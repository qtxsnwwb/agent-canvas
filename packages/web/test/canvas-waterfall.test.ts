import { expect, test } from 'vitest';
import type { Graph, GraphEdge, GraphNode, NodeKind } from '@claude-canvas/shared';
import { buildView } from '../src/canvas/view';
import { barOf, buildWaterfall, durationPlacement, scopeOf, stepChain, waterfallClock } from '../src/canvas/waterfall';

const EPOCH = Date.parse('2026-01-01T00:00:00Z');
const iso = (t: number) => new Date(EPOCH + t).toISOString();

function node(id: string, kind: NodeKind, turnId: string | null, agentId: string | null, t: number, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id, sessionId: 's1', turnId, agentId, childAgentId: null, endedAt: null, parentId: null, kind, status: null,
    timestamp: iso(t), confirmed: true, title: kind, summary: 'x', toolName: null,
    toolUseId: null, messageId: null, durationMs: null, usage: null, systemSubtype: null, ...extra,
  };
}
const e = (from: string, to: string, kind: GraphEdge['kind'] = 'sequence'): GraphEdge => ({ id: `${from}->${to}`, sessionId: 's1', from, to, kind });
function graph(nodes: GraphNode[], edges: GraphEdge[] = []): Graph {
  return { nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), edges: Object.fromEntries(edges.map((x) => [x.id, x])) };
}
const opts = { compact: true, nowMs: EPOCH + 100_000 };

function twoTurnsWithAgents(): Graph {
  return graph(
    [
      node('p1', 'prompt', 't1', null, 0),
      node('a', 'tool', 't1', null, 1000, { status: 'succeeded', title: 'Read', endedAt: iso(1500) }),
      node('d1', 'subagent', 't1', null, 2000, { status: 'succeeded', title: 'Explore', childAgentId: 'ag1', endedAt: iso(9000) }),
      node('i1', 'tool', null, 'ag1', 2100, { status: 'succeeded', title: 'Grep', durationMs: 300 }),
      node('d2', 'subagent', null, 'ag1', 3000, { status: 'succeeded', title: 'Plan', childAgentId: 'ag2' }),
      node('i2', 'text', null, 'ag2', 3100),
      node('x', 'text', 't1', null, 9500),
      node('p2', 'prompt', 't2', null, 20_000),
      node('late', 'system', null, null, 20_500, { systemSubtype: 'compact' }),
      node('b', 'tool', 't2', null, 21_000, { status: 'running', title: 'Bash' }),
    ],
    [e('p1', 'a'), e('a', 'd1'), e('d1', 'x'), e('x', 'p2'), e('p2', 'b'), e('d1', 'i1', 'spawn'), e('i1', 'd2'), e('d2', 'i2', 'spawn')],
  );
}

test('outline view: one summary node per turn, with its agents and their agents hanging off it', () => {
  const v = buildView(twoTurnsWithAgents(), new Map(), undefined, { mode: 'outline' });
  expect([...v.nodes.keys()].sort()).toEqual(['d1', 'd2', 'turn:t1', 'turn:t2']);
  expect(v.turns.map((t) => [t.key, t.collapsed, t.nodeIds])).toEqual([
    ['t1', true, ['turn:t1', 'd1', 'd2']],
    ['t2', true, ['turn:t2']],
  ]);
  expect(v.edges.map((x) => `${x.from}->${x.to}`).sort()).toEqual(['d1->d2', 'turn:t1->d1', 'turn:t1->turn:t2']);
  expect(v.latestNodeId).toBe('turn:t2');
  expect(v.agentGroups).toEqual([]);
  const d1 = v.nodes.get('d1');
  expect(d1).toMatchObject({ type: 'node', turnKey: 't1', innerCount: 2, expandable: false, expanded: false });
  expect(v.turns[1]!.summary).toMatchObject({ running: true, activity: 'Bash', toolCount: 1 });
  expect(v.turns[0]!.summary.activity).toBeUndefined();
});

test('outline view ignores turn overrides and expanded agents; a dispatch cycle does not loop', () => {
  const g = graph([
    node('p1', 'prompt', 't1', null, 0),
    node('d1', 'subagent', 't1', null, 1, { childAgentId: 'ag1' }),
    node('d2', 'subagent', null, 'ag1', 2, { childAgentId: 'ag1' }),
  ]);
  const v = buildView(g, new Map([['t1', true]]), undefined, { mode: 'outline', expandedAgents: new Set(['ag1']) });
  expect([...v.nodes.keys()].sort()).toEqual(['d1', 'd2', 'turn:t1']);
  expect(v.turns[0]!.collapsed).toBe(true);
});

