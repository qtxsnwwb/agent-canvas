import type { Change, GraphEdge, GraphNode, NodeDetail, Session, Usage } from '@claude-canvas/shared';
import { CURSOR_RECORD_TYPES } from '../sources/cursor/records.js';
import type { RawEvent } from '../store/store.js';
import { promptTitle } from './codex.js';
import { summarize } from './summary.js';
import type { AgentNormalizer, NormalizeResult } from './types.js';

/*
 * The Cursor normalizer (spec section 6): the trimmed `composer` / `bubble` records CursorSource stores (contract in
 * sources/cursor/records.ts) in, the shared Change stream out. Every session it creates has origin 'cursor'.
 *
 * Unlike the append-only transcripts of the other origins, a Cursor bubble is rewritten in place (a later record of
 * the same bubbleId supersedes the earlier one) and a conversation's records may arrive in any interleaving with its
 * subagents' records. So nothing here is incremental: the normalizer keeps the latest record of every bubble, derives
 * each conversation's part of the graph from them (`deriveThread`), and emits the difference to what it emitted before
 * (new nodes, changed node fields, new or changed edges). Node fields and the session are therefore a function of the
 * records read so far, whatever their order. Edges cannot be removed (there is no such Change): when a bubble moves,
 * its new edges are added and the old ones stay; for records that arrive in their conversation's order (as the source
 * sends them) the edge set is the derived one too.
 */

const EPOCH = '1970-01-01T00:00:00.000Z';
const TASK_TOOL = 'task_v2';
const CANCELLED_NOTE = 'Cancelled in Cursor.';
const NEVER_FINISHED_NOTE = 'Never finished: the turn ended while the tool was still running.';
/** `params` keys naming a call's main argument, most telling first (Cursor's camelCase and snake_case spellings). */
const MAIN_ARG_KEYS = [
  'command',
  'targetFile',
  'target_file',
  'relativeWorkspacePath',
  'relative_workspace_path',
  'filePath',
  'file_path',
  'path',
  'targetDirectory',
  'target_directory',
  'query',
  'pattern',
  'globPattern',
  'glob_pattern',
  'searchTerm',
  'search_term',
  'url',
  'description',
  'prompt',
  'explanation',
];
const TASK_ARG_KEYS = ['description', 'prompt'];
const AGENT_TYPE_KEYS = ['subagentTypeName', 'subagentType', 'subagent_type'];

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
function isoOf(ms: number | null): string | null {
  if (ms === null) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function msOfIso(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}
const maxOf = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));
const minOf = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.min(a, b));

/** A conversation's composer facts the graph needs. */
interface ComposerFacts {
  name: string | null;
  status: string | null;
  createdAt: number | null;
  cwd: string | null;
  /** Subagents: the task_v2 call that dispatched it. */
  toolCallId: string | null;
  subagentTypeName: string | null;
}

type BubbleKind = 'prompt' | 'text' | 'thinking' | 'tool' | 'subagent';

/** What the graph needs of the latest record of one bubble (the large texts go to `SessionState.pending`). */
interface BubbleView {
  bubbleId: string;
  nodeId: string;
  /** Index in the conversation's list; Infinity when the record had none. */
  order: number;
  createdMs: number | null;
  /** startedAtMs, else createdAt. */
  startMs: number | null;
  endMs: number | null;
  /** Latest of its times (session activity). */
  latestMs: number | null;
  hasTurnDuration: boolean;
  /** null: a shape that makes no node. */
  kind: BubbleKind | null;
  title: string;
  summary: string;
  promptTitle: string | null;
  thinkingMs: number | null;
  usage: Usage | null;
  toolName: string | null;
  toolStatus: string | null;
  toolCallId: string | null;
  /** task_v2: the subagent type named in its params. */
  agentType: string | null;
}

