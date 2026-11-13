import { afterEach, expect, test, vi } from 'vitest';
import type { ContentHit, ContentSearchResponse, SearchHit } from '@agent-canvas/shared';
import {
  CONTENT_NOTE_INDEXING, CONTENT_NOTE_SHORT_QUERY, CONTENT_NOTE_TRUNCATED, contentView, createSearcher, groupContentHits,
  snippetParts, type ContentResult,
} from '../src/search';
import { KIND_LABEL } from '../src/labels';

afterEach(() => { vi.useRealTimers(); });

const chit = (over: Partial<ContentHit> = {}): ContentHit => ({
  sessionId: 's1', projectId: 'p1', origin: 'claude', sessionTitle: '修登录', nodeId: 'n1', kind: 'text', toolName: null,
  at: '2026-11-01T10:00:00.000Z', agentId: null,
  snippet: { before: '前文 ', match: '登录页', after: ' 后文', clippedStart: false, clippedEnd: false },
  ...over,
});
const resp = (hits: ContentHit[], over: Partial<ContentSearchResponse> = {}): ContentSearchResponse =>
  ({ hits, truncated: false, shortQuery: false, indexing: false, ...over });
const ok = (q: string, r: ContentSearchResponse): ContentResult => ({ q, response: r, error: null });

test('snippetParts：三段按原样成文本段，命中段标记；空段省略；被截处加省略号', () => {
  expect(snippetParts({ before: 'a ', match: 'Fix', after: ' b', clippedStart: false, clippedEnd: false })).toEqual([
    { text: 'a ', match: false }, { text: 'Fix', match: true }, { text: ' b', match: false },
  ]);
  expect(snippetParts({ before: 'x', match: 'm', after: 'y', clippedStart: true, clippedEnd: true })).toEqual([
    { text: '…x', match: false }, { text: 'm', match: true }, { text: 'y…', match: false },
  ]);
  // Match at the very start / end of the text: no empty parts.
  expect(snippetParts({ before: '', match: 'm', after: '', clippedStart: false, clippedEnd: false })).toEqual([{ text: 'm', match: true }]);
  // Match itself cut (longer than the server keeps): the ellipsis still follows it.
  expect(snippetParts({ before: '', match: 'mmm', after: '', clippedStart: true, clippedEnd: true })).toEqual([
    { text: '…', match: false }, { text: 'mmm', match: true }, { text: '…', match: false },
  ]);
  // Markup-looking text stays plain text (rendered as text nodes).
  expect(snippetParts({ before: '<b>', match: '<i>', after: '&amp;', clippedStart: false, clippedEnd: false })
    .map((p) => p.text).join('')).toBe('<b><i>&amp;');
});

test('groupContentHits：相邻同会话的命中归一组，保持顺序；行模型含链接、类型、工具、子代理', () => {
  const hits = [
    chit({ sessionId: 's1', nodeId: 'n3', kind: 'tool', toolName: 'Bash', agentId: 'a1' }),
    chit({ sessionId: 's1', nodeId: 'n/2' }),
    chit({ sessionId: 's2', origin: 'codex', sessionTitle: null, nodeId: 'p1', kind: 'prompt' }),
  ];
  const groups = groupContentHits(hits);
  expect(groups.map((g) => [g.sessionId, g.origin, g.title, g.rows.length])).toEqual([
    ['s1', 'claude', '修登录', 2],
    ['s2', 'codex', 's2', 1],
  ]);
  expect(groups[0]!.rows[0]).toMatchObject({
    href: '#/s/s1/n/n3', kindLabel: KIND_LABEL.tool, toolName: 'Bash', inSubagent: true, at: '2026-11-01T10:00:00.000Z',
  });
  expect(groups[0]!.rows[1]).toMatchObject({ href: '#/s/s1/n/n%2F2', kindLabel: '回复', toolName: null, inSubagent: false });
  expect(groups[1]!.rows[0]!.kindLabel).toBe('提示');
  expect(new Set(groups.flatMap((g) => [g.key, ...g.rows.map((r) => r.key)])).size).toBe(5);
});

test('groupContentHits：标题缺失时用会话 id 前 8 位（与会话卡片一致）；不相邻的同一会话各成一组', () => {
  const groups = groupContentHits([
    chit({ sessionId: 'abcdef0123456789', sessionTitle: null }),
    chit({ sessionId: 'other' }),
    chit({ sessionId: 'abcdef0123456789', sessionTitle: null, nodeId: 'n9' }),
  ]);
  expect(groups.map((g) => g.title)).toEqual(['abcdef01', '修登录', 'abcdef01']);
  expect(new Set(groups.map((g) => g.key)).size).toBe(3);
});

test('contentView：查询太短、加载中（无结果或结果属于旧查询）、失败', () => {
  expect(contentView(null, 'a', 'all')).toEqual({ state: 'short', message: '至少输入 2 个字才搜内容' });
  expect(contentView(null, '😀', 'all').state).toBe('short');
  expect(contentView(null, '登录', 'all')).toEqual({ state: 'loading' });
  expect(contentView(ok('登', resp([chit()])), '登录', 'all')).toEqual({ state: 'loading' });
  expect(contentView({ q: '登录', response: null, error: 'HTTP 500' }, '登录', 'all'))
    .toEqual({ state: 'error', message: '内容搜索失败：HTTP 500' });
});

