import { createHash } from 'node:crypto';
import type { Change, GraphNode, NodeDetail, Session, Usage } from '@agent-canvas/shared';
import { GROK_SUMMARY_ENTRY_PREFIX, type GrokSummaryPayload } from '../sources/grok/source.js';
import type { RawEvent } from '../store/store.js';
import { promptTitle } from './codex.js';
import { applyPatchTouches, filesFields, grokToolCategory, grokTouches, nodeFiles, type RawTouch } from './files.js';
import { nodePatch } from './gemini.js';
import { inputKeyFields, inputKeyOf } from './input-key.js';
import { summarize } from './summary.js';
import type { AgentNormalizer, BatchItem, BatchResult, NormalizeResult } from './types.js';
import { unknownTypeName } from './unknown-type.js';

/*
 * The Grok Build normalizer (spec 5.2). A session's `updates.jsonl` (and each subagent session's, as an agent thread
 * of its parent) is a list of ACP `session/update` notifications and xAI `_x.ai/session/update` extension records;
 * each line is applied once, in order, to its thread and emits the changes it causes. Work per line is O(1) apart from
 * the line's own content; a rewind costs the nodes it removes.
 *
 * Node ids: `grok:<session id>[/<agent id>]:call:<toolCallId>` for a tool call, `…:@<offset>` for a chunk run (the file
 * offset of its first chunk line, the same for every read of the file).
 *
 * Chunk runs: consecutive `user_message_chunk` / `agent_message_chunk` / `agent_thought_chunk` lines of one kind in one
 * turn extend one node (prompt / text / thinking). A line that adds a node of its own, a chunk of another kind, a new
 * turn, a `turn_completed` or a rewind closes the run; records that add no node (a tool_call_update, ignored records)
 * do not. Only the open run's text is held; the node's detail carries the whole text, emitted once per apply / batch
 * (node_updated detail replaces the stored text). A run longer than RUN_MAX_CHARS continues in a new node, so a
 * pathological run never makes each store write cost its whole length.
 *
 * Turns: `_meta.promptId` (params first, then params.update) changing opens a turn; without one, a user chunk that
 * does not continue a user run opens one. Turn index (rewind `target_prompt_index`) = position among the thread's turns.
 */

const EPOCH = '1970-01-01T00:00:00.000Z';
const MAIN = '';
const UPDATE = 'session/update';
const EXT = '_x.ai/session/update';
/** Standard ACP updates that show nothing (spec 5.2): neither node nor report. */
const IGNORED_UPDATES = new Set(['plan', 'available_commands_update', 'current_mode_update']);
const CHUNKS: Record<string, RunKind> = { user_message_chunk: 'user', agent_message_chunk: 'agent', agent_thought_chunk: 'thought' };
/** Characters of a run kept for its summary / prompt title (the head of the text). */
const PREFIX_MAX = 2048;
/** A chunk run longer than this continues in a new node. */
export const GROK_RUN_MAX_CHARS = 256 * 1024;
/** Keys of a dispatch's output (or `_meta`) that name the subagent session it ran (research A2: `subagent_id`). */
const CHILD_ID_KEYS = ['subagent_id', 'subagentId', 'child_session_id', 'childSessionId'];
const MAX_CHILD_IDS = 8;
const SUMMARY_KEYS = ['command', 'target_file', 'file_path', 'path', 'filePath', 'target_directory', 'pattern', 'query', 'url', 'description', 'prompt'];
const PATH_KEYS = ['target_file', 'file_path', 'path', 'target_directory', 'filePath'];
const PATH_MAX_CHARS = 4096;
const MAX_TOUCHES = 64;

type RunKind = 'user' | 'agent' | 'thought';
type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const isoOfMs = (ms: number): string => new Date(ms).toISOString();
/**
 * A copy of `s` that shares no memory with the string it was cut from. V8 keeps a slice (`slice`, a regex replace that
 * matched nothing, …) of a long string as a view that holds the whole original alive: every string this normalizer keeps
 * across records (names, titles, summaries, paths, ids) goes through here, so no tool input, output or line is retained.
 */
const own = (s: string): string => (' ' + s).slice(1);
/** summarize, as an owned copy (see own). */
const brief = (v: unknown): string => own(summarize(v));

/** The id of a Grok node: `grok:<session id>[/<agent id>]:<part>`. */
export function grokNodeId(sessionId: string, agentId: string | null, part: string): string {
  return `grok:${sessionId}${agentId === null ? '' : `/${agentId}`}:${part}`;
}

