import { usageTotal, type Graph, type GraphNode, type Session } from '@agent-canvas/shared';
import { byTimeThenId, groupByTurn, type Entry } from './view';
import { isBackgroundStep, parseMs, stepSpan, type WaterfallClock } from './waterfall';

/**
 * Where a session's time went, by thread (the 时间线 view; spec docs/superpowers/specs/2026-11-24-agent-timeline-design.md).
 *
 * Threads: the main thread (nodes with agentId null) and one per agent (its agentId), plus one per dispatch whose agent is
 * not known (`unmatched:<dispatch id>`). Step intervals and "now" follow the waterfall (stepSpan, WaterfallClock).
 *
 * - Blocking: when a thread is held up by one of its agents. Every origin but Codex: a dispatch blocks its thread from
 *   its start until the earlier of its end and the first later step of that thread that is neither a dispatch nor part
 *   of the dispatch's message (same messageId; without a messageId, the same timestamp). A background dispatch so stops
 *   blocking once its thread carries on. A main-thread dispatch still open blocks no later than the main thread's "now".
 *   Codex: dispatches and follow-ups never block; a `wait_agent` step blocks for its interval, on the agents its input
 *   names (read from its summary), else on the thread's own agents active during it.
 * - Total: the union of the turns' intervals. A turn runs from its first step to the later of its last main-thread step
 *   that is not a dispatch / wait_agent and the end of the main thread's blocking that starts in it; the latest turn to
 *   "now" while the main thread is ticking.
 * - Attribution: each moment of the total belongs to one thread. Starting at the main thread: a thread that is busy (a
 *   step other than a dispatch / wait_agent running) or not blocked keeps the moment; otherwise it passes to the
 *   blocking agent whose block ends last (key; ties: the smaller id), and so on down; a blocker already on the chain
 *   (a dispatch cycle) leaves the moment where it is.
 * - Own time: one segment per dispatch of the agent (Codex follow-ups count as dispatches): from the dispatch to the end
 *   of the agent's last step before its next dispatch (and the dispatch's own end when it ended by then); an agent still
 *   working runs to the background "now". Overlapping segments are merged.
 */

export interface TimeSpan { startMs: number; endMs: number }

export interface ThreadTime {
  /** 'main', the agent id, or 'unmatched:<dispatchNodeId>' for a dispatch without childAgentId. */
  id: string;
  /** null for main and for orphan threads. */
  parentId: string | null;
  /** The dispatch node's title (an orphan: its agent id); ' #n' added to equal names in order of appearance. */
  label: string;
  /** The dispatch nodes (and Codex follow-ups) of this thread, in order. */
  dispatchIds: string[];
  /** Own-time segments, by start, not overlapping. Main: the turns' union. */
  segments: TimeSpan[];
  /** Where this thread was waiting on its own agents (drawn light). Main: inside the total only. */
  waitingSpans: TimeSpan[];
  /** Sum of segments; main: its own attributed time. */
  ownMs: number;
  /** Time attributed to this thread (main: 0; see AgentTimeline.mainWaitMs). */
  waitMs: number;
  /** Still running by the clock. */
  open: boolean;
  steps: number;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
  children: ThreadTime[];
}

export interface AgentTimeline {
  available: true;
  totalMs: number;
  turns: number;
  mainOwnMs: number;
  mainWaitMs: number;
  /** Main, its agents below it; orphan threads appended to its children (same level as main's own agents). */
  root: ThreadTime;
  /** The orphan threads (also in root.children). */
  orphans: ThreadTime[];
  /** breaks: gaps between turns longer than BREAK_AFTER_MS with no agent at work, to be drawn compressed. */
  axis: { startMs: number; endMs: number; breaks: TimeSpan[] };
  longestWaitId: string | null;
}

export type AgentTimelineResult = AgentTimeline | { available: false; reason: 'no-times' };

/** A quiet gap between turns longer than this becomes a break on the axis. */
export const BREAK_AFTER_MS = 5 * 60_000;
export const MAIN_THREAD_ID = 'main';
const MAIN_LABEL = '主线';

