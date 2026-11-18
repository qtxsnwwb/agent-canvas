import type { Usage } from '@agent-canvas/shared';

/*
 * Token usage of a WorkBuddy / CodeBuddy Code record (docs/formats/buddy-family.md 6.3) in this project's convention
 * (spec section 10 item 2): `inputTokens` = input not read from cache, cache writes included; `cachedInputTokens` = cache
 * reads; `outputTokens` includes reasoning. Not checked against real data (no real file was seen).
 */

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** The first key of `keys` whose value is a count. */
function firstPresent(src: Obj, keys: readonly string[]): number | null {
  for (const k of keys) {
    const v = count(src[k]);
    if (v !== null) return v;
  }
  return null;
}

/** `cached_tokens` of `inputTokensDetails` (an object, or an array of objects: the first positive one). */
function detailsCached(v: unknown): number {
  const items = Array.isArray(v) ? v : [v];
  for (const item of items) {
    if (!isObject(item)) continue;
    const c = count(item.cached_tokens);
    if (c !== null && c > 0) return c;
  }
  return 0;
}

/** Cache reads: the first positive alias, in the engine's order (getCacheReadTokens), then the other readers' names. */
function cacheRead(src: Obj): number {
  const candidates: number[] = [
    count(src.cache_read_input_tokens) ?? 0,
    count(src.cacheReadInputTokens) ?? 0,
    detailsCached(src.inputTokensDetails),
    isObject(src.prompt_tokens_details) ? (count(src.prompt_tokens_details.cached_tokens) ?? 0) : 0,
    count(src.prompt_cache_hit_tokens) ?? 0,
    count(src.cacheTokens) ?? 0,
    count(src.cache_tokens) ?? 0,
  ];
  return candidates.find((n) => n > 0) ?? 0;
}

/** Cache writes: the first positive alias (getCacheCreationTokens). */
function cacheWrite(src: Obj): number {
  for (const k of ['cache_creation_input_tokens', 'cacheCreationInputTokens', 'prompt_cache_write_tokens']) {
    const v = count(src[k]);
    if (v !== null && v > 0) return v;
  }
  return 0;
}

const INPUT_KEYS = ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens'];
const OUTPUT_KEYS = ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens'];
/** Keys whose presence proves the input count includes the cached tokens (the engine's getCurrentContextUsage). */
const INCLUSIVE_KEYS = ['prompt_tokens', 'prompt_tokens_details', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens', 'inputTokensDetails'];

/**
 * One usage record in this project's convention, plus its total for "keep the largest"; null when not a usage object
 * (neither an input nor an output count). Every shape of format reference 6.3:
 * - gross input = the first of input_tokens / inputTokens / prompt_tokens / promptTokens; output = the first of
 *   output_tokens / outputTokens / completion_tokens / completionTokens (reasoning is part of it, never added);
 * - cached = the first positive cache-read alias; cache writes = the first positive cache-write alias;
 * - the input includes the cache when a key of INCLUSIVE_KEYS is present, or a reported total (total_tokens /
 *   totalTokens) equals gross input + output: then input = max(0, gross − cached) (writes stay in);
 *   otherwise the gross input excludes the cache: input = gross + writes.
 * total = input + cached + output.
 */
export function buddyUsage(src: unknown): { usage: Usage; total: number } | null {
  if (!isObject(src)) return null;
  const gross = firstPresent(src, INPUT_KEYS);
  const output = firstPresent(src, OUTPUT_KEYS);
  if (gross === null && output === null) return null;
  const g = gross ?? 0;
  const out = output ?? 0;
  const cached = cacheRead(src);
  const total = count(src.total_tokens) ?? count(src.totalTokens);
  const inclusive = INCLUSIVE_KEYS.some((k) => src[k] !== undefined) || (total !== null && total === g + out);
  const inputTokens = inclusive ? Math.max(0, g - cached) : g + cacheWrite(src);
  return { usage: { inputTokens, cachedInputTokens: cached, outputTokens: out }, total: inputTokens + cached + out };
}
