import {
  CONTENT_SHORT_QUERY_DAYS, SEARCH_MAX_CHARS, SEARCH_MIN_CHARS, type ContentHit, type ContentSearchResponse, type Origin,
  type SearchHit,
} from '@agent-canvas/shared';
import { originLook, type OriginFilter } from './home';
import { KIND_LABEL } from './labels';
import { IDENTITY_MASKER, type PageMasker } from './masking';
import { sessionNodeHash } from './route';

export const SEARCH_DEBOUNCE_MS = 250;

/** 只把 ASCII 字母转小写（与服务端、SQLite LIKE 相同），字符串下标与原文保持对齐。 */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * 把片段按 q 的出现位置切成段，供高亮；规则与服务端检索相同：q 去掉首尾空白后截到 SEARCH_MAX_CHARS 个码点，
 * 只有 ASCII 字母不区分大小写，按字面查找（不用正则、不做 Unicode 大小写折叠）。q 为空或未出现时返回单段。
 */
export function highlightParts(snippet: string, q: string): { text: string; match: boolean }[] {
  const ranges = highlightRanges(snippet, q);
  if (ranges.length === 0) return [{ text: snippet, match: false }];
  const parts: { text: string; match: boolean }[] = [];
  let last = 0;
  for (const [at, end] of ranges) {
    if (at > last) parts.push({ text: snippet.slice(last, at), match: false });
    parts.push({ text: snippet.slice(at, end), match: true });
    last = end;
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), match: false });
  return parts;
}

/** Where q occurs in the snippet (highlightParts' rule), as [start, end) ranges in order. */
export function highlightRanges(snippet: string, q: string): [number, number][] {
  const needle = asciiLower(Array.from(q.trim()).slice(0, SEARCH_MAX_CHARS).join('').trim());
  if (needle === '') return [];
  const hay = asciiLower(snippet);
  const out: [number, number][] = [];
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) out.push([at, at + needle.length]);
  return out;
}

/** `mask: true`: requested with `mask=1` (the server masked the snippets); absent: plain. */
export interface SearchResult { q: string; hits: SearchHit[] | null; error: string | null; mask?: true }
/**
 * The content group's answer for q under an origin filter (null: all origins; the server filters, so its caps apply
 * after the filter): response null when q is too short or the request failed (error set).
 */
export interface ContentResult { q: string; origin: Origin | null; response: ContentSearchResponse | null; error: string | null; mask?: true }

/** Shown instead of results that should have come masked (switch on) but did not: nothing of them is rendered. */
export const SEARCH_UNMASKED_TEXT = '检索结果暂时无法遮蔽显示';

/**
 * The session group's state for the switch: 'loading' while the answer is for the other switch position (stale),
 * 'unmasked' when the switch is on and a match did not come masked by the server (fail closed: render none of it),
 * else 'ok'.
 */
