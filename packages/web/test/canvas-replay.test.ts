import { expect, test } from 'vitest';
import type { Graph, GraphEdge, GraphNode, NodeKind, Usage } from '@claude-canvas/shared';
import { advance, formatTokens, graphAt, replayOverlay, replayRange, turnIndexAt, turnMarks, usageTotal } from '../src/canvas/replay';

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

test.each([[999, '999'], [1000, '1k'], [999_949, '999.9k'], [999_950, '1M'], [1200, '1.2k'], [15000, '15k'], [1250000, '1.3M'], [-5, '0'], [Number.NaN, '0'], [Infinity, '0']])('formatTokens(%s)', (n, s) => {
  expect(formatTokens(n)).toBe(s);
});

test('endedAt 无法解析的节点原样返回', () => {
  const g = graph([node('a', 'tool', 1000, { status: 'succeeded', endedAt: 'garbage' })]);
  const at = graphAt(g, EPOCH + 1500);
  expect(at.nodes.a).toBe(g.nodes.a);
  expect(at).toBe(g);
});

const RANGE = { startMs: 1000, endMs: 5000 };
test('advance：按倍速推进，到末尾夹住并报告结束', () => {
  expect(advance(1000, 100, 10, RANGE)).toEqual({ timeMs: 2000, done: false });
  expect(advance(1000, 100, 1, RANGE)).toEqual({ timeMs: 1100, done: false });
  expect(advance(4500, 100, 60, RANGE)).toEqual({ timeMs: 5000, done: true });
  expect(advance(5000, 100, 10, RANGE)).toEqual({ timeMs: 5000, done: true });
});
test('advance：负数或 NaN 的经过时间被忽略；时刻先夹到范围内', () => {
  expect(advance(2000, -50, 10, RANGE)).toEqual({ timeMs: 2000, done: false });
  expect(advance(2000, Number.NaN, 10, RANGE)).toEqual({ timeMs: 2000, done: false });
  expect(advance(2000, 100, Number.NaN, RANGE)).toEqual({ timeMs: 2000, done: false });
  expect(advance(0, 0, 10, RANGE)).toEqual({ timeMs: 1000, done: false });
  expect(advance(9000, Number.NaN, 10, RANGE)).toEqual({ timeMs: 5000, done: true });
  expect(advance(3000, 100, 10, null)).toEqual({ timeMs: 3000, done: true });
});

test('turnIndexAt：时刻之前（含）的轮次数，第一轮之前为 0', () => {
  const marks = [{ turnId: 't1', ms: 100 }, { turnId: 't2', ms: 500 }, { turnId: 't3', ms: 900 }];
  expect(turnIndexAt(marks, 99)).toBe(0);
  expect(turnIndexAt(marks, 100)).toBe(1);
  expect(turnIndexAt(marks, 899)).toBe(2);
  expect(turnIndexAt(marks, 10_000)).toBe(3);
  expect(turnIndexAt([], 10_000)).toBe(0);
});

test('replayOverlay：工具 / 子代理显示耗时与 token，缺的省略，全缺为 —', () => {
  const usage = { inputTokens: 1200, outputTokens: 340 };
  expect(replayOverlay(node('a', 'tool', 0, { durationMs: 3400, usage }))).toBe('耗时 3.4s · 输入 1.2k · 输出 340');
  expect(replayOverlay(node('a', 'subagent', 0, { durationMs: 3400 }))).toBe('耗时 3.4s');
  expect(replayOverlay(node('a', 'tool', 0, { usage }))).toBe('输入 1.2k · 输出 340');
  expect(replayOverlay(node('a', 'tool', 0))).toBe('—');
  expect(replayOverlay(node('a', 'tool', 0, { durationMs: -1 }))).toBe('—');
});
test('replayOverlay：回复只显示 token 两项；其他类型没有叠加行', () => {
  const usage = { inputTokens: 15000, outputTokens: 999 };
  expect(replayOverlay(node('a', 'text', 0, { usage, durationMs: 100 }))).toBe('输入 15k · 输出 999');
  expect(replayOverlay(node('a', 'text', 0))).toBe('—');
  for (const k of ['prompt', 'thinking', 'system', 'unknown'] as const) expect(replayOverlay(node('a', k, 0, { usage }))).toBeNull();
});
