import { afterEach, expect, test, vi } from 'vitest';
import { SEARCH_MAX_CHARS, type SearchHit } from '@claude-canvas/shared';
import { createSearcher, highlightParts } from '../src/search';
import { baseSession } from './helpers';

afterEach(() => { vi.useRealTimers(); });

const hit = (id: string): SearchHit => ({ session: { ...baseSession, id }, matches: [] });

test('highlightParts：不区分大小写、多处命中、中文、q 含正则特殊字符', () => {
  expect(highlightParts('Fix the FIX (fix)', 'fix')).toEqual([
    { text: 'Fix', match: true }, { text: ' the ', match: false }, { text: 'FIX', match: true }, { text: ' (', match: false }, { text: 'fix', match: true }, { text: ')', match: false },
  ]);
  expect(highlightParts('a.b', '.')).toEqual([{ text: 'a', match: false }, { text: '.', match: true }, { text: 'b', match: false }]);
  expect(highlightParts('修复登录问题', '登录')).toEqual([{ text: '修复', match: false }, { text: '登录', match: true }, { text: '问题', match: false }]);
  expect(highlightParts('abc', '')).toEqual([{ text: 'abc', match: false }]);
  expect(highlightParts('abc', 'zz')).toEqual([{ text: 'abc', match: false }]);
  expect(highlightParts('a(b', '(b')).toEqual([{ text: 'a', match: false }, { text: '(b', match: true }]);
});

test('highlightParts 与服务端规则一致：只对 ASCII 字母不区分大小写，É 与 é 互不高亮', () => {
  expect(highlightParts('Élan élan', 'é')).toEqual([{ text: 'Élan ', match: false }, { text: 'é', match: true }, { text: 'lan', match: false }]);
  expect(highlightParts('Élan élan', 'É')).toEqual([{ text: 'É', match: true }, { text: 'lan élan', match: false }]);
  expect(highlightParts('STRASSE', 'straße')).toEqual([{ text: 'STRASSE', match: false }]);
  expect(highlightParts('İstanbul', 'i̇')).toEqual([{ text: 'İstanbul', match: false }]);
});

test('highlightParts：超过 SEARCH_MAX_CHARS 的查询只用前 200 个码点', () => {
  const emoji = '\u{1F600}';
  const head = 'a'.repeat(199) + emoji; // 200 code points
  const snippet = `x${head}y`;
  expect(SEARCH_MAX_CHARS).toBe(200);
  expect(highlightParts(snippet, `${head}ZZZ`)).toEqual([
    { text: 'x', match: false },
    { text: head, match: true },
    { text: 'y', match: false },
  ]);
});

test('createSearcher：防抖内只发最后一次', async () => {
  vi.useFakeTimers();
  const search = vi.fn(async (q: string) => [hit(q)]);
  const onResult = vi.fn();
  const s = createSearcher({ search, onResult, delayMs: 250 });
  s.query('ab');
  await vi.advanceTimersByTimeAsync(100);
  s.query('abc');
  await vi.advanceTimersByTimeAsync(100);
  s.query('abcd');
  expect(search).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(250);
  expect(search).toHaveBeenCalledTimes(1);
  expect(search).toHaveBeenCalledWith('abcd');
  expect(onResult).toHaveBeenCalledTimes(1);
  expect(onResult.mock.calls[0]![0]).toMatchObject({ q: 'abcd', error: null });
  expect(onResult.mock.calls[0]![0].hits[0].session.id).toBe('abcd');
});

