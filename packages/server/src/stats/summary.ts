import { groupTurns, STALE_AFTER_MS, type GraphNode, type Origin, type Session } from '@agent-canvas/shared';

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
 *   (dated by its own timestamp).
 * - Tokens: node usage, each messageId counted once per session (the first node in time order carrying it), as the
 *   session page's totals do (web replay.ts usageTotal).
 */

export interface SummaryTurn {
  key: string;
  startMs: number;
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

/** Internal nodes of a session without any main-thread turn: one per node that is a call or carries usage. */
export interface SummaryExtra {
  atMs: number;
  toolCalls: number;
  finished: number;
  failed: number;
  toolMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface SummaryCall {
  nodeId: string;
  toolName: string;
  /** The node's timestamp (ms, 0 when unparseable) and as stored. */
  atMs: number;
  startedAt: string;
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

function parseMs(ts: string | null): number | null {
  if (ts === null) return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

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
    return { key: g.key, startMs: g.startMs, endMs, open, lastActivityMs, toolCalls: 0, finished: 0, failed: 0, toolMs: 0, inputTokens: 0, outputTokens: 0 };
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
  const sorted = [...nodes]
    .map((node) => ({ node, ms: parseMs(node.timestamp) ?? 0 }))
    .sort((a, b) => a.ms - b.ms || (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0));
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

  const extras: SummaryExtra[] = [];
  const calls: SummaryCall[] = [];
  const seenMessages = new Set<string>();
  let usageNodes = 0;
  for (const { node, ms } of sorted) {
    const call = isCall(node);
    let input = 0;
    let output = 0;
    if (node.usage !== null) {
      usageNodes++;
      if (node.messageId === null || !seenMessages.has(node.messageId)) {
        if (node.messageId !== null) seenMessages.add(node.messageId);
        input = node.usage.inputTokens;
        output = node.usage.outputTokens;
      }
    }
    if (!call && node.usage === null) continue;
    let turn: number;
    if (node.agentId === null) turn = turnOfMain.get(node.id)!;
    else if (turns.length === 0) turn = -1;
    else turn = resolveAgent(node.agentId) ?? turnByTime(ms);
    const target: SummaryTurn | SummaryExtra =
      turn >= 0 ? turns[turn]! : (extras[extras.length] = { atMs: ms, toolCalls: 0, finished: 0, failed: 0, toolMs: 0, inputTokens: 0, outputTokens: 0 });
    target.inputTokens += input;
    target.outputTokens += output;
    if (turn >= 0 && node.agentId !== null) {
      const t = turns[turn]!;
      const activity = Math.max(ms, parseMs(node.endedAt) ?? ms);
      if (activity > t.lastActivityMs) t.lastActivityMs = activity;
    }
    if (!call) continue;
    const durationMs = callDuration(node);
    target.toolCalls++;
    if (isFinished(node)) target.finished++;
    if (isFailed(node)) target.failed++;
    if (durationMs !== null) target.toolMs += durationMs;
    calls.push({
      nodeId: node.id, toolName: node.toolName ?? node.title, atMs: ms, startedAt: node.timestamp, turn,
      finished: isFinished(node), failed: isFailed(node), durationMs,
    });
  }
  return { sessionId: session.id, origin: session.origin, projectId: session.projectId, turns, extras, calls, usageNodes };
}
