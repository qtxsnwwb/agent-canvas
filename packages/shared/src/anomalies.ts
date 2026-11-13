import type { GraphNode, NodeStatus, Origin } from './model.js';
import { pathKey } from './paths.js';
import { countedUsageNodes, groupTurns, PRELUDE_TURN_KEY } from './stats.js';

/**
 * Anomaly detection (spec 2026-11-13-anomalies-design.md, section 3): patterns inside one session worth a second look.
 * Every function here is a pure function of the current node set: the order nodes are given in does not matter, and a
 * node whose status changes later changes the result accordingly. Anomalies carry kinds, counts, numbers, times, ids
 * and file paths only — never conversation text, tool input or output.
 */

/** The same call (toolName + inputKey) failing this many times in one turn: `loop` (basis `failed`). */
export const LOOP_FAILED_MIN = 3;
/** The same call this many times in a row among the turn's calls: `loop` (basis `repeat`). */
export const LOOP_REPEAT_MIN = 5;
/** This many calls in a row (in the order they finished) ending failed: `failures`. */
export const FAILURE_STREAK_MIN = 5;
/** This many edit / write touches of one file in one turn: `churn`. */
export const CHURN_MIN = 15;
/** A finished main-thread turn at least this many times its group's 95th percentile: `cost`. */
export const COST_FACTOR = 2;
/** A cost baseline needs at least this many finished turns (for tokens: finished turns with tokens). */
export const COST_MIN_TURNS = 20;
/** Floor of a `cost` anomaly by active time: 10 minutes. */
export const COST_MIN_ACTIVE_MS = 600_000;
/** Floor of a `cost` anomaly by tokens (new input + output). */
export const COST_MIN_TOKENS = 200_000;

export type AnomalyKind = 'loop' | 'failures' | 'churn' | 'cost';
export const ANOMALY_KINDS: readonly AnomalyKind[] = ['loop', 'failures', 'churn', 'cost'];

/**
 * What an anomaly was found on: `loop` — `failed` (the same call failed LOOP_FAILED_MIN times) or `repeat` (the same
 * call LOOP_REPEAT_MIN times in a row); `failures` — `streak`; `churn` — `edits`; `cost` — `time` or `tokens`.
 */
export type AnomalyBasis = 'failed' | 'repeat' | 'streak' | 'edits' | 'time' | 'tokens';

/**
 * One anomaly. At most one per (session, turn, kind), except `cost`, which may have one per basis.
 * - id: `<kind>:<turnKey>`, for cost `cost:<turnKey>:<basis>` — stable and unique within the session (key a
 *   cross-session list on sessionId + id).
 * - agentId: the thread the turn is in (null = main thread). turnKey: for the main thread the key groupTurns gives the
 *   turn; for a subagent thread `<agentId>:<key>` (see detectionTurns).
 * - count: loop (failed: how many times that call failed in the turn; repeat: the length of the run), failures (the
 *   length of the streak), churn (the file's edit / write touches in the turn). Grows while the pattern continues.
 * - value / baselineValue (cost): the turn's active time (ms) or tokens, and the group's 95th percentile it was judged
 *   against.
 * - path (churn): the file as the first touch stored it. toolName (loop): the call's tool name.
 * - firstNodeId / lastNodeId: the first and last node of the pattern (the node to jump to is the last).
 * - at: ISO 8601, the time the threshold was reached — the end (failed calls, streaks) or the start (repeats, edits) of
 *   the node that completed it; for cost the end of the turn — as stored on that node.
 */
export interface Anomaly {
  id: string;
  kind: AnomalyKind;
  sessionId: string;
  agentId: string | null;
  turnKey: string;
  basis: AnomalyBasis;
  count?: number;
  value?: number;
  baselineValue?: number;
  path?: string;
  toolName?: string | null;
  firstNodeId: string;
  lastNodeId: string;
  at: string;
}

