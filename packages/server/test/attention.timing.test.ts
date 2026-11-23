import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Change, GraphNode, Session, SessionStatus } from '@agent-canvas/shared';
import { AttentionService } from '../src/attention/service.js';
import { openStore, type Store } from '../src/store/store.js';

// Timing-sensitive: runs in the serial "timing" Vitest project (see vitest.config.ts). In-memory store only.
//
// Review Focus 4: a 100,000-node session receiving appends; recomputing its item never reads the whole graph and one
// change batch costs O(changed nodes). Measured on the development machine (Windows, Node 25), four runs:
//   whole-graph read (getGraphJson) of the session ......... 202-221 ms
//   start-up load (constructor, this session + 50 others) ... 3.7-9.0 ms
//   1,000 appended batches through noteChanges .............. 11.7-44.9 ms (about 0.01-0.05 ms a batch)
// A whole-graph read per batch would cost 1,000 x the first figure (over 200 s); the bounds leave ~10x headroom.

const TIMING_SCALE = Math.max(1, Number(process.env.AGENT_CANVAS_TIMING_SCALE) || 1);
const bound = (ms: number): number => ms * TIMING_SCALE;
const BOUND_STARTUP = 100;
const BOUND_BATCHES = 500;

const T0 = Date.parse('2026-11-20T10:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

let store: Store;
let service: AttentionService | null = null;
beforeEach(() => {
  store = openStore(':memory:');
});
afterEach(() => {
  service?.close();
  store.close();
});

const session = (id: string, status: SessionStatus, at: number): Session => ({
  id, projectId: 'proj', origin: 'claude', cwd: '/w/proj', title: id, gitBranch: null, status, sourceDeleted: false,
  startedAt: iso(T0 - 86_400_000), lastActivityAt: iso(at),
});
const node = (sessionId: string, i: number, at: number, over: Partial<GraphNode> = {}): GraphNode => ({
  id: `n${i}`, sessionId, turnId: null, agentId: null, childAgentId: null, parentId: null, kind: 'tool', status: 'succeeded',
  timestamp: iso(at), confirmed: true, title: 'Bash', summary: `npm run step-${i} -- --flag ${'x'.repeat(60)}`, toolName: 'Bash',
  toolUseId: null, messageId: null, durationMs: 5, endedAt: iso(at + 5), usage: null, systemSubtype: null, ...over,
});
/** Node i of a long session: a main-thread prompt every 500 nodes, every 4th node a subagent's, every 3rd a reply. */
const nth = (sessionId: string, i: number, at: number): GraphNode =>
  i % 500 === 0
    ? node(sessionId, i, at, { kind: 'prompt', status: null, title: 'Prompt', toolName: null, endedAt: null })
    : i % 4 === 1
      ? node(sessionId, i, at, { agentId: 'ag1' })
      : i % 3 === 0
        ? node(sessionId, i, at, { kind: 'text', status: null, title: 'Text', toolName: null, endedAt: null })
        : node(sessionId, i, at);

test('a 100,000-node session: start-up load and 1,000 appended batches never read the whole graph', () => {
  const N = 100_000;
  const step = 1_000; // ms between nodes
  const start = T0 - N * step - 3_600_000;
  for (let from = 0; from < N; from += 10_000) {
    const chunk: Change[] = from === 0 ? [{ type: 'session_upserted', session: session('big', 'running', start) }] : [];
    for (let i = from; i < from + 10_000; i++) chunk.push({ type: 'node_added', node: nth('big', i, start + i * step), detail: {} });
    store.applyChanges(chunk);
  }
  store.applyChanges([{ type: 'session_upserted', session: session('big', 'idle', start + N * step) }]);
  for (let s = 0; s < 50; s++) {
    const at = T0 - 3_600_000 - s * 1_000;
    store.applyChanges([
      { type: 'session_upserted', session: session(`s${s}`, 'idle', at) },
      { type: 'node_added', node: nth(`s${s}`, 0, at - 2_000), detail: {} },
      { type: 'node_added', node: nth(`s${s}`, 3, at - 1_000), detail: {} },
    ]);
  }

  let t = performance.now();
  const whole = store.getGraphJson('big')!;
  const wholeMs = performance.now() - t;
  expect(whole.length).toBeGreaterThan(N * 100);

  let now = T0;
  t = performance.now();
  service = new AttentionService({ store, now: () => now, stuckMinutes: () => 15, isAbortedCall: () => false });
  const startupMs = performance.now() - t;
  const first = service.snapshot();
  expect(first.items.find((i) => i.sessionId === 'big')).toMatchObject({ kind: 'finished', since: iso(start + (N - 1) * step) });
  expect(first.items).toHaveLength(51);

  let noteMs = 0;
  let at = T0;
  for (let b = 0; b < 1_000; b++) {
    const i = N + b * 3;
    at += 3_000;
    now = at + 500;
    const batch: Change[] = [
      { type: 'session_upserted', session: session('big', 'running', at) },
      // Every 100th batch starts a new turn.
      {
        type: 'node_added',
        node: b % 100 === 0 ? node('big', i, at, { kind: 'prompt', status: null, title: 'Prompt', toolName: null, endedAt: null }) : node('big', i, at, { status: 'running', endedAt: null }),
        detail: {},
      },
      { type: 'node_updated', sessionId: 'big', id: `n${i}`, patch: { status: 'succeeded', endedAt: iso(at + 5) } },
      { type: 'node_added', node: node('big', i + 1, at + 1, { agentId: 'ag1' }), detail: {} },
      { type: 'node_added', node: node('big', i + 2, at + 2, { kind: 'text', status: null, title: 'Text', toolName: null, endedAt: null }), detail: {} },
      { type: 'session_upserted', session: session('big', 'idle', at + 2) },
    ];
    const applied = store.applyChanges(batch);
    const t1 = performance.now();
    service.noteChanges(applied);
    noteMs += performance.now() - t1;
  }
  const last = service.snapshot().items.find((i) => i.sessionId === 'big')!;
  expect(last).toMatchObject({ kind: 'finished', since: iso(at + 2), nodeId: `n${N + 999 * 3 + 2}` });

  console.log(`attention timing: whole graph ${wholeMs.toFixed(0)} ms, start-up ${startupMs.toFixed(1)} ms, 1,000 batches ${noteMs.toFixed(1)} ms`);
  expect(startupMs).toBeLessThan(bound(BOUND_STARTUP));
  expect(noteMs).toBeLessThan(bound(BOUND_BATCHES));
  // Whatever the machine: all 1,000 batches together cost less than one whole-graph read.
  expect(noteMs).toBeLessThan(wholeMs);
}, 120_000);
