import { expect, test } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import { emptyGraph, type Graph, type GraphEdge, type GraphNode, type NodeKind } from '@claude-canvas/shared';
import { agentGroupKey, buildView, type AgentGroup, type CanvasView } from '../src/canvas/view';
import {
  groupInput, layoutTurn, placeAgentGroups, stackTurns, turnInput, turnSignature, TURN_GAP, TURN_HEADER, type ElkLike, type TurnLayout,
} from '../src/canvas/layout';
import { containerSize, sizeOf } from '../src/canvas/sizes';

const EPOCH = Date.parse('2026-01-01T00:00:00Z');
function node(id: string, kind: NodeKind, turnId: string, tMs: number): GraphNode {
  return {
    id, sessionId: 's1', turnId, agentId: null, childAgentId: null, endedAt: null, parentId: null, kind, status: null,
    timestamp: new Date(EPOCH + tMs).toISOString(), confirmed: true, title: kind, summary: `${kind} ${id}`, toolName: null,
    toolUseId: null, messageId: null, durationMs: null, usage: null, systemSubtype: null,
  };
}
const e = (from: string, to: string): GraphEdge => ({ id: `${from}->${to}`, sessionId: 's1', from, to, kind: 'sequence' });
function twoTurnsLinked(): Graph {
  const nodes = [node('p1', 'prompt', 't1', 0), node('x1', 'tool', 't1', 1), node('y1', 'text', 't1', 2), node('p2', 'prompt', 't2', 100), node('x2', 'tool', 't2', 101)];
  const edges = [e('p1', 'x1'), e('x1', 'y1'), e('y1', 'p2'), e('p2', 'x2')];
  return { ...emptyGraph(), nodes: Object.fromEntries(nodes.map((x) => [x.id, x])), edges: Object.fromEntries(edges.map((x) => [x.id, x])) };
}

const n = (id: string, width = 240, height = 52) => ({ id, width, height });
const elk = new ELK();

test('链式节点自上而下排列，互不重叠', async () => {
  const l = await layoutTurn(elk, { key: 't', nodes: [n('a'), n('b'), n('c')], edges: [{ id: 'a->b', from: 'a', to: 'b' }, { id: 'b->c', from: 'b', to: 'c' }] });
  expect(l.positions.a!.y).toBeLessThan(l.positions.b!.y);
  expect(l.positions.b!.y - l.positions.a!.y).toBeGreaterThanOrEqual(52);
  expect(l.positions.b!.y).toBeLessThan(l.positions.c!.y);
});

test('并行分叉的节点在同一层、左右排开且按输入顺序', async () => {
  const l = await layoutTurn(elk, { key: 't', nodes: [n('a'), n('b1'), n('b2'), n('b3')], edges: ['b1', 'b2', 'b3'].map((b) => ({ id: `a->${b}`, from: 'a', to: b })) });
  expect(new Set([l.positions.b1!.y, l.positions.b2!.y, l.positions.b3!.y]).size).toBe(1);
  expect(l.positions.b1!.x + 240).toBeLessThanOrEqual(l.positions.b2!.x);
  expect(l.positions.b2!.x + 240).toBeLessThanOrEqual(l.positions.b3!.x);
  expect(l.width).toBeGreaterThanOrEqual(3 * 240);
});

test('单节点不调用 elk', async () => {
  const never: ElkLike = { layout: () => { throw new Error('called'); } };
  expect(await layoutTurn(never, { key: 't', nodes: [n('a', 340, 60)], edges: [] })).toEqual({ key: 't', width: 340, height: 60, anchorX: 170, positions: { a: { x: 0, y: 0 } } });
});

test('没有边的多个节点也不重叠（占位节点尚未接上）', async () => {
  const l = await layoutTurn(elk, { key: 't', nodes: [n('a'), n('b')], edges: [] });
  const [a, b] = [l.positions.a!, l.positions.b!];
  expect(Math.abs(a.x - b.x) >= 240 || Math.abs(a.y - b.y) >= 52).toBe(true);
});

