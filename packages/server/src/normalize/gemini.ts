import type { Change, GraphNode, NodeDetail, Session, Usage } from '@agent-canvas/shared';
import { GEMINI_PROJECT_ENTRY_PREFIX } from '../sources/gemini/project.js';
import type { RawEvent } from '../store/store.js';
import { promptTitle } from './codex.js';
import { filesFields, filesPatch, geminiTouches, nodeFiles } from './files.js';
import { applyGeminiOps, emptyGeminiState, reduceGemini, reduceGeminiLegacy, type GeminiObj, type GeminiOp, type GeminiThreadState } from './gemini-reduce.js';
import { inputKeyFields, inputKeyOf, inputKeyPatch } from './input-key.js';
import { summarize } from './summary.js';
import type { AgentNormalizer, BatchItem, BatchResult, NormalizeResult } from './types.js';
import { unknownTypeName } from './unknown-type.js';

/*
 * The Gemini CLI normalizer (spec 5.1). Each thread (the session file, and each subagent file under
 * `chats/<session id>/`) is reduced to its messages in order of first appearance (gemini-reduce.ts); the graph is a
 * function of those messages: every message gives a fixed list of nodes (user prompt; gemini thoughts, text, tool
 * calls; info / warning / error notices), chained in thread order. A message that changes (re-appended, patched)
 * re-derives its nodes; the difference to what was emitted goes out as node_added / node_updated / node_removed and
 * edge changes. Node ids are stable: `gemini:<session id>[/<agent id>]:<message id>:<part>`.
 *
 * Only the part of a thread from its first changed message on is walked again (`dirtyFrom`); a message whose record,
 * working directory and subagent links are unchanged reuses its built nodes.
 */

const EPOCH = '1970-01-01T00:00:00.000Z';
const KNOWN_TYPES = new Set(['user', 'gemini', 'info', 'warning', 'error']);
/** Content part keys that are known (others are reported as `gemini:part.<key>`). */
const KNOWN_PARTS = new Set([
  'text',
  'thought',
  'thoughtSignature',
  'functionCall',
  'functionResponse',
  'inlineData',
  'fileData',
  'executableCode',
  'codeExecutionResult',
  'videoMetadata',
  'mediaResolution',
]);
/** Tools that run a subagent (spec 5.1's table): a dispatch node even before (or without) a matching thread. */
const SUBAGENT_TOOLS = new Set(['invoke_agent', 'codebase_investigator', 'cli_help']);
const SUMMARY_KEYS = ['command', 'file_path', 'absolute_path', 'path', 'dir_path', 'directory', 'pattern', 'query', 'objective', 'prompt'];
const SYSTEM_TITLES: Record<string, string> = { info: 'Info', warning: 'Warning', error: 'Error' };
/** Key of the main thread in SessionState.threads. */
const MAIN = '';

type Obj = GeminiObj;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
function msOf(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}
const isoOf = (v: unknown): string | null => {
  const ms = msOf(v);
  return ms === null ? null : new Date(ms).toISOString();
};

/** The stable id of one node of a message. `part`: prompt, text, info / warning / error, thought:<i>, call:<id>. */
export function geminiNodeId(sessionId: string, agentId: string | null, messageId: string, part: string): string {
  return `gemini:${sessionId}${agentId === null ? '' : `/${agentId}`}:${messageId}:${part}`;
}

/** Content as parts: a string is one text part; a part is a list of one. */
function partsOf(content: unknown): unknown[] {
  if (typeof content === 'string') return [{ text: content }];
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? { text: p } : p));
  return content === undefined || content === null ? [] : [content];
}
/** The text of content parts (thought parts and non-text parts left out; an image as `[image]`). */
function textOf(content: unknown): string {
  let out = '';
  for (const p of partsOf(content)) {
    if (!isObject(p) || p.thought === true) continue;
    if (typeof p.text === 'string') out += p.text;
    else if (isObject(p.inlineData) || isObject(p.fileData)) out += '[image]';
  }
  return out;
}
const hasFunctionResponse = (content: unknown): boolean => partsOf(content).some((p) => isObject(p) && 'functionResponse' in p);

/** `{input − cached, cached, output + thoughts}` from a message's `tokens`; null when it has none. */
function usageOf(tokens: unknown): Usage | null {
  if (!isObject(tokens)) return null;
  const cached = num(tokens.cached);
  return { inputTokens: Math.max(0, num(tokens.input) - cached), cachedInputTokens: cached, outputTokens: num(tokens.output) + num(tokens.thoughts) };
}

