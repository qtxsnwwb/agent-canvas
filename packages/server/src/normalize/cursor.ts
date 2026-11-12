import type { Change, GraphEdge, GraphNode, NodeDetail, Session } from '@claude-canvas/shared';
import { CURSOR_RECORD_TYPES } from '../sources/cursor/records.js';
import type { RawEvent } from '../store/store.js';
import {
  bubbleView,
  composerFacts,
  isObject,
  isoOf,
  lowerBound,
  maxOf,
  minOf,
  str,
  type BubbleView,
  type ComposerFacts,
} from './cursor-bubbles.js';
import { parseCursorHook } from './cursor-hooks.js';
import type { AgentNormalizer, NormalizeResult } from './types.js';

/*
 * The Cursor normalizer (spec section 6): the trimmed `composer` / `bubble` records CursorSource stores (contract in
 * sources/cursor/records.ts) in, the shared Change stream out. Every session it creates has origin 'cursor'.
 *
 * Unlike the append-only transcripts of the other origins, a Cursor bubble is rewritten in place (a later record of
 * the same bubbleId supersedes the earlier one) and a conversation's records may arrive in any interleaving with its
 * subagents' records. So nothing here is incremental in the Codex sense: the normalizer keeps the latest view of every
 * bubble, derives each conversation's part of the graph from them (`deriveThread`), and emits the difference to what it
 * emitted before: new nodes, changed node fields, new or changed edges, and `edge_removed` for every edge a node no
 * longer produces. Nodes, edges and the session are therefore a function of the records read so far, whatever their
 * order. (One exception, kept on purpose: a bubble whose newer record has a shape that makes no node keeps the node of
 * its last recognised shape; nodes are never removed.)
 *
 * Hooks (spec 7.3) only leave a session-level mark (HookMark); the session status combines it with the records.
 */

const EPOCH = '1970-01-01T00:00:00.000Z';
const CANCELLED_NOTE = 'Cancelled in Cursor.';
const REJECTED_NOTE = 'Rejected by the user.';
const ABORTED_NOTE = 'Aborted: the conversation was stopped while the tool was still running.';
const NEVER_FINISHED_NOTE = 'Never finished: the turn ended while the tool was still running.';
/** A derivation saves a scan checkpoint before every CHECKPOINT_EVERY-th bubble of a thread. */
const CHECKPOINT_EVERY = 32;
/** How many sessions that exist only as hook marks (no record, no session yet) are remembered (as for Codex). */
const MAX_UNSEEN_HOOK_SESSIONS = 200;

/**
 * The latest session-level mark the hooks of a conversation left: `started` (beforeSubmitPrompt), `stopped` (stop),
 * `ended` (sessionEnd), `resumed` (sessionStart: the conversation exists again, without saying that a turn runs).
 * "Latest" is by the hook's time: the receive time stored with the raw event (Cursor's payloads carry no time of their
 * own), so a replay gives the same mark; a later-applied hook wins a tie. Kept outside SessionState so a hook received
 * before its session's first record still counts once the session appears.
 */
interface HookMark {
  kind: 'started' | 'stopped' | 'ended' | 'resumed';
  atMs: number;
}

const MARK_OF_EVENT: Readonly<Record<string, HookMark['kind']>> = {
  beforeSubmitPrompt: 'started',
  stop: 'stopped',
  sessionEnd: 'ended',
  sessionStart: 'resumed',
};

interface Turn {
  /** The prompt node that opened it; null for bubbles before the thread's first prompt. */
  promptNodeId: string | null;
  /** Index of its first bubble in the thread's sorted list. */
  startIndex: number;
  /** A bubble with turnDurationMs is in it, a later prompt exists, or the conversation was aborted in it. */
  ended: boolean;
  hasTurnDuration: boolean;
  /** Ended by the composer status `aborted` (last turn only). */
  aborted: boolean;
  /** A tool / dispatch bubble of it is not in a terminal raw status. */
  hasRunning: boolean;
  /** End time: the turnDurationMs bubble's end, else the next prompt's start; aborted: its latest bubble time. */
  endMs: number | null;
  /** Latest bubble time in it. */
  maxMs: number | null;
}

/** Everything derived from one thread's own records (cached per thread version). */
interface Analysis {
  sorted: BubbleView[];
  turns: Turn[];
  /** Turn index of each sorted bubble. */
  turnOf: number[];
  /** The last turn has not ended (rule in `analyze`). */
  open: boolean;
  minMs: number | null;
  maxMs: number | null;
  /** Title from the first prompt with a usable text. */
  firstPromptTitle: string | null;
  /** task_v2 bubbles, in thread order, with their index in `sorted`. */
  dispatches: { nodeId: string; callId: string | null; agentId: string | null; index: number }[];
}

