import fs from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { CompareResponse, CompareSide, SearchHit, Session } from '@agent-canvas/shared';
import {
  ALL_PROJECTS_TEXT, COMPARE_BUTTON_TEXT, COMPARE_IDLE_POLL_MS, COMPARE_POLL_MS, FAILED_ONLY_TEXT, COMPARE_RETRY_MAX_MS, CWDS_DIFFER_TEXT, compareRetryDelay, isPlainClick, NOT_FOUND_TEXT, NO_TURN_TEXT, REFRESH_FAILED_TEXT,
  SAME_SESSION_TEXT, TURNS_TRUNCATED_TEXT, betterSide, compareView, createComparePoller, filterPickerRows, pickerList, pickerRows,
  searchPickerRows, shouldPoll, type CompareState,
} from '../src/compare';
import { IDENTITY_MASKER, createPageMasker } from '../src/masking';
import { ComparePageView } from '../src/pages/Compare';
import { ComparePickerView } from '../src/ComparePicker';
import { compareHash, parseHash, sessionFileHash, sessionHash, sessionNodeHash } from '../src/route';
import { embeddedSource } from '../src/viewer/data';
import { baseSession } from './helpers';

afterEach(() => { vi.useRealTimers(); });

// Invented sessions only.
const NOW = Date.parse('2026-11-24T10:00:00Z');

function side(o: Partial<CompareSide> = {}): CompareSide {
  return {
    sessionId: 'left-1', title: '修 CI 超时', origin: 'claude', projectId: 'D--work-demo', cwd: 'D:\\work\\demo', status: 'idle',
    lastActivityAt: '2026-11-24T09:00:00Z', activeMs: 750_000, turns: 3, steps: 142, toolCalls: 58, failed: 2, subagents: 4,
    tokens: { input: 1_000_000, cachedInput: 18_400_000, output: 200_000 }, ...o,
  };
}

function response(o: Partial<CompareResponse> = {}): CompareResponse {
  return {
    left: side(),
    right: side({
      sessionId: 'right-1', origin: 'codex', cwd: 'D:\\work\\demo', activeMs: 1_265_000, turns: 5, steps: 260, toolCalls: 97, failed: 9,
      subagents: 0, tokens: { input: 1_500_000, cachedInput: 3_100_000, output: 500_000 },
    }),
    sameSession: false,
    tools: [
      { toolName: 'Bash', left: { calls: 12, failed: 1 }, right: { calls: 20, failed: 6 } },
      { toolName: 'exec_command', left: null, right: { calls: 41, failed: 0 } },
      { toolName: 'Read', left: { calls: 30, failed: 0 }, right: null },
    ],
    otherTools: null,
    turns: [
      {
        index: 1,
        left: { promptNodeId: 'p1', promptHead: '帮我修 CI 超时', activeMs: 480_000, toolCalls: 40, tokens: 800_000 },
        right: { promptNodeId: 'q1', promptHead: '帮我修 CI 超时', activeMs: 720_000, toolCalls: 60, tokens: 1_100_000 },
      },
      {
        index: 2,
        left: { promptNodeId: null, promptHead: '', activeMs: null, toolCalls: 3, tokens: null },
        right: { promptNodeId: 'q2', promptHead: '再跑一次', activeMs: 60_000, toolCalls: 10, tokens: 20_000 },
      },
      { index: 3, left: null, right: { promptNodeId: 'q3', promptHead: '好了', activeMs: 5_000, toolCalls: 1, tokens: 900 } },
    ],
    turnsTruncated: false,
    files: {
      both: [{ path: 'src/ci.yml', left: { reads: 3, changes: 2 }, right: { reads: 5, changes: 4 } }],
      onlyLeft: [{ path: 'README.md', left: { reads: 1, changes: 0 }, right: null }],
      onlyRight: [],
      more: { both: 0, onlyLeft: 0, onlyRight: 0 },
      cwdsDiffer: false,
    },
    ...o,
  };
}