/**
 * One main-thread turn's cost (see turnCosts). activeMs: the sum of the durations of its tool, dispatch and thinking
 * nodes (main thread only; parallel calls each count). tokens: new input + output of the usage-counted nodes of the
 * turn, subagent-internal ones included (attributed to the turn that dispatched them, as the stats page does).
 * finished: a later main turn exists, or the session is not running. at: ISO 8601, the turn's latest node end (endedAt,
 * else timestamp). firstNodeId / lastNodeId: its first and last main-thread node by time, then id.
 */
export interface TurnCost {
  sessionId: string;
  turnKey: string;
  startMs: number;
  activeMs: number;
  tokens: number;
  finished: boolean;
  firstNodeId: string;
  lastNodeId: string;
  at: string;
}

/** The 95th percentiles a turn's cost is judged against; null = not enough data (fewer than COST_MIN_TURNS turns). */
export interface CostBaseline {
  activeP95: number | null;
  tokensP95: number | null;
}

/** A detection turn: nodes of one thread, by time then id. */
export interface DetectionTurn {
  /** Unique within the session: main-thread turns as groupTurns names them, subagent ones `<agentId>:<key>`. */
  key: string;
  agentId: string | null;
  /** The turn's first node's time (ms); an unparseable timestamp counts as 0. */
  startMs: number;
  nodes: GraphNode[];
}

// ---- helpers ----

