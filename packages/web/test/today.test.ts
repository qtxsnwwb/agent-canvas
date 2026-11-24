import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, test, vi } from 'vitest';
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings, type NotificationStatus, type TodayUsage } from '@agent-canvas/shared';
import { openLiveToday, type TodayLiveState } from '../src/client';
import { lineInputText, NOTIFICATION_KINDS, parseLineInput } from '../src/notifications';
import { NotificationsView, type NotificationsViewProps } from '../src/pages/Notifications';
import { Stats, TodayBlock } from '../src/pages/Stats';
import { TodayHeaderLink } from '../src/TodayHeaderLink';
import { parseHash, USAGE_LINE_HASH } from '../src/route';
import { headerToday, percentOfLine, todayBlock } from '../src/today';
import { fakeSocket } from './helpers';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const M = 60_000;
const H = 60 * M;

/** Invented: a day with Claude Code, Codex and Cursor, as of 14:32 local time. */
const usage = (over: Partial<TodayUsage> = {}): TodayUsage => ({
  day: '2026-11-24',
  asOf: new Date(2026, 10, 24, 14, 32, 10).toISOString(),
  turns: 37,
  activeMs: 2 * H + 10 * M,
  tokens: { input: 1_000_000, cachedInput: 18_400_000, output: 200_000 },
  main: 1_200_000,
  byOrigin: [
    { origin: 'claude', turns: 25, activeMs: H + 40 * M, tokens: { input: 850_000, cachedInput: 17_900_000, output: 150_000 } },
    { origin: 'codex', turns: 9, activeMs: 25 * M, tokens: { input: 150_000, cachedInput: 500_000, output: 50_000 } },
    { origin: 'cursor', turns: 3, activeMs: 5 * M, tokens: null },
  ],
  usualMain: 900_000,
  lineTokens: 2_000_000,
  over: false,
  ...over,
});

const nothingToday = (): TodayUsage => usage({
  turns: 0, activeMs: 0, tokens: { input: 0, cachedInput: 0, output: 0 }, main: 0, byOrigin: [], usualMain: null,
});

const cursorOnly = (): TodayUsage => usage({
  turns: 3, activeMs: 5 * M, tokens: null, main: null,
  byOrigin: [{ origin: 'cursor', turns: 3, activeMs: 5 * M, tokens: null }],
});

// ---- the header ----

test('header: "今天" alone before the first result', () => {
  expect(headerToday(null)).toEqual({ num: null, label: '今天的用量，还没算出来', over: false });
});

test('header: the main number, rounded as on the stats page; the label spells it out', () => {
  expect(headerToday(usage({ main: 1_234_567 }))).toEqual({ num: '1.2M', label: '今天，新输入加输出 1,234,567 token', over: false });
  expect(headerToday(usage({ main: 86_000 })).num).toBe('86k');
  expect(headerToday(nothingToday())).toEqual({ num: '0', label: '今天，新输入加输出 0 token', over: false });
});

test('header: over the line, the warning state and the line in the label', () => {
  expect(headerToday(usage({ main: 2_345_678, over: true }))).toEqual({
    num: '2.3M', label: '今天，新输入加输出 2,345,678 token，已超过你设的 2,000,000', over: true,
  });
});

test('header: no token data today is a dash', () => {
  expect(headerToday(cursorOnly())).toEqual({ num: '—', label: '今天，用过的来源都没有 token 数据', over: false });
});

test('header link: a link to the stats page, number hidden from screen readers (the label has it), warning class when over', () => {
  const html = renderToStaticMarkup(createElement(TodayHeaderLink, { usage: usage({ main: 1_234_567 }) }));
  expect(html).toContain('href="#/stats"');
  expect(html).toContain('aria-label="今天，新输入加输出 1,234,567 token"');
  expect(html).toContain('今天<span class="header-today-num" aria-hidden="true">1.2M</span>');
  expect(html).not.toContain('is-over');
  const over = renderToStaticMarkup(createElement(TodayHeaderLink, { usage: usage({ main: 2_100_000, over: true }) }));
  expect(over).toContain('header-today is-over');
  expect(over).toContain('已超过你设的 2,000,000');
  const before = renderToStaticMarkup(createElement(TodayHeaderLink, { usage: null }));
  expect(before).toContain('>今天</a>');
});

