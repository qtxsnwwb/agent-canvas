import type { Change, GraphNode, NodeDetail, Session, Usage } from '@agent-canvas/shared';
import { normaliseCwd } from '../sources/cursor/project.js';
import type { RawEvent } from '../store/store.js';
import { promptTitle } from './codex.js';
import { deepseekTouches, filesFields, nodeFiles, type RawTouch } from './files.js';
import { nodePatch } from './gemini.js';
import { inputKeyFields, inputKeyOf } from './input-key.js';
import { summarize } from './summary.js';
import type { AgentNormalizer, BatchItem, BatchResult, NormalizeResult } from './types.js';
import { unknownTypeName } from './unknown-type.js';

/*
 * The DeepSeek Harness normalizer (spec 3.3-3.5, docs/formats/deepseek-harness.md sections 4-5). The source delivers
 * one decoded JSONL row per event: the file's header at offset 0, then its event rows at 1, 2, … (the line ordinal). A
 * session file is the main thread of its session; a subagent file is an agent thread of its root session (agentId =
 * the subagent's own session id). Each row is applied once, in order, to its thread and emits the changes it causes;
 * work per row is O(1) apart from the row's own content. Nothing of a row's content is kept after it was applied: a
 * thread keeps ids, counters and small maps only.
 *
 * Node ids: `deepseek:<session id>[/<agent id>]:<part>`. `@<offset>` for the node a row makes (prompt, checkpoint,
 * turn end), `@<offset>.<block index>` for a node of an assistant message (a run of text or reasoning blocks: the index
 * of its first block), `call:<turn>.<step>.<callId>` for a tool call (a callId is unique within a step only; `-` for a
 * turn or step the rows do not give). Offsets are the same for every read of one file generation.
 *
 * A row at or before the last offset read of its thread means the file is being read again from its start (the source
 * found it rewritten): what the thread's old content made is removed and the thread is rebuilt from the new rows.
 *
 * Subagent link (spec 3.5): a `tool/result` whose `meta` is `{kind: 'activation', name}` names a child by the last `/`
 * segment of `name`; the `subagent/catalog` row with that `name` in the same file gives its session id. Either may come
 * first. The child's thread hangs off the first live call naming it; an activation no catalog row matches leaves the
 * thread unlinked. `mode: 'external'` rows name no thread. In a seeded file (a fork, or a subagent started as a fork)
 * catalog rows and activations before the last inherited `session/end-seed` are the source session's, not this one's:
 * ignored.
 */

const EPOCH = '1970-01-01T00:00:00.000Z';
const MAIN = '';
const ORIGIN = 'deepseek';
/** Types this normalizer reads. */
const HANDLED = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'session/title',
  'working-directory/change',
  'subagent/catalog',
  'session/end-seed',
]);
/**
 * Types of the format reference that show nothing (spec 3.3: compaction brackets, the inbox splice, system and
 * developer messages, request logs and the other log-only events): skipped, never reported as unknown.
 */
const IGNORED = new Set([
  'compaction/start',
  'compaction/summary',
  'compaction/end',
  'compaction/prune',
  'agent/inbox/spliced',
  'system/message',
  'developer/message',
  'request/header',
  'request/context',
  'model/selection',
  'assistant/attempt',
  'tool/ptc-dispatch-start',
  'tool/ptc-dispatch',
  'command/run',
  'command/done',
  'subagent/descriptor',
  'subagent/model-selection-policy',
  'llm/retry',
  'llm/retry-started',
  'approval/asked',
  'approval/decided',
  'approval/policy',
  'plan/mode',
  'permission/preset',
  'sandbox/mode',
  'todo/write',
  'goal/change',
  'job/registered',
  'job/settled',
  'hook/invoked',
  'hook/result',
  'image/offload',
  'workspace/changes',
  'deliverables/presented',
  'schedule/change',
  'agent-preset/selected',
  'session-log-deepseek/delivery-accepted',
  'session/title-llm-request',
  'web/deepseek-search-llm-request',
]);
/** Families of log-only types the format reference names by prefix (`feedback/*`, Agent Teams, workflows, plugins). */
const IGNORED_PREFIXES = ['feedback/', 'team/', 'tool-workflow/', 'plugin:'];
/** The subagent tool's default names (format reference 4.10). */
const SUBAGENT_TOOLS = new Set(['subagent', 'subagent_fork']);
const SUMMARY_KEYS = ['command', 'path', 'file_path', 'filePath', 'file', 'target_file', 'pattern', 'query', 'url', 'description', 'prompt'];
/** Characters of a text kept for its summary / prompt title (the head of the text). */
const PREFIX_MAX = 2048;
const ID_MAX = 200;
const PATH_MAX_CHARS = 4096;
const MAX_TOUCHES = 64;
const MAX_CHILD_IDS = 8;

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const isoOfMs = (ms: number): string => new Date(ms).toISOString();
/** A copy of `s` sharing no memory with the string it was cut from (see grok.ts `own`): nothing of a row is retained. */
const own = (s: string): string => (' ' + s).slice(1);
const ownId = (s: string): string => own(s.slice(0, ID_MAX));
/** summarize of the head of a text, as an owned copy. */
const brief = (v: unknown): string => own(summarize(typeof v === 'string' ? head(v, PREFIX_MAX) : v));

/** The id of a DeepSeek node: `deepseek:<session id>[/<agent id>]:<part>`. */
export function deepseekNodeId(sessionId: string, agentId: string | null, part: string): string {
  return `deepseek:${sessionId}${agentId === null ? '' : `/${agentId}`}:${part}`;
}

