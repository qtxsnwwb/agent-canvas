import { expect, test } from 'vitest';
import { applyChange, emptyGraph, type GraphNode } from '../src/index.js';

const node = (over: Partial<GraphNode> = {}): GraphNode => ({
  id: 'n1', sessionId: 's1', turnId: null, agentId: null, parentId: null, kind: 'tool',
  status: 'running', timestamp: '2026-01-01T00:00:00.000Z', confirmed: false, title: 'Bash',
  summary: '', toolName: 'Bash', toolUseId: 'tu1', messageId: null, durationMs: null,
  usage: null, systemSubtype: null, ...over,
});

test('node_added 加入节点', () => {
  const g = applyChange(emptyGraph(), { type: 'node_added', node: node(), detail: {} });
  expect(g.nodes.n1.title).toBe('Bash');
});
test('node_updated 合并 patch 且不改动原图', () => {
  const g1 = applyChange(emptyGraph(), { type: 'node_added', node: node(), detail: {} });
  const g2 = applyChange(g1, { type: 'node_updated', sessionId: 's1', id: 'n1', patch: { status: 'succeeded', confirmed: true } });
  expect(g2.nodes.n1.status).toBe('succeeded');
  expect(g2.nodes.n1.title).toBe('Bash');
  expect(g1.nodes.n1.status).toBe('running');
});
test('node_updated 指向不存在的节点时忽略', () => {
  const g = applyChange(emptyGraph(), { type: 'node_updated', sessionId: 's1', id: 'nope', patch: { status: 'failed' } });
  expect(g.nodes).toEqual({});
});
test('edge_added 加入边', () => {
  const g = applyChange(emptyGraph(), { type: 'edge_added', edge: { id: 'e1', sessionId: 's1', from: 'a', to: 'b', kind: 'sequence' } });
  expect(g.edges.e1.kind).toBe('sequence');
});
