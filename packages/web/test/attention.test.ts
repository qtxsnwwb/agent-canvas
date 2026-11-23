import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, test, vi } from 'vitest';
import type { AttentionHidden, AttentionItem, AttentionResponse, Session } from '@agent-canvas/shared';
import {
  ATTENTION_KIND_LABEL, attentionRetryDelay, attentionRows, emptyText, footerText, headerCount, hiddenRows, parseAutoHideInput,
  undeterminableRows,
} from '../src/attention';
import { createSessionsFeed, openLiveAttention, openLiveSessions, type AttentionLiveState } from '../src/client';
import { createPageMasker, IDENTITY_MASKER } from '../src/masking';
import { AttentionRow, AutoHideSetting, dismissClick } from '../src/pages/Attention';
import { baseSession, fakeSocket, type FakeSocket } from './helpers';

afterEach(() => { vi.useRealTimers(); });

const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const ago = (min: number): string => new Date(NOW - min * 60_000).toISOString();

const item = (over: Partial<AttentionItem> = {}): AttentionItem => {
  const base: AttentionItem = {
    key: '', sessionId: 's1', kind: 'finished', since: ago(5), title: '修登录', origin: 'claude', projectId: 'p1',
    cwd: 'D:/work/agent-canvas', explanation: '已经改好了', nodeId: 'n1', ...over,
  };
  return { ...base, key: `${base.sessionId}|${base.kind}|${base.since}` };
};

const response = (over: Partial<AttentionResponse> = {}): AttentionResponse => ({
  items: [], hidden: [], hiddenCount: 0, undeterminable: [], runningCount: 0, autoHideHours: 24, ...over,
});

// ---- labels, grouping, order ----

test('四种的名字：等你批准、出错中断、卡住了、跑完了', () => {
  expect(ATTENTION_KIND_LABEL).toEqual({ permission: '等你批准', error: '出错中断', stuck: '卡住了', finished: '跑完了' });
});

test('行：同类挨在一起，按 permission、error、stuck、finished；同类里新的在前', () => {
  const items = [
    item({ sessionId: 'f-old', kind: 'finished', since: ago(60) }),
    item({ sessionId: 'st', kind: 'stuck', since: ago(30) }),
    item({ sessionId: 'f-new', kind: 'finished', since: ago(2) }),
    item({ sessionId: 'p', kind: 'permission', since: ago(90) }),
    item({ sessionId: 'e', kind: 'error', since: ago(10) }),
  ];
  const rows = attentionRows(items, IDENTITY_MASKER, NOW);
  expect(rows.map((r) => r.sessionId)).toEqual(['p', 'e', 'st', 'f-new', 'f-old']);
  expect(rows.map((r) => r.kindLabel)).toEqual(['等你批准', '出错中断', '卡住了', '跑完了', '跑完了']);
  expect(rows.map((r) => r.statusClass)).toEqual(['awaiting_permission', 'failed', 'stale', 'idle', 'idle']);
});

test('行：说明加前缀，项目取目录名，时间是相对时间，链接定位到节点（没有节点只开会话）', () => {
  const [p, e, s, f, bare] = attentionRows([
    item({ sessionId: 'p', kind: 'permission', explanation: 'Bash npm publish ./release', nodeId: 'n/1' }),
    item({ sessionId: 'e', kind: 'error', explanation: '请求超时' }),
    item({ sessionId: 's', kind: 'stuck', explanation: '读取文件' }),
    item({ sessionId: 'f', kind: 'finished', since: ago(65), explanation: '已经改好，测试全部通过' }),
    item({ sessionId: 'x y', kind: 'finished', since: ago(70), explanation: null, nodeId: null, title: null, cwd: null, projectId: 'cursor-abc' }),
  ], IDENTITY_MASKER, NOW);
  expect(p!.explanation).toBe('要执行：Bash npm publish ./release');
  expect(e!.explanation).toBe('这一轮没有正常结束：请求超时');
  expect(s!.explanation).toBe('最后一步：读取文件');
  expect(f!.explanation).toBe('最后的回复：已经改好，测试全部通过');
  expect(bare!.explanation).toBeNull();
  expect(p!.project).toBe('agent-canvas');
  expect(p!.href).toBe('#/s/p/n/n%2F1');
  expect(bare!.href).toBe('#/s/x%20y');
  expect(bare!.title).toBe('x y');
  expect(bare!.project).toBe('Cursor（未知目录）');
  expect(f!.time).toBe('1 小时前');
  expect(p!.time).toBe('5 分钟前');
});