interface Turn {
  /** The prompt node that opened it; null for bubbles before the thread's first prompt. */
  promptNodeId: string | null;
  /** Index of its first bubble in the thread's sorted list. */
  startIndex: number;
  /** A bubble with turnDurationMs is in it, or a later prompt exists. */
  ended: boolean;
  hasTurnDuration: boolean;
  /** A tool / dispatch bubble of it is not in a terminal raw status. */
  hasRunning: boolean;
  /** End time: the turnDurationMs bubble's end, else the next prompt's start. */
  endMs: number | null;
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
  /** Title from the first prompt; undefined when the thread has no prompt. */
  firstPromptTitle: string | null | undefined;
  /** task_v2 bubbles with a toolCallId, in thread order, with their index in `sorted`. */
  dispatches: { nodeId: string; callId: string; index: number }[];
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
  /** Scan state before each prompt bubble (by node id), saved by the last derivation that passed it. */
  checkpoints: Map<string, Scan>;
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

/** Pass-through of JSON text: parsed when it parses, else the text itself. */
function parseJsonText(text: string | null, cut: boolean): unknown {
  if (text === null) return null;
  if (cut) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** The main argument of a call as a one-line summary: a known key, else the first string value, else the whole input. */
function mainArg(input: unknown, keys: readonly string[]): string {
  if (isObject(input)) {
    for (const k of keys) {
      const v = str(input[k]);
      if (v !== null && v.trim() !== '') return summarize(v.trim());
    }
    for (const v of Object.values(input)) {
      if (typeof v === 'string' && v.trim() !== '') return summarize(v.trim());
    }
  }
  return input === null ? '' : summarize(input);
}

function firstString(input: unknown, keys: readonly string[]): string | null {
  if (!isObject(input)) return null;
  for (const k of keys) {
    const v = str(input[k]);
    if (v !== null) return v;
  }
  return null;
}

function usageOf(v: unknown): Usage | null {
  if (!isObject(v)) return null;
  const inputTokens = num(v.inputTokens) ?? 0;
  const outputTokens = num(v.outputTokens) ?? 0;
  return inputTokens === 0 && outputTokens === 0 ? null : { inputTokens, outputTokens };
}

function composerFacts(rec: Obj): ComposerFacts {
  const info = isObject(rec.subagentInfo) ? rec.subagentInfo : null;
  return {
    name: str(rec.name),
    status: str(rec.status),
    createdAt: num(rec.createdAt),
    cwd: str(rec.cwd),
    toolCallId: info === null ? null : str(info.toolCallId),
    subagentTypeName: info === null ? null : str(info.subagentTypeName),
  };
}

/** The view of a bubble record, its detail, and the shape label when it makes no node. */
function bubbleView(rec: Obj, bubbleId: string, nodeId: string): { view: BubbleView; detail: Partial<NodeDetail>; unknown?: string } {
  const type = num(rec.type);
  const cap = num(rec.capabilityType);
  const text = str(rec.text);
  const thinking = isObject(rec.thinking) ? rec.thinking : null;
  const tfd = isObject(rec.toolFormerData) ? rec.toolFormerData : null;
  const truncated = Array.isArray(rec.truncated) ? rec.truncated.filter((x): x is string => typeof x === 'string') : [];
  const createdMs = msOfIso(rec.createdAt);
  const startedAtMs = num(rec.startedAtMs);
  const endMs = num(rec.completedAtMs);
  const startMs = startedAtMs ?? createdMs;
  let kind: BubbleKind | null = null;
  if (type === 1) kind = 'prompt';
  else if (type === 2) {
    if (tfd !== null) kind = str(tfd.name) === TASK_TOOL ? 'subagent' : 'tool';
    else if (thinking !== null || cap === 30) kind = 'thinking';
    else if (text !== null) kind = 'text';
  }
  const view: BubbleView = {
    bubbleId,
    nodeId,
    order: num(rec.order) ?? Number.POSITIVE_INFINITY,
    createdMs,
    startMs,
    endMs,
    latestMs: maxOf(maxOf(createdMs, startedAtMs), endMs),
    hasTurnDuration: num(rec.turnDurationMs) !== null,
    kind,
    title: '',
    summary: '',
    promptTitle: null,
    thinkingMs: null,
    usage: usageOf(rec.tokenCount),
    toolName: null,
    toolStatus: null,
    toolCallId: null,
    agentType: null,
  };
  let detail: Partial<NodeDetail> = {};
  switch (kind) {
    case 'prompt':
      view.title = 'Prompt';
      view.summary = summarize(text ?? '');
      view.promptTitle = text === null ? null : promptTitle(text);
      detail = { input: null, output: null, text: text ?? '', raw: null };
      break;
    case 'text':
      view.title = 'Text';
      view.summary = summarize(text ?? '');
      detail = { input: null, output: null, text: text ?? '', raw: null };
      break;
    case 'thinking': {
      const t = thinking === null ? null : str(thinking.text);
      view.title = 'Thinking';
      view.summary = summarize(t ?? '');
      view.thinkingMs = num(rec.thinkingDurationMs);
      detail = { input: null, output: null, text: t ?? '', raw: null };
      break;
    }
    case 'tool':
    case 'subagent': {
      const t = tfd!;
      const name = str(t.name) ?? 'unknown';
      const params = str(t.params);
      const input = parseJsonText(params, truncated.includes('params'));
      const output = parseJsonText(str(t.result), truncated.includes('result'));
      view.toolName = name;
      view.title = name;
      view.toolStatus = str(t.status);
      view.toolCallId = str(t.toolCallId);
      view.summary = kind === 'subagent' ? mainArg(input, TASK_ARG_KEYS) : mainArg(input, MAIN_ARG_KEYS);
      if (kind === 'subagent') view.agentType = firstString(input, AGENT_TYPE_KEYS);
      detail = { input, output, raw: { status: view.toolStatus, toolCallId: view.toolCallId, truncated } };
      break;
    }
    case null:
      return {
        view,
        detail,
        unknown: type === 2 ? `bubble:type2/cap${cap ?? 'null'}/empty` : `bubble:type${type ?? 'null'}/cap${cap ?? 'null'}`,
      };
  }
  return { view, detail };
}

function compareBubbles(a: BubbleView, b: BubbleView): number {
  if (a.order !== b.order) return a.order < b.order ? -1 : 1;
  const ac = a.createdMs ?? Number.POSITIVE_INFINITY;
  const bc = b.createdMs ?? Number.POSITIVE_INFINITY;
  if (ac !== bc) return ac < bc ? -1 : 1;
  return a.bubbleId < b.bubbleId ? -1 : a.bubbleId > b.bubbleId ? 1 : 0;
}

/** First index of `list` (sorted by compareBubbles) whose bubble does not sort before `v`. */
function lowerBound(list: BubbleView[], v: BubbleView): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareBubbles(list[mid]!, v) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

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
 * next prompt. The last turn is open unless it has a turnDurationMs bubble, and it is open when it has a tool still in
 * a non-terminal status, or the thread's last bubble is its prompt, or the composer status is neither 'completed' nor
 * 'aborted' (Cursor's 'none' while generating, or no composer record yet).
 */
function analyze(thread: ThreadState): Analysis {
  if (thread.analysis !== null && thread.analysisVersion === thread.version) return thread.analysis;
  const sorted = thread.sorted;
  const turns: Turn[] = [];
  const turnOf: number[] = [];
  let minMs: number | null = null;
  let maxMs: number | null = null;
  let firstPromptTitle: string | null | undefined;
  const dispatches: Analysis['dispatches'] = [];
  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i]!;
    if (b.kind === 'prompt') {
      const prev = turns[turns.length - 1];
      if (prev !== undefined && !prev.ended) {
        prev.ended = true;
        prev.endMs = b.startMs;
      }
      turns.push({ promptNodeId: b.nodeId, startIndex: i, ended: false, hasTurnDuration: false, hasRunning: false, endMs: null });
      if (firstPromptTitle === undefined) firstPromptTitle = b.promptTitle;
    } else if (turns.length === 0) {
      turns.push({ promptNodeId: null, startIndex: 0, ended: false, hasTurnDuration: false, hasRunning: false, endMs: null });
    }
    const turn = turns[turns.length - 1]!;
    turnOf.push(turns.length - 1);
    if (b.hasTurnDuration) {
      turn.ended = true;
      turn.hasTurnDuration = true;
      turn.endMs = b.endMs ?? b.startMs;
    }
    if ((b.kind === 'tool' || b.kind === 'subagent') && isRunningRaw(b.toolStatus)) turn.hasRunning = true;
    if (b.kind === 'subagent' && b.toolCallId !== null) dispatches.push({ nodeId: b.nodeId, callId: b.toolCallId, index: i });
    minMs = minOf(minMs, b.startMs);
    maxMs = maxOf(maxMs, b.latestMs);
  }
  const last = turns[turns.length - 1];
  let open = false;
  if (last !== undefined && !last.hasTurnDuration) {
    const status = thread.composer?.status ?? null;
    open = last.hasRunning || sorted[sorted.length - 1]!.kind === 'prompt' || !(status === 'completed' || status === 'aborted');
  }
  const analysis: Analysis = { sorted, turns, turnOf, open, minMs, maxMs, firstPromptTitle, dispatches };
  thread.analysis = analysis;
  thread.analysisVersion = thread.version;
  return analysis;
}

/** A tool's status from its raw status: a non-terminal one in a turn that has ended never finished. */
function toolStatus(raw: string | null, turnEnded: boolean): { status: GraphNode['status']; note: string | null; neverFinished: boolean } {
  if (raw === 'completed') return { status: 'succeeded', note: null, neverFinished: false };
  if (raw === 'error') return { status: 'failed', note: null, neverFinished: false };
  if (raw === 'cancelled') return { status: 'failed', note: CANCELLED_NOTE, neverFinished: false };
  return turnEnded ? { status: 'failed', note: NEVER_FINISHED_NOTE, neverFinished: true } : { status: 'running', note: null, neverFinished: false };
}

/** Same node? (every field the normalizer sets) */
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

