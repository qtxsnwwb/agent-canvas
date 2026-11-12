import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import type { Diagnostics } from '@claude-canvas/shared';
import { createPoller, EXPECTED_CODEX_HOOK_EVENTS, EXPECTED_HOOK_EVENTS, EXPECTED_HOOK_EVENTS_BY_ORIGIN, fileOrigin, formatAge, hooksByOrigin, hookState, summarizeDiagnostics, truncateSample, SAMPLE_DISPLAY_MAX } from '../src/diagnostics';

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const base: Diagnostics = {
  unknownRecords: [],
  lastHookAt: null,
  hookEvents: [],
  files: [],
  ingestFailures: [],
  importing: false,
  normalizerVersion: 1,
  dbEpoch: 'e',
  codex: { sessionsDir: null, sessionsDirExists: false },
  cursor: { dbPath: null, dbExists: false, lastPollAt: null, lastError: null },
};
const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

test('summarizeDiagnostics：从未收到 / 10 分钟内 / 更久', () => {
  expect(summarizeDiagnostics(base, NOW)).toMatchObject({ hooks: 'never', hookAgeMs: null });
  expect(summarizeDiagnostics({ ...base, lastHookAt: at(5_000) }, NOW)).toMatchObject({ hooks: 'recent', hookAgeMs: 5_000 });
  expect(summarizeDiagnostics({ ...base, lastHookAt: at(600_000) }, NOW)).toMatchObject({ hooks: 'recent' });
  expect(summarizeDiagnostics({ ...base, lastHookAt: at(600_001) }, NOW)).toMatchObject({ hooks: 'quiet', hookAgeMs: 600_001 });
  // A clock a little ahead of the server's never yields a negative age.
  expect(summarizeDiagnostics({ ...base, lastHookAt: at(-3_000) }, NOW).hookAgeMs).toBe(0);
});

test('missingHookEvents 是 14 个事件里没出现的，顺序同 EXPECTED_HOOK_EVENTS', () => {
  expect(EXPECTED_HOOK_EVENTS).toHaveLength(14);
  expect(summarizeDiagnostics(base, NOW).missingHookEvents).toEqual([...EXPECTED_HOOK_EVENTS]);
  const seen = [EXPECTED_HOOK_EVENTS[3]!, EXPECTED_HOOK_EVENTS[0]!, 'SomethingNew'];
  const d = { ...base, hookEvents: seen.map((eventName) => ({ origin: 'claude' as const, eventName, count: 1, lastAt: at(1) })) };
  expect(summarizeDiagnostics(d, NOW).missingHookEvents).toEqual(EXPECTED_HOOK_EVENTS.filter((e) => !seen.includes(e)));
  const all = { ...base, hookEvents: EXPECTED_HOOK_EVENTS.map((eventName) => ({ origin: 'claude' as const, eventName, count: 1, lastAt: at(1) })) };
  expect(summarizeDiagnostics(all, NOW).missingHookEvents).toEqual([]);
});

test('filesBehind 只含未读完的文件，最多 200 条；unknownTotal 是次数之和', () => {
  const files = [
    { path: 'a', offset: 10, size: 10 },
    { path: 'b', offset: 5, size: 10 },
    { path: 'c', offset: 0, size: 1 },
  ];
  const s = summarizeDiagnostics(
    { ...base, files, unknownRecords: [{ recordType: 'x', count: 3, sample: '' }, { recordType: 'y', count: 4, sample: '' }] },
    NOW,
  );
  expect(s.filesTotal).toBe(3);
  expect(s.filesBehind).toEqual([{ path: 'b', offset: 5, size: 10 }, { path: 'c', offset: 0, size: 1 }]);
  expect(s.unknownTotal).toBe(7);

  const many = Array.from({ length: 500 }, (_, i) => ({ path: `f${i}`, offset: 0, size: 1 }));
  const big = summarizeDiagnostics({ ...base, files: many }, NOW);
  expect(big.filesBehind).toHaveLength(200);
  expect(big.filesBehind[0]!.path).toBe('f0');
  expect(big.filesTotal).toBe(500);
});

test('EXPECTED_HOOK_EVENTS 与 docs/hooks-snippet.json 一致', () => {
  const file = fileURLToPath(new URL('../../../docs/hooks-snippet.json', import.meta.url));
  const snippet = JSON.parse(readFileSync(file, 'utf8')) as { hooks: Record<string, unknown> };
  expect([...EXPECTED_HOOK_EVENTS]).toEqual(Object.keys(snippet.hooks));
});