test('遮蔽开着：说明、会话标题、项目名都遮蔽；关着原样', () => {
  const KEY = 'sk-' + 'proj-' + 'FAKEFAKE0123456789abcdefTEST';
  const TERM = 'Falcon' + 'Project';
  const raw = item({ kind: 'permission', title: `部署 ${TERM}`, explanation: `Bash curl -H "Authorization: Bearer ${KEY}"`, cwd: `D:/work/${TERM}` });
  const on = createPageMasker({ customTerms: [TERM], numbered: false });
  const [row] = attentionRows([raw], on, NOW);
  expect(JSON.stringify(row)).not.toContain(KEY);
  expect(JSON.stringify(row)).not.toContain(TERM);
  expect(row!.explanation!.startsWith('要执行：')).toBe(true);
  const [plain] = attentionRows([raw], IDENTITY_MASKER, NOW);
  expect(plain!.explanation).toContain(KEY);
  expect(plain!.title).toContain(TERM);
});

// ---- header, footer, empty state ----

test('顶栏的数：主列表的条数，0 和还没加载时不显示', () => {
  expect(headerCount(null)).toBeNull();
  expect(headerCount(response())).toBeNull();
  expect(headerCount(response({ items: [item(), item({ sessionId: 's2' })], hiddenCount: 7 }))).toBe(2);
});

test('底部：运行中 N 个 · 无法判断状态的 M 个（来源名，各出现一次）', () => {
  expect(footerText(response({ runningCount: 4 }), true)).toBe('运行中 4 个');
  expect(footerText(response({ runningCount: 0 }), true)).toBe('运行中 0 个');
  const und = [
    { sessionId: 'a', title: null, origin: 'doubao' as const }, { sessionId: 'b', title: null, origin: 'grok' as const },
    { sessionId: 'c', title: null, origin: 'doubao' as const },
  ];
  expect(footerText(response({ runningCount: 4, undeterminable: und }), true)).toBe('运行中 4 个 · 无法判断状态的 3 个（豆包、Grok）');
  expect(footerText(response({ runningCount: 4, undeterminable: und }), false)).toBe('无法判断状态的 3 个（豆包、Grok）');
  expect(footerText(response({ runningCount: 4 }), false)).toBeNull();
});

test('无法判断的会话：只遮蔽它们的标题；没有标题用 id 开头；链接到会话', () => {
  const TERM = 'Falcon' + 'Project';
  const on = createPageMasker({ customTerms: [TERM], numbered: false });
  const list = [{ sessionId: 'u 1', title: `看 ${TERM}`, origin: 'doubao' as const }, { sessionId: 'abcdefghij', title: null, origin: 'grok' as const }];
  const rows = undeterminableRows(list, on);
  expect(JSON.stringify(rows)).not.toContain(TERM);
  expect(rows[1]).toEqual({ sessionId: 'abcdefghij', origin: 'grok', title: 'abcdefgh', href: '#/s/abcdefghij' });
  expect(rows[0]!.href).toBe('#/s/u%201');
  expect(undeterminableRows(list, IDENTITY_MASKER)[0]!.title).toBe(`看 ${TERM}`);
});

test('空列表：一句话加运行中的数量', () => {
  expect(emptyText(response({ runningCount: 3 }))).toEqual({ title: '此刻没有需要你处理的会话', sub: '运行中 3 个' });
  expect(emptyText(response({ runningCount: 0 })).sub).toBe('也没有正在运行的会话');
});

// ---- hidden list ----

test('已移出的：注明原因，只有“知道了”的能撤销', () => {
  const hidden: AttentionHidden[] = [
    { item: item({ sessionId: 'd', since: ago(10) }), reason: 'dismissed' },
    { item: item({ sessionId: 'x', since: ago(60 * 30) }), reason: 'expired' },
  ];
  const rows = hiddenRows(hidden, 24, IDENTITY_MASKER, NOW);
  expect(rows.map((r) => r.sessionId)).toEqual(['d', 'x']);
  expect(rows.map((r) => r.reasonText)).toEqual(['你点了知道了', '超过 24 小时没处理']);
  expect(rows.map((r) => r.canRestore)).toEqual([true, false]);
  expect(rows[0]!.key).toBe(hidden[0]!.item.key);
});

