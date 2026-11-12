import type { GraphNode, Origin, Usage } from './model.js';

/**
 * Cross-session statistics (`GET /api/stats`). Every number is computed from derived nodes and sessions only; the
 * response carries counts, durations (milliseconds), tool / project names and ids, never conversation content.
 */

/** `7d` / `30d`: today (local day of the service) and the 6 / 29 days before it. `all`: everything up to today. */
export type StatsRange = '7d' | '30d' | 'all';
export const STATS_RANGES: readonly StatsRange[] = ['7d', '30d', 'all'];
export const STATS_DEFAULT_RANGE: StatsRange = '7d';
/** `byDay` holds at most this many days (for `all`: the most recent ones, see StatsCoverage.byDayTruncated). */
export const STATS_BY_DAY_MAX = 366;
/** `byProject` lists at most this many projects; the rest are merged into one "其他" row. */
export const STATS_TOP_PROJECTS = 20;
export const STATS_TOP_TOOLS = 30;
export const STATS_SLOWEST = 10;
export const STATS_MOST_FAILING = 10;
/** A (origin, tool) with fewer calls than this in the range is not listed in `mostFailing`. */
export const STATS_MOST_FAILING_MIN_CALLS = 5;

/**
 * Token sums (from node `usage`, see Usage), the same three categories for every origin:
 * - input: new input, i.e. input the model processed that was not read from cache ("新输入"; cache writes included);
 * - cachedInput: input read from cache ("缓存读取");
 * - output: output ("输出"; Codex's reasoning tokens included).
 */
export interface StatsTokens { input: number; cachedInput: number; output: number }

/**
 * The measures shared by totals, origins and projects, over the turns (and their tool calls) that started in the range.
 * - sessions: sessions with at least one turn in the range.
 * - turns: main-thread turns that started in the range (subagent-internal work never forms a turn).
 * - activeMs: sum of those turns' durations (see the spec, section 4: last end − start; a turn still in progress counts
 *   up to now, but stops growing 15 minutes after its last activity).
 * - toolCalls: tool and subagent-dispatch nodes, subagent-internal ones included.
 * - finished: tool calls that reached a terminal status (succeeded / failed / denied); still-running ones are not.
 * - failed: tool calls with status failed or denied.
 * - failureRate: failed / finished, 0..1; null when finished is 0.
 * - toolMs: sum of the finished calls' durations (parallel calls each count, so it can exceed activeMs).
 * - tokens: sum of node usage; null when no origin in scope has token data at all (see StatsCoverage.noTokenData).
 */
export interface StatsMeasures {
  sessions: number;
  turns: number;
  activeMs: number;
  toolCalls: number;
  finished: number;
  failed: number;
  failureRate: number | null;
  toolMs: number;
  tokens: StatsTokens | null;
}

/** One origin's share of a day (no `sessions`, `finished`, `failureRate`). tokens: null for an origin without token data. */
export interface StatsDayOrigin {
  origin: Origin;
  turns: number;
  activeMs: number;
  toolCalls: number;
  failed: number;
  toolMs: number;
  tokens: StatsTokens | null;
}

/**
 * One local day (`YYYY-MM-DD`), turns attributed to the day they started. Days without activity are present with 0s.
 * byOrigin: one entry per origin of `byOrigin` (same order), zeros included, so stacked columns line up.
 */
export interface StatsDay {
  day: string;
  turns: number;
  activeMs: number;
  toolCalls: number;
  failed: number;
  toolMs: number;
  tokens: StatsTokens | null;
  byOrigin: StatsDayOrigin[];
}

/**
 * One origin with at least one turn in the range (an origin without any is absent, never a row of zeros), in ORIGINS
 * order. medianTurnMs: nearest-rank median of the turn durations. avgToolCallsPerTurn = toolCalls / turns.
 * avgTokensPerTurn = tokens / turns per category (fractional); null when tokens is null.
 */
export interface StatsOrigin extends StatsMeasures {
  origin: Origin;
  medianTurnMs: number | null;
  avgToolCallsPerTurn: number | null;
  avgTokensPerTurn: StatsTokens | null;
}

/**
 * One project with at least one turn in the range, by activeMs descending (ties: name, then id). At most
 * STATS_TOP_PROJECTS rows; when there are more, the rest are merged into a last row with projectId null, name "其他"
 * and projectCount = how many projects it stands for (1 for a real project).
 */
export interface StatsProject extends StatsMeasures {
  projectId: string | null;
  name: string;
  projectCount: number;
}

/**
 * One (origin, toolName): toolName is the node's tool name as stored ('(unknown)' when the node has none), never merged
 * across origins. timedCalls: finished calls with a known duration; totalMs / medianMs / p95Ms are over those
 * (nearest-rank; null when timedCalls is 0). Ordered by totalMs descending (ties: calls descending, origin, name); at
 * most STATS_TOP_TOOLS.
 */
export interface StatsTool {
  origin: Origin;
  toolName: string;
  calls: number;
  finished: number;
  failed: number;
  failureRate: number | null;
  timedCalls: number;
  totalMs: number;
  medianMs: number | null;
  p95Ms: number | null;
}

/**
 * One finished tool call with a known duration; startedAt is the node's timestamp (ISO 8601, normalized to
 * `YYYY-MM-DDTHH:mm:ss.sssZ`; '' when the node's timestamp is unparseable).
 */
export interface StatsSlowCall {
  sessionId: string;
  nodeId: string;
  projectId: string;
  origin: Origin;
  toolName: string;
  durationMs: number;
  startedAt: string;
}

/** One (origin, toolName) with at least one failure and at least STATS_MOST_FAILING_MIN_CALLS calls in the range. */
export interface StatsFailingTool {
  origin: Origin;
  toolName: string;
  calls: number;
  finished: number;
  failed: number;
  failureRate: number | null;
}

