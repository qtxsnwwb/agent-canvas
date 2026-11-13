import {
  createMasker,
  isCutTitle,
  SEARCH_MAX_CHARS,
  SEARCH_SNIPPET_CHARS,
  type Diagnostics,
  type MaskedText,
  type Masker,
  type MaskTextOptions,
  type SearchHit,
  type SearchMatch,
} from '@agent-canvas/shared';
import { asciiLower, cutSnippet, type IndexPart, type IndexText, type Snippet } from '../store/search-index.js';
import type { Store } from '../store/store.js';
import { loadExportSettings } from './settings.js';

/**
 * Masked snippets for the page's masking switch (`?mask=1` on the search and diagnostics routes, spec 5). The page
 * cannot mask a snippet itself: what identifies a secret (a key name, a prefix, a scheme) may lie before the cut. The
 * server masks the FULL source text (at most MASKED_SOURCE_MAX characters), maps the match into the masked text and
 * cuts the snippet from there, never inside a placeholder.
 */

/** Stands for a whole snippet when masking cannot be applied (the custom-terms file is damaged): fail closed. */
export const MASKED_ALL = '‹已遮蔽›';
/** The longest source text masked for one snippet (the content index's own cap is 64 KB of UTF-8). */
export const MASKED_SOURCE_MAX = 256 * 1024;

/**
 * The snippet masker: credential, assignment and custom (terms from the export settings), unnumbered (snippets of many
 * sessions side by side). null when the settings file is damaged — callers then replace snippets by MASKED_ALL.
 */
export function snippetMasker(dataDir: string): Masker | null {
  const settings = loadExportSettings(dataDir);
  if (settings.settingsError !== null) return null;
  return createMasker({ categories: ['credential', 'assignment', 'custom'], customTerms: settings.customTerms, numbered: false });
}

/**
 * [a, b) of the original text mapped into the masked text: an end inside a replaced span moves to the span's end, a start
 * inside one to its start (so a match inside a secret becomes the whole placeholder).
 */
export function mapRange(r: MaskedText, a: number, b: number): [number, number] {
  let delta = 0;
  let ms = -1;
  let me = -1;
  for (const sp of r.spans) {
    if (ms < 0) {
      if (a < sp.start) ms = a + delta;
      else if (a < sp.end) ms = sp.maskedStart;
    }
    if (me < 0) {
      if (b <= sp.start) me = b + delta;
      else if (b <= sp.end) me = sp.maskedEnd;
    }
    delta += sp.maskedEnd - sp.maskedStart - (sp.end - sp.start);
  }
  if (ms < 0) ms = a + delta;
  if (me < 0) me = b + delta;
  return [ms, Math.max(ms, me)];
}

/** A snippet whose edges fell inside a placeholder: the broken placeholder is dropped and the side marked clipped. */
function trimPlaceholderEdges(sn: Snippet): Snippet {
  let { before, match, after, clippedStart, clippedEnd } = sn;
  const close = before.indexOf('›');
  const open = before.indexOf('‹');
  if (close >= 0 && (open < 0 || close < open)) {
    before = before.slice(close + 1);
    clippedStart = true;
  }
  const lastOpen = after.lastIndexOf('‹');
  if (lastOpen >= 0 && after.indexOf('›', lastOpen) < 0) {
    after = after.slice(0, lastOpen);
    clippedEnd = true;
  }
  const matchOpen = match.lastIndexOf('‹');
  if (matchOpen > 0 && match.indexOf('›', matchOpen) < 0) {
    match = match.slice(0, matchOpen);
    clippedEnd = true;
  }
  return { before, match, after, clippedStart, clippedEnd };
}

/** A content-search hit's snippet from the masked part holding the match (ContentSearchOptions.snippet). */
export function maskedContentSnippet(masker: Masker | null, it: IndexText, at: number, length: number, part: IndexPart): Snippet {
  if (masker === null) return { before: '', match: MASKED_ALL, after: '', clippedStart: true, clippedEnd: true };
  const text = it.text.slice(part.start, part.end);
  const r = masker.maskWithSpans(text, {
    truncated: part.cut,
    ...(part.key !== undefined ? { key: part.key, nested: part.nested === true } : {}),
  });
  const [ms, me] = mapRange(r, at - part.start, at - part.start + length);
  const out = trimPlaceholderEdges(cutSnippet(r.text, ms, me - ms, { start: 0, end: r.text.length, cut: part.cut }));
  if (part.start > 0 && /\S/.test(it.text.slice(0, part.start))) out.clippedStart = true;
  if (part.end < it.text.length && /\S/.test(it.text.slice(part.end))) out.clippedEnd = true;
  return out;
}