test('contentView：没有结果；标志位各自给出说明', () => {
  expect(contentView(ok('登录', resp([])), '登录', 'all')).toEqual({ state: 'empty', message: '没有匹配的内容', notes: [] });
  const v = contentView(ok('登录', resp([chit()], { shortQuery: true, indexing: true, truncated: true })), '登录', 'all');
  expect(v.state).toBe('hits');
  if (v.state !== 'hits') return;
  expect(v.notes).toEqual([CONTENT_NOTE_INDEXING, CONTENT_NOTE_SHORT_QUERY, CONTENT_NOTE_TRUNCATED]);
  expect(CONTENT_NOTE_SHORT_QUERY).toBe('两个字的词只在最近 30 天的提示和回复里找');
  expect(CONTENT_NOTE_INDEXING).toBe('索引正在重建，结果可能不全');
  expect(CONTENT_NOTE_TRUNCATED).toBe('结果较多，只显示了一部分，试试更长的词');
  expect(v.groups).toHaveLength(1);
  // An empty answer still says the index is incomplete.
  expect(contentView(ok('登录', resp([], { indexing: true })), '登录', 'all'))
    .toEqual({ state: 'empty', message: '没有匹配的内容', notes: [CONTENT_NOTE_INDEXING] });
});

test('contentView：来源筛选与会话组相同（在页面上筛），被筛掉时说明其他来源有几处', () => {
  const r = ok('登录', resp([chit({ sessionId: 'a' }), chit({ sessionId: 'b', origin: 'codex' }), chit({ sessionId: 'b', origin: 'codex', nodeId: 'n2' })]));
  const v = contentView(r, '登录', 'codex');
  expect(v.state === 'hits' && v.groups.map((g) => [g.sessionId, g.rows.length])).toEqual([['b', 2]]);
  expect(contentView(r, '登录', 'cursor')).toEqual({ state: 'empty', message: '没有匹配的 Cursor 内容（其他来源有 3 处）', notes: [] });
});

test('createSearcher：会话与内容两个请求同时发出，各自先到先报', async () => {
  vi.useFakeTimers();
  const resolvers: Record<string, (v: unknown) => void> = {};
  const search = vi.fn((q: string) => new Promise<SearchHit[]>((r) => { resolvers[`s:${q}`] = r as (v: unknown) => void; }));
  const searchContent = vi.fn((q: string) => new Promise<ContentSearchResponse>((r) => { resolvers[`c:${q}`] = r as (v: unknown) => void; }));
  const onResult = vi.fn();
  const onContent = vi.fn();
  const s = createSearcher({ search, onResult, searchContent, onContent, delayMs: 10 });
  s.query('登录');
  await vi.advanceTimersByTimeAsync(10);
  expect(search).toHaveBeenCalledWith('登录');
  expect(searchContent).toHaveBeenCalledWith('登录');
  resolvers['c:登录']!(resp([chit()]));
  await vi.advanceTimersByTimeAsync(0);
  expect(onContent).toHaveBeenCalledTimes(1);
  expect(onContent.mock.calls[0]![0]).toMatchObject({ q: '登录', error: null });
  expect(onResult).not.toHaveBeenCalled();
  resolvers['s:登录']!([]);
  await vi.advanceTimersByTimeAsync(0);
  expect(onResult).toHaveBeenCalledWith({ q: '登录', hits: [], error: null });
});

test('createSearcher：旧查询的内容结果晚到被丢弃；内容失败不影响会话结果；太短时两组都回报 null', async () => {
  vi.useFakeTimers();
  const resolvers: Record<string, (v: ContentSearchResponse) => void> = {};
  const search = vi.fn(async () => [] as SearchHit[]);
  const searchContent = vi.fn((q: string) => {
    if (q === 'bad') return Promise.reject(new Error('HTTP 400'));
    return new Promise<ContentSearchResponse>((r) => { resolvers[q] = r; });
  });
  const onResult = vi.fn();
  const onContent = vi.fn();
  const s = createSearcher({ search, onResult, searchContent, onContent, delayMs: 10 });
  s.query('aa');
  await vi.advanceTimersByTimeAsync(10);
  s.query('bb');
  await vi.advanceTimersByTimeAsync(10);
  resolvers['bb']!(resp([]));
  await vi.advanceTimersByTimeAsync(0);
  resolvers['aa']!(resp([chit()]));
  await vi.advanceTimersByTimeAsync(0);
  expect(onContent).toHaveBeenCalledTimes(1);
  expect(onContent.mock.calls[0]![0].q).toBe('bb');

  s.query('bad');
  await vi.advanceTimersByTimeAsync(10);
  expect(onContent.mock.calls.at(-1)![0]).toMatchObject({ q: 'bad', response: null });
  expect(onContent.mock.calls.at(-1)![0].error).toContain('HTTP 400');
  expect(onResult).toHaveBeenLastCalledWith({ q: 'bad', hits: [], error: null });

  s.query('a');
  expect(onContent).toHaveBeenLastCalledWith({ q: 'a', response: null, error: null });
  expect(onResult).toHaveBeenLastCalledWith({ q: 'a', hits: null, error: null });
});

test('api.searchContent 对查询做 URL 编码', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(resp([]))));
  vi.stubGlobal('fetch', fetchMock);
  try {
    const { api } = await import('../src/client');
    await api.searchContent('a&b=c 登录#');
    expect(fetchMock).toHaveBeenCalledWith('/api/search/content?q=a%26b%3Dc%20%E7%99%BB%E5%BD%95%23');
  } finally {
    vi.unstubAllGlobals();
  }
});
