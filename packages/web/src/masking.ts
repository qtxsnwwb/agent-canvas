/**
 * The page's masking switch (spec 5): what the header's 遮蔽 switch applies to the text the pages show. Pure (only the
 * shared masker); the React side is MaskContext.tsx.
 *
 * Where it is applied (one place per kind of data, so no surface is missed):
 * - the session page: createMaskedSource wraps the session's SessionSource, so the canvas, the waterfall, the drawer
 *   (input / output / text / raw record), the file panel, the anomaly panel and the replay all render masked data (the
 *   exported viewer renders its already-masked bundle the same way, through the same component);
 * - the cross-session pages: each page masks the API answer it received with the functions below before rendering it
 *   (maskSessionFields, maskProject, maskProjectFiles, maskStats, maskAnomalyList, maskDiagnostics), and the search
 *   snippets with maskedHighlight / maskContentSnippet.
 * Ids are never masked (they address sessions and nodes); links that would carry a path or a project id carry it
 * masked, and the page that receives it compares with sameMaskedValue.
 */
import {
  createMasker, maskPlaceholder, MASK_FAILED_TEXT, type AnomalyListResponse, type ContentHit, type Diagnostics, type Graph, type GraphNode, type Masker,
  type MaskCategory, type NodeDetail, type Project, type ProjectFilesResponse, type Session, type SessionAnomaliesResponse,
  type SessionFilesResponse, type StatsResponse,
} from '@agent-canvas/shared';
import { projectTitle } from './home';
import type { SessionSource, StepDetail } from './sessionSource';

/** localStorage key of the switch: '1' on, anything else (or nothing) off. */
export const MASK_SWITCH_KEY = 'agent-canvas:mask';
export const parseMaskSwitch = (stored: string | null): boolean => stored === '1';
export const serializeMaskSwitch = (on: boolean): string => (on ? '1' : '0');

/** The page masks credentials, assignments and custom terms; personal information is left alone (spec 3.1). */
export const PAGE_MASK_CATEGORIES: readonly MaskCategory[] = ['credential', 'assignment', 'custom'];

/**
 * What the pages call. When the switch is off every function is the identity (same string, same object).
 * - text: a whole text (a path, a detail field, a branch name).
 * - cut: a text that was cut short (a summary, a title, a snippet's end): a secret cut at the end is masked too.
 * - value: a structured value (a step's input / output / raw record), masked string by string with the masker's
 *   key-name rules — never stringified first.
 */
export interface PageMasker {
  readonly on: boolean;
  text(text: string): string;
  cut(text: string): string;
  value(value: unknown): unknown;
  /**
   * First pass (the shared masker's learn / learnValue): remember the secret values found in a text / value, so that
   * later masking also masks their other literal occurrences. Masked texts remembered before are forgotten when
   * something new was learned (they are masked again when next asked for).
   */
  learn(text: string, cut: boolean): void;
  learnValue(value: unknown): void;
}

export const IDENTITY_MASKER: PageMasker = {
  on: false, text: (t) => t, cut: (t) => t, value: (v) => v, learn: () => {}, learnValue: () => {},
};

/** Texts up to this many characters are remembered per masker (summaries, titles, paths); longer ones are details, masked once when loaded. */
const CACHE_MAX_CHARS = 4096;
/** Remembered texts per masker before the cache is emptied (bounds memory on a huge session). */
const CACHE_MAX_ENTRIES = 100_000;

type MaskerLike = Pick<Masker, 'mask' | 'maskValue'> & Partial<Pick<Masker, 'learn' | 'learnValue' | 'learnedCount'>>;

const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * A cut text whose content (before a trailing `…` / `...`) ends in the first characters of a custom term — the term was
 * cut: that tail is replaced by the custom-term placeholder (the shared masker's truncated mode covers credentials and
 * assignments only). At least 3 characters of the term must be left for this to apply.
 */
export function maskCutTermTail(masked: string, terms: readonly string[]): string {
  if (terms.length === 0) return masked;
  const tail = masked.endsWith('…') ? '…' : masked.endsWith('...') ? '...' : '';
  const body = masked.slice(0, masked.length - tail.length);
  const low = asciiLower(body);
  let best = 0;
  for (const t of terms) {
    const term = asciiLower(t);
    for (let n = Math.min(term.length - 1, low.length); n >= 3 && n > best; n--) {
      if (low.endsWith(term.slice(0, n))) { best = n; break; }
    }
  }
  return best === 0 ? masked : `${body.slice(0, body.length - best)}${maskPlaceholder('custom', null)}${tail}`;
}