/** The state of a thread's derivation scan just before one bubble (see deriveThread). */
interface Scan {
  prevNode: string | null;
  prevTs: string | null;
  batch: { parent: string | null; members: string[]; maxEnd: number } | null;
}

interface ThreadState {
  /** The conversation's composer id. */
  id: string;
  /** null for the main conversation. */
  agentId: string | null;
  composer: ComposerFacts | null;
  bubbles: Map<string, BubbleView>;
  /** The bubbles in thread order (compareBubbles), kept sorted as records arrive. */
  sorted: BubbleView[];
  /** Lowest index in `sorted` changed since the thread was last derived (Infinity: none). */
  dirtyFrom: number;
  /** Scan state before a bubble (by bubble id), saved by the last derivation that passed it. */
  checkpoints: Map<string, Scan>;
  /** Per turn (prompt node id, '' before the first prompt): the turn facts nodes depend on, at the last derivation. */
  turnFacts: Map<string, string>;
  version: number;
  analysis: Analysis | null;
  analysisVersion: number;
}

interface SessionState {
  session: Session;
  projectId: string;
  threads: Map<string, ThreadState>;
  /** Nodes as emitted. */
  nodes: Map<string, GraphNode>;
  /** Tool / dispatch notes (detail.text) as emitted. */
  notes: Map<string, string | null>;
  /** Edge id -> `from>to>kind` as emitted. */
  edges: Map<string, string>;
  /** Edge id -> the bubble node whose derivation step produced it, as emitted. */
  edgeProducer: Map<string, string>;
  /** Bubble node id -> the edge ids its derivation step produced, as emitted. */
  produced: Map<string, string[]>;
  /** Detail of a bubble's latest record, until it has been emitted (held subagent threads keep theirs). */
  pending: Map<string, Partial<NodeDetail>>;
  /** Shown threads -> the dispatch node they hang off (null for the main conversation), as last derived. */
  links: Map<string, string | null>;
}

interface DerivedNode {
  node: GraphNode;
  note: string | null;
  isCall: boolean;
}

interface Derived {
  nodes: DerivedNode[];
  edges: GraphEdge[];
  /** Every bubble (node or not) the derivation passed -> the edge ids its step produced. */
  producers: Map<string, string[]>;
}

/** Thread links: which threads are shown and where they hang. */
interface Links {
  /** Shown thread -> its dispatch node (null for the root), in breadth-first order from the root. */
  shown: Map<string, string | null>;
  /** Dispatch node -> the subagent thread it started. */
  childOf: Map<string, string>;
  /** Subagent thread -> the thread its dispatch node is in. */
  ownerOf: Map<string, string>;
}

const isRunningRaw = (status: string | null): boolean => status !== 'completed' && status !== 'error' && status !== 'cancelled';

/** Stores the latest view of a bubble, keeping `sorted` in order; marks the thread dirty from the lowest index moved. */
function upsertBubble(thread: ThreadState, view: BubbleView): void {
  let dirty = Number.POSITIVE_INFINITY;
  const old = thread.bubbles.get(view.bubbleId);
  if (old !== undefined) {
    const i = lowerBound(thread.sorted, old);
    if (thread.sorted[i] === old) {
      thread.sorted.splice(i, 1);
      dirty = i;
    }
  }
  const j = lowerBound(thread.sorted, view);
  thread.sorted.splice(j, 0, view);
  thread.bubbles.set(view.bubbleId, view);
  thread.dirtyFrom = Math.min(thread.dirtyFrom, dirty, j);
  thread.version += 1;
}

/**
 * The thread's own facts: order, turns, times, dispatch calls. A turn ends at a bubble with turnDurationMs or at the
 * next prompt. When the composer status is `aborted`, the last turn counts as ended too (unless the thread's last bubble
 * is a prompt: a new turn started after the abort). The last turn is open unless it has ended that way, and it is open
 * when it has a tool still in a non-terminal status, or the thread's last bubble is its prompt, or the composer status
 * is neither 'completed' nor 'aborted' (Cursor's 'none' while generating, or no composer record yet).
 */