/** At most SEARCH_SNIPPET_CHARS code points around [ms, me) of masked text, with `…` marks, never inside a placeholder. */
function windowAround(masked: string, ms: number, me: number): string {
  const cps = Array.from(masked);
  const max = SEARCH_SNIPPET_CHARS;
  if (cps.length <= max) return masked;
  const at = Array.from(masked.slice(0, ms)).length;
  const matchLen = Array.from(masked.slice(ms, me)).length;
  const inner = max - 2;
  let start = Math.max(0, Math.min(at - Math.floor((inner - Math.min(matchLen, inner)) / 2), cps.length - inner));
  let end = Math.min(cps.length, start + inner);
  if (start === 0) end = Math.min(cps.length, end + 1);
  if (end === cps.length) start = Math.max(0, start - 1);
  // Edges inside a placeholder move outwards past it on the start side, back before it on the end side.
  for (let i = start - 1; i >= 0 && start > 0; i--) {
    if (cps[i] === '›') break;
    if (cps[i] === '‹') {
      const close = cps.indexOf('›', start);
      start = close < 0 ? end : Math.min(end, close + 1);
      break;
    }
  }
  for (let i = end - 1; i >= start; i--) {
    if (cps[i] === '›') break;
    if (cps[i] === '‹') {
      if (cps.indexOf('›', i) >= end) end = i;
      break;
    }
  }
  return `${start > 0 ? '…' : ''}${cps.slice(start, end).join('')}${end < cps.length ? '…' : ''}`;
}

/** The trimmed query the session search used (SEARCH_MAX_CHARS code points). */
function sessionQuery(raw: string): string {
  return Array.from(raw.trim()).slice(0, SEARCH_MAX_CHARS).join('').trim();
}

/** A session-search match with its snippet cut from the masked full source (the whole prompt for prompt matches). */
export function maskedSessionMatch(masker: Masker | null, store: Pick<Store, 'getNodeDetail'>, hit: SearchHit, match: SearchMatch, rawQuery: string): SearchMatch {
  const fail: SearchMatch = { ...match, snippet: MASKED_ALL, masked: true };
  if (masker === null) return fail;
  const s = hit.session;
  let source: string | null = null;
  let opts: MaskTextOptions | undefined;
  if (match.field === 'title') {
    source = s.title;
    if (isCutTitle(source)) opts = { truncated: true };
  } else if (match.field === 'id') source = s.id;
  else if (match.field === 'branch') source = s.gitBranch;
  else if (match.field === 'cwd') source = s.cwd;
  else if (match.nodeId !== null) {
    const detail = store.getNodeDetail(s.id, match.nodeId);
    if (detail !== null && typeof detail.text === 'string' && detail.text !== '') source = detail.text;
  }
  if (source === null || source.length > MASKED_SOURCE_MAX) return fail;
  const needle = asciiLower(sessionQuery(rawQuery));
  const at = asciiLower(source).indexOf(needle);
  if (needle === '' || at < 0) return fail;
  const r = masker.maskWithSpans(source, opts);
  const [ms, me] = mapRange(r, at, at + needle.length);
  return { ...match, snippet: windowAround(r.text, ms, me), masked: true };
}

/** Diagnostics with unknown-record samples masked (samples are cut at 500 characters: masked as cut text then). */
export function maskedDiagnostics(masker: Masker | null, d: Diagnostics, sampleMax: number): Diagnostics {
  return {
    ...d,
    unknownRecords: d.unknownRecords.map((r) => ({
      ...r,
      sample: masker === null ? MASKED_ALL : masker.mask(r.sample, r.sample.length >= sampleMax ? { truncated: true } : undefined),
    })),
  };
}
