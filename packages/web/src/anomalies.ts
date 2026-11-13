/* Pure helpers for the anomaly views (spec 2026-11-13-anomalies-design.md, section 6): the home card marker, the
   session page's toolbar button, panel (canvas/AnomalyPanel.tsx) and card markers, and the anomalies page
   (pages/Anomalies.tsx). No React, no DOM. Kind names and basis lines come from the shared module only. */
import {
  ANOMALY_DEFAULT_RANGE, ANOMALY_KINDS, ANOMALY_LABELS, ANOMALY_LIST_MAX, ANOMALY_RANGES, ORIGINS, anomalyBasisText, groupTurns,
  relativeToDir,
  type Anomaly, type AnomalyKind, type AnomalyListItem, type AnomalyListResponse, type AnomalyRange, type AnomalySessionCount,
  type Graph, type GraphNode, type Origin, type Project,
} from '@agent-canvas/shared';
import { sessionNodeHash } from './route';
import { availableOrigins } from './stats';

/** The line at the top of the anomalies page (and under the session panel). */
export const ANOMALY_HEURISTIC_NOTE = '这些是按固定规则找出来的，可能有误报。';
/** The session panel when the session has none. */
export const ANOMALY_EMPTY_SESSION = '这个会话没有发现异常';
/** Shown while a response says `computing`. */
export const ANOMALY_COMPUTING_NOTE = '仍在计算，结果可能不全，稍后会自动刷新。';
/** While a response says `computing`, it is fetched again this often. */
export const ANOMALY_POLL_MS = 3_000;
/** After the session changes, its anomalies are fetched again this long after the last change. */
export const ANOMALY_REFRESH_MS = 2_000;

export const kindName = (kind: AnomalyKind): string => ANOMALY_LABELS[kind].name;

/** "原地打转 2 条、反复改同一个文件 1 条": the kinds in their fixed order, zero counts left out. */
export function kindCountsText(byKind: Partial<Record<AnomalyKind, number>>): string {
  return ANOMALY_KINDS.filter((k) => (byKind[k] ?? 0) > 0).map((k) => `${kindName(k)} ${byKind[k]} 条`).join('、');
}

// ---- home ----

/** The home card's marker: null while unknown or zero. `label` is its tooltip and accessible name. */
export function homeMarker(c: AnomalySessionCount | undefined): { total: number; label: string } | null {
  if (c === undefined || c.total <= 0) return null;
  return { total: c.total, label: `发现 ${c.total} 条异常：${kindCountsText(c.byKind)}` };
}

// ---- the session page ----

/** The toolbar button: “异常” with the count when there is one (null: not loaded yet). */
export function anomalyButton(anomalies: readonly Anomaly[] | null): { text: string; label: string } {
  if (anomalies === null) return { text: '异常', label: '异常' };
  if (anomalies.length === 0) return { text: '异常', label: '异常，没有发现' };
  return { text: `异常 ${anomalies.length}`, label: `异常，${anomalies.length} 条` };
}

/** A card's marker: how many anomalies, which kinds (fixed order), and the tooltip / accessible text. */
export interface CardMarker {
  count: number;
  kinds: AnomalyKind[];
  label: string;
}
/** Markers by main turn key (turn cards) and by agent id (the subagent card whose childAgentId it is). */
export interface CardMarks {
  turns: ReadonlyMap<string, CardMarker>;
  agents: ReadonlyMap<string, CardMarker>;
}
export const NO_CARD_MARKS: CardMarks = { turns: new Map(), agents: new Map() };

/** A dispatch node as the marks and the panel need it. */
export interface DispatchInfo {
  id: string;
  /** The thread it was dispatched from (null: the main thread). */
  agentId: string | null;
  title: string;
}
export interface AnomalyResolver {
  /** The node that dispatched agent `agentId` (the earliest one naming it). */
  dispatchOf(agentId: string): DispatchInfo | undefined;
  /** The main turn (groupTurns key) of a main-thread node; null for any other id. */
  mainTurnOf(nodeId: string): string | null;
}