interface Step extends Entry {
  /** Where the step is placed: its timestamp, else the earliest readable time of its turn / agent; null: none. */
  at: number | null;
  startMs: number;
  endMs: number;
  open: boolean;
}
interface Block { startMs: number; endMs: number; key: number; blocker: string }
interface Piece { startMs: number; endMs: number; blocker: string }

interface Thread {
  id: string;
  /** By time then id (the order buildView uses). */
  steps: Step[];
  /** In graph order (tokens count as on the session page). */
  nodes: GraphNode[];
  /** Dispatch nodes of this thread's agent, and Codex follow-ups to it. */
  points: Step[];
  claimed: boolean;
  parentId: string | null;
  children: Thread[];
  blocks: Block[];
  /** Blocked and not busy, with the blocker; by time, not overlapping. */
  waits: Piece[];
  attributed: number;
  prefixEnd: Float64Array | null;
}

const NO_TIMES: AgentTimelineResult = { available: false, reason: 'no-times' };

export function computeAgentTimeline(
  graph: Graph, session: Pick<Session, 'origin' | 'status' | 'lastActivityAt'>, clock: WaterfallClock,
): AgentTimelineResult {
  if (session.origin === 'doubao') return NO_TIMES;
  const codex = session.origin === 'codex';
  const isWait = (n: GraphNode): boolean => codex && n.kind === 'tool' && baseName(n) === 'wait_agent';
  const isFollowUp = (n: GraphNode): boolean => {
    if (!codex || n.kind !== 'tool') return false;
    const name = baseName(n);
    return name === 'followup_task' || name === 'send_message';
  };

  // Threads and their steps.
  const threads = new Map<string, Thread>();
  const threadOf = (id: string): Thread => {
    let t = threads.get(id);
    if (!t) {
      t = { id, steps: [], nodes: [], points: [], claimed: false, parentId: null, children: [], blocks: [], waits: [], attributed: 0, prefixEnd: null };
      threads.set(id, t);
    }
    return t;
  };
  const main = threadOf(MAIN_THREAD_ID);
  let nodeCount = 0;
  let anyReadable = false;
  for (const node of Object.values(graph.nodes)) {
    nodeCount++;
    const th = threadOf(node.agentId ?? MAIN_THREAD_ID);
    const at = parseMs(node.timestamp);
    if (at !== null) anyReadable = true;
    th.nodes.push(node);
    th.steps.push({ node, ms: at ?? 0, at, startMs: 0, endMs: 0, open: false });
  }
  if (nodeCount > 0 && !anyReadable) return NO_TIMES;
  const withNodes = [...threads.values()];
  for (const th of withNodes) th.steps.sort(byTimeThenId);

  // Unreadable timestamps: the earliest readable time of the turn (main) or of the agent, as the waterfall places them.
  const { groups, turnOf } = groupByTurn(main.steps);
  for (const entries of groups.values()) fillUnreadable(entries as Step[]);
  for (const th of withNodes) if (th !== main) fillUnreadable(th.steps);
  for (const th of withNodes) {
    for (const s of th.steps) {
      if (s.at === null) continue;
      const span = stepSpan(s.node, s.at, isBackgroundStep(s.node) ? clock.backgroundNowMs : clock.nowMs);
      s.startMs = span.startMs;
      s.endMs = span.endMs;
      s.open = span.open;
    }
  }

  // Dispatch points; a dispatch without end time that is not running ends with its agent's last step (spec 3.1).
  const targetOf = new Map<Step, Thread>();
  for (const th of withNodes) {
    for (const s of th.steps) {
      if (s.node.kind !== 'subagent') continue;
      const target = threadOf(s.node.childAgentId ?? `unmatched:${s.node.id}`);
      targetOf.set(s, target);
      target.points.push(s);
    }
  }
  for (const [s, target] of targetOf) {
    if (s.at === null || s.open || parseMs(s.node.endedAt) !== null || s.node.durationMs !== null) continue;
    let last = -Infinity;
    for (const x of target.steps) if (x.at !== null && x.endMs > last) last = x.endMs;
    if (last > s.endMs) s.endMs = last;
  }

  // Codex: which agents a wait / follow-up names.
  const names = codex ? nameIndex(threads) : new Map<string, Thread[]>();
  const followUps = new Map<Step, Thread>();
  if (codex) {
    for (const th of withNodes) {
      for (const s of th.steps) {
        if (s.at === null || !isFollowUp(s.node)) continue;
        const target = pickFollowUpTarget(refsOf(s.node.summary, names), s.ms);
        if (target === null) continue;
        followUps.set(s, target);
        target.points.push(s);
      }
    }
  }
  for (const th of threads.values()) th.points.sort(byTimeThenId);

  // The thread tree: breadth first from main, each agent under the first thread found dispatching it; then orphans.
  const claim = (root: Thread, parentId: string | null): void => {
    root.claimed = true;
    root.parentId = parentId;
    const queue = [root];
    for (let k = 0; k < queue.length; k++) {
      const p = queue[k]!;
      for (const s of p.steps) {
        const c = targetOf.get(s);
        if (c === undefined || c.claimed) continue;
        c.claimed = true;
        c.parentId = p.id;
        p.children.push(c);
        queue.push(c);
      }
    }
  };
  claim(main, null);
  const orphanRoots: Thread[] = [];
  const unclaimed = [...threads.values()].filter((t) => !t.claimed)
    .sort((a, b) => firstMs(a) - firstMs(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const t of unclaimed) {
    if (t.claimed) continue;
    claim(t, null);
    orphanRoots.push(t);
  }

  // Blocking intervals.
  /** Main-thread turn key -> the latest end of the main thread's blocking that starts in it. */
  const blockEnd = new Map<string, number>();
  for (const th of threads.values()) {
    for (const s of th.steps) {
      if (s.at === null) continue;
      let end = s.startMs;
      if (!codex && s.node.kind === 'subagent') {
        end = s.endMs;
        const cut = carriesOnAt(th.steps, s);
        if (cut !== null && cut < end) end = cut;
        if (th === main && s.open) end = Math.min(end, Math.max(s.startMs, clock.nowMs));
        if (end > s.startMs) th.blocks.push({ startMs: s.startMs, endMs: end, key: end, blocker: targetOf.get(s)!.id });
      } else if (isWait(s.node) && s.endMs > s.startMs) {
        const targets = waitTargets(th, s);
        if (targets.length > 0) end = s.endMs;
        for (const target of targets) {
          const key = Math.min(s.endMs, Math.max(s.startMs, lastEndBefore(target, s.endMs)));
          th.blocks.push({ startMs: s.startMs, endMs: s.endMs, key, blocker: target.id });
        }
      }
      const turn = th === main && end > s.startMs ? turnOf.get(s.node.id) : undefined;
      if (turn !== undefined) blockEnd.set(turn, Math.max(blockEnd.get(turn) ?? -Infinity, end));
    }
  }
  function waitTargets(th: Thread, w: Step): Thread[] {
    const named = new Set<Thread>();
    for (const list of refsOf(w.node.summary, names)) {
      const active = list.filter((t) => lastEndBefore(t, w.endMs) > w.startMs);
      for (const t of active.length > 0 ? active : list) named.add(t);
    }
    if (named.size > 0) return [...named];
    // Nothing named: the thread's own agents that worked during the wait.
    const own = new Set<Thread>();
    for (const s of th.steps) {
      const t = targetOf.get(s) ?? followUps.get(s);
      if (t !== undefined && lastEndBefore(t, w.endMs) > w.startMs) own.add(t);
    }
    return [...own];
  }
  function lastEndBefore(t: Thread, ms: number): number {
    if (t.prefixEnd === null) {
      t.prefixEnd = new Float64Array(t.steps.length);
      let max = -Infinity;
      t.steps.forEach((x, i) => {
        if (x.at !== null && x.endMs > max) max = x.endMs;
        t.prefixEnd![i] = max;
      });
    }
    const i = lowerBound(t.steps, ms);
    return i > 0 ? t.prefixEnd[i - 1]! : -Infinity;
  }

  // Where each thread is held up and not busy.
  for (const th of threads.values()) {
    if (th.blocks.length === 0) continue;
    const busy: TimeSpan[] = [];
    for (const s of th.steps) {
      if (s.at !== null && s.endMs > s.startMs && s.node.kind !== 'subagent' && !isWait(s.node)) busy.push({ startMs: s.startMs, endMs: s.endMs });
    }
    th.waits = subtract(heldUp(th.blocks), mergeSpans(busy));
  }

  // Turns and the total.
  const turnSpans: TimeSpan[] = [];
  let latest: TimeSpan | null = null;
  for (const [key, entries] of groups) {
    let start = Infinity;
    let end = -Infinity;
    for (const e of entries as Step[]) {
      if (e.at === null) continue;
      if (e.startMs < start) start = e.startMs;
      if (e.node.kind !== 'subagent' && !isWait(e.node) && e.endMs > end) end = e.endMs;
    }
    if (start === Infinity) continue;
    const span = { startMs: start, endMs: Math.max(start, end, blockEnd.get(key) ?? -Infinity) };
    turnSpans.push(span);
    if (latest === null || span.startMs >= latest.startMs) latest = span;
  }
  if (latest !== null && clock.ticking) latest.endMs = Math.max(latest.endMs, clock.nowMs);
  const total = mergeSpans(turnSpans);
  let totalMs = 0;
  for (const u of total) totalMs += u.endMs - u.startMs;

  // Attribution.
  const chain = new Set<Thread>([main]);
  const attribute = (th: Thread, a: number, b: number): void => {
    let covered = 0;
    const w = th.waits;
    for (let i = firstEndingAfter(w, a); i < w.length && w[i]!.startMs < b; i++) {
      const c = Math.max(a, w[i]!.startMs);
      const d = Math.min(b, w[i]!.endMs);
      const next = threads.get(w[i]!.blocker);
      if (d <= c || next === undefined || chain.has(next)) continue;
      chain.add(next);
      attribute(next, c, d);
      chain.delete(next);
      covered += d - c;
    }
    th.attributed += b - a - covered;
  };
  for (const u of total) attribute(main, u.startMs, u.endMs);

  // Own time, labels, the tree.
  const segmentsOf = new Map<Thread, TimeSpan[]>();
  const openOf = new Map<Thread, boolean>();
  for (const th of threads.values()) {
    if (th === main) continue;
    const { segments, active } = ownSegments(th, clock);
    segmentsOf.set(th, segments);
    openOf.set(th, active && clock.backgroundTicking);
  }
  const labels = labelThreads([...segmentsOf.keys()]);

  const build = (th: Thread): ThreadTime => {
    const isMain = th === main;
    const segments = isMain ? total : segmentsOf.get(th)!;
    const waiting = isMain ? intersect(th.waits, total) : mergeSpans(th.waits);
    let ownMs = 0;
    if (isMain) ownMs = th.attributed;
    else for (const s of segments) ownMs += s.endMs - s.startMs;
    return {
      id: th.id,
      parentId: th.parentId,
      label: isMain ? MAIN_LABEL : labels.get(th)!,
      dispatchIds: th.points.map((p) => p.node.id),
      segments,
      waitingSpans: waiting,
      ownMs,
      waitMs: isMain ? 0 : th.attributed,
      open: isMain ? clock.ticking : openOf.get(th)!,
      steps: th.nodes.length,
      usage: usageTotal(th.nodes),
      children: th.children.map(build),
    };
  };
  const root = build(main);
  const orphans = orphanRoots.map(build);
  root.children.push(...orphans);

  // The axis and its breaks.
  const activity = mergeSpans([...segmentsOf.values()].flat());
  let axisStart = Infinity;
  let axisEnd = -Infinity;
  for (const s of [...total, ...activity]) {
    if (s.startMs < axisStart) axisStart = s.startMs;
    if (s.endMs > axisEnd) axisEnd = s.endMs;
  }
  const breaks: TimeSpan[] = [];
  for (let i = 1; i < total.length; i++) {
    const gap = { startMs: total[i - 1]!.endMs, endMs: total[i]!.startMs, blocker: '' };
    for (const free of subtract([gap], activity)) {
      if (free.endMs - free.startMs > BREAK_AFTER_MS) breaks.push({ startMs: free.startMs, endMs: free.endMs });
    }
  }
  const axis = axisStart === Infinity
    ? { startMs: 0, endMs: 1, breaks }
    : { startMs: axisStart, endMs: Math.max(axisEnd, axisStart + 1), breaks };

  let longestWaitId: string | null = null;
  let longest = 0;
  for (const th of threads.values()) {
    if (th === main || th.attributed <= 0) continue;
    if (th.attributed > longest || (th.attributed === longest && longestWaitId !== null && th.id < longestWaitId)) {
      longest = th.attributed;
      longestWaitId = th.id;
    }
  }

  return {
    available: true,
    totalMs,
    turns: turnSpans.length,
    mainOwnMs: main.attributed,
    mainWaitMs: totalMs - main.attributed,
    root,
    orphans,
    axis,
    longestWaitId,
  };
}

/** `t` with its agents' rows sorted among siblings (recursively): by wait time (longest first) or start; ties by id. */
export function sortThreads(t: ThreadTime, by: 'wait' | 'start'): ThreadTime {
  const startOf = (x: ThreadTime): number => x.segments[0]?.startMs ?? Infinity;
  const order = by === 'wait'
    ? (a: ThreadTime, b: ThreadTime): number => b.waitMs - a.waitMs || byId(a, b)
    : (a: ThreadTime, b: ThreadTime): number => (startOf(a) === startOf(b) ? 0 : startOf(a) - startOf(b)) || byId(a, b);
  return { ...t, children: t.children.map((c) => sortThreads(c, by)).sort(order) };
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The name of a tool without its namespace (`collaboration.wait_agent` -> `wait_agent`). */
function baseName(n: GraphNode): string {
  const name = n.toolName ?? n.title;
  return name.slice(name.lastIndexOf('.') + 1);
}

function firstMs(t: Thread): number {
  return t.steps[0]?.ms ?? Infinity;
}

/** Gives steps whose timestamp cannot be read the earliest readable time among `steps` (none: they stay without one). */
function fillUnreadable(steps: Step[]): void {
  let earliest: number | null = null;
  for (const s of steps) if (s.at !== null && (earliest === null || s.at < earliest)) earliest = s.at;
  if (earliest === null) return;
  for (const s of steps) if (s.at === null) s.at = earliest;
}

/** First index of `steps` (by ms) whose ms is at least `ms`. */
function lowerBound(steps: readonly Entry[], ms: number): number {
  let lo = 0;
  let hi = steps.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (steps[mid]!.ms < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index of `spans` (by time, not overlapping) that ends after `ms`. */
function firstEndingAfter(spans: readonly TimeSpan[], ms: number): number {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (spans[mid]!.endMs <= ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * When the thread of dispatch `d` carries on without it: the start (not before d's) of its first step recorded after d
 * that is neither a dispatch nor part of d's message. A step with d's own timestamp is part of its message whatever
 * its messageId (this is the rule for origins without message ids); a later one is when it has d's messageId (the
 * parallel calls of one Claude message are written one record after another). Null when there is none.
 */
function carriesOnAt(steps: readonly Step[], d: Step): number | null {
  for (let i = lowerBound(steps, d.ms + 1); i < steps.length; i++) {
    const n = steps[i]!;
    if (n.at === null || n.node.kind === 'subagent') continue;
    if (d.node.messageId !== null && n.node.messageId === d.node.messageId) continue;
    return Math.max(d.startMs, n.startMs);
  }
  return null;
}

/** Codex: agent names -> threads. An agent is known by its id, its dispatch's title and summary (the task name). */
function nameIndex(threads: ReadonlyMap<string, Thread>): Map<string, Thread[]> {
  const names = new Map<string, Thread[]>();
  const add = (name: string, t: Thread): void => {
    if (name === '') return;
    const list = names.get(name);
    if (!list) names.set(name, [t]);
    else if (!list.includes(t)) list.push(t);
  };
  for (const t of threads.values()) {
    if (t.id === MAIN_THREAD_ID || t.id.startsWith('unmatched:')) continue;
    add(t.id, t);
    for (const p of t.points) {
      add(p.node.title, t);
      add(p.node.summary, t);
    }
  }
  return names;
}

const QUOTED = /"((?:[^"\\]|\\.)*)"/g;

/** The agents a Codex call's summary (its input as JSON, maybe cut short) names: one list of candidates per name found. */
function refsOf(summary: string, names: ReadonlyMap<string, Thread[]>): Thread[][] {
  const strings = [summary];
  for (const m of summary.matchAll(QUOTED)) {
    try {
      strings.push(JSON.parse(m[0]) as string);
    } catch {
      strings.push(m[1]!);
    }
  }
  const out: Thread[][] = [];
  for (const s of strings) {
    const found = names.get(s) ?? names.get(s.slice(s.lastIndexOf('/') + 1));
    if (found !== undefined) out.push(found);
  }
  return out;
}

/**
 * The agent a follow-up at `ms` goes to: of the candidates for the first name it gives, the one spawned last before it
 * (ties: the smaller id); none spawned before it: the first candidate.
 */
function pickFollowUpTarget(refs: Thread[][], ms: number): Thread | null {
  const list = refs[0];
  if (list === undefined) return null;
  let best: Thread | null = null;
  let bestMs = -Infinity;
  for (const t of list) {
    let spawned = Infinity;
    for (const p of t.points) if (p.node.kind === 'subagent' && p.ms < spawned) spawned = p.ms;
    if (spawned > ms) continue;
    if (best === null || spawned > bestMs || (spawned === bestMs && t.id < best.id)) {
      best = t;
      bestMs = spawned;
    }
  }
  return best ?? list[0]!;
}

/** Sorted, merged (touching or overlapping spans become one). Does not change its input. */
function mergeSpans(spans: readonly TimeSpan[]): TimeSpan[] {
  const sorted = [...spans].sort((a, b) => a.startMs - b.startMs);
  const out: TimeSpan[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && s.startMs <= last.endMs) {
      if (s.endMs > last.endMs) last.endMs = s.endMs;
    } else out.push({ startMs: s.startMs, endMs: s.endMs });
  }
  return out;
}

/** The parts of `pieces` (by time, not overlapping) outside `holes` (merged). */
function subtract(pieces: readonly Piece[], holes: readonly TimeSpan[]): Piece[] {
  const out: Piece[] = [];
  let h = 0;
  for (const p of pieces) {
    while (h < holes.length && holes[h]!.endMs <= p.startMs) h++;
    let cur = p.startMs;
    for (let k = h; cur < p.endMs; k++) {
      const hole = holes[k];
      if (hole === undefined || hole.startMs >= p.endMs) {
        out.push({ startMs: cur, endMs: p.endMs, blocker: p.blocker });
        break;
      }
      if (hole.startMs > cur) out.push({ startMs: cur, endMs: hole.startMs, blocker: p.blocker });
      if (hole.endMs > cur) cur = hole.endMs;
    }
  }
  return out;
}

/** The parts of `pieces` inside `spans` (both by time, not overlapping), merged. */
function intersect(pieces: readonly TimeSpan[], spans: readonly TimeSpan[]): TimeSpan[] {
  const out: TimeSpan[] = [];
  let j = 0;
  for (const p of pieces) {
    while (j < spans.length && spans[j]!.endMs <= p.startMs) j++;
    for (let k = j; k < spans.length && spans[k]!.startMs < p.endMs; k++) {
      const a = Math.max(p.startMs, spans[k]!.startMs);
      const b = Math.min(p.endMs, spans[k]!.endMs);
      if (b <= a) continue;
      const last = out[out.length - 1];
      if (last !== undefined && last.endMs === a) last.endMs = b;
      else out.push({ startMs: a, endMs: b });
    }
  }
  return out;
}

/** When a thread is held up, and by which agent: of the blocks active at a moment, the one ending last (key; ties: smaller blocker id). */
function heldUp(blocks: readonly Block[]): Piece[] {
  const byStart = [...blocks].sort((a, b) => a.startMs - b.startMs);
  const byEnd = [...blocks].sort((a, b) => a.endMs - b.endMs);
  const active = new Set<Block>();
  const out: Piece[] = [];
  let i = 0;
  let j = 0;
  let prev = -Infinity;
  while (i < byStart.length || j < byEnd.length) {
    const t = Math.min(byStart[i]?.startMs ?? Infinity, byEnd[j]?.endMs ?? Infinity);
    if (active.size > 0 && t > prev) {
      let top: Block | null = null;
      for (const b of active) {
        if (top === null || b.key > top.key || (b.key === top.key && b.blocker < top.blocker)) top = b;
      }
      const last = out[out.length - 1];
      if (last !== undefined && last.blocker === top!.blocker && last.endMs === prev) last.endMs = t;
      else out.push({ startMs: prev, endMs: t, blocker: top!.blocker });
    }
    while (j < byEnd.length && byEnd[j]!.endMs === t) active.delete(byEnd[j++]!);
    while (i < byStart.length && byStart[i]!.startMs === t) active.add(byStart[i++]!);
    prev = t;
  }
  return out;
}

/**
 * An agent's own-time segments (see the module comment) and whether it is still at work (a step or a dispatch of it
 * still running). Without any dispatch (an orphan): from its first step to its last.
 */
function ownSegments(th: Thread, clock: WaterfallClock): { segments: TimeSpan[]; active: boolean } {
  const points = th.points.filter((p) => p.at !== null);
  const steps = th.steps.filter((s) => s.at !== null);
  const active = steps.some((s) => s.open) || points.some((p) => p.node.kind === 'subagent' && p.open);
  let segments: TimeSpan[];
  if (points.length === 0) {
    if (steps.length === 0) return { segments: [], active };
    let start = Infinity;
    let end = -Infinity;
    for (const s of steps) {
      if (s.startMs < start) start = s.startMs;
      if (s.endMs > end) end = s.endMs;
    }
    segments = [{ startMs: start, endMs: end }];
  } else {
    segments = points.map((p) => ({ startMs: p.startMs, endMs: p.startMs }));
    let k = 0;
    for (const s of steps) {
      while (k + 1 < points.length && points[k + 1]!.ms <= s.ms) k++;
      const seg = segments[k]!;
      if (s.startMs < seg.startMs) seg.startMs = s.startMs;
      if (s.endMs > seg.endMs) seg.endMs = s.endMs;
    }
    // A dispatch's own end counts when it came before the agent's next dispatch, or when that one started with it (the
    // same agent dispatched twice at once: one segment).
    points.forEach((p, i) => {
      const next = points[i + 1];
      const settled = next === undefined || p.endMs <= next.startMs || next.startMs <= p.startMs;
      if (p.node.kind === 'subagent' && settled && p.endMs > segments[i]!.endMs) segments[i]!.endMs = p.endMs;
    });
  }
  const last = segments[segments.length - 1]!;
  if (active && clock.backgroundNowMs > last.endMs) last.endMs = clock.backgroundNowMs;
  return { segments: mergeSpans(segments), active };
}

/** Each agent's label: its first dispatch's title (an orphan: its id), with ' #n' among equal names in order of appearance. */
function labelThreads(agents: Thread[]): Map<Thread, string> {
  const appearance = (t: Thread): number => t.points[0]?.ms ?? firstMs(t);
  const ordered = [...agents].sort((a, b) => appearance(a) - appearance(b) || byId(a, b));
  const base = new Map<Thread, string>();
  const count = new Map<string, number>();
  for (const t of ordered) {
    const name = t.points.find((p) => p.node.kind === 'subagent')?.node.title ?? t.id;
    base.set(t, name);
    count.set(name, (count.get(name) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const labels = new Map<Thread, string>();
  for (const t of ordered) {
    const name = base.get(t)!;
    if (count.get(name)! > 1) {
      const n = (seen.get(name) ?? 0) + 1;
      seen.set(name, n);
      labels.set(t, `${name} #${n}`);
    } else labels.set(t, name);
  }
  return labels;
}