/** A call's result: `functionResponse.response.output`, else `.error`, of its result parts (joined when several). */
function outputOf(result: unknown): unknown {
  if (result === undefined || result === null) return undefined;
  if (typeof result === 'string') return result;
  const outs: unknown[] = [];
  for (const p of partsOf(result)) {
    if (!isObject(p) || !isObject(p.functionResponse)) continue;
    const r = p.functionResponse.response;
    if (!isObject(r)) continue;
    if (r.output !== undefined) outs.push(r.output);
    else if (r.error !== undefined) outs.push(r.error);
  }
  if (outs.length === 0) return undefined;
  if (outs.length === 1) return outs[0];
  return outs.every((o) => typeof o === 'string') ? outs.join('\n') : outs;
}

function callStatus(status: unknown): 'running' | 'succeeded' | 'failed' {
  if (status === 'success') return 'succeeded';
  if (status === 'error' || status === 'cancelled') return 'failed';
  return 'running';
}

function toolSummary(args: unknown): string {
  if (!isObject(args)) return args === undefined || args === null ? '' : summarize(args);
  for (const k of SUMMARY_KEYS) {
    const v = str(args[k]);
    if (v !== null && v.trim() !== '') return summarize(v.trim());
  }
  for (const v of Object.values(args)) if (typeof v === 'string' && v.trim() !== '') return summarize(v.trim());
  return Object.keys(args).length === 0 ? '' : summarize(args);
}

/** One node of a message, without the fields its place in the thread decides (parentId, turnId; timestamp if unset). */
interface Part {
  id: string;
  messageId: string;
  kind: GraphNode['kind'];
  title: string;
  summary: string;
  timestamp: string | null;
  status: GraphNode['status'];
  endedAt: string | null;
  toolName: string | null;
  toolUseId: string | null;
  usage: Usage | null;
  systemSubtype: string | null;
  files: ReturnType<typeof nodeFiles>;
  inputKey: string | undefined;
  /** Subagent dispatch: the agent id it names (a link candidate), and whether it is linked. */
  childAgentId: string | null;
  detail: Partial<NodeDetail>;
  detailSig: string;
  /** A prompt: it opens a turn, and its title candidate. */
  promptTitle?: string | null;
}

interface Built {
  record: Obj;
  cwd: string | null;
  linkSig: string;
  parts: Part[];
}

/** Where the walk of a thread stands after a message. */
interface Chain {
  prev: string | null;
  prevTs: string | null;
  turn: string | null;
  /** The thread's first prompt's title (undefined: no prompt yet). */
  firstTitle: string | null | undefined;
}

interface Thread {
  agentId: string | null;
  st: GeminiThreadState;
  built: Map<string, Built>;
  /** Message id -> ids of its nodes as emitted. */
  emitted: Map<string, string[]>;
  /** Message id -> agent ids its calls name. */
  dispatches: Map<string, string[]>;
  chain: Chain[];
  dirtyFrom: number;
  /** A JSONL line of this thread was read: a legacy `.json` of it is not read any more (spec 5.1). */
  sawJsonl: boolean;
  /** Earliest / latest time read in this thread's records. */
  minMs: number | null;
  maxMs: number | null;
  /** A legacy `.json` was applied to this thread (its messages go when the first `.jsonl` line arrives). */
  legacyApplied: boolean;
  /**
   * Message id -> call id -> the call's `timestamp` on the first record that showed it in a terminal status
   * (GraphNode.endedAt: later corrections keep it). Kept with the records, in record order, so every batching, page
   * boundary, hydration and rebuild gives the same value.
   */
  firstEnded: Map<string, Map<string, string>>;
}

interface SessionState {
  session: Session;
  /** A message was read (any thread): the session exists. Metadata or `$set` alone make none (spec: empty launches). */
  started: boolean;
  /** The session row was emitted at least once. */
  sessionEmitted: boolean;
  projectId: string;
  /** Project and working directory from the source's project entry (`.project_root` / `projects.json`). */
  entry: { projectId: string; cwd: string | null } | null;
  threads: Map<string, Thread>;
  nodes: Map<string, GraphNode>;
  detailSigs: Map<string, string>;
  /** Node id -> the edge into it, as emitted. */
  edgeInto: Map<string, { id: string; from: string; kind: 'sequence' | 'spawn' }>;
  /** Node id -> the nodes whose edge (edgeInto) comes from it (reverse index of edgeInto). */
  edgesFrom: Map<string, Set<string>>;
  /** Agent id -> the dispatch node it hangs off, as last derived. */
  links: Map<string, string>;
}