test('stackTurns：轮次按锚点居中堆叠；给最后一个轮次加高不改变前面轮次的任何坐标', () => {
  const t1: TurnLayout = { key: 't1', width: 300, height: 100, anchorX: 150, positions: { a: { x: 0, y: 0 }, b: { x: 60, y: 48 } } };
  const t2: TurnLayout = { key: 't2', width: 500, height: 80, anchorX: 250, positions: { c: { x: 130, y: 0 } } };
  const s = stackTurns([t1, t2]);
  expect(s.turnBoxes.t1).toEqual({ x: -150, y: 0, width: 300, height: TURN_HEADER + 100 });
  expect(s.positions.a).toEqual({ x: -150, y: TURN_HEADER });
  expect(s.turnBoxes.t2!.y).toBe(TURN_HEADER + 100 + TURN_GAP);
  expect(s.positions.c).toEqual({ x: -250 + 130, y: TURN_HEADER + 100 + TURN_GAP + TURN_HEADER });
  const s2 = stackTurns([t1, { ...t2, height: 400, width: 900, anchorX: 450, positions: { c: { x: 330, y: 0 }, d: { x: 0, y: 300 } } }]);
  expect(s2.positions.a).toEqual(s.positions.a);
  expect(s2.positions.b).toEqual(s.positions.b);
  expect(s2.turnBoxes.t1).toEqual(s.turnBoxes.t1);
});

test('turnInput 只带本轮次内部的边；turnSignature 随节点或边变化', () => {
  const v = buildView(twoTurnsLinked(), new Map());
  const input = turnInput(v, v.turns[0]!);
  expect(input.nodes.length).toBe(3);
  expect(input.edges.length).toBe(2);
  expect(input.edges.every((x) => input.nodes.some((y) => y.id === x.from) && input.nodes.some((y) => y.id === x.to))).toBe(true);
  expect(turnSignature(input)).toBe(turnSignature(turnInput(v, v.turns[0]!)));
  expect(turnSignature({ ...input, nodes: [...input.nodes, n('z')] })).not.toBe(turnSignature(input));
  expect(turnSignature({ ...input, edges: input.edges.slice(1) })).not.toBe(turnSignature(input));
});

test('stackTurns：每个轮次的第一个节点中心都在 x = 0（直的主干），加高最后一个轮次不改前面的坐标', () => {
  // t1: first node a (width 240) starts at relative x 400 -> centre 520; t2: first node c (width 280) at 0 -> centre 140.
  const t1: TurnLayout = { key: 't1', width: 900, height: 100, anchorX: 520, positions: { a: { x: 400, y: 0 }, b: { x: 0, y: 48 } } };
  const t2: TurnLayout = { key: 't2', width: 600, height: 80, anchorX: 140, positions: { c: { x: 0, y: 0 } } };
  const s = stackTurns([t1, t2]);
  expect(s.positions.a!.x + 120).toBe(0);
  expect(s.positions.c!.x + 140).toBe(0);
  expect(s.turnBoxes.t1!.x + 520).toBe(0);
  expect(s.turnBoxes.t2!.x + 140).toBe(0);
  const s2 = stackTurns([t1, { ...t2, height: 300, width: 1200, anchorX: 700, positions: { c: { x: 560, y: 0 }, d: { x: 0, y: 200 } } }]);
  expect(s2.positions.a).toEqual(s.positions.a);
  expect(s2.positions.b).toEqual(s.positions.b);
  expect(s2.turnBoxes.t1).toEqual(s.turnBoxes.t1);
  expect(s2.positions.c!.x + 140).toBe(0);
});

test('layoutTurn 的 anchorX 是第一个输入节点的水平中心', async () => {
  const l = await layoutTurn(elk, { key: 't', nodes: [n('a', 280, 64), n('b1'), n('b2')], edges: [{ id: 'a->b1', from: 'a', to: 'b1' }, { id: 'a->b2', from: 'a', to: 'b2' }] });
  expect(l.anchorX).toBe(l.positions.a!.x + 140);
});

test('分叉：a → {b1,b2,b3} → c 时 a 与 c 的中心与 b2 的中心相差不到 1 px', async () => {
  const bs = ['b1', 'b2', 'b3'];
  const l = await layoutTurn(elk, {
    key: 't',
    nodes: [n('a'), ...bs.map((b) => n(b)), n('c')],
    edges: [...bs.map((b) => ({ id: `a->${b}`, from: 'a', to: b })), ...bs.map((b) => ({ id: `${b}->c`, from: b, to: 'c' }))],
  });
  const cx = (id: string) => l.positions[id]!.x + 120;
  expect(Math.abs(cx('a') - cx('b2'))).toBeLessThan(1);
  expect(Math.abs(cx('c') - cx('b2'))).toBeLessThan(1);
});

