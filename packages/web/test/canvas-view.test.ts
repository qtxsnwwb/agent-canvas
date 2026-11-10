import { expect, test } from 'vitest';
import { emptyGraph, type Graph, type GraphEdge, type GraphNode, type NodeKind } from '@claude-canvas/shared';
import { buildView, forkSources, PRELUDE_TURN } from '../src/canvas/view';

const EPOCH = Date.parse('2026-01-01T00:00:00Z');

function node(id: string, kind: NodeKind, turnId: string | null, agentId: string | null, tMs: number, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id, sessionId: 's1', turnId, agentId, childAgentId: null, parentId: null, kind, status: null,
    timestamp: new Date(EPOCH + tMs).toISOString(), confirmed: true, title: kind, summary: '', toolName: null,
    toolUseId: null, messageId: null, durationMs: null, usage: null, systemSubtype: null, ...extra,
  };
}
const p = (id: string, turnId: string | null, t: number, extra: Partial<GraphNode> = {}) => node(id, 'prompt', turnId, null, t, { summary: `prompt ${turnId}`, ...extra });
const tool = (id: string, turnId: string | null, t: number, extra: Partial<GraphNode> = {}) => node(id, 'tool', turnId, null, t, extra);
const sub = (id: string, turnId: string | null, t: number, extra: Partial<GraphNode> = {}) => node(id, 'subagent', turnId, null, t, extra);
const sys = (id: string, turnId: string | null, t: number, extra: Partial<GraphNode> = {}) => node(id, 'system', turnId, null, t, extra);
const inner = (id: string, agentId: string, t: number) => node(id, 'text', null, agentId, t);
const text = (id: string, turnId: string | null, t: number) => node(id, 'text', turnId, null, t);
const e = (from: string, to: string, kind: GraphEdge['kind'] = 'sequence'): GraphEdge => ({ id: `${from}->${to}`, sessionId: 's1', from, to, kind });
function graph(nodes: GraphNode[], edges: GraphEdge[]): Graph {
  return { nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), edges: Object.fromEntries(edges.map((x) => [x.id, x])) };
}
function fiveTurnsOfThreeNodes(): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (let i = 1; i <= 5; i++) {
    const t = i * 100;
    nodes.push(p(`p${i}`, `t${i}`, t, { summary: `prompt t${i}` }), tool(`x${i}`, `t${i}`, t + 1), text(`y${i}`, `t${i}`, t + 2));
    edges.push(e(`p${i}`, `x${i}`), e(`x${i}`, `y${i}`));
    if (i < 5) edges.push(e(`y${i}`, `p${i + 1}`));
  }
  return graph(nodes, edges);
}

test('只有主线节点进视图；子代理节点带内部节点数', () => {
  const v = buildView(graph([p('p1','t1',0), sub('s1','t1',1,{childAgentId:'a1'}), inner('i1','a1',2), inner('i2','a1',3)],
    [e('p1','s1'), e('s1','i1','spawn'), e('i1','i2')]), new Map());
  expect([...v.nodes.keys()]).toEqual(['p1','s1']);
  expect(v.nodes.get('s1')).toMatchObject({ type: 'node', innerCount: 2 });
  expect(v.edges).toEqual([{ id: 'p1->s1', from: 'p1', to: 's1', kind: 'sequence' }]);
});

test('默认只展开最后 3 个轮次，更早的各折叠成一个摘要节点', () => {
  const v = buildView(fiveTurnsOfThreeNodes(), new Map());
  expect(v.turns.map((t) => t.collapsed)).toEqual([true, true, false, false, false]);
  expect(v.turns[0]!.nodeIds).toEqual(['turn:t1']);
  expect(v.nodes.size).toBe(2 + 9);
  expect(v.nodes.get('turn:t1')).toMatchObject({ type: 'turn_summary', summary: { nodeCount: 3, toolCount: 1, promptSummary: 'prompt t1' } });
});

test('覆盖项优先于默认：可展开旧轮次、折叠新轮次', () => {
  const v = buildView(fiveTurnsOfThreeNodes(), new Map([['t1', true], ['t5', false]]));
  expect(v.turns.map((t) => t.collapsed)).toEqual([false, true, false, false, true]);
});

test('折叠轮次的边改接到摘要节点，轮次内部的边消失，不重复', () => {
  const v = buildView(fiveTurnsOfThreeNodes(), new Map());   // 每轮 p→x→y，y→下一轮的 p
  expect(v.edges.filter((x) => x.from === 'turn:t1' || x.to === 'turn:t1')).toEqual([{ id: 'turn:t1->turn:t2', from: 'turn:t1', to: 'turn:t2', kind: 'sequence' }]);
  expect(new Set(v.edges.map((x) => x.id)).size).toBe(v.edges.length);
});

test('相邻轮次之间没有边时补一条顺序边', () => {
  const v = buildView(graph([p('p1','t1',0), p('p2','t2',10)], []), new Map());
  expect(v.edges).toEqual([{ id: 'p1->p2', from: 'p1', to: 'p2', kind: 'sequence' }]);
});

test('没有 turnId 的主线节点归入时间上所在的轮次；最前面没有轮次时归入 prelude', () => {
  const v = buildView(graph([sys('c0', null, -5), p('p1','t1',0), tool('h1', null, 3), p('p2','t2',10), tool('h2', null, 12)], []), new Map());
  expect(v.turns.map((t) => [t.key, t.nodeIds])).toEqual([[PRELUDE_TURN, ['c0']], ['t1', ['p1','h1']], ['t2', ['p2','h2']]]);
});

test('悬空的边被跳过：一端不存在或指向子代理内部节点', () => {
  const v = buildView(graph([p('p1','t1',0), inner('i1','a1',1)], [e('p1','missing'), e('p1','i1'), e('ghost','p1')]), new Map());
  expect(v.edges).toEqual([]);
});

test('摘要统计：失败数、是否仍在运行、耗时', () => {
  const v = buildView(graph([p('p1','t1',0), tool('a','t1',1000,{status:'failed'}), tool('b','t1',4000,{status:'running'}), p('p2','t2',9000), p('p3','t3',9001), p('p4','t4',9002)], []), new Map());
  expect(v.turns[0]!.summary).toMatchObject({ failedCount: 1, running: true, durationMs: 4000, toolCount: 2 });
});

test('latestNodeId 是时间最晚的主线节点；它在折叠轮次里时是该摘要节点；空图为 null', () => {
  expect(buildView(emptyGraph(), new Map()).latestNodeId).toBeNull();
  expect(buildView(fiveTurnsOfThreeNodes(), new Map()).latestNodeId).toBe('y5');
  expect(buildView(fiveTurnsOfThreeNodes(), new Map([['t5', false]])).latestNodeId).toBe('turn:t5');
});

test('forkSources：出度 ≥ 2 的视图节点（不论边的 kind）', () => {
  const edges = [
    { id: 'a->b', from: 'a', to: 'b', kind: 'sequence' as const },
    { id: 'a->c', from: 'a', to: 'c', kind: 'sequence' as const },
    { id: 'b->d', from: 'b', to: 'd', kind: 'fork' as const },
  ];
  expect([...forkSources(edges)]).toEqual(['a']);
  expect(forkSources([]).size).toBe(0);
});