/** The main turn an agent was dispatched in (followed up through nested agents); null when it cannot be found. */
export function dispatchingTurn(agentId: string, r: AnomalyResolver): string | null {
  const seen = new Set<string>();
  let id: string | null = agentId;
  while (id !== null && !seen.has(id)) {
    seen.add(id);
    const d = r.dispatchOf(id);
    if (d === undefined) return null;
    if (d.agentId === null) return r.mainTurnOf(d.id);
    id = d.agentId;
  }
  return null;
}

function markerOf(list: readonly Anomaly[]): CardMarker {
  const byKind: Partial<Record<AnomalyKind, number>> = {};
  for (const a of list) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
  return {
    count: list.length,
    kinds: ANOMALY_KINDS.filter((k) => byKind[k] !== undefined),
    label: `${list.length} 条异常：${kindCountsText(byKind)}`,
  };
}

/**
 * Which cards get a marker: a main-thread anomaly marks its turn; one inside a subagent marks that subagent's card and
 * the main turn that (through any nesting) dispatched it.
 */
export function cardMarks(anomalies: readonly Anomaly[], r: AnomalyResolver): CardMarks {
  const turns = new Map<string, Anomaly[]>();
  const agents = new Map<string, Anomaly[]>();
  const add = (m: Map<string, Anomaly[]>, key: string, a: Anomaly): void => {
    const list = m.get(key);
    if (list) list.push(a); else m.set(key, [a]);
  };
  for (const a of anomalies) {
    if (a.agentId === null) {
      add(turns, a.turnKey, a);
      continue;
    }
    add(agents, a.agentId, a);
    const turn = dispatchingTurn(a.agentId, r);
    if (turn !== null) add(turns, turn, a);
  }
  const done = (m: Map<string, Anomaly[]>): Map<string, CardMarker> => new Map([...m].map(([k, v]) => [k, markerOf(v)]));
  return { turns: done(turns), agents: done(agents) };
}

/** A resolver over the session's graph. The main turns are computed once, on first use. */
export function graphResolver(graph: Graph): AnomalyResolver {
  let dispatch: Map<string, GraphNode> | null = null;
  let turnOf: Map<string, string> | null = null;
  const ms = (n: GraphNode): number => {
    const t = Date.parse(n.timestamp);
    return Number.isNaN(t) ? 0 : t;
  };
  return {
    dispatchOf(agentId) {
      if (dispatch === null) {
        dispatch = new Map();
        for (const n of Object.values(graph.nodes)) {
          if (n.kind !== 'subagent' || n.childAgentId === null) continue;
          const old = dispatch.get(n.childAgentId);
          if (old === undefined || ms(n) < ms(old) || (ms(n) === ms(old) && n.id < old.id)) dispatch.set(n.childAgentId, n);
        }
      }
      const d = dispatch.get(agentId);
      return d === undefined ? undefined : { id: d.id, agentId: d.agentId, title: d.title };
    },
    mainTurnOf(nodeId) {
      if (turnOf === null) {
        turnOf = new Map();
        for (const t of groupTurns(Object.values(graph.nodes))) for (const n of t.nodes) turnOf.set(n.id, t.key);
      }
      return turnOf.get(nodeId) ?? null;
    },
  };
}

/** A turn as the panel names it: its place in the session and the prompt summary its overview card shows. */
export function turnLabel(index: number, promptSummary: string): string {
  return `第 ${index + 1} 轮 · ${promptSummary || '（无提示）'}`;
}

/** A churn path: relative to `dir` when inside it (as the file panel shows paths), and in full. */
export interface ShownPath { shown: string; full: string }
const shownPath = (path: string | undefined, dir: string | null): ShownPath | null =>
  path === undefined ? null : { shown: relativeToDir(path, dir), full: path };

export interface PanelRow {
  key: string;
  kind: AnomalyKind;
  kindLabel: string;
  /** “第 2 轮 · <prompt>”; null when the turn is not (or no longer) known. */
  turnText: string | null;
  /** For an anomaly inside a subagent: “在子代理“<title>”里”, or “在子代理里” when it has no name. */
  agentText: string | null;
  basis: string;
  at: string;
  path: ShownPath | null;
  /** The node to jump to (the pattern's last) and its address. */
  nodeId: string;
  href: string;
}

