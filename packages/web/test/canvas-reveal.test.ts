import { expect, test } from 'vitest';
import type { Graph, GraphNode } from '@agent-canvas/shared';
import { revealPlan } from '../src/canvas/reveal';
import { mkNode } from './helpers';

function graphOf(nodes: GraphNode[]): Graph {
  return { nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), edges: {} };
}
const at = (s: number) => `2026-01-01T00:00:${String(s).padStart(2, '0')}Z`;

test('主线程的一步：它的轮次，没有子代理', () => {
  const g = graphOf([
    { ...mkNode('p1', at(1)), kind: 'prompt', turnId: 't1' },
    { ...mkNode('x', at(2)), kind: 'tool', turnId: 't1' },
    { ...mkNode('p2', at(3)), kind: 'prompt', turnId: 't2' },
  ]);
  expect(revealPlan(g, 'x')).toEqual({ turnKey: 't1', agents: [], dispatchId: null });
});

test('子代理里嵌套子代理的一步：从外到内的代理、最外层派发所在的轮次、最内层的派发节点', () => {
  const g = graphOf([
    { ...mkNode('p1', at(1)), kind: 'prompt', turnId: 't1' },
    { ...mkNode('d1', at(2)), kind: 'subagent', turnId: 't1', childAgentId: 'A' },
    { ...mkNode('d2', at(3)), kind: 'subagent', agentId: 'A', childAgentId: 'B' },
    { ...mkNode('x', at(4)), kind: 'tool', agentId: 'B' },
  ]);
  expect(revealPlan(g, 'x')).toEqual({ turnKey: 't1', agents: ['A', 'B'], dispatchId: 'd2' });
});

test('找不到派发节点的代理、未知节点、循环', () => {
  const g = graphOf([{ ...mkNode('x', at(4)), kind: 'tool', agentId: 'Z' }]);
  expect(revealPlan(g, 'x')).toEqual({ turnKey: null, agents: ['Z'], dispatchId: null });
  expect(revealPlan(g, 'nope')).toBeNull();
  const loop = graphOf([
    { ...mkNode('d1', at(1)), kind: 'subagent', agentId: 'B', childAgentId: 'A' },
    { ...mkNode('d2', at(2)), kind: 'subagent', agentId: 'A', childAgentId: 'B' },
    { ...mkNode('x', at(3)), kind: 'tool', agentId: 'A' },
  ]);
  expect(revealPlan(loop, 'x')).toEqual({ turnKey: null, agents: ['B', 'A'], dispatchId: 'd1' });
});