test('scopeOf: a turn summary is a turn scope, a subagent with a known agent is an agent scope', () => {
  const v = buildView(twoTurnsWithAgents(), new Map(), undefined, { mode: 'outline' });
  expect(scopeOf(v.nodes.get('turn:t1'))).toEqual({ type: 'turn', turnKey: 't1' });
  expect(scopeOf(v.nodes.get('d1'))).toEqual({ type: 'agent', agentId: 'ag1' });
  expect(scopeOf(undefined)).toBeNull();
  const live = buildView(twoTurnsWithAgents(), new Map([['t1', true]]));
  expect(scopeOf(live.nodes.get('a'))).toBeNull();
});

test('a turn scope lists its main-thread steps in time order, including steps without a turn id', () => {
  const g = twoTurnsWithAgents();
  const t1 = buildWaterfall(g, { type: 'turn', turnKey: 't1' }, opts);
  expect(t1.rows.map((r) => r.id)).toEqual(['p1', 'a', 'd1', 'x']);
  expect(t1.rows[1]).toMatchObject({ startMs: EPOCH + 1000, endMs: EPOCH + 1500, open: false, childAgentId: null });
  expect(t1.rows[2]).toMatchObject({ endMs: EPOCH + 9000, childAgentId: 'ag1' });
  expect(t1.rows[3]).toMatchObject({ startMs: EPOCH + 9500, endMs: EPOCH + 9500 });
  expect([t1.startMs, t1.endMs]).toEqual([EPOCH, EPOCH + 9500]);
  const t2 = buildWaterfall(g, { type: 'turn', turnKey: 't2' }, opts);
  expect(t2.rows.map((r) => r.id)).toEqual(['p2', 'late', 'b']);
});

test('a running step is open and ends now; an agent scope lists that agent only', () => {
  const g = twoTurnsWithAgents();
  const t2 = buildWaterfall(g, { type: 'turn', turnKey: 't2' }, opts);
  expect(t2.rows[2]).toMatchObject({ id: 'b', open: true, endMs: opts.nowMs });
  expect(t2.endMs).toBe(opts.nowMs);
  const ag1 = buildWaterfall(g, { type: 'agent', agentId: 'ag1' }, opts);
  expect(ag1.rows.map((r) => r.id)).toEqual(['i1', 'd2']);
  expect(ag1.rows[0]).toMatchObject({ startMs: EPOCH + 2100, endMs: EPOCH + 2400 });
  expect(ag1.rows[1]!.childAgentId).toBe('ag2');
});

test('compact leaves out empty thinking and plain system steps; thinking runs up to its timestamp', () => {
  const g = graph([
    node('p', 'prompt', 't1', null, 0),
    node('empty', 'thinking', 't1', null, 2000, { summary: '', durationMs: 1000 }),
    node('th', 'thinking', 't1', null, 5000, { summary: 'why', durationMs: 2000 }),
    node('s', 'system', 't1', null, 6000),
  ]);
  const compact = buildWaterfall(g, { type: 'turn', turnKey: 't1' }, opts);
  expect(compact.rows.map((r) => r.id)).toEqual(['p', 'th']);
  expect(compact.rows[1]).toMatchObject({ startMs: EPOCH + 3000, endMs: EPOCH + 5000 });
  const full = buildWaterfall(g, { type: 'turn', turnKey: 't1' }, { ...opts, compact: false });
  expect(full.rows.map((r) => r.id)).toEqual(['p', 'empty', 'th', 's']);
});

test('an unknown scope is empty with a usable range; barOf gives fractions of the range', () => {
  const none = buildWaterfall(twoTurnsWithAgents(), { type: 'turn', turnKey: 'nope' }, opts);
  expect(none).toEqual({ rows: [], startMs: 0, endMs: 1 });
  expect(barOf({ startMs: 0, endMs: 100 }, { startMs: 25, endMs: 75 })).toEqual({ left: 0.25, width: 0.5 });
  expect(barOf({ startMs: 0, endMs: 100 }, { startMs: 50, endMs: 50 })).toEqual({ left: 0.5, width: 0 });
  expect(barOf({ startMs: 0, endMs: 100 }, { startMs: -10, endMs: 500 })).toEqual({ left: 0, width: 1 });
});

test('stepChain walks back to the turn prompt, skips parallel siblings, and stops at the prompt', () => {
  const g = graph(
    [
      node('p0', 'prompt', 't0', null, 0), node('y0', 'text', 't0', null, 1),
      node('p1', 'prompt', 't1', null, 10), node('th', 'thinking', 't1', null, 11), node('x1', 'text', 't1', null, 12),
      node('a', 'tool', 't1', null, 13), node('b', 'tool', 't1', null, 13), node('x2', 'text', 't1', null, 14),
      node('c', 'tool', 't1', null, 15),
    ],
    [e('p0', 'y0'), e('y0', 'p1'), e('p1', 'th'), e('th', 'x1'), e('x1', 'a', 'fork'), e('x1', 'b', 'fork'), e('a', 'x2'), e('b', 'x2'), e('x2', 'c')],
  );
  const viaA = stepChain(g, 'a');
  expect([...viaA.ids].sort()).toEqual(['a', 'p1', 'th', 'x1']);
  expect(viaA.reasoning.map((n) => n.id)).toEqual(['th', 'x1']);
  const viaC = stepChain(g, 'c');
  expect([...viaC.ids].sort()).toEqual(['a', 'b', 'c', 'p1', 'th', 'x1', 'x2']);
  expect(viaC.reasoning.map((n) => n.id)).toEqual(['th', 'x1', 'x2']);
  expect([...stepChain(g, 'p1').ids]).toEqual(['p1']);
  expect(stepChain(g, null).ids.size).toBe(0);
  expect(stepChain(g, 'nope').ids.size).toBe(0);
});