function parseMs(ts: string | null | undefined): number | null {
  if (typeof ts !== 'string') return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

const cmpId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Item {
  node: GraphNode;
  ms: number;
}

/**
 * Nodes with their start, by start then id — the one sort of a detection. A node whose timestamp cannot be parsed is
 * left out: it cannot be judged (spec 7), so it takes no part in turns, detection or costs.
 */
function sortedItems(nodes: Iterable<GraphNode>): Item[] {
  const items: Item[] = [];
  for (const node of nodes) {
    const ms = parseMs(node.timestamp);
    if (ms !== null) items.push({ node, ms });
  }
  items.sort((a, b) => a.ms - b.ms || cmpId(a.node.id, b.node.id));
  return items;
}

const isCall = (n: GraphNode): boolean => n.kind === 'tool' || n.kind === 'subagent';

/**
 * The turns of one thread, `items` sorted by time then id: groupTurns' rule (a node with a turnId belongs to it; one
 * without belongs to the latest turn that started at or before it, else to PRELUDE_TURN_KEY). With `prompts`, a prompt
 * node without a turnId also starts a turn, keyed by its id (Claude Code's subagent threads carry no turnIds).
 */
function threadTurns(items: Item[], agentId: string | null, prompts: boolean): DetectionTurn[] {
  const anchorOf = new Map<string, number>();
  for (const x of items) {
    const key = x.node.turnId ?? (prompts && x.node.kind === 'prompt' ? x.node.id : null);
    if (key !== null && !anchorOf.has(key)) anchorOf.set(key, x.ms);
  }
  const anchors = [...anchorOf].map(([key, ms]) => ({ key, ms })).sort((a, b) => a.ms - b.ms || cmpId(a.key, b.key));
  const prefix = agentId === null ? '' : `${agentId}:`;
  const groups = new Map<string, DetectionTurn>();
  let a = 0;
  let current = PRELUDE_TURN_KEY;
  for (const x of items) {
    while (a < anchors.length && anchors[a]!.ms <= x.ms) current = anchors[a++]!.key;
    const own = x.node.turnId ?? (prompts && x.node.kind === 'prompt' ? x.node.id : null);
    const key = prefix + (own ?? current);
    let turn = groups.get(key);
    if (!turn) groups.set(key, (turn = { key, agentId, startMs: x.ms, nodes: [] }));
    turn.nodes.push(x.node);
  }
  return [...groups.values()];
}

function turnsOfItems(items: Item[]): DetectionTurn[] {
  const byThread = new Map<string | null, Item[]>();
  for (const x of items) {
    const list = byThread.get(x.node.agentId);
    if (list) list.push(x);
    else byThread.set(x.node.agentId, [x]);
  }
  const out: DetectionTurn[] = [];
  for (const [agentId, list] of byThread) out.push(...threadTurns(list, agentId, agentId !== null));
  return out.sort((p, q) => p.startMs - q.startMs || cmpId(p.key, q.key));
}

/**
 * The detection turns of a session (spec 3.1): per thread (agentId; main = null). The main thread's turns are exactly
 * groupTurns'; a subagent thread's follow the same rule, a prompt of that thread without a turnId also starting a turn
 * (a thread without any is one turn, `<agentId>:__prelude__`). A dispatch node belongs to the thread that dispatched it
 * (its agentId). Nodes whose timestamp cannot be parsed are left out. Ordered by start, then key.
 */
export function detectionTurns(nodes: Iterable<GraphNode>): DetectionTurn[] {
  return turnsOfItems(sortedItems(nodes));
}

// ---- detection ----

interface Found {
  basis: AnomalyBasis;
  /** When the threshold was reached (Anomaly.at). */
  atMs: number;
  /** The time used to tell which loop condition came first (atMs, or Infinity when the end is not known). */
  cmpMs: number;
  count: number;
  first: GraphNode;
  last: GraphNode;
  toolName?: string | null;
  path?: string;
}

const callKey = (n: GraphNode): string | null => (n.inputKey === undefined ? null : `${n.toolName ?? ''}\u0000${n.inputKey}`);

interface Call {
  node: GraphNode;
  ms: number;
  /** endedAt, null when it does not parse. */
  knownEndMs: number | null;
  /** knownEndMs, else the start. */
  endMs: number;
}

/**
 * loop, basis failed: the first call (in end order) to fail LOOP_FAILED_MIN times; count = its failures in the turn.
 * A failure without a usable end time comes after every failure with one (it is not taken as having ended at its
 * start, which would move the condition back in time once its status arrives): cmpMs is then Infinity and `at` its
 * start.
 */
function loopFailed(byStart: Call[]): Found | null {
  const failures = byStart.filter((c) => c.node.status === 'failed' && callKey(c.node) !== null);
  failures.sort(
    (a, b) => (a.knownEndMs ?? Infinity) - (b.knownEndMs ?? Infinity) || a.ms - b.ms || cmpId(a.node.id, b.node.id),
  );
  const counts = new Map<string, { count: number; first: GraphNode; last: GraphNode }>();
  let hit: { key: string; c: Call } | null = null;
  for (const c of failures) {
    const key = callKey(c.node)!;
    const e = counts.get(key);
    if (e) {
      e.count++;
      e.last = c.node;
    } else counts.set(key, { count: 1, first: c.node, last: c.node });
    if (hit === null && counts.get(key)!.count === LOOP_FAILED_MIN) hit = { key, c };
  }
  if (hit === null) return null;
  const e = counts.get(hit.key)!;
  const atMs = hit.c.knownEndMs ?? hit.c.ms;
  const cmpMs = hit.c.knownEndMs ?? Infinity;
  return { basis: 'failed', atMs, cmpMs, count: e.count, first: e.first, last: e.last, toolName: e.first.toolName };
}

/** loop, basis repeat: the first run (in start order) of the same call reaching LOOP_REPEAT_MIN; count = its length. */
function loopRepeat(byStart: Call[]): Found | null {
  let runKey: string | null = null;
  let runStart = 0;
  for (let i = 0; i < byStart.length; i++) {
    const key = callKey(byStart[i]!.node);
    if (key === null || key !== runKey) {
      runKey = key;
      runStart = i;
      continue;
    }
    if (i - runStart + 1 === LOOP_REPEAT_MIN) {
      let end = i;
      while (end + 1 < byStart.length && callKey(byStart[end + 1]!.node) === key) end++;
      const at = byStart[i]!;
      const first = byStart[runStart]!.node;
      return { basis: 'repeat', atMs: at.ms, cmpMs: at.ms, count: end - runStart + 1, first, last: byStart[end]!.node, toolName: first.toolName };
    }
  }
  return null;
}

/** Statuses that neither count in a failure streak nor break it. */
const SKIPPED: ReadonlySet<NodeStatus | null> = new Set<NodeStatus | null>(['denied', 'running', 'awaiting_permission', null]);

/** failures: the first streak (in end order) of FAILURE_STREAK_MIN failed calls; count = its final length. */
function failureStreak(byEnd: Call[]): Found | null {
  let streak: Call[] = [];
  let hit: Call | null = null;
  for (const c of byEnd) {
    const s = c.node.status;
    if (SKIPPED.has(s)) continue;
    if (s === 'failed') {
      streak.push(c);
      if (hit === null && streak.length === FAILURE_STREAK_MIN) hit = c;
      continue;
    }
    if (hit !== null) break; // the reported streak ends here
    streak = [];
  }
  if (hit === null) return null;
  return { basis: 'streak', atMs: hit.endMs, cmpMs: hit.endMs, count: streak.length, first: streak[0]!.node, last: streak[streak.length - 1]!.node };
}

interface FileCount {
  path: string;
  count: number;
  first: GraphNode;
  last: GraphNode;
  /** Order in which files reached CHURN_MIN (-1: not yet). */
  reached: number;
  atMs: number;
}

/**
 * churn: per file (pathKey), the calls (status not failed / denied) that edit or write it, in start order — a call
 * counts once per file, even when it both edits and writes it; the file with the most reaching CHURN_MIN (a tie: the
 * one that reached it first).
 */
function churn(byStart: Call[]): Found | null {
  const files = new Map<string, FileCount>();
  let seq = 0;
  for (const c of byStart) {
    const n = c.node;
    if (!n.files || n.files.length === 0 || n.status === 'failed' || n.status === 'denied') continue;
    const seen = n.files.length > 1 ? new Set<string>() : null;
    for (const f of n.files) {
      if (f.action !== 'edit' && f.action !== 'write') continue;
      const key = pathKey(f.path);
      if (seen !== null) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      let e = files.get(key);
      if (!e) files.set(key, (e = { path: f.path, count: 0, first: n, last: n, reached: -1, atMs: 0 }));
      e.count++;
      e.last = n;
      if (e.count === CHURN_MIN) {
        e.reached = seq++;
        e.atMs = c.ms;
      }
    }
  }
  let best: FileCount | null = null;
  for (const e of files.values()) {
    if (e.count < CHURN_MIN) continue;
    if (best === null || e.count > best.count || (e.count === best.count && e.reached < best.reached)) best = e;
  }
  if (best === null) return null;
  return { basis: 'edits', atMs: best.atMs, cmpMs: best.atMs, count: best.count, first: best.first, last: best.last, path: best.path };
}

function toAnomaly(kind: AnomalyKind, sessionId: string, turn: DetectionTurn, f: Found): Anomaly {
  const a: Anomaly = {
    id: `${kind}:${turn.key}`,
    kind,
    sessionId,
    agentId: turn.agentId,
    turnKey: turn.key,
    basis: f.basis,
    count: f.count,
    firstNodeId: f.first.id,
    lastNodeId: f.last.id,
    at: new Date(f.atMs).toISOString(),
  };
  if (f.toolName !== undefined) a.toolName = f.toolName;
  if (f.path !== undefined) a.path = f.path;
  return a;
}

/**
 * The `loop`, `failures` and `churn` anomalies of one session's nodes (spec 3.3), at most one per kind per detection
 * turn (see detectionTurns). Calls are tool and dispatch nodes. "The same call": the same toolName and inputKey (a node
 * without inputKey matches nothing). loop: the same call failed LOOP_FAILED_MIN times in the turn, or ran
 * LOOP_REPEAT_MIN times in a row in start order (any status); when both hold, the one reached first (a tie: failed).
 * failures: FAILURE_STREAK_MIN calls in a row, in the order they finished (endedAt, else start), ending failed —
 * denied / running / awaiting-permission calls are skipped, a success breaks the streak; the first such streak.
 * churn: see churn(). A node whose timestamp cannot be parsed takes no part; an unparseable endedAt counts as unknown
 * (the start stands in for it, except in telling the loop conditions apart, see loopFailed). `at` is always an ISO
 * time (toISOString). Ordered by `at`, then id. O(n log n).
 */
export function detectAnomalies(nodes: Iterable<GraphNode>): Anomaly[] {
  const items = sortedItems(nodes);
  const out: { a: Anomaly; atMs: number }[] = [];
  for (const turn of turnsOfItems(items)) {
    const byStart: Call[] = [];
    for (const n of turn.nodes) {
      if (!isCall(n)) continue;
      const ms = parseMs(n.timestamp)!; // sortedItems kept parseable ones only
      const knownEndMs = parseMs(n.endedAt);
      byStart.push({ node: n, ms, knownEndMs, endMs: knownEndMs ?? ms });
    }
    if (byStart.length === 0) continue;
    const byEnd = [...byStart].sort((a, b) => a.endMs - b.endMs || a.ms - b.ms || cmpId(a.node.id, b.node.id));
    const sessionId = byStart[0]!.node.sessionId;
    const failed = loopFailed(byStart);
    const repeat = loopRepeat(byStart);
    const loop = failed !== null && (repeat === null || failed.cmpMs <= repeat.cmpMs) ? failed : repeat;
    if (loop !== null) out.push({ a: toAnomaly('loop', sessionId, turn, loop), atMs: loop.atMs });
    const streak = failureStreak(byEnd);
    if (streak !== null) out.push({ a: toAnomaly('failures', sessionId, turn, streak), atMs: streak.atMs });
    const edits = churn(byStart);
    if (edits !== null) out.push({ a: toAnomaly('churn', sessionId, turn, edits), atMs: edits.atMs });
  }
  return out.sort((p, q) => p.atMs - q.atMs || cmpId(p.a.id, q.a.id)).map((x) => x.a);
}

// ---- cost ----

const ACTIVE_KINDS: ReadonlySet<GraphNode['kind']> = new Set<GraphNode['kind']>(['tool', 'subagent', 'thinking']);

/**
 * Each main-thread turn's cost (groupTurns' turns, in their order; see TurnCost). Tokens follow countedUsageNodes'
 * rule (a messageId counts once per session), applied to the nodes by time then id so the result does not depend on
 * the input order; a counted subagent-internal node is attributed to the turn that dispatched its agent (the earliest
 * dispatch node naming it, followed up through nested agents), else to the latest turn started at or before it, else
 * the first turn — the stats page's rule. A node whose timestamp cannot be parsed is left out (no time, no tokens, never
 * a turn's start or end); `at` is an ISO time (toISOString).
 */
export function turnCosts(nodes: Iterable<GraphNode>, sessionRunning: boolean): TurnCost[] {
  const items = sortedItems(nodes);
  const turns = groupTurns(items.map((x) => x.node));
  if (turns.length === 0) return [];
  const turnOfMain = new Map<string, number>();
  const costs: TurnCost[] = turns.map((t, i) => {
    let activeMs = 0;
    let atMs = t.startMs;
    for (const n of t.nodes) {
      turnOfMain.set(n.id, i);
      if (ACTIVE_KINDS.has(n.kind) && typeof n.durationMs === 'number' && Number.isFinite(n.durationMs) && n.durationMs > 0) activeMs += n.durationMs;
      const end = parseMs(n.endedAt) ?? parseMs(n.timestamp)!;
      if (end > atMs) atMs = end;
    }
    return {
      sessionId: t.nodes[0]!.sessionId,
      turnKey: t.key,
      startMs: t.startMs,
      activeMs,
      tokens: 0,
      finished: i < turns.length - 1 || !sessionRunning,
      firstNodeId: t.nodes[0]!.id,
      lastNodeId: t.nodes[t.nodes.length - 1]!.id,
      at: new Date(atMs).toISOString(),
    };
  });

  const dispatchOf = new Map<string, GraphNode>();
  for (const { node } of items) {
    if (node.kind === 'subagent' && node.childAgentId !== null && !dispatchOf.has(node.childAgentId)) dispatchOf.set(node.childAgentId, node);
  }
  const agentTurn = new Map<string, number | null>();
  const resolveAgent = (agentId: string): number | null => {
    if (agentTurn.has(agentId)) return agentTurn.get(agentId)!;
    agentTurn.set(agentId, null); // cycle guard
    const d = dispatchOf.get(agentId);
    const result = d === undefined ? null : d.agentId === null ? (turnOfMain.get(d.id) ?? null) : resolveAgent(d.agentId);
    agentTurn.set(agentId, result);
    return result;
  };
  const turnByTime = (ms: number): number => {
    let lo = 0;
    let hi = turns.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (turns[mid]!.startMs <= ms) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  };
  for (const n of countedUsageNodes(items.map((x) => x.node))) {
    const i = n.agentId === null ? turnOfMain.get(n.id)! : (resolveAgent(n.agentId) ?? turnByTime(parseMs(n.timestamp) ?? 0));
    costs[i]!.tokens += n.usage!.inputTokens + n.usage!.outputTokens;
  }
  return costs;
}

/** Nearest-rank percentile of an ascending list (p in 0..1); null for an empty list. */
function nearestRank(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

/**
 * Origins whose turns are never judged by tokens (spec 3.4: Cursor only by active time — its token counts are partial).
 */
export const COST_NO_TOKEN_ORIGINS: readonly Origin[] = ['cursor'];

/**
 * The 95th percentiles (nearest rank) of the finished turns' active time and tokens (unfinished turns are left out);
 * tokens over the turns with tokens > 0 only. Each null when fewer than COST_MIN_TURNS turns qualify. Grouping the
 * turns (by project and origin) is the caller's; `options.origin` is the group's origin: for one in
 * COST_NO_TOKEN_ORIGINS tokensP95 is always null, so costAnomalies never judges its tokens.
 */
export function costBaseline(costs: Iterable<TurnCost>, options: { origin?: Origin } = {}): CostBaseline {
  const judgeTokens = options.origin === undefined || !COST_NO_TOKEN_ORIGINS.includes(options.origin);
  const active: number[] = [];
  const tokens: number[] = [];
  for (const c of costs) {
    if (!c.finished) continue;
    active.push(c.activeMs);
    if (c.tokens > 0) tokens.push(c.tokens);
  }
  active.sort((a, b) => a - b);
  tokens.sort((a, b) => a - b);
  return {
    activeP95: active.length >= COST_MIN_TURNS ? nearestRank(active, 0.95) : null,
    tokensP95: judgeTokens && tokens.length >= COST_MIN_TURNS ? nearestRank(tokens, 0.95) : null,
  };
}

/**
 * The `cost` anomalies of finished turns against `baseline` (spec 3.4): basis `time` when activeMs ≥ COST_FACTOR ×
 * activeP95 and ≥ COST_MIN_ACTIVE_MS; basis `tokens` when tokens ≥ COST_FACTOR × tokensP95 and ≥ COST_MIN_TOKENS. A
 * null percentile judges nothing. In the order of `costs`, time before tokens.
 */
export function costAnomalies(costs: Iterable<TurnCost>, baseline: CostBaseline): Anomaly[] {
  const out: Anomaly[] = [];
  const add = (c: TurnCost, basis: 'time' | 'tokens', value: number, p95: number): void => {
    out.push({
      id: `cost:${c.turnKey}:${basis}`,
      kind: 'cost',
      sessionId: c.sessionId,
      agentId: null,
      turnKey: c.turnKey,
      basis,
      value,
      baselineValue: p95,
      firstNodeId: c.firstNodeId,
      lastNodeId: c.lastNodeId,
      at: c.at,
    });
  };
  for (const c of costs) {
    if (!c.finished) continue;
    const { activeP95, tokensP95 } = baseline;
    if (activeP95 !== null && c.activeMs >= COST_FACTOR * activeP95 && c.activeMs >= COST_MIN_ACTIVE_MS) add(c, 'time', c.activeMs, activeP95);
    if (tokensP95 !== null && c.tokens >= COST_FACTOR * tokensP95 && c.tokens >= COST_MIN_TOKENS) add(c, 'tokens', c.tokens, tokensP95);
  }
  return out;
}

// ---- text ----

/** The name and a one-line explanation of each kind (pages and notifications use the same words). */
export const ANOMALY_LABELS: Record<AnomalyKind, { name: string; description: string }> = {
  loop: { name: '原地打转', description: '同一个调用在一轮里反复失败，或者连着执行了很多次。' },
  failures: { name: '失败扎堆', description: '一轮里接连好几次工具调用都以失败结束。' },
  churn: { name: '反复改同一个文件', description: '一轮里同一个文件被改了很多次。' },
  cost: { name: '消耗异常高', description: '这一轮的工作时间或 token 远高于同项目、同来源的平时高位。' },
};

/** One decimal at most, without a trailing `.0`. */
const oneDecimal = (n: number): string => n.toFixed(1).replace(/\.0$/, '');

function minutesText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分钟`;
}

const tokensText = (n: number): string => (n >= 10_000 ? `${oneDecimal(n / 10_000)} 万` : String(Math.round(n)));

/** The one-line basis of an anomaly, e.g. “同一个调用失败了 3 次”, “工作时间 42 分钟，是平时高位的 2.3 倍”. */
export function anomalyBasisText(a: Anomaly): string {
  const count = a.count ?? 0;
  switch (a.basis) {
    case 'failed':
      return `同一个调用失败了 ${count} 次`;
    case 'repeat':
      return `同一个调用连续执行了 ${count} 次`;
    case 'streak':
      return `连续 ${count} 次调用失败`;
    case 'edits':
      return `改了 ${count} 次`;
    case 'time':
    case 'tokens': {
      const value = a.value ?? 0;
      const base = a.baselineValue ?? 0;
      const head = a.basis === 'time' ? `工作时间 ${minutesText(value)}` : `用了 ${tokensText(value)} token`;
      return base > 0 ? `${head}，是平时高位的 ${oneDecimal(value / base)} 倍` : `${head}，远高于平时`;
    }
  }
}

// ---- routes (server spec section 4) ----

/** Most items GET /api/anomalies returns (newest first); more matched: `truncated`. */
export const ANOMALY_LIST_MAX = 200;
/** A `loop` / `failures` anomaly notifies only when it happened at most this long ago (spec 5). */
export const ANOMALY_NOTIFY_MAX_AGE_MS = 120_000;

/** The time range of GET /api/anomalies (as the stats page: local days, today included). */
export type AnomalyRange = '7d' | '30d' | 'all';
export const ANOMALY_RANGES: readonly AnomalyRange[] = ['7d', '30d', 'all'];
export const ANOMALY_DEFAULT_RANGE: AnomalyRange = '30d';

/**
 * GET /api/sessions/:id/anomalies: every anomaly of the session (all four kinds), by `at` then id. computing: the
 * cost baselines are not yet built from every session (warm-up or import in progress), so `cost` ones may be missing.
 */
export interface SessionAnomaliesResponse {
  anomalies: Anomaly[];
  computing: boolean;
}

/** One row of GET /api/anomalies: the anomaly plus what the row shows of its session. */
export type AnomalyListItem = Anomaly & { projectId: string; origin: Origin; sessionTitle: string | null };

/**
 * GET /api/anomalies?range=&origin=&projectId=&kind=: anomalies whose `at` is in range, newest first, at most
 * ANOMALY_LIST_MAX. totals: per kind, over everything matching range / origin / projectId (the kind filter left out).
 * truncated: more matched than returned. computing: not every session's anomalies are computed yet (the list may
 * grow). failedSessions: sessions whose anomalies could not be computed (left out).
 */
export interface AnomalyListResponse {
  items: AnomalyListItem[];
  totals: Record<AnomalyKind, number>;
  truncated: boolean;
  computing: boolean;
  failedSessions: number;
}

/** One session's anomaly counts (home page marker). */
export interface AnomalySessionCount {
  total: number;
  byKind: Partial<Record<AnomalyKind, number>>;
}

/** GET /api/anomalies/counts: all time, only sessions with at least one anomaly, keyed by session id. */
export interface AnomalyCountsResponse {
  counts: Record<string, AnomalySessionCount>;
  computing: boolean;
}

/**
 * The page address of a node: the session page with the node selected (the web's sessionNodeHash, `#/s/<id>/n/<node>`,
 * both parts URI-encoded). For notification click targets.
 */
export function nodeAddressHash(sessionId: string, nodeId: string): string {
  return `#/s/${encodeURIComponent(sessionId)}/n/${encodeURIComponent(nodeId)}`;
}