function analyze(thread: ThreadState): Analysis {
  if (thread.analysis !== null && thread.analysisVersion === thread.version) return thread.analysis;
  const sorted = thread.sorted;
  const turns: Turn[] = [];
  const turnOf: number[] = [];
  let minMs: number | null = null;
  let maxMs: number | null = null;
  let firstPromptTitle: string | null = null;
  const dispatches: Analysis['dispatches'] = [];
  const newTurn = (promptNodeId: string | null, startIndex: number): Turn => ({
    promptNodeId,
    startIndex,
    ended: false,
    hasTurnDuration: false,
    aborted: false,
    hasRunning: false,
    endMs: null,
    maxMs: null,
  });
  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i]!;
    if (b.kind === 'prompt') {
      const prev = turns[turns.length - 1];
      if (prev !== undefined && !prev.ended) {
        prev.ended = true;
        prev.endMs = b.startMs;
      }
      turns.push(newTurn(b.nodeId, i));
      if (firstPromptTitle === null) firstPromptTitle = b.promptTitle;
    } else if (turns.length === 0) {
      turns.push(newTurn(null, 0));
    }
    const turn = turns[turns.length - 1]!;
    turnOf.push(turns.length - 1);
    if (b.hasTurnDuration) {
      turn.ended = true;
      turn.hasTurnDuration = true;
      turn.endMs = b.endMs ?? b.startMs;
    }
    if ((b.kind === 'tool' || b.kind === 'subagent') && isRunningRaw(b.toolStatus)) turn.hasRunning = true;
    if (b.kind === 'subagent') dispatches.push({ nodeId: b.nodeId, callId: b.toolCallId, agentId: b.resultAgentId, index: i });
    turn.maxMs = maxOf(turn.maxMs, b.latestMs);
    minMs = minOf(minMs, b.startMs);
    maxMs = maxOf(maxMs, b.latestMs);
  }
  const last = turns[turns.length - 1];
  const status = thread.composer?.status ?? null;
  const lastIsPrompt = sorted.length > 0 && sorted[sorted.length - 1]!.kind === 'prompt';
  if (last !== undefined && !last.ended && status === 'aborted' && !lastIsPrompt) {
    last.ended = true;
    last.aborted = true;
    last.endMs = last.maxMs;
  }
  let open = false;
  if (last !== undefined && !last.ended) open = last.hasRunning || lastIsPrompt || !(status === 'completed' || status === 'aborted');
  const analysis: Analysis = { sorted, turns, turnOf, open, minMs, maxMs, firstPromptTitle, dispatches };
  thread.analysis = analysis;
  thread.analysisVersion = thread.version;
  return analysis;
}

/** The facts of a turn the nodes in it depend on (statuses and ends of calls). */
const turnSig = (t: Turn): string => `${t.ended}|${t.endMs}|${t.aborted}`;

/**
 * A call's own status: rejected → denied; completed → succeeded; error → failed; cancelled → failed noting it; any
 * other (loading) → running, or failed when its turn has ended (never finished / aborted).
 */
function callStatus(b: BubbleView, turn: Turn): { status: GraphNode['status']; note: string | null; settled: boolean } {
  if (b.rejected && b.toolStatus !== 'loading') return { status: 'denied', note: REJECTED_NOTE, settled: false };
  if (b.toolStatus === 'completed') return { status: 'succeeded', note: null, settled: false };
  if (b.toolStatus === 'error') return { status: 'failed', note: null, settled: false };
  if (b.toolStatus === 'cancelled') return { status: 'failed', note: CANCELLED_NOTE, settled: false };
  if (!turn.ended) return { status: 'running', note: null, settled: false };
  return { status: 'failed', note: turn.aborted ? ABORTED_NOTE : NEVER_FINISHED_NOTE, settled: true };
}

/** The fields of an emitted node that differ in `next`. */
function nodePatch(old: GraphNode, next: GraphNode): Partial<GraphNode> {
  const patch: Partial<GraphNode> = {};
  const keys: (keyof GraphNode)[] = [
    'turnId',
    'agentId',
    'childAgentId',
    'parentId',
    'kind',
    'status',
    'timestamp',
    'title',
    'summary',
    'toolName',
    'toolUseId',
    'durationMs',
    'endedAt',
  ];
  for (const k of keys) if (old[k] !== next[k]) (patch as Record<string, unknown>)[k] = next[k];
  const ou = old.usage;
  const nu = next.usage;
  if ((ou === null) !== (nu === null) || (ou !== null && nu !== null && (ou.inputTokens !== nu.inputTokens || ou.outputTokens !== nu.outputTokens))) patch.usage = nu;
  return patch;
}

export class CursorNormalizer implements AgentNormalizer {
  private readonly sessions = new Map<string, SessionState>();
  private readonly checkpointEvery: number;
  /** Latest hook mark per session id; may exist before the session does (see HookMark). */
  private readonly hookMarks = new Map<string, HookMark>();
  /** Sessions without state whose hook mark was restored by restorePreSession. */
  private readonly preSessionRestored = new Set<string>();

  /** `checkpointEvery` (tests): checkpoint spacing; Infinity derives every changed thread in full. */
  constructor(options: { checkpointEvery?: number } = {}) {
    this.checkpointEvery = options.checkpointEvery ?? CHECKPOINT_EVERY;
  }

