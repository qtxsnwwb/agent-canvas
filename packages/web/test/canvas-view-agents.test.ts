import { expect, test } from 'vitest';
import type { Graph, GraphEdge, GraphNode, NodeKind } from '@claude-canvas/shared';
import { agentGroupKey, buildView, forkSources, TURN_TAIL_NODES, type ViewMode } from '../src/canvas/view';

const EPOCH = Date.parse('2026-01-01T00:00:00Z');

function node(id: string, kind: NodeKind, turnId: string | null, agentId: string | null, tMs: number, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id, sessionId: 's1', turnId, agentId, childAgentId: null, parentId: null, kind, status: null,
    timestamp: new Date(EPOCH + tMs).toISOString(), confirmed: true, title: kind, summary: '', toolName: null,
    toolUseId: null, messageId: null, durationMs: null, endedAt: null, usage: null, systemSubtype: null, ...extra,
  };
}
const p = (id: string, turnId: string, t: number) => node(id, 'prompt', turnId, null, t, { summary: `prompt ${turnId}` });
const tool = (id: string, turnId: string | null, t: number, extra: Partial<GraphNode> = {}) => node(id, 'tool', turnId, null, t, extra);
const text = (id: string, turnId: string | null, t: number) => node(id, 'text', turnId, null, t);
const think = (id: string, turnId: string | null, t: number) => node(id, 'thinking', turnId, null, t);
const sub = (id: string, turnId: string | null, t: number, childAgentId: string | null) => node(id, 'subagent', turnId, null, t, { childAgentId });
const inner = (id: string, agentId: string, t: number, kind: NodeKind = 'tool', extra: Partial<GraphNode> = {}) => node(id, kind, null, agentId, t, extra);
const innerSub = (id: string, agentId: string, t: number, childAgentId: string) => inner(id, agentId, t, 'subagent', { childAgentId });
const e = (from: string, to: string, kind: GraphEdge['kind'] = 'sequence'): GraphEdge => ({ id: `${from}->${to}`, sessionId: 's1', from, to, kind });
function graph(nodes: GraphNode[], edges: GraphEdge[]): Graph {
  return { nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), edges: Object.fromEntries(edges.map((x) => [x.id, x])) };
}

interface Opts { overrides?: ReadonlyMap<string, boolean>; expandedAgents?: ReadonlySet<string>; mode?: ViewMode; keepVisible?: string | null }
const opts = (o: Opts = {}) => o;
function view(g: Graph, o: Opts = {}) {
  return buildView(g, o.overrides ?? new Map(), undefined, { expandedAgents: o.expandedAgents, mode: o.mode, keepVisible: o.keepVisible });
}

/** 主线 p1 → s1(childAgentId a1)；a1 内部 i1 → i2 → i3 */
function mainWithAgent(): Graph {
  return graph(
    [p('p1', 't1', 0), sub('s1', 't1', 1, 'a1'), inner('i1', 'a1', 2), inner('i2', 'a1', 3), inner('i3', 'a1', 4)],
    [e('p1', 's1'), e('s1', 'i1', 'spawn'), e('i1', 'i2'), e('i2', 'i3')],
  );
}
/** s1(a1) 内部有 k1 → s2(a2)，a2 内部有 j1 */
function nestedAgents(): Graph {
  return graph(
    [p('p1', 't1', 0), sub('s1', 't1', 1, 'a1'), inner('k1', 'a1', 2), innerSub('s2', 'a1', 3, 'a2'), inner('j1', 'a2', 4)],
    [e('p1', 's1'), e('s1', 'k1', 'spawn'), e('k1', 's2'), e('s2', 'j1', 'spawn')],
  );
}
/** a1 内部的 s2 的 childAgentId 也是 a1 */
function cyclicAgents(): Graph {
  return graph(
    [p('p1', 't1', 0), sub('s1', 't1', 1, 'a1'), inner('k1', 'a1', 2), innerSub('s2', 'a1', 3, 'a1')],
    [e('p1', 's1'), e('s1', 'k1', 'spawn'), e('k1', 's2')],
  );
}
/** s1 的 childAgentId 是 a1 但 a1 没有内部节点；s0 的 childAgentId 为空 */
function agentWithoutInner(): Graph {
  return graph([p('p1', 't1', 0), sub('s0', 't1', 1, null), sub('s1', 't1', 2, 'a1')], [e('p1', 's0'), e('s0', 's1')]);
}
/** 主线：p1 → th1 → tx1 → {b1, b2}（fork）→ th2 → c1；s1 在 c1 之后（a1 内部有 i1） */
function topologyFixture(): Graph {
  return graph(
    [p('p1', 't1', 0), think('th1', 't1', 1), text('tx1', 't1', 2), tool('b1', 't1', 3), tool('b2', 't1', 4), think('th2', 't1', 5),
      tool('c1', 't1', 6), sub('s1', 't1', 7, 'a1'), inner('i1', 'a1', 8)],
    [e('p1', 'th1'), e('th1', 'tx1'), e('tx1', 'b1', 'fork'), e('tx1', 'b2', 'fork'), e('b1', 'th2'), e('b2', 'th2'), e('th2', 'c1'),
      e('c1', 's1'), e('s1', 'i1', 'spawn')],
  );
}
/** … → c1 → tx9（最晚） */
function endsWithText(): Graph {
  return graph([p('p1', 't1', 0), tool('c1', 't1', 1), text('tx9', 't1', 2)], [e('p1', 'c1'), e('c1', 'tx9')]);
}