// ---- the stats block ----

test('block: a normal day', () => {
  const b = todayBlock(usage());
  expect(b.title).toBe('今天（截至 14:32，数字最多晚 30 秒）');
  expect(b.empty).toBe(false);
  expect(b.main).toBe('1.2M');
  expect(b.usual).toBe('900k');
  expect(b.cached).toBe('18.4M');
  expect(b.activity).toBe('轮数 37 · 工作时长 2 小时 10 分');
  expect(b.line).toEqual({ text: '提醒线：2M（已用 60%）', tone: 'ok' });
  expect(b.rows).toEqual([
    { origin: 'claude', name: 'Claude Code', main: '1M', cached: '17.9M', turns: '25', active: '1 小时 40 分' },
    { origin: 'codex', name: 'Codex', main: '200k', cached: '500k', turns: '9', active: '25 分' },
    { origin: 'cursor', name: 'Cursor', main: '—', cached: '—', turns: '3', active: '5 分' },
  ]);
  expect(b.notes).toEqual(['Cursor 没有 token 数据，不在这个数里']);
});

test('block: over the line says 已超过 instead of a percent, from the line itself on', () => {
  expect(todayBlock(usage({ main: 2_500_000, over: true })).line).toEqual({ text: '已超过提醒线 2M', tone: 'over' });
  expect(todayBlock(usage({ main: 2_000_000, over: true })).line).toEqual({ text: '已超过提醒线 2M', tone: 'over' });
});

test('block: percent of the line is floored', () => {
  expect(percentOfLine(1_999_999, 2_000_000)).toBe(99);
  expect(percentOfLine(0, 2_000_000)).toBe(0);
  expect(percentOfLine(1_200_000, 2_000_000)).toBe(60);
  expect(todayBlock(usage({ main: 1_999_999 })).line.text).toBe('提醒线：2M（已用 99%）');
});

test('block: no line', () => {
  expect(todayBlock(usage({ lineTokens: null })).line).toEqual({ text: '没有设提醒线', tone: 'none' });
});

test('block: Cursor only — no main number, the reason, and the line cannot be compared', () => {
  const b = todayBlock(cursorOnly());
  expect(b.main).toBe('—');
  expect(b.cached).toBe('—');
  expect(b.line).toEqual({ text: '提醒线：2M（今天没有 token 数据，比不了）', tone: 'na' });
  expect(b.notes).toEqual(['Cursor 没有 token 数据，所以今天没有这个数']);
  expect(todayBlock(usage({ ...cursorOnly(), lineTokens: null })).line).toEqual({ text: '没有设提醒线', tone: 'none' });
});

test('block: several origins without token data are named together', () => {
  const b = todayBlock(usage({
    byOrigin: [
      ...usage().byOrigin,
      { origin: 'doubao', turns: 1, activeMs: M, tokens: null },
    ],
  }));
  expect(b.notes).toEqual(['Cursor、豆包没有 token 数据，不在这个数里']);
});

test('block: nothing today', () => {
  const b = todayBlock(nothingToday());
  expect(b.empty).toBe(true);
  expect(b.rows).toEqual([]);
  expect(b.notes).toEqual(['今天还没有用过']);
  expect(b.main).toBe('0');
  expect(b.line.text).toBe('提醒线：2M（已用 0%）');
});