/** The one place a cut text is masked: the shared masker's truncated mode, then a cut custom term at the end. */
function maskTruncated(m: MaskerLike, text: string, terms: readonly string[]): string {
  return maskCutTermTail(m.mask(text, { truncated: true }), terms);
}

/**
 * A page masker over one shared masker. `numbered`: the session page (one masker per session, placeholders numbered
 * per value); false: the cross-session lists (`‹已遮蔽·<类型>›`). Texts are remembered per (text, kind) and values per
 * object, so a re-render does not mask again. If the masker cannot be created, everything is replaced (fail closed).
 */
export function createPageMasker(o: {
  customTerms: readonly string[]; numbered: boolean; create?: (options: Parameters<typeof createMasker>[0]) => MaskerLike;
}): PageMasker {
  let m: MaskerLike;
  try {
    m = (o.create ?? createMasker)({ categories: [...PAGE_MASK_CATEGORIES], customTerms: [...o.customTerms], numbered: o.numbered });
  } catch {
    const failed = (t: string): string => (t === '' ? '' : MASK_FAILED_TEXT);
    return {
      on: true, text: failed, cut: failed, value: (v) => (v === null || v === undefined ? v : MASK_FAILED_TEXT),
      learn: () => {}, learnValue: () => {},
    };
  }
  const terms = o.customTerms.filter((t) => typeof t === 'string' && t.trim().length >= 3).map((t) => t.trim());
  const texts = new Map<string, string>();
  const cuts = new Map<string, string>();
  let values = new WeakMap<object, unknown>();
  /** After learning something new, earlier results may miss it: forget them. */
  const afterLearning = (before: number): void => {
    if (m.learnedCount === undefined || m.learnedCount() === before) return;
    texts.clear();
    cuts.clear();
    values = new WeakMap();
  };
  const learnedNow = (): number => (m.learnedCount === undefined ? 0 : m.learnedCount());
  const remembered = (cache: Map<string, string>, t: string, run: (t: string) => string): string => {
    if (t === '') return t;
    if (t.length > CACHE_MAX_CHARS) return run(t);
    const hit = cache.get(t);
    if (hit !== undefined) return hit;
    const out = run(t);
    if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
    cache.set(t, out);
    return out;
  };
  const text = (t: string): string => (typeof t === 'string' ? remembered(texts, t, (x) => m.mask(x)) : t);
  const cut = (t: string): string => (typeof t === 'string' ? remembered(cuts, t, (x) => maskTruncated(m, x, terms)) : t);
  const value = (v: unknown): unknown => {
    if (typeof v === 'string') return text(v);
    if (v === null || typeof v !== 'object') return v;
    if (values.has(v)) return values.get(v);
    const out = m.maskValue(v);
    values.set(v, out);
    return out;
  };
  const learn = (t: string, isCut: boolean): void => {
    if (typeof t !== 'string' || t === '' || m.learn === undefined) return;
    const before = learnedNow();
    try { m.learn(t, isCut ? { truncated: true } : undefined); } catch { /* masking still applies the rules */ }
    afterLearning(before);
  };
  const learnValue = (v: unknown): void => {
    if (v === null || v === undefined || m.learnValue === undefined) return;
    const before = learnedNow();
    try { m.learnValue(v); } catch { /* masking still applies the rules */ }
    afterLearning(before);
  };
  return { on: true, text, cut, value, learn, learnValue };
}

// ---- placeholders in addresses ----