export function sessionResultState(result: SearchResult, maskOn: boolean): 'loading' | 'unmasked' | 'ok' {
  if ((result.mask === true) !== maskOn) return 'loading';
  if (maskOn && (result.hits ?? []).some((h) => h.matches.some((m) => m.masked !== true))) return 'unmasked';
  return 'ok';
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * 只把最后一次查询的结果交给回调；更早的请求即使晚到也被丢弃。delayMs 内的连续输入只发最后一次。
 * 给了 searchContent 时，会话与内容两个请求在同一时刻发出，各自到达就各自回报（onResult / onContent），互不等待。
 * 内容请求带着来源筛选（setContentOrigin）；筛选变了只重发内容请求，旧筛选的结果晚到同样被丢弃。
 */
export function createSearcher(deps: {
  /** `mask` true: ask for server-masked snippets (`mask=1`); the argument is passed only when true. */
  search(q: string, mask?: true): Promise<SearchHit[]>;
  onResult(r: SearchResult): void;
  searchContent?(q: string, origin: Origin | null, mask?: true): Promise<ContentSearchResponse>;
  onContent?(r: ContentResult): void;
  delayMs?: number;
}): { query(q: string): void; setContentOrigin(origin: Origin | null): void; setMask(on: boolean): void; dispose(): void } {
  const delayMs = deps.delayMs ?? SEARCH_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest = 0;
  let latestContent = 0;
  let disposed = false;
  let origin: Origin | null = null;
  /** The query whose requests were sent (null: too short, or nothing sent yet). */
  let sentQ: string | null = null;
  /** The masking switch: requests carry `mask=1` and results `mask: true` while on. */
  let mask = false;
  const tag = <T extends object>(r: T, on: boolean): T & { mask?: true } => (on ? { ...r, mask: true as const } : r);

  const runContent = (q: string): void => {
    const { searchContent, onContent } = deps;
    if (searchContent === undefined || onContent === undefined) return;
    latestContent += 1;
    const mine = latestContent;
    const o = origin;
    const on = mask;
    const current = (): boolean => !disposed && mine === latestContent;
    (on ? searchContent(q, o, true) : searchContent(q, o)).then(
      (response) => { if (current()) onContent(tag({ q, origin: o, response, error: null }, on)); },
      (e: unknown) => { if (current()) onContent(tag({ q, origin: o, response: null, error: errorText(e) }, on)); },
    );
  };

  const runSessions = (q: string): void => {
    latest += 1;
    const mine = latest;
    const on = mask;
    const current = (): boolean => !disposed && mine === latest;
    (on ? deps.search(q, true) : deps.search(q)).then(
      (hits) => { if (current()) deps.onResult(tag({ q, hits, error: null }, on)); },
      (e: unknown) => { if (current()) deps.onResult(tag({ q, hits: null, error: errorText(e) }, on)); },
    );
  };

  return {
    query(raw) {
      if (disposed) return;
      const q = raw.trim();
      latest += 1;
      latestContent += 1;
      sentQ = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (Array.from(q).length < SEARCH_MIN_CHARS) {
        deps.onResult({ q, hits: null, error: null });
        deps.onContent?.({ q, origin, response: null, error: null });
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        sentQ = q;
        runSessions(q);
        runContent(q);
      }, delayMs);
    },
    setContentOrigin(next) {
      if (disposed || next === origin) return;
      origin = next;
      // A pending (debounced) query picks the new filter up when it fires.
      if (sentQ !== null) runContent(sentQ);
    },
    setMask(on) {
      if (disposed || on === mask) return;
      mask = on;
      // Both groups are asked again; the answers for the other position are dropped (and ignored by the views).
      if (sentQ !== null) {
        runSessions(sentQ);
        runContent(sentQ);
      }
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

export const CONTENT_NOTE_INDEXING = '索引正在重建，结果可能不全';
export const CONTENT_NOTE_SHORT_QUERY = `两个字的词只在最近 ${CONTENT_SHORT_QUERY_DAYS} 天的提示和回复里找`;
export const CONTENT_NOTE_TRUNCATED = '结果较多，只显示了一部分，试试更长的词';

export interface SnippetPart { text: string; match: boolean }

/** A content snippet as text parts (the match marked), with an ellipsis where the server left text out; no empty parts. */
export function snippetParts(snippet: ContentHit['snippet']): SnippetPart[] {
  const before = `${snippet.clippedStart ? '…' : ''}${snippet.before}`;
  const after = `${snippet.after}${snippet.clippedEnd ? '…' : ''}`;
  const parts: SnippetPart[] = [];
  if (before !== '') parts.push({ text: before, match: false });
  if (snippet.match !== '') parts.push({ text: snippet.match, match: true });
  if (after !== '') parts.push({ text: after, match: false });
  return parts;
}

export interface ContentRow {
  key: string;
  /** The node address: opens the session with this step selected. */
  href: string;
  kindLabel: string;
  toolName: string | null;
  at: string;
  /** The step belongs to a subagent's thread. */
  inSubagent: boolean;
  parts: SnippetPart[];
}

/** One session's hits under one heading (title and origin shown once). */
export interface ContentSessionGroup { key: string; sessionId: string; origin: Origin; title: string; rows: ContentRow[] }

/**
 * Groups consecutive hits of the same session (the server sends them grouped), keeping the server's order. With the
 * masking switch on (`m`), the session title (isCutTitle) and tool name are masked here; the snippet was masked by the
 * server (`mask=1`) and is shown as it came (its match may be a placeholder, which is then the marked part).
 */
export function groupContentHits(hits: readonly ContentHit[], m: PageMasker = IDENTITY_MASKER): ContentSessionGroup[] {
  const groups: ContentSessionGroup[] = [];
  for (const h of hits) {
    let g = groups.at(-1);
    if (g === undefined || g.sessionId !== h.sessionId) {
      g = { key: `${groups.length}:${h.sessionId}`, sessionId: h.sessionId, origin: h.origin, title: h.sessionTitle !== null ? m.title(h.sessionTitle) : h.sessionId.slice(0, 8), rows: [] };
      groups.push(g);
    }
    g.rows.push({
      key: `${g.key}:${g.rows.length}:${h.nodeId}`,
      href: sessionNodeHash(h.sessionId, h.nodeId),
      kindLabel: KIND_LABEL[h.kind] ?? h.kind,
      toolName: h.toolName === null ? null : m.text(h.toolName),
      at: h.at,
      inSubagent: h.agentId !== null,
      parts: snippetParts(h.snippet),
    });
  }
  return groups;
}

export type ContentView =
  | { state: 'short'; message: string }
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'empty'; message: string; notes: string[] }
  | { state: 'hits'; groups: ContentSessionGroup[]; notes: string[] };

/**
 * What the content group shows for the trimmed query q under the page's origin filter. The server applies the filter
 * (contentOrigin); an answer for another query or another filter counts as still loading.
 */
export function contentView(result: ContentResult | null, q: string, filter: OriginFilter, m: PageMasker = IDENTITY_MASKER): ContentView {
  if (Array.from(q).length < SEARCH_MIN_CHARS) return { state: 'short', message: `至少输入 ${SEARCH_MIN_CHARS} 个字才搜内容` };
  if (result === null || result.q !== q || result.origin !== contentOrigin(filter)) return { state: 'loading' };
  // An answer for the other switch position is stale.
  if ((result.mask === true) !== m.on) return { state: 'loading' };
  if (result.response === null) return result.error !== null ? { state: 'error', message: `内容搜索失败：${result.error}` } : { state: 'loading' };
  const r = result.response;
  // Fail closed: with the switch on, a hit that did not come masked by the server is not rendered at all.
  if (m.on && r.hits.some((h) => h.masked !== true)) return { state: 'error', message: SEARCH_UNMASKED_TEXT };
  const notes: string[] = [];
  if (r.indexing) notes.push(CONTENT_NOTE_INDEXING);
  if (r.shortQuery) notes.push(CONTENT_NOTE_SHORT_QUERY);
  if (r.truncated) notes.push(CONTENT_NOTE_TRUNCATED);
  if (r.hits.length === 0) {
    return { state: 'empty', message: filter === 'all' ? '没有匹配的内容' : `没有匹配的 ${originLook(filter).label} 内容`, notes };
  }
  return { state: 'hits', groups: groupContentHits(r.hits, m), notes };
}

/** The origin the content request carries for the page's filter (null: no filter). */
export function contentOrigin(filter: OriginFilter): Origin | null {
  return filter === 'all' ? null : filter;
}
