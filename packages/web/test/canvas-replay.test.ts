import { expect, test } from 'vitest';
import type { Graph, GraphEdge, GraphNode, NodeKind, Usage } from '@claude-canvas/shared';
import { formatTokens, graphAt, replayRange, turnMarks, usageTotal } from '../src/canvas/replay';

const EPOCH = Date.parse('2026-01-01T00:00:00Z');
const iso = (tMs: number) => new Date(EPOCH + tMs).toISOString();

function node(id: string, kind: NodeKind, tMs: number, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id, sessionId: 's1', turnId: 't1', agentId: null, childAgentId: null, parentId: null, kind, status: null,
    timestamp: iso(tMs), confirmed: true, title: kind, summary: '', toolName: null,
    toolUseId: null, messageId: null, durationMs: null, endedAt: null, usage: null, systemSubtype: null, ...extra,
  };
}
const e = (from: string, to: string): GraphEdge => ({ id: `${from}->${to}`, sessionId: 's1', from, to, kind: 'sequence' });
function graph(nodes: GraphNode[], edges: GraphEdge[] = []): Graph {
  return { nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), edges: Object.fromEntries(edges.map((x) => [x.id, x])) };
}

function sample(): Graph {
  return graph(
    [
      node('p1', 'prompt', 0),
      node('a', 'tool', 1000, { status: 'succeeded', durationMs: 4000, endedAt: iso(5000) }),
      node('b', 'text', 6000),
    ],
    [e('p1', 'a'), e('a', 'b')],
  );
}

test('t 之前开始的节点保留，之后的节点和连到它们的边消失', () => {
  const g = sample();
  const at = graphAt(g, EPOCH + 3000);
  expect(Object.keys(at.nodes).sort()).toEqual(['a', 'p1']);
  expect(Object.keys(at.edges)).toEqual(['p1->a']);
  expect(at.edges['p1->a']).toBe(g.edges['p1->a']);
});

test('执行中途：工具显示为 running，耗时和 endedAt 为空；到结束时间后恢复终态', () => {
  const g = sample();
  expect(graphAt(g, EPOCH + 3000).nodes.a).toMatchObject({ status: 'running', durationMs: null, endedAt: null });
  expect(graphAt(g, EPOCH + 5000).nodes.a).toBe(g.nodes.a);
  expect(g.nodes.a.status).toBe('succeeded');
});

test('没有 endedAt 的节点保持当前状态（awaiting_permission 不被改成 running）', () => {
  const g = graph([node('a', 'tool', 1000, { status: 'awaiting_permission' })]);
  const at = graphAt(g, EPOCH + 2000);
  expect(at.nodes.a.status).toBe('awaiting_permission');
  expect(at).toBe(g);
});

test('endedAt 早于开始时间：从开始时间起就是终态', () => {
  const g = graph([node('a', 'tool', 5000, { status: 'failed', durationMs: 10, endedAt: iso(2000) })]);
  expect(graphAt(g, EPOCH + 5000).nodes.a).toBe(g.nodes.a);
  expect(graphAt(g, EPOCH + 4999).nodes.a).toBeUndefined();
});

test('开始时间无法解析的节点始终保留', () => {
  const g = graph([node('x', 'text', 0, { timestamp: 'garbage' }), node('y', 'text', 9000)], [e('x', 'y')]);
  const at = graphAt(g, EPOCH + 100);
  expect(at.nodes.x).toBe(g.nodes.x);
  expect(at.nodes.y).toBeUndefined();
  expect(Object.keys(at.edges)).toEqual([]);
});

test('t 不小于范围末尾时返回传入的图本身；未变化的节点保持引用相等', () => {
  const g = sample();
  expect(graphAt(g, Number.MAX_SAFE_INTEGER)).toBe(g);
  const at = graphAt(g, EPOCH + 3000);
  expect(at.nodes.p1).toBe(g.nodes.p1);
  expect(at).not.toBe(g);
});

test('只有节点状态变化时边对象复用', () => {
  const g = graph([node('a', 'tool', 0, { status: 'succeeded', endedAt: iso(5000) })]);
  const at = graphAt(g, EPOCH + 100);
  expect(at.nodes.a.status).toBe('running');
  expect(at.edges).toBe(g.edges);
});

test('replayRange 取最早开始到最晚结束；空图为 null', () => {
  expect(replayRange({ nodes: {}, edges: {} })).toBeNull();
  expect(replayRange(sample())).toEqual({ startMs: EPOCH, endMs: EPOCH + 6000 });
  const g = graph([node('p', 'prompt', 100), node('a', 'tool', 200, { endedAt: iso(9000) }), node('z', 'text', 0, { timestamp: 'bad' })]);
  expect(replayRange(g)).toEqual({ startMs: EPOCH + 100, endMs: EPOCH + 9000 });
  expect(replayRange(graph([node('z', 'text', 0, { timestamp: 'bad' })]))).toBeNull();
});

test('turnMarks 只取主线 prompt，按时间升序', () => {
  const g = graph([
    node('p2', 'prompt', 500, { turnId: 't2' }),
    node('p1', 'prompt', 100, { turnId: 't1' }),
    node('ip', 'prompt', 50, { turnId: 't9', agentId: 'a1' }),
    node('tx', 'text', 10),
  ]);
  expect(turnMarks(g)).toEqual([{ turnId: 't1', ms: EPOCH + 100 }, { turnId: 't2', ms: EPOCH + 500 }]);
});

function fiveNodesOneMessage(usage: Usage): GraphNode[] {
  return [1, 2, 3, 4, 5].map((i) => node(`n${i}`, 'text', i, { messageId: 'm1', usage }));
}
test('usageTotal 按 messageId 去重：五个节点共用一条消息只算一次', () => {
  expect(usageTotal(fiveNodesOneMessage({ inputTokens: 1200, outputTokens: 340 }))).toEqual({ inputTokens: 1200, outputTokens: 340 });
});

test('usageTotal：无 messageId 各算一次，usage 为空跳过', () => {
  const u = { inputTokens: 10, outputTokens: 1 };
  const nodes = [
    node('a', 'text', 0, { usage: u }), node('b', 'text', 0, { usage: u }),
    node('c', 'text', 0, { messageId: 'm', usage: u }), node('d', 'text', 0, { messageId: 'm', usage: u }),
    node('e', 'text', 0),
  ];
  expect(usageTotal(nodes)).toEqual({ inputTokens: 30, outputTokens: 3 });
  expect(usageTotal([])).toEqual({ inputTokens: 0, outputTokens: 0 });
});

test.each([[999, '999'], [1200, '1.2k'], [15000, '15k'], [1250000, '1.3M'], [-5, '0'], [Number.NaN, '0'], [Infinity, '0']])('formatTokens(%s)', (n, s) => {
  expect(formatTokens(n)).toBe(s);
});

test('8000 个节点的图上 graphAt 在 50 毫秒内完成', () => {
  const nodes: GraphNode[] = [];
  for (let i = 0; i < 8000; i++) nodes.push(node(`n${i}`, 'tool', i * 10, { status: 'succeeded', endedAt: iso(i * 10 + 5) }));
  const edges = nodes.slice(1).map((n, i) => e(`n${i}`, n.id));
  const g = graph(nodes, edges);
  graphAt(g, EPOCH + 40000);
  const t0 = performance.now();
  graphAt(g, EPOCH + 40000);
  expect(performance.now() - t0).toBeLessThan(50);
});
