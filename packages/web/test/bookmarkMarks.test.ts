import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import type { Graph, GraphEdge, GraphNode, NodeKind } from '@agent-canvas/shared';
import { graphResolver } from '../src/anomalies';
import { NO_STARS, bookmarkMarks, bookmarksUntil, stableStars, starLabel } from '../src/canvas/bookmarkMarks';
import { withStar } from '../src/canvas/Canvas';
import { StarBadge } from '../src/canvas/nodes';
import { buildView, TURN_FOLD_THRESHOLD, type ViewMode } from '../src/canvas/view';

// Invented sessions only.
const EPOCH = Date.parse('2026-01-01T00:00:00Z');

function node(id: string, kind: NodeKind, turnId: string | null, agentId: string | null, tMs: number, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id, sessionId: 's1', turnId, agentId, childAgentId: null, parentId: null, kind, status: null,
    timestamp: new Date(EPOCH + tMs).toISOString(), confirmed: true, title: kind, summary: 'x', toolName: null,
    toolUseId: null, messageId: null, durationMs: null, endedAt: null, usage: null, systemSubtype: null, ...extra,
  };
}
const p = (id: string, turnId: string, t: number) => node(id, 'prompt', turnId, null, t, { summary: `prompt ${turnId}` });
const tool = (id: string, turnId: string, t: number) => node(id, 'tool', turnId, null, t);
const sub = (id: string, turnId: string, t: number, childAgentId: string) => node(id, 'subagent', turnId, null, t, { childAgentId });
const inner = (id: string, agentId: string, t: number) => node(id, 'tool', null, agentId, t);
const innerSub = (id: string, agentId: string, t: number, childAgentId: string) => node(id, 'subagent', null, agentId, t, { childAgentId });
const e = (from: string, to: string, kind: GraphEdge['kind'] = 'sequence'): GraphEdge => ({ id: `${from}->${to}`, sessionId: 's1', from, to, kind });
const graph = (nodes: GraphNode[], edges: GraphEdge[] = []): Graph => ({
  nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), edges: Object.fromEntries(edges.map((x) => [x.id, x])),
});

/** Turn t1: p1 → c1 → s1 (agent a1: k1 → s2 (agent a2: j1)); turn t2: p2 → c2. */
function nested(): Graph {
  return graph(
    [p('p1', 't1', 0), tool('c1', 't1', 1), sub('s1', 't1', 2, 'a1'), inner('k1', 'a1', 3), innerSub('s2', 'a1', 4, 'a2'), inner('j1', 'a2', 5),
      p('p2', 't2', 10), tool('c2', 't2', 11)],
    [e('p1', 'c1'), e('c1', 's1'), e('s1', 'k1', 'spawn'), e('k1', 's2'), e('s2', 'j1', 'spawn'), e('c1', 'p2'), e('p2', 'c2')],
  );
}

const view = (g: Graph, o: { mode?: ViewMode; expandedAgents?: string[]; overrides?: [string, boolean][] } = {}) =>
  buildView(g, new Map(o.overrides ?? []), undefined, { mode: o.mode, expandedAgents: new Set(o.expandedAgents ?? []) });

const marks = (g: Graph, nodeIds: (string | null)[], v = view(g)) =>
  Object.fromEntries([...bookmarkMarks(nodeIds.map((nodeId) => ({ nodeId })), v, g, graphResolver(g))].map(([id, m]) => [id, m.count]));

test('主线的一步：逐步视角画了它的卡片就标在它自己身上', () => {
  const g = nested();
  expect(marks(g, ['c1'])).toEqual({ c1: 1 });
});

test('主线的一步：概览只画轮次，标在它那一轮的卡片上', () => {
  const g = nested();
  const v = view(g, { mode: 'outline' });
  const turn = v.turns[0]!.key;
  expect(marks(g, ['c1'], v)).toEqual({ [`turn:${turn}`]: 1 });
});

test('嵌套子代理里的一步（概览，Review Focus 5）：轮次卡片和两层子代理卡片都标', () => {
  const g = nested();
  const v = view(g, { mode: 'outline' });
  const turn = v.turns[0]!.key;
  expect(marks(g, ['j1'], v)).toEqual({ [`turn:${turn}`]: 1, s1: 1, s2: 1 });
});