const PLACEHOLDER_NUMBER = /(‹已遮蔽·[^‹›#]*)#\d+›/g;

/** A masked text with the placeholders' numbers removed (a numbered and an unnumbered masking of one value compare equal). */
export function stripPlaceholderNumbers(text: string): string {
  return text.replace(PLACEHOLDER_NUMBER, '$1›');
}

/** Whether two masked texts are the same value, whatever numbering each masker used. */
export function sameMaskedValue(a: string, b: string): boolean {
  return a === b || stripPlaceholderNumbers(a) === stripPlaceholderNumbers(b);
}

/**
 * The id an address names, among `ids`: the id itself, or (with the switch on) the id whose masked form it is — a link
 * shown with the switch on carries the id masked (a project id is the encoded working directory). Unknown: unchanged.
 */
export function resolveMaskedId(value: string | null, ids: readonly string[], m: PageMasker): string | null {
  if (value === null || ids.includes(value) || !value.includes('‹已遮蔽·')) return value;
  return ids.find((id) => sameMaskedValue(m.text(id), value)) ?? value;
}

/** An id as a link carries it: masked while the switch is on. */
export const linkId = (id: string, m: PageMasker): string => (m.on ? m.text(id) : id);

// ---- the session page ----

const maybe = (s: string | null, f: (t: string) => string): string | null => (s === null ? null : f(s));

/** A session's text fields (title cut, cwd, branch); ids, the project id included, unchanged. */
export function maskSessionFields(s: Session, m: PageMasker): Session {
  if (!m.on) return s;
  return { ...s, title: maybe(s.title, m.cut), cwd: maybe(s.cwd, m.text), gitBranch: maybe(s.gitBranch, m.text) };
}

/** A node's text fields: title and summary (both may be cut), tool name, file paths. Ids and enums unchanged. */
export function maskNode(n: GraphNode, m: PageMasker): GraphNode {
  if (!m.on) return n;
  const out: GraphNode = { ...n, title: m.cut(n.title), summary: m.cut(n.summary), toolName: maybe(n.toolName, m.text) };
  if (n.files !== undefined) out.files = n.files.map((f) => ({ ...f, path: m.text(f.path) }));
  return out;
}

/** A step's detail: input, output and raw record as structured values, text as text. */
export function maskDetail(d: NodeDetail, m: PageMasker): NodeDetail {
  if (!m.on) return d;
  return { ...d, input: m.value(d.input), output: m.value(d.output), text: maybe(d.text, m.text), raw: m.value(d.raw) };
}

export function maskSessionFiles(r: SessionFilesResponse, m: PageMasker): SessionFilesResponse {
  if (!m.on) return r;
  return {
    ...r,
    cwd: maybe(r.cwd, m.text),
    files: r.files.map((f) => ({
      ...f, path: m.text(f.path), relativePath: m.text(f.relativePath),
      touches: f.touches.map((t) => ({ ...t, toolName: maybe(t.toolName, m.text) })),
    })),
  };
}

export function maskSessionAnomalies(r: SessionAnomaliesResponse, m: PageMasker): SessionAnomaliesResponse {
  if (!m.on) return r;
  return {
    ...r,
    anomalies: r.anomalies.map((a) => ({
      ...a,
      ...(a.path !== undefined ? { path: m.text(a.path) } : {}),
      ...(a.toolName !== undefined ? { toolName: maybe(a.toolName, m.text) } : {}),
    })),
  };
}

/**
 * The session page's source with every text masked (`m` is the session's numbered masker); the source itself when the
 * switch is off. The graph is masked node by node and remembered per node object, so an update re-masks only the
 * nodes it changed and unchanged nodes keep their identity (the canvas memoizes on it). A detail is masked once when
 * it is loaded. The files and anomalies loaders are created once (the panels refetch when the function changes).
 */
export function createMaskedSource(source: SessionSource, m: PageMasker): SessionSource {
  if (!m.on) return source;
  const nodes = new WeakMap<GraphNode, GraphNode>();
  let rawGraph: Graph | null = null;
  let maskedGraph: Graph | null = null;
  let rawSession: Session | null = null;
  let maskedSession: Session | null = null;
  const details = new WeakMap<NodeDetail, NodeDetail>();
  const files = source.files;
  const anomalies = source.anomalies;
  return {
    getSession() {
      const s = source.getSession();
      if (s !== rawSession || maskedSession === null) {
        rawSession = s;
        // The project id is the encoded working directory; on this page it only feeds the link back to the project.
        maskedSession = { ...maskSessionFields(s, m), projectId: m.text(s.projectId) };
      }
      return maskedSession;
    },
    getGraph() {
      const g = source.getGraph();
      if (g === rawGraph && maskedGraph !== null) return maskedGraph;
      // Two passes over the nodes not masked yet: learn the secret values in their texts, then mask, so a value found
      // in one summary is masked in the others too.
      const fresh = Object.values(g.nodes).filter((n) => !nodes.has(n));
      for (const n of fresh) {
        m.learn(n.summary, true);
        m.learn(n.title, true);
      }
      const entries: [string, GraphNode][] = [];
      for (const [id, n] of Object.entries(g.nodes)) {
        let out = nodes.get(n);
        if (out === undefined) nodes.set(n, (out = maskNode(n, m)));
        entries.push([id, out]);
      }
      rawGraph = g;
      maskedGraph = { nodes: Object.fromEntries(entries), edges: g.edges };
      return maskedGraph;
    },
    subscribe: source.subscribe,
    live: source.live,
    nodeDetail: (nodeId) => source.nodeDetail(nodeId).then((step): StepDetail => {
      const d = step.detail;
      if (d === null) return step;
      let out = details.get(d);
      if (out === undefined) {
        // Learn the detail's values first, so a secret found in one field is masked in the others.
        m.learnValue(d.input);
        m.learnValue(d.output);
        if (d.text !== null) m.learn(d.text, false);
        m.learnValue(d.raw);
        details.set(d, (out = maskDetail(d, m)));
      }
      return { ...step, detail: out };
    }),
    files: files === null ? null : () => files().then((r) => maskSessionFiles(r, m)),
    anomalies: anomalies === null ? null : () => anomalies().then((r) => maskSessionAnomalies(r, m)),
    createLayoutClient: () => source.createLayoutClient(),
  };
}

// ---- cross-session pages ----

/** A project as the lists show it: cwd masked, plus its display name and path (masked); the id stays for links and filters. */
export interface ShownProject extends Project { title: string; displayPath: string }

export function maskProject(p: Project, m: PageMasker): ShownProject {
  const cwd = maybe(p.cwd, m.text);
  const title = projectTitle(p);
  return { ...p, cwd, title: m.on ? m.text(title) : title, displayPath: cwd ?? m.text(p.id) };
}

/** The files page's answer; each file keeps its original path as `rawPath` (the list's keys and the expansion state). */
export type ShownProjectFiles = Omit<ProjectFilesResponse, 'files'> & { files: (ProjectFilesResponse['files'][number] & { rawPath: string })[] };

export function maskProjectFiles(r: ProjectFilesResponse, m: PageMasker): ShownProjectFiles {
  return {
    ...r,
    projectName: m.text(r.projectName),
    projectDir: maybe(r.projectDir, m.text),
    files: r.files.map((f) => ({
      ...f, rawPath: f.path, path: m.text(f.path), relativePath: m.text(f.relativePath),
      sessions: m.on ? f.sessions.map((s) => ({ ...s, title: maybe(s.title, m.cut) })) : f.sessions,
    })),
  };
}

export function maskStats<T extends Pick<StatsResponse, 'byProject' | 'byTool' | 'slowest' | 'mostFailing'>>(r: T, m: PageMasker): T {
  if (!m.on) return r;
  return {
    ...r,
    byProject: r.byProject.map((p) => ({ ...p, name: m.text(p.name) })),
    byTool: r.byTool.map((t) => ({ ...t, toolName: m.text(t.toolName) })),
    slowest: r.slowest.map((c) => ({ ...c, toolName: m.text(c.toolName) })),
    mostFailing: r.mostFailing.map((t) => ({ ...t, toolName: m.text(t.toolName) })),
  };
}

export function maskAnomalyList(r: AnomalyListResponse, m: PageMasker): AnomalyListResponse {
  if (!m.on) return r;
  return {
    ...r,
    items: r.items.map((a) => ({
      ...a,
      sessionTitle: maybe(a.sessionTitle, m.cut),
      ...(a.path !== undefined ? { path: m.text(a.path) } : {}),
      ...(a.toolName !== undefined ? { toolName: maybe(a.toolName, m.text) } : {}),
    })),
  };
}

/** Diagnostics: unknown-record samples (conversation text), file keys, errors and configured paths. */
export function maskDiagnostics(d: Diagnostics, m: PageMasker): Diagnostics {
  if (!m.on) return d;
  const t = (s: string | null): string | null => maybe(s, m.text);
  return {
    ...d,
    unknownRecords: d.unknownRecords.map((r) => ({ ...r, recordType: m.text(r.recordType), sample: m.cut(r.sample) })),
    files: d.files.map((f) => ({ ...f, path: m.text(f.path) })),
    ingestFailures: d.ingestFailures.map((f) => ({ ...f, file: m.text(f.file), error: m.cut(f.error) })),
    codex: { ...d.codex, sessionsDir: t(d.codex.sessionsDir) },
    cursor: { ...d.cursor, dbPath: t(d.cursor.dbPath), lastError: t(d.cursor.lastError) },
    ...(d.notifications !== undefined
      ? { notifications: { ...d.notifications, lastError: t(d.notifications.lastError), settingsError: t(d.notifications.settingsError) } }
      : {}),
    ...(d.storage !== undefined
      ? { storage: { ...d.storage, lastError: t(d.storage.lastError), vacuumSkipReason: t(d.storage.vacuumSkipReason) } }
      : {}),
    ...(d.search !== undefined ? { search: { ...d.search, lastError: t(d.search.lastError) } } : {}),
  };
}

// ---- search snippets ----

export interface SnippetPart { text: string; match: boolean }

const PLACEHOLDER = /‹已遮蔽·[^‹›]*›/g;

/** Splits `text` into parts by the (sorted, non-overlapping) ranges; offset: where `text` starts in the original. */
function splitByRanges(text: string, offset: number, ranges: readonly (readonly [number, number])[], out: SnippetPart[]): void {
  let at = 0;
  for (const [s, e] of ranges) {
    const a = Math.max(0, s - offset);
    const b = Math.min(text.length, e - offset);
    if (b <= a) continue;
    if (a > at) push(out, text.slice(at, a), false);
    push(out, text.slice(a, b), true);
    at = b;
  }
  if (at < text.length) push(out, text.slice(at), false);
}

function push(out: SnippetPart[], text: string, match: boolean): void {
  if (text === '') return;
  const last = out[out.length - 1];
  if (last !== undefined && last.match === match) last.text += text;
  else out.push({ text, match });
}

/**
 * The text masked as one string, split into parts with the ranges (positions in the original `text`) marked: a range
 * that falls inside a masked span marks the placeholder. The parts always join to the masked text, never to the
 * original. `cut`: the text was cut at its end. When the masked text cannot be aligned with the original (e.g. the
 * original contains placeholder-like text) it is returned as one unmarked part.
 */
export function maskedHighlight(m: PageMasker, text: string, ranges: readonly (readonly [number, number])[], cut: boolean): SnippetPart[] {
  const sorted = [...ranges].filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const masked = m.on ? (cut ? m.cut(text) : m.text(text)) : text;
  const out: SnippetPart[] = [];
  if (masked === text) {
    splitByRanges(text, 0, sorted, out);
    return out;
  }
  // Tokens of the masked text: placeholders and the literal text between them (which is original text, in order).
  const tokens: { text: string; placeholder: boolean }[] = [];
  let last = 0;
  for (const mt of masked.matchAll(PLACEHOLDER)) {
    if (mt.index > last) tokens.push({ text: masked.slice(last, mt.index), placeholder: false });
    tokens.push({ text: mt[0], placeholder: true });
    last = mt.index + mt[0].length;
  }
  if (last < masked.length) tokens.push({ text: masked.slice(last), placeholder: false });
  // Original start of each token.
  const starts: number[] = [];
  let pos = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i]!;
    if (tk.placeholder) { starts.push(pos); continue; }
    let at: number;
    if (i === 0) at = text.startsWith(tk.text) ? 0 : -1;
    else if (i === tokens.length - 1) at = text.length - tk.text.length >= pos + 1 && text.endsWith(tk.text) ? text.length - tk.text.length : -1;
    else at = text.indexOf(tk.text, pos + 1);
    if (at < 0) return masked === '' ? [] : [{ text: masked, match: false }];
    if (i > 0 && tokens[i - 1]!.placeholder && at <= starts[i - 1]!) return [{ text: masked, match: false }];
    starts.push(at);
    pos = at + tk.text.length;
  }
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i]!;
    const s = starts[i]!;
    if (tk.placeholder) {
      const e = i + 1 < tokens.length ? starts[i + 1]! : text.length;
      push(out, tk.text, sorted.some(([a, b]) => a < e && b > s));
    } else {
      splitByRanges(tk.text, s, sorted, out);
    }
  }
  return out;
}

