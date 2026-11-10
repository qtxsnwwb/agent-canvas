import { SEARCH_MIN_CHARS, type SearchHit } from '@claude-canvas/shared';

export const SEARCH_DEBOUNCE_MS = 250;

/** 把片段按不区分大小写的 q 切成段，供高亮；q 为空或未出现时返回单段。 */
export function highlightParts(snippet: string, q: string): { text: string; match: boolean }[] {
  if (q === '') return [{ text: snippet, match: false }];
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const parts: { text: string; match: boolean }[] = [];
  let last = 0;
  for (const m of snippet.matchAll(re)) {
    if (m[0] === '') continue;
    if (m.index > last) parts.push({ text: snippet.slice(last, m.index), match: false });
    parts.push({ text: m[0], match: true });
    last = m.index + m[0].length;
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
      if (q.length < SEARCH_MIN_CHARS) {
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
