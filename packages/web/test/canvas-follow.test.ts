import { expect, test } from 'vitest';
import { emptyGraph, type Graph, type GraphNode, type NodeKind } from '@claude-canvas/shared';
import { buildView } from '../src/canvas/view';
import { followTarget } from '../src/canvas/follow';

const EPOCH = Date.parse('2026-01-01T00:00:00Z');
function node(id: string, kind: NodeKind, turnId: string, tMs: number): GraphNode {
  return {
    id, sessionId: 's1', turnId, agentId: null, childAgentId: null, parentId: null, kind, status: null,
    timestamp: new Date(EPOCH + tMs).toISOString(), confirmed: true, title: kind, summary: '', toolName: null,
    toolUseId: null, messageId: null, durationMs: null, usage: null, systemSubtype: null,
  };
}
function graph(nodes: GraphNode[]): Graph {
  return { nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), edges: {} };
}
// Five turns (prompt + tool each); the last node y5 is a tool.
function fiveTurns(): Graph {
  const ns: GraphNode[] = [];
  for (let i = 1; i <= 5; i++) ns.push(node(`p${i}`, 'prompt', `t${i}`, i * 100), node(i === 5 ? 'y5' : `y${i}`, 'tool', `t${i}`, i * 100 + 1));
  return graph(ns);
}

test('返回最新节点的中心', () => {
  const view = buildView(fiveTurns(), new Map());
  expect(view.latestNodeId).toBe('y5');
  expect(followTarget({ view, positions: { y5: { x: 100, y: 400 } } })).toEqual({ x: 220, y: 426 });
});

test('最新节点在折叠轮次里时取摘要节点的中心（340×60）', () => {
  const collapsedLast = buildView(fiveTurns(), new Map([['t5', false]]));
  expect(collapsedLast.latestNodeId).toBe('turn:t5');
  expect(followTarget({ view: collapsedLast, positions: { 'turn:t5': { x: 0, y: 0 } } })).toEqual({ x: 170, y: 30 });
});

test('最新节点尚无位置或图为空时返回 null', () => {
  const view = buildView(fiveTurns(), new Map());
  expect(followTarget({ view, positions: {} })).toBeNull();
  expect(followTarget({ view: buildView(emptyGraph(), new Map()), positions: {} })).toBeNull();
});
