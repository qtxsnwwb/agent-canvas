import { expect, test } from 'vitest';
import { applyChange, applyChanges, emptyGraph, type Change, type Graph, type GraphNode } from '../src/index.js';

const node = (id: string): GraphNode => ({
  id, sessionId: 's1', turnId: null, agentId: null, parentId: null, kind: 'text',
  status: null, timestamp: '2026-01-01T00:00:00.000Z', confirmed: true, title: 'Text',
  summary: '', toolName: null, toolUseId: null, messageId: null, durationMs: null,
  usage: null, systemSubtype: null, childAgentId: null, endedAt: null,
});

const build: Change[] = [
  { type: 'node_added', node: node('a'), detail: {} },
  { type: 'node_added', node: node('b'), detail: {} },
  { type: 'node_added', node: node('c'), detail: {} },
  { type: 'edge_added', edge: { id: 'a->b', sessionId: 's1', from: 'a', to: 'b', kind: 'sequence' } },
  { type: 'edge_added', edge: { id: 'b->c', sessionId: 's1', from: 'b', to: 'c', kind: 'sequence' } },
  { type: 'edge_added', edge: { id: 'a->c:fork', sessionId: 's1', from: 'a', to: 'c', kind: 'fork' } },
];

const graphOf = (changes: Change[]): Graph => changes.reduce(applyChange, emptyGraph());

test('node_removed 移除节点和所有以它为起点或终点的边', () => {
  const g = applyChange(graphOf(build), { type: 'node_removed', sessionId: 's1', id: 'b' });
  expect(Object.keys(g.nodes).sort()).toEqual(['a', 'c']);
  expect(Object.keys(g.edges)).toEqual(['a->c:fork']);
});

test('node_removed 指向不存在的节点时原样返回', () => {
  const g = graphOf(build);
  expect(applyChange(g, { type: 'node_removed', sessionId: 's1', id: 'nope' })).toBe(g);
  expect(applyChanges(g, [{ type: 'node_removed', sessionId: 's1', id: 'nope' }])).toBe(g);
});

test('applyChanges 与逐条 applyChange 结果一致（含 node_removed，及移除后再加回）', () => {
  const changes: Change[] = [
    ...build,
    { type: 'node_removed', sessionId: 's1', id: 'b' },
    { type: 'node_added', node: node('b'), detail: {} },
    { type: 'edge_added', edge: { id: 'a->b', sessionId: 's1', from: 'a', to: 'b', kind: 'sequence' } },
    { type: 'node_removed', sessionId: 's1', id: 'c' },
  ];
  const one = graphOf(changes);
  expect(applyChanges(emptyGraph(), changes)).toEqual(one);
  expect(Object.keys(one.nodes).sort()).toEqual(['a', 'b']);
  expect(Object.keys(one.edges)).toEqual(['a->b']);
  const base = graphOf(build);
  const before = structuredClone(base);
  applyChanges(base, [{ type: 'node_removed', sessionId: 's1', id: 'a' }]);
  expect(base).toEqual(before); // immutable
});
