import {
  TERMINAL_STATUSES,
  type Change,
  type GraphEdge,
  type GraphNode,
  type NodeDetail,
  type Session,
} from '@agent-canvas/shared';
import type { RawEvent } from '../store/store.js';
import { parseCodexHook, type CodexHook } from './codex-hooks.js';
import { summarize } from './summary.js';
import type { AgentNormalizer, NormalizeResult } from './types.js';

/*
 * The Codex normalizer: Codex rollout records (one file per thread; subagent threads carry agentId = their thread id)
 * and the session-index titles in, the shared Change stream out. Record structure checked against Codex 0.142.5
 * (spec section 2.2). Every session it creates has origin 'codex'.
 */

const EPOCH = '1970-01-01T00:00:00.000Z';
/** Title sources, highest priority first: the session index (`thread_name`), then the first root-thread prompt. */
const TITLE_PRIORITY = ['index', 'prompt'] as const;
type TitleSource = (typeof TITLE_PRIORITY)[number];
const PROMPT_TITLE_CHARS = 60;

/** Prompt text as a title: trimmed, whitespace collapsed, first 60 code points; null when nothing is left. */
export function promptTitle(text: string): string | null {
  const folded = text.trim().replace(/\s+/g, ' ');
  if (folded.replace(/\[image\]/g, '').trim() === '') return null;
  return Array.from(folded).slice(0, PROMPT_TITLE_CHARS).join('');
}

/** Top-level record types that are known and produce nothing. */
const IGNORED_RECORDS = new Set(['turn_context', 'world_state', 'inter_agent_communication_metadata']);
const IGNORED_EVENTS = new Set(['token_count', 'thread_settings_applied']);
const IGNORED_RESPONSE_ITEMS = new Set(['additional_tools', 'agent_message', 'configuration_update']);
/** `item_completed` items that produce no node of their own (Reasoning and SubAgentActivity are still read). */
const IGNORED_ITEMS = new Set(['AgentMessage', 'Reasoning', 'ContextCompaction', 'SubAgentActivity']);
/** `item_completed` items that are what a tool call actually did: folded into the open call. */
const FOLDED_ITEMS = new Set(['CommandExecution', 'McpToolCall', 'FileChange', 'ImageView', 'Extension', 'CollabAgentToolCall']);
const CALLS = new Set(['custom_tool_call', 'function_call']);
const OUTPUTS = new Set(['custom_tool_call_output', 'function_call_output']);

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** Epoch milliseconds as ISO time; null for anything a Date cannot represent (NaN, ±1e20, …). */
function isoOf(ms: number | null): string | null {
  if (ms === null) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
/** Epoch milliseconds of an ISO time; null when it does not parse. */
function msOf(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}
const obj = (v: unknown): Obj => (isObject(v) ? v : {});
const lastSegment = (p: string | null): string | null => {
  if (p === null) return null;
  const seg = p.split('/').filter((s) => s !== '').pop();
  return seg ?? null;
};

/** Milliseconds from `start` to `end` (never negative); null when either time cannot be parsed. */
function elapsedMs(start: string, end: string): number | null {
  const a = Date.parse(start);
  const b = Date.parse(end);
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.max(0, b - a);
}

/** One thing a tool call did (a command, an MCP call, a file change, …), as listed in the call node's detail. */
interface FoldEntry {
  type: string;
  name: string;
  status: string | null;
  exitCode: number | null;
  durationMs: number | null;
}

interface Turn {
  id: string;
  endedAt: string | null;
  failed: boolean;
}

interface ThreadState {
  /** Thread id (the session id for the root thread). */
  id: string;
  /** null for the root thread. */
  agentId: string | null;
  /** `subagent_history_start_ordinal`: records with a smaller ordinal are the parent's history copied into this file. */
  historyStart: number | null;
  parentThreadId: string | null;
  nickname: string | null;
  agentPath: string | null;
  /** Time of the thread's own session_meta (orders threads spawned under the same name). */
  startedAt: string;
  /** Last node placed in this thread: the next node hangs off it. */
  lastNode: string | null;
  firstNode: string | null;
  /** The last node placed is a compact node (consecutive compaction records make one node). */
  lastWasCompact: boolean;
  /** Turns in start order. */
  turns: Turn[];
  /** Turn of records that carry no turn id. */
  currentTurn: string | null;
  /** Tool node ids of calls still waiting for their output, in open order. */
  openCalls: string[];
  /** Every call of the thread with its time window [call record, output record] (end null while open), in file order. */
  callWindows: { nodeId: string; startMs: number; endMs: number | null }[];
  /** call_id -> tool node id. */
  callNodes: Map<string, string>;
  /** The current turn has an `item_completed/UserMessage` (subagent prompt synthesis is then not needed). */
  turnHasUserMessage: boolean;
  /** The current turn has had model output (assistant text, reasoning, a call). */
  turnHasOutput: boolean;
  /** Subagent threads: the last role-user message of the current turn before its first model output. */
  pendingTask: { id: string | null; text: string; ts: string; offset: number } | null;
  /** Increases at every record that ends a model response's run of calls (see parallel calls). */
  group: number;
  /** The current run of calls of one response (parallel siblings). */
  batch: { group: number; parentId: string | null; members: string[] } | null;
  /** Reasoning item id -> duration from its `item_completed/Reasoning`, until the reasoning node exists. */
  reasoningMs: Map<string, number>;
  /** Reasoning item id -> its thinking node id. */
  reasoningNodes: Map<string, string>;
  /** Tool and dispatch node ids of the thread's calls, in placement order. */
  callOrder: string[];
  /** Per turn id: its calls still waiting for an output record, and how many got one. */
  turnCalls: Map<string, { open: Set<string>; settled: number }>;
  /** Time of the thread's last record with a valid timestamp (the fallback for one without). */
  lastTs: string | null;
  /**
   * Model-output nodes (assistant text, thinking, calls) placed in this thread since its last `token_usage_record`, in
   * placement order: the nodes of the response that record will account for.
   */
  responseNodes: string[];
  /** Every node placed in this thread, in placement order (usage fallback: nearest earlier node of the turn). */
  placed: string[];
  /** Response ids (or record identities) whose usage was already applied in this thread. */
  usageSeen: Set<string>;
}

/** How many sessions that exist only as hook marks (no transcript, no session yet) are remembered. */
const MAX_UNSEEN_HOOK_SESSIONS = 200;

/** What the hooks have said about one turn (keyed by the payload's turn_id; '' = a hook without one). */
interface HookTurnMark {
  /** UserPromptSubmit, or a tool / permission hook: the turn is active. */
  started: boolean;
  /**
   * Stop / Interrupt: the turn is over. A late tool hook of the same turn does not reopen it; a later
   * UserPromptSubmit or PermissionRequest of that turn does (the turn went on after a Stop hook asked it to).
   */
  stopped: boolean;
  /** PermissionRequest, not yet followed by another hook of the turn. */
  permission: boolean;
  /**
   * A hook of this turn carried an agent_id: it is a subagent's turn. It never counts toward the session's status,
   * also before (or without) the transcript placing the turn in a child thread.
   */
  child: boolean;
}

/**
 * The hook marks of one session, in the order the hooks were received. Kept outside SessionState (like titles) so a
 * hook received before its session exists (a Stop, a SessionEnd) still counts once the session appears.
 */
interface HookMarks {
  turns: Map<string, HookTurnMark>;
  /** The latest session-level mark is a SessionEnd (a SessionStart / UserPromptSubmit after it resumes). */
  ended: boolean;
  /** Earliest and latest receive time of the session's hooks. */
  firstAt: string | null;
  lastAt: string | null;
}

interface Spawn {
  /** Thread the spawn_agent call was made in. */
  threadId: string;
  callId: string;
  taskName: string | null;
  toolName: string;
  timestamp: string;
}

interface SessionState {
  session: Session;
  /** A transcript record of the session has been applied: from then on hooks never set its project or cwd. */
  transcriptSeen: boolean;
  /** startedAt / lastActivityAt come from a valid time (false only while every record so far had an unusable one). */
  timed: boolean;
  /** Turn id -> the thread the transcript puts it in (the root thread wins over a subagent thread) and that turn. */
  turnThread: Map<string, { threadId: string; turn: Turn }>;
  /** Nodes shown as awaiting_permission by a pending permission request -> the status the transcript gave them. */
  awaiting: Map<string, GraphNode['status']>;
  nodes: Map<string, GraphNode>;
  /** Tool node id -> its input, while the call is open. */
  toolInputs: Map<string, unknown>;
  /** Tool node id -> what was folded into it. */
  folded: Map<string, FoldEntry[]>;
  threads: Map<string, ThreadState>;
  /** Dispatch node id -> the spawn_agent call. */
  spawns: Map<string, Spawn>;
  /** call_id -> the thread a SubAgentActivity says the call started. */
  activity: Map<string, { agentThreadId: string; agentPath: string | null }>;
  /** child thread id -> its dispatch node, as currently resolved. */
  dispatchOf: Map<string, string>;
  /** child threads whose spawn edge was emitted. */
  spawned: Set<string>;
  firstPromptSeen: boolean;
  /** `token_usage_record`s with valid counts but no node of their turn in their thread (their usage is dropped). */
  droppedUsage: number;
}

type Transcript = Extract<RawEvent, { source: 'transcript' }>;

/** What a record is, decided before any state is touched (unknown records change nothing). */
type Kind =
  | { kind: 'unknown'; type: string }
  | { kind: 'ignored' }
  | { kind: 'handled' };

function classify(type: string, payload: Obj): Kind {
  const ptype = str(payload.type);
  const named = ptype === null ? type : `${type}/${ptype}`;
  switch (type) {
    case 'session_meta':
    case 'compacted':
    case 'token_usage_record':
      return { kind: 'handled' };
    case 'event_msg':
      if (ptype === 'task_started' || ptype === 'task_complete' || ptype === 'turn_aborted') return { kind: 'handled' };
      if (ptype !== null && IGNORED_EVENTS.has(ptype)) return { kind: 'ignored' };
      if (ptype === 'item_completed') {
        const itype = str(obj(payload.item).type);
        if (itype === 'UserMessage' || (itype !== null && (FOLDED_ITEMS.has(itype) || IGNORED_ITEMS.has(itype)))) return { kind: 'handled' };
        return { kind: 'unknown', type: `item_completed/${itype ?? '?'}` };
      }
      return { kind: 'unknown', type: named };
    case 'response_item':
      if (ptype === 'message' || ptype === 'reasoning' || ptype === 'compaction') return { kind: 'handled' };
      if (ptype !== null && (CALLS.has(ptype) || OUTPUTS.has(ptype))) return { kind: 'handled' };
      if (ptype !== null && IGNORED_RESPONSE_ITEMS.has(ptype)) return { kind: 'ignored' };
      return { kind: 'unknown', type: named };
    default:
      if (IGNORED_RECORDS.has(type)) return { kind: 'ignored' };
      return { kind: 'unknown', type: named };
  }
}

/** Duration of a folded item: its own `duration` ({secs, nanos}) or `durationMs`, else the record's start/end times. */
function itemDuration(item: Obj, payload: Obj): number | null {
  const d = obj(item.duration);
  const secs = num(d.secs);
  const nanos = num(d.nanos);
  if (secs !== null || nanos !== null) return Math.round((secs ?? 0) * 1000 + (nanos ?? 0) / 1e6);
  const ms = num(item.durationMs);
  if (ms !== null) return ms;
  const a = num(payload.started_at_ms);
  const b = num(payload.completed_at_ms);
  return a !== null && b !== null ? Math.max(0, b - a) : null;
}

/** The command / tool / path a folded item names (no output, no arguments). */
function itemName(type: string, item: Obj): string {
  switch (type) {
    case 'CommandExecution': {
      const parsed = Array.isArray(item.parsed_cmd) ? item.parsed_cmd.flatMap((p) => (isObject(p) && typeof p.cmd === 'string' ? [p.cmd] : [])) : [];
      if (parsed.length > 0) return parsed.join(' && ');
      if (Array.isArray(item.command)) return String(item.command[item.command.length - 1] ?? '');
      return str(item.command) ?? '';
    }
    case 'McpToolCall': {
      const tool = str(item.tool) ?? '';
      const server = str(item.server);
      return server !== null && server !== '' ? `${server}.${tool}` : tool;
    }
    case 'FileChange':
      return Object.keys(obj(item.changes)).join(', ');
    case 'ImageView':
      return str(item.path) ?? '';
    case 'Extension':
      return str(item.kind) ?? '';
    case 'CollabAgentToolCall':
      return str(item.tool) ?? '';
    default:
      return '';
  }
}

const entryFailed = (e: FoldEntry): boolean => e.status === 'failed' || (e.exitCode !== null && e.exitCode !== 0);

const isTerminal = (s: GraphNode['status']): boolean => s !== null && TERMINAL_STATUSES.includes(s);

/** Text parts of a content list: `pick` maps one part to its text (null = skipped). */
function joinParts(content: unknown, pick: (part: Obj) => string | null, sep: string): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  return content.flatMap((p) => {
    const t = isObject(p) ? pick(p) : null;
    return t === null ? [] : [t];
  }).join(sep);
}

