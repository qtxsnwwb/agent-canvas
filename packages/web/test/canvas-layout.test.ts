import { expect, test } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import { emptyGraph, type Graph, type GraphEdge, type GraphNode, type NodeKind } from '@claude-canvas/shared';
import { buildView } from '../src/canvas/view';
import { layoutTurn, stackTurns, turnInput, turnSignature, TURN_GAP, TURN_HEADER, type ElkLike, type TurnLayout } from '../src/canvas/layout';

const EPOCH = Date.parse('2026-01-01T00:00:00Z');
function node(id: string, kind: NodeKind, turnId: string, tMs: number): GraphNode {
  return {
    id, sessionId: 's1', turnId, agentId: null, childAgentId: null, parentId: null, kind, status: null,
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
  expect(await layoutTurn(never, { key: 't', nodes: [n('a', 340, 60)], edges: [] })).toEqual({ key: 't', width: 340, height: 60, positions: { a: { x: 0, y: 0 } } });
});

test('没有边的多个节点也不重叠（占位节点尚未接上）', async () => {
  const l = await layoutTurn(elk, { key: 't', nodes: [n('a'), n('b')], edges: [] });
  const [a, b] = [l.positions.a!, l.positions.b!];
  expect(Math.abs(a.x - b.x) >= 240 || Math.abs(a.y - b.y) >= 52).toBe(true);
});

test('stackTurns：轮次居中堆叠；给最后一个轮次加高不改变前面轮次的任何坐标', () => {
  const t1: TurnLayout = { key: 't1', width: 300, height: 100, positions: { a: { x: 0, y: 0 }, b: { x: 60, y: 48 } } };
  const t2: TurnLayout = { key: 't2', width: 500, height: 80, positions: { c: { x: 130, y: 0 } } };
  const s = stackTurns([t1, t2]);
  expect(s.turnBoxes.t1).toEqual({ x: -150, y: 0, width: 300, height: TURN_HEADER + 100 });
  expect(s.positions.a).toEqual({ x: -150, y: TURN_HEADER });
  expect(s.turnBoxes.t2!.y).toBe(TURN_HEADER + 100 + TURN_GAP);
  expect(s.positions.c).toEqual({ x: -250 + 130, y: TURN_HEADER + 100 + TURN_GAP + TURN_HEADER });
  const s2 = stackTurns([t1, { ...t2, height: 400, width: 900, positions: { c: { x: 330, y: 0 }, d: { x: 0, y: 300 } } }]);
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