test('block: Copilot CLI present adds its note', () => {
  const b = todayBlock(usage({
    byOrigin: [...usage().byOrigin.slice(0, 2), { origin: 'copilot', turns: 2, activeMs: 3 * M, tokens: { input: 0, cachedInput: 0, output: 0 } }],
  }));
  expect(b.notes).toEqual(['Copilot CLI 只在会话退出时记总数']);
  expect(b.rows.at(-1)).toMatchObject({ name: 'Copilot CLI', main: '0' });
});

test('block: no usual line when the past 7 days have no token data', () => {
  expect(todayBlock(usage({ usualMain: null })).usual).toBeNull();
});

test('block: an unreadable asOf leaves the time out of the title', () => {
  expect(todayBlock(usage({ asOf: 'nope' })).title).toBe('今天（数字最多晚 30 秒）');
});

test('block rendered: rows, the 修改 link, the per-origin table', () => {
  const html = renderToStaticMarkup(createElement(TodayBlock, { live: { usage: usage(), failed: false } }));
  expect(html).toContain('今天（截至 14:32，数字最多晚 30 秒）');
  expect(html).toContain('新输入 + 输出');
  expect(html).toContain('过去 7 天同一时刻平均');
  expect(html).toContain('缓存读取');
  expect(html).toContain('轮数 37 · 工作时长 2 小时 10 分');
  expect(html).toContain('提醒线：2M（已用 60%）');
  expect(html).toContain('href="#/notifications/usage-line"');
  for (const th of ['来源', '新输入+输出', '缓存读取', '轮数', '工作时长']) expect(html).toContain(`>${th}</th>`);
  expect(html).toContain('Cursor 没有 token 数据，不在这个数里');
  expect(renderToStaticMarkup(createElement(TodayBlock, { live: { usage: usage({ usualMain: null }), failed: false } })))
    .not.toContain('过去 7 天同一时刻平均');
  const over = renderToStaticMarkup(createElement(TodayBlock, { live: { usage: usage({ main: 2_500_000, over: true }), failed: false } }));
  expect(over).toContain('today-line is-over');
  expect(over).toContain('已超过提醒线 2M');
});

test('block rendered: nothing today, loading, failed', () => {
  const empty = renderToStaticMarkup(createElement(TodayBlock, { live: { usage: nothingToday(), failed: false } }));
  expect(empty).toContain('今天还没有用过');
  expect(empty).not.toContain('<table');
  expect(renderToStaticMarkup(createElement(TodayBlock, { live: { usage: null, failed: false } }))).toContain('加载中…');
  expect(renderToStaticMarkup(createElement(TodayBlock, { live: { usage: null, failed: true } }))).toContain('今天的用量读不出来，正在重试…');
});

test('block rendered: a failed refresh over a shown result says so in one line, the result stays', () => {
  const html = renderToStaticMarkup(createElement(TodayBlock, { live: { usage: usage(), failed: true } }));
  expect(html).toContain('今天的用量刷新失败，正在重试…');
  expect(html).toContain('提醒线：2M（已用 60%）');
  expect(renderToStaticMarkup(createElement(TodayBlock, { live: { usage: usage(), failed: false } }))).not.toContain('刷新失败');
});

test('route: 修改 opens the settings at the usage line', () => {
  expect(parseHash('#/notifications/usage-line')).toEqual({ page: 'notifications', focus: 'usage-line' });
  expect(parseHash(USAGE_LINE_HASH)).toEqual({ page: 'notifications', focus: 'usage-line' });
  expect(parseHash('#/notifications')).toStrictEqual({ page: 'notifications' });
  expect(parseHash('#/notifications/other')).toEqual({ page: 'home', projectId: null });
});