/** Characters of a token that may be the tail of a secret (base64, hex, key characters). */
const TOKEN_CHAR = /[A-Za-z0-9_\-+/=]/;

const leadingRun = (s: string): number => {
  let i = 0;
  while (i < s.length && TOKEN_CHAR.test(s[i]!)) i++;
  return i;
};

/**
 * A content-search snippet as parts, masked (spec 5): before + match + after masked as one string, the match marked
 * (on the placeholder when it falls inside a masked span), the server's clipped ends shown as `…`. With the switch on
 * and the start clipped, the token the snippet starts in is dropped (it may be the tail of a secret whose recognisable
 * start was cut off); when that token runs on into the match, the match stays (the reader typed it) and the token's
 * continuation after it is dropped too.
 */
export function maskContentSnippet(m: PageMasker, snippet: ContentHit['snippet']): SnippetPart[] {
  let { before, after } = snippet;
  const { match } = snippet;
  let dropAfter = false;
  if (m.on && snippet.clippedStart) {
    const run = leadingRun(before);
    if (run === before.length && leadingRun(match) === match.length && match !== '') {
      before = '';
      dropAfter = true;
    } else {
      before = before.slice(run);
    }
  }
  if (dropAfter) {
    const run = leadingRun(after);
    if (run > 0) after = `…${after.slice(run)}`;
  }
  const text = before + match + after;
  const parts = maskedHighlight(m, text, [[before.length, before.length + match.length]], snippet.clippedEnd);
  const out: SnippetPart[] = [];
  if (snippet.clippedStart) push(out, '…', false);
  for (const p of parts) push(out, p.text, p.match);
  if (snippet.clippedEnd) push(out, '…', false);
  return out;
}
