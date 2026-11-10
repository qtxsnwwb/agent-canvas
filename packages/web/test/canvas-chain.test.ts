import { expect, test } from 'vitest';
import type { Graph, GraphEdge, GraphNode, NodeKind } from '@claude-canvas/shared';
import { buildView, type CanvasView, type ViewMode } from '../src/canvas/view';
import { EMPTY_CHAIN, expandCut, upstreamChain } from '../src/canvas/chain';

const EPOCH = Date.parse('2026-01-01T00:00:00Z');
function node(id: string, kind: NodeKind, turnId: string | null, agentId: string | null, tMs: number, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id, sessionId: 's1', turnId, agentId, childAgentId: null, parentId: null, kind, status: null,
    timestamp: new Date(EPOCH + tMs).toISOString(), confirmed: true, title: kind, summary: '', toolName: null,
    toolUseId: null, messageId: null, durationMs: null, endedAt: null, usage: null, systemSubtype: null, ...extra,
  };
}
const p = (id: string, turnId: string, t: number) => node(id, 'prompt', turnId, null, t);
const tool = (id: string, turnId: string | null, t: number) => node(id, 'tool', turnId, null, t);
const text = (id: string, turnId: string | null, t: number) => node(id, 'text', turnId, null, t);
const think = (id: string, turnId: string | null, t: number) => node(id, 'thinking', turnId, null, t);
const sub = (id: string, turnId: string | null, t: number, childAgentId: string) => node(id, 'subagent', turnId, null, t, { childAgentId });
const inner = (id: string, agentId: string, t: number, kind: NodeKind = 'tool') => node(id, kind, null, agentId, t);
const e = (from: string, to: string, kind: GraphEdge['kind'] = 'sequence'): GraphEdge => ({ id: `${from}->${to}`, sessionId: 's1', from, to, kind });
function graph(nodes: GraphNode[], edges: GraphEdge[]): Graph {
  return { nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), edges: Object.fromEntries(edges.map((x) => [x.id, x])) };
}
interface Opts { overrides?: ReadonlyMap<string, boolean>; expandedAgents?: ReadonlySet<string>; mode?: ViewMode; full?: ReadonlySet<string> }
const opts = (o: Opts = {}) => o;
function buildV(g: Graph, o: Opts = {}) {
  return buildView(g, o.overrides ?? new Map(), o.full, { expandedAgents: o.expandedAgents, mode: o.mode });
}

/** t1: p1 → th1 → tx1 → a1；t2: p2 → th2 → b2；a1 → p2 */
function twoTurnChain(): Graph {
  return graph(
    [p('p1', 't1', 0), think('th1', 't1', 1), text('tx1', 't1', 2), tool('a1', 't1', 3), p('p2', 't2', 10), think('th2', 't2', 11), tool('b2', 't2', 12)],
    [e('p1', 'th1'), e('th1', 'tx1'), e('tx1', 'a1'), e('a1', 'p2'), e('p2', 'th2'), e('th2', 'b2')],
  );
}
/** p1 → tx1 → {b1, b2} → c1 */
function forkJoin(): Graph {
  return graph(
    [p('p1', 't1', 0), text('tx1', 't1', 1), tool('b1', 't1', 2), tool('b2', 't1', 3), tool('c1', 't1', 4)],
    [e('p1', 'tx1'), e('tx1', 'b1', 'fork'), e('tx1', 'b2', 'fork'), e('b1', 'c1'), e('b2', 'c1')],
  );
}
/** Five turns; x9 has no turnId and lands in the last turn, its upstream edge comes from collapsed turn t1. */
function chainIntoCollapsedTurn(): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (let i = 1; i <= 5; i++) nodes.push(p(`p${i}`, `t${i}`, i * 100), tool(`x${i}`, `t${i}`, i * 100 + 1));
  for (let i = 1; i <= 5; i++) edges.push(e(`p${i}`, `x${i}`));
  nodes.push(tool('x9', null, 502));
  edges.push(e('x1', 'x9'), e('x2', 'x1')); // turn:t2 (collapsed) is upstream of turn:t1 (collapsed)
  return graph(nodes, edges);
}
/** p1 → tx1 → s1(a1)；a1 内部 i1 → ith → i2 */
function mainWithAgentReasoning(): Graph {
  return graph(
    [p('p1', 't1', 0), text('tx1', 't1', 1), sub('s1', 't1', 2, 'a1'), inner('i1', 'a1', 3), inner('ith', 'a1', 4, 'thinking'), inner('i2', 'a1', 5)],
    [e('p1', 'tx1'), e('tx1', 's1'), e('s1', 'i1', 'spawn'), e('i1', 'ith'), e('ith', 'i2')],
  );
}
/** a → b → a, no prompt */
function cyclicEdges(): Graph {
  return graph([tool('a', 't1', 0), tool('b', 't1', 1)], [e('a', 'b'), e('b', 'a')]);
}
function longChain(n: number): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push(i === 0 ? p('n0', 't1', 0) : tool(`n${i}`, 't1', i));
    if (i > 0) edges.push(e(`n${i - 1}`, `n${i}`));
  }
  return graph(nodes, edges);
}

