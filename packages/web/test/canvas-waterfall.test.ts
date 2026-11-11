import { expect, test } from 'vitest';
import type { Graph, GraphEdge, GraphNode, NodeKind } from '@claude-canvas/shared';
import { buildView } from '../src/canvas/view';
import { barOf, buildWaterfall, scopeOf } from '../src/canvas/waterfall';

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