test('formatAge：秒 / 分钟 / 小时', () => {
  expect(formatAge(0)).toBe('0 秒前');
  expect(formatAge(59_999)).toBe('59 秒前');
  expect(formatAge(60_000)).toBe('1 分钟前');
  expect(formatAge(3_599_000)).toBe('59 分钟前');
  expect(formatAge(3_600_000)).toBe('1 小时前');
});

test('truncateSample 最多 2000 字符', () => {
  expect(SAMPLE_DISPLAY_MAX).toBe(2000);
  expect(truncateSample('x'.repeat(2000))).toBe('x'.repeat(2000));
  expect(truncateSample('x'.repeat(2001))).toBe('x'.repeat(2000) + '…');
});

test('behindTotal 是全部未读完文件数；无法解析的 lastHookAt 视为 quiet 且 hookAgeMs 为 null', () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ path: `f${i}`, offset: i % 2, size: 1 }));
  const s = summarizeDiagnostics({ ...base, files: many }, NOW);
  expect(s.behindTotal).toBe(125);
  expect(s.filesBehind).toHaveLength(125);
  const big = summarizeDiagnostics({ ...base, files: Array.from({ length: 300 }, (_, i) => ({ path: `g${i}`, offset: 0, size: 1 })) }, NOW);
  expect(big.behindTotal).toBe(300);
  expect(big.filesBehind).toHaveLength(200);
  expect(summarizeDiagnostics({ ...base, lastHookAt: 'garbage' }, NOW)).toMatchObject({ hooks: 'quiet', hookAgeMs: null });
  expect(summarizeDiagnostics(base, NOW)).toMatchObject({ hooks: 'never', behindTotal: 0 });
});

// ---- createPoller ----
afterEach(() => { vi.useRealTimers(); });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('createPoller：请求未返回时不发第二个；返回 5 秒后才发下一个', async () => {
  vi.useFakeTimers();
  const pending: ReturnType<typeof deferred<number>>[] = [];
  const load = vi.fn(() => { const d = deferred<number>(); pending.push(d); return d.promise; });
  const onResult = vi.fn();
  const p = createPoller({ load, onResult, intervalMs: 5000 });
  p.start();
  expect(load).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(load).toHaveBeenCalledTimes(1); // still pending: no overlap
  pending[0]!.resolve(1);
  await vi.advanceTimersByTimeAsync(4999);
  expect(onResult).toHaveBeenCalledWith({ ok: true, value: 1 });
  expect(load).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(load).toHaveBeenCalledTimes(2);
  p.stop();
});

test('createPoller：失败也会安排下一次', async () => {
  vi.useFakeTimers();
  const load = vi.fn<() => Promise<number>>().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(2);
  const onResult = vi.fn();
  const p = createPoller({ load, onResult, intervalMs: 5000 });
  p.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(onResult).toHaveBeenNthCalledWith(1, { ok: false, error: 'boom' });
  await vi.advanceTimersByTimeAsync(5000);
  expect(load).toHaveBeenCalledTimes(2);
  expect(onResult).toHaveBeenNthCalledWith(2, { ok: true, value: 2 });
  p.stop();
});

test('createPoller：stop() 之后不再请求，迟到的结果被丢弃', async () => {
  vi.useFakeTimers();
  const d = deferred<number>();
  const load = vi.fn(() => d.promise);
  const onResult = vi.fn();
  const p = createPoller({ load, onResult, intervalMs: 5000 });
  p.start();
  p.stop();
  d.resolve(1);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(onResult).not.toHaveBeenCalled();
  expect(load).toHaveBeenCalledTimes(1);

  // stop() while a next request is only scheduled
  const load2 = vi.fn(async () => 1);
  const p2 = createPoller({ load: load2, onResult, intervalMs: 5000 });
  p2.start();
  await vi.advanceTimersByTimeAsync(0);
  p2.stop();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(load2).toHaveBeenCalledTimes(1);
});

// ---- per origin ----
const ev = (origin: 'claude' | 'codex', eventName: string, lastAt = at(1)) => ({ origin, eventName, count: 1, lastAt });

