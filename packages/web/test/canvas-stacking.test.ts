import { expect, test } from 'vitest';
import type { Graph, GraphEdge, GraphNode, NodeKind } from '@claude-canvas/shared';
import { buildView } from '../src/canvas/view';
import { edgeZ, groupDepths, HEADER_Z, nodeZ, Z_PER_DEPTH } from '../src/canvas/stacking';

const EPOCH = Date.parse('2026-01-01T00:00:00Z');
function node(id: string, kind: NodeKind, turnId: string | null, agentId: string | null, tMs: number, childAgentId: string | null = null): GraphNode {
  return {
    id, sessionId: 's1', turnId, agentId, childAgentId, parentId: null, kind, status: null,
    timestamp: new Date(EPOCH + tMs).toISOString(), confirmed: true, title: kind, summary: '', toolName: null,
    toolUseId: null, messageId: null, durationMs: null, endedAt: null, usage: null, systemSubtype: null,
  };
}
const e = (from: string, to: string, kind: GraphEdge['kind'] = 'sequence'): GraphEdge => ({ id: `${from}->${to}`, sessionId: 's1', from, to, kind });

/** p1 → s1(a1) → c1；a1 内部 k1 → s2(a2)；a2 内部 j1 → j2 */
function nested(): Graph {
  const nodes = [
    node('p1', 'prompt', 't1', null, 0), node('s1', 'subagent', 't1', null, 1, 'a1'), node('c1', 'tool', 't1', null, 9),
    node('k1', 'tool', null, 'a1', 2), node('s2', 'subagent', null, 'a1', 3, 'a2'),
    node('j1', 'tool', null, 'a2', 4), node('j2', 'tool', null, 'a2', 5),
  ];
  const edges = [e('p1', 's1'), e('s1', 'c1'), e('s1', 'k1', 'spawn'), e('k1', 's2'), e('s2', 'j1', 'spawn'), e('j1', 'j2')];
  return { nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), edges: Object.fromEntries(edges.map((x) => [x.id, x])) };
}

function zOf(expanded: string[]) {
  const view = buildView(nested(), new Map(), undefined, { expandedAgents: new Set(expanded) });
  const depths = groupDepths(view);
  const z = (id: string) => nodeZ(depths, view.nodes.get(id)!);
  const ez = (id: string, onChain = false) => edgeZ(view, depths, view.edges.find((x) => x.id === id)!, onChain);
  return { view, z, ez };
}

/** Each depth is one layer of Z_PER_DEPTH values: (turn headers,) edges, edges on the chain, nodes. */
const layer = (depth: number) => ({
  edge: depth * Z_PER_DEPTH + 1, chain: depth * Z_PER_DEPTH + 2, node: depth * Z_PER_DEPTH + 3,
});

test('轮次标题栏在第 0 层最底下：低于普通边', () => {
  const { ez } = zOf([]);
  expect(HEADER_Z).toBeLessThan(ez('p1->s1'));
  expect(HEADER_Z).toBe(0);
});

test('没有展开的子代理时所有节点和边都在第 0 层', () => {
  const { view, z, ez } = zOf([]);
  for (const id of view.nodes.keys()) expect(z(id)).toBe(layer(0).node);
  for (const x of view.edges) expect(ez(x.id)).toBe(layer(0).edge);
});

test('容器低于内部节点，嵌套容器高于外层容器，组内的边画在本组容器之上、本组节点之下', () => {
  const { z, ez } = zOf(['a1', 'a2']);
  expect(z('p1')).toBe(layer(0).node);
  expect(z('s1')).toBe(layer(0).node); // 外层容器在主线组里
  expect(z('k1')).toBe(layer(1).node);
  expect(z('s2')).toBe(layer(1).node); // 嵌套容器：高于 s1，低于自己的内部节点
  expect(z('j1')).toBe(layer(2).node);
  expect(z('j2')).toBe(layer(2).node);
  expect(ez('p1->s1')).toBe(layer(0).edge);
  expect(ez('s1->c1')).toBe(layer(0).edge);
  expect(ez('k1->s2')).toBe(layer(1).edge); // 画在 s1 的底色之上
  expect(ez('j1->j2')).toBe(layer(2).edge); // 画在 s2 的底色之上
  expect(ez('k1->s2')).toBeGreaterThan(z('s1'));
  expect(ez('k1->s2')).toBeLessThan(z('k1'));
});

test('推理链上的边画在同层的变暗边之上，仍在同层节点和更深一层的边之下', () => {
  const { z, ez } = zOf(['a1', 'a2']);
  expect(ez('k1->s2', true)).toBe(layer(1).chain);
  expect(ez('k1->s2', true)).toBeGreaterThan(ez('k1->s2'));
  expect(ez('k1->s2', true)).toBeLessThan(z('k1'));
  expect(ez('p1->s1', true)).toBeGreaterThan(ez('p1->s1'));
  expect(ez('p1->s1', true)).toBeLessThan(z('s1'));
  expect(ez('p1->s1', true)).toBeLessThan(ez('k1->s2'));
});

test('端点不在视图里时按第 0 层计', () => {
  const { view } = zOf(['a1']);
  expect(edgeZ(view, groupDepths(view), { from: 'nope', to: 'k1' })).toBe(layer(1).edge);
  expect(edgeZ(view, groupDepths(view), { from: 'nope', to: 'gone' })).toBe(layer(0).edge);
});
