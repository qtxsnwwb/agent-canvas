/**
 * The page's masking switch (spec 5): what the header's 遮蔽 switch applies to the text the pages show. Pure (only the
 * shared masker); the React side is MaskContext.tsx.
 *
 * Where it is applied (one place per kind of data, so no surface is missed):
 * - the session page: createDisplaySource wraps the session's SessionSource, so the canvas, the waterfall, the drawer
 *   (input / output / text / raw record), the file panel, the anomaly panel and the replay all render masked data; the
 *   masker is swapped in place (switch, custom terms) without rebuilding the canvas. The same wrapper, with the identity
 *   masker, makes the exported viewer show bidi controls as visible markers (bidi.ts).
 * - the cross-session pages: each page masks the API answer it received with the functions below before rendering it
 *   (maskSessionFields, maskProject, maskProjectFiles, maskStats, maskAnomalyList, maskDiagnostics). Search snippets are
 *   masked by the server (`mask=1`) and rendered as they come (search.ts).
 * Ids are never masked (they address sessions and nodes); links that would carry a path or a project id carry it
 * masked, and the page that receives it compares with sameMaskedValue.
 */
import {
  createMasker, FILE_ONLY_ORIGINS, isCutSummary, isCutTitle, MASK_FAILED_TEXT, type AnomalyListResponse, type Diagnostics, type Graph, type GraphNode,
  type LearnedValue, type Masker, type MaskCategory, type NodeDetail, type Project, type ProjectFilesResponse, type Session,
  type FileOnlyOrigin, type FileSourceStatus, type SessionAnomaliesResponse, type SessionFilesResponse, type StatsResponse,
} from '@agent-canvas/shared';
import { neutralizeBidi, neutralizeBidiValue } from './bidi';
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
 * - text: a whole text (a path, a detail field, a branch name, a tool name).
 * - title: a session or node title — the shared masker's truncated mode exactly when the shared isCutTitle says it was
 *   cut (60 code points, or an ellipsis at the end).
 * - summary: a node summary or another capped text — truncated mode when isCutSummary says it was cut.
 * - value: a structured value (a step's input / output / raw record), masked string by string with the masker's
 *   key-name rules — never stringified first.
 * - learn / learnValue / adopt: the shared masker's first pass (which values count is the masker's rule); `adopt` takes
 *   the values the server learned from the whole session (POST /api/sessions/:id/mask/learned). Masked texts remembered
 *   before are forgotten when something new was learned. Values live in memory only.
 */
export interface PageMasker {
  readonly on: boolean;
  text(text: string): string;
  title(text: string): string;
  summary(text: string): string;
  value(value: unknown): unknown;
  learn(text: string, kind?: 'title' | 'summary'): void;
  learnValue(value: unknown): void;
  adopt(values: readonly LearnedValue[]): void;
  /** How many values have been learned (changes when learning found something new). */
  learnedCount(): number;
}

const noop = (): void => {};
export const IDENTITY_MASKER: PageMasker = {
  on: false, text: (t) => t, title: (t) => t, summary: (t) => t, value: (v) => v, learn: noop, learnValue: noop, adopt: noop,
  learnedCount: () => 0,
};

/** Texts up to this many characters are remembered per masker (summaries, titles, paths); longer ones are details, masked once when loaded. */
const CACHE_MAX_CHARS = 4096;
/** Remembered texts per masker before the cache is emptied (bounds memory on a huge session). */
const CACHE_MAX_ENTRIES = 100_000;