const IDS = { a: 'left-1', b: 'right-1' };
const text = (parts: { text: string }[]): string => parts.map((p) => p.text).join('');
const bold = (parts: { text: string; better: boolean }[]): string[] => parts.filter((p) => p.better).map((p) => p.text);

describe('route', () => {
  test('#/compare/<a>/<b> round-trips; swapping is the same route with the ids exchanged', () => {
    expect(compareHash('a/1', 'b 2')).toBe('#/compare/a%2F1/b%202');
    expect(parseHash(compareHash('a/1', 'b 2'))).toEqual({ page: 'compare', a: 'a/1', b: 'b 2' });
    expect(parseHash(compareHash('b 2', 'a/1'))).toEqual({ page: 'compare', a: 'b 2', b: 'a/1' });
  });
  test('a compare address without two ids is the home page', () => {
    for (const h of ['#/compare', '#/compare/', '#/compare/a', '#/compare/a/', '#/compare//b', '#/compare/a/b/c', '#/compare/%E0/b']) {
      expect(parseHash(h), h).toEqual({ page: 'home', projectId: null });
    }
  });
});

describe('bold rules', () => {
  test('the smaller side is better; equal or a missing side: none', () => {
    expect(betterSide(1, 2)).toBe('left');
    expect(betterSide(3, 2)).toBe('right');
    expect(betterSide(2, 2)).toBeNull();
    expect(betterSide(null, 2)).toBeNull();
    expect(betterSide(2, null)).toBeNull();
    expect(betterSide(null, null)).toBeNull();
  });

  test('totals: time, calls, failures and new input + output are bolded on the better side; the other rows never', () => {
    const v = compareView(response(), IDS, IDENTITY_MASKER, NOW);
    const row = (label: string) => v.totals.find((r) => r.label === label)!;
    expect(v.totals.map((r) => r.label)).toEqual(['总用时', '轮数', '步骤', '工具调用 / 失败', '子代理', '新输入 + 输出', '缓存读取', '来源']);
    expect(text(row('总用时').left)).toBe('12 分 30 秒');
    expect(text(row('总用时').right)).toBe('21 分 5 秒');
    expect(bold(row('总用时').left)).toEqual(['12 分 30 秒']);
    expect(bold(row('总用时').right)).toEqual([]);
    expect(text(row('工具调用 / 失败').left)).toBe('58 / 2');
    expect(bold(row('工具调用 / 失败').left)).toEqual(['58', '2']);
    expect(text(row('新输入 + 输出').left)).toBe('1.2M');
    expect(text(row('新输入 + 输出').right)).toBe('2M');
    expect(bold(row('新输入 + 输出').left)).toEqual(['1.2M']);
    for (const label of ['轮数', '步骤', '子代理', '缓存读取', '来源']) {
      expect(bold(row(label).left), label).toEqual([]);
      expect(bold(row(label).right), label).toEqual([]);
    }
    expect(text(row('来源').left)).toBe('Claude Code');
    expect(text(row('来源').right)).toBe('Codex');
  });

  test('calls and failures are judged apart; equal values and no token data are not bolded', () => {
    const r = response();
    r.right = { ...r.right!, toolCalls: 30, failed: 2, activeMs: r.left!.activeMs, tokens: null };
    const v = compareView(r, IDS, IDENTITY_MASKER, NOW);
    const row = (label: string) => v.totals.find((x) => x.label === label)!;
    expect(bold(row('工具调用 / 失败').left)).toEqual([]);
    expect(bold(row('工具调用 / 失败').right)).toEqual(['30']);
    expect(bold(row('总用时').left)).toEqual([]);
    expect(bold(row('总用时').right)).toEqual([]);
    expect(text(row('新输入 + 输出').right)).toBe('—');
    expect(text(row('缓存读取').right)).toBe('—');
    expect(bold(row('新输入 + 输出').left)).toEqual([]);
  });
});

