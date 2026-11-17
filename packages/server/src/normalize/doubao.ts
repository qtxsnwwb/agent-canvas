import { createHash } from 'node:crypto';
import type { Change, GraphNode, NodeDetail, Session } from '@agent-canvas/shared';
import { parseAssignment, stripReminders } from '../sources/doubao/assignment.js';
import { DOUBAO_PROJECT } from '../sources/doubao/source.js';
import type { RawEvent } from '../store/store.js';
import { promptTitle } from './codex.js';
import { doubaoTouches, filesFields, nodeFiles, type RawTouch } from './files.js';
import { nodePatch } from './gemini.js';
import { inputKeyFields, inputKeyOf } from './input-key.js';
import { summarize } from './summary.js';
import type { AgentNormalizer, BatchItem, BatchResult, NormalizeResult } from './types.js';
import { unknownTypeName } from './unknown-type.js';

/*
 * The Doubao Work (豆包工作) normalizer (spec 5, docs/formats/doubao-work.md A2-A4). A conversation is a session; its
 * main agent's `trajectory.jsonl` is the main thread, every other agent's an agent thread (agentId = the agent's
 * directory). Rows are `{role, content, tool_calls?, tool_call_id?}` with no id, time, model, usage or directory: a row
 * is its byte offset in the file. The reader puts one synthetic line `{"__agentCanvas":"file","mtimeMs":n}` at offset
 * -1 whenever it reads a file from its start, and one at the byte before the first row of every later read that
 * delivers rows (the file's modification time then: the session's last activity, never a node time); each agent's
 * `assignment.md` arrives whole as a meta event, as often as it
 * changed. Nothing of a row's content is kept after it was applied: a thread keeps ids, counters, demand times and its
 * first demand (text at most 64 KiB, for the `demand0` node's detail).
 *
 * Node ids: `doubao:<session id>[/<agent id>]:<part>` — `@<offset>` for a prompt or a reply, `call:<tool call id>` for a
 * tool call, `demand0` for the prompt made from the first demand of assignment.md when the thread has no user row for
 * it (format reference A3).
 *
 * Turns (spec 5.3): each prompt opens one. When the thread's first meaningful row is not a prompt, the first turn is the
 * first demand's (made visible by the `demand0` node once assignment.md is read) and the prompts open turns 1, 2, …;
 * otherwise they open 0, 1, …. Every node of turn n has the time of demand n of the thread's own assignment.md, else
 * (no such demand, or its time does not parse) the file's modification time from the synthetic line, else the epoch.
 * Times, turn ids and the `demand0` node are kept as functions of what was read, so the rows and the assignment may
 * arrive in either order with the same result.
 *
 * A row at or before the last offset read of its thread means the file is read again from its start (the source found
 * it rewritten): what the thread's rows made is removed and the thread is rebuilt from the new rows.
 *
 * Subagent link (spec 5.4): a `create_agent` call whose result starts with `create_agent ok` and names, one per line,
 * `agent_id`, `parent_id` (`main_agent` from the main agent, else the caller's own id) and a numeric `thread_id`. The
 * child's thread hangs off the first live call naming it; a result that does not parse leaves it unlinked.
 */

const EPOCH = '1970-01-01T00:00:00.000Z';
const MAIN = '';
const ORIGIN = 'doubao';
const P0 = 'demand0';
const CREATE_AGENT = 'create_agent';
const CREATE_OK = 'create_agent ok\n';
const AGENT_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const THREAD_ID = /^\d{1,30}$/;
const SUMMARY_KEYS = ['command', 'file_path', 'path', 'filePath', 'file', 'pattern', 'query', 'url', 'subtask', 'description', 'prompt'];
/** Characters of a text kept for its summary / prompt title (the head of the text). */
const PREFIX_MAX = 2048;
const ID_MAX = 200;
const PATH_MAX_CHARS = 4096;
const MAX_TOUCHES = 64;
const MAX_CHILD_IDS = 8;
const MAX_MS = 8.64e15;

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const isoOfMs = (ms: number): string => new Date(ms).toISOString();
/** A copy of `s` sharing no memory with the string it was cut from (see grok.ts `own`): nothing of a row is retained. */
const own = (s: string): string => (' ' + s).slice(1);
const ownId = (s: string): string => own(s.slice(0, ID_MAX));
const brief = (v: unknown): string => own(summarize(typeof v === 'string' ? head(v, PREFIX_MAX) : v));
const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');