test('stepChain continues from an agent step through its dispatch node into the main thread', () => {
  const g = twoTurnsWithAgents();
  const chain = stepChain(g, 'i2');
  expect([...chain.ids].sort()).toEqual(['a', 'd1', 'd2', 'i1', 'i2', 'p1']);
  expect(chain.reasoning.map((n) => n.id)).toEqual(['i2']);
});

test('stepChain.direct: the nearest reasoning on each path, with the reasoning right before it; else the prompt', () => {
  const g = graph(
    [
      node('p', 'prompt', 't1', null, 0), node('x0', 'text', 't1', null, 1), node('a', 'tool', 't1', null, 2),
      node('th', 'thinking', 't1', null, 3, { summary: 'why' }), node('gap', 'thinking', 't1', null, 4, { summary: '' }),
      node('x1', 'text', 't1', null, 5), node('b', 'tool', 't1', null, 6), node('c', 'tool', 't1', null, 7),
    ],
    [e('p', 'x0'), e('x0', 'a'), e('a', 'th'), e('th', 'gap'), e('gap', 'x1'), e('x1', 'b'), e('b', 'c')],
  );
  // c <- b <- x1 (reply) <- gap (empty thinking, passed through) <- th (thinking); the run ends at tool a.
  expect([...stepChain(g, 'c').direct].sort()).toEqual(['th', 'x1']);
  expect([...stepChain(g, 'c').ids].sort()).toEqual(['a', 'b', 'c', 'gap', 'p', 'th', 'x0', 'x1']);
  expect([...stepChain(g, 'a').direct]).toEqual(['x0']);
  expect([...stepChain(g, 'x0').direct]).toEqual(['p']);
  expect(stepChain(g, 'p').direct.size).toBe(0);
  expect(stepChain(g, null).direct.size).toBe(0);
});

test('waterfallClock ticks only while the session is progressing; otherwise open steps end at the last activity', () => {
  const at = iso(60_000);
  const now = EPOCH + 120_000;
  expect(waterfallClock({ status: 'running', lastActivityAt: at }, now)).toEqual({ nowMs: now, ticking: true });
  expect(waterfallClock({ status: 'awaiting_permission', lastActivityAt: at }, now)).toEqual({ nowMs: now, ticking: true });
  expect(waterfallClock({ status: 'idle', lastActivityAt: at }, now)).toEqual({ nowMs: EPOCH + 60_000, ticking: false });
  expect(waterfallClock({ status: 'ended', lastActivityAt: at }, now)).toEqual({ nowMs: EPOCH + 60_000, ticking: false });
  // Running, but silent for an hour: displayed as stale, so nothing is growing.
  expect(waterfallClock({ status: 'running', lastActivityAt: at }, now + 3_600_000)).toEqual({ nowMs: EPOCH + 60_000, ticking: false });
});

test('durationPlacement: after a bar with room on its right, before one with room on its left, inside a full-width one', () => {
  expect(durationPlacement(0.1, 0.2)).toBe('after');
  expect(durationPlacement(0.6, 0.4)).toBe('before');
  expect(durationPlacement(0, 1)).toBe('inside');
  expect(durationPlacement(0.2, 0.7)).toBe('inside');
});

test('stepChain.direct inside an agent: its task prompt counts, and the walk does not go on into the main thread', () => {
  const g = graph(
    [
      node('p', 'prompt', 't1', null, 0), node('x', 'text', 't1', null, 1),
      node('d', 'subagent', 't1', null, 2, { childAgentId: 'ag' }),
      node('ap', 'prompt', null, 'ag', 3), node('r', 'tool', null, 'ag', 4), node('out', 'text', null, 'ag', 5),
    ],
    [e('p', 'x'), e('x', 'd'), e('d', 'ap', 'spawn'), e('ap', 'r'), e('r', 'out')],
  );
  expect([...stepChain(g, 'out').direct]).toEqual(['ap']);
  expect([...stepChain(g, 'r').direct]).toEqual(['ap']);
  expect([...stepChain(g, 'ap').direct]).toEqual(['x']);
  expect([...stepChain(g, 'out').ids].sort()).toEqual(['ap', 'd', 'out', 'p', 'r', 'x']);
});