describe('bold on what is shown', () => {
  test('two values that print the same are not bolded, even when the raw numbers differ', () => {
    const r = response();
    r.left = { ...r.left!, activeMs: 2 * 3_600_000 + 5 * 60_000 + 10_000, tokens: { input: 1_000_000, cachedInput: 0, output: 210_000 } };
    r.right = { ...r.right!, activeMs: 2 * 3_600_000 + 5 * 60_000 + 50_000, tokens: { input: 1_000_000, cachedInput: 0, output: 240_000 } };
    const v = compareView(r, IDS, IDENTITY_MASKER, NOW);
    const row = (label: string) => v.totals.find((x) => x.label === label)!;
    expect(text(row('总用时').left)).toBe('2 小时 5 分');
    expect(text(row('总用时').right)).toBe('2 小时 5 分');
    expect([...bold(row('总用时').left), ...bold(row('总用时').right)]).toEqual([]);
    expect(text(row('新输入 + 输出').left)).toBe('1.2M');
    expect(text(row('新输入 + 输出').right)).toBe('1.2M');
    expect([...bold(row('新输入 + 输出').left), ...bold(row('新输入 + 输出').right)]).toEqual([]);
  });

  test('calls and failures: judged on the printed counts too', () => {
    const r = response();
    r.left = { ...r.left!, toolCalls: 123_401, failed: 3 };
    r.right = { ...r.right!, toolCalls: 123_449, failed: 4 };
    const v = compareView(r, IDS, IDENTITY_MASKER, NOW);
    const row = v.totals.find((x) => x.label === '工具调用 / 失败')!;
    expect(text(row.left)).toBe('12.3 万 / 3');
    expect(text(row.right)).toBe('12.3 万 / 4');
    expect(bold(row.left)).toEqual(['3']);
    expect(bold(row.right)).toEqual([]);
  });
});

