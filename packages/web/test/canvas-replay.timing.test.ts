import { expect, test } from 'vitest';
import type { Graph, GraphEdge, GraphNode } from '@claude-canvas/shared';
import { graphAt } from '../src/canvas/replay';

// Wall-clock bounds: runs in the serial `timing` project with retries (see vitest.config.ts).

const EPOCH = Date.parse('2026-01-01T00:00:00Z');
const iso = (tMs: number) => new Date(EPOCH + tMs).toISOString();

function bigGraph(): Graph {
  const nodes: GraphNode[] = [];
  for (let i = 0; i < 8000; i++) {
    nodes.push({
      id: `n${i}`, sessionId: 's1', turnId: 't1', agentId: null, childAgentId: null, parentId: null, kind: 'tool',
      status: 'succeeded', timestamp: iso(i * 10), confirmed: true, title: 'tool', summary: '', toolName: null,
      toolUseId: null, messageId: null, durationMs: 5, endedAt: iso(i * 10 + 5), usage: null, systemSubtype: null,
    });
  }
  const edges: GraphEdge[] = nodes.slice(1).map((n, i) => ({ id: `n${i}->${n.id}`, sessionId: 's1', from: `n${i}`, to: n.id, kind: 'sequence' }));
  return { nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), edges: Object.fromEntries(edges.map((x) => [x.id, x])) };
}

test('8000 个节点的图上 graphAt 在 200 毫秒内完成', () => {
  const g = bigGraph();
  graphAt(g, EPOCH + 40000);
  const t0 = performance.now();
  graphAt(g, EPOCH + 40000);
  expect(performance.now() - t0).toBeLessThan(200);
});

test('8000 个节点的图上 graphAt(g, MAX_SAFE_INTEGER) 返回 g 本身，且在 200 毫秒内完成', () => {
  const g = bigGraph();
  graphAt(g, Number.MAX_SAFE_INTEGER);
  const t0 = performance.now();
  const at = graphAt(g, Number.MAX_SAFE_INTEGER);
  expect(performance.now() - t0).toBeLessThan(200);
  expect(at).toBe(g);
});