test('EXPECTED_CODEX_HOOK_EVENTS 是 11 个，EXPECTED_HOOK_EVENTS_BY_ORIGIN 按来源给出', () => {
  expect([...EXPECTED_CODEX_HOOK_EVENTS]).toEqual([
    'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse',
    'SubagentStart', 'SubagentStop', 'Stop', 'PostCompact', 'Interrupt',
  ]);
  expect(EXPECTED_HOOK_EVENTS_BY_ORIGIN.claude).toBe(EXPECTED_HOOK_EVENTS);
  expect(EXPECTED_HOOK_EVENTS_BY_ORIGIN.codex).toBe(EXPECTED_CODEX_HOOK_EVENTS);
});

test('fileOrigin：codex: 前缀是 Codex，其余是 Claude Code', () => {
  expect(fileOrigin('codex:2026/11/11/rollout-x.jsonl')).toBe('codex');
  expect(fileOrigin('D--proj/abc.jsonl')).toBe('claude');
  expect(fileOrigin('hook:abc')).toBe('claude');
});

test('hooksByOrigin：只有 Claude 的安装只有 claude 一节，和以前一样', () => {
  const d = { ...base, lastHookAt: at(5), hookEvents: [ev('claude', 'Stop', at(5))] };
  const h = hooksByOrigin(d);
  expect(h.map((x) => x.origin)).toEqual(['claude']);
  expect(h[0]!.events.map((e) => e.eventName)).toEqual(['Stop']);
  expect(h[0]!.missing).toEqual(EXPECTED_HOOK_EVENTS.filter((e) => e !== 'Stop'));
  expect(h[0]!.lastAt).toBe(at(5));
  expect(hooksByOrigin(base)).toEqual([{ origin: 'claude', events: [], missing: [...EXPECTED_HOOK_EVENTS], lastAt: null }]);
});

test('hooksByOrigin：有 Codex 文件但没收到 Codex hook 时也列出 codex，缺失是全部 11 个', () => {
  const d = { ...base, files: [{ path: 'codex:2026/11/11/r.jsonl', offset: 1, size: 1 }] };
  const h = hooksByOrigin(d);
  expect(h.map((x) => x.origin)).toEqual(['claude', 'codex']);
  expect(h[1]).toEqual({ origin: 'codex', events: [], missing: [...EXPECTED_CODEX_HOOK_EVENTS], lastAt: null });
});

test('hooksByOrigin：事件按来源分开，缺失各按各的清单，最近时间取该来源事件里最晚的', () => {
  const d = {
    ...base,
    lastHookAt: at(1),
    hookEvents: [ev('claude', 'Notification', at(100)), ev('claude', 'Stop', at(50)), ev('codex', 'Interrupt', at(1)), ev('codex', 'Stop', at(20))],
  };
  const [claude, codex] = hooksByOrigin(d);
  expect(claude!.events.map((e) => e.eventName)).toEqual(['Notification', 'Stop']);
  expect(claude!.missing).not.toContain('Notification');
  expect(claude!.missing).toContain('SessionStart');
  expect(claude!.lastAt).toBe(at(50));
  expect(codex!.events.map((e) => e.eventName)).toEqual(['Interrupt', 'Stop']);
  expect(codex!.missing).toEqual(EXPECTED_CODEX_HOOK_EVENTS.filter((e) => e !== 'Interrupt' && e !== 'Stop'));
  expect(codex!.missing).not.toContain('Notification');
  expect(codex!.lastAt).toBe(at(1));
  // Only Codex hooks so far: the Claude section still shows, with nothing received.
  const onlyCodex = hooksByOrigin({ ...base, lastHookAt: at(1), hookEvents: [ev('codex', 'Stop', at(1))] });
  expect(onlyCodex.map((x) => [x.origin, x.lastAt])).toEqual([['claude', null], ['codex', at(1)]]);
});

test('hookState：和 summarizeDiagnostics 的 hooks / hookAgeMs 同一规则', () => {
  expect(hookState(null, NOW)).toEqual({ hooks: 'never', hookAgeMs: null });
  expect(hookState(at(5_000), NOW)).toEqual({ hooks: 'recent', hookAgeMs: 5_000 });
  expect(hookState(at(600_001), NOW)).toEqual({ hooks: 'quiet', hookAgeMs: 600_001 });
  expect(hookState('garbage', NOW)).toEqual({ hooks: 'quiet', hookAgeMs: null });
});

