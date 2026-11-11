import { effectiveStatus, type Graph, type GraphNode, type Session } from '@claude-canvas/shared';
import { isNoise } from './compact';
import { turnNodes, type ViewNode } from './view';

/** What the waterfall panel lists: the main-thread steps of one turn, or the steps of one agent. */
export type WaterfallScope = { type: 'turn'; turnKey: string } | { type: 'agent'; agentId: string };

/**
 * One step. `startMs` / `endMs`: when it ran (equal for a step with no known duration, drawn as a marker). `open`: it
 * is still running or awaiting permission, and `endMs` is "now". `childAgentId`: set for a subagent dispatch whose
 * agent is known (the row can open that agent's steps).
 */
export interface WaterfallRow {
  id: string;
  node: GraphNode;
  startMs: number;
  endMs: number;
  open: boolean;
  childAgentId: string | null;
}
export interface Waterfall {
  rows: WaterfallRow[];
  /** The range of the rows (endMs > startMs; a one-millisecond range when there is nothing to measure). */
  startMs: number;
  endMs: number;
}

/**
 * The scope a canvas selection stands for: a turn's summary node is that turn; a subagent node is its agent, or — while
 * the agent is not known yet (its metadata has not arrived) — the turn it was dispatched in.
 */
export function scopeOf(vn: ViewNode | undefined): WaterfallScope | null {
  if (vn === undefined) return null;
  if (vn.type === 'turn_summary') return { type: 'turn', turnKey: vn.turnKey };
  if (vn.type === 'node' && vn.node.kind === 'subagent') {
    return vn.node.childAgentId !== null ? { type: 'agent', agentId: vn.node.childAgentId } : { type: 'turn', turnKey: vn.turnKey };
  }
  return null;
}

/** `turn:<turnKey>` (also the id of the turn's summary node) or `agent:<agentId>`. */
export function scopeKey(scope: WaterfallScope): string {
  return scope.type === 'turn' ? `turn:${scope.turnKey}` : `agent:${scope.agentId}`;
}

