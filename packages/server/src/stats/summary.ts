import { countedUsageNodes, groupTurns, STALE_AFTER_MS, type GraphNode, type Origin, type Session } from '@agent-canvas/shared';

/**
 * Per-session summary for the stats page: a pure function of a session record and its derived nodes, independent of
 * the clock (in-progress turns keep what turnDurationMs needs to measure them at request time).
 *
 * Definitions (spec 2026-11-12-stats-design.md, section 4):
 * - Turns are the canvas's turns (shared groupTurns): main-thread nodes grouped by turnId, a prelude included.
 * - A call is a `tool` or `subagent` node, subagent-internal ones included. finished: status succeeded / failed / denied;
 *   failed: failed / denied. Duration (finished calls only): durationMs, else endedAt − timestamp, else unknown;
 *   a negative one is unknown.
 * - A subagent-internal node (agentId set) belongs to the turn that dispatched its agent: the earliest dispatch node
 *   whose childAgentId is that agent, followed up through nested agents to the main thread. When that cannot be
 *   resolved: the latest turn started at or before the node, else the first turn. With no turn at all, it is an extra
 *   (dated by its own timestamp). Every internal node (calls, text, thinking, …) extends its turn's last activity.
 * - Tokens: exactly the session page's rule (shared countedUsageNodes / usageTotal), applied to the nodes in the order
 *   given, which must be the snapshot's node order (store rowid order).
 * - Undated: a turn whose start, or an extra whose time, is unparseable or not after 1970-01-01T00:00:00Z (a source's
 *   fallback) has `dated: false`; the aggregation leaves it out of every day and counts it in coverage.
 */

export interface SummaryTurn {
  key: string;
  startMs: number;
  dated: boolean;
  /** Latest end (endedAt, else timestamp) of the turn's main-thread nodes; at least startMs. */
  endMs: number;
  /**
   * In progress: one of its main-thread nodes is running / awaiting permission, or it is the session's last turn and
   * the session is running / awaiting permission.
   */
  open: boolean;
  /**
   * Latest timestamp / endedAt of its nodes (main-thread and attributed internal ones); for the last turn of a session
   * that is running / awaiting permission, also the session's lastActivityAt.
   */
  lastActivityMs: number;
  toolCalls: number;
  finished: number;
  failed: number;
  toolMs: number;
  inputTokens: number;
  outputTokens: number;
}

/** Internal nodes of a session without any main-thread turn: one per node that is a call or carries counted usage. */
export interface SummaryExtra {
  atMs: number;
  dated: boolean;
  toolCalls: number;
  finished: number;
  failed: number;
  toolMs: number;
  inputTokens: number;
  outputTokens: number;
}

/** Kept small (one per call, the bulk of a summary's memory): no strings but the node id and an interned tool name. */
export interface SummaryCall {
  nodeId: string;
  toolName: string;
  /** The node's timestamp in ms; NaN when unparseable. */
  atMs: number;
  /** Index into turns; -1 for an extra. */
  turn: number;
  finished: boolean;
  failed: boolean;
  /** Finished calls only; null when unknown. */
  durationMs: number | null;
}

export interface SessionSummary {
  sessionId: string;
  origin: Origin;
  projectId: string;
  turns: SummaryTurn[];
  extras: SummaryExtra[];
  /** By time, then node id. */
  calls: SummaryCall[];
  /** Nodes carrying usage (before messageId deduplication): 0 means the session has no token data. */
  usageNodes: number;
}

/** The tool name of a call whose node has none (never the node title: a title could one day carry content). */
export const UNKNOWN_TOOL = '(unknown)';

/** Tool names are a handful of distinct strings repeated per call: share one copy (bounded table). */
const INTERN_MAX = 10_000;
const interned = new Map<string, string>();
function intern(name: string): string {
  const known = interned.get(name);
  if (known !== undefined) return known;
  if (interned.size < INTERN_MAX) interned.set(name, name);
  return name;
}

function parseMs(ts: string | null): number | null {
  if (ts === null) return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}
const isDated = (ms: number): boolean => ms > 0;

const isCall = (n: GraphNode): boolean => n.kind === 'tool' || n.kind === 'subagent';
const isActive = (n: GraphNode): boolean => n.status === 'running' || n.status === 'awaiting_permission';
const isFinished = (n: GraphNode): boolean => n.status === 'succeeded' || n.status === 'failed' || n.status === 'denied';
const isFailed = (n: GraphNode): boolean => n.status === 'failed' || n.status === 'denied';

function callDuration(n: GraphNode): number | null {
  if (!isFinished(n)) return null;
  if (n.durationMs !== null) return n.durationMs >= 0 ? n.durationMs : null;
  const start = parseMs(n.timestamp);
  const end = parseMs(n.endedAt);
  if (start === null || end === null || end < start) return null;
  return end - start;
}