type MaskerLike = Pick<Masker, 'mask' | 'maskValue'> & Partial<Pick<Masker, 'learn' | 'learnValue' | 'learnedCount' | 'adopt'>>;

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
      on: true, text: failed, title: failed, summary: failed, value: (v) => (v === null || v === undefined ? v : MASK_FAILED_TEXT),
      learn: noop, learnValue: noop, adopt: noop, learnedCount: () => 0,
    };
  }
  const texts = new Map<string, string>();
  const cuts = new Map<string, string>();
  let values = new WeakMap<object, unknown>();
  const forget = (): void => {
    texts.clear();
    cuts.clear();
    values = new WeakMap();
  };
  const learnedNow = (): number => (m.learnedCount === undefined ? 0 : m.learnedCount());
  /** After learning something new, earlier results may miss it: forget them. */
  const afterLearning = (before: number): void => {
    if (learnedNow() !== before) forget();
  };
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
  // The one place truncated mode is chosen: by the shared predicate for the kind of field.
  const truncated = (t: string): string => remembered(cuts, t, (x) => m.mask(x, { truncated: true }));
  const title = (t: string): string => (typeof t === 'string' && isCutTitle(t) ? truncated(t) : text(t));
  const summary = (t: string): string => (typeof t === 'string' && isCutSummary(t) ? truncated(t) : text(t));
  const value = (v: unknown): unknown => {
    if (typeof v === 'string') return text(v);
    if (v === null || typeof v !== 'object') return v;
    if (values.has(v)) return values.get(v);
    const out = m.maskValue(v);
    values.set(v, out);
    return out;
  };
  const learn = (t: string, kind?: 'title' | 'summary'): void => {
    if (typeof t !== 'string' || t === '' || m.learn === undefined) return;
    const cut = kind === 'title' ? isCutTitle(t) : kind === 'summary' ? isCutSummary(t) : false;
    const before = learnedNow();
    try { m.learn(t, cut ? { truncated: true } : undefined); } catch { /* masking still applies the rules */ }
    afterLearning(before);
  };
  const learnValue = (v: unknown): void => {
    if (v === null || v === undefined || m.learnValue === undefined) return;
    const before = learnedNow();
    try { m.learnValue(v); } catch { /* masking still applies the rules */ }
    afterLearning(before);
  };
  const adopt = (vals: readonly LearnedValue[]): void => {
    if (m.adopt === undefined || vals.length === 0) return;
    try { m.adopt(vals); } catch { /* masking still applies the rules */ }
    forget();
  };
  return { on: true, text, title, summary, value, learn, learnValue, adopt, learnedCount: learnedNow };
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

/**
 * The `value` of a project's `<option>`: the id, or while the switch is on an opaque key (its position in the list,
 * `p<n>`) — a value attribute is in the DOM, and a project id is the encoded working directory. '' stays ''.
 */
export function projectOptionValue(id: string | null, ids: readonly string[], m: PageMasker): string {
  if (id === null || id === '') return '';
  if (!m.on) return id;
  const i = ids.indexOf(id);
  return i < 0 ? 'p?' : `p${i}`;
}

/** The project id an option's value stands for (projectOptionValue's inverse); null for '' (all projects). */
export function projectFromOptionValue(value: string, ids: readonly string[], m: PageMasker): string | null {
  if (value === '') return null;
  if (!m.on) return value;
  const n = /^p(\d+)$/.exec(value);
  return n === null ? null : ids[Number(n[1])] ?? null;
}

/** An id as a link carries it: masked while the switch is on. */
export const linkId = (id: string, m: PageMasker): string => (m.on ? m.text(id) : id);

// ---- the session page ----

const maybe = (s: string | null, f: (t: string) => string): string | null => (s === null ? null : f(s));

/** A session's text fields (title by isCutTitle, cwd, branch); ids, the project id included, unchanged. */
export function maskSessionFields(s: Session, m: PageMasker): Session {
  if (!m.on) return s;
  return { ...s, title: maybe(s.title, m.title), cwd: maybe(s.cwd, m.text), gitBranch: maybe(s.gitBranch, m.text) };
}