test('沿边逆向走到本轮提示为止，不越过提示', () => {
  const v = buildV(twoTurnChain(), opts({ mode: 'causal' }));
  const c = upstreamChain(v, 'b2');
  expect([...c.nodeIds].sort()).toEqual(['b2', 'p2', 'th2']);
  expect([...c.edgeIds].sort()).toEqual(['p2->th2', 'th2->b2']);
  expect(c.reasoning).toEqual(['th2']);
});

test('并行分叉：汇合点之后的节点，上游包含每个分支', () => {
  const c = upstreamChain(buildV(forkJoin(), opts({ mode: 'causal' })), 'c1');
  expect([...c.nodeIds].sort()).toEqual(['b1', 'b2', 'c1', 'p1', 'tx1']);
  expect(c.reasoning).toEqual(['tx1']);
});

test('上游是折叠的轮次：摘要节点算进链并停止', () => {
  const v = buildV(chainIntoCollapsedTurn(), opts({ mode: 'causal' }));
  const c = upstreamChain(v, 'x9');
  expect(c.nodeIds.has('turn:t1')).toBe(true);
  expect(c.nodeIds.has('turn:t2')).toBe(false);
  expect(v.edges.some((x) => x.from === 'turn:t2' && x.to === 'turn:t1')).toBe(true);
  expect([...c.nodeIds].every((id) => id === 'turn:t1' || !id.startsWith('turn:'))).toBe(true);
});

test('子代理内部：走到内部起点后接到容器节点，再向上到提示', () => {
  const v = buildV(mainWithAgentReasoning(), opts({ mode: 'causal', expandedAgents: new Set(['a1']) }));
  const c = upstreamChain(v, 'i2');
  expect([...c.nodeIds].sort()).toEqual(['i1', 'i2', 'ith', 'p1', 's1', 'tx1']);
  expect(c.reasoning).toEqual(['tx1', 'ith']);
});

test('有环的边不会死循环，每个节点只出现一次', () => {
  const c = upstreamChain(buildV(cyclicEdges(), opts({ mode: 'causal' })), 'b');
  expect([...c.nodeIds].sort()).toEqual(['a', 'b']);
});

test('起点是提示或摘要节点时链只有它自己；起点不存在或为 null 时是空链', () => {
  const v = buildV(twoTurnChain(), opts({ mode: 'causal' }));
  expect([...upstreamChain(v, 'p2').nodeIds]).toEqual(['p2']);
  expect(upstreamChain(v, 'gone')).toBe(EMPTY_CHAIN);
  expect(upstreamChain(v, null)).toBe(EMPTY_CHAIN);
  const c = upstreamChain(buildV(chainIntoCollapsedTurn(), opts({ mode: 'causal' })), 'turn:t1');
  expect([...c.nodeIds]).toEqual(['turn:t1']);
});

test('earlier 节点和摘要节点一样：进入链后不再继续', () => {
  const v = buildV(longChain(70), opts({ mode: 'causal' }));
  expect(v.nodes.has('earlier:t1')).toBe(true);
  const c = upstreamChain(v, 'n69');
  expect(c.nodeIds.has('earlier:t1')).toBe(true);
  expect(c.nodeIds.has('n0')).toBe(false); // the walk stops at earlier
  expect(upstreamChain(v, 'earlier:t1').nodeIds.size).toBe(1);
});