test('未展开的子代理不产生内部视图节点，也没有代理分组', () => {
  const v = view(mainWithAgent(), opts());
  expect([...v.nodes.keys()]).toEqual(['p1', 's1']);
  expect(v.agentGroups).toEqual([]);
  expect(v.nodes.get('s1')).toMatchObject({ expanded: false, expandable: true, innerCount: 3, groupKey: 't1' });
  expect(v.mode).toBe('live');
});

test('展开后内部节点进入视图，归入代理分组，带内部的边，不带派发边', () => {
  const v = view(mainWithAgent(), opts({ expandedAgents: new Set(['a1']) }));
  expect(v.agentGroups).toEqual([{ key: 'agent:a1', agentId: 'a1', containerId: 's1', parentGroupKey: 't1', depth: 1, nodeIds: ['i1', 'i2', 'i3'] }]);
  expect(v.nodes.get('i2')).toMatchObject({ groupKey: 'agent:a1', turnKey: 't1' });
  expect(v.nodes.get('s1')).toMatchObject({ expanded: true });
  expect(v.edges.map((e) => e.id).sort()).toEqual(['i1->i2', 'i2->i3', 'p1->s1']);
});

test('嵌套：内层只有在外层展开时才展开；分组按深度降序', () => {
  const g = nestedAgents();
  expect(view(g, opts({ expandedAgents: new Set(['a2']) })).agentGroups).toEqual([]);
  const v = view(g, opts({ expandedAgents: new Set(['a1', 'a2']) }));
  expect(v.agentGroups.map((x) => [x.key, x.depth, x.parentGroupKey])).toEqual([['agent:a2', 2, 'agent:a1'], ['agent:a1', 1, 't1']]);
});

test('环：childAgentId 指回祖先时按未展开处理', () => {
  const v = view(cyclicAgents(), opts({ expandedAgents: new Set(['a1']) }));
  expect(v.nodes.get('s2')).toMatchObject({ expanded: false });
  expect(v.agentGroups).toHaveLength(1);
});

test('容器所在轮次折叠时，展开状态不产生任何内部节点', () => {
  const v = view(mainWithAgent(), opts({ expandedAgents: new Set(['a1']), overrides: new Map([['t1', false]]) }));
  expect([...v.nodes.keys()]).toEqual(['turn:t1']);
  expect(v.agentGroups).toEqual([]);
});

test('childAgentId 为空或没有内部节点的子代理不可展开', () => {
  const v = view(agentWithoutInner(), opts({ expandedAgents: new Set(['a1']) }));
  expect(v.nodes.get('s1')).toMatchObject({ expandable: false, expanded: false });
  expect(v.nodes.get('s0')).toMatchObject({ expandable: false, expanded: false });
  expect(v.nodes.get('p1')).toMatchObject({ expandable: false, expanded: false });
});

test('拓扑视角：隐藏思考和文本，缩并后链路不断，分叉保留', () => {
  const v = view(topologyFixture(), opts({ mode: 'topology', expandedAgents: new Set(['a1']) }));
  expect([...v.nodes.keys()]).toEqual(['p1', 'b1', 'b2', 'c1', 's1']);
  expect(v.edges.map((e) => [e.id, e.kind]).sort()).toEqual([
    ['b1->c1', 'sequence'], ['b2->c1', 'sequence'], ['c1->s1', 'sequence'], ['p1->b1', 'fork'], ['p1->b2', 'fork'],
  ]);
  expect(v.agentGroups).toEqual([]);
  expect(v.mode).toBe('topology');
});