const minOf = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.min(a, b));
const maxOf = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

export class GeminiNormalizer implements AgentNormalizer {
  private readonly sessions = new Map<string, SessionState>();
  private readonly restored = new Set<string>();

  apply(event: RawEvent, projectId: string): NormalizeResult {
    const r = this.applyBatch([{ event, projectId }]);
    const unknown = r.unknown[0];
    return unknown === undefined ? { changes: r.changes } : { changes: r.changes, unknownRecordType: unknown };
  }

  /** Records update their thread's messages as they come; each touched session is derived once, at the end. */
  applyBatch(items: readonly BatchItem[]): BatchResult {
    const changes: Change[] = [];
    const unknown: (string | undefined)[] = [];
    const touched = new Set<SessionState>();
    items.forEach(({ event, projectId }, i) => {
      unknown.push(undefined);
      if (event.source === 'hook') return; // Gemini CLI has no hooks of ours
      try {
        const state = this.stateFor(event.sessionId, projectId);
        unknown[i] = this.record(state, event, projectId, changes);
        touched.add(state);
      } catch {
        unknown[i] = 'gemini:normalizer-error';
      }
    });
    for (const state of touched) {
      try {
        this.derive(state, changes);
      } catch {
        const last = unknown.length - 1;
        unknown[last] ??= 'gemini:normalizer-error';
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

  /** Before the session exists only project entries can be stored for it: re-applied, their changes discarded. */
  restorePreSession(sessionId: string, events: Iterable<RawEvent>): void {
    this.dropSession(sessionId);
    for (const ev of events) {
      if (ev.sessionId !== sessionId) continue;
      const projectId = ev.source !== 'hook' && ev.projectId != null ? ev.projectId : 'unknown';
      this.apply(ev, projectId);
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

  // ---- records ----

  private stateFor(sessionId: string, projectId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (state === undefined) {
      state = {
        session: {
          id: sessionId,
          projectId,
          origin: 'gemini',
          cwd: null,
          title: null,
          gitBranch: null,
          status: 'idle',
          sourceDeleted: false,
          startedAt: EPOCH,
          lastActivityAt: EPOCH,
        },
        started: false,
        sessionEmitted: false,
        projectId,
        entry: null,
        threads: new Map(),
        nodes: new Map(),
        detailSigs: new Map(),
        edgeInto: new Map(),
        edgesFrom: new Map(),
        links: new Map(),
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private threadFor(state: SessionState, agentId: string | null): Thread {
    const key = agentId ?? MAIN;
    let t = state.threads.get(key);
    if (t === undefined) {
      t = { agentId, st: emptyGeminiState(), built: new Map(), emitted: new Map(), dispatches: new Map(), chain: [], dirtyFrom: 0, sawJsonl: false, legacyApplied: false, minMs: null, maxMs: null, firstEnded: new Map() };
      state.threads.set(key, t);
    }
    return t;
  }

  /** Takes one raw event into the session state; returns its unknown label. */
  private record(state: SessionState, event: Exclude<RawEvent, { source: 'hook' }>, projectId: string, changes: Change[]): string | undefined {
    if (event.source === 'meta' && event.file.startsWith(GEMINI_PROJECT_ENTRY_PREFIX)) {
      let cwd: string | null = null;
      try {
        const parsed: unknown = JSON.parse(event.payload);
        if (isObject(parsed)) cwd = str(parsed.cwd);
      } catch {
        // a damaged entry: project only
      }
      const old = state.entry;
      state.entry = { projectId, cwd };
      if (old?.cwd !== cwd) for (const t of state.threads.values()) t.dirtyFrom = 0;
      return undefined;
    }
    if (projectId !== 'unknown' && (event.agentId === null || state.projectId === 'unknown')) state.projectId = projectId;
    const thread = this.threadFor(state, event.agentId);
    let ops: GeminiOp[];
    if (event.source === 'meta') {
      if (thread.sawJsonl) return undefined; // the .jsonl of this session is read instead
      ops = reduceGeminiLegacy(event.payload);
      if (ops.some((o) => o.op === 'replaceAll')) thread.legacyApplied = true;
    } else {
      if (!thread.sawJsonl && thread.legacyApplied) {
        // Only the .jsonl is read (spec 5.1): what a legacy .json seen first left goes, whatever the .jsonl lacks.
        this.applyOps(state, thread, [{ op: 'replaceAll', messages: [] }], changes);
        thread.st.meta = {};
        thread.minMs = null;
        thread.maxMs = null;
        thread.firstEnded.clear();
      }
      thread.sawJsonl = true;
      ops = reduceGemini(thread.st, event.line);
    }
    if (ops.some((o) => o.op === 'upsertMessage' || (o.op === 'replaceAll' && o.messages.length > 0))) state.started = true;
    return this.applyOps(state, thread, ops, changes);
  }

  /** Applies ops to the thread: removals emitted now, the rest marked for derive. Returns the first unknown label. */
  private applyOps(state: SessionState, thread: Thread, ops: GeminiOp[], changes: Change[]): string | undefined {
    let unknown: string | undefined;
    const note = (label: string | undefined): void => {
      unknown ??= label;
    };
    for (const o of ops) {
      switch (o.op) {
        case 'unknown':
          note(o.type);
          break;
        case 'setMeta':
          this.time(thread, o.meta.lastUpdated);
          this.time(thread, o.meta.startTime);
          // The fallback time of untimed leading nodes.
          if ('startTime' in o.meta && o.meta.startTime !== thread.st.meta.startTime) thread.dirtyFrom = 0;
          break;
        case 'upsertMessage': {
          note(this.inspect(thread, o.message));
          this.noteEnded(thread, o.id, o.message);
          const at = thread.st.messages.has(o.id) ? thread.st.order.lastIndexOf(o.id) : thread.st.order.length;
          thread.dirtyFrom = Math.min(thread.dirtyFrom, at);
          this.noteDispatches(thread, o.id, o.message);
          break;
        }
        case 'removeMessages': {
          const gone = new Set(o.ids);
          const at = thread.st.order.findIndex((id) => gone.has(id));
          if (at !== -1) thread.dirtyFrom = Math.min(thread.dirtyFrom, at);
          for (const id of o.ids) this.removeMessage(state, thread, id, changes);
          break;
        }
        case 'replaceAll': {
          const keep = new Set<string>();
          for (const m of o.messages) {
            note(this.inspect(thread, m));
            this.noteEnded(thread, m.id as string, m);
            keep.add(m.id as string);
          }
          for (const id of thread.st.order) if (!keep.has(id)) this.removeMessage(state, thread, id, changes);
          thread.dispatches.clear();
          for (const m of o.messages) this.noteDispatches(thread, m.id as string, m);
          thread.dirtyFrom = 0;
          break;
        }
      }
    }
    applyGeminiOps(thread.st, ops);
    return unknown;
  }

  /** Session times from a message, and the unknown label of its type or of a content part, if any. */
  private inspect(thread: Thread, m: Obj): string | undefined {
    this.time(thread, m.timestamp);
    if (Array.isArray(m.thoughts)) for (const t of m.thoughts) if (isObject(t)) this.time(thread, t.timestamp);
    if (Array.isArray(m.toolCalls)) for (const c of m.toolCalls) if (isObject(c)) this.time(thread, c.timestamp);
    if (typeof m.type !== 'string' || !KNOWN_TYPES.has(m.type)) return unknownTypeName('gemini', m.type);
    for (const p of partsOf(m.content)) {
      if (!isObject(p)) continue;
      const k = Object.keys(p).find((key) => KNOWN_PARTS.has(key));
      if (k === undefined) {
        // A part's key is data the format does not control: named only when it looks like a schema key.
        const first = Object.keys(p)[0] ?? '';
        return unknownTypeName('gemini', /^[a-z][A-Za-z]{0,40}$/.test(first) ? `part.${first}` : 'part');
      }
    }
    return undefined;
  }

  private time(thread: Thread, v: unknown): void {
    const ms = msOf(v);
    if (ms === null) return;
    thread.minMs = minOf(thread.minMs, ms);
    thread.maxMs = maxOf(thread.maxMs, ms);
  }

  private noteDispatches(thread: Thread, id: string, m: Obj): void {
    const agents: string[] = [];
    if (Array.isArray(m.toolCalls)) for (const c of m.toolCalls) if (isObject(c) && typeof c.agentId === 'string' && c.agentId !== '') agents.push(c.agentId);
    if (agents.length > 0) thread.dispatches.set(id, agents);
    else thread.dispatches.delete(id);
  }

  /** Records the first terminal time of each call of a message record (see Thread.firstEnded). */
  private noteEnded(thread: Thread, id: string, m: Obj): void {
    if (!Array.isArray(m.toolCalls)) return;
    for (const c of m.toolCalls) {
      if (!isObject(c) || typeof c.id !== 'string' || callStatus(c.status) === 'running') continue;
      const at = isoOf(c.timestamp) ?? isoOf(m.timestamp);
      if (at === null) continue;
      let calls = thread.firstEnded.get(id);
      if (calls === undefined) thread.firstEnded.set(id, (calls = new Map()));
      if (!calls.has(c.id)) calls.set(c.id, at);
    }
  }

  /** A message leaves the thread: every node of it is removed (with the edges into and out of them). */
  private removeMessage(state: SessionState, thread: Thread, id: string, changes: Change[]): void {
    thread.firstEnded.delete(id);
    for (const nodeId of thread.emitted.get(id) ?? []) this.removeNode(state, nodeId, changes);
    thread.emitted.delete(id);
    thread.built.delete(id);
    thread.dispatches.delete(id);
  }

  private removeNode(state: SessionState, nodeId: string, changes: Change[]): void {
    if (!state.nodes.delete(nodeId)) return;
    state.detailSigs.delete(nodeId);
    changes.push({ type: 'node_removed', sessionId: state.session.id, id: nodeId });
    // The store dropped every edge from or to it.
    this.dropEdgeInto(state, nodeId);
    const out = state.edgesFrom.get(nodeId);
    if (out !== undefined) for (const to of [...out]) this.dropEdgeInto(state, to);
    state.edgesFrom.delete(nodeId);
  }

  /** Forgets the edge into `to` (both indexes). */
  private dropEdgeInto(state: SessionState, to: string): void {
    const e = state.edgeInto.get(to);
    if (e === undefined) return;
    state.edgeInto.delete(to);
    const set = state.edgesFrom.get(e.from);
    if (set === undefined) return;
    set.delete(to);
    if (set.size === 0) state.edgesFrom.delete(e.from);
  }

  /** Records the edge into `to` (both indexes). */
  private setEdgeInto(state: SessionState, to: string, e: { id: string; from: string; kind: 'sequence' | 'spawn' }): void {
    this.dropEdgeInto(state, to);
    state.edgeInto.set(to, e);
    let set = state.edgesFrom.get(e.from);
    if (set === undefined) state.edgesFrom.set(e.from, (set = new Set()));
    set.add(to);
  }

  // ---- derive ----

  /**
   * Links: each subagent thread hangs off the first call naming its agent id (main thread first, then the other
   * threads by agent id; within a thread in message order).
   */
  private computeLinks(state: SessionState): Map<string, string> {
    const links = new Map<string, string>();
    const keys = [...state.threads.keys()].sort();
    for (const key of keys) {
      const t = state.threads.get(key)!;
      if (t.dispatches.size === 0) continue;
      for (const msgId of t.st.order) {
        const agents = t.dispatches.get(msgId);
        if (agents === undefined) continue;
        const calls = t.st.messages.get(msgId)?.toolCalls;
        if (!Array.isArray(calls)) continue;
        calls.forEach((c, i) => {
          if (!isObject(c) || typeof c.agentId !== 'string') return;
          const child = c.agentId;
          if (links.has(child) || child === t.agentId || !state.threads.has(child)) return;
          links.set(child, geminiNodeId(state.session.id, t.agentId, msgId, callPart(c, i)));
        });
      }
    }
    return links;
  }

  private derive(state: SessionState, changes: Change[]): void {
    if (!state.started) return;
    const links = this.computeLinks(state);
    const changed = new Set<string>();
    for (const [a, d] of links) if (state.links.get(a) !== d) changed.add(a);
    for (const [a] of state.links) if (!links.has(a)) changed.add(a);
    state.links = links;
    for (const a of changed) {
      const child = state.threads.get(a);
      if (child !== undefined) child.dirtyFrom = 0;
      for (const t of state.threads.values()) {
        for (const [msgId, agents] of t.dispatches) {
          if (!agents.includes(a)) continue;
          t.built.delete(msgId);
          t.dirtyFrom = Math.min(t.dirtyFrom, t.st.order.indexOf(msgId));
        }
      }
    }
    const cwd = state.entry?.cwd ?? null;
    const main = state.threads.get(MAIN);
    if (main !== undefined) this.walk(state, main, null, cwd, changes);
    for (const [key, t] of [...state.threads].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (key === MAIN) continue;
      this.walk(state, t, links.get(key) ?? null, cwd, changes);
    }
    this.commitSession(state, changes);
  }

  /** Re-derives a thread from its first changed message on, emitting what differs. */
  private walk(state: SessionState, t: Thread, dispatch: string | null, cwd: string | null, changes: Change[]): void {
    const order = t.st.order;
    t.chain.length = Math.min(t.chain.length, order.length);
    const from = Math.max(0, Math.min(t.dirtyFrom, order.length));
    t.dirtyFrom = Number.POSITIVE_INFINITY;
    if (from >= order.length) return;
    let chain: Chain = from === 0 ? { prev: null, prevTs: null, turn: null, firstTitle: undefined } : { ...t.chain[from - 1]! };
    for (let i = from; i < order.length; i++) {
      const msgId = order[i]!;
      const record = t.st.messages.get(msgId)!;
      const linkSig = this.linkSig(state, t, msgId);
      let built = t.built.get(msgId);
      if (built === undefined || built.record !== record || built.cwd !== cwd || built.linkSig !== linkSig) {
        built = { record, cwd, linkSig, parts: this.build(state, t, msgId, record, cwd) };
        t.built.set(msgId, built);
      }
      const ids: string[] = [];
      for (const part of built.parts) {
        if (part.promptTitle !== undefined) {
          chain.turn = part.id;
          if (chain.firstTitle === undefined) chain.firstTitle = part.promptTitle;
        }
        const parentId = chain.prev ?? dispatch;
        // Untimed leading nodes: the thread's metadata startTime (read before any message), never a batch-dependent time.
        const timestamp = part.timestamp ?? chain.prevTs ?? isoOf(t.st.meta.startTime) ?? EPOCH;
        this.emitNode(state, t, part, parentId, chain.prev === null ? 'spawn' : 'sequence', chain.turn, timestamp, changes);
        ids.push(part.id);
        chain.prev = part.id;
        chain.prevTs = timestamp;
      }
      const old = t.emitted.get(msgId) ?? [];
      for (const id of old) if (!ids.includes(id)) this.removeNode(state, id, changes);
      t.emitted.set(msgId, ids);
      t.chain[i] = { ...chain };
    }
  }

  /** Which of the agent ids a message's calls name are linked to those calls (part of what its nodes depend on). */
  private linkSig(state: SessionState, t: Thread, msgId: string): string {
    const agents = t.dispatches.get(msgId);
    if (agents === undefined) return '';
    return agents.map((a) => `${a}=${state.links.get(a) ?? ''}`).join('|');
  }

  /** The nodes of one message (spec 5.1 "消息"). */
  private build(state: SessionState, t: Thread, msgId: string, m: Obj, cwd: string | null): Part[] {
    const sid = state.session.id;
    const id = (part: string): string => geminiNodeId(sid, t.agentId, msgId, part);
    const ts = isoOf(m.timestamp);
    const base = (part: string, kind: GraphNode['kind'], title: string): Part => ({
      id: id(part),
      messageId: msgId,
      kind,
      title,
      summary: '',
      timestamp: ts,
      status: null,
      endedAt: null,
      toolName: null,
      toolUseId: null,
      usage: null,
      systemSubtype: null,
      files: {},
      inputKey: undefined,
      childAgentId: null,
      detail: {},
      detailSig: '',
    });
    const withDetail = (p: Part, detail: Partial<NodeDetail>): Part => {
      p.detail = detail;
      p.detailSig = JSON.stringify(detail) ?? '';
      return p;
    };
    const type = m.type;
    if (type === 'user') {
      if (hasFunctionResponse(m.content)) return [];
      const text = textOf(m.content);
      const p = base('prompt', 'prompt', 'Prompt');
      p.summary = summarize(text);
      p.promptTitle = promptTitle(text);
      return [withDetail(p, { text })];
    }
    if (type === 'info' || type === 'warning' || type === 'error') {
      const text = textOf(m.content);
      const p = base(type, 'system', SYSTEM_TITLES[type]!);
      p.summary = summarize(text);
      p.systemSubtype = type;
      return [withDetail(p, { text })];
    }
    if (type !== 'gemini') return [];
    const parts: Part[] = [];
    const thinking: Part[] = [];
    if (Array.isArray(m.thoughts)) {
      m.thoughts.forEach((th, i) => {
        if (!isObject(th)) return;
        const subject = str(th.subject) ?? '';
        const description = str(th.description) ?? '';
        const text = subject !== '' && description !== '' ? `${subject}\n${description}` : subject + description;
        const p = base(`thought:${i}`, 'thinking', 'Thinking');
        p.summary = summarize(subject !== '' ? subject : description);
        p.timestamp = isoOf(th.timestamp) ?? ts;
        thinking.push(withDetail(p, { text }));
      });
    }
    parts.push(...thinking);
    const usage = usageOf(m.tokens);
    const model = str(m.model);
    const text = textOf(m.content);
    let textPart: Part | null = null;
    if (text.trim() !== '') {
      textPart = base('text', 'text', 'Text');
      textPart.summary = summarize(text);
      parts.push(textPart);
    }
    const calls: Part[] = [];
    const seenCalls = new Set<string>();
    if (Array.isArray(m.toolCalls)) {
      m.toolCalls.forEach((c, i) => {
        if (!isObject(c)) return;
        let part = callPart(c, i);
        if (seenCalls.has(part)) part = `call#${i}`;
        seenCalls.add(part);
        const name = str(c.name) ?? 'unknown';
        const args = c.args;
        const status = callStatus(c.status);
        const agent = str(c.agentId);
        const linked = agent !== null && state.links.get(agent) === id(part);
        const isDispatch = linked || SUBAGENT_TOOLS.has(name);
        const p = base(part, isDispatch ? 'subagent' : 'tool', isDispatch ? agentTitle(name, args) : name);
        p.summary = toolSummary(args);
        p.status = status;
        const first = typeof c.id === 'string' ? t.firstEnded.get(msgId)?.get(c.id) : undefined;
        p.endedAt = status === 'running' ? null : (first ?? isoOf(c.timestamp) ?? ts);
        p.toolName = name;
        p.toolUseId = str(c.id);
        p.childAgentId = linked ? agent : null;
        p.files = nodeFiles(geminiTouches(name, args), cwd);
        p.inputKey = inputKeyOf(name, args);
        const output = outputOf(c.result);
        withDetail(p, { input: args ?? null, ...(output !== undefined ? { output } : {}) });
        calls.push(p);
      });
    }
    parts.push(...calls);
    const usageHolder = textPart ?? calls[0] ?? thinking[thinking.length - 1] ?? null;
    if (usageHolder !== null) usageHolder.usage = usage;
    if (textPart !== null) withDetail(textPart, { text, ...(model !== null || usage !== null ? { raw: { model, tokens: m.tokens ?? null } } : {}) });
    else if (usageHolder !== null && usage !== null) withDetail(usageHolder, { ...usageHolder.detail, raw: { model, tokens: m.tokens ?? null } });
    return parts;
  }

  /** Emits one node of the walk (added, or updated where it differs) and the edge into it. */
  private emitNode(
    state: SessionState,
    t: Thread,
    part: Part,
    parentId: string | null,
    edgeKind: 'sequence' | 'spawn',
    turnId: string | null,
    timestamp: string,
    changes: Change[],
  ): void {
    const sid = state.session.id;
    const old = state.nodes.get(part.id);
    const endedAt = part.endedAt;
    const durationMs = endedAt === null ? null : Math.max(0, Date.parse(endedAt) - Date.parse(timestamp)) || 0;
    const node: GraphNode = {
      id: part.id,
      sessionId: sid,
      turnId,
      agentId: t.agentId,
      childAgentId: part.childAgentId,
      parentId,
      kind: part.kind,
      status: part.status,
      timestamp,
      confirmed: true,
      title: part.title,
      summary: part.summary,
      toolName: part.toolName,
      toolUseId: part.toolUseId,
      messageId: part.messageId,
      durationMs,
      endedAt,
      usage: part.usage,
      systemSubtype: part.systemSubtype,
      ...filesFields(part.files),
      ...inputKeyFields(part.inputKey),
    };
    if (old === undefined) {
      state.nodes.set(node.id, node);
      state.detailSigs.set(node.id, part.detailSig);
      changes.push({ type: 'node_added', node, detail: part.detail });
    } else {
      const patch = nodePatch(old, node);
      const detailChanged = state.detailSigs.get(node.id) !== part.detailSig;
      if (Object.keys(patch).length > 0 || detailChanged) {
        state.nodes.set(node.id, { ...old, ...patch });
        state.detailSigs.set(node.id, part.detailSig);
        changes.push({ type: 'node_updated', sessionId: sid, id: node.id, patch, ...(detailChanged ? { detail: part.detail } : {}) });
      }
    }
    const edge = state.edgeInto.get(node.id);
    const want = parentId === null ? null : { id: `${parentId}->${node.id}`, from: parentId, kind: edgeKind };
    if (edge !== undefined && (want === null || edge.id !== want.id || edge.kind !== want.kind)) {
      this.dropEdgeInto(state, node.id);
      changes.push({ type: 'edge_removed', sessionId: sid, id: edge.id });
    }
    if (want !== null && (edge === undefined || edge.id !== want.id || edge.kind !== want.kind)) {
      this.setEdgeInto(state, node.id, want);
      changes.push({ type: 'edge_added', edge: { id: want.id, sessionId: sid, from: want.from, to: node.id, kind: want.kind } });
    }
  }

  /**
   * The session as a function of the messages read: title = the main thread's `summary` (`$set`), else its first
   * prompt; project and cwd = the project entry's, else the project the records came with; started = the main
   * metadata's startTime, else the earliest time read; last activity = the latest time read. Status (no hooks): running
   * while the main thread's last message is a user message or a gemini message with a call not finished; else idle.
   */
  private commitSession(state: SessionState, changes: Change[]): void {
    const main = state.threads.get(MAIN);
    const summary = str(main?.st.meta.summary);
    const lastChain = main === undefined || main.chain.length === 0 ? undefined : main.chain[main.chain.length - 1];
    const title = summary !== null && summary.trim() !== '' ? summary : (lastChain?.firstTitle ?? null);
    let minMs: number | null = null;
    let maxMs: number | null = null;
    for (const t of state.threads.values()) {
      minMs = minOf(minMs, t.minMs);
      maxMs = maxOf(maxMs, t.maxMs);
    }
    const startedAt = isoOf(main?.st.meta.startTime) ?? (minMs === null ? EPOCH : new Date(minMs).toISOString());
    const startedMs = Date.parse(startedAt);
    const lastMs = maxOf(maxMs, startedMs);
    const next: Session = {
      ...state.session,
      projectId: state.entry?.projectId ?? state.projectId,
      cwd: state.entry?.cwd ?? null,
      title,
      status: main === undefined ? 'idle' : threadStatus(main),
      startedAt,
      lastActivityAt: lastMs === null ? startedAt : new Date(lastMs).toISOString(),
    };
    const s = state.session;
    const same =
      s.projectId === next.projectId &&
      s.cwd === next.cwd &&
      s.title === next.title &&
      s.status === next.status &&
      s.startedAt === next.startedAt &&
      s.lastActivityAt === next.lastActivityAt;
    if (same && state.sessionEmitted) return;
    state.sessionEmitted = true;
    state.session = next;
    changes.push({ type: 'session_upserted', session: next });
  }
}

/** The node-id part of a tool call: `call:<id>`, or `call#<index>` when it has none. */
function callPart(c: Obj, i: number): string {
  return typeof c.id === 'string' && c.id !== '' ? `call:${c.id}` : `call#${i}`;
}

/** A dispatch node's title: the agent name its arguments give, else the tool name. */
function agentTitle(name: string, args: unknown): string {
  if (isObject(args)) for (const k of ['agent_name', 'agentName', 'name']) if (typeof args[k] === 'string' && (args[k] as string).trim() !== '') return args[k] as string;
  return name;
}

function threadStatus(t: Thread): Session['status'] {
  const order = t.st.order;
  if (order.length === 0) return 'idle';
  const last = t.st.messages.get(order[order.length - 1]!)!;
  if (last.type === 'user') return 'running';
  if (last.type === 'gemini' && Array.isArray(last.toolCalls) && last.toolCalls.some((c) => isObject(c) && callStatus(c.status) === 'running')) return 'running';
  return 'idle';
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
    'messageId',
    'durationMs',
    'endedAt',
    'systemSubtype',
  ];
  for (const k of keys) if (old[k] !== next[k]) (patch as Record<string, unknown>)[k] = next[k];
  const ou = old.usage;
  const nu = next.usage;
  if (
    (ou === null) !== (nu === null) ||
    (ou !== null && nu !== null && (ou.inputTokens !== nu.inputTokens || ou.outputTokens !== nu.outputTokens || (ou.cachedInputTokens ?? 0) !== (nu.cachedInputTokens ?? 0)))
  ) {
    patch.usage = nu;
  }
  Object.assign(patch, filesPatch(old, next));
  Object.assign(patch, inputKeyPatch(old, next.inputKey));
  return patch;
}