test('500 个节点的直链在 50 毫秒内算完', () => {
  const v = buildV(longChain(500), opts({ mode: 'causal', overrides: new Map([['t1', true]]), full: new Set(['t1']) }));
  const t = performance.now();
  expect(upstreamChain(v, 'n499').nodeIds.size).toBe(500);
  expect(performance.now() - t).toBeLessThan(50);
});

test('源节点不在视图里的边被忽略', () => {
  const real = buildV(twoTurnChain(), opts({ mode: 'causal' }));
  const v: CanvasView = { ...real, edges: [...real.edges, { id: 'ghost->b2', from: 'ghost', to: 'b2', kind: 'sequence' }] };
  const c = upstreamChain(v, 'b2');
  expect([...c.nodeIds].sort()).toEqual(['b2', 'p2', 'th2']);
  expect(c.edgeIds.has('ghost->b2')).toBe(false);
});

test('同一个视图上多次调用结果正确且互不影响', () => {
  const v = buildV(twoTurnChain(), opts({ mode: 'causal' }));
  const a = upstreamChain(v, 'b2');
  const b = upstreamChain(v, 'tx1');
  expect([...b.nodeIds].sort()).toEqual(['p1', 'th1', 'tx1']);
  expect(upstreamChain(v, 'b2')).toEqual(a);
});

test('EMPTY_CHAIN 可以安全共享：reasoning 已冻结', () => {
  expect(Object.isFrozen(EMPTY_CHAIN.reasoning)).toBe(true);
});

test('拓扑视角：思考和文本被隐藏，reasoning 为空且不报错', () => {
  const v = buildV(twoTurnChain(), opts({ mode: 'topology' }));
  const c = upstreamChain(v, 'b2');
  expect(c.reasoning).toEqual([]);
  expect(c.nodeIds.has('b2')).toBe(true);
});

test('时间戳相同的推理节点按 id 排序', () => {
  const g = graph(
    [p('p1', 't1', 0), think('zz', 't1', 5), text('aa', 't1', 5), tool('c1', 't1', 9)],
    [e('p1', 'zz'), e('p1', 'aa'), e('zz', 'c1'), e('aa', 'c1')],
  );
  expect(upstreamChain(buildV(g, opts({ mode: 'causal' })), 'c1').reasoning).toEqual(['aa', 'zz']);
});

test('被折叠截断：走到 earlier 时 truncated 为真，cutAt 是 earlier 节点', () => {
  const v = buildV(longChain(70), opts({ mode: 'causal' }));
  const c = upstreamChain(v, 'n69');
  expect(c.truncated).toBe(true);
  expect(c.cutAt).toEqual(['earlier:t1']);
});

test('被折叠截断：走到折叠轮次的摘要节点时 truncated 为真，cutAt 是摘要节点', () => {
  const c = upstreamChain(buildV(chainIntoCollapsedTurn(), opts({ mode: 'causal' })), 'x9');
  expect(c.truncated).toBe(true);
  expect(c.cutAt).toEqual(['turn:t1']);
});

test('走到提示为止的链不算截断；起点本身是摘要节点时也不算', () => {
  const v = buildV(twoTurnChain(), opts({ mode: 'causal' }));
  const c = upstreamChain(v, 'b2');
  expect(c.truncated).toBe(false);
  expect(c.cutAt).toEqual([]);
  const s = upstreamChain(buildV(chainIntoCollapsedTurn(), opts({ mode: 'causal' })), 'turn:t1');
  expect(s.truncated).toBe(false);
  expect(s.cutAt).toEqual([]);
  expect(EMPTY_CHAIN.truncated).toBe(false);
  expect(EMPTY_CHAIN.cutAt).toEqual([]);
  expect(Object.isFrozen(EMPTY_CHAIN.cutAt)).toBe(true);
});

test('expandCut：earlier 对应 showFullTurn(groupKey)，摘要节点对应展开该轮次', () => {
  const v1 = buildV(longChain(70), opts({ mode: 'causal' }));
  expect(expandCut(v1, upstreamChain(v1, 'n69').cutAt)).toEqual({ fullTurns: ['t1'], turns: [] });
  const v2 = buildV(chainIntoCollapsedTurn(), opts({ mode: 'causal' }));
  expect(expandCut(v2, upstreamChain(v2, 'x9').cutAt)).toEqual({ fullTurns: [], turns: ['t1'] });
  expect(expandCut(v2, ['gone', 'x9'])).toEqual({ fullTurns: [], turns: [] });
});
