import { expect, test } from 'vitest';
import { groupTurns, PRELUDE_TURN_KEY, STATS_RANGES, type GraphNode } from '../src/index.js';

function mk(id: string, ts: string, o: Partial<GraphNode> = {}): GraphNode {
  return {
    id, sessionId: 's1', turnId: null, agentId: null, parentId: null, kind: 'text', status: null, timestamp: ts,
    confirmed: true, title: 't', summary: 's', toolName: null, toolUseId: null, messageId: null,
    durationMs: null, usage: null, systemSubtype: null, childAgentId: null, endedAt: null, ...o,
  };
}

test('STATS_RANGES lists the three ranges', () => {
  expect(STATS_RANGES).toEqual(['7d', '30d', 'all']);
});

test('groupTurns: main-thread nodes grouped by turnId, ordered by start, nodes by time then id', () => {
  const turns = groupTurns([
    mk('b', '2026-01-01T00:00:05Z', { turnId: 'T1', kind: 'tool', status: 'succeeded' }),
    mk('p2', '2026-01-01T00:01:00Z', { turnId: 'T2', kind: 'prompt' }),
    mk('p1', '2026-01-01T00:00:00Z', { turnId: 'T1', kind: 'prompt' }),
    mk('a', '2026-01-01T00:00:05Z', { turnId: 'T1' }),
  ]);
  expect(turns.map((t) => t.key)).toEqual(['T1', 'T2']);
  expect(turns[0]!.nodes.map((n) => n.id)).toEqual(['p1', 'a', 'b']);
  expect(turns[0]!.startMs).toBe(Date.parse('2026-01-01T00:00:00Z'));
});

test('groupTurns: a node without turnId joins the latest turn started at or before it, else the prelude', () => {
  const turns = groupTurns([
    mk('early', '2026-01-01T00:00:00Z'),
    mk('p1', '2026-01-01T00:00:10Z', { turnId: 'T1', kind: 'prompt' }),
    mk('late', '2026-01-01T00:00:20Z'),
    mk('same', '2026-01-01T00:00:10Z'),
  ]);
  expect(turns.map((t) => [t.key, t.nodes.map((n) => n.id)])).toEqual([
    [PRELUDE_TURN_KEY, ['early']],
    ['T1', ['p1', 'same', 'late']],
  ]);
  // The prelude's start is its first node's time.
  expect(turns[0]!.startMs).toBe(Date.parse('2026-01-01T00:00:00Z'));
});

test('groupTurns: a turn not started by a prompt starts at its first node', () => {
  const turns = groupTurns([
    mk('x', '2026-01-01T00:00:03Z', { turnId: 'T1', kind: 'text' }),
    mk('p', '2026-01-01T00:00:05Z', { turnId: 'T1', kind: 'prompt' }),
  ]);
  expect(turns).toHaveLength(1);
  expect(turns[0]!.startMs).toBe(Date.parse('2026-01-01T00:00:03Z'));
});

test('groupTurns: subagent-internal nodes are ignored', () => {
  const turns = groupTurns([
    mk('p1', '2026-01-01T00:00:00Z', { turnId: 'T1', kind: 'prompt' }),
    mk('in', '2026-01-01T00:00:01Z', { turnId: 'X', agentId: 'ag1', kind: 'tool', status: 'succeeded' }),
  ]);
  expect(turns.map((t) => [t.key, t.nodes.length])).toEqual([['T1', 1]]);
});

test('groupTurns: an unparseable timestamp counts as 0 (as the canvas does)', () => {
  const turns = groupTurns([
    mk('p1', '2026-01-01T00:00:00Z', { turnId: 'T1', kind: 'prompt' }),
    mk('bad', 'not a date', { turnId: 'T0' }),
  ]);
  expect(turns.map((t) => t.key)).toEqual(['T0', 'T1']);
  expect(turns[0]!.startMs).toBe(0);
});