test('拓扑视角：最新节点被隐藏时，latestNodeId 取它之前最晚的可见节点', () => {
  const v = view(endsWithText(), opts({ mode: 'topology' }));
  expect(v.latestNodeId).toBe('c1');
  expect(view(endsWithText()).latestNodeId).toBe('tx9');
});

// ---- 与其他规则的交互 ----

test('同一个 agent id 只产生一个分组：第二个同 childAgentId 的派发节点不展开', () => {
  const g = mainWithAgent();
  g.nodes['s1b'] = sub('s1b', 't1', 5, 'a1');
  g.edges['s1->s1b'] = e('s1', 's1b');
  const v = view(g, opts({ expandedAgents: new Set(['a1']) }));
  expect(v.agentGroups.map((x) => x.containerId)).toEqual(['s1']);
  expect(v.nodes.get('s1')).toMatchObject({ expanded: true });
  expect(v.nodes.get('s1b')).toMatchObject({ expanded: false, expandable: true });
});

test('代理分组内保留 fork 边；跨分组的边丢弃；所有边两端都在视图里', () => {
  const g = mainWithAgent();
  g.edges['i1->i3'] = e('i1', 'i3', 'fork');
  g.edges['i3->p1'] = e('i3', 'p1');
  const v = view(g, opts({ expandedAgents: new Set(['a1']) }));
  expect(v.edges.find((x) => x.id === 'i1->i3')).toMatchObject({ kind: 'fork' });
  expect(v.edges.some((x) => x.id === 'i3->p1')).toBe(false);
  expect(v.edges.every((x) => v.nodes.has(x.from) && v.nodes.has(x.to))).toBe(true);
});

/** One turn 't1': prompt n0, then tools n1..n{count-1}; subagent at index `subAt` (childAgentId a1, with `innerN` inner nodes). */
function longTurnWithAgent(count: number, subAt: number, innerN: number): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (let i = 0; i < count; i++) {
    const id = `n${i}`;
    nodes.push(i === 0 ? p(id, 't1', 0) : i === subAt ? sub(id, 't1', i, 'a1') : tool(id, 't1', i));
    if (i > 0) edges.push(e(`n${i - 1}`, id));
  }
  for (let k = 0; k < innerN; k++) {
    nodes.push(inner(`m${k}`, 'a1', 1000 + k));
    if (k > 0) edges.push(e(`m${k - 1}`, `m${k}`));
  }
  edges.push(e(`n${subAt}`, 'm0', 'spawn'));
  return graph(nodes, edges);
}

test('折叠进 earlier 的派发节点不展开，也不产生分组；earlier 的 groupKey 是轮次键', () => {
  const v = view(longTurnWithAgent(61, 5, 3), opts({ expandedAgents: new Set(['a1']) }));
  expect(v.nodes.has('n5')).toBe(false);
  expect(v.nodes.has('m0')).toBe(false);
  expect(v.agentGroups).toEqual([]);
  expect(v.nodes.get('earlier:t1')).toMatchObject({ type: 'earlier', groupKey: 't1' });
});

test('展开的代理内部节点从不折叠进 earlier（即使超过阈值）', () => {
  const v = view(longTurnWithAgent(10, 9, 100), opts({ expandedAgents: new Set(['a1']) }));
  expect(v.agentGroups).toHaveLength(1);
  expect(v.agentGroups[0]!.nodeIds).toHaveLength(100);
  expect(v.nodes.has('earlier:agent:a1')).toBe(false);
  expect(v.edges.filter((x) => x.from.startsWith('m')).length).toBe(99);
});

test('keepVisible 指向展开代理的内部节点：照常可见；被拓扑视角隐藏的节点不阻止轮次的默认折叠', () => {
  const v = view(mainWithAgent(), opts({ expandedAgents: new Set(['a1']), keepVisible: 'i2' }));
  expect(v.nodes.get('i2')).toMatchObject({ type: 'node' });
  // 五个轮次 p→x→y(text)，y→下一轮 p。
  const five = fiveTurns();
  expect(view(five, opts({ keepVisible: 'y1' })).turns[0]!.collapsed).toBe(false);
  const topo = view(five, opts({ keepVisible: 'y1', mode: 'topology' }));
  expect(topo.turns[0]!.collapsed).toBe(true);
  expect(topo.nodes.has('y1')).toBe(false);
});