// ---- Cursor block ----
import { cursorBlockVisible, cursorDbLine, cursorHooks, cursorPollLine, cursorUnknownRecords } from '../src/diagnostics';

const cursorHook = { origin: 'cursor' as const, eventName: 'stop', count: 2, lastAt: at(1) };

test('cursorBlockVisible：库存在，或有 Cursor 的数据 / hook / 未识别记录时显示，否则不显示', () => {
  expect(cursorBlockVisible(base)).toBe(false);
  // A configured path alone says nothing (the default path is configured even where Cursor is not installed).
  expect(cursorBlockVisible({ ...base, cursor: { ...base.cursor, dbPath: '/x/state.vscdb' } })).toBe(false);
  expect(cursorBlockVisible({ ...base, cursor: { ...base.cursor, dbExists: true } })).toBe(true);
  expect(cursorBlockVisible({ ...base, hookEvents: [cursorHook] })).toBe(true);
  // Stored Cursor records with the database gone (M7): the server says so; Cursor never has file offsets.
  expect(cursorBlockVisible({ ...base, cursor: { ...base.cursor, hasData: true } })).toBe(true);
  expect(cursorBlockVisible({ ...base, files: [{ path: 'cursor:abc', offset: 1, size: 1 }] })).toBe(false);
  expect(cursorBlockVisible({ ...base, unknownRecords: [{ recordType: 'bubble:type9/cap3', count: 1, sample: '' }] })).toBe(true);
  expect(cursorBlockVisible({ ...base, unknownRecords: [{ recordType: 'foo', count: 1, sample: '' }] })).toBe(false);
});

test('cursorUnknownRecords：只取 Cursor 的（bubble:、composer: 或 cursor: 开头）', () => {
  const u = [
    { recordType: 'bubble:type9/cap3', count: 2, sample: 's' },
    { recordType: 'composer:invalid-json', count: 1, sample: '' },
    { recordType: 'cursor:composer', count: 1, sample: '' },
    { recordType: 'weird', count: 4, sample: '' },
    { recordType: 'normalizer-error', count: 1, sample: '' },
  ];
  expect(cursorUnknownRecords({ ...base, unknownRecords: u }).map((r) => r.recordType)).toEqual(['bubble:type9/cap3', 'composer:invalid-json', 'cursor:composer']);
});

test('cursorDbLine：未启用 / 存在 / 不存在（M8）', () => {
  expect(cursorDbLine({ ...base.cursor, dbPath: null })).toBe('Cursor 数据库：未启用');
  expect(cursorDbLine({ ...base.cursor, dbPath: '/c/state.vscdb', dbExists: true })).toBe('Cursor 数据库：/c/state.vscdb（存在）');
  expect(cursorDbLine({ ...base.cursor, dbPath: '/c/state.vscdb', dbExists: false })).toBe('Cursor 数据库：/c/state.vscdb（不存在，Cursor 似乎没有安装）');
});

test('cursorPollLine：相对时间，null 是“尚未轮询”', () => {
  expect(cursorPollLine(null, NOW)).toBe('尚未轮询');
  expect(cursorPollLine(at(90_000), NOW)).toBe('1 分钟前');
  expect(cursorPollLine('nonsense', NOW)).toBe('时间无法识别');
});

test('cursorHooks：Cursor 的事件、最近时间；没有 hook 时 events 为空，五个安装的事件都算缺少', () => {
  expect(cursorHooks(base)).toEqual({
    origin: 'cursor',
    events: [],
    missing: ['sessionStart', 'beforeSubmitPrompt', 'stop', 'subagentStop', 'sessionEnd'],
    lastAt: null,
  });
  const h = cursorHooks({ ...base, hookEvents: [{ origin: 'claude', eventName: 'Stop', count: 1, lastAt: at(5) }, cursorHook] });
  expect(h.events.map((e) => e.eventName)).toEqual(['stop']);
  expect(h.missing).toEqual(['sessionStart', 'beforeSubmitPrompt', 'subagentStop', 'sessionEnd']);
  expect(h.lastAt).toBe(at(1));
});

test('EXPECTED_HOOK_EVENTS_BY_ORIGIN.cursor 与 hooks install --cursor 安装的五个事件一致', () => {
  expect([...EXPECTED_HOOK_EVENTS_BY_ORIGIN.cursor]).toEqual(['sessionStart', 'beforeSubmitPrompt', 'stop', 'subagentStop', 'sessionEnd']);
});