/**
 * - sessionsByOrigin: sessions counted in the range per origin (origins of `byOrigin` only).
 * - noTokenData: origins (ORIGINS order) that have sessions but not one node carrying usage in the whole dataset (not
 *   only the range, and regardless of the filters): their tokens are null everywhere, to be shown as "—".
 * - failedSessions: sessions skipped because their summary could not be computed.
 * - firstActiveDay: the local day of the earliest turn in scope (filters applied; any range), or null when none.
 * - byDayTruncated: `all` only: activity spans more than STATS_BY_DAY_MAX days, so byDay holds the most recent
 *   STATS_BY_DAY_MAX days only (the totals and every other list still cover everything).
 * - undatedTurns (added in fix round 1; optional): turns (and orphan subagent nodes) in scope whose start time is
 *   unparseable or not after 1970-01-01T00:00:00Z; they are in no day and no number of the response.
 * - importing (added in fix round 1; optional): true while the service's start-up import, a rebuild or a poll source's
 *   first round is still running: the numbers may still be filling in.
 */
export interface StatsCoverage {
  sessionsByOrigin: { origin: Origin; sessions: number }[];
  noTokenData: Origin[];
  failedSessions: number;
  firstActiveDay: string | null;
  byDayTruncated: boolean;
  undatedTurns?: number;
  importing?: boolean;
}

/**
 * range.from / range.to: the first and last local day (`YYYY-MM-DD`) of the range; for `all`, from is the first active
 * day (null with no activity at all). filters echo the request (null = not filtered). generatedAt: ISO 8601.
 * slowest: at most STATS_SLOWEST, durationMs descending. mostFailing: at most STATS_MOST_FAILING, failed descending
 * (ties: failureRate descending, origin, name).
 */
export interface StatsResponse {
  generatedAt: string;
  range: { range: StatsRange; from: string | null; to: string };
  filters: { origin: Origin | null; projectId: string | null };
  totals: StatsMeasures;
  byDay: StatsDay[];
  byOrigin: StatsOrigin[];
  byProject: StatsProject[];
  byTool: StatsTool[];
  slowest: StatsSlowCall[];
  mostFailing: StatsFailingTool[];
  coverage: StatsCoverage;
}

/** Key of the turn holding main-thread nodes that come before every turn with a turnId (as the canvas names it). */
export const PRELUDE_TURN_KEY = '__prelude__';

export interface NodeTurn {
  key: string;
  /** The turn's first node's time (ms); an unparseable timestamp counts as 0. */
  startMs: number;
  /** Main-thread nodes, by time then id. */
  nodes: GraphNode[];
}

function parseMs(ts: string): number {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * The turns of a session's main thread, exactly as the session page's canvas groups them (packages/web view.ts
 * groupByTurn): main-thread nodes (agentId null) sorted by time then id; a node with a turnId belongs to that turn; one
 * without belongs to the latest turn that started at or before it, else to PRELUDE_TURN_KEY. Turns are ordered by start,
 * then key. Subagent-internal nodes are ignored.
 */
export function groupTurns(nodes: Iterable<GraphNode>): NodeTurn[] {
  const main: { node: GraphNode; ms: number }[] = [];
  for (const node of nodes) if (node.agentId === null) main.push({ node, ms: parseMs(node.timestamp) });
  main.sort((a, b) => a.ms - b.ms || (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0));
  const turnStart = new Map<string, number>();
  for (const x of main) {
    const key = x.node.turnId;
    if (key !== null && !turnStart.has(key)) turnStart.set(key, x.ms);
  }
  const anchors = [...turnStart].map(([key, ms]) => ({ key, ms })).sort((a, b) => a.ms - b.ms || (a.key < b.key ? -1 : 1));
  const groups = new Map<string, NodeTurn>();
  let a = 0; // main is sorted: the latest anchor at or before x only moves forward
  let current: string = PRELUDE_TURN_KEY;
  for (const x of main) {
    while (a < anchors.length && anchors[a]!.ms <= x.ms) current = anchors[a++]!.key;
    const key = x.node.turnId ?? current;
    let turn = groups.get(key);
    if (!turn) groups.set(key, (turn = { key, startMs: x.ms, nodes: [] }));
    turn.nodes.push(x.node);
  }
  return [...groups.values()].sort((p, q) => p.startMs - q.startMs || (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));
}

/**
 * The nodes whose usage counts, as the session page totals tokens (web replay.ts usageTotal): `nodes` in the session
 * snapshot's order (the store's node rowid order); a node without usage is skipped; a node with a non-empty messageId
 * counts only if no earlier node (in that order) with usage had the same messageId; a null or empty messageId: each
 * node counts.
 */
export function countedUsageNodes(nodes: Iterable<GraphNode>): GraphNode[] {
  const seen = new Set<string>();
  const out: GraphNode[] = [];
  for (const n of nodes) {
    if (!n.usage) continue;
    if (n.messageId) {
      if (seen.has(n.messageId)) continue;
      seen.add(n.messageId);
    }
    out.push(n);
  }
  return out;
}

/** A usage sum: every category present (a node without cachedInputTokens adds 0 to it). */
export type UsageTotal = Required<Usage>;

/** 按 messageId 去重求和；messageId 为空的节点各算一次；usage 为空的跳过（see countedUsageNodes）。 */
export function usageTotal(nodes: Iterable<GraphNode>): UsageTotal {
  const total: UsageTotal = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  for (const n of countedUsageNodes(nodes)) {
    total.inputTokens += n.usage!.inputTokens;
    total.cachedInputTokens += n.usage!.cachedInputTokens ?? 0;
    total.outputTokens += n.usage!.outputTokens;
  }
  return total;
}