test('stats page: the block sits above the range switch and does not change with the filters', () => {
  const live: TodayLiveState = { usage: usage(), failed: false };
  const block = (html: string): string => /<section[^>]*class="today-block"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
  const plain = renderToStaticMarkup(createElement(Stats, { today: live }));
  vi.stubGlobal('window', { localStorage: { getItem: () => JSON.stringify({ range: 'all', origin: 'codex', projectId: 'p9' }), setItem: () => {} } });
  const filtered = renderToStaticMarkup(createElement(Stats, { today: live }));
  expect(block(plain)).not.toBe('');
  expect(block(filtered)).toBe(block(plain));
  expect(plain).not.toBe(filtered); // the filters did change: the range switch shows another choice
  expect(plain.indexOf('today-block')).toBeLessThan(plain.indexOf('aria-label="时间范围"'));
});

// ---- the settings ----

test('settings: the usage kind is in the list', () => {
  const k = NOTIFICATION_KINDS.find((x) => x.key === 'usage')!;
  expect(k.label).toBe('今天的新输入 + 输出超过提醒线时提醒我');
  expect(k.hint).not.toBe('');
  expect(k.note).not.toBe('');
});

test('settings: the line is typed in 万 token, both ways; empty means no line', () => {
  expect(lineInputText(0)).toBe('');
  expect(lineInputText(2_000_000)).toBe('200');
  expect(lineInputText(100_000_000_000)).toBe('10000000');
  expect(lineInputText(12_345)).toBe('1.2345'); // set by an API client: shown as it is, not rounded away
  expect(parseLineInput('200')).toEqual({ ok: true, value: 2_000_000 });
  expect(parseLineInput(' 1 ')).toEqual({ ok: true, value: 10_000 });
  expect(parseLineInput('10000000')).toEqual({ ok: true, value: 100_000_000_000 });
  expect(parseLineInput('')).toEqual({ ok: true, value: 0 });
  expect(parseLineInput('  ')).toEqual({ ok: true, value: 0 });
  expect(parseLineInput('0')).toEqual({ ok: true, value: 0 });
  const bad = '请填 1 到 10,000,000 之间的整数（单位：万 token），空着就是不设提醒线';
  for (const raw of ['10000001', '1.5', '-1', 'abc', '1e3', '2万']) expect(parseLineInput(raw)).toEqual({ ok: false, error: bad });
});

const status: NotificationStatus = {
  available: true, lastError: null, lastErrorAt: null, lastSentAt: null, lastSentKind: null, settingsError: null,
};
const view = (settings: NotificationSettings, over: Partial<NotificationsViewProps> = {}): string => renderToStaticMarkup(createElement(NotificationsView, {
  settings, status, loadError: null, drafts: {}, fieldErrors: {}, save: { kind: 'idle' }, test: { kind: 'idle' },
  onCommit: () => {}, onDraft: () => {}, onField: () => {}, onTest: () => {}, ...over,
}));
const inputTag = (html: string, id: string): string => new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? '';

test('settings page: with the master off the usage switch is disabled, the line input is not', () => {
  const html = view({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: false, usageLineTokens: 2_000_000 });
  expect(inputTag(html, 'notify-usage')).toContain('disabled');
  const line = inputTag(html, 'notify-usage-line');
  expect(line).not.toContain('disabled');
  expect(line).toContain('value="200"');
  expect(html).toContain('今天的新输入 + 输出超过提醒线时提醒我');
  expect(html).toContain('万 token');
  expect(html).toContain('不发通知也会变色');
  // The other number fields still follow the master switch.
  expect(inputTag(html, 'notify-stuck-minutes')).toContain('disabled');
});

test('settings page: no line is an empty input; a typed draft and its error are shown', () => {
  expect(inputTag(view({ ...DEFAULT_NOTIFICATION_SETTINGS }), 'notify-usage-line')).toContain('value=""');
  const parsed = parseLineInput('1.5');
  const html = view({ ...DEFAULT_NOTIFICATION_SETTINGS }, {
    drafts: { usageLineTokens: '1.5' }, fieldErrors: { usageLineTokens: parsed.ok ? undefined : parsed.error },
  });
  expect(inputTag(html, 'notify-usage-line')).toContain('value="1.5"');
  expect(inputTag(html, 'notify-usage-line')).toContain('aria-invalid="true"');
  expect(html).toContain('请填 1 到 10,000,000 之间的整数（单位：万 token），空着就是不设提醒线');
});