  apply(event: RawEvent, projectId: string): NormalizeResult {
    // Hooks are Task 5 (session-level marks); meta events are not produced for Cursor.
    if (event.source !== 'transcript') return { changes: [] };
    const changes: Change[] = [];
    try {
      const unknown = this.applyRecord(event, projectId, changes);
      return unknown === undefined ? { changes } : { changes, unknownRecordType: unknown };
    } catch {
      return { changes, unknownRecordType: 'normalizer-error' };
    }
  }

  dropSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Nothing is kept for a session before its first record (hooks are not handled yet). */
  needsPreSessionReplay(_sessionId: string): boolean {
    return false;
  }

  restorePreSession(_sessionId: string, _events: Iterable<RawEvent>): void {}

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
    if (!isObject(parsed)) return `${recordType}:invalid-json`;
    const threadId = event.agentId ?? event.sessionId;
    let unknown: string | undefined;
    let pendingView: { view: BubbleView; detail: Partial<NodeDetail> } | null = null;
    if (recordType === CURSOR_RECORD_TYPES.bubble) {
      const bubbleId = str(parsed.bubbleId);
      if (bubbleId === null) return 'bubble:missing-id';
      const out = bubbleView(parsed, bubbleId, `bubble:${threadId}:${bubbleId}`);
      unknown = out.unknown;
      pendingView = out;
    }

