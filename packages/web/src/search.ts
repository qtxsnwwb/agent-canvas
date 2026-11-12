import { SEARCH_MAX_CHARS, SEARCH_MIN_CHARS, type SearchHit } from '@agent-canvas/shared';

export const SEARCH_DEBOUNCE_MS = 250;

/** 只把 ASCII 字母转小写（与服务端、SQLite LIKE 相同），字符串下标与原文保持对齐。 */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * 把片段按 q 的出现位置切成段，供高亮；规则与服务端检索相同：q 去掉首尾空白后截到 SEARCH_MAX_CHARS 个码点，
 * 只有 ASCII 字母不区分大小写，按字面查找（不用正则、不做 Unicode 大小写折叠）。q 为空或未出现时返回单段。
 */
export function highlightParts(snippet: string, q: string): { text: string; match: boolean }[] {
  const needle = asciiLower(Array.from(q.trim()).slice(0, SEARCH_MAX_CHARS).join('').trim());
  if (needle === '') return [{ text: snippet, match: false }];
  const hay = asciiLower(snippet);
  const parts: { text: string; match: boolean }[] = [];
  let last = 0;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, last)) {
    if (at > last) parts.push({ text: snippet.slice(last, at), match: false });
    parts.push({ text: snippet.slice(at, at + needle.length), match: true });
    last = at + needle.length;
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), match: false });
  return parts.length === 0 ? [{ text: snippet, match: false }] : parts;
}

export interface SearchResult { q: string; hits: SearchHit[] | null; error: string | null }

/** 只把最后一次请求的结果交给 onResult；更早的请求即使晚到也被丢弃。delayMs 内的连续输入只发最后一次。 */
export function createSearcher(deps: {
  search(q: string): Promise<SearchHit[]>;
  onResult(r: SearchResult): void;
  delayMs?: number;
}): { query(q: string): void; dispose(): void } {
  const delayMs = deps.delayMs ?? SEARCH_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest = 0;
  let disposed = false;

  return {
    query(raw) {
      if (disposed) return;
      const q = raw.trim();
      latest += 1;
      const mine = latest;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (Array.from(q).length < SEARCH_MIN_CHARS) {
        deps.onResult({ q, hits: null, error: null });
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        deps.search(q).then(
          (hits) => { if (!disposed && mine === latest) deps.onResult({ q, hits, error: null }); },
          (e: unknown) => { if (!disposed && mine === latest) deps.onResult({ q, hits: null, error: e instanceof Error ? e.message : String(e) }); },
        );
      }, delayMs);
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