test('turnInput 的边按实际输出的节点过滤，而不是按 turn.nodeIds', () => {
  const v = buildView(twoTurnsLinked(), new Map());
  const turn = v.turns[0]!;
  const nodes = new Map(v.nodes);
  nodes.delete('x1'); // listed in turn.nodeIds but missing from the view's node map
  const input = turnInput({ ...v, nodes } as CanvasView, turn);
  expect(input.nodes.map((x) => x.id)).toEqual(['p1', 'y1']);
  expect(input.edges).toEqual([]);
});

/** 主线 p1(prompt) → s1(subagent, childAgentId a1)；a1 内部 i1 → i2 */
function mainWithAgent(): Graph {
  const nodes = [
    node('p1', 'prompt', 't1', 0), { ...node('s1', 'subagent', 't1', 1), childAgentId: 'a1' },
    { ...node('i1', 'tool', 't1', 2), turnId: null, agentId: 'a1' }, { ...node('i2', 'tool', 't1', 3), turnId: null, agentId: 'a1' },
  ];
  const edges = [e('p1', 's1'), { ...e('s1', 'i1'), kind: 'spawn' as const }, e('i1', 'i2')];
  return { ...emptyGraph(), nodes: Object.fromEntries(nodes.map((x) => [x.id, x])), edges: Object.fromEntries(edges.map((x) => [x.id, x])) };
}
const opts = (o: { expandedAgents?: ReadonlySet<string> } = {}) => o;
const view = (graph: Graph, o: { expandedAgents?: ReadonlySet<string> } = {}) => buildView(graph, new Map(), undefined, o);
const g = (key: string, containerId: string, depth: number, nodeIds: string[]): AgentGroup =>
  ({ key, agentId: key.slice('agent:'.length), containerId, parentGroupKey: 't1', depth, nodeIds, foldedIds: [] });

test('containerSize：加内边距和标题区，宽度有下限', () => {
  expect(containerSize({ width: 500, height: 300 })).toEqual({ width: 532, height: 400 });
  expect(containerSize({ width: 100, height: 40 })).toEqual({ width: 260, height: 140 });
});

test('groupInput 对展开的容器使用给定尺寸，其余用 sizeOf；只带分组内部的边', () => {
  const v = view(mainWithAgent(), opts({ expandedAgents: new Set(['a1']) }));
  const input = groupInput(v, 't1', v.turns[0]!.nodeIds, new Map([['s1', { width: 532, height: 400 }]]));
  expect(input.key).toBe('t1');
  expect(input.nodes).toEqual([{ id: 'p1', width: 280, height: 64 }, { id: 's1', width: 532, height: 400 }]);
  expect(input.edges).toEqual([{ id: 'p1->s1', from: 'p1', to: 's1' }]);
  // The agent group itself: its inner nodes and only the edges between them.
  const group = v.agentGroups[0]!;
  expect(group.key).toBe(agentGroupKey('a1'));
  const inner = groupInput(v, group.key, group.nodeIds, new Map());
  expect(inner).toEqual({
    key: 'agent:a1', nodes: [{ id: 'i1', width: 240, height: 52 }, { id: 'i2', width: 240, height: 52 }], edges: [{ id: 'i1->i2', from: 'i1', to: 'i2' }],
  });
  // turnInput is the thin wrapper with no container sizes.
  expect(turnInput(v, v.turns[0]!)).toEqual(groupInput(v, 't1', v.turns[0]!.nodeIds, new Map()));
});

