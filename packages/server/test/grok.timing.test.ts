import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, test } from 'vitest';
import type { Change } from '@agent-canvas/shared';
import { GROK_RUN_MAX_CHARS, GrokNormalizer } from '../src/normalize/grok.js';
import type { RawEvent } from '../src/store/store.js';
import { chunk, ext, PROJECT, SID, T0, upd, UPDATES_KEY } from './grok-fixtures.js';

// Timing- and memory-sensitive Grok normalizer checks (the timing project: one file at a time, retried).

let offset = 0;
const event = (line: string): RawEvent => {
  const e: RawEvent = { source: 'transcript', origin: 'grok', file: UPDATES_KEY, offset, line, recordType: 'x', sessionId: SID, agentId: null, projectId: PROJECT };
  offset += line.length + 1;
  return e;
};

/** A forced garbage collection (node: --expose-gc enabled at run time for a fresh context's `gc`). */
function gcFn(): () => void {
  v8.setFlagsFromString('--expose-gc');
  return vm.runInNewContext('gc') as () => void;
}

/** The lines of one turn: prompt, tool call + result, two reply chunks, completion. */
function turn(i: number): string[] {
  const m = { meta: { promptId: `p${i}` } };
  return [
    chunk('user', `step ${i}`, { ts: T0 + i, promptId: `p${i}` }),
    upd({ sessionUpdate: 'tool_call', toolCallId: `c${i}`, kind: 'read', rawInput: { target_file: `/w/f${i}.ts` } }, { ts: T0 + i, ...m }),
    upd({ sessionUpdate: 'tool_call_update', toolCallId: `c${i}`, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] }, { ts: T0 + i, ...m }),
    chunk('agent', `done `, { ts: T0 + i, promptId: `p${i}` }),
    chunk('agent', `${i}`, { ts: T0 + i, promptId: `p${i}` }),
    ext({ sessionUpdate: 'turn_completed', prompt_id: `p${i}`, usage: { inputTokens: 10, outputTokens: 2 } }, { ts: T0 + i }),
  ];
}

describe('Grok normalizer: cost of long sessions and long chunk runs', () => {
  test('50,000 agent_message_chunk lines one by one into one node: linear, one node, the whole text, little held', () => {
    const gc = gcFn();
    offset = 0;
    const n = new GrokNormalizer();
    n.apply(event(chunk('user', 'go')), PROJECT);
    gc();
    const before = process.memoryUsage().heapUsed;
    const slices: number[] = [];
    let added = 0;
    let last: Change | undefined;
    const piece = 'tok1 '; // 5 characters: 250,000 characters in all (under GROK_RUN_MAX_CHARS)
    for (let s = 0; s < 5; s++) {
      const lines = Array.from({ length: 10_000 }, () => chunk('agent', piece));
      const t0 = performance.now();
      for (const line of lines) {
        for (const c of n.apply(event(line), PROJECT).changes) {
          if (c.type === 'node_added') added++;
          if (c.type === 'node_updated' && c.detail !== undefined) last = c;
        }
      }
      slices.push(performance.now() - t0);
    }
    expect(added).toBe(1);
    const text = (last as Extract<Change, { type: 'node_updated' }>).detail!.text as string;
    expect(text.length).toBe(50_000 * piece.length);
    // Linear: the last slice within 3× the first (+ 50 ms of noise); per-chunk work growing with the run would be ~9×.
    expect(slices[4]!).toBeLessThan(slices[0]! * 3 + 50);
    expect(slices.reduce((a, b) => a + b, 0)).toBeLessThan(10_000);
    last = undefined;
    gc();
    const held = process.memoryUsage().heapUsed - before;
    // Held: the open run's text (250 KB of characters) and bookkeeping; a copy per chunk would be gigabytes.
    console.log(`[grok timing] 50k chunks: slices ms ${slices.map((x) => x.toFixed(0)).join('/')}, held ${(held / 1e6).toFixed(1)} MB`);
    expect(held).toBeLessThan(40e6);
    expect(n.hasSession(SID)).toBe(true);
  });

  test('a run longer than GROK_RUN_MAX_CHARS continues in a new node', () => {
    offset = 0;
    const n = new GrokNormalizer();
    let added = 0;
    const big = 'x'.repeat(64 * 1024);
    const lines = [chunk('user', 'go'), ...Array.from({ length: Math.ceil(GROK_RUN_MAX_CHARS / big.length) + 1 }, () => chunk('agent', big))];
    for (const line of lines) for (const c of n.apply(event(line), PROJECT).changes) if (c.type === 'node_added') added++;
    expect(added).toBe(3); // prompt, text, its continuation
  });

  test('30,000 lines of turns one by one: the last 6,000 cost about what the first 6,000 did', () => {
    offset = 0;
    const n = new GrokNormalizer();
    const slices: number[] = [];
    for (let s = 0; s < 5; s++) {
      const evs = Array.from({ length: 1000 }, (_, k) => turn(s * 1000 + k)).flat().map(event);
      const t0 = performance.now();
      for (const e of evs) n.apply(e, PROJECT);
      slices.push(performance.now() - t0);
    }
    expect(slices[4]!).toBeLessThan(slices[0]! * 3 + 50);
    expect(slices.reduce((a, b) => a + b, 0)).toBeLessThan(10_000);
  });

  test('rewinds cost the nodes they remove, not the session size', () => {
    offset = 0;
    const n = new GrokNormalizer();
    for (let i = 0; i < 5000; i++) for (const l of turn(i)) n.apply(event(l), PROJECT);
    const slices: number[] = [];
    for (let s = 0; s < 4; s++) {
      const t0 = performance.now();
      for (let k = 0; k < 500; k++) {
        const i = 100_000 + s * 1000 + k;
        for (const l of turn(i)) n.apply(event(l), PROJECT);
        const r = n.apply(event(ext({ sessionUpdate: 'rewind_marker', target_prompt_index: 5000 })), PROJECT);
        expect(r.changes.filter((c) => c.type === 'node_removed')).toHaveLength(3);
      }
      slices.push(performance.now() - t0);
    }
    expect(slices[3]!).toBeLessThan(slices[0]! * 3 + 50);
    expect(slices.reduce((a, b) => a + b, 0)).toBeLessThan(10_000);
  });

  test('tool inputs and outputs are emitted, not kept', () => {
    const gc = gcFn();
    offset = 0;
    gc();
    const before = process.memoryUsage().heapUsed;
    const n = new GrokNormalizer();
    const big = 'o'.repeat(100_000);
    const calls = 300; // 30 MB of output, 30 MB of input
    for (let i = 0; i < calls; i++) {
      n.apply(event(upd({ sessionUpdate: 'tool_call', toolCallId: `b${i}`, kind: 'execute', rawInput: { command: big + i } })), PROJECT);
      n.apply(event(upd({ sessionUpdate: 'tool_call_update', toolCallId: `b${i}`, status: 'completed', rawOutput: { stdout: big } })), PROJECT);
    }
    gc();
    const held = process.memoryUsage().heapUsed - before;
    console.log(`[grok timing] 300 calls with 100 KB input and output each: held ${(held / 1e6).toFixed(2)} MB`);
    expect(held).toBeLessThan(6e6); // < 0.1× of what went through
    expect(n.hasSession(SID)).toBe(true);
  });
});