/** A line's time: Unix seconds (milliseconds when the number is that large); 0 / missing: none. */
function msOfTimestamp(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  const ms = v > 1e12 ? v : v * 1000;
  return ms > 8.64e15 ? null : Math.floor(ms);
}

/** The text of a content block (or a list of them): text parts joined; an image as `[image]`. */
function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(blockText).join('');
  if (!isObject(content)) return '';
  if (typeof content.text === 'string') return content.text;
  if (content.type === 'image') return '[image]';
  if (isObject(content.content)) return blockText(content.content);
  return '';
}

/** A tool update's output text: the text blocks of `content[]` (ACP `{type:"content", content}` or bare), joined. */
function contentText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const c of content) {
    if (!isObject(c)) continue;
    const inner = c.type === 'content' && isObject(c.content) ? c.content : c;
    if (typeof inner.text === 'string') parts.push(inner.text);
  }
  return parts.length === 0 ? null : parts.join('\n');
}

function callStatus(v: unknown): 'running' | 'succeeded' | 'failed' | null {
  if (typeof v !== 'string') return null;
  if (v === 'completed') return 'succeeded';
  if (v === 'failed' || v === 'error' || v === 'cancelled') return 'failed';
  return 'running';
}

/** Usage of a turn_completed (spec 5.2): cache writes count as new input, reasoning as output. Null: none given. */
function usageOf(u: unknown): Usage | null {
  if (!isObject(u)) return null;
  const keys = ['inputTokens', 'outputTokens', 'cachedReadTokens', 'cacheCreationTokens', 'reasoningTokens'];
  if (!keys.some((k) => typeof u[k] === 'number')) return null;
  return { inputTokens: num(u.inputTokens) + num(u.cacheCreationTokens), cachedInputTokens: num(u.cachedReadTokens), outputTokens: num(u.outputTokens) + num(u.reasoningTokens) };
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

interface Turn {
  /** The turn's first node (its turnId); '' until it has one. */
  id: string;
  promptId: string | null;
  /** A prompt turn (counts for rewind indices); false: the nodes read before any turn. */
  counted: boolean;
  nodes: string[];
  /** The turn's latest reply (text) node. */
  lastReply: string | null;
  /** The node holding the turn's usage. */
  usageOn: string | null;
  /** The title of the turn's first prompt (undefined: no prompt yet). */
  title: string | null | undefined;
  removed: boolean;
}

interface Run {
  kind: RunKind;
  nodeId: string;
  turn: Turn;
  /** The whole text (built by concatenation: never sliced or searched, so never flattened here). */
  text: string;
  chars: number;
  /** The head of the text (PREFIX_MAX characters) for summary and title. */
  prefix: string;
  /** summarize(prefix), once per change of the prefix (null: to compute). */
  summary: string | null;
  /** Text changed since last emitted. */
  dirty: boolean;
  /** The run gives its turn's title. */
  titles: boolean;
}

interface Thread {
  agentId: string | null;
  turns: Turn[];
  current: Turn | null;
  byPrompt: Map<string, Turn>;
  prev: string | null;
  prevTs: string | null;
  /** Time of the thread's latest timed line (fallback time of an untimed node; thread-local, so arrival order of threads never matters). */
  lastTs: string | null;
  first: string | null;
  run: Run | null;
  /** The earliest turn that has a prompt title (the session's fallback title). */
  firstTitled: Turn | null;
  /** The dispatch this agent thread hangs off. */
  linkedTo: Call | null;
}

/**
 * A tool call's state. Bounded: arguments and output are never kept (they go out in the node's detail when a record
 * brings them; the store merges detail fields); only what later records need is: the path arguments (capped), files of
 * a patch, the first location, and fields derived from the arguments.
 */
interface Call {
  key: string;
  nodeId: string;
  toolCallId: string | null;
  thread: Thread;
  name: string | null;
  kind: string | null;
  acpTitle: string | null;
  status: 'running' | 'succeeded' | 'failed';
  endedAt: string | null;
  pathArgs: Record<string, string>;
  patchFiles: RawTouch[];
  locations: { path: string }[];
  inputKey: string | undefined;
  argSummary: string;
  argAgent: string | null;
  /** Session ids of subagent runs this call names (exact ids only). */
  childIds: string[];
  removed: boolean;
}

interface SessionState {
  session: Session;
  /** A node was added: the session exists (a summary alone, ignored records or garbage make none). */
  started: boolean;
  emitted: boolean;
  projectId: string;
  summary: GrokSummaryPayload | null;
  entryProjectId: string | null;
  minMs: number | null;
  maxMs: number | null;
  threads: Map<string, Thread>;
  /** Every live node as emitted. */
  nodes: Map<string, GraphNode>;
  calls: Map<string, Call>;
  /** Node id -> the call it shows. */
  callByNode: Map<string, Call>;
  /** Keys of calls removed by a rewind (a late update must not bring one back). */
  removedCalls: Set<string>;
  /** Child (agent) id -> the calls naming it, in the order they named it. */
  childCalls: Map<string, Call[]>;
  /** `_meta.eventId` + line hash of the lines applied (a repeated line changes nothing). */
  seenEvents: Set<string>;
  /** Runs whose text is not emitted yet. */
  pending: Set<Run>;
}

export class GrokNormalizer implements AgentNormalizer {
  private readonly sessions = new Map<string, SessionState>();
  private readonly restored = new Set<string>();

  apply(event: RawEvent, projectId: string): NormalizeResult {
    const r = this.applyBatch([{ event, projectId }]);
    const unknown = r.unknown[0];
    return unknown === undefined ? { changes: r.changes } : { changes: r.changes, unknownRecordType: unknown };
  }

  /** Records one by one; chunk texts and the session row are emitted once, at the end of the batch. */
  applyBatch(items: readonly BatchItem[]): BatchResult {
    const changes: Change[] = [];
    const unknown: (string | undefined)[] = [];
    const touched = new Set<SessionState>();
    for (const { event, projectId } of items) {
      unknown.push(undefined);
      if (event.source === 'hook') continue; // Grok Build has no hooks of ours
      try {
        const state = this.stateFor(event.sessionId, projectId);
        touched.add(state);
        unknown[unknown.length - 1] = event.source === 'meta' ? this.meta(state, event, projectId, changes) : this.record(state, event, projectId, changes);
      } catch {
        unknown[unknown.length - 1] = 'grok:normalizer-error';
      }
    }
    for (const state of touched) {
      try {
        this.flush(state, changes);
        if (state.started) this.commitSession(state, changes);
      } catch {
        unknown[unknown.length - 1] ??= 'grok:normalizer-error';
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

  /** Before the session exists only summary entries (or records that made no node) can be stored: re-applied. */
  restorePreSession(sessionId: string, events: Iterable<RawEvent>): void {
    this.dropSession(sessionId);
    for (const ev of events) {
      if (ev.sessionId !== sessionId) continue;
      this.apply(ev, ev.source !== 'hook' && ev.projectId != null ? ev.projectId : 'unknown');
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
        session: { id: sessionId, projectId, origin: 'grok', cwd: null, title: null, gitBranch: null, status: 'running', sourceDeleted: false, startedAt: EPOCH, lastActivityAt: EPOCH },
        started: false,
        emitted: false,
        projectId,
        summary: null,
        entryProjectId: null,
        minMs: null,
        maxMs: null,
        threads: new Map(),
        nodes: new Map(),
        calls: new Map(),
        callByNode: new Map(),
        removedCalls: new Set(),
        childCalls: new Map(),
        seenEvents: new Set(),
        pending: new Set(),
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private thread(state: SessionState, agentId: string | null, changes: Change[]): Thread {
    const key = agentId ?? MAIN;
    let t = state.threads.get(key);
    if (t === undefined) {
      t = { agentId, turns: [], current: null, byPrompt: new Map(), prev: null, prevTs: null, lastTs: null, first: null, run: null, firstTitled: null, linkedTo: null };
      state.threads.set(key, t);
      if (agentId !== null) this.relink(state, t, changes); // a dispatch naming it may have been read already
    }
    return t;
  }

  /** A summary entry (spec 5.2: title, cwd, model from summary.json). Other meta files are not this normalizer's. */
  private meta(state: SessionState, event: Extract<RawEvent, { source: 'meta' }>, projectId: string, changes: Change[]): string | undefined {
    if (!event.file.startsWith(GROK_SUMMARY_ENTRY_PREFIX) || event.agentId !== null) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.payload);
    } catch {
      return undefined; // damaged: as if missing
    }
    if (!isObject(parsed)) return undefined;
    const oldCwd = state.summary?.cwd ?? null;
    state.summary = {
      title: nonEmpty(parsed.title),
      summary: nonEmpty(parsed.summary),
      model: nonEmpty(parsed.model),
      cwd: nonEmpty(parsed.cwd),
      branch: nonEmpty(parsed.branch),
      createdAt: nonEmpty(parsed.createdAt),
    };
    if (projectId !== 'unknown') state.entryProjectId = projectId;
    // Files of calls read before the working directory was known are resolved against it now (once per change).
    if (state.summary.cwd !== oldCwd) for (const call of state.calls.values()) this.refreshCall(state, call, changes);
    return undefined;
  }

  // ---- records ----

  private record(state: SessionState, event: Extract<RawEvent, { source: 'transcript' }>, projectId: string, changes: Change[]): string | undefined {
    let rec: unknown;
    try {
      rec = JSON.parse(event.line);
    } catch {
      return 'grok:invalid-json';
    }
    if (!isObject(rec)) return 'grok:not-an-object';
    const hasMethod = 'method' in rec;
    const method = rec.method;
    if (hasMethod && method !== UPDATE && method !== EXT) return unknownTypeName('grok', method);
    // Legacy lines carry the notification itself, without an envelope (spec 5.2).
    const params = hasMethod ? (isObject(rec.params) ? rec.params : {}) : rec;
    const update = isObject(params.update) ? params.update : null;
    const meta = (key: string): string | null => (isObject(params._meta) ? nonEmpty(params._meta[key]) : null) ?? (update !== null && isObject(update._meta) ? nonEmpty(update._meta[key]) : null);

    const isExt = method === EXT;
    const type = isExt ? (nonEmpty(update?.sessionUpdate) ?? nonEmpty(update?.type) ?? nonEmpty(params.type)) : nonEmpty(update?.sessionUpdate);
    if (type === null) return unknownTypeName('grok', null);
    if (!isExt && IGNORED_UPDATES.has(type)) return undefined;
    const known = isExt ? isTurnCompleted(type) || /rewind/i.test(type) : type in CHUNKS || type === 'tool_call' || type === 'tool_call_update';
    if (!known) return unknownTypeName('grok', type);

    const t = this.thread(state, event.agentId, changes);
    const eventId = meta('eventId');
    if (eventId !== null) {
      // A line read before (same eventId and same content: appended twice) changes nothing. The content is part of the
      // key because whether an eventId is unique per line or shared by the chunks of one message is not known.
      const k = `${t.agentId ?? ''}\u0000${eventId.slice(0, 200)}\u0000${createHash('sha256').update(event.line).digest('hex').slice(0, 16)}`;
      if (state.seenEvents.has(k)) return undefined;
      state.seenEvents.add(own(k));
    }
    if (projectId !== 'unknown' && (event.agentId === null || state.projectId === 'unknown')) state.projectId = projectId;
    const ms = msOfTimestamp(rec.timestamp);
    const ts = ms === null ? null : isoOfMs(ms);
    if (ms !== null) {
      state.minMs = state.minMs === null ? ms : Math.min(state.minMs, ms);
      state.maxMs = state.maxMs === null ? ms : Math.max(state.maxMs, ms);
    }
    const rawPrompt = meta('promptId');
    const promptId = rawPrompt === null ? null : own(rawPrompt.slice(0, 200));
    let unknown: string | undefined;
    if (isExt) {
      const u = update ?? params;
      if (isTurnCompleted(type)) this.turnCompleted(state, t, u, params, promptId, changes);
      else unknown = this.rewindMarker(state, t, u, params, type, changes);
    } else if (type in CHUNKS) {
      this.chunk(state, t, CHUNKS[type]!, blockText(update!.content), ts, promptId, event.offset, changes);
    } else {
      this.toolRecord(state, t, update!, params, ts, promptId, event.offset, type === 'tool_call_update', changes);
    }
    if (ts !== null) t.lastTs = ts;
    return unknown;
  }

  // ---- turns and nodes ----

  /**
   * The turn a node of `t` read now belongs to, opening one when the record says a new turn starts. Nodes read before
   * any turn go to the thread's leading uncounted turn (turnId null).
   */
  private turnFor(state: SessionState, t: Thread, promptId: string | null, isUser: boolean, changes: Change[]): Turn {
    const cur = t.current;
    if (promptId !== null) {
      if (cur !== null && cur.counted && (cur.promptId === null || cur.promptId === promptId)) {
        if (cur.promptId === null) {
          cur.promptId = promptId;
          t.byPrompt.set(promptId, cur);
        }
        return cur;
      }
      return this.openTurn(state, t, promptId, true, changes);
    }
    if (isUser && !(t.run?.kind === 'user' && t.run.turn === cur)) return this.openTurn(state, t, null, true, changes);
    return cur ?? this.openTurn(state, t, null, false, changes);
  }

  private openTurn(state: SessionState, t: Thread, promptId: string | null, counted: boolean, changes: Change[]): Turn {
    this.closeRun(state, t, changes);
    const turn: Turn = { id: '', promptId, counted, nodes: [], lastReply: null, usageOn: null, title: undefined, removed: false };
    t.turns.push(turn);
    t.current = turn;
    if (promptId !== null) t.byPrompt.set(promptId, turn);
    return turn;
  }

  /** The node a thread's next node hangs off: its last node, else (agent thread) the dispatch it is linked to. */
  private parentOf(t: Thread): { from: string; kind: 'sequence' | 'spawn' } | null {
    if (t.prev !== null) return { from: t.prev, kind: 'sequence' };
    if (t.linkedTo === null || t.linkedTo.removed) return null;
    return { from: t.linkedTo.nodeId, kind: 'spawn' };
  }

  /** Adds a node at the end of thread `t` in `turn`, with the edge into it. */
  private addNode(state: SessionState, t: Thread, turn: Turn, node: Omit<GraphNode, 'sessionId' | 'turnId' | 'agentId' | 'parentId' | 'timestamp' | 'confirmed'>, ts: string | null, detail: Partial<NodeDetail>, changes: Change[]): GraphNode {
    if (!state.started) {
      state.started = true;
      this.commitSession(state, changes); // the session row before its first node
    }
    let id = node.id;
    for (let k = 1; state.nodes.has(id); k++) id = `${node.id}~${k}`; // a re-read file whose offsets repeat
    const holder = turn;
    if (holder.id === '') holder.id = id;
    const parent = this.parentOf(t);
    const timestamp = ts ?? t.prevTs ?? t.lastTs ?? EPOCH;
    const full: GraphNode = {
      ...node,
      id,
      sessionId: state.session.id,
      turnId: holder.counted ? holder.id : null,
      agentId: t.agentId,
      parentId: parent?.from ?? null,
      timestamp,
      confirmed: true,
    };
    state.nodes.set(id, full);
    holder.nodes.push(id);
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

  // ---- chunk runs ----

  private chunk(state: SessionState, t: Thread, kind: RunKind, text: string, ts: string | null, promptId: string | null, offset: number, changes: Change[]): void {
    if (text === '') return;
    const turn = this.turnFor(state, t, promptId, kind === 'user', changes);
    const run = t.run;
    if (run !== null && run.kind === kind && run.turn === turn && run.chars < GROK_RUN_MAX_CHARS) {
      run.text += text;
      run.chars += text.length;
      if (run.prefix.length < PREFIX_MAX) {
        run.prefix += text.slice(0, PREFIX_MAX - run.prefix.length);
        run.summary = null;
        if (run.titles) run.turn.title = promptTitle(run.prefix);
      }
      run.dirty = true;
      state.pending.add(run);
      return;
    }
    this.closeRun(state, t, changes);
    const prefix = text.slice(0, PREFIX_MAX);
    const summary = brief(prefix);
    const spec = kind === 'user' ? { kind: 'prompt' as const, title: 'Prompt' } : kind === 'agent' ? { kind: 'text' as const, title: 'Text' } : { kind: 'thinking' as const, title: 'Thinking' };
    const node = this.addNode(state, t, turn, { id: grokNodeId(state.session.id, t.agentId, `@${offset}`), childAgentId: null, kind: spec.kind, status: null, title: spec.title, summary, toolName: null, toolUseId: null, messageId: null, durationMs: null, endedAt: null, usage: null, systemSubtype: null }, ts, { text }, changes);
    const titles = kind === 'user' && turn.counted && turn.title === undefined;
    if (titles) {
      turn.title = promptTitle(prefix);
      t.firstTitled ??= turn;
    }
    if (kind === 'agent') turn.lastReply = node.id;
    t.run = { kind, nodeId: node.id, turn, text, chars: text.length, prefix, summary, dirty: false, titles };
  }

  /** Emits a run's text (whole) and summary when they changed since last emitted. */
  private emitRun(state: SessionState, run: Run, changes: Change[]): void {
    state.pending.delete(run);
    if (!run.dirty) return;
    run.dirty = false;
    const node = state.nodes.get(run.nodeId);
    if (node === undefined) return;
    run.summary ??= brief(run.prefix);
    this.update(state, { ...node, summary: run.summary }, changes, { text: run.text });
  }

  /** Ends the thread's open run (its pending text emitted now): the next chunk starts a node of its own. */
  private closeRun(state: SessionState, t: Thread, changes: Change[]): void {
    const run = t.run;
    if (run === null) return;
    t.run = null;
    if (run.dirty) this.emitRun(state, run, changes);
  }

  /** Emits every run's pending text (end of a batch). */
  private flush(state: SessionState, changes: Change[]): void {
    for (const run of [...state.pending]) this.emitRun(state, run, changes);
  }

  // ---- tool calls ----

  private toolRecord(state: SessionState, t: Thread, u: Obj, params: Obj, ts: string | null, promptId: string | null, offset: number, isUpdate: boolean, changes: Change[]): void {
    const rawId = nonEmpty(u.toolCallId);
    const toolCallId = rawId === null ? null : own(rawId.slice(0, 200));
    const key = toolCallId !== null ? `${t.agentId ?? ''}\u0000${toolCallId}` : `${t.agentId ?? ''}\u0000@${offset}`;
    if (state.removedCalls.has(key)) {
      if (isUpdate) return; // a late update of a call a rewind removed
      state.removedCalls.delete(key);
    }
    let call = state.calls.get(key);
    if (call === undefined) {
      const turn = this.turnFor(state, t, promptId, false, changes);
      this.closeRun(state, t, changes);
      const nodeId = grokNodeId(state.session.id, t.agentId, toolCallId !== null ? `call:${toolCallId}` : `@${offset}`);
      const node = this.addNode(state, t, turn, { id: nodeId, childAgentId: null, kind: 'tool', status: 'running', title: 'tool', summary: '', toolName: null, toolUseId: toolCallId, messageId: null, durationMs: null, endedAt: null, usage: null, systemSubtype: null }, ts, {}, changes);
      call = { key, nodeId: node.id, toolCallId, thread: t, name: null, kind: null, acpTitle: null, status: 'running', endedAt: null, pathArgs: {}, patchFiles: [], locations: [], inputKey: undefined, argSummary: '', argAgent: null, childIds: [], removed: false };
      state.calls.set(key, call);
      state.callByNode.set(call.nodeId, call);
    }
    const metaOf = (o: unknown): Obj | null => (isObject(o) && isObject(o._meta) ? o._meta : null);
    const name = nonEmpty(metaOf(u)?.toolName) ?? nonEmpty(metaOf(u)?.tool_name) ?? nonEmpty(metaOf(params)?.toolName) ?? nonEmpty(metaOf(params)?.tool_name) ?? nonEmpty(u.toolName) ?? nonEmpty(u.tool_name);
    if (name !== null) call.name = brief(name);
    const kind = nonEmpty(u.kind);
    if (kind !== null) call.kind = brief(kind);
    const title = nonEmpty(u.title);
    if (title !== null) call.acpTitle = brief(title);
    const status = callStatus(u.status);
    if (status !== null && !(status === 'running' && call.status !== 'running')) {
      call.status = status;
      if (status !== 'running') call.endedAt ??= ts ?? t.lastTs ?? state.nodes.get(call.nodeId)?.timestamp ?? EPOCH;
    }
    if (Array.isArray(u.locations) && isObject(u.locations[0]) && typeof u.locations[0].path === 'string') call.locations = [{ path: own(u.locations[0].path.slice(0, PATH_MAX_CHARS)) }];
    const detail: Partial<NodeDetail> = {};
    const input = u.rawInput;
    if (input !== undefined && input !== null) {
      detail.input = input;
      call.pathArgs = {};
      if (isObject(input)) for (const k of PATH_KEYS) if (typeof input[k] === 'string') call.pathArgs[k] = own((input[k] as string).slice(0, PATH_MAX_CHARS));
      call.patchFiles = patchTouches(input).slice(0, MAX_TOUCHES).map((x) => ({ path: own(x.path.slice(0, PATH_MAX_CHARS)), action: x.action }));
      call.inputKey = inputKeyOf(call.name ?? call.kind, input);
      call.argSummary = toolSummary(input);
      const agent = isObject(input) ? (nonEmpty(input.subagent_type) ?? nonEmpty(input.agent_type)) : null;
      call.argAgent = agent === null ? null : brief(agent);
    }
    const text = contentText(u.content);
    if (text !== null) detail.output = text;
    else if (u.rawOutput !== undefined && u.rawOutput !== null) detail.output = u.rawOutput;
    const named = [...childIdsIn(u.rawOutput), ...childIdsIn(metaOf(u))];
    this.refreshCall(state, call, changes, Object.keys(detail).length > 0 ? detail : undefined);
    for (const id of named) this.nameChild(state, call, id, changes);
  }

  /** The call's node as its state says, emitted where it differs (with `detail` merged into the stored one). */
  private refreshCall(state: SessionState, call: Call, changes: Change[], detail?: Partial<NodeDetail>): void {
    if (call.removed) return;
    const old = state.nodes.get(call.nodeId);
    if (old === undefined) return;
    const category = grokToolCategory(call.name, call.kind);
    const childAgentId = call.childIds.find((id) => state.threads.get(id)?.linkedTo === call) ?? null;
    const subagent = category === 'subagent' || childAgentId !== null;
    const files = nodeFiles(this.touches(call), state.summary?.cwd ?? null);
    const durationMs = call.endedAt === null ? null : Math.max(0, Date.parse(call.endedAt) - Date.parse(old.timestamp)) || 0;
    const next: GraphNode = {
      ...old,
      files: undefined,
      filesTruncated: undefined,
      kind: subagent ? 'subagent' : 'tool',
      title: subagent ? (call.argAgent ?? call.name ?? call.acpTitle ?? call.kind ?? 'task') : (call.name ?? call.acpTitle ?? call.kind ?? 'tool'),
      summary: call.argSummary !== '' ? call.argSummary : (call.acpTitle ?? ''),
      status: call.status,
      toolName: call.name ?? call.kind,
      toolUseId: call.toolCallId,
      childAgentId,
      endedAt: call.endedAt,
      durationMs,
      ...filesFields(files),
      ...inputKeyFields(call.inputKey),
    };
    this.update(state, next, changes, detail);
  }

  /** The files a call names (spec 5.2 order: path arguments, a patch's files, the first location). */
  private touches(call: Call): RawTouch[] {
    const fromArgs = grokTouches(call.name, call.kind, call.pathArgs, null);
    if (fromArgs.length > 0) return fromArgs;
    if (call.name === 'apply_patch' && call.patchFiles.length > 0) return call.patchFiles;
    return grokTouches(call.name, call.kind, null, call.locations);
  }

  // ---- subagent threads ----

  /** A call named a subagent session id: it is a link candidate of that thread. */
  private nameChild(state: SessionState, call: Call, childId: string, changes: Change[]): void {
    if (call.childIds.includes(childId) || call.childIds.length >= MAX_CHILD_IDS || childId === call.thread.agentId) return;
    call.childIds.push(own(childId));
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

  // ---- extension records ----

  private turnCompleted(state: SessionState, t: Thread, u: Obj, params: Obj, promptId: string | null, changes: Change[]): void {
    this.closeRun(state, t, changes);
    const usage = usageOf(u.usage) ?? usageOf(params.usage);
    if (usage === null) return;
    const pid = nonEmpty(u.prompt_id) ?? nonEmpty(u.promptId) ?? nonEmpty(params.prompt_id) ?? nonEmpty(params.promptId) ?? promptId;
    const turn = (pid !== null ? t.byPrompt.get(pid) : undefined) ?? t.current;
    if (turn === null || turn === undefined || turn.removed) return;
    const holder = turn.lastReply ?? turn.nodes[turn.nodes.length - 1] ?? null;
    if (holder === null) return;
    // Set, never added: a repeated or re-sent completion counts once; a later reply of the turn takes the usage over.
    if (turn.usageOn !== null && turn.usageOn !== holder) {
      const prev = state.nodes.get(turn.usageOn);
      if (prev !== undefined) this.update(state, { ...prev, usage: null }, changes);
    }
    const node = state.nodes.get(holder);
    if (node === undefined) return;
    turn.usageOn = holder;
    this.update(state, { ...node, usage }, changes);
  }

  /** A rewind marker: removes the turns from `target_prompt_index` on; without an index nothing, reported. */
  private rewindMarker(state: SessionState, t: Thread, u: Obj, params: Obj, type: string, changes: Change[]): string | undefined {
    const raw = u.target_prompt_index ?? u.targetPromptIndex ?? params.target_prompt_index ?? params.targetPromptIndex;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return unknownTypeName('grok', type);
    this.closeRun(state, t, changes);
    const lead = t.turns[0]?.counted === false ? 1 : 0;
    const from = lead + raw;
    if (from >= t.turns.length) return undefined;
    const gone = t.turns.splice(from);
    const affected = new Set<Thread>();
    for (const turn of gone) {
      turn.removed = true;
      if (turn.promptId !== null && t.byPrompt.get(turn.promptId) === turn) t.byPrompt.delete(turn.promptId);
      for (const id of turn.nodes) this.removeNode(state, id, affected, changes);
    }
    t.current = t.turns[t.turns.length - 1] ?? null;
    // Every turn has a node (a turn opens with the node that needs it): the last one's last node is the thread's last.
    let lastTurn: Turn | undefined;
    for (let i = t.turns.length - 1; i >= 0 && lastTurn === undefined; i--) if (t.turns[i]!.nodes.length > 0) lastTurn = t.turns[i];
    t.prev = lastTurn === undefined ? null : lastTurn.nodes[lastTurn.nodes.length - 1]!;
    t.prevTs = t.prev === null ? null : (state.nodes.get(t.prev)?.timestamp ?? null);
    if (t.first !== null && !state.nodes.has(t.first)) t.first = t.turns.find((x) => x.nodes.length > 0)?.nodes[0] ?? null;
    // A rewind removes a suffix of turns: a titled turn before the removed first titled one cannot exist.
    if (t.firstTitled?.removed === true) t.firstTitled = null;
    for (const child of affected) this.relink(state, child, changes);
    return undefined;
  }

  /** Removes one node (the store drops its detail, search entry and edges); a call's node takes the call with it. */
  private removeNode(state: SessionState, id: string, affected: Set<Thread>, changes: Change[]): void {
    if (!state.nodes.delete(id)) return;
    changes.push({ type: 'node_removed', sessionId: state.session.id, id });
    for (const run of state.pending) if (run.nodeId === id) state.pending.delete(run);
    const call = state.callByNode.get(id);
    if (call === undefined) return;
    call.removed = true;
    state.callByNode.delete(id);
    state.calls.delete(call.key);
    state.removedCalls.add(call.key);
    for (const childId of call.childIds) {
      const child = state.threads.get(childId);
      if (child !== undefined && child.linkedTo === call) affected.add(child);
    }
  }

  // ---- session ----

  /**
   * The session as a function of what was read: title = summary.json's generated_title, else session_summary, else the
   * main thread's first prompt; project, cwd and branch from the summary entry, else the records' project; started =
   * summary created_at, else the earliest line time; status running (no end record: spec 4.5 turns a quiet session
   * idle in the display).
   */
  private commitSession(state: SessionState, changes: Change[]): void {
    const s = state.summary;
    const main = state.threads.get(MAIN);
    const firstPrompt = main?.firstTitled?.title ?? null;
    const startedAt = s?.createdAt ?? (state.minMs === null ? EPOCH : isoOfMs(state.minMs));
    const lastMs = Math.max(state.maxMs ?? Number.NEGATIVE_INFINITY, Date.parse(startedAt));
    const next: Session = {
      ...state.session,
      projectId: state.entryProjectId ?? state.projectId,
      cwd: s?.cwd ?? null,
      title: s?.title ?? s?.summary ?? firstPrompt,
      gitBranch: s?.branch ?? null,
      status: 'running',
      startedAt,
      lastActivityAt: isoOfMs(lastMs),
    };
    const cur = state.session;
    const same =
      cur.projectId === next.projectId &&
      cur.cwd === next.cwd &&
      cur.title === next.title &&
      cur.gitBranch === next.gitBranch &&
      cur.status === next.status &&
      cur.startedAt === next.startedAt &&
      cur.lastActivityAt === next.lastActivityAt;
    if (same && state.emitted) return;
    state.emitted = true;
    state.session = next;
    changes.push({ type: 'session_upserted', session: next });
  }
}

const isTurnCompleted = (type: string): boolean => type.replace(/[^a-z]/gi, '').toLowerCase() === 'turncompleted';

/** Session ids a dispatch's output or `_meta` names (CHILD_ID_KEYS at the top level or one level down). */
function childIdsIn(v: unknown): string[] {
  if (!isObject(v)) return [];
  const out: string[] = [];
  const take = (o: Obj): void => {
    for (const k of CHILD_ID_KEYS) {
      const id = nonEmpty(o[k]);
      if (id !== null && id.length <= 200 && !out.includes(id)) out.push(id);
    }
  };
  take(v);
  for (const inner of Object.values(v)) if (isObject(inner)) take(inner);
  return out.slice(0, MAX_CHILD_IDS);
}

/** Files of an `apply_patch` input: the patch text itself, or its `input` / `patch` argument. */
function patchTouches(input: unknown): RawTouch[] {
  if (typeof input === 'string') return applyPatchTouches(input);
  if (!isObject(input)) return [];
  for (const k of ['input', 'patch']) {
    const v = str(input[k]);
    if (v !== null) {
      const t = applyPatchTouches(v);
      if (t.length > 0) return t;
    }
  }
  return [];
}
