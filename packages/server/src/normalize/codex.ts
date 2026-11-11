import {
  TERMINAL_STATUSES,
  type Change,
  type GraphEdge,
  type GraphNode,
  type NodeDetail,
  type Session,
} from '@claude-canvas/shared';
import type { RawEvent } from '../store/store.js';
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
function promptTitle(text: string): string | null {
  const folded = text.trim().replace(/\s+/g, ' ');
  if (folded.replace(/\[image\]/g, '').trim() === '') return null;
  return Array.from(folded).slice(0, PROMPT_TITLE_CHARS).join('');
}

/** Top-level record types that are known and produce nothing. */
const IGNORED_RECORDS = new Set(['turn_context', 'world_state', 'token_usage_record', 'inter_agent_communication_metadata']);
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
  /** call_id -> tool node id (a node id is suffixed when another thread took `tool:<call_id>` first). */
  callNodes: Map<string, string>;
  /** Increases at every record that ends a model response's run of calls (see parallel calls). */
  group: number;
  /** The current run of calls of one response (parallel siblings). */
  batch: { group: number; parentId: string | null; members: string[] } | null;
  /** Reasoning item id -> duration from its `item_completed/Reasoning`, until the reasoning node exists. */
  reasoningMs: Map<string, number>;
  /** Reasoning item id -> its thinking node id. */
  reasoningNodes: Map<string, string>;
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
  /** Time of the root-thread record that last set the status (an older one must not overwrite it). */
  statusAt: string;
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
  /** Sessions without state whose pre-session memory (titles) was restored by restorePreSession. */
  private readonly preSessionRestored = new Set<string>();

  apply(event: RawEvent, projectId: string): NormalizeResult {
    try {
      if (event.source === 'transcript') return this.applyTranscript(event, projectId);
      if (event.source === 'meta') return this.applyMeta(event);
      return { changes: [] }; // hooks: not yet (a later task)
    } catch {
      return { changes: [], unknownRecordType: 'normalizer-error' };
    }
  }

  dropSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.titleSources.delete(sessionId);
    this.preSessionRestored.delete(sessionId);
  }

  needsPreSessionReplay(sessionId: string): boolean {
    return !this.sessions.has(sessionId) && !this.preSessionRestored.has(sessionId);
  }

  /** Before a session exists the only thing kept is its titles (index meta events): restored from them, in order. */
  restorePreSession(sessionId: string, events: Iterable<RawEvent>): void {
    this.dropSession(sessionId);
    try {
      for (const ev of events) if (ev.source === 'meta' && ev.sessionId === sessionId) this.applyMeta(ev);
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

  // ---- titles ----

  private applyMeta(event: Extract<RawEvent, { source: 'meta' }>): NormalizeResult {
    if (event.agentId !== null) return { changes: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.payload);
    } catch {
      return { changes: [] };
    }
    const changes: Change[] = [];
    if (isObject(parsed)) this.setTitle(event.sessionId, 'index', str(parsed.thread_name), changes);
    return { changes };
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

  private stateFor(sessionId: string, ts: string, projectId: string, changes: Change[]): SessionState {
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
        statusAt: EPOCH,
        nodes: new Map(),
        toolInputs: new Map(),
        folded: new Map(),
        threads: new Map(),
        spawns: new Map(),
        activity: new Map(),
        dispatchOf: new Map(),
        spawned: new Set(),
        firstPromptSeen: false,
      };
      this.sessions.set(sessionId, state);
      this.preSessionRestored.delete(sessionId);
      changes.push({ type: 'session_upserted', session });
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
        callNodes: new Map(),
        group: 0,
        batch: null,
        reasoningMs: new Map(),
        reasoningNodes: new Map(),
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
  private touchSession(state: SessionState, ts: string, projectId: string, isRoot: boolean, changes: Change[]): void {
    const s = state.session;
    let nextProject = s.projectId;
    if (projectId !== 'unknown' && (isRoot || s.projectId === 'unknown')) nextProject = projectId;
    this.commitSession(
      state,
      {
        ...s,
        lastActivityAt: ts > s.lastActivityAt ? ts : s.lastActivityAt,
        startedAt: ts < s.startedAt ? ts : s.startedAt,
        projectId: nextProject,
      },
      changes,
    );
  }

  /** Session status from the root thread's turns; a record older than the last status observation does not overwrite it. */
  private setStatus(state: SessionState, status: Session['status'], ts: string, changes: Change[]): void {
    if (ts < state.statusAt) return;
    state.statusAt = ts;
    this.commitSession(state, { ...state.session, status }, changes);
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

  private applyTranscript(event: Transcript, projectId: string): NormalizeResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.line);
    } catch {
      return { changes: [], unknownRecordType: 'invalid-json' };
    }
    if (!isObject(parsed)) return { changes: [], unknownRecordType: 'invalid-json' };
    const type = parsed.type;
    if (typeof type !== 'string') return { changes: [], unknownRecordType: 'missing-type' };
    const payload = obj(parsed.payload);
    const kind = classify(type, payload);
    if (kind.kind === 'unknown') return { changes: [], unknownRecordType: kind.type };

    const changes: Change[] = [];
    const existing = this.sessions.get(event.sessionId);
    const ts = str(parsed.timestamp) ?? existing?.session.lastActivityAt ?? EPOCH;
    const state = this.stateFor(event.sessionId, ts, projectId, changes);
    const thread = this.threadFor(state, event, ts);
    const isRoot = event.agentId === null;

    // The parent's history copied into a forked thread's file: already shown in the parent's thread.
    const ordinal = num(parsed.ordinal);
    if (thread.historyStart !== null && ordinal !== null && ordinal > 0 && ordinal < thread.historyStart) return { changes };
    // A second session_meta in the file is the parent's (copied with its history).
    if (type === 'session_meta' && str(payload.id) !== null && str(payload.id) !== thread.id) return { changes };

    this.touchSession(state, ts, projectId, isRoot, changes);
    if (kind.kind === 'ignored') {
      if (type === 'token_usage_record' || type === 'response_item') thread.group += 1; // ends a response's run of calls
      return { changes };
    }
    const ctx: Ctx = { state, thread, event, payload, ts, changes, isRoot };
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
    }
    return { changes };
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
        thread.turns.push({ id, endedAt: null, failed: false });
        thread.currentTurn = id;
        if (ctx.isRoot) this.setStatus(ctx.state, 'running', ctx.ts, ctx.changes);
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
    }
    turn.endedAt = ctx.ts;
    turn.failed = failed;
    // Only the end of the thread's latest turn makes the session idle (a stale end does not).
    if (ctx.isRoot && thread.turns[thread.turns.length - 1] === turn) this.setStatus(ctx.state, 'idle', ctx.ts, ctx.changes);
    this.threadTurnsChanged(ctx);
  }

  private threadTurnsChanged(ctx: Ctx): void {
    const dispatch = ctx.state.dispatchOf.get(ctx.thread.id);
    if (dispatch !== undefined) this.applyDispatchStatus(ctx.state, dispatch, ctx.changes);
  }

  private applyItem(ctx: Ctx, item: Obj): void {
    const { thread, payload } = ctx;
    const itype = str(item.type) ?? '';
    const itemId = str(item.id);
    switch (itype) {
      case 'UserMessage': {
        thread.group += 1;
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
        const agentThreadId = str(item.agent_thread_id);
        if (itemId === null || agentThreadId === null || ctx.state.activity.has(itemId)) return;
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
    const target = thread.openCalls[thread.openCalls.length - 1];
    if (target !== undefined && ctx.state.nodes.has(target)) {
      const list = [...(ctx.state.folded.get(target) ?? []), entry];
      ctx.state.folded.set(target, list);
      const node = ctx.state.nodes.get(target)!;
      const patch: Partial<GraphNode> = {};
      if (list.length === 1 && node.kind === 'tool' && entry.name !== '') patch.summary = summarize(entry.name);
      this.patch(ctx.state, target, patch, ctx.changes, { raw: { items: list } });
      return;
    }
    // Nothing open to fold into: the item is a finished tool step of its own.
    const startedMs = num(payload.started_at_ms);
    this.addNode(ctx, {
      id: itemId !== null ? `tool:${itemId}` : null,
      kind: 'tool',
      title: itype,
      summary: summarize(entry.name),
      toolName: itype,
      status: entryFailed(entry) ? 'failed' : 'succeeded',
      timestamp: startedMs !== null ? new Date(startedMs).toISOString() : ctx.ts,
      endedAt: ctx.ts,
      durationMs: entry.durationMs,
      detail: { raw: { items: [entry] } },
    });
  }

  private applyResponseItem(ctx: Ctx): void {
    const { payload, thread } = ctx;
    const ptype = str(payload.type) ?? '';
    if (CALLS.has(ptype)) {
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
        if (payload.role !== 'assistant') return; // user / developer messages are context injection
        const text = joinParts(payload.content, (p) => (p.type === 'output_text' ? str(p.text) : null), '');
        const id = str(payload.id);
        this.addNode(ctx, { id: id !== null ? `text:${id}` : null, kind: 'text', title: 'Text', summary: summarize(text), detail: { text, raw: { phase: str(payload.phase) } } });
        return;
      }
      case 'reasoning': {
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
    thread.callNodes.set(callId, id);
    thread.openCalls.push(id);
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
    state.toolInputs.delete(id);
    const detail = { output: payload.output ?? null };
    // A dispatch node follows its agent's thread, not the immediate answer to the spawn call.
    if (node.kind === 'subagent' || (node.status !== null && TERMINAL_STATUSES.includes(node.status))) {
      this.patch(state, id, {}, ctx.changes, detail);
      return;
    }
    const failed = (state.folded.get(id) ?? []).some(entryFailed);
    const patch: Partial<GraphNode> = { status: failed ? 'failed' : 'succeeded', endedAt: ctx.ts };
    const durationMs = elapsedMs(node.timestamp, ctx.ts);
    if (durationMs !== null) patch.durationMs = durationMs;
    this.patch(state, id, patch, ctx.changes, detail);
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
   * id, or null when the record repeats a node this thread already has.
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
    let id = spec.id ?? `${spec.kind}:${thread.id}@${ctx.event.offset}`;
    const taken = state.nodes.get(id);
    if (taken) {
      if (taken.agentId === thread.agentId) return null; // the same record again
      id = `${id}@${thread.id}`; // another thread uses the same id
      if (state.nodes.has(id)) return null;
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

    const node: GraphNode = {
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
    state.nodes.set(id, node);
    changes.push({ type: 'node_added', node, detail: spec.detail });
    const sid = state.session.id;
    if (parentId !== null) changes.push({ type: 'edge_added', edge: { id: `${parentId}->${id}`, sessionId: sid, from: parentId, to: id, kind: edgeKind } });
    if (forkFirst !== null && parentId !== null) {
      changes.push({ type: 'edge_added', edge: { id: `${parentId}->${forkFirst}:fork`, sessionId: sid, from: parentId, to: forkFirst, kind: 'fork' } });
    }
    for (const from of joinFrom) changes.push({ type: 'edge_added', edge: { id: `${from}->${id}`, sessionId: sid, from, to: id, kind: 'sequence' } });
    thread.lastNode = id;
    thread.lastWasCompact = false;
    if (thread.firstNode === null) {
      thread.firstNode = id;
      if (thread.agentId !== null) this.trySpawn(state, thread.id, changes);
    }
    return id;
  }

  private patch(state: SessionState, id: string, patch: Partial<GraphNode>, changes: Change[], detail?: Partial<NodeDetail>): void {
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
   * last turn's end decides (failed when it ended with an error or was aborted) and gives the end time.
   */
  private applyDispatchStatus(state: SessionState, dispatch: string, changes: Change[]): void {
    const node = state.nodes.get(dispatch);
    if (!node || node.kind !== 'subagent') return;
    const thread = node.childAgentId === null ? undefined : state.threads.get(node.childAgentId);
    const last = thread?.turns[thread.turns.length - 1];
    let next: Pick<GraphNode, 'status' | 'endedAt' | 'durationMs'>;
    if (last === undefined || last.endedAt === null) next = { status: 'running', endedAt: null, durationMs: null };
    else next = { status: last.failed ? 'failed' : 'succeeded', endedAt: last.endedAt, durationMs: elapsedMs(node.timestamp, last.endedAt) };
    const patch: Partial<GraphNode> = {};
    if (node.status !== next.status) patch.status = next.status;
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
}