function fiveTurns(): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (let i = 1; i <= 5; i++) {
    const t = i * 100;
    nodes.push(p(`p${i}`, `t${i}`, t), tool(`x${i}`, `t${i}`, t + 1), text(`y${i}`, `t${i}`, t + 2));
    edges.push(e(`p${i}`, `x${i}`), e(`x${i}`, `y${i}`));
    if (i < 5) edges.push(e(`y${i}`, `p${i + 1}`));
  }
  return graph(nodes, edges);
}

test('拓扑视角：跨轮次缩并的边是顺序边；摘要仍按全部主线节点统计；groupKey 是轮次键', () => {
  const v = view(fiveTurns(), opts({ mode: 'topology' }));
  expect(v.edges.map((x) => x.id).sort()).toEqual(['p3->x3', 'p4->x4', 'p5->x5', 'turn:t1->turn:t2', 'turn:t2->p3', 'x3->p4', 'x4->p5']);
  expect(v.edges.every((x) => x.kind === 'sequence')).toBe(true);
  expect(v.turns[2]!.summary.nodeCount).toBe(3);
  expect(v.turns[2]!.nodeIds).toEqual(['p3', 'x3']);
  expect(v.nodes.get('turn:t1')).toMatchObject({ groupKey: 't1' });
  expect(v.nodes.get('x3')).toMatchObject({ groupKey: 't3' });
  expect(v.latestNodeId).toBe('x5');
});

test('拓扑视角：轮内折叠只计可见节点，缩并在折叠改接之前，链路保持连通', () => {
  // 提示 n0，之后 61 个工具 n1..n61，每个工具后跟一个文本 w{i}：实时视角 123 个节点，拓扑视角 62 个可见。
  const nodes: GraphNode[] = [p('n0', 't1', 0)];
  const edges: GraphEdge[] = [];
  let prev = 'n0';
  for (let i = 1; i <= 61; i++) {
    nodes.push(tool(`n${i}`, 't1', i * 10), text(`w${i}`, 't1', i * 10 + 1));
    edges.push(e(prev, `n${i}`), e(`n${i}`, `w${i}`));
    prev = `w${i}`;
  }
  const g = graph(nodes, edges);
  const v = view(g, opts({ mode: 'topology' }));
  const t = v.turns[0]!;
  const tail = Array.from({ length: TURN_TAIL_NODES }, (_, k) => `n${22 + k}`);
  expect(t.nodeIds).toEqual(['n0', 'earlier:t1', ...tail]);
  expect(t.foldedEarlier).toBe(21);
  expect(t.foldedIds.every((id) => id.startsWith('n'))).toBe(true);
  expect(v.nodes.get('earlier:t1')).toMatchObject({ count: 21, toolCount: 21, groupKey: 't1' });
  const ids = new Set(v.edges.map((x) => x.id));
  expect(ids.has('n0->earlier:t1')).toBe(true);
  expect(ids.has('earlier:t1->n22')).toBe(true);
  for (let i = 22; i < 61; i++) expect(ids.has(`n${i}->n${i + 1}`)).toBe(true);
  expect(v.edges.every((x) => v.nodes.has(x.from) && v.nodes.has(x.to))).toBe(true);
  // 实时视角按全部节点折叠。
  expect(view(g).turns[0]!.foldedEarlier).toBe(123 - 1 - TURN_TAIL_NODES);
  expect(forkSources(v.edges, (id) => v.nodes.get(id)?.type === 'earlier').size).toBe(0);
});

test('拓扑视角：没有可见节点的轮次 nodeIds 为空，补的轮间边连接最近的非空轮次', () => {
  const g = graph(
    [p('p1', 't1', 0), tool('x1', 't1', 1), text('y2', 't2', 10), think('z2', 't2', 11), p('p3', 't3', 20)],
    [e('p1', 'x1'), e('y2', 'z2')],
  );
  const v = view(g, opts({ mode: 'topology' }));
  expect(v.turns.map((t) => [t.key, t.collapsed, t.nodeIds])).toEqual([['t1', false, ['p1', 'x1']], ['t2', false, []], ['t3', false, ['p3']]]);
  expect(v.edges.map((x) => x.id).sort()).toEqual(['p1->x1', 'x1->p3']);
  expect(v.turns[1]!.summary.nodeCount).toBe(2);
  // 缩并后已连通时不再补边。
  g.edges['x1->y2'] = e('x1', 'y2');
  g.edges['z2->p3'] = e('z2', 'p3');
  expect(view(g, opts({ mode: 'topology' })).edges.map((x) => x.id).sort()).toEqual(['p1->x1', 'x1->p3']);
});

test('agentGroupKey', () => {
  expect(agentGroupKey('a1')).toBe('agent:a1');
});
