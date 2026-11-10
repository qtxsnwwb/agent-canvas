import { expect, test } from 'vitest';
import { emptyGraph, type Graph, type GraphNode, type NodeKind } from '@claude-canvas/shared';
import { buildView } from '../src/canvas/view';
import { followTarget, resumeZoom, viewportMoved } from '../src/canvas/follow';

const EPOCH = Date.parse('2026-01-01T00:00:00Z');
function node(id: string, kind: NodeKind, turnId: string, tMs: number): GraphNode {
  return {
    id, sessionId: 's1', turnId, agentId: null, childAgentId: null, endedAt: null, parentId: null, kind, status: null,
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

test('因果视角下按 280×56 取思考节点的中心，其他视角按 160×28', () => {
  const g = graph([node('p1', 'prompt', 't1', 0), node('th1', 'thinking', 't1', 1)]);
  const positions = { th1: { x: 100, y: 400 } };
  const causal = buildView(g, new Map(), undefined, { mode: 'causal' });
  expect(causal.latestNodeId).toBe('th1');
  expect(followTarget({ view: causal, positions })).toEqual({ x: 240, y: 428 });
  expect(followTarget({ view: buildView(g, new Map()), positions })).toEqual({ x: 180, y: 414 });
});

test('最新节点尚无位置或图为空时返回 null', () => {
  const view = buildView(fiveTurns(), new Map());
  expect(followTarget({ view, positions: {} })).toBeNull();
  expect(followTarget({ view: buildView(emptyGraph(), new Map()), positions: {} })).toBeNull();
});

test('viewportMoved：相同或亚阈值抖动不算移动，平移或缩放算', () => {
  const a = { x: 10, y: 20, zoom: 1 };
  expect(viewportMoved(a, { ...a })).toBe(false);
  expect(viewportMoved(a, { x: 10.3, y: 19.8, zoom: 1.0005 })).toBe(false);
  expect(viewportMoved(a, { x: 12, y: 20, zoom: 1 })).toBe(true);
  expect(viewportMoved(a, { x: 10, y: 20, zoom: 1.2 })).toBe(true);
});

test('resumeZoom：缩放低于 0.5 时回到 1，否则保持当前缩放', () => {
  expect(resumeZoom(0.2)).toBe(1);
  expect(resumeZoom(0.5)).toBe(0.5);
  expect(resumeZoom(1.4)).toBe(1.4);
});

test('位置还是按旧视角布局的（layoutMode）时，按 layoutMode 的尺寸取中心', () => {
  const g = graph([node('p1', 'prompt', 't1', 0), node('th1', 'thinking', 't1', 1)]);
  const positions = { th1: { x: 100, y: 400 } };
  const causal = buildView(g, new Map(), undefined, { mode: 'causal' });
  expect(followTarget({ view: causal, positions, layoutMode: 'live' })).toEqual({ x: 180, y: 414 });
  expect(followTarget({ view: causal, positions, layoutMode: 'causal' })).toEqual({ x: 240, y: 428 });
});