/** `function_call.arguments` is a JSON string; anything that does not parse is kept as it is. */
function parseArguments(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? null;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}

export class CodexNormalizer implements AgentNormalizer {
  private readonly sessions = new Map<string, SessionState>();
  /**
   * Current title per source, per session. Kept outside SessionState so a title arriving before its session exists
   * (the session index read before the root thread's file) is not lost, and replaying raw events in order (also after
   * an eviction) rebuilds the same values.
   */
  private readonly titleSources = new Map<string, Partial<Record<TitleSource, string>>>();
  /** Sessions without state whose pre-session memory (titles, hook marks) was restored by restorePreSession. */
  private readonly preSessionRestored = new Set<string>();
  /** Hook marks per session (see HookMarks); like titles, they may exist before the session does. */
  private readonly hookMarks = new Map<string, HookMarks>();

  apply(event: RawEvent, projectId: string): NormalizeResult {
    // Every state mutation pushes its change right away, so on a failure the changes made so far are still returned:
    // the derived data never falls behind the in-memory state.
    const changes: Change[] = [];
    try {
      if (event.source === 'transcript') {
        const unknown = this.applyTranscript(event, projectId, changes);
        const state = this.sessions.get(event.sessionId);
        if (state) this.refresh(state, changes);
        return unknown === undefined ? { changes } : { changes, unknownRecordType: unknown };
      }
      if (event.source === 'meta') {
        this.applyMeta(event, changes);
        return { changes };
      }
      const unknown = this.applyHook(event, projectId, changes);
      return unknown === undefined ? { changes } : { changes, unknownRecordType: unknown };
    } catch {
      return { changes, unknownRecordType: 'normalizer-error' };
    }
  }

  dropSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.titleSources.delete(sessionId);
    this.hookMarks.delete(sessionId);
    this.preSessionRestored.delete(sessionId);
  }

  needsPreSessionReplay(sessionId: string): boolean {
    return !this.sessions.has(sessionId) && !this.preSessionRestored.has(sessionId);
  }

  /**
   * Before a session exists the only things kept are its titles (index meta events) and its hook marks (hooks that do
   * not create a session): restored from them, in order.
   */
  restorePreSession(sessionId: string, events: Iterable<RawEvent>): void {
    this.dropSession(sessionId);
    try {
      for (const ev of events) {
        if (ev.source === 'meta' && ev.sessionId === sessionId) this.applyMeta(ev, []);
        else if (ev.source === 'hook') {
          const parsed = parseCodexHook(ev.eventName, ev.payload);
          if (parsed.ok && parsed.hook.sessionId === sessionId) this.recordHook(parsed.hook, ev.receivedAt);
        }
      }
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

  toolInputCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.toolInputs.size ?? 0;
  }

  /**
   * Number of the session's `token_usage_record`s whose usage was dropped (no node of their turn in their thread when
   * they were read). Held in memory with the session: rebuilt identically by a re-hydration, 0 for an evicted session.
   */
  droppedUsageCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.droppedUsage ?? 0;
  }

  // ---- titles ----

  private applyMeta(event: Extract<RawEvent, { source: 'meta' }>, changes: Change[]): void {
    if (event.agentId !== null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.payload);
    } catch {
      return;
    }
    if (isObject(parsed)) this.setTitle(event.sessionId, 'index', str(parsed.thread_name), changes);
  }

  private bestTitle(sessionId: string): string | null {
    const sources = this.titleSources.get(sessionId);
    if (!sources) return null;
    for (const source of TITLE_PRIORITY) if (sources[source] !== undefined) return sources[source]!;
    return null;
  }

  private setTitle(sessionId: string, source: TitleSource, value: string | null, changes: Change[]): void {
    if (value === null || value.trim() === '') return;
    const sources = this.titleSources.get(sessionId) ?? {};
    sources[source] = value.trim();
    this.titleSources.set(sessionId, sources);
    const state = this.sessions.get(sessionId);
    if (state) this.commitSession(state, { ...state.session, title: this.bestTitle(sessionId) }, changes);
  }

  // ---- session ----

  private stateFor(sessionId: string, ts: string, projectId: string, changes: Change[], timed = true): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      const session: Session = {
        id: sessionId,
        projectId,
        origin: 'codex',
        cwd: null,
        title: this.bestTitle(sessionId),
        gitBranch: null,
        status: 'idle',
        sourceDeleted: false,
        startedAt: ts,
        lastActivityAt: ts,
      };
      state = {
        session,
        transcriptSeen: false,
        timed,
        turnThread: new Map(),
        awaiting: new Map(),
        nodes: new Map(),
        toolInputs: new Map(),
        folded: new Map(),
        threads: new Map(),
        spawns: new Map(),
        activity: new Map(),
        dispatchOf: new Map(),
        spawned: new Set(),
        firstPromptSeen: false,
        droppedUsage: 0,
      };
      this.sessions.set(sessionId, state);
      this.preSessionRestored.delete(sessionId);
      changes.push({ type: 'session_upserted', session });
      // Hooks received before the session existed still count for its times.
      const marks = this.hookMarks.get(sessionId);
      if (marks?.firstAt != null && marks.lastAt !== null) {
        this.commitSession(state, this.withTime(state, marks.lastAt, this.withTime(state, marks.firstAt)), changes);
      }
    }
    return state;
  }

  private threadFor(state: SessionState, event: Transcript, ts: string): ThreadState {
    const id = event.agentId ?? event.sessionId;
    let thread = state.threads.get(id);
    if (!thread) {
      thread = {
        id,
        agentId: event.agentId,
        historyStart: null,
        parentThreadId: null,
        nickname: null,
        agentPath: null,
        startedAt: ts,
        lastNode: null,
        firstNode: null,
        lastWasCompact: false,
        turns: [],
        currentTurn: null,
        openCalls: [],
        callWindows: [],
        callNodes: new Map(),
        turnHasUserMessage: false,
        turnHasOutput: false,
        pendingTask: null,
        group: 0,
        batch: null,
        reasoningMs: new Map(),
        reasoningNodes: new Map(),
        callOrder: [],
        turnCalls: new Map(),
        lastTs: null,
        responseNodes: [],
        placed: [],
        usageSeen: new Set(),
      };
      state.threads.set(id, thread);
    }
    return thread;
  }

  /**
   * Times and project, whatever thread the record is in: the activity time is the latest record time and the start
   * the earliest (so the order threads' files are read in does not matter); the root thread's project wins over a
   * subagent thread's (which may have been classified from its own worktree before the root was seen).
   */
  private touchSession(state: SessionState, ts: string | null, projectId: string, isRoot: boolean, changes: Change[]): void {
    const next = ts === null ? { ...state.session } : this.withTime(state, ts);
    if (projectId !== 'unknown' && (isRoot || next.projectId === 'unknown')) next.projectId = projectId;
    this.commitSession(state, next, changes);
  }

  /** The latest time is the activity time, the earliest the start (min / max: the order of arrival does not matter). */
  private withTime(state: SessionState, ts: string, s: Session = state.session): Session {
    if (!state.timed) {
      state.timed = true;
      return { ...s, lastActivityAt: ts, startedAt: ts };
    }
    return { ...s, lastActivityAt: ts > s.lastActivityAt ? ts : s.lastActivityAt, startedAt: ts < s.startedAt ? ts : s.startedAt };
  }

  /** Recomputes everything derived from transcript state + hook marks together: the session status and the overlay. */
  private refresh(state: SessionState, changes: Change[]): void {
    const view = this.statusView(state);
    if (view.status !== state.session.status) this.commitSession(state, { ...state.session, status: view.status }, changes);
    this.applyAwaiting(state, view.permissionTargets, changes);
  }

  /**
   * The session status as a function of state (never of arrival times or order):
   *  - a turn belongs to the root thread or a subagent thread when the transcript says so, else it is unknown yet;
   *    turns of a subagent thread never affect the session status;
   *  - a turn is finished when the transcript ended it (task_complete / turn_aborted), a Stop / Interrupt hook named
   *    it, or (root thread) a later root turn has started;
   *  - ended: the latest session-level hook mark is a SessionEnd;
   *  - awaiting_permission: a root or unknown turn has a pending permission request and is not finished;
   *  - running: the root thread's latest turn is open in the transcript and no Stop / Interrupt hook stopped it, or a
   *    hook started a root or unknown turn that is not finished;
   *  - idle otherwise.
   * A permission request is pending until a later hook of its turn, the end of its turn, or the transcript shows every
   * call of that turn settled (at least one). Also returns, per pending request, the node it marks.
   */
  private statusView(state: SessionState): { status: Session['status']; permissionTargets: Set<string> } {
    const marks = this.hookMarks.get(state.session.id);
    const rootId = state.session.id;
    const root = state.threads.get(rootId);
    const rootLatest = root?.turns[root.turns.length - 1];
    const ownerOf = (turnId: string): string | undefined => state.turnThread.get(turnId)?.threadId;
    const finished = (turnId: string, mark: HookTurnMark | undefined): boolean => {
      if (mark?.stopped) return true;
      const known = state.turnThread.get(turnId);
      if (known === undefined) return false;
      if (known.turn.endedAt !== null) return true;
      return known.threadId === rootId && rootLatest !== undefined && rootLatest.id !== turnId;
    };
    const settledInTranscript = (turnId: string): boolean => {
      const tc = state.threads.get(ownerOf(turnId) ?? rootId)?.turnCalls.get(turnId);
      return tc !== undefined && tc.settled > 0 && tc.open.size === 0;
    };
    const relevant = (turnId: string, mark: HookTurnMark): boolean => {
      const owner = ownerOf(turnId);
      return owner === undefined ? !mark.child : owner === rootId;
    };

    const permissionTargets = new Set<string>();
    let awaiting = false;
    let hookRunning = false;
    for (const [turnId, mark] of marks?.turns ?? []) {
      if (finished(turnId, mark)) continue;
      if (mark.started && relevant(turnId, mark)) hookRunning = true;
      if (!mark.permission || settledInTranscript(turnId)) continue;
      if (relevant(turnId, mark)) awaiting = true;
      // A subagent's turn the transcript has not placed yet has no thread to mark a node in.
      if (mark.child && ownerOf(turnId) === undefined) continue;
      const target = this.permissionTarget(state, turnId);
      if (target !== undefined) permissionTargets.add(target);
    }
    let status: Session['status'];
    if (marks?.ended) status = 'ended';
    else if (awaiting) status = 'awaiting_permission';
    else if ((rootLatest !== undefined && rootLatest.endedAt === null && !marks?.turns.get(rootLatest.id)?.stopped) || hookRunning) status = 'running';
    else status = 'idle';
    return { status, permissionTargets };
  }

  /**
   * The node a pending permission request of a turn marks: the latest call node of the turn's thread (the root thread
   * while the turn is unknown) whose transcript status is not terminal; when the turn is known, only its own calls.
   */
  private permissionTarget(state: SessionState, turnId: string): string | undefined {
    const owner = state.turnThread.get(turnId)?.threadId;
    const thread = state.threads.get(owner ?? state.session.id);
    if (!thread) return undefined;
    for (let i = thread.callOrder.length - 1; i >= 0; i--) {
      const id = thread.callOrder[i]!;
      const node = state.nodes.get(id);
      if (!node || isTerminal(this.baseStatus(state, node))) continue;
      if (owner !== undefined && node.turnId !== turnId) continue;
      return id;
    }
    return undefined;
  }

  /** A node's status as the transcript set it (under a possible awaiting_permission overlay). */
  private baseStatus(state: SessionState, node: GraphNode): GraphNode['status'] {
    return state.awaiting.has(node.id) ? (state.awaiting.get(node.id) ?? null) : node.status;
  }

  /** Shows awaiting_permission on exactly `targets`; a node that leaves the set gets its transcript status back. */
  private applyAwaiting(state: SessionState, targets: Set<string>, changes: Change[]): void {
    for (const [id, base] of [...state.awaiting]) {
      if (targets.has(id)) continue;
      state.awaiting.delete(id);
      const node = state.nodes.get(id);
      if (node && node.status !== base) this.writeNode(state, id, { status: base }, changes);
    }
    for (const id of targets) {
      if (state.awaiting.has(id)) continue;
      const node = state.nodes.get(id);
      if (!node) continue;
      state.awaiting.set(id, node.status);
      this.writeNode(state, id, { status: 'awaiting_permission' }, changes);
    }
  }

  private commitSession(state: SessionState, next: Session, changes: Change[]): void {
    const s = state.session;
    const same =
      s.lastActivityAt === next.lastActivityAt &&
      s.startedAt === next.startedAt &&
      s.cwd === next.cwd &&
      s.gitBranch === next.gitBranch &&
      s.projectId === next.projectId &&
      s.title === next.title &&
      s.status === next.status;
    if (same) return;
    state.session = next;
    changes.push({ type: 'session_upserted', session: next });
  }

  // ---- records ----

  /** Pushes the record's changes; returns the unknown-record label, if any. */
  private applyTranscript(event: Transcript, projectId: string, changes: Change[]): string | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.line);
    } catch {
      return 'invalid-json';
    }
    if (!isObject(parsed)) return 'invalid-json';
    const type = parsed.type;
    if (typeof type !== 'string') return 'missing-type';
    const payload = obj(parsed.payload);
    const kind = classify(type, payload);
    if (kind.kind === 'unknown') return kind.type;

    // A record time that does not parse is not a time: the thread's (else the session's) previous valid time is used
    // for the record, and it never becomes the session's start or activity time.
    const rawTs = str(parsed.timestamp);
    const validTs = rawTs !== null && msOf(rawTs) !== null ? rawTs : null;
    const existing = this.sessions.get(event.sessionId);
    const ts = validTs ?? existing?.threads.get(event.agentId ?? event.sessionId)?.lastTs ?? (existing?.timed ? existing.session.lastActivityAt : null) ?? EPOCH;
    const state = this.stateFor(event.sessionId, ts, projectId, changes, validTs !== null);
    if (!state.transcriptSeen) {
      // A session a hook created takes its project and cwd from the transcript from its first record on (as if the
      // hooks had never come): the record's project, and no cwd until the root thread's session_meta.
      state.transcriptSeen = true;
      const nextProject = projectId !== 'unknown' ? projectId : state.session.projectId;
      this.commitSession(state, { ...state.session, projectId: nextProject, cwd: null }, changes);
    }
    const thread = this.threadFor(state, event, ts);
    const isRoot = event.agentId === null;

    // The parent's history copied into a forked thread's file: already shown in the parent's thread.
    const ordinal = num(parsed.ordinal);
    if (thread.historyStart !== null && ordinal !== null && ordinal > 0 && ordinal < thread.historyStart) return undefined;
    // A second session_meta in the file is the parent's (copied with its history).
    if (type === 'session_meta' && str(payload.id) !== null && str(payload.id) !== thread.id) return undefined;

    if (validTs !== null) thread.lastTs = validTs;
    this.touchSession(state, validTs, projectId, isRoot, changes);
    if (kind.kind === 'ignored') {
      if (type === 'response_item') thread.group += 1; // ends a response's run of calls
      return undefined;
    }
    const ctx: Ctx = { state, thread, event, payload, ts, changes, isRoot, unknown: undefined };
    switch (type) {
      case 'session_meta':
        this.applySessionMeta(ctx);
        break;
      case 'compacted':
        this.addCompact(ctx, str(payload.message));
        break;
      case 'event_msg':
        this.applyEventMsg(ctx);
        break;
      case 'response_item':
        this.applyResponseItem(ctx);
        break;
      case 'token_usage_record':
        thread.group += 1; // ends a response's run of calls
        this.applyUsage(ctx);
        break;
    }
    return ctx.unknown;
  }

  private applySessionMeta(ctx: Ctx): void {
    const { state, thread, payload, isRoot, changes } = ctx;
    const spawn = obj(obj(obj(payload.source).subagent).thread_spawn);
    thread.historyStart = num(payload.subagent_history_start_ordinal);
    thread.parentThreadId = str(payload.parent_thread_id) ?? str(spawn.parent_thread_id);
    thread.nickname = str(payload.agent_nickname) ?? str(spawn.agent_nickname);
    thread.agentPath = str(payload.agent_path) ?? str(spawn.agent_path);
    thread.startedAt = ctx.ts;
    if (isRoot) {
      const cwd = str(payload.cwd);
      if (cwd !== null) this.commitSession(state, { ...state.session, cwd }, changes);
    } else {
      this.refreshDispatches(state, changes);
    }
  }

  private applyEventMsg(ctx: Ctx): void {
    const { thread, payload } = ctx;
    switch (str(payload.type)) {
      case 'task_started': {
        thread.group += 1;
        const id = str(payload.turn_id) ?? `turn@${ctx.event.offset}`;
        const turn: Turn = { id, endedAt: null, failed: false };
        thread.turns.push(turn);
        this.placeTurn(ctx.state, turn, thread);
        thread.currentTurn = id;
        thread.turnHasUserMessage = false;
        thread.turnHasOutput = false;
        thread.pendingTask = null;
        this.threadTurnsChanged(ctx);
        break;
      }
      case 'task_complete': {
        thread.group += 1;
        const error = payload.error;
        const failed = error !== undefined && error !== null;
        if (failed) {
          const message = isObject(error) ? (str(error.message) ?? JSON.stringify(error)) : String(error);
          this.addSystem(ctx, { title: 'Turn failed', subtype: 'interrupt', text: message });
        }
        this.endTurn(ctx, failed);
        break;
      }
      case 'turn_aborted': {
        thread.group += 1;
        const reason = str(payload.reason) ?? 'aborted';
        this.addSystem(ctx, { title: 'Interrupted', subtype: 'interrupt', text: reason });
        this.endTurn(ctx, true);
        break;
      }
      case 'item_completed':
        this.applyItem(ctx, obj(payload.item));
        break;
    }
  }

  private endTurn(ctx: Ctx, failed: boolean): void {
    const { thread } = ctx;
    const id = this.turnOf(ctx);
    let turn = id === null ? undefined : thread.turns.find((t) => t.id === id);
    if (!turn) {
      // The end of a turn whose start this file does not have.
      turn = { id: id ?? `turn@${ctx.event.offset}`, endedAt: null, failed: false };
      thread.turns.push(turn);
      this.placeTurn(ctx.state, turn, thread);
    }
    turn.endedAt = ctx.ts;
    turn.failed = failed;
    // Calls left without an output (an aborted turn) stop being fold targets: nothing after the turn ran inside them.
    const endMs = msOf(ctx.ts);
    for (const w of thread.callWindows) if (w.endMs === null && endMs !== null) w.endMs = endMs;
    thread.openCalls = [];
    thread.pendingTask = null;
    this.threadTurnsChanged(ctx);
  }

  /** Records which thread a turn is in (the root thread wins over a subagent thread naming the same turn id). */
  private placeTurn(state: SessionState, turn: Turn, thread: ThreadState): void {
    const known = state.turnThread.get(turn.id);
    // The thread's latest turn of that id; a subagent thread never takes a turn id over from the root thread.
    if (known === undefined || known.threadId === thread.id || thread.agentId === null) state.turnThread.set(turn.id, { threadId: thread.id, turn });
  }

  /** A turn of the thread started or ended: dispatches following it (its own, and those spawned in it) re-derive. */
  private threadTurnsChanged(ctx: Ctx): void {
    const dispatch = ctx.state.dispatchOf.get(ctx.thread.id);
    if (dispatch !== undefined) this.applyDispatchStatus(ctx.state, dispatch, ctx.changes);
    for (const [id, spawn] of ctx.state.spawns) if (spawn.threadId === ctx.thread.id) this.applyDispatchStatus(ctx.state, id, ctx.changes);
  }

  private applyItem(ctx: Ctx, item: Obj): void {
    const { thread, payload } = ctx;
    const itype = str(item.type) ?? '';
    const itemId = str(item.id);
    switch (itype) {
      case 'UserMessage': {
        thread.group += 1;
        thread.turnHasUserMessage = true;
        thread.pendingTask = null;
        const text = joinParts(item.content, (p) => (p.type === 'text' ? str(p.text) : p.type === 'local_image' || p.type === 'image' ? '[image]' : null), '\n');
        if (ctx.isRoot && !ctx.state.firstPromptSeen) {
          // Only the first root-thread prompt can name the session, even when it yields no usable text.
          ctx.state.firstPromptSeen = true;
          this.setTitle(ctx.state.session.id, 'prompt', promptTitle(text), ctx.changes);
        }
        this.addNode(ctx, { id: itemId !== null ? `prompt:${itemId}` : null, kind: 'prompt', title: 'Prompt', summary: summarize(text), detail: { text } });
        return;
      }
      case 'Reasoning': {
        const a = num(payload.started_at_ms);
        const b = num(payload.completed_at_ms);
        if (itemId === null || a === null || b === null) return;
        const ms = Math.max(0, b - a);
        const nodeId = thread.reasoningNodes.get(itemId);
        const node = nodeId === undefined ? undefined : ctx.state.nodes.get(nodeId);
        if (node) {
          if (node.durationMs === null) this.patch(ctx.state, node.id, { durationMs: ms }, ctx.changes);
        } else thread.reasoningMs.set(itemId, ms);
        return;
      }
      case 'SubAgentActivity': {
        // Only `started` links a spawn call to its thread (`interacted` / `completed` name other calls or none).
        const agentThreadId = str(item.agent_thread_id);
        if (item.kind !== 'started' || itemId === null || agentThreadId === null || ctx.state.activity.has(itemId)) return;
        ctx.state.activity.set(itemId, { agentThreadId, agentPath: str(item.agent_path) });
        this.refreshDispatches(ctx.state, ctx.changes);
        return;
      }
    }
    if (!FOLDED_ITEMS.has(itype)) return; // AgentMessage (the response item is used), ContextCompaction (the compacted record is)
    const entry: FoldEntry = {
      type: itype,
      name: itemName(itype, item),
      status: str(item.status),
      exitCode: num(item.exit_code),
      durationMs: itemDuration(item, payload),
    };
    const startedMs = num(payload.started_at_ms);
    const startedAt = isoOf(startedMs);
    const target = this.foldTarget(thread, startedAt === null ? null : startedMs);
    const node = target === undefined ? undefined : ctx.state.nodes.get(target);
    if (target !== undefined && node) {
      const list = [...(ctx.state.folded.get(target) ?? []), entry];
      ctx.state.folded.set(target, list);
      const patch: Partial<GraphNode> = {};
      if (node.kind === 'tool') {
        // The first command names the call; without one, the first item that has a name.
        const named = list.find((e) => e.type === 'CommandExecution' && e.name !== '') ?? list.find((e) => e.name !== '');
        if (named !== undefined && summarize(named.name) !== node.summary) patch.summary = summarize(named.name);
        // An item can arrive after the call's output: a failure still fails the settled call.
        if (node.status === 'succeeded' && entryFailed(entry)) patch.status = 'failed';
      }
      this.patch(ctx.state, target, patch, ctx.changes, { raw: { items: list } });
      return;
    }
    // No call it ran in: the item is a finished tool step of its own (own id prefix: item ids can equal call ids).
    this.addNode(ctx, {
      id: itemId !== null ? `item:${itemId}` : null,
      kind: 'tool',
      title: itype,
      summary: summarize(entry.name),
      toolName: itype,
      status: entryFailed(entry) ? 'failed' : 'succeeded',
      timestamp: startedAt ?? ctx.ts,
      endedAt: ctx.ts,
      durationMs: entry.durationMs,
      detail: { raw: { items: [entry] } },
    });
  }

  /**
   * The call a folded item ran in: the latest-starting call of the thread whose window [call record, output record]
   * holds the item's start (a call without an output yet, or closed by its turn's end, has an open-ended window, resp.
   * the turn end as its end). Without a usable start time: the most recently opened call still open. Undefined = none.
   */
  private foldTarget(thread: ThreadState, startedMs: number | null): string | undefined {
    if (startedMs === null) return thread.openCalls[thread.openCalls.length - 1];
    let best: ThreadState['callWindows'][number] | undefined;
    for (const w of thread.callWindows) {
      if (w.startMs > startedMs || (w.endMs !== null && startedMs > w.endMs)) continue;
      if (best === undefined || w.startMs >= best.startMs) best = w;
    }
    return best?.nodeId;
  }

  /**
   * A subagent thread's task arrives as a role-user message, not as a UserMessage item: before the turn's first model
   * output, the last such message of the turn becomes its prompt node (only when the turn has no UserMessage item).
   */
  private beginModelOutput(ctx: Ctx): void {
    const { thread } = ctx;
    if (thread.turnHasOutput) return;
    thread.turnHasOutput = true;
    const task = thread.pendingTask;
    thread.pendingTask = null;
    if (task === null || thread.agentId === null || thread.turnHasUserMessage) return;
    this.addNode(ctx, {
      id: task.id !== null ? `prompt:${task.id}` : `prompt:${thread.id}@${task.offset}`,
      kind: 'prompt',
      title: 'Prompt',
      summary: summarize(task.text),
      timestamp: task.ts,
      detail: { text: task.text },
    });
  }

  private applyResponseItem(ctx: Ctx): void {
    const { payload, thread } = ctx;
    const ptype = str(payload.type) ?? '';
    if (CALLS.has(ptype)) {
      this.beginModelOutput(ctx);
      this.applyCall(ctx, ptype);
      return;
    }
    thread.group += 1;
    if (OUTPUTS.has(ptype)) {
      this.applyOutput(ctx);
      return;
    }
    switch (ptype) {
      case 'message': {
        if (payload.role === 'user' && thread.agentId !== null && !thread.turnHasOutput && !thread.turnHasUserMessage) {
          // Possibly the subagent's task (see beginModelOutput); the last one before the first output wins.
          const text = joinParts(payload.content, (p) => (p.type === 'input_text' || p.type === 'text' ? str(p.text) : null), '\n');
          thread.pendingTask = { id: str(payload.id), text, ts: ctx.ts, offset: ctx.event.offset };
        }
        if (payload.role !== 'assistant') return; // user / developer messages are context injection
        this.beginModelOutput(ctx);
        const text = joinParts(payload.content, (p) => (p.type === 'output_text' ? str(p.text) : null), '');
        const id = str(payload.id);
        const placed = this.addNode(ctx, { id: id !== null ? `text:${id}` : null, kind: 'text', title: 'Text', summary: summarize(text), detail: { text, raw: { phase: str(payload.phase) } } });
        if (placed !== null) thread.responseNodes.push(placed);
        return;
      }
      case 'reasoning': {
        this.beginModelOutput(ctx);
        const text = joinParts(payload.summary, (p) => str(p.text), '\n');
        const rid = str(payload.id);
        const placed = this.addNode(ctx, {
          id: rid !== null ? `thinking:${rid}` : null,
          kind: 'thinking',
          title: 'Thinking',
          summary: summarize(text),
          durationMs: rid !== null ? (thread.reasoningMs.get(rid) ?? null) : null,
          detail: { text },
        });
        if (placed !== null) thread.responseNodes.push(placed);
        if (rid !== null && placed !== null) {
          thread.reasoningMs.delete(rid);
          thread.reasoningNodes.set(rid, placed);
        }
        return;
      }
      case 'compaction':
        this.addCompact(ctx, null);
        return;
    }
  }

  private applyCall(ctx: Ctx, ptype: string): void {
    const { payload, thread, state } = ctx;
    const callId = str(payload.call_id);
    if (callId === null) return;
    const name = str(payload.name) ?? 'unknown';
    const namespace = str(payload.namespace);
    const toolName = namespace !== null && namespace !== '' ? `${namespace}.${name}` : name;
    const input = ptype === 'custom_tool_call' ? (payload.input ?? null) : parseArguments(payload.arguments);
    const isSpawn = ptype === 'function_call' && name === 'spawn_agent' && (namespace === null || namespace === 'collaboration');
    const taskName = isSpawn ? str(obj(input).task_name) : null;
    const id = this.addNode(
      ctx,
      {
        id: `tool:${callId}`,
        kind: isSpawn ? 'subagent' : 'tool',
        title: toolName,
        summary: isSpawn ? summarize(taskName ?? '') : summarize(input),
        toolName,
        toolUseId: callId,
        status: 'running',
        detail: { input },
      },
      true,
    );
    if (id === null) return;
    thread.responseNodes.push(id);
    thread.callNodes.set(callId, id);
    thread.openCalls.push(id);
    thread.callOrder.push(id);
    const turnId = state.nodes.get(id)?.turnId ?? null;
    if (turnId !== null) {
      const tc = thread.turnCalls.get(turnId) ?? { open: new Set<string>(), settled: 0 };
      tc.open.add(id);
      thread.turnCalls.set(turnId, tc);
    }
    const startMs = msOf(ctx.ts);
    if (startMs !== null) thread.callWindows.push({ nodeId: id, startMs, endMs: null });
    state.toolInputs.set(id, input);
    if (isSpawn) {
      state.spawns.set(id, { threadId: thread.id, callId, taskName, toolName, timestamp: ctx.ts });
      this.refreshDispatches(state, ctx.changes);
    }
  }

  private applyOutput(ctx: Ctx): void {
    const { payload, thread, state } = ctx;
    const callId = str(payload.call_id);
    const id = callId === null ? undefined : thread.callNodes.get(callId);
    const node = id === undefined ? undefined : state.nodes.get(id);
    if (id === undefined || !node) return; // its call is not in this thread (e.g. never written)
    thread.openCalls = thread.openCalls.filter((x) => x !== id);
    const endMs = msOf(ctx.ts);
    for (const w of thread.callWindows) if (w.nodeId === id && endMs !== null) w.endMs = endMs;
    state.toolInputs.delete(id);
    const tc = node.turnId === null ? undefined : thread.turnCalls.get(node.turnId);
    if (tc?.open.delete(id)) tc.settled += 1;
    const detail = { output: payload.output ?? null };
    // A dispatch node follows its agent's thread, not the immediate answer to the spawn call.
    if (node.kind === 'subagent' || isTerminal(this.baseStatus(state, node))) {
      this.patch(state, id, {}, ctx.changes, detail);
      return;
    }
    const failed = (state.folded.get(id) ?? []).some(entryFailed);
    const patch: Partial<GraphNode> = { status: failed ? 'failed' : 'succeeded', endedAt: ctx.ts };
    const durationMs = elapsedMs(node.timestamp, ctx.ts);
    if (durationMs !== null) patch.durationMs = durationMs;
    this.patch(state, id, patch, ctx.changes, detail);
  }

  /**
   * A `token_usage_record`: the usage of one model response (`usage`, never the turn's running `turn_token_usage`).
   * Response items carry item ids only, no response id, so the response is told by order within the thread's file
   * (Codex writes the record after the response's items): its nodes are the model-output nodes of the record's turn
   * placed in this thread since the thread's previous record. The usage goes on the first of them; without one, on
   * the nearest earlier node of the same turn in this thread (usages on one node add up); with no node of that turn in
   * the thread it is dropped and counted. A function of this thread's records only, so the order other threads' files
   * arrive in does not matter. A response id already applied in this thread changes nothing (a repeated record);
   * a record without one is identified by its place in the file. A record whose input or output count is not a
   * non-negative number is ignored, but still ends its response.
   */
  private applyUsage(ctx: Ctx): void {
    const { state, thread, payload } = ctx;
    const key = str(payload.response_id) ?? `@${ctx.event.offset}`;
    if (thread.usageSeen.has(key)) return;
    thread.usageSeen.add(key);
    const segment = thread.responseNodes;
    thread.responseNodes = [];
    const usage = obj(payload.usage);
    const input = num(usage.input_tokens);
    const output = num(usage.output_tokens);
    if (input === null || output === null || input < 0 || output < 0) return;
    const turnId = str(payload.turn_id) ?? thread.currentTurn;
    const sameTurn = (id: string): boolean => state.nodes.get(id)?.turnId === turnId;
    let target = segment.find(sameTurn);
    for (let i = thread.placed.length - 1; target === undefined && i >= 0; i--) {
      if (sameTurn(thread.placed[i]!)) target = thread.placed[i];
    }
    const node = target === undefined ? undefined : state.nodes.get(target);
    if (target === undefined || !node) {
      state.droppedUsage += 1;
      return;
    }
    const prev = node.usage;
    const next = { inputTokens: (prev?.inputTokens ?? 0) + input, outputTokens: (prev?.outputTokens ?? 0) + output };
    // The total, not the increment: a replay writing the same patches again lands on the same value.
    this.writeNode(state, target, { usage: next }, ctx.changes);
  }

  // ---- hooks (marks only: they never create, confirm or settle a node) ----

  /** Pushes the hook's changes; returns the unknown-record label, if any. */
  private applyHook(event: Extract<RawEvent, { source: 'hook' }>, projectId: string, changes: Change[]): string | undefined {
    const parsed = parseCodexHook(event.eventName, event.payload);
    if (!parsed.ok) return parsed.unknownRecordType;
    const hook = parsed.hook;
    const at = event.receivedAt;
    this.recordHook(hook, at);
    let state = this.sessions.get(hook.sessionId);
    if (!state) {
      // A live session whose file is not read yet shows up at once; an end / stop for a session never seen does not
      // conjure an empty one (its mark is kept and counts once the session appears).
      if (!hook.createsSession) return undefined;
      state = this.stateFor(hook.sessionId, at, projectId, changes);
    }
    const next = this.withTime(state, at);
    // Until the first transcript record, the session's project and cwd come from the hooks; never after that.
    if (!state.transcriptSeen) {
      const isRoot = hook.agentId === null;
      if (projectId !== 'unknown' && (isRoot || next.projectId === 'unknown')) next.projectId = projectId;
      if (isRoot && next.cwd === null) next.cwd = hook.cwd;
    }
    this.commitSession(state, next, changes);
    this.refresh(state, changes);
    return undefined;
  }

  /**
   * The marks a hook leaves, in receive order (see HookMarks / statusView). Session-level: SessionEnd ends,
   * SessionStart / UserPromptSubmit resume (a subagent's never). Per turn (turn_id, '' when the payload has none):
   * UserPromptSubmit and the tool / permission hooks start it, Stop / Interrupt stop it (without a turn_id: every turn
   * marked so far), PermissionRequest makes a request pending, and any other hook of the turn clears that.
   */
  private recordHook(hook: CodexHook, at: string): void {
    let marks = this.hookMarks.get(hook.sessionId);
    if (!marks) {
      marks = { turns: new Map(), ended: false, firstAt: null, lastAt: null };
      this.hookMarks.set(hook.sessionId, marks);
      this.pruneUnseenHookMarks();
    }
    if (marks.firstAt === null || at < marks.firstAt) marks.firstAt = at;
    if (marks.lastAt === null || at > marks.lastAt) marks.lastAt = at;
    const e = hook.eventName;
    if (hook.agentId === null) {
      if (e === 'SessionEnd') marks.ended = true;
      if (e === 'SessionStart' || e === 'UserPromptSubmit') marks.ended = false;
    }
    const turnScoped = e === 'UserPromptSubmit' || e === 'PreToolUse' || e === 'PostToolUse' || e === 'PermissionRequest' || e === 'Stop' || e === 'Interrupt';
    if (!turnScoped) {
      // Another hook naming a turn still ends that turn's pending permission request.
      const mark = hook.turnId === null ? undefined : marks.turns.get(hook.turnId);
      if (mark) mark.permission = false;
      return;
    }
    const key = hook.turnId ?? '';
    let mark = marks.turns.get(key);
    if (!mark) {
      mark = { started: false, stopped: false, permission: false, child: false };
      marks.turns.set(key, mark);
    }
    if (hook.agentId !== null) mark.child = true;
    if (e === 'Stop' || e === 'Interrupt') {
      const stopped = hook.turnId === null ? [...marks.turns.values()] : [mark];
      for (const m of stopped) {
        m.stopped = true;
        m.permission = false;
      }
      return;
    }
    mark.started = true;
    mark.permission = e === 'PermissionRequest';
    if (e === 'PermissionRequest' || e === 'UserPromptSubmit') mark.stopped = false;
  }

  /**
   * Hook marks are kept for sessions not seen yet (a hook can precede its session's file). Hooks naming sessions that
   * never appear must not pile up: beyond the limit the oldest marks of unseen sessions are dropped.
   */
  private pruneUnseenHookMarks(): void {
    const unseen: string[] = [];
    for (const id of this.hookMarks.keys()) if (!this.sessions.has(id)) unseen.push(id);
    for (const id of unseen.slice(0, Math.max(0, unseen.length - MAX_UNSEEN_HOOK_SESSIONS))) this.hookMarks.delete(id);
  }

  // ---- nodes ----

  private turnOf(ctx: Ctx): string | null {
    const p = ctx.payload;
    return str(p.turn_id) ?? str(obj(p.internal_chat_message_metadata_passthrough).turn_id) ?? ctx.thread.currentTurn;
  }

  private addCompact(ctx: Ctx, message: string | null): void {
    if (ctx.thread.lastWasCompact) return; // one compaction, written as more than one record
    this.addSystem(ctx, { title: 'Compact', subtype: 'compact', text: message, summary: '' });
    ctx.thread.lastWasCompact = true;
  }

  private addSystem(ctx: Ctx, spec: { title: string; subtype: string; text: string | null; summary?: string }): void {
    this.addNode(ctx, {
      id: `system:${ctx.thread.id}@${ctx.event.offset}`,
      kind: 'system',
      title: spec.title,
      summary: spec.summary ?? summarize(spec.text ?? ''),
      systemSubtype: spec.subtype,
      detail: { text: spec.text },
    });
  }

  /**
   * Places a node in its thread: it hangs off the thread's last node, except that calls of one model response are
   * siblings (fork from the first one's parent) and the next node after such a run joins all of them. Returns the node
   * id, or null when the id is already taken in the session (reported as `duplicate-node-id`).
   */
  private addNode(
    ctx: Ctx,
    spec: {
      id: string | null;
      kind: GraphNode['kind'];
      title: string;
      summary: string;
      detail: Partial<NodeDetail>;
      toolName?: string;
      toolUseId?: string;
      status?: GraphNode['status'];
      timestamp?: string;
      endedAt?: string | null;
      durationMs?: number | null;
      systemSubtype?: string;
    },
    isCall = false,
  ): string | null {
    const { state, thread, changes } = ctx;
    const id = spec.id ?? `${spec.kind}:${thread.id}@${ctx.event.offset}`;
    if (state.nodes.has(id)) {
      // The id is taken (by this or another thread): a repeated record. Nothing is placed; diagnostics show it.
      ctx.unknown = 'duplicate-node-id';
      return null;
    }
    let parentId = thread.lastNode;
    let edgeKind: GraphEdge['kind'] = 'sequence';
    let forkFirst: string | null = null;
    let joinFrom: string[] = [];
    const batch = thread.batch;
    if (batch && isCall && batch.group === thread.group) {
      parentId = batch.parentId;
      edgeKind = 'fork';
      if (batch.members.length === 1) forkFirst = batch.members[0] ?? null;
      batch.members.push(id);
    } else if (batch) {
      thread.batch = null;
      if (batch.members.length >= 2) {
        parentId = batch.members[batch.members.length - 1] ?? parentId;
        joinFrom = batch.members.slice(0, -1);
      }
    }
    if (isCall && thread.batch === null) thread.batch = { group: thread.group, parentId, members: [id] };

    const placed: GraphNode = {
      id,
      sessionId: state.session.id,
      turnId: this.turnOf(ctx),
      agentId: thread.agentId,
      childAgentId: null,
      parentId,
      kind: spec.kind,
      status: spec.status ?? null,
      timestamp: spec.timestamp ?? ctx.ts,
      confirmed: true,
      title: spec.title,
      summary: spec.summary,
      toolName: spec.toolName ?? null,
      toolUseId: spec.toolUseId ?? null,
      messageId: null,
      durationMs: spec.durationMs ?? null,
      endedAt: spec.endedAt ?? null,
      usage: null,
      systemSubtype: spec.systemSubtype ?? null,
    };
    const sid = state.session.id;
    state.nodes.set(id, placed);
    changes.push({ type: 'node_added', node: placed, detail: spec.detail });
    if (parentId !== null) changes.push({ type: 'edge_added', edge: { id: `${parentId}->${id}`, sessionId: sid, from: parentId, to: id, kind: edgeKind } });
    if (forkFirst !== null && parentId !== null) {
      changes.push({ type: 'edge_added', edge: { id: `${parentId}->${forkFirst}:fork`, sessionId: sid, from: parentId, to: forkFirst, kind: 'fork' } });
    }
    for (const from of joinFrom) changes.push({ type: 'edge_added', edge: { id: `${from}->${id}`, sessionId: sid, from, to: id, kind: 'sequence' } });
    thread.lastNode = id;
    thread.placed.push(id);
    thread.lastWasCompact = false;
    if (thread.firstNode === null) {
      thread.firstNode = id;
      if (thread.agentId !== null) this.trySpawn(state, thread.id, changes);
    }
    return id;
  }

  /**
   * A change the transcript makes to a node. Under an awaiting_permission overlay a non-terminal status is only
   * remembered (the node keeps showing awaiting_permission); a terminal one ends the overlay and is shown.
   */
  private patch(state: SessionState, id: string, patch: Partial<GraphNode>, changes: Change[], detail?: Partial<NodeDetail>): void {
    let out = patch;
    if (state.awaiting.has(id) && 'status' in patch) {
      const next = patch.status ?? null;
      if (isTerminal(next)) state.awaiting.delete(id);
      else {
        state.awaiting.set(id, next);
        out = { ...patch };
        delete out.status;
      }
    }
    this.writeNode(state, id, out, changes, detail);
  }

  private writeNode(state: SessionState, id: string, patch: Partial<GraphNode>, changes: Change[], detail?: Partial<NodeDetail>): void {
    const node = state.nodes.get(id);
    if (!node) return;
    if (Object.keys(patch).length === 0 && detail === undefined) return;
    state.nodes.set(id, { ...node, ...patch });
    changes.push({ type: 'node_updated', sessionId: state.session.id, id, patch, ...(detail !== undefined ? { detail } : {}) });
  }

  // ---- subagents ----

  /**
   * Which thread each spawn_agent call started: the SubAgentActivity that names the call, else the child thread's own
   * session_meta (parent thread + last segment of its agent path = the call's task_name; several spawns of one name in
   * one thread are paired with those threads in time order). A function of what has been read so far, so the order the
   * threads' files arrive in does not matter.
   */
  private resolveChildren(state: SessionState): Map<string, string> {
    const out = new Map<string, string>();
    const claimed = new Set<string>();
    for (const [dispatch, spawn] of state.spawns) {
      const act = state.activity.get(spawn.callId);
      if (act !== undefined) {
        out.set(dispatch, act.agentThreadId);
        claimed.add(act.agentThreadId);
      }
    }
    const byName = new Map<string, { dispatches: [string, Spawn][]; threads: ThreadState[] }>();
    const keyOf = (parent: string, name: string): string => `${parent}\u0000${name}`;
    for (const [dispatch, spawn] of state.spawns) {
      if (out.has(dispatch) || spawn.taskName === null) continue;
      const k = keyOf(spawn.threadId, spawn.taskName);
      const g = byName.get(k) ?? { dispatches: [], threads: [] };
      g.dispatches.push([dispatch, spawn]);
      byName.set(k, g);
    }
    for (const t of state.threads.values()) {
      const name = lastSegment(t.agentPath);
      if (t.agentId === null || t.parentThreadId === null || name === null || claimed.has(t.id)) continue;
      byName.get(keyOf(t.parentThreadId, name))?.threads.push(t);
    }
    const order = <T>(a: [string, T], b: [string, T]): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    for (const g of byName.values()) {
      const ds = g.dispatches.map(([d, s]) => [`${s.timestamp}\u0000${d}`, d] as [string, string]).sort(order);
      const ts = g.threads.map((t) => [`${t.startedAt}\u0000${t.id}`, t.id] as [string, string]).sort(order);
      ds.forEach(([, d], i) => {
        const child = ts[i]?.[1];
        if (child !== undefined) out.set(d, child);
      });
    }
    return out;
  }

  /** Re-resolves every dispatch's child, title and status, and emits any spawn edge that can now be drawn. */
  private refreshDispatches(state: SessionState, changes: Change[]): void {
    const children = this.resolveChildren(state);
    state.dispatchOf.clear();
    for (const [dispatch, spawn] of state.spawns) {
      const node = state.nodes.get(dispatch);
      if (!node) continue;
      const child = children.get(dispatch) ?? null;
      if (child !== null && !state.dispatchOf.has(child)) state.dispatchOf.set(child, dispatch);
      const t = child === null ? undefined : state.threads.get(child);
      const act = state.activity.get(spawn.callId);
      const title = t?.nickname ?? lastSegment(act?.agentPath ?? t?.agentPath ?? null) ?? spawn.toolName;
      const patch: Partial<GraphNode> = {};
      if (node.childAgentId !== child) patch.childAgentId = child;
      if (node.title !== title) patch.title = title;
      this.patch(state, dispatch, patch, changes);
      this.applyDispatchStatus(state, dispatch, changes);
    }
    for (const child of state.dispatchOf.keys()) this.trySpawn(state, child, changes);
  }

  /**
   * A dispatch node's status follows its agent's thread: a turn open (or nothing read yet) → running; otherwise the
   * last turn's end decides (failed when it ended with an error or was aborted) and gives the end time. While no child
   * thread is known, it follows the turn the spawn call was made in: running while that turn is open, failed (ended at
   * the turn's end) once it has ended — a child thread that turns up later takes over.
   */
  private applyDispatchStatus(state: SessionState, dispatch: string, changes: Change[]): void {
    const node = state.nodes.get(dispatch);
    if (!node || node.kind !== 'subagent') return;
    const running = { status: 'running', endedAt: null, durationMs: null } as const;
    let next: Pick<GraphNode, 'status' | 'endedAt' | 'durationMs'>;
    if (node.childAgentId === null) {
      const spawnThread = state.threads.get(state.spawns.get(dispatch)?.threadId ?? '');
      const turns = spawnThread?.turns ?? [];
      let turn: Turn | undefined;
      for (let i = turns.length - 1; i >= 0 && node.turnId !== null; i--) {
        if (turns[i]!.id === node.turnId) {
          turn = turns[i];
          break;
        }
      }
      next = turn?.endedAt != null ? { status: 'failed', endedAt: turn.endedAt, durationMs: elapsedMs(node.timestamp, turn.endedAt) } : running;
    } else {
      const thread = state.threads.get(node.childAgentId);
      const last = thread?.turns[thread.turns.length - 1];
      if (last === undefined || last.endedAt === null) next = running;
      else next = { status: last.failed ? 'failed' : 'succeeded', endedAt: last.endedAt, durationMs: elapsedMs(node.timestamp, last.endedAt) };
    }
    const patch: Partial<GraphNode> = {};
    if (this.baseStatus(state, node) !== next.status) patch.status = next.status;
    if (node.endedAt !== next.endedAt) patch.endedAt = next.endedAt;
    if (node.durationMs !== next.durationMs) patch.durationMs = next.durationMs;
    if (Object.keys(patch).length === 0) return;
    // Any change of the end resends the three together, so a reader sees one consistent state.
    this.patch(state, dispatch, { status: next.status, endedAt: next.endedAt, durationMs: next.durationMs }, changes);
  }

  /** The spawn edge from the dispatch node to the child thread's first node, once both exist; at most once per thread. */
  private trySpawn(state: SessionState, child: string, changes: Change[]): void {
    if (state.spawned.has(child)) return;
    const dispatch = state.dispatchOf.get(child);
    const first = state.threads.get(child)?.firstNode ?? null;
    if (dispatch === undefined || first === null || !state.nodes.has(dispatch)) return;
    state.spawned.add(child);
    this.patch(state, first, { parentId: dispatch }, changes);
    changes.push({ type: 'edge_added', edge: { id: `${dispatch}->${first}`, sessionId: state.session.id, from: dispatch, to: first, kind: 'spawn' } });
  }
}

interface Ctx {
  state: SessionState;
  thread: ThreadState;
  event: Transcript;
  payload: Obj;
  ts: string;
  changes: Change[];
  isRoot: boolean;
  /** Set when the record is reported in diagnostics although it was applied (a duplicate node id). */
  unknown: string | undefined;
}