test('createSearcher：先发的请求后到时被丢弃', async () => {
  vi.useFakeTimers();
  const resolvers: Record<string, (h: SearchHit[]) => void> = {};
  const search = vi.fn((q: string) => new Promise<SearchHit[]>((r) => { resolvers[q] = r; }));
  const onResult = vi.fn();
  const s = createSearcher({ search, onResult, delayMs: 10 });
  s.query('aa');
  await vi.advanceTimersByTimeAsync(10);
  s.query('bb');
  await vi.advanceTimersByTimeAsync(10);
  resolvers['bb']!([hit('B')]);
  await vi.advanceTimersByTimeAsync(0);
  resolvers['aa']!([hit('A')]);
  await vi.advanceTimersByTimeAsync(0);
  expect(onResult).toHaveBeenCalledTimes(1);
  expect(onResult.mock.calls[0]![0].q).toBe('bb');
  expect(onResult.mock.calls[0]![0].hits[0].session.id).toBe('B');
});

test('createSearcher：不足 2 个字符不发请求，并回报 hits: null', async () => {
  vi.useFakeTimers();
  const search = vi.fn(async () => [] as SearchHit[]);
  const onResult = vi.fn();
  const s = createSearcher({ search, onResult, delayMs: 10 });
  s.query('a');
  s.query(' a ');
  s.query('');
  await vi.advanceTimersByTimeAsync(100);
  expect(search).not.toHaveBeenCalled();
  expect(onResult).toHaveBeenCalledWith({ q: '', hits: null, error: null });
  // Dropping below the minimum cancels a pending request.
  s.query('abc');
  s.query('a');
  await vi.advanceTimersByTimeAsync(100);
  expect(search).not.toHaveBeenCalled();
  expect(onResult.mock.calls.at(-1)![0]).toEqual({ q: 'a', hits: null, error: null });
});

test('api.search 对查询做 URL 编码', async () => {
  const fetchMock = vi.fn(async () => new Response('[]'));
  vi.stubGlobal('fetch', fetchMock);
  try {
    const { api } = await import('../src/client');
    await api.search('a&b=c 登录#');
    expect(fetchMock).toHaveBeenCalledWith('/api/search?q=a%26b%3Dc%20%E7%99%BB%E5%BD%95%23');
  } finally {
    vi.unstubAllGlobals();
  }
});

test('createSearcher：请求失败回报 error；dispose 后不再回调', async () => {
  vi.useFakeTimers();
  const search = vi.fn(async (q: string): Promise<SearchHit[]> => { if (q === 'bad') throw new Error('HTTP 500'); return []; });
  const onResult = vi.fn();
  const s = createSearcher({ search, onResult, delayMs: 10 });
  s.query('bad');
  await vi.advanceTimersByTimeAsync(20);
  expect(onResult).toHaveBeenCalledTimes(1);
  expect(onResult.mock.calls[0]![0]).toMatchObject({ q: 'bad', hits: null });
  expect(onResult.mock.calls[0]![0].error).toContain('HTTP 500');
  s.query('good');
  s.dispose();
  await vi.advanceTimersByTimeAsync(50);
  s.query('later');
  await vi.advanceTimersByTimeAsync(50);
  expect(onResult).toHaveBeenCalledTimes(1);
  expect(search).toHaveBeenCalledTimes(1);
});

test('highlightParts：相邻命中、q 比片段长', () => {
  expect(highlightParts('abab', 'ab')).toEqual([{ text: 'ab', match: true }, { text: 'ab', match: true }]);
  expect(highlightParts('ab', 'abcdef')).toEqual([{ text: 'ab', match: false }]);
  expect(highlightParts('', 'ab')).toEqual([{ text: '', match: false }]);
});

test('createSearcher：最小长度按码点计，与服务端一致', async () => {
  vi.useFakeTimers();
  const search = vi.fn(async () => [] as SearchHit[]);
  const onResult = vi.fn();
  const s = createSearcher({ search, onResult, delayMs: 10 });
  s.query('😀'); // one code point, two UTF-16 units
  await vi.advanceTimersByTimeAsync(50);
  expect(search).not.toHaveBeenCalled();
  expect(onResult).toHaveBeenLastCalledWith({ q: '😀', hits: null, error: null });
  s.query('登录'); // two code points
  await vi.advanceTimersByTimeAsync(50);
  expect(search).toHaveBeenCalledWith('登录');
});