function parseMs(ts: string | null): number | null {
  if (ts === null) return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

function isActive(node: GraphNode): boolean {
  return node.status === 'running' || node.status === 'awaiting_permission';
}

/**
 * The steps of `scope`, by start time then id. Tool and subagent steps run from their timestamp to `endedAt` (or to
 * timestamp + duration; to `nowMs` while still active). A thinking step's timestamp is when its message was recorded,
 * so it runs for its duration up to that time. Other steps are markers. `compact` leaves out thinking steps without
 * text and system steps other than compaction / interrupt (see isNoise). A step whose timestamp cannot be read is put
 * at the earliest readable time of the scope (it must not stretch the range back to 1970).
 */
export function buildWaterfall(graph: Graph, scope: WaterfallScope, options: { compact: boolean; nowMs: number }): Waterfall {
  const nodes = scope.type === 'turn'
    ? turnNodes(graph, scope.turnKey)
    : Object.values(graph.nodes).filter((n) => n.agentId === scope.agentId);
  const rows: WaterfallRow[] = [];
  let earliest: number | null = null;
  for (const node of nodes) {
    const ms = parseMs(node.timestamp);
    if (ms !== null && (earliest === null || ms < earliest)) earliest = ms;
  }
  for (const node of nodes) {
    if (options.compact && isNoise(node)) continue;
    const at = parseMs(node.timestamp) ?? earliest ?? 0;
    let startMs = at;
    let endMs = at;
    const open = isActive(node);
    if (node.kind === 'thinking') {
      startMs = at - Math.max(0, node.durationMs ?? 0);
    } else if (open) {
      endMs = Math.max(at, options.nowMs);
    } else {
      endMs = Math.max(at, parseMs(node.endedAt) ?? at + Math.max(0, node.durationMs ?? 0));
    }
    rows.push({ id: node.id, node, startMs, endMs, open, childAgentId: node.kind === 'subagent' ? node.childAgentId : null });
  }
  rows.sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let startMs = Infinity;
  let endMs = -Infinity;
  for (const r of rows) {
    if (r.startMs < startMs) startMs = r.startMs;
    if (r.endMs > endMs) endMs = r.endMs;
  }
  if (rows.length === 0) return { rows, startMs: 0, endMs: 1 };
  return { rows, startMs, endMs: Math.max(endMs, startMs + 1) };
}

/** Background work still counts as progressing for this long after the session's last activity (see waterfallClock). */
export const QUIET_AFTER_MS = 5 * 60_000;

/**
 * Whether work is progressing, and the "now" still-open steps end at, for the main thread and for background work.
 *  - Main thread (`ticking`, `nowMs`): while the session is running or awaiting a permission. Otherwise (idle, ended,
 *    waiting for input, or running but silent for too long) a main-thread step still open was cut off: it ends at the
 *    session's last activity.
 *  - Background work — a subagent's steps and its dispatch node (`backgroundTicking`, `backgroundNowMs`): also, unless
 *    the session has ended, for QUIET_AFTER_MS after its last activity. Background agents go on working while the main
 *    thread is idle, and their records move the last activity but not the session's status.
 */
export interface WaterfallClock { nowMs: number; ticking: boolean; backgroundNowMs: number; backgroundTicking: boolean }
export function waterfallClock(session: Pick<Session, 'status' | 'lastActivityAt'>, nowMs: number): WaterfallClock {
  const status = effectiveStatus(session, nowMs);
  const parsed = Date.parse(session.lastActivityAt);
  const last = Number.isNaN(parsed) ? nowMs : parsed;
  const ticking = status === 'running' || status === 'awaiting_permission';
  const backgroundTicking = ticking || (status !== 'ended' && !Number.isNaN(parsed) && nowMs - parsed < QUIET_AFTER_MS);
  return { nowMs: ticking ? nowMs : last, ticking, backgroundNowMs: backgroundTicking ? nowMs : last, backgroundTicking };
}

/** A subagent's step, or the node that dispatched a subagent: background work in the sense of waterfallClock. */
export function isBackgroundStep(node: Pick<GraphNode, 'agentId' | 'kind'>): boolean {
  return node.agentId !== null || node.kind === 'subagent';
}

/** Whether a step of this kind is being worked on right now, by the clock. */
export function stepTicking(clock: Pick<WaterfallClock, 'ticking' | 'backgroundTicking'>, node: Pick<GraphNode, 'agentId' | 'kind'>): boolean {
  return isBackgroundStep(node) ? clock.backgroundTicking : clock.ticking;
}

/** Where the duration label of a bar goes: after it, before it, or inside it when it leaves no room on either side. */
export function durationPlacement(left: number, width: number): 'after' | 'before' | 'inside' {
  if (left + width < 0.75) return 'after';
  return left > 0.25 ? 'before' : 'inside';
}

/**
 * `w` (built with nowMs 0) with its open rows ending at the clock's "now" for their kind of step. Rows that are not
 * open keep their objects, so only the open rows look changed to a memoized list.
 */
export function withNow(w: Waterfall, clock: Pick<WaterfallClock, 'nowMs' | 'backgroundNowMs'>): Waterfall {
  let endMs = w.startMs + 1;
  const rows = w.rows.map((r) => {
    const row = r.open ? { ...r, endMs: Math.max(r.startMs, isBackgroundStep(r.node) ? clock.backgroundNowMs : clock.nowMs) } : r;
    if (row.endMs > endMs) endMs = row.endMs;
    return row;
  });
  return rows.length === 0 ? w : { rows, startMs: w.startMs, endMs };
}

/** Where a row's bar sits on the track, as fractions of the range (0..1). */
export function barOf(w: Pick<Waterfall, 'startMs' | 'endMs'>, row: Pick<WaterfallRow, 'startMs' | 'endMs'>): { left: number; width: number } {
  const span = w.endMs - w.startMs;
  const left = Math.min(1, Math.max(0, (row.startMs - w.startMs) / span));
  const right = Math.min(1, Math.max(left, (row.endMs - w.startMs) / span));
  return { left, width: right - left };
}

const incomingIndex = new WeakMap<Graph, Map<string, string[]>>();
/** Node id -> the nodes with an edge into it (any kind); built once per graph object. */
function incomingOf(graph: Graph): Map<string, string[]> {
  const known = incomingIndex.get(graph);
  if (known) return known;
  const incoming = new Map<string, string[]>();
  for (const e of Object.values(graph.edges)) {
    let list = incoming.get(e.to);
    if (!list) incoming.set(e.to, (list = []));
    list.push(e.from);
  }
  incomingIndex.set(graph, incoming);
  return incoming;
}

/**
 * The steps that led to `stepId`: the graph's edges walked backwards from it (breadth first, each node once), through
 * an agent's first step into the node that dispatched it, up to and including the main-thread prompt of the turn (where
 * the walk ends). `ids` includes the start; `reasoning`: the thinking / text nodes among them, by time then id. Empty
 * for null or an unknown id.
 *
 * `direct`: what the step was decided on — walking back from it, the first thinking / reply steps met on each path,
 * together with the thinking / reply steps right before those (one message's thinking and reply, say); the turn's
 * prompt when a path reaches it without meeting any; inside an agent, the agent's task prompt counts like a reply. A
 * thinking step without text is passed through, not counted. In a
 * turn whose steps follow one another `ids` is simply everything before the step; `direct` is the part worth reading.
 */
export function stepChain(graph: Graph, stepId: string | null): {
  ids: ReadonlySet<string>; reasoning: GraphNode[]; direct: ReadonlySet<string>;
} {
  const ids = new Set<string>();
  const reasoning: GraphNode[] = [];
  const direct = directBasis(graph, stepId);
  if (stepId === null || graph.nodes[stepId] === undefined) return { ids, reasoning, direct };
  const incoming = incomingOf(graph);
  const queue = [stepId];
  ids.add(stepId);
  for (let head = 0; head < queue.length; head++) {
    const node = graph.nodes[queue[head]!];
    if (node === undefined) continue;
    if (node.kind === 'thinking' || node.kind === 'text') reasoning.push(node);
    if (node.kind === 'prompt' && node.agentId === null) continue; // the turn's prompt ends the walk
    for (const from of incoming.get(node.id) ?? []) {
      if (!ids.has(from) && graph.nodes[from] !== undefined) {
        ids.add(from);
        queue.push(from);
      }
    }
  }
  const ms = (n: GraphNode): number => parseMs(n.timestamp) ?? 0;
  reasoning.sort((a, b) => ms(a) - ms(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ids, reasoning, direct };
}

function directBasis(graph: Graph, stepId: string | null): Set<string> {
  const direct = new Set<string>();
  if (stepId === null || graph.nodes[stepId] === undefined) return direct;
  const incoming = incomingOf(graph);
  // An agent's task prompt is what its steps were decided on, like a reply or a thought.
  const says = (n: GraphNode): boolean =>
    n.kind === 'text' || (n.kind === 'thinking' && n.summary !== '') || (n.kind === 'prompt' && n.agentId !== null);
  const isTurnPrompt = (n: GraphNode): boolean => n.kind === 'prompt' && n.agentId === null;
  // `inRun`: the walk has reached reasoning on this path and only continues through more of it.
  const seen = new Set<string>([`0${stepId}`]);
  const queue: { id: string; inRun: boolean }[] = [{ id: stepId, inRun: false }];
  for (let head = 0; head < queue.length; head++) {
    const { id, inRun } = queue[head]!;
    const node = graph.nodes[id]!;
    if (isTurnPrompt(node)) continue;
    for (const from of incoming.get(id) ?? []) {
      const prev = graph.nodes[from];
      if (prev === undefined) continue;
      const passThrough = prev.kind === 'thinking' && prev.summary === '';
      let next: boolean;
      if (says(prev)) {
        direct.add(from);
        next = true;
      } else if (passThrough) {
        next = inRun;
      } else if (inRun) {
        continue; // the run of reasoning ends at a step of another kind
      } else {
        if (isTurnPrompt(prev)) direct.add(from);
        next = false;
      }
      const key = `${next ? 1 : 0}${from}`;
      if (!seen.has(key)) {
        seen.add(key);
        queue.push({ id: from, inRun: next });
      }
    }
  }
  return direct;
}