    const created = !this.sessions.has(event.sessionId);
    const state = this.stateFor(event.sessionId, projectId);
    if (projectId !== 'unknown' && (event.agentId === null || state.projectId === 'unknown')) state.projectId = projectId;
    const thread = this.threadFor(state, threadId, event.agentId);
    if (pendingView === null) {
      thread.composer = composerFacts(parsed);
      thread.version += 1;
      thread.dirtyFrom = 0; // its createdAt is the time of untimed leading nodes
    } else {
      const { view, detail } = pendingView;
      upsertBubble(thread, view);
      if (view.kind === null) state.pending.delete(view.nodeId);
      else state.pending.set(view.nodeId, detail);
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
        version: 0,
        analysis: null,
        analysisVersion: -1,
      };
      state.threads.set(id, thread);
    }
    return thread;
  }

  // ---- session ----

  /**
   * The session as a function of the records: title = the root composer's name, else its first prompt; cwd from the
   * root composer; created = the root composer's createdAt, else the earliest bubble; last activity = the latest
   * bubble time of any thread; status = running while the root conversation's last turn is open, else idle.
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
    return {
      ...state.session,
      projectId: state.projectId,
      cwd: root?.composer?.cwd ?? null,
      title: root?.composer?.name ?? ra?.firstPromptTitle ?? null,
      status: ra?.open ? 'running' : 'idle',
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
   * Which threads are shown: the main conversation, and (breadth-first from it) every subagent conversation whose
   * composer's subagentInfo.toolCallId equals the toolCallId of a task_v2 bubble in a shown thread. Several candidates
   * for one call: the smallest composer id. A subagent without such a dispatch is held (not shown).
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
    const shown = new Map<string, string | null>([[rootId, null]]);
    const childOf = new Map<string, string>();
    const ownerOf = new Map<string, string>();
    const queue = [rootId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      const t = state.threads.get(id);
      if (!t) continue;
      for (const d of analyze(t).dispatches) {
        const child = byCall.get(d.callId)?.find((c) => !shown.has(c));
        if (child === undefined || childOf.has(d.nodeId)) continue;
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
   * dispatch node from that node's turn on (a dispatch's status, end and title follow its subagent). A thread that is
   * not shown is not derived; its changes wait in `dirtyFrom`. Parents are derived before their subagents.
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
   * The thread's nodes and edges. Bubbles are chained in order (prompt / text / thinking / tool / dispatch; unknown
   * shapes make no node but still end turns). Parallel rule: a tool or dispatch bubble that starts before the end of
   * the run of calls just before it joins that run — every member hangs off the run's parent (fork), and the next
   * node hangs off the last member with an edge from every member (join); a call's end is completedAtMs, else
   * (completed) the next bubble's start, else (still running, error or cancelled without an end) open. A subagent
   * thread's first node hangs off its dispatch node (spawn edge).
   *
   * Only the part that can differ is derived: from the start of the turn before the one holding bubble `from` (a
   * bubble can change its own turn's statuses and, being a prompt, end the previous turn), resuming the scan from the
   * checkpoint saved before that turn's prompt. Without a usable checkpoint (or when that prompt has no time, so an
   * earlier node's end could depend on later bubbles) the whole thread is derived.
   */
  private deriveThread(
    state: SessionState,
    thread: ThreadState,
    dispatch: string | null,
    links: Links,
    from: number,
  ): { nodes: DerivedNode[]; edges: GraphEdge[] } {
    const a = analyze(thread);
    const sid = state.session.id;
    const nodes: DerivedNode[] = [];
    const edges: GraphEdge[] = [];
    const edge = (from: string, to: string, kind: GraphEdge['kind'], suffix = ''): void => {
      edges.push({ id: `${from}->${to}${suffix}`, sessionId: sid, from, to, kind });
    };
    let prevNode: string | null = null;
    let prevTs: string | null = null;
    let batch: Scan['batch'] = null;
    const fallbackTs = isoOf(thread.composer?.createdAt ?? null) ?? EPOCH;

    let start = 0;
    if (from > 0 && a.sorted.length > 0) {
      const turnIndex = a.turnOf[Math.min(from, a.sorted.length - 1)]!;
      const s = a.turns[Math.max(0, turnIndex - 1)]!.startIndex;
      const head = a.sorted[s]!;
      const cp = s > 0 && head.startMs !== null ? thread.checkpoints.get(head.nodeId) : undefined;
      if (cp !== undefined) {
        start = s;
        prevNode = cp.prevNode;
        prevTs = cp.prevTs;
        batch = cp.batch === null ? null : { ...cp.batch, members: [...cp.batch.members] };
      }
    }

    for (let i = start; i < a.sorted.length; i++) {
      const b = a.sorted[i]!;
      if (b.kind === null) continue;
      if (b.kind === 'prompt') {
        thread.checkpoints.set(b.nodeId, { prevNode, prevTs, batch: batch === null ? null : { ...batch, members: [...batch.members] } });
      }
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
      if (isCall) {
        const own = toolStatus(b.toolStatus, turn.ended);
        const child = b.kind === 'subagent' ? links.childOf.get(b.nodeId) : undefined;
        const childThread = child === undefined ? undefined : state.threads.get(child);
        if (b.kind === 'subagent') {
          childAgentId = child ?? null;
          title = childThread?.composer?.subagentTypeName ?? b.agentType ?? b.title;
        }
        if (childThread !== undefined) {
          // A dispatch follows its subagent: running while its last turn is open, then the task_v2 call's own status.
          const ca = analyze(childThread);
          if (ca.sorted.length === 0 || ca.open) status = 'running';
          else {
            status = own.status === 'running' ? 'succeeded' : own.status;
            note = own.note;
            endedMs = b.endMs ?? ca.maxMs;
          }
        } else {
          status = own.status;
          note = own.note;
          if (status !== 'running') endedMs = b.endMs ?? (own.neverFinished ? (turn.endMs ?? nextStart) : nextStart);
        }
        if (endedMs !== null && !Number.isNaN(startMs)) durationMs = Math.max(0, endedMs - startMs);
      } else if (b.kind === 'thinking') {
        durationMs = b.thinkingMs;
      }

      // Placement.
      let parentId: string | null;
      const runEnd = b.endMs ?? (b.toolStatus === 'completed' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY);
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
    return { nodes, edges };
  }

  /** Emits what differs from what was emitted before: new nodes, changed fields / details, new or changed edges. */
  private emit(state: SessionState, derived: { nodes: DerivedNode[]; edges: GraphEdge[] }, changes: Change[]): void {
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
    for (const e of derived.edges) {
      const sig = `${e.from}>${e.to}>${e.kind}`;
      if (state.edges.get(e.id) === sig) continue;
      state.edges.set(e.id, sig);
      changes.push({ type: 'edge_added', edge: e });
    }
  }
}