// ---- the live state ----

type Fetch = () => Promise<TodayUsage>;

test('live: fetched once subscribed, replaced by pushes, fetched again after a reconnect', async () => {
  vi.useFakeTimers();
  const sock = fakeSocket();
  let n = 0;
  const fetchToday = vi.fn<Fetch>(async () => { n += 1; return usage({ main: n }); });
  const states: TodayLiveState[] = [];
  const live = openLiveToday((s) => states.push(s), { fetchToday, createSocket: () => sock });
  expect(fetchToday).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(0);
  expect(sock.sent[0]).toEqual({ type: 'subscribe', scope: 'sessions' });
  expect(states.at(-1)).toEqual({ usage: usage({ main: 1 }), failed: false });
  sock.receive({ type: 'today', usage: usage({ main: 500 }) });
  expect(states.at(-1)).toEqual({ usage: usage({ main: 500 }), failed: false });
  sock.receive({ type: 'attention', response: {} });
  expect(states.at(-1)!.usage!.main).toBe(500);
  sock.drop();
  await vi.advanceTimersByTimeAsync(1000);
  expect(fetchToday).toHaveBeenCalledTimes(2);
  expect(states.at(-1)).toEqual({ usage: usage({ main: 2 }), failed: false });
  live.close();
});

test('live: refresh() fetches now (the stats page opening), its answer shown unless a push came first', async () => {
  vi.useFakeTimers();
  const sock = fakeSocket();
  let n = 0;
  const fetchToday = vi.fn<Fetch>(async () => { n += 1; return usage({ main: n * 10 }); });
  const states: TodayLiveState[] = [];
  const live = openLiveToday((s) => states.push(s), { fetchToday, createSocket: () => sock });
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchToday).toHaveBeenCalledTimes(1);
  live.refresh();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchToday).toHaveBeenCalledTimes(2);
  expect(states.at(-1)).toEqual({ usage: usage({ main: 20 }), failed: false });
  live.close();
  live.refresh();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchToday).toHaveBeenCalledTimes(2);
});

test('live: a fetch older than a push does not overwrite it', async () => {
  vi.useFakeTimers();
  const sock = fakeSocket();
  let resolve!: (u: TodayUsage) => void;
  const fetchToday = vi.fn<Fetch>(() => new Promise((r) => { resolve = r; }));
  const states: TodayLiveState[] = [];
  const live = openLiveToday((s) => states.push(s), { fetchToday, createSocket: () => sock });
  await vi.advanceTimersByTimeAsync(0);
  sock.receive({ type: 'today', usage: usage({ main: 9 }) });
  resolve(usage({ main: 1 }));
  await vi.advanceTimersByTimeAsync(0);
  expect(states.at(-1)).toEqual({ usage: usage({ main: 9 }), failed: false });
  live.close();
});

test('live: a failed fetch keeps the last state, is marked and retried', async () => {
  vi.useFakeTimers();
  const sock = fakeSocket();
  let fail = true;
  const fetchToday = vi.fn<Fetch>(async () => { if (fail) throw new TypeError('fetch failed'); return usage(); });
  const states: TodayLiveState[] = [];
  const live = openLiveToday((s) => states.push(s), { fetchToday, createSocket: () => sock });
  await vi.advanceTimersByTimeAsync(0);
  expect(states.at(-1)).toEqual({ usage: null, failed: true });
  fail = false;
  await vi.advanceTimersByTimeAsync(500);
  expect(fetchToday).toHaveBeenCalledTimes(2);
  expect(states.at(-1)).toEqual({ usage: usage(), failed: false });
  live.close();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetchToday).toHaveBeenCalledTimes(2);
});