  apply(event: RawEvent, projectId: string): NormalizeResult {
    // Meta events are not produced for Cursor.
    if (event.source === 'meta') return { changes: [] };
    const changes: Change[] = [];
    try {
      const unknown = event.source === 'hook' ? this.applyHook(event, changes) : this.applyRecord(event, projectId, changes);
      return unknown === undefined ? { changes } : { changes, unknownRecordType: unknown };
    } catch {
      return { changes, unknownRecordType: 'normalizer-error' };
    }
  }

  dropSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.hookMarks.delete(sessionId);
    this.preSessionRestored.delete(sessionId);
  }

  /** Before a session's first record the only thing kept is its hook mark. */
  needsPreSessionReplay(sessionId: string): boolean {
    return !this.sessions.has(sessionId) && !this.preSessionRestored.has(sessionId);
  }

  /** Restores the hook mark of a session that has no record yet from its stored hooks, in order. */
  restorePreSession(sessionId: string, events: Iterable<RawEvent>): void {
    this.dropSession(sessionId);
    try {
      for (const ev of events) if (ev.source === 'hook' && ev.sessionId === sessionId) this.recordHook(ev);
    } catch (err) {
      this.dropSession(sessionId);
      throw err;
    }
    if (!this.sessions.has(sessionId)) this.preSessionRestored.add(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  /** Details held for nodes not emitted yet (held subagent threads). */
  toolInputCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.pending.size ?? 0;
  }

  // ---- records ----

  private applyRecord(event: Extract<RawEvent, { source: 'transcript' }>, projectId: string, changes: Change[]): string | undefined {
    const recordType = event.recordType;
    if (recordType !== CURSOR_RECORD_TYPES.composer && recordType !== CURSOR_RECORD_TYPES.bubble) return `cursor:${recordType}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.line);
    } catch {
      return `${recordType}:invalid-json`;
    }
    if (!isObject(parsed)) return `${recordType}:not-an-object`;
    const threadId = event.agentId ?? event.sessionId;
    let bubble: { view: BubbleView; detail: Partial<NodeDetail> } | null = null;
    if (recordType === CURSOR_RECORD_TYPES.bubble) {
      const bubbleId = str(parsed.bubbleId);
      if (bubbleId === null) return 'bubble:missing-id';
      bubble = bubbleView(parsed, bubbleId, `bubble:${threadId}:${bubbleId}`);
    }

    const created = !this.sessions.has(event.sessionId);
    const state = this.stateFor(event.sessionId, projectId);
    if (projectId !== 'unknown' && (event.agentId === null || state.projectId === 'unknown')) state.projectId = projectId;
    const thread = this.threadFor(state, threadId, event.agentId);
    let unknown: string | undefined;
    if (bubble === null) {
      thread.composer = composerFacts(parsed);
      thread.version += 1;
      thread.dirtyFrom = 0; // its createdAt is the time of untimed leading nodes; its status ends turns
    } else {
      const old = thread.bubbles.get(bubble.view.bubbleId);
      let view = bubble.view;
      if (view.unknown !== null) {
        // Counted once per shape change of a bubble, not once per version.
        if (old?.unknown !== view.unknown) unknown = view.unknown;
        // A bubble seen with a recognised shape keeps that node (nodes are never removed); its order and times follow.
        if (old !== undefined && old.kind !== null) {
          view = { ...old, unknown: view.unknown, order: view.order, createdMs: view.createdMs, startMs: view.startMs, endMs: view.endMs, latestMs: view.latestMs, hasTurnDuration: view.hasTurnDuration };
        }
      }
      upsertBubble(thread, view);
      if (view.kind === null) state.pending.delete(view.nodeId);
      else if (bubble.view.kind !== null) state.pending.set(view.nodeId, bubble.detail);
    }
    this.refresh(state, threadId, changes);
    this.commitSession(state, this.deriveSession(state), changes, created);
    return unknown;
  }

  private stateFor(sessionId: string, projectId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        session: {
          id: sessionId,
          projectId,
          origin: 'cursor',
          cwd: null,
          title: null,
          gitBranch: null,
          status: 'idle',
          sourceDeleted: false,
          startedAt: EPOCH,
          lastActivityAt: EPOCH,
        },
        projectId,
        threads: new Map(),
        nodes: new Map(),
        notes: new Map(),
        edges: new Map(),
        edgeProducer: new Map(),
        produced: new Map(),
        pending: new Map(),
        links: new Map(),
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private threadFor(state: SessionState, id: string, agentId: string | null): ThreadState {
    let thread = state.threads.get(id);
    if (!thread) {
      thread = {
        id,
        agentId,
        composer: null,
        bubbles: new Map(),
        sorted: [],
        dirtyFrom: Number.POSITIVE_INFINITY,
        checkpoints: new Map(),
        turnFacts: new Map(),
        version: 0,
        analysis: null,
        analysisVersion: -1,
      };
      state.threads.set(id, thread);
    }
    return thread;
  }

  // ---- hooks (session-level marks only: they never create a session or touch a node) ----

  /** Records the hook's mark and recomputes the status of its session if it exists; returns the unknown label, if any. */
  private applyHook(event: Extract<RawEvent, { source: 'hook' }>, changes: Change[]): string | undefined {
    const parsed = parseCursorHook(event.eventName, event.payload);
    if (!parsed.ok) return parsed.unknownRecordType ?? undefined;
    this.recordHook(event);
    const state = event.sessionId === null ? undefined : this.sessions.get(event.sessionId);
    if (state !== undefined) this.commitSession(state, this.deriveSession(state), changes, false);
    return undefined;
  }

  /**
   * The mark a hook leaves on its session (HookMark). None from subagentStop, from a hook without a session id, or from
   * a hook of a subagent conversation that the pipeline filed under its root session (its conversation id is not the
   * session's): a subagent's prompt, stop or end says nothing about the main conversation.
   */
  private recordHook(event: Extract<RawEvent, { source: 'hook' }>): void {
    const sessionId = event.sessionId;
    if (sessionId === null) return;
    const parsed = parseCursorHook(event.eventName, event.payload);
    if (!parsed.ok || parsed.hook.conversationId !== sessionId) return;
    const kind = MARK_OF_EVENT[parsed.hook.eventName];
    const atMs = Date.parse(event.receivedAt);
    if (kind === undefined || Number.isNaN(atMs)) return;
    const old = this.hookMarks.get(sessionId);
    if (old !== undefined && atMs < old.atMs) return;
    this.hookMarks.set(sessionId, { kind, atMs });
    if (old === undefined) this.pruneUnseenHookMarks();
  }

  /** Hook marks of sessions that never appear must not pile up: beyond the limit the oldest are dropped. */
  private pruneUnseenHookMarks(): void {
    const unseen: string[] = [];
    for (const id of this.hookMarks.keys()) if (!this.sessions.has(id)) unseen.push(id);
    for (const id of unseen.slice(0, Math.max(0, unseen.length - MAX_UNSEEN_HOOK_SESSIONS))) this.hookMarks.delete(id);
  }

  // ---- session ----

  /**
   * The session as a function of the records and the hook mark: title = the root composer's name, else its first
   * prompt with text; cwd from the root composer; created = the root composer's createdAt, else the earliest bubble;
   * last activity = the latest bubble time of any thread. Status (spec 6 and 7.3), whatever order records and hooks
   * arrived in: the latest hook mark is `ended` → ended; else the root conversation's last turn is open in the records
   * → running; else the latest mark is `started` and newer than the session's latest bubble (a prompt was submitted and
   * nothing of it has been read from the database yet) → running; else idle.
   */
  private deriveSession(state: SessionState): Session {
    const rootId = state.session.id;
    const root = state.threads.get(rootId);
    const ra = root === undefined ? null : analyze(root);
    let minMs: number | null = null;
    let maxMs: number | null = null;
    for (const t of state.threads.values()) {
      const a = analyze(t);
      minMs = minOf(minMs, a.minMs);
      maxMs = maxOf(maxMs, a.maxMs);
    }
    const startedMs = root?.composer?.createdAt ?? minMs;
    const startedAt = isoOf(startedMs) ?? EPOCH;
    const mark = this.hookMarks.get(rootId);
    let status: Session['status'];
    if (mark?.kind === 'ended') status = 'ended';
    else if (ra?.open) status = 'running';
    else if (mark?.kind === 'started' && (maxMs === null || mark.atMs > maxMs)) status = 'running';
    else status = 'idle';
    return {
      ...state.session,
      projectId: state.projectId,
      cwd: root?.composer?.cwd ?? null,
      title: root?.composer?.name ?? ra?.firstPromptTitle ?? null,
      status,
      startedAt,
      lastActivityAt: isoOf(maxOf(maxMs, startedMs)) ?? startedAt,
    };
  }

  private commitSession(state: SessionState, next: Session, changes: Change[], force: boolean): void {
    const s = state.session;
    const same =
      s.lastActivityAt === next.lastActivityAt &&
      s.startedAt === next.startedAt &&
      s.cwd === next.cwd &&
      s.projectId === next.projectId &&
      s.title === next.title &&
      s.status === next.status;
    if (same && !force) return;
    state.session = next;
    changes.push({ type: 'session_upserted', session: next });
  }

  // ---- links between conversations ----

  /**
   * Which threads are shown: the main conversation, and (breadth-first from it) every subagent conversation linked to
   * a task_v2 bubble of a shown thread. Link: a subagent whose composer's subagentInfo.toolCallId equals the bubble's
   * toolCallId (several: the smallest composer id); when there is none, the conversation the bubble's result names
   * (`agentId`), unless that conversation's own toolCallId names another task_v2 call (toolCallId wins). A subagent
   * without a link is held (not shown).
   */
  private links(state: SessionState): Links {
    const rootId = state.session.id;
    const byCall = new Map<string, string[]>();
    for (const t of state.threads.values()) {
      const call = t.composer?.toolCallId ?? null;
      if (t.agentId === null || call === null) continue;
      const list = byCall.get(call) ?? [];
      list.push(t.id);
      byCall.set(call, list);
    }
    for (const list of byCall.values()) list.sort();
    const calls = new Set<string>();
    for (const t of state.threads.values()) for (const d of analyze(t).dispatches) if (d.callId !== null) calls.add(d.callId);
    const shown = new Map<string, string | null>([[rootId, null]]);
    const childOf = new Map<string, string>();
    const ownerOf = new Map<string, string>();
    const queue = [rootId];
    for (let q = 0; q < queue.length; q++) {
      const id = queue[q]!;
      const t = state.threads.get(id);
      if (!t) continue;
      for (const d of analyze(t).dispatches) {
        if (childOf.has(d.nodeId)) continue;
        let child = d.callId === null ? undefined : byCall.get(d.callId)?.find((c) => !shown.has(c));
        if (child === undefined && d.agentId !== null && d.agentId !== id && !shown.has(d.agentId)) {
          const named = state.threads.get(d.agentId);
          const ownCall = named?.composer?.toolCallId ?? null;
          if (named !== undefined && named.agentId !== null && (ownCall === null || ownCall === d.callId || !calls.has(ownCall))) child = named.id;
        }
        if (child === undefined) continue;
        shown.set(child, d.nodeId);
        childOf.set(d.nodeId, child);
        ownerOf.set(child, id);
        queue.push(child);
      }
    }
    return { shown, childOf, ownerOf };
  }

  /**
   * Re-derives what may have changed: the touched thread from its first changed bubble on, every thread whose link
   * changed (newly shown, or hanging off another dispatch) in full, and for each of those the thread holding its
   * dispatch node from that node on (a dispatch's status, end and title follow its subagent). A thread that is not
   * shown is not derived; its changes wait in `dirtyFrom`. Parents are derived before their subagents.
   */
  private refresh(state: SessionState, touched: string, changes: Change[]): void {
    const links = this.links(state);
    const from = new Map<string, number>();
    const want = (id: string, index: number): void => {
      from.set(id, Math.min(from.get(id) ?? Number.POSITIVE_INFINITY, index));
      const owner = links.ownerOf.get(id);
      const ownerThread = owner === undefined ? undefined : state.threads.get(owner);
      if (owner === undefined || ownerThread === undefined) return;
      const dispatch = links.shown.get(id);
      const at = analyze(ownerThread).dispatches.find((d) => d.nodeId === dispatch)?.index ?? 0;
      from.set(owner, Math.min(from.get(owner) ?? Number.POSITIVE_INFINITY, at));
    };
    const touchedThread = state.threads.get(touched);
    if (links.shown.has(touched) && touchedThread !== undefined) want(touched, touchedThread.dirtyFrom);
    for (const [id, dispatch] of links.shown) {
      if (!state.links.has(id) || state.links.get(id) !== dispatch) want(id, 0);
    }
    state.links = links.shown;
    for (const [id, dispatch] of links.shown) {
      const t = state.threads.get(id);
      const index = from.get(id);
      if (t === undefined || index === undefined) continue;
      const start = Math.min(index, t.dirtyFrom);
      t.dirtyFrom = Number.POSITIVE_INFINITY;
      if (start < t.sorted.length) this.emit(state, this.deriveThread(state, t, dispatch, links, start), changes);
    }
  }

  // ---- one thread's graph ----

  /**
   * The first bubble whose derived node or edges can differ from the last derivation, given that bubbles from `from`
   * on changed: no later than `from`; the start of every turn whose facts (ended, end time, aborted) changed, since
   * its calls' statuses and ends follow them; and the nearest timed bubble before that, since the end of a call without
   * completedAtMs is the next bubble's start.
   */
  private firstAffected(thread: ThreadState, a: Analysis, from: number): number {
    let s = from;
    const facts = new Map<string, string>();
    for (const t of a.turns) {
      const key = t.promptNodeId ?? '';
      const sig = turnSig(t);
      facts.set(key, sig);
      if (thread.turnFacts.get(key) !== sig) s = Math.min(s, t.startIndex);
    }
    thread.turnFacts = facts;
    if (s >= a.sorted.length) return s;
    let p = s - 1;
    while (p >= 0 && a.sorted[p]!.startMs === null) p--;
    return Math.max(0, Math.min(s, p));
  }

  /**
   * The thread's nodes and edges. Bubbles are chained in order (prompt / text / thinking / tool / dispatch; unknown
   * shapes make no node but still end turns). Parallel rule: a tool or dispatch bubble that starts before the end of
   * the run of calls just before it joins that run — every member hangs off the run's parent (fork), and the next
   * node hangs off the last member with an edge from every member (join). A call's end for this rule is the end its
   * node shows: completedAtMs; else, while it is still running, open; else (finished or settled without an end) the
   * next bubble's start, which never overlaps the next call. A subagent thread's first node hangs off its dispatch node
   * (spawn edge).
   *
   * Only the part that can differ is derived (`firstAffected`), resuming the scan from the latest checkpoint saved at or
   * before it (one every CHECKPOINT_EVERY bubbles); without one, the whole thread is derived.
   */
  private deriveThread(state: SessionState, thread: ThreadState, dispatch: string | null, links: Links, from: number): Derived {
    const a = analyze(thread);
    const sid = state.session.id;
    const nodes: DerivedNode[] = [];
    const edges: GraphEdge[] = [];
    const producers = new Map<string, string[]>();
    let producing: string[] = [];
    const edge = (from: string, to: string, kind: GraphEdge['kind'], suffix = ''): void => {
      const id = `${from}->${to}${suffix}`;
      edges.push({ id, sessionId: sid, from, to, kind });
      producing.push(id);
    };
    let prevNode: string | null = null;
    let prevTs: string | null = null;
    let batch: Scan['batch'] = null;
    const fallbackTs = isoOf(thread.composer?.createdAt ?? null) ?? EPOCH;
    const copyBatch = (b: Scan['batch']): Scan['batch'] => (b === null ? null : { ...b, members: [...b.members] });

    const affected = from <= 0 ? 0 : this.firstAffected(thread, a, from);
    if (from <= 0) this.firstAffected(thread, a, 0); // records the turn facts
    let start = 0;
    for (let i = Math.min(affected, a.sorted.length - 1); i > 0; i--) {
      const cp = thread.checkpoints.get(a.sorted[i]!.bubbleId);
      if (cp === undefined) continue;
      start = i;
      prevNode = cp.prevNode;
      prevTs = cp.prevTs;
      batch = copyBatch(cp.batch);
      break;
    }

    for (let i = start; i < a.sorted.length; i++) {
      const b = a.sorted[i]!;
      if (i > 0 && i % this.checkpointEvery === 0) thread.checkpoints.set(b.bubbleId, { prevNode, prevTs, batch: copyBatch(batch) });
      else if (i > start) thread.checkpoints.delete(b.bubbleId); // a stale one from another position
      producing = [];
      producers.set(b.nodeId, producing);
      if (b.kind === null) continue;
      const turn = a.turns[a.turnOf[i]!]!;
      const ts: string = isoOf(b.startMs) ?? prevTs ?? fallbackTs;
      const startMs = Date.parse(ts);
      let nextStart: number | null = null;
      for (let j = i + 1; j < a.sorted.length && nextStart === null; j++) nextStart = a.sorted[j]!.startMs;
      const isCall = b.kind === 'tool' || b.kind === 'subagent';

      let status: GraphNode['status'] = null;
      let note: string | null = null;
      let endedMs: number | null = null;
      let durationMs: number | null = null;
      let childAgentId: string | null = null;
      let title = b.title;
      let runEnd = Number.NEGATIVE_INFINITY;
      if (isCall) {
        const own = callStatus(b, turn);
        // Without completedAtMs a finished or settled call ends where the next bubble starts (the turn's end when last).
        const ownEnd = b.endMs ?? nextStart ?? (own.settled ? turn.endMs : null);
        const child = b.kind === 'subagent' ? links.childOf.get(b.nodeId) : undefined;
        const childThread = child === undefined ? undefined : state.threads.get(child);
        if (b.kind === 'subagent') {
          childAgentId = child ?? null;
          title = childThread?.composer?.subagentTypeName ?? b.agentType ?? b.title;
        }
        const ca = childThread === undefined ? null : analyze(childThread);
        if (ca !== null && ca.sorted.length > 0 && !ca.open) {
          // The subagent finished: the task_v2 call's own status (still loading: it did its job).
          status = own.status === 'running' ? 'succeeded' : own.status;
          note = own.note;
          endedMs = b.endMs ?? ca.maxMs;
        } else if (ca !== null && !turn.ended) {
          status = 'running'; // follows its subagent while the parent's turn goes on
        } else {
          // No subagent, or the parent's turn ended without the subagent showing it finished: the call's own status.
          status = own.status;
          note = own.note;
          if (status !== 'running') endedMs = ownEnd;
        }
        if (endedMs !== null && !Number.isNaN(startMs)) durationMs = Math.max(0, endedMs - startMs);
        runEnd = b.endMs ?? (status === 'running' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
      } else if (b.kind === 'thinking') {
        durationMs = b.thinkingMs;
      }

      // Placement.
      let parentId: string | null;
      if (isCall && batch !== null && b.startMs !== null && b.startMs < batch.maxEnd) {
        parentId = batch.parent;
        batch.members.push(b.nodeId);
        batch.maxEnd = Math.max(batch.maxEnd, runEnd);
        if (parentId !== null) edge(parentId, b.nodeId, 'fork');
        if (batch.members.length === 2 && parentId !== null) edge(parentId, batch.members[0]!, 'fork', ':fork');
      } else {
        parentId = prevNode ?? dispatch;
        const joinFrom: string[] = [];
        if (batch !== null && batch.members.length >= 2) {
          parentId = batch.members[batch.members.length - 1]!;
          joinFrom.push(...batch.members.slice(0, -1));
        }
        batch = isCall ? { parent: parentId, members: [b.nodeId], maxEnd: runEnd } : null;
        if (parentId !== null) edge(parentId, b.nodeId, prevNode === null ? 'spawn' : 'sequence');
        for (const from of joinFrom) edge(from, b.nodeId, 'sequence');
      }

      nodes.push({
        isCall,
        note,
        node: {
          id: b.nodeId,
          sessionId: sid,
          turnId: turn.promptNodeId,
          agentId: thread.agentId,
          childAgentId,
          parentId,
          kind: b.kind,
          status,
          timestamp: ts,
          confirmed: true,
          title,
          summary: b.summary,
          toolName: b.toolName,
          toolUseId: b.toolCallId,
          messageId: null,
          durationMs,
          endedAt: isCall ? isoOf(endedMs) : null,
          usage: b.usage,
          systemSubtype: null,
        },
      });
      prevNode = b.nodeId;
      prevTs = ts;
    }
    return { nodes, edges, producers };
  }

  /**
   * Emits what differs from what was emitted before: new nodes, changed fields / details, new or changed edges, and the
   * removal of every edge whose producing bubble was re-derived without producing it again.
   */
  private emit(state: SessionState, derived: Derived, changes: Change[]): void {
    const sid = state.session.id;
    for (const { node, note, isCall } of derived.nodes) {
      const old = state.nodes.get(node.id);
      const pending = state.pending.get(node.id);
      state.pending.delete(node.id);
      const withNote = (d: Partial<NodeDetail>): Partial<NodeDetail> => (isCall ? { ...d, text: note } : d);
      if (old === undefined) {
        state.nodes.set(node.id, node);
        state.notes.set(node.id, note);
        changes.push({ type: 'node_added', node, detail: withNote(pending ?? {}) });
        continue;
      }
      const patch = nodePatch(old, node);
      let detail: Partial<NodeDetail> | undefined;
      if (pending !== undefined) detail = withNote(pending);
      else if (isCall && state.notes.get(node.id) !== note) detail = { text: note };
      if (Object.keys(patch).length === 0 && detail === undefined) continue;
      state.nodes.set(node.id, node);
      state.notes.set(node.id, note);
      changes.push({ type: 'node_updated', sessionId: sid, id: node.id, patch, ...(detail !== undefined ? { detail } : {}) });
    }
    const fresh = new Set(derived.edges.map((e) => e.id));
    for (const [producer, ids] of derived.producers) {
      for (const id of state.produced.get(producer) ?? []) {
        if (fresh.has(id) || state.edgeProducer.get(id) !== producer) continue;
        state.edges.delete(id);
        state.edgeProducer.delete(id);
        changes.push({ type: 'edge_removed', sessionId: sid, id });
      }
      if (ids.length === 0) state.produced.delete(producer);
      else state.produced.set(producer, ids);
    }
    for (const [producer, ids] of derived.producers) for (const id of ids) state.edgeProducer.set(id, producer);
    for (const e of derived.edges) {
      const sig = `${e.from}>${e.to}>${e.kind}`;
      if (state.edges.get(e.id) === sig) continue;
      state.edges.set(e.id, sig);
      changes.push({ type: 'edge_added', edge: e });
    }
  }
}