test('子代理没展开（逐步）：标在画出来的外层子代理卡片上；展开后它自己的卡片画出来了就只标它自己', () => {
  const g = nested();
  expect(marks(g, ['j1'])).toEqual({ s1: 1 });
  expect(marks(g, ['j1'], view(g, { expandedAgents: ['a1'] }))).toEqual({ s1: 1, s2: 1 });
  expect(marks(g, ['j1'], view(g, { expandedAgents: ['a1', 'a2'] }))).toEqual({ j1: 1 });
});

test('折叠起来的一轮（逐步）：标在这一轮的折叠卡片上', () => {
  const g = nested();
  const v = view(g, { overrides: [[view(g).turns[0]!.key, false]] });
  const turn = v.turns[0]!.key;
  expect(v.nodes.get(`turn:${turn}`)?.type).toBe('turn_summary');
  expect(marks(g, ['c1', 'j1'], v)).toEqual({ [`turn:${turn}`]: 2 });
});

test('长的一轮中间收进“更早的 N 个节点”：标在那张卡片上（视图给出的 foldedIds）', () => {
  const count = TURN_FOLD_THRESHOLD + 10;
  const nodes = [p('p1', 't1', 0), ...Array.from({ length: count }, (_, i) => tool(`c${i}`, 't1', i + 1))];
  const g = graph(nodes);
  const v = view(g);
  const turn = v.turns[0]!;
  expect(turn.foldedIds).toContain('c3');
  expect(marks(g, ['c3', 'c4'], v)).toEqual({ [`earlier:${turn.key}`]: 2 });
  expect(marks(g, [`c${count - 1}`], v)).toEqual({ [`c${count - 1}`]: 1 }); // the tail is drawn
});

test('会话书签不标卡片；图里没有的步骤不标', () => {
  const g = nested();
  expect(bookmarkMarks([{ nodeId: null }], view(g), g, graphResolver(g))).toEqual(new Map());
  expect(marks(g, ['gone'])).toEqual({});
  expect(marks(g, ['gone'], view(g, { mode: 'outline' }))).toEqual({});
});

test('一张卡片收了几个书签：数量写进无障碍名称，例如「2 个书签」', () => {
  const g = nested();
  const v = view(g, { mode: 'outline' });
  const got = bookmarkMarks([{ nodeId: 'c1' }, { nodeId: 'j1' }, { nodeId: null }], v, g, graphResolver(g));
  const turn = got.get(`turn:${v.turns[0]!.key}`)!;
  expect(turn).toEqual({ count: 2, label: '2 个书签' });
  expect(got.get('s1')).toEqual({ count: 1, label: '1 个书签' });
  expect(starLabel(3)).toBe('3 个书签');
});

test('卡片上画一个 ★，提示和无障碍名称写数量', () => {
  const star = { count: 2, label: starLabel(2) };
  expect(renderToStaticMarkup(createElement(StarBadge, { star }))).toBe('<span class="cc-star" title="2 个书签" aria-hidden="true">★</span>');
  expect(renderToStaticMarkup(createElement(StarBadge, { star: null }))).toBe('');
  expect(withStar('工具 · Bash · 成功', star)).toBe('工具 · Bash · 成功，2 个书签');
  expect(withStar('工具 · Bash · 成功', null)).toBe('工具 · Bash · 成功');
});

test('复盘：只算复盘时间已经到了的步骤', () => {
  const g = nested();
  const list = [{ nodeId: 'c1' }, { nodeId: 'c2' }, { nodeId: null }, { nodeId: 'gone' }];
  expect(bookmarksUntil(list, g, null)).toBe(list);
  expect(bookmarksUntil(list, g, EPOCH + 5).map((b) => b.nodeId)).toEqual(['c1']);
});

test('没变的星标保持同一个对象，画布不重建卡片', () => {
  const a = new Map([['c1', { count: 1, label: '1 个书签' }]]);
  const b = new Map([['c1', { count: 1, label: '1 个书签' }]]);
  expect(stableStars(a, b)).toBe(a);
  const c = new Map([['c1', { count: 2, label: '2 个书签' }]]);
  expect(stableStars(a, c)).toBe(c);
  expect(stableStars(a, new Map())).toBe(NO_STARS);
  expect(stableStars(NO_STARS, new Map())).toBe(NO_STARS);
});