/** Duration of a turn at `nowMs` (see SummaryTurn and the spec: in progress counts to now, cut 15 min after activity). */
export function turnDurationMs(turn: SummaryTurn, nowMs: number): number {
  let end = turn.endMs;
  if (turn.open) end = Math.max(end, nowMs - turn.lastActivityMs <= STALE_AFTER_MS ? nowMs : turn.lastActivityMs);
  return Math.max(0, end - turn.startMs);
}

/** `nodes`: the session's nodes in snapshot order (store rowid order; getGraph's order) — it decides the token rule. */
export function summarizeSession(session: Session, nodes: readonly GraphNode[]): SessionSummary {
  const grouped = groupTurns(nodes);
  const turns: SummaryTurn[] = grouped.map((g) => {
    let endMs = g.startMs;
    let lastActivityMs = g.startMs;
    let open = false;
    for (const n of g.nodes) {
      const ts = parseMs(n.timestamp) ?? g.startMs;
      const end = parseMs(n.endedAt) ?? ts;
      if (end > endMs) endMs = end;
      if (Math.max(ts, end) > lastActivityMs) lastActivityMs = Math.max(ts, end);
      if (isActive(n)) open = true;
    }
    return {
      key: g.key, startMs: g.startMs, dated: isDated(g.startMs), endMs, open, lastActivityMs,
      toolCalls: 0, finished: 0, failed: 0, toolMs: 0, inputTokens: 0, outputTokens: 0,
    };
  });
  const last = turns[turns.length - 1];
  if (last !== undefined && (session.status === 'running' || session.status === 'awaiting_permission')) {
    last.open = true;
    const ms = parseMs(session.lastActivityAt);
    if (ms !== null && ms > last.lastActivityMs) last.lastActivityMs = ms;
  }

  // Main-thread node id -> turn index; agent id -> its earliest dispatch node.
  const turnOfMain = new Map<string, number>();
  grouped.forEach((g, i) => {
    for (const n of g.nodes) turnOfMain.set(n.id, i);
  });
  const sorted = nodes
    .map((node) => ({ node, ms: parseMs(node.timestamp) }))
    .sort((a, b) => (a.ms ?? 0) - (b.ms ?? 0) || (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0));
  const dispatchOf = new Map<string, GraphNode>();
  for (const { node } of sorted) {
    if (node.kind === 'subagent' && node.childAgentId !== null && !dispatchOf.has(node.childAgentId)) dispatchOf.set(node.childAgentId, node);
  }
  const agentTurn = new Map<string, number | null>();
  const resolveAgent = (agentId: string): number | null => {
    if (agentTurn.has(agentId)) return agentTurn.get(agentId)!;
    agentTurn.set(agentId, null); // cycle guard
    let result: number | null = null;
    const dispatch = dispatchOf.get(agentId);
    if (dispatch !== undefined) result = dispatch.agentId === null ? turnOfMain.get(dispatch.id) ?? null : resolveAgent(dispatch.agentId);
    agentTurn.set(agentId, result);
    return result;
  };
  /** The latest turn started at or before `ms`, else the first one (turns are sorted by start). */
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

  const counted = new Set(countedUsageNodes(nodes));
  const extras: SummaryExtra[] = [];
  const calls: SummaryCall[] = [];
  let usageNodes = 0;
  for (const { node, ms } of sorted) {
    if (node.usage) usageNodes++;
    const call = isCall(node);
    const counts = counted.has(node);
    let turn: number;
    if (node.agentId === null) turn = turnOfMain.get(node.id)!;
    else if (turns.length === 0) turn = -1;
    else {
      turn = resolveAgent(node.agentId) ?? turnByTime(ms ?? 0);
      // Any internal node is activity of the turn that dispatched it.
      const t = turns[turn]!;
      const activity = Math.max(ms ?? -Infinity, parseMs(node.endedAt) ?? -Infinity);
      if (activity > t.lastActivityMs) t.lastActivityMs = activity;
    }
    if (!call && !counts) continue;
    const target: SummaryTurn | SummaryExtra =
      turn >= 0
        ? turns[turn]!
        : (extras[extras.length] = {
            atMs: ms ?? NaN, dated: ms !== null && isDated(ms), toolCalls: 0, finished: 0, failed: 0, toolMs: 0, inputTokens: 0, outputTokens: 0,
          });
    if (counts) {
      target.inputTokens += node.usage!.inputTokens;
      target.outputTokens += node.usage!.outputTokens;
    }
    if (!call) continue;
    const durationMs = callDuration(node);
    target.toolCalls++;
    if (isFinished(node)) target.finished++;
    if (isFailed(node)) target.failed++;
    if (durationMs !== null) target.toolMs += durationMs;
    calls.push({
      nodeId: node.id, toolName: intern(node.toolName ?? UNKNOWN_TOOL), atMs: ms ?? NaN, turn,
      finished: isFinished(node), failed: isFailed(node), durationMs,
    });
  }
  return { sessionId: session.id, origin: session.origin, projectId: session.projectId, turns, extras, calls, usageNodes };
}