/** A synthetic line of the reader, `{"__agentCanvas":"file","mtimeMs":n}` (a row always has a `role`). */
const isFileLine = (rec: unknown): rec is Obj => isObject(rec) && rec.__agentCanvas === 'file' && !('role' in rec);
/** The modification time a synthetic line carries, or null when it is not one or the time is unusable. */
const fileLineMs = (rec: unknown): number | null =>
  isFileLine(rec) && typeof rec.mtimeMs === 'number' && Number.isFinite(rec.mtimeMs) && Math.abs(rec.mtimeMs) <= MAX_MS ? Math.floor(rec.mtimeMs) : null;

/** The id of a Doubao node: `doubao:<session id>[/<agent id>]:<part>`. */
export function doubaoNodeId(sessionId: string, agentId: string | null, part: string): string {
  return `doubao:${sessionId}${agentId === null ? '' : `/${agentId}`}:${part}`;
}

/** The first `n` UTF-16 units of `s`, one fewer when the cut would split a surrogate pair. */
function head(s: string, n: number): string {
  if (s.length <= n) return s;
  const code = s.charCodeAt(n - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
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

/** The agent directory a store key names (`doubao:<label>/<profile>/<ns>/<conv>/<agent>/<file>`), or null. */
function dirOfKey(key: string): string | null {
  const parts = key.split('/');
  return parts.length >= 2 ? own(parts[parts.length - 2]!) : null;
}

/** A tool call's state: never its arguments or output (they go out in the node's detail). */
interface Call {
  nodeId: string;
  callId: string;
  thread: Thread;
  /** The turn the call was made in (its node's time). */
  turn: number;
  name: string | null;
  done: boolean;
  inputKey: string | undefined;
  argSummary: string;
  touches: RawTouch[];
  /** Agent ids of the threads this call created (its `create_agent ok` result). */
  childIds: string[];
  removed: boolean;
}

/**
 * The first demand of an assignment.md, kept to make or remake the `demand0` node: its full text (at most
 * DOUBAO_DEMAND_MAX_BYTES and a cut mark, the parser cuts longer ones) so the node's detail is the same in every arrival order and
 * after a rewrite, and its summary, title and SHA-1.
 */
interface FirstDemand {
  text: string;
  hash: string;
  summary: string;
  title: string | null;
}

interface Thread {
  agentId: string | null;
  /** The agent's directory name (the main agent's too): what a `create_agent` result must not name as the child. */
  dirId: string | null;
  /** Offset of the latest row read (one at or before it: the file is read again from its start). */
  lastOffset: number;
  /** The file's modification time from the synthetic line read with the file's start (offset -1): node times' fallback. */
  mtimeMs: number | null;
  /**
   * The latest modification time of every synthetic line of this generation (the reader puts one before each read
   * that delivers rows): the thread's last activity. Never a node time.
   */
  fileMs: number | null;
  /** The demand times of the latest assignment.md (null: not parseable); null when none was read. */
  demands: (number | null)[] | null;
  first: FirstDemand | null;
  /** The `demand0` node is shown. */
  p0: boolean;
  /** SHA-1 of the text the `demand0` node's detail carries. */
  p0Hash: string | null;
  /** Whether the first meaningful row was not a prompt (null: none read yet). */
  implicit: boolean | null;
  /** Prompt rows read. */
  prompts: number;
  /** The current turn (-1: none). */
  turn: number;
  /** Every live node of the thread, in order (`demand0` first when shown). */
  seq: string[];
  turnOf: Map<string, number>;
  /** The first row node of each turn. */
  rowFirst: (string | undefined)[];
  /** The highest turn with a node (-1: none). */
  maxTurn: number;
  /** Title of the first prompt row. */
  firstPromptTitle: string | null;
  /** Tool call id -> the calls with that id, in order. */
  calls: Map<string, Call[]>;
  linkedTo: Call | null;
  /** Earliest / latest known node time (ms); recomputed when `timesDirty`. */
  minMs: number | null;
  maxMs: number | null;
  timesDirty: boolean;
}

interface SessionState {
  session: Session;
  started: boolean;
  emitted: boolean;
  projectId: string;
  threads: Map<string, Thread>;
  nodes: Map<string, GraphNode>;
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

/** The child a `create_agent` result names (format reference A4), or null when it does not parse. */
function createdAgent(content: string, caller: Thread): string | null {
  if (!content.startsWith(CREATE_OK)) return null;
  const field = (name: string): string | null => new RegExp(`^${name}: ([a-zA-Z0-9_-]+)$`, 'm').exec(content)?.[1] ?? null;
  const agent = field('agent_id');
  if (agent === null || !AGENT_ID.test(agent) || agent === caller.dirId) return null;
  if (field('parent_id') !== (caller.agentId === null ? 'main_agent' : caller.dirId)) return null;
  const threadId = field('thread_id');
  if (threadId === null || !THREAD_ID.test(threadId)) return null;
  return own(agent);
}

export class DoubaoNormalizer implements AgentNormalizer {
  private readonly sessions = new Map<string, SessionState>();
  private readonly restored = new Set<string>();

  apply(event: RawEvent, projectId: string): NormalizeResult {
    const r = this.applyBatch([{ event, projectId }]);
    const unknown = r.unknown[0];
    return unknown === undefined ? { changes: r.changes } : { changes: r.changes, unknownRecordType: unknown };
  }

  /** Events one by one; the session row is emitted once, at the end of the batch. */
  applyBatch(items: readonly BatchItem[]): BatchResult {
    const changes: Change[] = [];
    const unknown: (string | undefined)[] = [];
    const touched = new Set<SessionState>();
    for (const { event, projectId } of items) {
      unknown.push(undefined);
      if (event.source === 'hook') continue;
      try {
        const state = this.stateFor(event.sessionId, projectId);
        touched.add(state);
        unknown[unknown.length - 1] = event.source === 'meta' ? this.assignment(state, event, changes) : this.record(state, event, changes);
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

  /** Before the session exists only events that made nothing can be stored (synthetic lines, an empty assignment): re-applied. */
  restorePreSession(sessionId: string, events: Iterable<RawEvent>): void {
    this.dropSession(sessionId);
    for (const ev of events) {
      if (ev.sessionId !== sessionId || ev.source === 'hook') continue;
      this.apply(ev, ev.projectId != null ? ev.projectId : DOUBAO_PROJECT);
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
        callByNode: new Map(),
        childCalls: new Map(),
      };
      this.sessions.set(sessionId, state);
    }
    if (projectId !== 'unknown') state.projectId = projectId;
    return state;
  }

  private thread(state: SessionState, agentId: string | null, file: string, changes: Change[]): Thread {
    const key = agentId ?? MAIN;
    let t = state.threads.get(key);
    if (t === undefined) {
      t = {
        agentId,
        dirId: dirOfKey(file),
        lastOffset: Number.NEGATIVE_INFINITY,
        mtimeMs: null,
        fileMs: null,
        demands: null,
        first: null,
        p0: false,
        p0Hash: null,
        implicit: null,
        prompts: 0,
        turn: -1,
        seq: [],
        turnOf: new Map(),
        rowFirst: [],
        maxTurn: -1,
        firstPromptTitle: null,
        calls: new Map(),
        linkedTo: null,
        minMs: null,
        maxMs: null,
        timesDirty: false,
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

  // ---- times and turns ----

  /** The time of turn `k` of thread `t` (spec 5.3): its demand's, else the file's modification time, else the epoch. */
  private timeOf(t: Thread, k: number): string {
    const d = t.demands?.[k];
    const ms = typeof d === 'number' ? d : t.mtimeMs;
    return ms === null || !Number.isFinite(ms) || Math.abs(ms) > MAX_MS ? EPOCH : isoOfMs(ms);
  }

  private turnIdOf(t: Thread, k: number, state: SessionState): string | null {
    if (k === 0 && t.p0) return this.p0Id(state, t);
    return t.rowFirst[k] ?? null;
  }

  private p0Id(state: SessionState, t: Thread): string {
    return doubaoNodeId(state.session.id, t.agentId, P0);
  }

  /** Every node of the thread with its turn's time and turn id (after the demands, the file time or `demand0` changed). */
  private refreshThread(state: SessionState, t: Thread, changes: Change[]): void {
    t.timesDirty = true;
    for (const id of t.seq) {
      const node = state.nodes.get(id);
      const k = t.turnOf.get(id);
      if (node === undefined || k === undefined) continue;
      const call = state.callByNode.get(id);
      const timestamp = this.timeOf(t, k);
      this.update(state, { ...node, timestamp, turnId: this.turnIdOf(t, k, state), ...(call !== undefined ? { endedAt: call.done ? timestamp : null } : {}) }, changes);
    }
  }

  // ---- nodes ----

  /** The node a thread's first node hangs off: the call it is linked to. */
  private linkOf(t: Thread): string | null {
    return t.linkedTo === null || t.linkedTo.removed ? null : t.linkedTo.nodeId;
  }

  /** Adds a row's node at the end of thread `t`, in turn `k`, with the edge into it. */
  private addNode(state: SessionState, t: Thread, k: number, node: NodeSpec, detail: Partial<NodeDetail>, changes: Change[]): GraphNode {
    this.start(state, changes);
    let id = node.id;
    for (let n = 1; state.nodes.has(id); n++) id = `${node.id}~${n}`;
    if (t.rowFirst[k] === undefined) t.rowFirst[k] = id;
    const prev = t.seq[t.seq.length - 1];
    const parent = prev !== undefined ? { from: prev, kind: 'sequence' as const } : this.linkOf(t) !== null ? { from: this.linkOf(t)!, kind: 'spawn' as const } : null;
    const full: GraphNode = { ...node, id, sessionId: state.session.id, turnId: this.turnIdOf(t, k, state), agentId: t.agentId, parentId: parent?.from ?? null, timestamp: this.timeOf(t, k), confirmed: true };
    state.nodes.set(id, full);
    t.seq.push(id);
    t.turnOf.set(id, k);
    if (k > t.maxTurn) {
      t.maxTurn = k;
      t.timesDirty = true;
    }
    changes.push({ type: 'node_added', node: full, detail });
    if (parent !== null) changes.push({ type: 'edge_added', edge: { id: `${parent.from}->${id}`, sessionId: state.session.id, from: parent.from, to: id, kind: parent.kind } });
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

  /** Sets the parent of the thread's first node (removing the old edge when its parent is still there). */
  private reparentFirst(state: SessionState, t: Thread, parent: string | null, kind: 'sequence' | 'spawn', oldParentLive: boolean, changes: Change[]): void {
    const first = t.seq[0];
    if (first === undefined) return;
    const node = state.nodes.get(first);
    if (node === undefined || node.parentId === parent) return;
    const sid = state.session.id;
    if (node.parentId !== null && oldParentLive) changes.push({ type: 'edge_removed', sessionId: sid, id: `${node.parentId}->${first}` });
    this.update(state, { ...node, parentId: parent }, changes);
    if (parent !== null) changes.push({ type: 'edge_added', edge: { id: `${parent}->${first}`, sessionId: sid, from: parent, to: first, kind } });
  }

  // ---- the first demand (format reference A3) ----

  /**
   * Shows the `demand0` node exactly when the thread has a first demand and its first meaningful row is not a prompt
   * (or none was read yet), with the kept first demand's text as its detail.
   */
  private syncP0(state: SessionState, t: Thread, changes: Change[]): void {
    const want = t.first !== null && t.implicit !== false;
    if (want && !t.p0) {
      this.insertP0(state, t, changes);
    } else if (want && t.p0 && t.first!.hash !== t.p0Hash) {
      const node = state.nodes.get(this.p0Id(state, t));
      if (node !== undefined) this.update(state, { ...node, summary: t.first!.summary }, changes, { text: t.first!.text });
      t.p0Hash = t.first!.hash;
    } else if (!want && t.p0) {
      this.removeP0(state, t, changes);
    }
  }

  private insertP0(state: SessionState, t: Thread, changes: Change[]): void {
    this.start(state, changes);
    const id = this.p0Id(state, t);
    const link = this.linkOf(t);
    const old = t.seq[0] !== undefined ? state.nodes.get(t.seq[0]) : undefined;
    t.p0 = true;
    t.p0Hash = t.first!.hash;
    const full: GraphNode = { ...blankNode(id, 'prompt', 'Prompt', t.first!.summary), id, sessionId: state.session.id, turnId: id, agentId: t.agentId, parentId: link, timestamp: this.timeOf(t, 0), confirmed: true };
    state.nodes.set(id, full);
    changes.push({ type: 'node_added', node: full, detail: { text: t.first!.text } });
    if (link !== null) changes.push({ type: 'edge_added', edge: { id: `${link}->${id}`, sessionId: state.session.id, from: link, to: id, kind: 'spawn' } });
    if (old !== undefined) {
      // The thread's former first node now follows the demand.
      if (old.parentId !== null) changes.push({ type: 'edge_removed', sessionId: state.session.id, id: `${old.parentId}->${old.id}` });
      this.update(state, { ...old, parentId: id }, changes);
      changes.push({ type: 'edge_added', edge: { id: `${id}->${old.id}`, sessionId: state.session.id, from: id, to: old.id, kind: 'sequence' } });
    }
    t.seq.unshift(id);
    t.turnOf.set(id, 0);
    if (t.maxTurn < 0) t.maxTurn = 0;
    this.refreshThread(state, t, changes);
  }

  private removeP0(state: SessionState, t: Thread, changes: Change[]): void {
    const id = this.p0Id(state, t);
    t.p0 = false;
    t.p0Hash = null;
    if (state.nodes.delete(id)) changes.push({ type: 'node_removed', sessionId: state.session.id, id });
    t.seq = t.seq.filter((x) => x !== id);
    t.turnOf.delete(id);
    if (t.seq.length === 0) t.maxTurn = -1;
    // The store dropped the removed node's edges: the next first node hangs off the link, if any.
    this.reparentFirst(state, t, this.linkOf(t), 'spawn', false, changes);
    this.refreshThread(state, t, changes);
  }

  // ---- assignment.md ----

  /** An agent's assignment.md, whole: its demand times, its first demand, then every node's time again. */
  private assignment(state: SessionState, event: Extract<RawEvent, { source: 'meta' }>, changes: Change[]): string | undefined {
    const t = this.thread(state, event.agentId, event.file, changes);
    const demands = parseAssignment(event.payload);
    t.demands = demands.map((d) => d.at);
    const first = demands[0];
    if (first === undefined) t.first = null;
    else {
      const title = promptTitle(head(first.text, PREFIX_MAX));
      t.first = { text: own(first.text), hash: sha1(first.text), summary: brief(first.text), title: title === null ? null : own(title) };
    }
    this.syncP0(state, t, changes);
    this.refreshThread(state, t, changes);
    return undefined;
  }

  // ---- rows ----

  private record(state: SessionState, event: Extract<RawEvent, { source: 'transcript' }>, changes: Change[]): string | undefined {
    const t = this.thread(state, event.agentId, event.file, changes);
    if (event.offset <= t.lastOffset) this.resetThread(state, t, changes);
    t.lastOffset = event.offset;
    let rec: unknown;
    try {
      rec = JSON.parse(event.line);
    } catch {
      return event.offset < 0 ? undefined : `${ORIGIN}:invalid-json`;
    }
    if (event.offset < 0) {
      // The reader's synthetic line read with the file's start: the modification time then, the node times' fallback.
      const ms = fileLineMs(rec);
      if (ms !== null) {
        t.mtimeMs = ms;
        this.noteFileMs(t, ms);
        this.refreshThread(state, t, changes);
      }
      return undefined;
    }
    // The reader's synthetic line before a later read that delivered rows (at the byte before them): the modification
    // time then, the thread's last activity only. Not a row: no node, not unknown.
    if (isFileLine(rec)) {
      const ms = fileLineMs(rec);
      if (ms !== null) this.noteFileMs(t, ms);
      return undefined;
    }
    if (!isObject(rec)) return `${ORIGIN}:not-an-object`;
    const role = rec.role;
    switch (role) {
      case 'user': {
        if (typeof rec.content !== 'string') return `${ORIGIN}:content/user`;
        const text = stripReminders(rec.content);
        if (text.trim() === '') return undefined; // injected only: no prompt
        this.prompt(state, t, text, event.offset, changes);
        return undefined;
      }
      case 'assistant': {
        const calls = Array.isArray(rec.tool_calls) ? rec.tool_calls : [];
        const content = rec.content;
        if (typeof content !== 'string' && !((content === undefined || content === null) && calls.length > 0)) return `${ORIGIN}:content/assistant`;
        this.assistant(state, t, typeof content === 'string' ? content : '', calls, event.offset, changes);
        return undefined;
      }
      case 'tool': {
        const callId = nonEmpty(rec.tool_call_id);
        if (callId === null) return `${ORIGIN}:tool/no-call-id`;
        if (typeof rec.content !== 'string') return `${ORIGIN}:content/tool`;
        this.toolResult(state, t, ownId(callId), rec.content, changes);
        return undefined;
      }
      default:
        return typeof role === 'string' ? unknownTypeName(ORIGIN, `role/${role}`) : `${ORIGIN}:role/?`;
    }
  }

  /** A synthetic line's modification time: the thread's last activity is the latest one. */
  private noteFileMs(t: Thread, ms: number): void {
    t.fileMs = t.fileMs === null ? ms : Math.max(t.fileMs, ms);
  }

  /** The thread's first meaningful row decides whether its first turn is the first demand's (no user row for it). */
  private meaningful(state: SessionState, t: Thread, isPrompt: boolean, changes: Change[]): void {
    if (t.implicit !== null) return;
    t.implicit = !isPrompt;
    if (t.implicit) t.turn = 0;
    this.syncP0(state, t, changes);
  }

  private prompt(state: SessionState, t: Thread, text: string, offset: number, changes: Change[]): void {
    this.meaningful(state, t, true, changes);
    const k = t.prompts + (t.implicit === true ? 1 : 0);
    t.prompts += 1;
    t.turn = k;
    this.addNode(state, t, k, blankNode(doubaoNodeId(state.session.id, t.agentId, `@${offset}`), 'prompt', 'Prompt', brief(text)), { text }, changes);
    if (t.firstPromptTitle === null) {
      const title = promptTitle(head(text, PREFIX_MAX));
      if (title !== null) t.firstPromptTitle = own(title);
    }
  }

  /** An assistant row: its text (when not empty) as a reply, then each tool call in order. */
  private assistant(state: SessionState, t: Thread, content: string, calls: unknown[], offset: number, changes: Change[]): void {
    this.meaningful(state, t, false, changes);
    const k = t.turn;
    if (content.trim() !== '') this.addNode(state, t, k, blankNode(doubaoNodeId(state.session.id, t.agentId, `@${offset}`), 'text', 'Text', brief(content)), { text: content }, changes);
    for (const entry of calls) {
      if (!isObject(entry)) continue;
      const rawId = nonEmpty(entry.id);
      if (rawId === null) continue;
      const fn = isObject(entry.function) ? entry.function : {};
      const name = nonEmpty(fn.name);
      const call = this.newCall(state, t, ownId(rawId), name === null ? null : brief(name), changes);
      let input: unknown = fn.arguments;
      if (typeof input === 'string') {
        try {
          input = JSON.parse(input);
        } catch {
          // shown as the string it is
        }
      }
      const detail: Partial<NodeDetail> = {};
      if (fn.arguments !== undefined) {
        detail.input = input;
        call.inputKey = inputKeyOf(call.name, input);
        call.argSummary = toolSummary(input);
        call.touches = call.name === null ? [] : doubaoTouches(call.name, input).slice(0, MAX_TOUCHES).map((x) => ({ path: own(x.path.slice(0, PATH_MAX_CHARS)), action: x.action }));
      }
      this.refreshCall(state, call, changes, Object.keys(detail).length > 0 ? detail : undefined);
    }
  }

  private newCall(state: SessionState, t: Thread, callId: string, name: string | null, changes: Change[]): Call {
    const k = t.turn < 0 ? 0 : t.turn;
    const node = this.addNode(state, t, k, { ...blankNode(doubaoNodeId(state.session.id, t.agentId, `call:${callId}`), 'tool', name ?? 'tool', ''), status: 'running', toolName: name, toolUseId: callId }, {}, changes);
    const call: Call = { nodeId: node.id, callId, thread: t, turn: k, name, done: false, inputKey: undefined, argSummary: '', touches: [], childIds: [], removed: false };
    const list = t.calls.get(callId);
    if (list === undefined) t.calls.set(callId, [call]);
    else list.push(call);
    state.callByNode.set(node.id, call);
    return call;
  }

  /** A tool row: the result of the first call of that id still without one (a result without its call: a call of its own). */
  private toolResult(state: SessionState, t: Thread, callId: string, content: string, changes: Change[]): void {
    this.meaningful(state, t, false, changes);
    const call = t.calls.get(callId)?.find((c) => !c.done && !c.removed) ?? this.newCall(state, t, callId, null, changes);
    call.done = true;
    if (call.name === CREATE_AGENT) {
      const child = createdAgent(content, t);
      if (child !== null) this.nameChild(state, call, child, changes);
    }
    this.refreshCall(state, call, changes, { output: content });
  }

  /** The call's node as its state says, emitted where it differs (with `detail` merged into the stored one). */
  private refreshCall(state: SessionState, call: Call, changes: Change[], detail?: Partial<NodeDetail>): void {
    if (call.removed) return;
    const old = state.nodes.get(call.nodeId);
    if (old === undefined) return;
    const childAgentId = call.childIds.find((id) => state.threads.get(id)?.linkedTo === call) ?? null;
    const subagent = call.name === CREATE_AGENT;
    const files = subagent ? {} : nodeFiles(call.touches, null);
    const timestamp = this.timeOf(call.thread, call.turn);
    const next: GraphNode = {
      ...old,
      files: undefined,
      filesTruncated: undefined,
      kind: subagent ? 'subagent' : 'tool',
      title: call.name ?? 'tool',
      summary: call.argSummary,
      status: call.done ? 'succeeded' : 'running',
      toolName: call.name,
      toolUseId: call.callId,
      childAgentId,
      timestamp,
      endedAt: call.done ? timestamp : null,
      durationMs: null,
      ...filesFields(files),
      ...inputKeyFields(call.inputKey),
    };
    this.update(state, next, changes, detail);
  }

  // ---- subagent threads ----

  /** A call created a subagent: it is a link candidate of that thread. */
  private nameChild(state: SessionState, call: Call, childId: string, changes: Change[]): void {
    if (call.childIds.includes(childId) || call.childIds.length >= MAX_CHILD_IDS || childId === call.thread.agentId) return;
    call.childIds.push(childId);
    const list = state.childCalls.get(childId);
    if (list === undefined) state.childCalls.set(childId, [call]);
    else list.push(call);
    const t = state.threads.get(childId);
    if (t !== undefined) this.relink(state, t, changes);
  }

  /** Hangs agent thread `t` off the first live call naming it (or off nothing): its first node's parent and spawn edge. */
  private relink(state: SessionState, t: Thread, changes: Change[]): void {
    if (t.agentId === null) return;
    const want = (state.childCalls.get(t.agentId) ?? []).find((c) => !c.removed && c.thread !== t) ?? null;
    if (want === t.linkedTo) return;
    const old = t.linkedTo;
    t.linkedTo = want;
    if (old !== null) this.refreshCall(state, old, changes);
    if (want !== null) this.refreshCall(state, want, changes);
    this.reparentFirst(state, t, want?.nodeId ?? null, 'spawn', old !== null && !old.removed, changes);
  }

  // ---- restarts ----

  /** The thread's file is read again from its start: everything its rows made is removed (the `demand0` node stays). */
  private resetThread(state: SessionState, t: Thread, changes: Change[]): void {
    const p0 = t.p0 ? this.p0Id(state, t) : null;
    const affected = new Set<Thread>();
    for (const id of t.seq) if (id !== p0) this.removeNode(state, id, affected, changes);
    t.seq = p0 === null ? [] : [p0];
    t.turnOf = new Map(p0 === null ? [] : [[p0, 0]]);
    t.rowFirst = [];
    t.maxTurn = p0 === null ? -1 : 0;
    t.implicit = null;
    t.prompts = 0;
    t.turn = -1;
    t.firstPromptTitle = null;
    t.calls.clear();
    t.mtimeMs = null;
    t.fileMs = null;
    t.timesDirty = true;
    for (const child of affected) if (child !== t) this.relink(state, child, changes);
    if (p0 !== null) this.refreshThread(state, t, changes);
  }

  /** Removes one node (the store drops its detail, search entry and edges); a call's node takes the call with it. */
  private removeNode(state: SessionState, id: string, affected: Set<Thread>, changes: Change[]): void {
    if (!state.nodes.delete(id)) return;
    changes.push({ type: 'node_removed', sessionId: state.session.id, id });
    const call = state.callByNode.get(id);
    if (call === undefined) return;
    call.removed = true;
    state.callByNode.delete(id);
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

  /** Earliest and latest known time of the thread's turns that have nodes. */
  private threadTimes(t: Thread): { min: number | null; max: number | null } {
    if (t.timesDirty) {
      t.minMs = null;
      t.maxMs = null;
      for (let k = 0; k <= t.maxTurn; k++) {
        const iso = this.timeOf(t, k);
        if (iso === EPOCH) continue;
        const ms = Date.parse(iso);
        t.minMs = t.minMs === null ? ms : Math.min(t.minMs, ms);
        t.maxMs = t.maxMs === null ? ms : Math.max(t.maxMs, ms);
      }
      t.timesDirty = false;
    }
    return { min: t.minMs, max: t.maxMs };
  }

  /**
   * The session as a function of what was read: title = the main thread's first prompt (the first demand when it had
   * no user row); no cwd, branch or model; started = the earliest known node time; last activity = the latest known
   * node time or the latest modification time of a synthetic line (the reader puts one before each read that delivers
   * rows), whichever is later, so a turn that keeps writing rows long after its demand's time is not seen as quiet;
   * status running (the display turns a quiet session idle).
   */
  private commitSession(state: SessionState, changes: Change[]): void {
    const main = state.threads.get(MAIN);
    let minMs: number | null = null;
    let maxMs: number | null = null;
    for (const th of state.threads.values()) {
      const { min, max } = this.threadTimes(th);
      if (min !== null) minMs = minMs === null ? min : Math.min(minMs, min);
      if (max !== null) maxMs = maxMs === null ? max : Math.max(maxMs, max);
      // Only threads that show something: a file of blank lines alone does not make the session active.
      if (th.fileMs !== null && th.seq.length > 0) maxMs = maxMs === null ? th.fileMs : Math.max(maxMs, th.fileMs);
    }
    const startedAt = minMs === null ? EPOCH : isoOfMs(minMs);
    const lastActivityAt = maxMs === null ? startedAt : isoOfMs(maxMs);
    const title = main === undefined ? null : main.p0 ? (main.first?.title ?? null) : main.firstPromptTitle;
    const next: Session = { ...state.session, projectId: state.projectId, cwd: null, title, gitBranch: null, status: 'running', startedAt, lastActivityAt };
    const cur = state.session;
    const same =
      cur.projectId === next.projectId &&
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