describe('the page view', () => {
  test('heads: title, origin, links to each session', () => {
    const v = compareView(response(), IDS, IDENTITY_MASKER, NOW);
    expect(v.heads[0]).toMatchObject({ found: true, title: '修 CI 超时', originLabel: 'Claude Code', href: sessionHash('left-1') });
    expect(v.heads[1]).toMatchObject({ found: true, originLabel: 'Codex', href: sessionHash('right-1') });
  });

  test('tools: literal names, a side without the tool shows —, a used tool links to its session; 其他 at the end', () => {
    const v = compareView(response({ otherTools: { left: 4, right: 0 } }), IDS, IDENTITY_MASKER, NOW);
    expect(v.tools.map((t) => t.name)).toEqual(['Bash', 'exec_command', 'Read', '其他']);
    expect(v.tools[0]!.left).toEqual({ text: '12（失败 1）', href: sessionHash('left-1') });
    expect(v.tools[0]!.right).toEqual({ text: '20（失败 6）', href: sessionHash('right-1') });
    expect(v.tools[1]!.left).toEqual({ text: '—', href: null });
    expect(v.tools[2]!.left.text).toBe('30');
    expect(v.tools[3]!.left.text).toBe('4');
    expect(v.tools[3]!.right.text).toBe('0');
  });

  test('turns: 第 N 轮, 「（无）」 for a missing turn, 「—」 for an undated one, links to the prompt (or the session)', () => {
    const v = compareView(response(), IDS, IDENTITY_MASKER, NOW);
    expect(v.turns.map((t) => t.label)).toEqual(['第 1 轮', '第 2 轮', '第 3 轮']);
    expect(v.turns[0]!.left).toMatchObject({ head: '帮我修 CI 超时', meta: '8 分 · 40 次 · 800k', href: sessionNodeHash('left-1', 'p1') });
    expect(v.turns[1]!.left).toMatchObject({ head: '', meta: '— · 3 次 · —', href: sessionHash('left-1') });
    expect(v.turns[2]!.left).toBeNull();
    expect(NO_TURN_TEXT).toBe('（无）');
    expect(v.turnsTruncated).toBe(false);
    expect(compareView(response({ turnsTruncated: true }), IDS, IDENTITY_MASKER, NOW).turnsTruncated).toBe(true);
    expect(TURNS_TRUNCATED_TEXT).toBe('只列出前 50 轮');
  });

  test('files: three groups, 「还有 N 个」, the cwd note, links to the file panel with the full path', () => {
    const r = response();
    r.files.more = { both: 0, onlyLeft: 7, onlyRight: 0 };
    r.files.cwdsDiffer = true;
    r.right = { ...r.right!, cwd: '/home/u/demo' };
    const v = compareView(r, IDS, IDENTITY_MASKER, NOW);
    expect(v.files.groups.map((g) => [g.label, g.rows.length, g.moreText])).toEqual([
      ['两边都碰过', 1, null], ['只有左边', 1, '还有 7 个'], ['只有右边', 0, null],
    ]);
    const ci = v.files.groups[0]!.rows[0]!;
    expect(ci.path).toBe('src/ci.yml');
    expect(ci.left).toEqual({ text: '3 / 2', href: sessionFileHash('left-1', 'D:/work/demo/src/ci.yml') });
    expect(ci.right).toEqual({ text: '5 / 4', href: sessionFileHash('right-1', '/home/u/demo/src/ci.yml') });
    expect(v.files.groups[1]!.rows[0]!.right).toEqual({ text: '—', href: null });
    expect(FAILED_ONLY_TEXT).toBe('（只有失败的尝试）');
    expect(v.files.cwdsDiffer).toBe(true);
    expect(CWDS_DIFFER_TEXT).toBe('两边工作目录不同，按相对路径配对');
  });

  test('a file touched only by failed attempts says so; failures beside successful touches do not change the cell', () => {
    const r = response();
    r.files.onlyLeft = [{ path: 'broken.ts', left: { reads: 0, changes: 0, failed: 2 }, right: null }];
    r.files.both = [{ path: 'src/ci.yml', left: { reads: 3, changes: 2, failed: 1 }, right: { reads: 5, changes: 4 } }];
    const v = compareView(r, IDS, IDENTITY_MASKER, NOW);
    expect(v.files.groups[1]!.rows[0]!.left.text).toBe('0 / 0（只有失败的尝试）');
    expect(v.files.groups[1]!.rows[0]!.left.href).toBe(sessionFileHash('left-1', 'D:/work/demo/broken.ts'));
    expect(v.files.groups[0]!.rows[0]!.left.text).toBe('3 / 2');
  });

  test('a side not found: 「找不到这个会话」, its cells empty, no bold; the other side shown as usual', () => {
    const r = response({ right: null });
    r.tools = r.tools.map((t) => ({ ...t, right: null }));
    const v = compareView(r, IDS, IDENTITY_MASKER, NOW);
    expect(v.heads[1]).toMatchObject({ found: false, title: NOT_FOUND_TEXT, href: null });
    expect(v.heads[0]).toMatchObject({ found: true, title: '修 CI 超时' });
    for (const row of v.totals) {
      expect(text(row.right), row.label).toBe('—');
      expect(bold(row.left), row.label).toEqual([]);
    }
    const html = renderToStaticMarkup(createElement(ComparePageView, { view: v, failed: false, onSwap: () => {}, onChange: () => {} }));
    expect(html).toContain(NOT_FOUND_TEXT);
    expect(html).toContain('修 CI 超时');
  });

  test('the same session twice: the note, and nothing bolded', () => {
    const r = response({ sameSession: true, right: side() });
    const v = compareView(r, { a: 'left-1', b: 'left-1' }, IDENTITY_MASKER, NOW);
    expect(v.sameSession).toBe(true);
    for (const row of v.totals) expect([...bold(row.left), ...bold(row.right)], row.label).toEqual([]);
    const html = renderToStaticMarkup(createElement(ComparePageView, { view: v, failed: false, onSwap: () => {}, onChange: () => {} }));
    expect(html).toContain(SAME_SESSION_TEXT);
  });

  test('masking on: titles, prompt heads, file paths (and their links) and cwds masked by rule', () => {
    const m = createPageMasker({ customTerms: ['北极星'], numbered: false });
    const r = response();
    r.left = { ...r.left!, title: '北极星 上线', cwd: 'D:\\北极星\\demo' };
    r.turns[0]!.left!.promptHead = '北极星 的 CI 坏了';
    r.files.both[0]!.path = 'src/北极星.yml';
    const v = compareView(r, IDS, m, NOW);
    const json = JSON.stringify(v);
    expect(json).not.toContain('北极星');
    expect(v.heads[0]!.title).toContain('‹已遮蔽·');
    expect(v.heads[0]!.cwd).toContain('‹已遮蔽·');
    expect(v.turns[0]!.left!.head).toContain('‹已遮蔽·');
    expect(v.files.groups[0]!.rows[0]!.path).toContain('‹已遮蔽·');
    const html = renderToStaticMarkup(createElement(ComparePageView, { view: v, failed: false, onSwap: () => {}, onChange: () => {} }));
    expect(html).not.toContain('北极星');
    expect(html).not.toContain(encodeURIComponent('北极星'));
  });

  test('the page: title row buttons, the totals table, a failed refresh keeps the result with one line', () => {
    const v = compareView(response(), IDS, IDENTITY_MASKER, NOW);
    const html = renderToStaticMarkup(createElement(ComparePageView, { view: v, failed: true, onSwap: () => {}, onChange: () => {} }));
    expect(html).toContain('交换左右');
    expect(html).toContain('换一个');
    expect(html).toContain('<strong>12 分 30 秒</strong>');
    expect(html).toContain(REFRESH_FAILED_TEXT);
    expect(html.split(REFRESH_FAILED_TEXT).length).toBe(2);
    // A running side while a refetch fails: the failure line only, not 「数字每 5 秒更新一次」 as well.
    const live = compareView(response({ left: side({ status: 'running' }) }), IDS, IDENTITY_MASKER, Date.parse(side().lastActivityAt) + 1000);
    expect(live.live).toBe(true);
    const page = (failed: boolean): string => renderToStaticMarkup(createElement(ComparePageView, { view: live, failed, onSwap: () => {}, onChange: () => {} }));
    expect(page(false)).toContain('每 5 秒更新一次');
    expect(page(true)).not.toContain('每 5 秒更新一次');
    expect(page(true)).toContain(REFRESH_FAILED_TEXT);
    expect(html).toContain(`href="${sessionNodeHash('left-1', 'p1')}"`);
    expect(html).toContain(NO_TURN_TEXT);
    // The tables scroll inside their own box.
    expect((html.match(/class="stats-table-wrap/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});

describe('polling', () => {
  const running = (): CompareResponse => response({ left: side({ status: 'running' }) });
  const idle = (): CompareResponse => response();

  test('shouldPoll: while either side runs or waits for a permission', () => {
    const at = Date.parse(side().lastActivityAt) + 1000;
    expect(shouldPoll(idle(), at)).toBe(false);
    expect(shouldPoll(running(), at)).toBe(true);
    expect(shouldPoll(response({ right: side({ status: 'awaiting_permission' }) }), at)).toBe(true);
    expect(shouldPoll(response({ right: side({ status: 'awaiting_input' }) }), at)).toBe(false);
    expect(shouldPoll(response({ left: null, right: null }), at)).toBe(false);
  });

  test('a stale “running” side (长时间无活动) is not live: no note, only the slow 60 s refetch', async () => {
    // Last activity a day before NOW: the pages show 长时间无活动, so the page neither says it is updating nor refetches.
    const stale = (): CompareResponse => response({ left: side({ status: 'running', lastActivityAt: '2026-11-23T10:00:00Z' }) });
    expect(shouldPoll(stale(), NOW)).toBe(false);
    const v = compareView(stale(), IDS, IDENTITY_MASKER, NOW);
    expect(v.heads[0]!.statusLabel).toBe('长时间无活动');
    expect(v.live).toBe(false);
    const html = renderToStaticMarkup(createElement(ComparePageView, { view: v, failed: false, onSwap: () => {}, onChange: () => {} }));
    expect(html).not.toContain('正在进行');
    vi.useFakeTimers();
    const load = vi.fn(() => Promise.resolve(stale()));
    const p = createComparePoller({ load, onState: () => {}, now: () => NOW });
    await vi.advanceTimersByTimeAsync(COMPARE_IDLE_POLL_MS - 1);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    p.close();
    // The same side fresh is live.
    expect(compareView(running(), IDS, IDENTITY_MASKER, Date.parse(side().lastActivityAt) + 1000).live).toBe(true);
  });

  // Answer time just after the running side's last activity: a fresh “running”.
  const fresh = (): number => Date.parse(side().lastActivityAt) + 1000;

  test('refetches every 5 s while running, every 60 s once both are idle, and fast again when a side resumes', async () => {
    vi.useFakeTimers();
    const answers = [running(), running(), idle(), idle(), running()];
    const load = vi.fn(() => Promise.resolve(answers.shift() ?? idle()));
    const states: CompareState[] = [];
    const p = createComparePoller({ load, onState: (s) => states.push(s), now: fresh });
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(COMPARE_POLL_MS - 1);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(COMPARE_POLL_MS);
    expect(load).toHaveBeenCalledTimes(3); // both idle now
    expect(states.at(-1)!.response!.left!.status).toBe('idle');
    await vi.advanceTimersByTimeAsync(COMPARE_IDLE_POLL_MS - 1);
    expect(load).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(4); // still idle: the next in 60 s
    await vi.advanceTimersByTimeAsync(COMPARE_IDLE_POLL_MS);
    expect(load).toHaveBeenCalledTimes(5); // a side resumed: back to 5 s
    await vi.advanceTimersByTimeAsync(COMPARE_POLL_MS);
    expect(load).toHaveBeenCalledTimes(6);
    expect(COMPARE_IDLE_POLL_MS).toBe(60_000);
    expect(states.at(-1)!.failed).toBe(false);
    p.close();
  });

  test('a failed refetch keeps the last result, says so, and retries', async () => {
    vi.useFakeTimers();
    const first = running();
    const load = vi.fn<() => Promise<CompareResponse>>()
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(idle());
    const states: CompareState[] = [];
    const p = createComparePoller({ load, onState: (s) => states.push(s), now: fresh });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(COMPARE_POLL_MS);
    expect(states.at(-1)).toEqual({ response: first, failed: true });
    await vi.advanceTimersByTimeAsync(COMPARE_POLL_MS);
    expect(load).toHaveBeenCalledTimes(3);
    expect(states.at(-1)!.failed).toBe(false);
    p.close();
  });

  test('closing stops it: no more requests (the slow idle refetch included), an answer in flight is dropped', async () => {
    vi.useFakeTimers();
    let resolve: (r: CompareResponse) => void = () => {};
    const load = vi.fn()
      .mockResolvedValueOnce(running())
      .mockImplementationOnce(() => new Promise<CompareResponse>((r) => { resolve = r; }));
    const onState = vi.fn();
    const p = createComparePoller({ load, onState, now: fresh });
    await vi.advanceTimersByTimeAsync(COMPARE_POLL_MS);
    expect(load).toHaveBeenCalledTimes(2);
    p.close();
    resolve(running());
    await vi.advanceTimersByTimeAsync(COMPARE_IDLE_POLL_MS * 3);
    expect(load).toHaveBeenCalledTimes(2);
    expect(onState).toHaveBeenCalledTimes(1);
  });
});

describe('retries', () => {
  test('the wait doubles from 5 s per failure in a row, capped at 60 s', () => {
    expect([1, 2, 3, 4, 5, 6, 50].map((n) => compareRetryDelay(n))).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    expect(COMPARE_RETRY_MAX_MS).toBe(60_000);
  });

  test('a first load that keeps failing is retried with growing waits; a success starts over', async () => {
    vi.useFakeTimers();
    const load = vi.fn<() => Promise<CompareResponse>>()
      .mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(response({ left: side({ status: 'running' }) }))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(response());
    const states: CompareState[] = [];
    const p = createComparePoller({ load, onState: (s) => states.push(s), now: () => Date.parse(side().lastActivityAt) + 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toEqual({ response: null, failed: true });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(load).toHaveBeenCalledTimes(4); // succeeded, a side running: the next one in 5 s
    expect(states.at(-1)!.failed).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(load).toHaveBeenCalledTimes(5); // failed once more: the wait starts over at 5 s
    await vi.advanceTimersByTimeAsync(5_000);
    expect(load).toHaveBeenCalledTimes(6);
    p.close();
  });
});

describe('the picker', () => {
  const s = (id: string, title: string | null, at: string, o: Partial<Session> = {}): Session =>
    ({ ...baseSession, id, title, lastActivityAt: at, projectId: 'p1', cwd: 'D:\\work\\demo', status: 'idle', ...o });
  const sessions = [
    s('cur', '当前这个', '2026-11-24T09:59:00Z'),
    s('old', '修登录 bug', '2026-11-20T09:00:00Z'),
    s('new', 'Fix CI timeout', '2026-11-24T09:30:00Z', { origin: 'codex' }),
    s('mid', null, '2026-11-23T09:00:00Z'),
  ];

  test('same-project sessions by last activity, without the current one; each with title, origin and time', () => {
    const rows = pickerRows(sessions, 'cur', IDENTITY_MASKER, NOW);
    expect(rows.map((r) => r.id)).toEqual(['new', 'mid', 'old']);
    expect(rows[0]).toMatchObject({ title: 'Fix CI timeout', originLabel: 'Codex', time: '30 分钟前', href: compareHash('cur', 'new') });
    expect(rows[1]!.title).toBe('mid');
  });

  test('from 换一个: the session already on the right is not offered again', () => {
    expect(pickerRows(sessions, 'cur', IDENTITY_MASKER, NOW, 'new').map((r) => r.id)).toEqual(['mid', 'old']);
    const hits = [{ session: s('new', 'Fix CI timeout', '2026-11-24T09:30:00Z'), matches: [] }, { session: s('far', 'CI', '2026-11-22T09:00:00Z'), matches: [] }];
    expect(searchPickerRows(hits, 'cur', IDENTITY_MASKER, NOW, 'new').map((r) => r.id)).toEqual(['far']);
    const base = { currentId: 'cur', projectId: 'p1', sessions, m: IDENTITY_MASKER, nowMs: NOW, otherId: 'new' };
    expect(pickerList({ ...base, allProjects: false, query: 'fix', search: null })).toEqual({ state: 'message', text: '没有符合筛选的会话' });
    expect(pickerList({ ...base, allProjects: true, query: 'CI', search: { q: 'CI', hits, error: null } })).toMatchObject({ state: 'rows', rows: [{ id: 'far' }] });
  });

  test('a row closes the picker only on a plain left click', () => {
    const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    expect(isPlainClick(click)).toBe(true);
    for (const other of [{ button: 1 }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }]) {
      expect(isPlainClick({ ...click, ...other }), JSON.stringify(other)).toBe(false);
    }
  });

  test('the filter matches the title literally (ASCII letters without case)', () => {
    const rows = pickerRows(sessions, 'cur', IDENTITY_MASKER, NOW);
    expect(filterPickerRows(rows, 'fix ci').map((r) => r.id)).toEqual(['new']);
    expect(filterPickerRows(rows, '登录').map((r) => r.id)).toEqual(['old']);
    expect(filterPickerRows(rows, '  ').map((r) => r.id)).toEqual(['new', 'mid', 'old']);
    expect(filterPickerRows(rows, 'f.x').map((r) => r.id)).toEqual([]);
  });

  test('all projects: the search endpoint’s session hits, at least 2 characters, without the current one', () => {
    const hit = (session: Session): SearchHit => ({ session, matches: [] });
    const hits = [hit(s('cur', '当前这个', '2026-11-24T09:59:00Z')), hit(s('far', 'CI 超时', '2026-11-22T09:00:00Z', { projectId: 'p2', cwd: '/srv/other' }))];
    const rows = searchPickerRows(hits, 'cur', IDENTITY_MASKER, NOW);
    expect(rows.map((r) => [r.id, r.project])).toEqual([['far', 'other']]);
    const base = { currentId: 'cur', projectId: 'p1', sessions, m: IDENTITY_MASKER, nowMs: NOW };
    expect(pickerList({ ...base, allProjects: true, query: 'C', search: null })).toEqual({ state: 'message', text: '至少输入 2 个字' });
    expect(pickerList({ ...base, allProjects: true, query: 'CI', search: null })).toEqual({ state: 'loading' });
    expect(pickerList({ ...base, allProjects: true, query: 'CI', search: { q: 'CI', hits, error: null } })).toMatchObject({ state: 'rows', rows: [{ id: 'far' }] });
    expect(pickerList({ ...base, allProjects: true, query: 'CI', search: { q: 'CI', hits: [], error: null } })).toEqual({ state: 'message', text: '没有匹配的会话' });
    expect(pickerList({ ...base, allProjects: false, query: 'fix', search: null })).toMatchObject({ state: 'rows', rows: [{ id: 'new' }] });
    expect(pickerList({ ...base, allProjects: false, query: '', search: null, sessions: null })).toEqual({ state: 'loading' });
  });

  test('masking on: titles and project names in the picker are masked', () => {
    const m = createPageMasker({ customTerms: ['北极星'], numbered: false });
    const rows = pickerRows([s('x', '北极星 发布', '2026-11-24T09:00:00Z')], 'cur', m, NOW);
    expect(JSON.stringify(rows)).not.toContain('北极星');
    const far = searchPickerRows([{ session: s('y', 'a', '2026-11-24T09:00:00Z', { cwd: '/srv/北极星' }), matches: [] }], 'cur', m, NOW);
    expect(JSON.stringify(far)).not.toContain('北极星');
  });

  test('the dialog: the filter box, the all-projects switch, the rows as links', () => {
    const rows = pickerRows(sessions, 'cur', IDENTITY_MASKER, NOW);
    const html = renderToStaticMarkup(createElement(ComparePickerView, {
      query: '', allProjects: false, list: { state: 'rows', rows }, onQuery: () => {}, onAllProjects: () => {}, onClose: () => {},
    }));
    expect(html).toContain('<dialog');
    expect(html).toContain(ALL_PROJECTS_TEXT);
    expect(html).toContain(`href="${compareHash('cur', 'new')}"`);
    expect(html).toContain('Fix CI timeout');
  });
});

describe('the viewer', () => {
  test('the exported viewer’s source has nothing a 「对比…」 would use', () => {
    const bundle = { session: baseSession, nodes: [], edges: [], details: {}, truncations: {}, unreadable: [] };
    const source = embeddedSource(bundle as never, () => { throw new Error('no layout here'); });
    expect(Object.keys(source).some((k) => /compare/i.test(k))).toBe(false);
    expect(COMPARE_BUTTON_TEXT).toBe('对比…');
  });

  // The built viewer (`pnpm build`): the whole page an exported file carries. Skipped before a build.
  const template = new URL('../dist/viewer-template.html', import.meta.url);
  test.skipIf(!fs.existsSync(template))('the built viewer carries no 「对比…」, no picker and no compare page', () => {
    const html = fs.readFileSync(template, 'utf8');
    for (const text of [COMPARE_BUTTON_TEXT, ALL_PROJECTS_TEXT, '交换左右', '/api/compare', '#/compare/']) expect(html, text).not.toContain(text);
  });
});