export interface PanelContext {
  /** The main turns in order (the canvas view's turns). */
  turns: readonly { key: string; promptSummary: string }[];
  resolver: AnomalyResolver;
  /** The session's working directory. */
  cwd: string | null;
}

/** The panel's rows, in the server's order (by time). */
export function panelRows(sessionId: string, anomalies: readonly Anomaly[], ctx: PanelContext): PanelRow[] {
  const index = new Map(ctx.turns.map((t, i) => [t.key, i]));
  const labelOf = (key: string | null): string | null => {
    if (key === null) return null;
    const i = index.get(key);
    return i === undefined ? null : turnLabel(i, ctx.turns[i]!.promptSummary);
  };
  return anomalies.map((a) => {
    let turnText: string | null;
    let agentText: string | null = null;
    if (a.agentId === null) {
      turnText = labelOf(a.turnKey);
    } else {
      turnText = labelOf(dispatchingTurn(a.agentId, ctx.resolver));
      const title = ctx.resolver.dispatchOf(a.agentId)?.title.trim() ?? '';
      agentText = title === '' ? '在子代理里' : `在子代理“${title}”里`;
    }
    return {
      key: a.id, kind: a.kind, kindLabel: kindName(a.kind), turnText, agentText, basis: anomalyBasisText(a), at: a.at,
      path: a.kind === 'churn' ? shownPath(a.path, ctx.cwd) : null, nodeId: a.lastNodeId, href: sessionNodeHash(sessionId, a.lastNodeId),
    };
  });
}

// ---- the anomalies page ----

export type AnomaliesOriginFilter = 'all' | Origin;
export interface AnomaliesFilter {
  range: AnomalyRange;
  origin: AnomaliesOriginFilter;
  /** null = every project. */
  projectId: string | null;
  /** null = every kind. */
  kind: AnomalyKind | null;
}
export const DEFAULT_ANOMALIES_FILTER: AnomaliesFilter = { range: ANOMALY_DEFAULT_RANGE, origin: 'all', projectId: null, kind: null };

/** The filter from the address's query part (`#/anomalies?<query>`); anything unknown takes its default. */
export function parseAnomaliesQuery(query: string): AnomaliesFilter {
  let p: URLSearchParams;
  try {
    // URLSearchParams turns a malformed escape into U+FFFD instead of throwing; such a value is unknown anyway.
    p = new URLSearchParams(query);
  } catch {
    return { ...DEFAULT_ANOMALIES_FILTER };
  }
  const range = p.get('range');
  const origin = p.get('origin');
  const projectId = p.get('projectId');
  const kind = p.get('kind');
  return {
    range: (ANOMALY_RANGES as readonly (string | null)[]).includes(range) ? (range as AnomalyRange) : DEFAULT_ANOMALIES_FILTER.range,
    origin: (ORIGINS as readonly (string | null)[]).includes(origin) ? (origin as Origin) : 'all',
    projectId: projectId !== null && projectId !== '' ? projectId : null,
    kind: (ANOMALY_KINDS as readonly (string | null)[]).includes(kind) ? (kind as AnomalyKind) : null,
  };
}

const filterParams = (f: AnomaliesFilter, alwaysRange: boolean): string => {
  const enc = encodeURIComponent;
  const parts: string[] = [];
  if (alwaysRange || f.range !== DEFAULT_ANOMALIES_FILTER.range) parts.push(`range=${enc(f.range)}`);
  if (f.origin !== 'all') parts.push(`origin=${enc(f.origin)}`);
  if (f.projectId !== null) parts.push(`projectId=${enc(f.projectId)}`);
  if (f.kind !== null) parts.push(`kind=${enc(f.kind)}`);
  return parts.join('&');
};

/** The page's address for a filter: only what differs from the default is written. */
export function anomaliesHash(f: AnomaliesFilter): string {
  const q = filterParams(f, false);
  return q === '' ? '#/anomalies' : `#/anomalies?${q}`;
}