/** A node's text fields: title (isCutTitle), summary (isCutSummary), tool name, file paths. Ids and enums unchanged. */
export function maskNode(n: GraphNode, m: PageMasker): GraphNode {
  if (!m.on) return n;
  const out: GraphNode = { ...n, title: m.title(n.title), summary: m.summary(n.summary), toolName: maybe(n.toolName, m.text) };
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

const bidi = (s: string | null): string | null => (s === null ? null : neutralizeBidi(s));

/** A node as shown: bidi controls in its texts made visible (the same object when there is none). */
export function bidiNode(n: GraphNode): GraphNode {
  const title = neutralizeBidi(n.title);
  const summary = neutralizeBidi(n.summary);
  const toolName = bidi(n.toolName);
  let files = n.files;
  if (files !== undefined && files.some((f) => neutralizeBidi(f.path) !== f.path)) {
    files = files.map((f) => ({ ...f, path: neutralizeBidi(f.path) }));
  }
  if (title === n.title && summary === n.summary && toolName === n.toolName && files === n.files) return n;
  const out: GraphNode = { ...n, title, summary, toolName };
  if (files !== undefined) out.files = files;
  return out;
}

function bidiDetail(d: NodeDetail): NodeDetail {
  const input = neutralizeBidiValue(d.input);
  const output = neutralizeBidiValue(d.output);
  const raw = neutralizeBidiValue(d.raw);
  const text = bidi(d.text);
  return input === d.input && output === d.output && raw === d.raw && text === d.text ? d : { ...d, input, output, raw, text };
}

function bidiSession(s: Session): Session {
  const title = bidi(s.title);
  const cwd = bidi(s.cwd);
  const gitBranch = bidi(s.gitBranch);
  return title === s.title && cwd === s.cwd && gitBranch === s.gitBranch ? s : { ...s, title, cwd, gitBranch };
}

/** The session page's source plus what the app does to it. */
export interface DisplaySource extends SessionSource {
  /** Use another masker (switch, custom terms): everything is masked again and subscribers are told; nothing is rebuilt. */
  setMasker(m: PageMasker): void;
  /** The masker learned values from outside (adopt): mask everything again once and tell subscribers. */
  refresh(): void;
}

/**
 * The session page's source as the page shows it: every text masked with the current masker (identity when the switch
 * is off) and bidi controls made visible. The graph is masked node by node and remembered per node object, so an update
 * re-masks only the nodes it changed and unchanged nodes keep their identity (the canvas memoizes on it). Node texts are
 * learned before they are masked; a detail is learned and masked once when it is loaded, and when that taught the masker
 * something new, the session and every node are masked again once and subscribers are told. Its functions are stable for
 * its lifetime (the panels refetch when a function changes); changing the masker keeps them, so toggling the switch keeps
 * the canvas, its view and the open drawer.
 */
export function createDisplaySource(source: SessionSource, initial: PageMasker): DisplaySource {
  let m = initial;
  let nodes = new WeakMap<GraphNode, GraphNode>();
  let rawGraph: Graph | null = null;
  let shownGraph: Graph | null = null;
  let rawSession: Session | null = null;
  let shownSession: Session | null = null;
  /** learnedCount() when the shown node texts were made; when it moved, they are masked again (once). */
  let maskedWith = -1;
  /** Nodes whose texts the current masker learned (once per node object). */
  let learnedNodes = new WeakSet<GraphNode>();
  let details = new WeakMap<NodeDetail, NodeDetail>();
  const listeners = new Set<() => void>();
  const files = source.files;
  const anomalies = source.anomalies;
  const notify = (): void => { for (const fn of [...listeners]) fn(); };
  const reset = (): void => {
    nodes = new WeakMap();
    shownGraph = null;
    shownSession = null;
    details = new WeakMap();
  };
  /** Something new was learned since the node texts were masked: they are masked again on the next read. */
  const relearned = (): boolean => {
    if (m.learnedCount() === maskedWith) return false;
    reset();
    return true;
  };
  const getGraph = (): Graph => {
    const g = source.getGraph();
    if (g === rawGraph && shownGraph !== null && m.learnedCount() === maskedWith) return shownGraph;
    // Two passes over the nodes not learned yet: learn the secret values in their texts, then mask, so a value found in
    // one summary is masked in the others too.
    if (m.on) {
      for (const n of Object.values(g.nodes)) {
        if (learnedNodes.has(n)) continue;
        learnedNodes.add(n);
        m.learn(n.summary, 'summary');
        m.learn(n.title, 'title');
      }
    }
    relearned();
    maskedWith = m.learnedCount();
    const entries: [string, GraphNode][] = [];
    for (const [id, n] of Object.entries(g.nodes)) {
      let out = nodes.get(n);
      if (out === undefined) nodes.set(n, (out = bidiNode(maskNode(n, m))));
      entries.push([id, out]);
    }
    rawGraph = g;
    shownGraph = { nodes: Object.fromEntries(entries), edges: g.edges };
    return shownGraph;
  };
  return {
    getSession() {
      const s = source.getSession();
      if (s !== rawSession || shownSession === null) {
        rawSession = s;
        // The project id is the encoded working directory; on this page it only feeds the link back to the project.
        const masked = maskSessionFields(s, m);
        shownSession = bidiSession(m.on ? { ...masked, projectId: m.text(s.projectId) } : masked);
      }
      return shownSession;
    },
    getGraph,
    subscribe(fn) {
      listeners.add(fn);
      const off = source.subscribe(fn);
      return () => { listeners.delete(fn); off(); };
    },
    live: source.live,
    nodeDetail: (nodeId) => source.nodeDetail(nodeId).then((step): StepDetail => {
      const d = step.detail;
      if (d === null) return step;
      let out = details.get(d);
      if (out === undefined) {
        // Learn the detail's values first, so a secret found in one field is masked in the others; a value learned here
        // that the cards already show is masked there too (masked again once, subscribers told).
        if (m.on) {
          m.learnValue(d.input);
          m.learnValue(d.output);
          if (d.text !== null) m.learn(d.text);
          m.learnValue(d.raw);
        }
        out = bidiDetail(maskDetail(d, m));
        const again = maskedWith >= 0 && relearned();
        details.set(d, out);
        if (again) notify();
      }
      return { ...step, detail: out };
    }),
    files: files === null ? null : () => files().then((r) => {
      const masked = maskSessionFiles(r, m);
      return {
        ...masked, cwd: bidi(masked.cwd),
        files: masked.files.map((f) => ({ ...f, path: neutralizeBidi(f.path), relativePath: neutralizeBidi(f.relativePath) })),
      };
    }),
    anomalies: anomalies === null ? null : () => anomalies().then((r) => maskSessionAnomalies(r, m)),
    createLayoutClient: () => source.createLayoutClient(),
    setMasker(next) {
      if (next === m) return;
      m = next;
      learnedNodes = new WeakSet();
      maskedWith = -1;
      reset();
      notify();
    },
    refresh() {
      maskedWith = -1;
      reset();
      notify();
    },
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
      sessions: m.on ? f.sessions.map((s) => ({ ...s, title: maybe(s.title, m.title) })) : f.sessions,
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
      sessionTitle: maybe(a.sessionTitle, m.title),
      ...(a.path !== undefined ? { path: m.text(a.path) } : {}),
      ...(a.toolName !== undefined ? { toolName: maybe(a.toolName, m.text) } : {}),
    })),
  };
}

