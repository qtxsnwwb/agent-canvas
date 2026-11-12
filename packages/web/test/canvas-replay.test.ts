import { expect, test } from 'vitest';
import type { Graph, GraphEdge, GraphNode, NodeKind, Usage } from '@agent-canvas/shared';
import { adjacentMark, advance, formatClock, formatTokens, graphAt, replayOverlay, replayOverlayTitle, replayRange, turnIndexAt, turnMarks, usageLabel, usageTotal } from '../src/canvas/replay';

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
  expect(usageTotal(fiveNodesOneMessage({ inputTokens: 1200, cachedInputTokens: 9000, outputTokens: 340 })))
    .toEqual({ inputTokens: 1200, cachedInputTokens: 9000, outputTokens: 340 });
});

test('usageTotal：无 messageId 各算一次，usage 为空跳过', () => {
  const u = { inputTokens: 10, outputTokens: 1 };
  const nodes = [
    node('a', 'text', 0, { usage: u }), node('b', 'text', 0, { usage: u }),
    node('c', 'text', 0, { messageId: 'm', usage: u }), node('d', 'text', 0, { messageId: 'm', usage: u }),
    node('e', 'text', 0),
  ];
  expect(usageTotal(nodes)).toEqual({ inputTokens: 30, cachedInputTokens: 0, outputTokens: 3 });
  expect(usageTotal([])).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
});

test('usageTotal：缓存读取单独求和；旧节点没有 cachedInputTokens 按 0 算', () => {
  const nodes = [
    node('a', 'text', 0, { usage: { inputTokens: 5, cachedInputTokens: 700, outputTokens: 2 } }),
    node('b', 'text', 0, { usage: { inputTokens: 3, outputTokens: 1 } }),
  ];
  expect(usageTotal(nodes)).toEqual({ inputTokens: 8, cachedInputTokens: 700, outputTokens: 3 });
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

test('replayOverlay：工具 / 子代理显示耗时与 token（新输入、输出；缓存读取在提示里），缺的省略，全缺为 —', () => {
  const usage = { inputTokens: 1200, cachedInputTokens: 45_000, outputTokens: 340 };
  expect(replayOverlay(node('a', 'tool', 0, { durationMs: 3400, usage }))).toBe('耗时 3.4s · 新输入 1.2k · 输出 340');
  expect(replayOverlay(node('a', 'subagent', 0, { durationMs: 3400 }))).toBe('耗时 3.4s');
  expect(replayOverlay(node('a', 'tool', 0, { usage }))).toBe('新输入 1.2k · 输出 340');
  expect(replayOverlay(node('a', 'tool', 0))).toBe('—');
  expect(replayOverlay(node('a', 'tool', 0, { durationMs: -1 }))).toBe('—');
});
test('replayOverlay：回复只显示 token 两项；其他类型没有叠加行', () => {
  const usage = { inputTokens: 15000, outputTokens: 999 };
  expect(replayOverlay(node('a', 'text', 0, { usage, durationMs: 100 }))).toBe('新输入 15k · 输出 999');
  expect(replayOverlay(node('a', 'text', 0))).toBe('—');
  for (const k of ['prompt', 'thinking', 'system', 'unknown'] as const) expect(replayOverlay(node('a', k, 0, { usage }))).toBeNull();
});

test('usageLabel：三项都写全；旧节点缺缓存读取按 0；replayOverlayTitle 只在有 token 时给出', () => {
  expect(usageLabel({ inputTokens: 1200, cachedInputTokens: 45_000, outputTokens: 340 })).toBe('新输入 1.2k · 缓存读取 45k · 输出 340');
  expect(usageLabel({ inputTokens: 3, outputTokens: 1 })).toBe('新输入 3 · 缓存读取 0 · 输出 1');
  expect(replayOverlayTitle(node('a', 'tool', 0, { usage: { inputTokens: 1, cachedInputTokens: 2, outputTokens: 3 } }))).toBe('新输入 1 · 缓存读取 2 · 输出 3');
  expect(replayOverlayTitle(node('a', 'tool', 0, { durationMs: 5 }))).toBeUndefined();
});

test('adjacentMark：PageUp 跳到上一个轮次标记、PageDown 跳到下一个；正好在标记上时跳到相邻的那个；没有则 null', () => {
  const marks = [{ turnId: 't1', ms: 100 }, { turnId: 't2', ms: 500 }, { turnId: 't3', ms: 900 }];
  expect(adjacentMark(marks, 600, -1)).toBe(500);
  expect(adjacentMark(marks, 600, 1)).toBe(900);
  expect(adjacentMark(marks, 500, -1)).toBe(100);
  expect(adjacentMark(marks, 500, 1)).toBe(900);
  expect(adjacentMark(marks, 100, -1)).toBeNull();
  expect(adjacentMark(marks, 50, -1)).toBeNull();
  expect(adjacentMark(marks, 50, 1)).toBe(100);
  expect(adjacentMark(marks, 900, 1)).toBeNull();
  expect(adjacentMark([], 0, 1)).toBeNull();
  // Order of the marks does not matter.
  expect(adjacentMark([...marks].reverse(), 600, -1)).toBe(500);
  expect(adjacentMark([...marks].reverse(), 600, 1)).toBe(900);
});

test('formatClock：回放范围起止在同一本地日期时只显示时刻，跨日时显示 MM-DD HH:mm:ss', () => {
  const at = (d: number, h: number, m: number, s: number) => new Date(2026, 10, d, h, m, s).getTime();
  const sameDay = { startMs: at(10, 0, 0, 1), endMs: at(10, 23, 59, 59) };
  expect(formatClock(at(10, 9, 5, 7), sameDay)).toBe(new Date(at(10, 9, 5, 7)).toLocaleTimeString());
  const twoDays = { startMs: at(10, 23, 0, 0), endMs: at(11, 1, 0, 0) };
  expect(formatClock(at(10, 23, 30, 5), twoDays)).toBe('11-10 23:30:05');
  expect(formatClock(at(11, 0, 4, 9), twoDays)).toBe('11-11 00:04:09');
  expect(formatClock(at(10, 9, 5, 7), null)).toBe(new Date(at(10, 9, 5, 7)).toLocaleTimeString());
  expect(formatClock(Number.NaN, twoDays)).toBe('');
});