/** The `/api/anomalies` query: the range always, the rest only when filtered. */
export function anomaliesQueryString(f: AnomaliesFilter): string {
  return filterParams(f, true);
}

/**
 * The filter in force (the stats page's rule): an origin no project has (or any origin while only one exists, when the
 * switch is hidden) becomes 全部, a project that no longer exists becomes 全部项目. Before the project list has loaded
 * (null) the address is used as is. The kind is kept.
 */
export function effectiveAnomaliesFilter(f: AnomaliesFilter, projects: readonly Project[] | null): AnomaliesFilter {
  if (projects === null) return f;
  const origins = availableOrigins(projects);
  const origin = f.origin !== 'all' && origins.length > 1 && origins.includes(f.origin) ? f.origin : 'all';
  const projectId = f.projectId !== null && projects.some((p) => p.id === f.projectId) ? f.projectId : null;
  return { range: f.range, origin, projectId, kind: f.kind };
}

export interface KindChip {
  kind: AnomalyKind | null;
  label: string;
  /** From the response's totals (null before there is one). */
  count: number | null;
  pressed: boolean;
}

/** 全部 and the four kinds, with their totals (over range, origin and project; the kind filter left out). */
export function kindChips(totals: Record<AnomalyKind, number> | null, selected: AnomalyKind | null): KindChip[] {
  const all = totals === null ? null : ANOMALY_KINDS.reduce((s, k) => s + (totals[k] ?? 0), 0);
  return [
    { kind: null, label: '全部', count: all, pressed: selected === null },
    ...ANOMALY_KINDS.map((k) => ({ kind: k, label: kindName(k), count: totals === null ? null : totals[k] ?? 0, pressed: selected === k })),
  ];
}

export interface ListRow {
  /** sessionId + id: an anomaly id is unique within its session only. */
  key: string;
  sessionId: string;
  origin: Origin;
  /** The session title, else the first 8 characters of its id (as elsewhere). */
  title: string;
  kind: AnomalyKind;
  kindLabel: string;
  basis: string;
  path: ShownPath | null;
  at: string;
  href: string;
}

/** The page's rows; a churn path is shown relative to its project's directory when inside it. */
export function listRows(items: readonly AnomalyListItem[], projects: readonly Project[] | null): ListRow[] {
  const dirOf = new Map((projects ?? []).map((p) => [p.id, p.cwd]));
  return items.map((a) => ({
    key: `${a.sessionId}\u0000${a.id}`,
    sessionId: a.sessionId,
    origin: a.origin,
    title: a.sessionTitle ?? a.sessionId.slice(0, 8),
    kind: a.kind,
    kindLabel: kindName(a.kind),
    basis: anomalyBasisText(a),
    path: a.kind === 'churn' ? shownPath(a.path, dirOf.get(a.projectId) ?? null) : null,
    at: a.at,
    href: sessionNodeHash(a.sessionId, a.lastNodeId),
  }));
}

/** Lines about how complete the list is. */
export function listNotes(r: Pick<AnomalyListResponse, 'truncated' | 'failedSessions'>): string[] {
  const out: string[] = [];
  if (r.truncated) out.push(`只显示最新的 ${ANOMALY_LIST_MAX} 条，用上面的筛选缩小范围。`);
  if (r.failedSessions > 0) out.push(`有 ${r.failedSessions} 个会话算不出来，已跳过。`);
  return out;
}

// ---- states ----

export type SurfaceState = 'loading' | 'error' | 'empty' | 'ready';

/** What a surface shows: a previous result stays on screen when a refresh fails (the error is then a line above it). */
export function surfaceState<T>(data: T | null, error: string | null, isEmpty: (data: T) => boolean): SurfaceState {
  if (data === null) return error === null ? 'loading' : 'error';
  return isEmpty(data) ? 'empty' : 'ready';
}

/** Fetch again (every ANOMALY_POLL_MS) while the answer says it is still being computed. */
export function shouldPoll(data: { computing: boolean } | null): boolean {
  return data !== null && data.computing;
}