/**
 * Diagnostics.sources: the directories (and every root of a source with several) and the reason a source cannot run.
 * Only the origins the server sent are kept (one from before an origin existed sends no entry for it).
 */
function maskFileSources(sources: Record<FileOnlyOrigin, FileSourceStatus>, m: PageMasker): Record<FileOnlyOrigin, FileSourceStatus> {
  const out: Partial<Record<FileOnlyOrigin, FileSourceStatus>> = {};
  for (const origin of FILE_ONLY_ORIGINS) {
    const s = sources[origin] as FileSourceStatus | undefined;
    if (s === undefined) continue;
    out[origin] = {
      ...s,
      dir: maybe(s.dir, m.text),
      ...(s.dirs !== undefined ? { dirs: s.dirs.map((d) => ({ ...d, dir: m.text(d.dir) })) } : {}),
      ...(s.unavailable !== undefined ? { unavailable: m.text(s.unavailable) } : {}),
    };
  }
  return out as Record<FileOnlyOrigin, FileSourceStatus>;
}

/** Diagnostics: unknown-record samples (conversation text), file keys, errors and configured paths. */
export function maskDiagnostics(d: Diagnostics, m: PageMasker): Diagnostics {
  if (!m.on) return d;
  const t = (s: string | null): string | null => maybe(s, m.text);
  return {
    ...d,
    unknownRecords: d.unknownRecords.map((r) => ({ ...r, recordType: m.text(r.recordType), sample: m.summary(r.sample) })),
    files: d.files.map((f) => ({ ...f, path: m.text(f.path) })),
    ingestFailures: d.ingestFailures.map((f) => ({ ...f, file: m.text(f.file), error: m.summary(f.error) })),
    codex: { ...d.codex, sessionsDir: t(d.codex.sessionsDir) },
    cursor: { ...d.cursor, dbPath: t(d.cursor.dbPath), lastError: t(d.cursor.lastError) },
    ...(d.notifications !== undefined
      ? { notifications: { ...d.notifications, lastError: t(d.notifications.lastError), settingsError: t(d.notifications.settingsError) } }
      : {}),
    ...(d.storage !== undefined
      ? { storage: { ...d.storage, lastError: t(d.storage.lastError), vacuumSkipReason: t(d.storage.vacuumSkipReason) } }
      : {}),
    ...(d.search !== undefined ? { search: { ...d.search, lastError: t(d.search.lastError) } } : {}),
    ...(d.sources !== undefined
      ? {
        sources: maskFileSources(d.sources, m),
      }
      : {}),
  };
}