// ---- the auto-hide limit ----

test('自动移出时限：1 到 720 的整数', () => {
  expect(parseAutoHideInput(' 48 ')).toEqual({ ok: true, value: 48 });
  expect(parseAutoHideInput('1')).toEqual({ ok: true, value: 1 });
  expect(parseAutoHideInput('720')).toEqual({ ok: true, value: 720 });
  for (const bad of ['0', '721', '1.5', '', 'abc', '1e2', '-3']) expect(parseAutoHideInput(bad).ok).toBe(false);
});

// ---- the row component ----

test('“知道了”在链接外面：点它不会跳转，也不往外冒泡', () => {
  const [row] = attentionRows([item({ sessionId: 'a', nodeId: 'n9' })], IDENTITY_MASKER, NOW);
  const html = renderToStaticMarkup(createElement(AttentionRow, { row: row!, onDismiss: () => {}, busy: false }));
  const linkEnd = html.indexOf('</a>');
  const button = html.indexOf('<button');
  expect(html).toContain('href="#/s/a/n/n9"');
  expect(html).toContain('知道了');
  expect(linkEnd).toBeGreaterThan(0);
  expect(button).toBeGreaterThan(linkEnd);
  // The row's own text names the link: no identical tooltip on every row.
  expect(html).not.toContain('title="打开这个会话');
  const onDismiss = vi.fn();
  const ev = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
  dismissClick(onDismiss)(ev);
  expect(ev.preventDefault).toHaveBeenCalled();
  expect(ev.stopPropagation).toHaveBeenCalled();
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test('时限表单：不用浏览器自带的校验（页面自己的“1 到 720 的整数”提示才显示得出来）', () => {
  const html = renderToStaticMarkup(createElement(AutoHideSetting, { hours: 24, save: async () => {} }));
  expect(html).toContain('<form');
  expect(html).toContain('novalidate=""');
  expect(html).toContain('value="24"');
});

// ---- live state ----

test('重试间隔：从 0.5 秒起翻倍，最多 5 秒', () => {
  expect([1, 2, 3, 4, 5, 9].map(attentionRetryDelay)).toEqual([500, 1000, 2000, 4000, 5000, 5000]);
});

type Fetch = () => Promise<AttentionResponse>;
const http = (status: number): Error => Object.assign(new Error(`HTTP ${status}`), { status });

test('订阅 sessions 之后才 GET；推送直接替换状态', async () => {
  vi.useFakeTimers();
  const sock = fakeSocket();
  const fetchAttention = vi.fn<Fetch>(async () => response({ runningCount: 1 }));
  const states: AttentionLiveState[] = [];
  const live = openLiveAttention((s) => states.push(s), { fetchAttention, createSocket: () => sock });
  expect(fetchAttention).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(0);
  expect(sock.sent[0]).toEqual({ type: 'subscribe', scope: 'sessions' });
  expect(fetchAttention).toHaveBeenCalledTimes(1);
  expect(states.at(-1)).toEqual({ response: response({ runningCount: 1 }), problem: null });
  const pushed = response({ items: [item()] });
  sock.receive({ type: 'attention', response: pushed });
  expect(states.at(-1)!.response).toEqual(pushed);
  live.close();
});

test('503：显示“正在准备”，退避后再 GET；成功后清掉', async () => {
  vi.useFakeTimers();
  const sock = fakeSocket();
  let calls = 0;
  const fetchAttention = vi.fn<Fetch>(async () => {
    calls += 1;
    if (calls <= 2) throw http(503);
    return response();
  });
  const states: AttentionLiveState[] = [];
  const live = openLiveAttention((s) => states.push(s), { fetchAttention, createSocket: () => sock });
  await vi.advanceTimersByTimeAsync(0);
  expect(states.at(-1)).toEqual({ response: null, problem: { kind: 'preparing', text: '待处理列表正在准备…' } });
  await vi.advanceTimersByTimeAsync(499);
  expect(calls).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(calls).toBe(2);
  await vi.advanceTimersByTimeAsync(1000);
  expect(calls).toBe(3);
  expect(states.at(-1)).toEqual({ response: response(), problem: null });
  live.close();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(calls).toBe(3);
});

test('连不上：保留上一次的列表，标出问题，并重试', async () => {
  vi.useFakeTimers();
  const sock = fakeSocket();
  let fail = false;
  const fetchAttention = vi.fn<Fetch>(async () => { if (fail) throw new TypeError('fetch failed'); return response({ runningCount: 2 }); });
  const states: AttentionLiveState[] = [];
  const live = openLiveAttention((s) => states.push(s), { fetchAttention, createSocket: () => sock });
  await vi.advanceTimersByTimeAsync(0);
  fail = true;
  sock.drop();
  await vi.advanceTimersByTimeAsync(1000); // reconnect, then GET again
  expect(fetchAttention).toHaveBeenCalledTimes(2);
  expect(states.at(-1)!.response).toEqual(response({ runningCount: 2 }));
  expect(states.at(-1)!.problem?.kind).toBe('failed');
  fail = false;
  await vi.advanceTimersByTimeAsync(500);
  expect(fetchAttention).toHaveBeenCalledTimes(3);
  expect(states.at(-1)!.problem).toBeNull();
  live.close();
});

test('推送到达时取消等待中的重试', async () => {
  vi.useFakeTimers();
  const sock = fakeSocket();
  const fetchAttention = vi.fn<Fetch>(async () => { throw http(503); });
  const states: AttentionLiveState[] = [];
  const live = openLiveAttention((s) => states.push(s), { fetchAttention, createSocket: () => sock });
  await vi.advanceTimersByTimeAsync(0);
  sock.receive({ type: 'attention', response: response({ runningCount: 5 }) });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetchAttention).toHaveBeenCalledTimes(1);
  expect(states.at(-1)).toEqual({ response: response({ runningCount: 5 }), problem: null });
  live.close();
});

/** A promise the test settles. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('write：没有推送插进来时，写接口的回答成为当前状态；失败照样抛给调用方', async () => {
  vi.useFakeTimers();
  const sock = fakeSocket();
  const states: AttentionLiveState[] = [];
  const live = openLiveAttention((s) => states.push(s), { fetchAttention: async () => response(), createSocket: () => sock });
  await vi.advanceTimersByTimeAsync(0);
  await live.write(async () => response({ autoHideHours: 48 }));
  expect(states.at(-1)).toEqual({ response: response({ autoHideHours: 48 }), problem: null });
  await expect(live.write(async () => { throw http(503); })).rejects.toMatchObject({ status: 503 });
  expect(states.at(-1)).toEqual({ response: response({ autoHideHours: 48 }), problem: null });
  live.close();
});

test('GET 发出后到了更新的推送：GET 的旧回答不覆盖它（审读复现：应为 9）', async () => {
  vi.useFakeTimers();
  const sock = fakeSocket();
  const get = deferred<AttentionResponse>();
  const states: AttentionLiveState[] = [];
  const live = openLiveAttention((s) => states.push(s), { fetchAttention: () => get.promise, createSocket: () => sock });
  await vi.advanceTimersByTimeAsync(0); // subscribed; the GET is in flight
  sock.receive({ type: 'attention', response: response({ runningCount: 9 }) });
  get.resolve(response({ runningCount: 1 }));
  await vi.advanceTimersByTimeAsync(0);
  expect(states.at(-1)).toEqual({ response: response({ runningCount: 9 }), problem: null });
  live.close();
});

test('GET 发出后到了推送，GET 又失败：不标问题，也不重试', async () => {
  vi.useFakeTimers();
  const sock = fakeSocket();
  const get = deferred<AttentionResponse>();
  const fetchAttention = vi.fn<Fetch>(() => get.promise);
  const states: AttentionLiveState[] = [];
  const live = openLiveAttention((s) => states.push(s), { fetchAttention, createSocket: () => sock });
  await vi.advanceTimersByTimeAsync(0);
  sock.receive({ type: 'attention', response: response({ runningCount: 9 }) });
  get.reject(new TypeError('fetch failed'));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetchAttention).toHaveBeenCalledTimes(1);
  expect(states.at(-1)).toEqual({ response: response({ runningCount: 9 }), problem: null });
  live.close();
});

test('GET 失败后到了推送，再一次 GET 成功：问题清掉（推送之前开始的回答不再覆盖）', async () => {
  vi.useFakeTimers();
  const sock = fakeSocket();
  let calls = 0;
  const second = deferred<AttentionResponse>();
  const fetchAttention = vi.fn<Fetch>(() => { calls += 1; return calls === 1 ? Promise.reject(http(500)) : second.promise; });
  const states: AttentionLiveState[] = [];
  const live = openLiveAttention((s) => states.push(s), { fetchAttention, createSocket: () => sock });
  await vi.advanceTimersByTimeAsync(0);
  expect(states.at(-1)!.problem?.kind).toBe('failed');
  await vi.advanceTimersByTimeAsync(500); // the retry is in flight
  sock.receive({ type: 'attention', response: response({ runningCount: 9 }) });
  second.resolve(response({ runningCount: 1 }));
  await vi.advanceTimersByTimeAsync(0);
  expect(states.at(-1)).toEqual({ response: response({ runningCount: 9 }), problem: null });
  live.close();
});

test('写接口的回答比它发出后到的推送旧：不覆盖推送', async () => {
  vi.useFakeTimers();
  const sock = fakeSocket();
  const states: AttentionLiveState[] = [];
  const live = openLiveAttention((s) => states.push(s), { fetchAttention: async () => response(), createSocket: () => sock });
  await vi.advanceTimersByTimeAsync(0);
  const answer = deferred<AttentionResponse>();
  const done = live.write(() => answer.promise);
  sock.receive({ type: 'attention', response: response({ runningCount: 9, hiddenCount: 1 }) });
  answer.resolve(response({ runningCount: 1, hiddenCount: 1 }));
  await done;
  expect(states.at(-1)).toEqual({ response: response({ runningCount: 9, hiddenCount: 1 }), problem: null });
  live.close();
});

test('已移出的列表：发出后到了推送，旧回答作废（null）；否则给出列表', async () => {
  vi.useFakeTimers();
  const sock = fakeSocket();
  const hiddenItem: AttentionHidden = { item: item(), reason: 'dismissed' };
  const pending = deferred<AttentionResponse>();
  const fetchHidden = vi.fn(() => pending.promise);
  const live = openLiveAttention(() => {}, { fetchAttention: async () => response(), fetchHidden, createSocket: () => sock });
  await vi.advanceTimersByTimeAsync(0);
  const stale = live.hidden();
  sock.receive({ type: 'attention', response: response({ hiddenCount: 2 }) });
  pending.resolve(response({ hidden: [hiddenItem], hiddenCount: 1 }));
  expect(await stale).toBeNull();
  fetchHidden.mockImplementation(async () => response({ hidden: [hiddenItem], hiddenCount: 1 }));
  expect(await live.hidden()).toEqual([hiddenItem]);
  live.close();
});

test('一条 sessions 连接：首页的会话流和待处理共用；后加入的立刻 GET；最后一个关掉才断开', async () => {
  vi.useFakeTimers();
  const socks: FakeSocket[] = [];
  const feed = createSessionsFeed(() => { const s = fakeSocket(); socks.push(s); return s; });
  const fetchAttention = vi.fn<Fetch>(async () => response());
  const attention = openLiveAttention(() => {}, { fetchAttention, feed });
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchAttention).toHaveBeenCalledTimes(1);
  const onSession = vi.fn();
  const onReconnect = vi.fn();
  const sessions = openLiveSessions(onSession, { feed, onReconnect });
  expect(socks).toHaveLength(1);
  const upserted: Session = { ...baseSession, status: 'idle' };
  socks[0]!.receive({ type: 'changes', changes: [{ seq: 1, type: 'session_upserted', session: upserted }] });
  expect(onSession).toHaveBeenCalledWith(upserted);
  expect(onReconnect).not.toHaveBeenCalled();
  // A drop: both resubscribe through the one new socket; the session feed refetches, attention GETs again.
  socks[0]!.drop();
  await vi.advanceTimersByTimeAsync(1000);
  expect(socks).toHaveLength(2);
  expect(socks[1]!.sent).toEqual([{ type: 'subscribe', scope: 'sessions' }]);
  expect(onReconnect).toHaveBeenCalledTimes(1);
  expect(fetchAttention).toHaveBeenCalledTimes(2);
  sessions.close();
  expect(socks[1]!.closed).toBe(false);
  // Joining an open feed: GET at once (the subscription is already in place).
  const second = openLiveAttention(() => {}, { fetchAttention, feed });
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchAttention).toHaveBeenCalledTimes(3);
  second.close();
  attention.close();
  expect(socks[1]!.closed).toBe(true);
  await vi.advanceTimersByTimeAsync(5000);
  expect(socks).toHaveLength(2);
});
