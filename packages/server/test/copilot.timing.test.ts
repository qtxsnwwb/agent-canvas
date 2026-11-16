import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, test } from 'vitest';
import { CopilotNormalizer } from '../src/normalize/copilot.js';
import type { RawEvent } from '../src/store/store.js';
import { EVENTS_KEY, ev, PROJECT, SID, startLine } from './copilot-fixtures.js';

// Timing- and memory-sensitive Copilot normalizer checks (the timing project: one file at a time, retried).

const T = (s: number): string => new Date(Date.parse('2026-11-12T08:00:00.000Z') + s * 1000).toISOString();
let offset = 0;
const event = (line: string): RawEvent => {
  const e: RawEvent = { source: 'transcript', origin: 'copilot', file: EVENTS_KEY, offset, line, recordType: 'x', sessionId: SID, agentId: null, projectId: PROJECT };
  offset += line.length + 1;
  return e;
};

/** The five lines of one turn (prompt, request, start, complete, text). */
function turn(i: number, output = 'ok'): string[] {
  return [
    ev('user.message', { content: `step ${i}` }, { at: T(i * 5) }),
    ev('assistant.message', { messageId: `m${i}`, content: '', toolRequests: [{ toolCallId: `c${i}`, name: 'view', arguments: { path: `/w/f${i}.ts` } }] }, { at: T(i * 5 + 1) }),
    ev('tool.execution_start', { toolCallId: `c${i}`, toolName: 'view', arguments: { path: `/w/f${i}.ts` } }, { at: T(i * 5 + 2) }),
    ev('tool.execution_complete', { toolCallId: `c${i}`, success: true, result: { content: output } }, { at: T(i * 5 + 3) }),
    ev('assistant.message', { messageId: `n${i}`, content: `done ${i}` }, { at: T(i * 5 + 4) }),
  ];
}

/** A forced garbage collection (node: --expose-gc enabled at run time for a fresh context's `gc`). */
function gcFn(): () => void {
  v8.setFlagsFromString('--expose-gc');
  return vm.runInNewContext('gc') as () => void;
}

describe('Copilot normalizer: cost of a long session', () => {
  test('20,000 events one by one: the last 4,000 cost about what the first 4,000 did (no per-event work ∝ session)', () => {
    const n = new CopilotNormalizer();
    n.apply(event(startLine()), PROJECT);
    const slices: number[] = [];
    let nodes = 0;
    for (let s = 0; s < 5; s++) {
      const evs = Array.from({ length: 800 }, (_, k) => turn(s * 800 + k)).flat().map(event);
      const t0 = performance.now();
      for (const e of evs) for (const c of n.apply(e, PROJECT).changes) if (c.type === 'node_added') nodes++;
      slices.push(performance.now() - t0);
    }
    expect(nodes).toBe(12_000);
    // Linear: the last slice within 3× the first (+ 50 ms of noise); quadratic work would make it ~9×. Absolute: generous.
    expect(slices[4]!).toBeLessThan(slices[0]! * 3 + 50);
    expect(slices.reduce((a, b) => a + b, 0)).toBeLessThan(10_000);
  });

  test('I-1: memory held per MB of tool output stays small (outputs are emitted, not kept)', () => {
    const gc = gcFn();
    const output = 'o'.repeat(100_000);
    const calls = 300; // 30 MB of tool output (and as much again in arguments of the large requests)
    gc();
    const before = process.memoryUsage().heapUsed;
    const n = new CopilotNormalizer();
    n.apply(event(startLine()), PROJECT);
    for (let i = 0; i < calls; i++) {
      // Each line is built, applied and dropped: only the normalizer can keep it alive.
      for (const line of turn(i, output)) n.apply(event(line), PROJECT);
    }
    gc();
    const held = process.memoryUsage().heapUsed - before;
    const outputMb = (calls * output.length) / 1e6;
    // Before the fix: about 2.5 MB held per MB of output. Now only the per-call / per-node bookkeeping (well under 1 KB
    // per call) is held; the bound leaves wide headroom for GC noise.
    expect(held / outputMb).toBeLessThan(150_000); // bytes per MB of output (< 0.15×)
    expect(n.hasSession(SID)).toBe(true); // still alive while measured
  });
});