/** A row's time (epoch ms); null when missing or out of range. */
function msOf(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 8.64e15) return null;
  return Math.floor(v);
}

/** The text of a message's content blocks: text joined; an image or file as a placeholder; other blocks nothing. */
function contentText(content: unknown, sep: string): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (!isObject(b)) continue;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'image') parts.push('[image]');
    else if (b.type === 'file') parts.push('[file]');
  }
  return parts.join(sep);
}

/** Usage of an assistant message (spec 3.3, section 10 item 2): cache writes count as new input, reasoning is in output. */
function usageOf(u: unknown): Usage | null {
  if (!isObject(u)) return null;
  if (!['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].some((k) => typeof u[k] === 'number')) return null;
  return { inputTokens: num(u.inputTokens) + num(u.cacheWriteTokens), cachedInputTokens: num(u.cacheReadTokens), outputTokens: num(u.outputTokens) };
}

function toolSummary(args: unknown): string {
  if (!isObject(args)) return args === undefined || args === null ? '' : brief(args);
  for (const k of SUMMARY_KEYS) {
    const v = nonEmpty(args[k]);
    if (v !== null) return brief(v.trim());
  }
  for (const v of Object.values(args)) if (typeof v === 'string' && v.trim() !== '') return brief(v.trim());
  return Object.keys(args).length === 0 ? '' : brief(args);
}

/** The first `n` UTF-16 units of `s`, one fewer when the cut would split a surrogate pair. */
function head(s: string, n: number): string {
  if (s.length <= n) return s;
  const code = s.charCodeAt(n - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

interface Turn {
  /** The turn's first node (its turnId); '' until it has one. */
  id: string;
  /** The `turn` number of its `turn/start`; null for a turn a prompt opened before its `turn/start` was read. */
  num: number | null;
  /** Calls made in the turn (a turn ended by an error or abort fails the ones still running). */
  calls: Call[];
  /** The seq of the row that opened it (a turn opened before a seeded file's cut is inherited). */
  seq: number;
}

interface CatalogEntry {
  childId: string;
  label: string | null;
  external: boolean;
  seq: number;
}

interface Thread {
  agentId: string | null;
  /** Offset of the latest row read (a smaller one: the file was rewritten and is read again from its start). */
  lastOffset: number;
  /** Every live node of the thread, in order. */
  nodes: string[];
  prev: string | null;
  prevTs: string | null;
  lastTs: string | null;
  first: string | null;
  /** The open turn (null: between turns). */
  turn: Turn | null;
  /** The latest `turn` / `step` numbers of the brackets (for rows that do not carry their own). */
  turnNum: number | null;
  stepNum: number | null;
  /** From the header: creation time and working directory. */
  createdMs: number | null;
  headerCwd: string | null;
  /** The latest `working-directory/change`. */
  changedCwd: string | null;
  /** The latest `session/title` (spec 3.3: last wins). */
  title: string | null;
  /** Title of the thread's first human prompt (the session's fallback title). */
  firstPrompt: string | null;
  /** Catalog rows and activations with a smaller seq are inherited (seeded file): +Infinity until the cut is read. */
  cutSeq: number;
  /** This file's own `subagent/catalog` rows by name. */
  catalog: Map<string, CatalogEntry>;
  /** Calls whose result was an activation, by the last segment of the activated name. */
  activations: Map<string, Call[]>;
  /** callId -> key of the latest call with that id (pairing a row without turn/step). */
  callIds: Map<string, string>;
  minMs: number | null;
  maxMs: number | null;
  /** The dispatch this agent thread hangs off. */
  linkedTo: Call | null;
  /**
   * Usage of messages that made no node while the thread had no node that could carry it (Task 8 review M1): added to
   * the next node that carries usage (carryUsage target or a message's holder).
   */
  pendingUsage: Usage | null;
}

/** Sum of two usages (null counts as nothing). */
function addUsage(a: Usage | null, b: Usage | null): Usage | null {
  if (a === null) return b;
  if (b === null) return a;
  return { inputTokens: a.inputTokens + b.inputTokens, cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0), outputTokens: a.outputTokens + b.outputTokens };
}

/** A tool call's state: never its arguments or output (they go out in the node's detail when a row brings them). */
interface Call {
  key: string;
  nodeId: string;
  callId: string;
  thread: Thread;
  name: string | null;
  status: 'running' | 'succeeded' | 'failed';
  endedAt: string | null;
  messageId: string | null;
  hasInput: boolean;
  hasResult: boolean;
  inputKey: string | undefined;
  argSummary: string;
  touches: RawTouch[];
  /** The thread's working directory when the call was made (resolves relative paths). */
  cwd: string | null;
  /** Full activated name (`reviewer/checker`) and the seq of its result. */
  activation: string | null;
  activationSeq: number;
  /** The catalog label of the child it activated. */
  label: string | null;
  /** Session ids of subagent threads this call names. */
  childIds: string[];
  removed: boolean;
}

interface SessionState {
  session: Session;
  /** The main header or a node was read: the session exists (a subagent header alone makes none). */
  started: boolean;
  emitted: boolean;
  projectId: string;
  threads: Map<string, Thread>;
  /** Every live node as emitted. */
  nodes: Map<string, GraphNode>;
  calls: Map<string, Call>;
  callByNode: Map<string, Call>;
  /** Child (agent) id -> the calls naming it, in the order they named it. */
  childCalls: Map<string, Call[]>;
}

type NodeSpec = Omit<GraphNode, 'sessionId' | 'turnId' | 'agentId' | 'parentId' | 'timestamp' | 'confirmed'>;

const blankNode = (id: string, kind: GraphNode['kind'], title: string, summary: string): NodeSpec => ({
  id,
  childAgentId: null,
  kind,
  status: null,
  title,
  summary,
  toolName: null,
  toolUseId: null,
  messageId: null,
  durationMs: null,
  endedAt: null,
  usage: null,
  systemSubtype: null,
});

export class DeepSeekNormalizer implements AgentNormalizer {
  private readonly sessions = new Map<string, SessionState>();
  private readonly restored = new Set<string>();

  apply(event: RawEvent, projectId: string): NormalizeResult {
    const r = this.applyBatch([{ event, projectId }]);
    const unknown = r.unknown[0];
    return unknown === undefined ? { changes: r.changes } : { changes: r.changes, unknownRecordType: unknown };
  }

  /** Rows one by one; the session row is emitted once, at the end of the batch. */
  applyBatch(items: readonly BatchItem[]): BatchResult {
    const changes: Change[] = [];
    const unknown: (string | undefined)[] = [];
    const touched = new Set<SessionState>();
    for (const { event, projectId } of items) {
      unknown.push(undefined);
      if (event.source !== 'transcript') continue; // no hooks or meta files of ours
      try {
        const state = this.stateFor(event.sessionId, projectId);
        touched.add(state);
        unknown[unknown.length - 1] = this.record(state, event, projectId, changes);
      } catch {
        unknown[unknown.length - 1] = `${ORIGIN}:normalizer-error`;
      }
    }
    for (const state of touched) {
      try {
        if (state.started) this.commitSession(state, changes);
      } catch {
        unknown[unknown.length - 1] ??= `${ORIGIN}:normalizer-error`;
      }
    }
    return { changes, unknown };
  }

  dropSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.restored.delete(sessionId);
  }

  needsPreSessionReplay(sessionId: string): boolean {
    return !this.sessions.has(sessionId) && !this.restored.has(sessionId);
  }

  /** Before the session exists only rows that made nothing can be stored (a subagent's header): re-applied. */
  restorePreSession(sessionId: string, events: Iterable<RawEvent>): void {
    this.dropSession(sessionId);
    for (const ev of events) {
      if (ev.sessionId !== sessionId || ev.source !== 'transcript') continue;
      this.apply(ev, ev.projectId != null ? ev.projectId : 'unknown');
    }
    if (!this.sessions.has(sessionId)) this.restored.add(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  toolInputCount(_sessionId: string): number {
    return 0;
  }

  // ---- state ----

  private stateFor(sessionId: string, projectId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (state === undefined) {
      state = {
        session: { id: sessionId, projectId, origin: ORIGIN, cwd: null, title: null, gitBranch: null, status: 'running', sourceDeleted: false, startedAt: EPOCH, lastActivityAt: EPOCH },
        started: false,
        emitted: false,
        projectId,
        threads: new Map(),
        nodes: new Map(),
        calls: new Map(),
        callByNode: new Map(),
        childCalls: new Map(),
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private thread(state: SessionState, agentId: string | null, changes: Change[]): Thread {
    const key = agentId ?? MAIN;
    let t = state.threads.get(key);
    if (t === undefined) {
      t = {
        agentId,
        lastOffset: -1,
        nodes: [],
        prev: null,
        prevTs: null,
        lastTs: null,
        first: null,
        turn: null,
        turnNum: null,
        stepNum: null,
        createdMs: null,
        headerCwd: null,
        changedCwd: null,
        title: null,
        firstPrompt: null,
        cutSeq: Number.NEGATIVE_INFINITY,
        catalog: new Map(),
        activations: new Map(),
        callIds: new Map(),
        minMs: null,
        maxMs: null,
        linkedTo: null,
        pendingUsage: null,
      };
      state.threads.set(key, t);
      if (agentId !== null) this.relink(state, t, changes); // a call naming it may have been read already
    }
    return t;
  }

  private start(state: SessionState, changes: Change[]): void {
    if (state.started) return;
    state.started = true;
    this.commitSession(state, changes); // the session row before its first node
  }

  // ---- rows ----

  private record(state: SessionState, event: Extract<RawEvent, { source: 'transcript' }>, projectId: string, changes: Change[]): string | undefined {
    const t = this.thread(state, event.agentId, changes);
    if (event.offset <= t.lastOffset) this.resetThread(state, t, changes);
    t.lastOffset = event.offset;
    let rec: unknown;
    try {
      rec = JSON.parse(event.line);
    } catch {
      return `${ORIGIN}:invalid-json`;
    }
    if (!isObject(rec)) return `${ORIGIN}:not-an-object`;
    const type = rec.type;
    if (typeof type !== 'string') return unknownTypeName(ORIGIN, type);
    const isHeader = type === 'session';
    if (!isHeader && !HANDLED.has(type)) {
      if (!IGNORED.has(type) && !IGNORED_PREFIXES.some((p) => type.startsWith(p))) return unknownTypeName(ORIGIN, type);
    }
    if (projectId !== 'unknown' && (event.agentId === null || state.projectId === 'unknown')) state.projectId = projectId;
    if (isHeader) {
      this.header(state, t, rec, changes);
      return undefined;
    }
    const ms = msOf(rec.time);
    if (ms !== null) {
      t.minMs = t.minMs === null ? ms : Math.min(t.minMs, ms);
      t.maxMs = t.maxMs === null ? ms : Math.max(t.maxMs, ms);
    }
    if (!HANDLED.has(type)) return undefined;
    const ts = ms === null ? null : isoOfMs(ms);
    const seq = int(rec.seq) ?? event.offset - 1;
    const data = isObject(rec.data) ? rec.data : {};
    switch (type) {
      case 'turn/start':
        this.turnStart(t, int(data.turn), event.offset - 1);
        break;
      case 'turn/end':
        this.turnEnd(state, t, data, ts, event.offset, changes);
        break;
      case 'step/start':
        t.stepNum = int(data.step);
        if (int(data.turn) !== null) t.turnNum = int(data.turn);
        break;
      case 'step/end':
        break;
      case 'user/message':
        this.userMessage(state, t, data, ts, event.offset, changes);
        break;
      case 'assistant/message':
        this.assistantMessage(state, t, data, ts, event.offset, changes);
        break;
      case 'tool/call':
        this.toolCall(state, t, data, ts, changes);
        break;
      case 'tool/result':
        this.toolResult(state, t, data, rec.surfaceOp, seq, ts, changes);
        break;
      case 'session/title': {
        const title = nonEmpty(data.title);
        if (title !== null) t.title = own(head(title.trim(), PREFIX_MAX));
        break;
      }
      case 'working-directory/change': {
        const cwd = nonEmpty(data.cwd);
        if (cwd !== null) t.changedCwd = own(normaliseCwd(cwd.slice(0, PATH_MAX_CHARS)));
        break;
      }
      case 'subagent/catalog':
        this.catalog(state, t, data, seq, changes);
        break;
      case 'session/end-seed':
        if (data.inherited === true) this.cut(state, t, seq, changes);
        break;
    }
    if (ts !== null) t.lastTs = ts;
    return undefined;
  }

  /** The header (format reference 4.1): creation time, working directory, seeded; a main header makes the session. */
  private header(state: SessionState, t: Thread, rec: Obj, changes: Change[]): void {
    t.createdMs = msOf(rec.createdAt);
    const cwd = nonEmpty(rec.cwd);
    t.headerCwd = cwd === null ? null : own(normaliseCwd(cwd.slice(0, PATH_MAX_CHARS)));
    // Seeded: everything up to the (last) inherited end-seed is a copy of another session's history.
    t.cutSeq = rec.isSeeded === true ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    if (t.agentId === null) this.start(state, changes);
  }

  private cwdOf(t: Thread): string | null {
    return t.changedCwd ?? t.headerCwd;
  }

  // ---- turns and nodes ----

  private turnStart(t: Thread, n: number | null, seq: number): void {
    t.turnNum = n;
    t.stepNum = null;
    // A turn a prompt opened before its bracket was read is this turn.
    if (t.turn !== null && t.turn.num === null) {
      t.turn.num = n;
      return;
    }
    t.turn = { id: '', num: n, calls: [], seq };
  }

  /**
   * turn/end (format reference 4.3): an error ends the turn with a "Turn failed" node, an abort or a crash with an
   * "Interrupted" node (both `systemSubtype: 'interrupt'`, as the Codex normalizer writes them), and the turn's calls
   * still running fail. Other reasons (completed, blocked, max-tokens, forked) show nothing.
   */
  private turnEnd(state: SessionState, t: Thread, data: Obj, ts: string | null, offset: number, changes: Change[]): void {
    const reason = isObject(data.reason) ? data.reason : {};
    const kind = reason.kind;
    if (kind === 'error' || kind === 'aborted' || kind === 'interrupted') {
      let summary = '';
      if (kind === 'error') {
        const err = isObject(reason.error) ? reason.error : {};
        summary = brief(nonEmpty(err.message) ?? nonEmpty(err.code) ?? '');
      } else if (kind === 'aborted' && isObject(reason.reason)) {
        const why = nonEmpty(reason.reason.reason) ?? nonEmpty(reason.reason.kind);
        summary = why === null ? '' : brief(why);
      }
      const title = kind === 'error' ? 'Turn failed' : 'Interrupted';
      this.addNode(state, t, t.turn, { ...blankNode(deepseekNodeId(state.session.id, t.agentId, `@${offset}`), 'system', title, summary), systemSubtype: 'interrupt' }, ts, kind === 'error' ? { text: summary } : {}, changes);
      for (const call of t.turn?.calls ?? []) {
        if (call.removed || call.status !== 'running') continue;
        call.status = 'failed';
        call.endedAt ??= ts ?? t.lastTs ?? EPOCH;
        this.refreshCall(state, call, changes);
      }
    }
    t.turn = null;
  }

  /** The node a thread's next node hangs off: its last node, else (agent thread) the dispatch it is linked to. */
  private parentOf(t: Thread): { from: string; kind: 'sequence' | 'spawn' } | null {
    if (t.prev !== null) return { from: t.prev, kind: 'sequence' };
    if (t.linkedTo === null || t.linkedTo.removed) return null;
    return { from: t.linkedTo.nodeId, kind: 'spawn' };
  }

  /** Adds a node at the end of thread `t` (in `turn`, if any), with the edge into it. */
  private addNode(state: SessionState, t: Thread, turn: Turn | null, node: NodeSpec, ts: string | null, detail: Partial<NodeDetail>, changes: Change[]): GraphNode {
    this.start(state, changes);
    let id = node.id;
    for (let k = 1; state.nodes.has(id); k++) id = `${node.id}~${k}`;
    if (turn !== null && turn.id === '') turn.id = id;
    const parent = this.parentOf(t);
    const timestamp = ts ?? t.prevTs ?? t.lastTs ?? EPOCH;
    const full: GraphNode = { ...node, id, sessionId: state.session.id, turnId: turn?.id ?? null, agentId: t.agentId, parentId: parent?.from ?? null, timestamp, confirmed: true };
    state.nodes.set(id, full);
    t.nodes.push(id);
    changes.push({ type: 'node_added', node: full, detail });
    if (parent !== null) changes.push({ type: 'edge_added', edge: { id: `${parent.from}->${id}`, sessionId: state.session.id, from: parent.from, to: id, kind: parent.kind } });
    t.prev = id;
    t.prevTs = timestamp;
    t.first ??= id;
    return full;
  }

  /** Emits what differs between an emitted node and `next`, and `detail` (merged into the stored one). */
  private update(state: SessionState, next: GraphNode, changes: Change[], detail?: Partial<NodeDetail>): void {
    const old = state.nodes.get(next.id);
    if (old === undefined) return;
    const patch = nodePatch(old, next);
    if (Object.keys(patch).length === 0 && detail === undefined) return;
    state.nodes.set(next.id, { ...old, ...patch });
    changes.push({ type: 'node_updated', sessionId: state.session.id, id: next.id, patch, ...(detail !== undefined ? { detail } : {}) });
  }

  // ---- messages ----

  /** user/message (format reference 4.4): `source.kind` `user` is a prompt, `compact-checkpoint` a system node; the rest is injected context. */
  private userMessage(state: SessionState, t: Thread, data: Obj, ts: string | null, offset: number, changes: Change[]): void {
    const kind = isObject(data.source) ? data.source.kind : undefined;
    if (kind !== 'user' && kind !== 'compact-checkpoint') return;
    // Blocks are separate paragraphs (Task 4 review m3): joined with a newline, not run together.
    const text = contentText(data.content, '\n');
    const id = deepseekNodeId(state.session.id, t.agentId, `@${offset}`);
    if (kind === 'compact-checkpoint') {
      this.addNode(state, t, t.turn, { ...blankNode(id, 'system', 'Compact', brief(text)), systemSubtype: 'compact' }, ts, { text }, changes);
      return;
    }
    if (text.trim() === '') return;
    t.turn ??= { id: '', num: null, calls: [], seq: offset - 1 };
    this.addNode(state, t, t.turn, blankNode(id, 'prompt', 'Prompt', brief(text)), ts, { text }, changes);
    if (t.firstPrompt === null) {
      const title = promptTitle(head(text, PREFIX_MAX));
      if (title !== null) t.firstPrompt = own(title);
    }
  }

  /**
   * assistant/message (format reference 4.5): runs of reasoning / text blocks become thinking / text nodes, tool-call
   * blocks tool nodes, in model order, each carrying the message id. The message's usage and model go on one node: its
   * last text node, else its first tool node, else its last thinking node.
   */
  private assistantMessage(state: SessionState, t: Thread, data: Obj, ts: string | null, offset: number, changes: Change[]): void {
    const message = isObject(data.message) ? data.message : {};
    const rawId = nonEmpty(message.id);
    const messageId = rawId === null ? null : ownId(rawId);
    const turnNum = int(data.turn) ?? t.turnNum;
    const stepNum = int(data.step) ?? t.stepNum;
    type Part = { kind: 'text' | 'thinking'; index: number; text: string } | { kind: 'call'; block: Obj };
    const parts: Part[] = [];
    const content = Array.isArray(message.content) ? message.content : [];
    content.forEach((b: unknown, index) => {
      if (!isObject(b)) return;
      if (b.type === 'text' || b.type === 'reasoning') {
        if (typeof b.text !== 'string' || b.text === '') return;
        const kind = b.type === 'text' ? 'text' : 'thinking';
        const last = parts[parts.length - 1];
        if (last !== undefined && last.kind === kind) last.text += b.text;
        else parts.push({ kind, index, text: b.text });
      } else if (b.type === 'tool-call' && nonEmpty(b.id) !== null) {
        parts.push({ kind: 'call', block: b });
      }
    });
    const lastOf = (kind: Part['kind']): Part | undefined => {
      for (let i = parts.length - 1; i >= 0; i--) if (parts[i]!.kind === kind) return parts[i];
      return undefined;
    };
    const holder = lastOf('text') ?? parts.find((p) => p.kind === 'call') ?? lastOf('thinking');
    const ownUsage = usageOf(data.usage);
    const source = isObject(message.source) ? message.source : {};
    const provider = nonEmpty(source.provider);
    const model = nonEmpty(source.model);
    const raw = provider !== null || model !== null ? { raw: { provider, model } } : {};
    if (holder === undefined) {
      if (ownUsage !== null) this.carryUsage(state, t, ownUsage, changes);
      return;
    }
    // The holder also takes usage left waiting by earlier messages of the thread that made no node.
    const usage = addUsage(ownUsage, t.pendingUsage);
    t.pendingUsage = null;
    for (const p of parts) {
      const holds = p === holder;
      if (p.kind === 'call') {
        const callId = ownId(nonEmpty(p.block.id)!);
        const call = this.ensureCall(state, t, turnNum, stepNum, callId, ts, changes);
        call.messageId ??= messageId;
        const name = nonEmpty(p.block.name);
        if (name !== null) call.name = brief(name);
        const detail: Partial<NodeDetail> = { ...(!call.hasInput && p.block.arguments !== undefined ? this.setArgs(call, p.block.arguments) : {}), ...(holds ? raw : {}) };
        if (holds && usage !== null) {
          const node = state.nodes.get(call.nodeId);
          if (node !== undefined) this.update(state, { ...node, usage }, changes);
        }
        this.refreshCall(state, call, changes, Object.keys(detail).length > 0 ? detail : undefined);
        continue;
      }
      const id = deepseekNodeId(state.session.id, t.agentId, `@${offset}.${p.index}`);
      const spec = p.kind === 'text' ? blankNode(id, 'text', 'Text', brief(p.text)) : blankNode(id, 'thinking', 'Thinking', brief(p.text));
      this.addNode(state, t, t.turn, { ...spec, messageId, usage: holds ? usage : null }, ts, { text: p.text, ...(holds ? raw : {}) }, changes);
    }
  }

  /**
   * The usage of an assistant message that makes no node (image only, or empty after an interruption; Task 4 review
   * m1), added to the nearest preceding node of thread `t` that may carry it, so session totals keep it: a node that
   * already has usage, or one without a message id. A node of another message that has no usage is passed over (that
   * message's usage is on a sibling node, and the totals count only the first node of a message id that has usage).
   * No such node yet in the thread (e.g. a subagent's first reply): it waits in `pendingUsage` for the thread's next
   * node that carries usage (Task 8 review M1); a thread that never gets one loses it.
   */
  private carryUsage(state: SessionState, t: Thread, usage: Usage, changes: Change[]): void {
    for (let i = t.nodes.length - 1; i >= 0; i--) {
      const node = state.nodes.get(t.nodes[i]!);
      if (node === undefined) continue;
      if (node.usage == null && node.messageId) continue;
      const sum = addUsage(addUsage(node.usage ?? null, usage), t.pendingUsage)!;
      t.pendingUsage = null;
      this.update(state, { ...node, usage: { inputTokens: sum.inputTokens, cachedInputTokens: sum.cachedInputTokens ?? 0, outputTokens: sum.outputTokens } }, changes);
      return;
    }
    t.pendingUsage = addUsage(t.pendingUsage, usage);
  }

  // ---- tool calls ----

  /** The call `(turn, step, callId)` of thread `t`, its node added at the end of the thread when new. */
  private ensureCall(state: SessionState, t: Thread, turnNum: number | null, stepNum: number | null, callId: string, ts: string | null, changes: Change[]): Call {
    const where = `${turnNum ?? '-'}.${stepNum ?? '-'}.${callId}`;
    const key = `${t.agentId ?? ''}\u0000${where}`;
    let call = state.calls.get(key);
    if (call !== undefined) return call;
    const node = this.addNode(state, t, t.turn, { ...blankNode(deepseekNodeId(state.session.id, t.agentId, `call:${where}`), 'tool', 'tool', ''), status: 'running', toolUseId: callId }, ts, {}, changes);
    call = {
      key,
      nodeId: node.id,
      callId,
      thread: t,
      name: null,
      status: 'running',
      endedAt: null,
      messageId: null,
      hasInput: false,
      hasResult: false,
      inputKey: undefined,
      argSummary: '',
      touches: [],
      cwd: this.cwdOf(t),
      activation: null,
      activationSeq: 0,
      label: null,
      childIds: [],
      removed: false,
    };
    state.calls.set(key, call);
    state.callByNode.set(node.id, call);
    t.callIds.set(callId, key);
    t.turn?.calls.push(call);
    return call;
  }

  /** The call's arguments (a raw JSON string from the model, possibly invalid): the detail input and what is derived from it. */
  private setArgs(call: Call, raw: unknown): Partial<NodeDetail> {
    let input: unknown = raw;
    if (typeof raw === 'string') {
      try {
        input = JSON.parse(raw);
      } catch {
        input = raw;
      }
    }
    call.hasInput = true;
    call.inputKey = inputKeyOf(call.name, input);
    call.argSummary = toolSummary(input);
    call.touches = call.name === null ? [] : deepseekTouches(call.name, input).slice(0, MAX_TOUCHES).map((x) => ({ path: own(x.path.slice(0, PATH_MAX_CHARS)), action: x.action }));
    return { input };
  }

  /** tool/call (format reference 4.6): the same call as the assistant message's tool-call block with that id. */
  private toolCall(state: SessionState, t: Thread, data: Obj, ts: string | null, changes: Change[]): void {
    const rawId = nonEmpty(data.callId);
    if (rawId === null) return;
    const call = this.ensureCall(state, t, int(data.turn) ?? t.turnNum, int(data.step) ?? t.stepNum, ownId(rawId), ts, changes);
    const name = nonEmpty(data.name);
    if (name !== null) call.name = brief(name);
    const detail = !call.hasInput && data.arguments !== undefined ? this.setArgs(call, data.arguments) : undefined;
    this.refreshCall(state, call, changes, detail);
  }

  /**
   * tool/result (format reference 4.6): paired by callId within its turn and step (else with the latest call of that
   * id still without a result); `isError` fails it. A `surfaceOp: replace` result is a new version of an earlier
   * result (pruning): it changes nothing. An activation result (4.10) names a subagent.
   */
  private toolResult(state: SessionState, t: Thread, data: Obj, surfaceOp: unknown, seq: number, ts: string | null, changes: Change[]): void {
    const message = isObject(data.message) ? data.message : {};
    const rawId = nonEmpty(message.toolCallId) ?? (isObject(message.source) ? nonEmpty(message.source.callId) : null);
    if (rawId === null) return;
    const callId = ownId(rawId);
    const replace = isObject(surfaceOp) && surfaceOp.op === 'replace';
    const turnNum = int(data.turn);
    const stepNum = int(data.step);
    let call = turnNum !== null && stepNum !== null ? state.calls.get(`${t.agentId ?? ''}\u0000${turnNum}.${stepNum}.${callId}`) : undefined;
    if (call === undefined) {
      const key = t.callIds.get(callId);
      const latest = key === undefined ? undefined : state.calls.get(key);
      if (latest !== undefined && (replace || !latest.hasResult)) call = latest;
    }
    if (replace) return; // a later version of a result already shown, or of one this file does not have
    call ??= this.ensureCall(state, t, turnNum ?? t.turnNum, stepNum ?? t.stepNum, callId, ts, changes);
    call.hasResult = true;
    call.status = message.isError === true ? 'failed' : 'succeeded';
    call.endedAt ??= ts ?? t.lastTs ?? EPOCH;
    let output = contentText(message.content, '\n');
    if (output === '' && isObject(data.error)) output = [nonEmpty(data.error.name), nonEmpty(data.error.reason) ?? nonEmpty(data.error.code)].filter((x) => x !== null).join(': ');
    const meta = isObject(data.meta) ? data.meta : null;
    const activated = meta !== null && meta.kind === 'activation' ? nonEmpty(meta.name) : null;
    if (activated !== null && seq >= t.cutSeq && call.activation === null) {
      call.activation = brief(activated);
      call.activationSeq = seq;
      const segment = activated.slice(activated.lastIndexOf('/') + 1);
      const list = t.activations.get(segment);
      if (list === undefined) t.activations.set(own(segment), [call]);
      else list.push(call);
      const entry = t.catalog.get(segment);
      if (entry !== undefined) this.join(state, call, entry, changes);
    }
    this.refreshCall(state, call, changes, { output });
  }

  /** The call's node as its state says, emitted where it differs (with `detail` merged into the stored one). */
  private refreshCall(state: SessionState, call: Call, changes: Change[], detail?: Partial<NodeDetail>): void {
    if (call.removed) return;
    const old = state.nodes.get(call.nodeId);
    if (old === undefined) return;
    const childAgentId = call.childIds.find((id) => state.threads.get(id)?.linkedTo === call) ?? null;
    const subagent = (call.name !== null && SUBAGENT_TOOLS.has(call.name)) || call.activation !== null || childAgentId !== null;
    const files = subagent ? {} : nodeFiles(call.touches, call.cwd);
    const durationMs = call.endedAt === null ? null : Math.max(0, Date.parse(call.endedAt) - Date.parse(old.timestamp)) || 0;
    const next: GraphNode = {
      ...old,
      files: undefined,
      filesTruncated: undefined,
      kind: subagent ? 'subagent' : 'tool',
      title: subagent ? (call.label ?? call.activation ?? call.name ?? 'subagent') : (call.name ?? 'tool'),
      summary: call.argSummary,
      status: call.status,
      toolName: call.name,
      toolUseId: call.callId,
      messageId: call.messageId,
      childAgentId,
      endedAt: call.endedAt,
      durationMs,
      ...filesFields(files),
      ...inputKeyFields(call.inputKey),
    };
    this.update(state, next, changes, detail);
  }

  // ---- subagent threads ----

  /** subagent/catalog (format reference 4.10): this file's own children by name; inherited rows of a seed are not. */
  private catalog(state: SessionState, t: Thread, data: Obj, seq: number, changes: Change[]): void {
    if (seq < t.cutSeq) return;
    const childId = nonEmpty(data.childId);
    const name = nonEmpty(data.name);
    if (childId === null || name === null) return; // catalog v0-v2 without a name: nothing to join by
    const label = nonEmpty(data.label);
    const entry: CatalogEntry = { childId: ownId(childId), label: label === null ? null : brief(label), external: data.mode === 'external', seq };
    t.catalog.set(own(name), entry);
    for (const call of t.activations.get(name) ?? []) this.join(state, call, entry, changes);
  }

  /** An activation call meets its catalog row: the label, and (a local child) the child's id. */
  private join(state: SessionState, call: Call, entry: CatalogEntry, changes: Change[]): void {
    if (call.removed) return;
    call.label = entry.label;
    if (entry.external) {
      this.refreshCall(state, call, changes);
      return;
    }
    this.nameChild(state, call, entry.childId, changes);
    this.refreshCall(state, call, changes);
  }

  /** The inherited cut of a seeded file: catalog rows and activations before it were the source session's. */
  private cut(state: SessionState, t: Thread, seq: number, changes: Change[]): void {
    t.cutSeq = seq;
    for (const [name, entry] of [...t.catalog]) if (entry.seq < seq) t.catalog.delete(name);
    for (const [name, calls] of [...t.activations]) {
      const kept = calls.filter((c) => c.activationSeq >= seq);
      for (const c of calls) if (c.activationSeq < seq) this.forgetActivation(state, c, changes);
      if (kept.length === 0) t.activations.delete(name);
      else t.activations.set(name, kept);
    }
  }

  private forgetActivation(state: SessionState, call: Call, changes: Change[]): void {
    call.activation = null;
    call.label = null;
    const ids = call.childIds;
    call.childIds = [];
    for (const id of ids) {
      const list = state.childCalls.get(id);
      if (list !== undefined) {
        const rest = list.filter((c) => c !== call);
        if (rest.length === 0) state.childCalls.delete(id);
        else state.childCalls.set(id, rest);
      }
      const child = state.threads.get(id);
      if (child !== undefined) this.relink(state, child, changes);
    }
    this.refreshCall(state, call, changes);
  }

  /** A call named a subagent session id: it is a link candidate of that thread. */
  private nameChild(state: SessionState, call: Call, childId: string, changes: Change[]): void {
    if (call.childIds.includes(childId) || call.childIds.length >= MAX_CHILD_IDS || childId === call.thread.agentId) return;
    call.childIds.push(childId);
    const list = state.childCalls.get(childId);
    if (list === undefined) state.childCalls.set(childId, [call]);
    else list.push(call);
    const t = state.threads.get(childId);
    if (t !== undefined) this.relink(state, t, changes);
  }

  /**
   * Hangs agent thread `t` off the first live call naming its id (in the order the calls named it), or off nothing
   * when none does: the thread's first node gets that parent (and spawn edge), the call its childAgentId.
   */
  private relink(state: SessionState, t: Thread, changes: Change[]): void {
    if (t.agentId === null) return;
    const want = (state.childCalls.get(t.agentId) ?? []).find((c) => !c.removed && c.thread !== t) ?? null;
    if (want === t.linkedTo) return;
    const old = t.linkedTo;
    t.linkedTo = want;
    if (old !== null) this.refreshCall(state, old, changes);
    if (want !== null) this.refreshCall(state, want, changes);
    if (t.first === null) return;
    const node = state.nodes.get(t.first);
    if (node === undefined) return;
    const parent = want?.nodeId ?? null;
    if (node.parentId === parent) return;
    const sid = state.session.id;
    if (node.parentId !== null && old !== null && !old.removed) changes.push({ type: 'edge_removed', sessionId: sid, id: `${node.parentId}->${node.id}` });
    this.update(state, { ...node, parentId: parent }, changes);
    if (parent !== null) changes.push({ type: 'edge_added', edge: { id: `${parent}->${node.id}`, sessionId: sid, from: parent, to: node.id, kind: 'spawn' } });
  }

  // ---- restarts ----

  /** The thread's file is read again from its start: everything its old content made is removed. */
  private resetThread(state: SessionState, t: Thread, changes: Change[]): void {
    const affected = new Set<Thread>();
    for (const id of t.nodes) this.removeNode(state, id, affected, changes);
    t.nodes = [];
    t.prev = null;
    t.prevTs = null;
    t.lastTs = null;
    t.first = null;
    t.turn = null;
    t.turnNum = null;
    t.stepNum = null;
    t.createdMs = null;
    t.headerCwd = null;
    t.changedCwd = null;
    t.title = null;
    t.firstPrompt = null;
    t.cutSeq = Number.NEGATIVE_INFINITY;
    t.catalog.clear();
    t.activations.clear();
    t.callIds.clear();
    t.minMs = null;
    t.maxMs = null;
    t.pendingUsage = null;
    for (const child of affected) if (child !== t) this.relink(state, child, changes);
  }

  /** Removes one node (the store drops its detail, search entry and edges); a call's node takes the call with it. */
  private removeNode(state: SessionState, id: string, affected: Set<Thread>, changes: Change[]): void {
    if (!state.nodes.delete(id)) return;
    changes.push({ type: 'node_removed', sessionId: state.session.id, id });
    const call = state.callByNode.get(id);
    if (call === undefined) return;
    call.removed = true;
    state.callByNode.delete(id);
    state.calls.delete(call.key);
    for (const childId of call.childIds) {
      const list = state.childCalls.get(childId);
      if (list !== undefined) {
        const rest = list.filter((c) => c !== call);
        if (rest.length === 0) state.childCalls.delete(childId);
        else state.childCalls.set(childId, rest);
      }
      const child = state.threads.get(childId);
      if (child !== undefined && child.linkedTo === call) affected.add(child);
    }
  }

  // ---- session ----

  /**
   * The session as a function of what was read: title = the main file's last session/title, else its first prompt;
   * cwd = its last working-directory/change, else its header's; started = the header's createdAt, else the earliest row
   * time; status (Task 8 review I1) running while the main thread has a turn open (from its `turn/start`, or a prompt
   * read before it, to its `turn/end`), else idle: subagent threads do not change it; a seeded file (a fork) is idle
   * until its inherited cut is read.
   */
  private commitSession(state: SessionState, changes: Change[]): void {
    const main = state.threads.get(MAIN);
    let minMs: number | null = null;
    let maxMs: number | null = null;
    for (const th of state.threads.values()) {
      if (th.minMs !== null) minMs = minMs === null ? th.minMs : Math.min(minMs, th.minMs);
      if (th.maxMs !== null) maxMs = maxMs === null ? th.maxMs : Math.max(maxMs, th.maxMs);
    }
    const startMs = main?.createdMs ?? minMs;
    const startedAt = startMs === null ? EPOCH : isoOfMs(startMs);
    const lastMs = Math.max(maxMs ?? Number.NEGATIVE_INFINITY, Date.parse(startedAt));
    const next: Session = {
      ...state.session,
      projectId: state.projectId,
      cwd: main === undefined ? null : this.cwdOf(main),
      title: main?.title ?? main?.firstPrompt ?? null,
      gitBranch: null,
      // A turn opened before a seeded file's cut (or while the cut is not read yet) is copied history: idle, so
      // replaying a fork never notifies.
      status: main !== undefined && main.turn !== null && main.turn.seq >= main.cutSeq ? 'running' : 'idle',
      startedAt,
      lastActivityAt: isoOfMs(lastMs),
    };
    const cur = state.session;
    const same =
      cur.projectId === next.projectId &&
      cur.cwd === next.cwd &&
      cur.title === next.title &&
      cur.status === next.status &&
      cur.startedAt === next.startedAt &&
      cur.lastActivityAt === next.lastActivityAt;
    if (same && state.emitted) return;
    state.emitted = true;
    state.session = next;
    changes.push({ type: 'session_upserted', session: next });
  }
}