test('placeAgentGroups：内部节点坐标 = 容器坐标 + 偏移；嵌套逐层累加', () => {
  const base = { positions: { s1: { x: 100, y: 200 } } };
  const outer = { group: g('agent:a1', 's1', 1, ['i1', 's2']), layout: { key: 'agent:a1', width: 300, height: 200, anchorX: 120, positions: { i1: { x: 0, y: 0 }, s2: { x: 10, y: 80 } } } };
  const inner = { group: g('agent:a2', 's2', 2, ['j1']), layout: { key: 'agent:a2', width: 240, height: 52, anchorX: 120, positions: { j1: { x: 0, y: 0 } } } };
  const r = placeAgentGroups(base, [outer, inner]);
  expect(r.positions.s1).toEqual({ x: 100, y: 200 });
  expect(r.positions.i1).toEqual({ x: 116, y: 284 });
  expect(r.positions.s2).toEqual({ x: 126, y: 364 });
  expect(r.positions.j1).toEqual({ x: 142, y: 448 });
  expect(r.containerBoxes.s1).toEqual({ x: 100, y: 200, width: 332, height: 300 });
  expect(r.containerBoxes.s2).toEqual({ x: 126, y: 364, width: 272, height: 152 });
  expect(base.positions).toEqual({ s1: { x: 100, y: 200 } }); // input untouched
});

test('placeAgentGroups：容器没有位置时，其分组（及更深的分组）不放置', () => {
  const outer = { group: g('agent:a1', 's1', 1, ['i1', 's2']), layout: { key: 'agent:a1', width: 300, height: 200, anchorX: 120, positions: { i1: { x: 0, y: 0 }, s2: { x: 10, y: 80 } } } };
  const inner = { group: g('agent:a2', 's2', 2, ['j1']), layout: { key: 'agent:a2', width: 240, height: 52, anchorX: 120, positions: { j1: { x: 0, y: 0 } } } };
  const r = placeAgentGroups({ positions: { p1: { x: 0, y: 0 } } }, [outer, inner]);
  expect(r.positions).toEqual({ p1: { x: 0, y: 0 } });
  expect(r.containerBoxes).toEqual({});
});

test('stackTurns：没有节点的轮次不占纵向空间，也没有轮次框', () => {
  const t1: TurnLayout = { key: 't1', width: 300, height: 100, anchorX: 150, positions: { a: { x: 0, y: 0 } } };
  const empty: TurnLayout = { key: 't2', width: 0, height: 0, anchorX: 0, positions: {} };
  const t3: TurnLayout = { key: 't3', width: 300, height: 80, anchorX: 150, positions: { c: { x: 0, y: 0 } } };
  const s = stackTurns([t1, empty, t3]);
  expect(s.turnBoxes.t2).toBeUndefined();
  expect(s.turnBoxes.t3!.y).toBe(TURN_HEADER + 100 + TURN_GAP);
  expect(s.turnBoxes.t3).toEqual(stackTurns([t1, t3]).turnBoxes.t3);
});

test('因果视角下思考节点用大尺寸，其余尺寸不变', () => {
  const nodes = [node('th', 'thinking', 't1', 1), node('tl', 'tool', 't1', 2)];
  const g: Graph = { ...emptyGraph(), nodes: Object.fromEntries(nodes.map((x) => [x.id, x])), edges: {} };
  const v = buildView(g, new Map());
  const thinkingViewNode = v.nodes.get('th')!;
  const toolViewNode = v.nodes.get('tl')!;
  expect(sizeOf(thinkingViewNode, 'causal')).toEqual({ width: 280, height: 56 });
  expect(sizeOf(thinkingViewNode)).toEqual({ width: 160, height: 28 });
  expect(sizeOf(toolViewNode, 'causal')).toEqual(sizeOf(toolViewNode));
  const causal = buildView(g, new Map(), undefined, { mode: 'causal' });
  expect(groupInput(causal, 't1', ['th', 'tl'], new Map()).nodes[0]).toMatchObject({ width: 280, height: 56 });
});

test('placeAgentGroups：容器被撑到最小宽度时，较窄的内部布局水平居中', () => {
  const base = { positions: { s1: { x: 100, y: 200 } } };
  const narrow = { group: g('agent:a1', 's1', 1, ['i1']), layout: { key: 'agent:a1', width: 100, height: 40, anchorX: 50, positions: { i1: { x: 0, y: 0 } } } };
  const r = placeAgentGroups(base, [narrow]);
  expect(r.containerBoxes.s1).toEqual({ x: 100, y: 200, width: 260, height: 140 });
  // (260 - 2 * 16 - 100) / 2 = 64 to the right of the padding.
  expect(r.positions.i1).toEqual({ x: 100 + 16 + 64, y: 284 });
});
