import type { Change, GraphNode, NodeDetail, Session, Usage } from '@agent-canvas/shared';
import type { RawEvent } from '../store/store.js';
import { promptTitle } from './codex.js';
import { filesFields, nodeFiles, qwenTouches, type NodeFiles } from './files.js';
import { nodePatch, outputOf, toolSummary } from './gemini.js';
import { inputKeyFields, inputKeyOf } from './input-key.js';
import { LiveChain } from './qwen-chain.js';
import { SubagentLinks, type LinkInfo } from './qwen-links.js';
import { classifyUser, promptText } from './qwen-prompt.js';
import { qwenUsage } from './qwen-usage.js';
import { summarize } from './summary.js';
import type { AgentNormalizer, BatchItem, BatchResult, NormalizeResult } from './types.js';
import { unknownTypeName } from './unknown-type.js';

/*
 * The Qwen Code normalizer (spec 4-8; docs/formats/qwen-code.md 1.4, 2-6). The source delivers one JSONL line per
 * event, `offset` = the line's byte offset. A session file is the main thread of its session; a subagent file
 * `subagents/<session>/agent-<stem>.jsonl` is an agent thread of it, keyed by the event's agent id (the file name's
 * lossy form of the id) and named in node ids by its first record's `agentId`. The two sidecars arrive whole as meta
 * events: the title sidecar (agentId null) and an agent's `.meta.json` (agentId = its stem).
 *
 * Subagent links (spec 6, reference 5.3) are kept by an incremental index (qwen-links.ts), settled at the end of every
 * event and costing what the event touched: a thread hangs off the shown dispatch call its sidecar names (`toolUseId`
 * in the thread of `parentAgentId`), else the first one whose id ends its agent id after a `-`; a link that would make
 * a thread its own ancestor is not made. Any arrival order of the call, the thread and the sidecar ends in the same
 * graph, and a dispatch call leaving the chain unlinks its thread until it returns. Agent-thread nodes are emitted as
 * read, before the session row exists (as Buddy's and DeepSeek's); only the main thread starts the session, decides
 * its status, title, cwd and git branch.
 *
 * Each record is a `ChatRecord` linked into a tree by `parentUuid`; the graph shows the live chain only (the last
 * conversation record walked to its root, qwen-chain.ts). A thread keeps, per conversation record, small facts (the
 * nodes it makes without their text, its call ids, its result's status, its usage counts, what it sets for the walk)
 * and the walk state after it while it is on the chain. A line is applied in order and emits what it changes:
 *
 * - the chain grows by the line's record (O(1)), or re-roots: the records that left are undone newest first (their
 *   results un-paired, their calls closed, their usage taken off the node holding it) and their nodes removed; the
 *   records that joined are walked from the fork point with the walk state stored there (O(records joined));
 * - a fragment (a repeated uuid) of an assistant record adds its parts' nodes and its usage, re-walking the chain from
 *   that record (diffs only).
 *
 * Nodes: one per shown part of a record (prompt, notice, thinking, text, tool call, compaction, command, turn end),
 * chained in chain order; a prompt opens a turn. A tool result is folded into the node of the call it pairs with (the
 * nearest call of its id on the chain without a result) and leaves with its record. Usage goes on the first node of the
 * response (a response that shows nothing: on the node before it).
 *
 * Text (prompt, reply, tool input or output) is emitted in node details and not kept, except in a bounded cache
 * (DETAIL_CACHE_CHARS per thread, oldest dropped first) from which a node returning to the chain gets its detail back
 * (`unreadable: true` when it was dropped), as the Buddy normalizer does.
 *
 * Node ids: `qwen:<session id>[/<agent id>]:<uuid>:<part>`. A line at or before the thread's last offset means the file
 * is read again from its start (rewritten): what the thread made is removed and the thread starts over.
 */

const EPOCH = '1970-01-01T00:00:00.000Z';
const MAIN = '';
/** Characters of node details kept per thread (oldest dropped first) for nodes that return to the chain: 256 KiB. */
export const DETAIL_CACHE_CHARS = 256 * 1024;
const PREFIX_MAX = 2048;
const PATH_MAX_CHARS = 4096;
const ID_MAX_CHARS = 1024;
/** A title sidecar larger than this is ignored (it is `{version, displayName, source, updatedAt}`). */
export const TITLE_SIDECAR_MAX_CHARS = 64 * 1024;
/** An agent sidecar larger than this is ignored (stats and recent activities make it grow; still small). */
export const AGENT_META_MAX_CHARS = 1024 * 1024;
const FRAGMENT_IGNORED = 'qwen:fragment-ignored';
const TYPES = new Set(['user', 'assistant', 'tool_result', 'system']);
/** Not conversation records (reference 2.3): never a leaf, never a link; besides every `managed_session_*`. */
const NON_CONVERSATION = new Set(['session_artifact_event', 'session_artifact_snapshot', 'session_sources_snapshot']);
/** System subtypes of reference 2.3 that show nothing and are not unknown (spec 4.4). */
const QUIET_SYSTEM = new Set([
  'rewind',
  'at_command',
  'ui_telemetry',
  'session_approval_mode',
  'session_workflow_mode',
  'session_source',
  'parent_session',
  'session_execution_engine',
  'turn_attempt',
  'file_history_snapshot',
  'attribution_snapshot',
  'user_text_elements',
  'memory_catalog_snapshot',
  'omni_recall',
  'background_task_completed',
  'branch_checkpoint',
  'goal_state',
  'goal_turn_end',
  'agent_bootstrap',
  'agent_launch_prompt',
  'agent_retry',
  'agent_session_ready',
]);
const QUIET_RESULTS = new Set(['code_mode_tool_result', 'tool_loop_end']);
/** The subagent tool and its legacy name (reference 5.1). */
const DISPATCH_TOOLS = new Set(['agent', 'task']);
const USAGE_FIELDS = ['promptTokenCount', 'candidatesTokenCount', 'cachedContentTokenCount', 'thoughtsTokenCount', 'totalTokenCount'];

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
/** A copy of `s` sharing no memory with the line it was cut from (see grok.ts `own`). */
const own = (s: string): string => (' ' + s).slice(1);
const brief = (v: unknown): string => own(summarize(typeof v === 'string' ? head(v, PREFIX_MAX) : v));

function head(s: string, n: number): string {
  if (s.length <= n) return s;
  const code = s.charCodeAt(n - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

function msOf(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

/** The id of a Qwen Code node: `qwen:<session id>[/<agent id>]:<uuid>:<part>`. */
export function qwenNodeId(sessionId: string, agentId: string | null, uuid: string, part: string): string {
  return `qwen:${sessionId}${agentId === null ? '' : `/${agentId}`}:${uuid}:${part}`;
}

const addUsage = (a: Usage | null, b: Usage | null): Usage | null => {
  if (b === null) return a;
  if (a === null) return { ...b };
  return { inputTokens: a.inputTokens + b.inputTokens, cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0), outputTokens: a.outputTokens + b.outputTokens };
};

/** The size of a detail for the cache: characters of its strings, of the JSON of its other values. */
function detailChars(detail: Partial<NodeDetail>): number {
  let size = 0;
  for (const v of Object.values(detail)) {
    if (typeof v === 'string') size += v.length;
    else if (v === null || v === undefined || typeof v !== 'object') size += 8;
    else {
      try {
        size += JSON.stringify(v)?.length ?? 0;
      } catch {
        return Number.POSITIVE_INFINITY;
      }
    }
  }
  return size;
}

/** A tool call of an assistant record: never its arguments (they go out in the node's detail). */
interface Call {
  nf: NodeFacts;
  thread: Thread;
  callId: string | null;
  name: string;
  inputKey: string | undefined;
  files: NodeFiles;
  /** The result record paired with it (on the chain), and the one whose output its emitted detail carries. */
  result: Rec | null;
  shown: Rec | null;
  /** An `agent` / `task` call: its `subagent_type`, and the agent thread linked to it. */
  dispatch: boolean;
  label: string | null;
  child: Thread | null;
}

/** What an agent's `.meta.json` says (reference 5.2 `AgentMeta`), the fields this normalizer reads. */
interface AgentMeta {
  agentId: string | null;
  agentType: string | null;
  toolUseId: string | null;
  /** null: a top-level agent (its call is in the main thread). */
  parentAgentId: string | null;
  model: string | null;
}

/** One node of a record, without the fields its place on the chain decides (parent, turn, fallback time, usage). */
interface NodeFacts {
  id: string;
  rec: Rec;
  kind: GraphNode['kind'];
  title: string;
  summary: string;
  systemSubtype: string | null;
  ts: string | null;
  call: Call | null;
  /** Usage of the following records that show no node, by their uuid (null: none). */
  extras: Map<string, Usage> | null;
}

interface ResultFacts {
  callId: string | null;
  name: string | null;
  failed: boolean;
  cancelled: boolean;
  /** `toolCallResult.resultDisplay` when a string, as a summary. */
  display: string | null;
  call: Call | null;
}

/** Where the walk of a chain stands after a record. */
interface Walk {
  prev: NodeFacts | null;
  prevTs: string | null;
  turn: string | null;
  auth: string | null;
  status: 'running' | 'idle' | null;
  /** The latest assistant record, when it has calls (a result without id pairs there). */
  reply: Rec | null;
}

/** The facts of one conversation record (all its fragments). */
interface Rec {
  uuid: string;
  type: string;
  nodes: NodeFacts[];
  /** Parts read so far (a fragment's parts continue the numbering). */
  partCount: number;
  opensTurn: boolean;
  status: 'running' | 'idle' | null;
  auth: string | null;
  /** The numeric fields of the latest `usageMetadata` (null: none), and the usage they gave on the last walk. */
  usage: Obj | null;
  usageNow: Usage | null;
  model: string | null;
  cwd: string | null;
  result: ResultFacts | null;
  ts: string | null;
  /** The walk state after it while it is on the chain. */
  after: Walk | null;
  /** The node its usage is on when it shows none. */
  attachedTo: NodeFacts | null;
}

interface Thread {
  /** Its key in SessionState.threads: MAIN, or `a:<stem>`. */
  key: string;
  /** null: the main thread; else the agent file's name form of the id (the event's agent id). */
  stem: string | null;
  /** The id in its node ids: null for the main thread; the first record's `agentId`, the stem until a record is read. */
  agentId: string | null;
  /** The first valid record was read (its `agentId`, when it has one, is in `recordId`). */
  fixed: boolean;
  recordId: string | null;
  /** The records' `agentName` (the first one read). */
  agentName: string | null;
  /** The agent's sidecar (latest version; null: none or not valid) and the dispatch call the thread hangs off. */
  meta: AgentMeta | null;
  link: Call | null;
  /** The latest `gitBranch` read (the main thread's names the session's). */
  gitBranch: string | null;
  lastOffset: number;
  chain: LiveChain;
  recs: Map<string, Rec>;
  /** Calls on the chain by call id, in chain order (those with a result are skipped when pairing). */
  open: Map<string, Call[]>;
  /** Details of recently emitted nodes and result outputs (`r:<uuid>`), oldest first, and their total size. */
  details: Map<string, { detail: Partial<NodeDetail>; size: number }>;
  detailChars: number;
  /** The last non-empty `custom_title` in the file, and the first prompt's title. */
  title: string | null;
  firstPrompt: string | null;
  cwd: string | null;
  firstMs: number | null;
  maxMs: number | null;
}

interface SessionState {
  session: Session;
  started: boolean;
  emitted: boolean;
  projectId: string;
  threads: Map<string, Thread>;
  nodes: Map<string, GraphNode>;
  /** Dispatch calls by node id. */
  dispatchByNode: Map<string, Call>;
  /** Which dispatch call each agent thread hangs off, kept incrementally (qwen-links.ts). */
  links: SubagentLinks<Thread, Call>;
  /** The title sidecar's name when its source is manual or auto (latest version). */
  sidecarTitle: string | null;
}

/** What the line being applied brought: details of its new nodes, its result output, whether its result paired. */
interface LineCtx {
  rec: Rec | null;
  fresh: Map<string, Partial<NodeDetail>>;
  output: unknown;
  orphan: boolean;
}

export class QwenNormalizer implements AgentNormalizer {
  private readonly sessions = new Map<string, SessionState>();
  private readonly restored = new Set<string>();

  apply(event: RawEvent, projectId: string): NormalizeResult {
    const r = this.applyBatch([{ event, projectId }]);
    const unknown = r.unknown[0];
    return unknown === undefined ? { changes: r.changes } : { changes: r.changes, unknownRecordType: unknown };
  }

  /** Lines one by one; the session row is emitted once more at the end of the batch. */
  applyBatch(items: readonly BatchItem[]): BatchResult {
    const changes: Change[] = [];
    const unknown: (string | undefined)[] = [];
    const touched = new Set<SessionState>();
    for (const { event, projectId } of items) {
      unknown.push(undefined);
      if (event.source === 'hook') continue; // Qwen Code has no hooks
      try {
        const state = this.stateFor(event.sessionId, projectId);
        touched.add(state);
        const ctx: LineCtx = { rec: null, fresh: new Map(), output: undefined, orphan: false };
        if (event.source === 'meta') this.meta(state, event, changes);
        else unknown[unknown.length - 1] = this.line(state, event, projectId, ctx, changes);
        this.relink(state, ctx, changes);
      } catch {
        unknown[unknown.length - 1] = 'qwen:normalizer-error';
      }
    }
    for (const state of touched) {
      try {
        if (state.started) this.commitSession(state, changes);
      } catch {
        unknown[unknown.length - 1] ??= 'qwen:normalizer-error';
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

  /** Before the session exists (subagent lines, sidecars): re-applied in order, their changes discarded. */
  restorePreSession(sessionId: string, events: Iterable<RawEvent>): void {
    this.dropSession(sessionId);
    for (const ev of events) {
      if (ev.sessionId !== sessionId || ev.source === 'hook') continue;
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

  /** Tool inputs held: only in the bounded detail cache (DETAIL_CACHE_CHARS per thread). */
  toolInputCount(sessionId: string): number {
    let count = 0;
    for (const t of this.sessions.get(sessionId)?.threads.values() ?? []) for (const e of t.details.values()) if (e.detail.input !== undefined) count += 1;
    return count;
  }

  // ---- state ----

  private stateFor(sessionId: string, projectId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (state === undefined) {
      state = {
        session: { id: sessionId, projectId, origin: 'qwen', cwd: null, title: null, gitBranch: null, status: 'idle', sourceDeleted: false, startedAt: EPOCH, lastActivityAt: EPOCH },
        started: false,
        emitted: false,
        projectId,
        threads: new Map(),
        nodes: new Map(),
        dispatchByNode: new Map(),
        links: new SubagentLinks<Thread, Call>(callOrder),
        sidecarTitle: null,
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /** The thread of an event: the main thread, or the agent thread of the file named `agent-<stem>`. */
  private thread(state: SessionState, stem: string | null): Thread {
    const key = stem === null ? MAIN : `a:${stem}`;
    let t = state.threads.get(key);
    if (t === undefined) {
      t = this.blankThread(key, stem);
      state.threads.set(key, t);
      if (stem !== null) state.links.setThread(t, linkInfo(t));
    }
    return t;
  }

  private blankThread(key: string, stem: string | null): Thread {
    return {
      key,
      stem,
      agentId: stem,
      fixed: false,
      recordId: null,
      agentName: null,
      meta: null,
      link: null,
      gitBranch: null,
      lastOffset: -1,
      chain: new LiveChain(),
      recs: new Map(),
      open: new Map(),
      details: new Map(),
      detailChars: 0,
      title: null,
      firstPrompt: null,
      cwd: null,
      firstMs: null,
      maxMs: null,
    };
  }

  private start(state: SessionState, changes: Change[]): void {
    if (state.started) return;
    state.started = true;
    this.commitSession(state, changes); // the session row before its first node
  }

  // ---- lines ----

  /** Applies one line of a thread; returns its unknown label. */
  private line(state: SessionState, event: Extract<RawEvent, { source: 'transcript' }>, projectId: string, ctx: LineCtx, changes: Change[]): string | undefined {
    const t = this.thread(state, event.agentId);
    if (event.offset <= t.lastOffset) this.resetThread(state, t, changes);
    t.lastOffset = event.offset;
    let obj: unknown;
    try {
      obj = JSON.parse(event.line);
    } catch {
      return 'qwen:invalid-json';
    }
    // Spec 4: an object; string uuid and sessionId; parentUuid a string or null; one of the four types.
    if (!isObject(obj) || typeof obj.uuid !== 'string' || typeof obj.sessionId !== 'string' || (typeof obj.parentUuid !== 'string' && obj.parentUuid !== null) || typeof obj.type !== 'string' || !TYPES.has(obj.type)) {
      return 'qwen:invalid-record';
    }
    if (t.stem === null && obj.sessionId !== event.sessionId) return 'qwen:session-mismatch';
    if (projectId !== 'unknown' && (event.agentId === null || state.projectId === 'unknown')) state.projectId = projectId;
    const ms = msOf(obj.timestamp);
    if (ms !== null) {
      t.firstMs ??= ms;
      t.maxMs = t.maxMs === null ? ms : Math.max(t.maxMs, ms);
    }
    const cwd = nonEmpty(obj.cwd);
    if (t.cwd === null && cwd !== null) t.cwd = own(cwd.slice(0, PATH_MAX_CHARS));
    const branch = nonEmpty(obj.gitBranch);
    if (branch !== null) t.gitBranch = own(head(branch, PATH_MAX_CHARS));
    if (t.stem === null) this.start(state, changes);
    else this.agentFacts(state, t, obj);
    const type = obj.type;
    const subtype = obj.subtype === undefined || obj.subtype === null ? null : obj.subtype;
    if (type === 'system' && typeof subtype === 'string' && (NON_CONVERSATION.has(subtype) || subtype.startsWith('managed_session_'))) return undefined;
    // Title (spec 7): the last custom_title in the file, wherever it is on the tree.
    if (type === 'system' && subtype === 'custom_title' && isObject(obj.systemPayload)) {
      const v = nonEmpty(obj.systemPayload.customTitle);
      if (v !== null) t.title = brief(v.trim());
    }
    const ts = ms === null ? null : new Date(ms).toISOString();
    const known = t.recs.get(obj.uuid);
    if (known !== undefined) return this.fragment(state, t, known, obj, ts, ctx, changes);
    const rec = this.newRec(state, t, obj, subtype, ts, ctx);
    ctx.rec = rec.rec;
    t.recs.set(obj.uuid, rec.rec);
    const gaps = t.chain.gaps;
    const cycles = t.chain.cycles;
    const step = t.chain.add({ uuid: obj.uuid, parentUuid: obj.parentUuid as string | null, conversation: true });
    this.reconcile(state, t, step.removed, step.added, ctx, changes);
    const anomaly = t.chain.gaps > gaps ? 'qwen:history-gap' : t.chain.cycles > cycles ? 'qwen:history-cycle' : undefined;
    return rec.unknown ?? (ctx.orphan ? 'qwen:orphan-result' : undefined) ?? anomaly;
  }

  /**
   * What an agent thread's record says about the thread (reference 5.2): the first valid record fixes the thread's id
   * (its `agentId`, else the file's name form), before any of its nodes is made; the first `agentName` names it.
   */
  private agentFacts(state: SessionState, t: Thread, obj: Obj): void {
    if (!t.fixed) {
      t.fixed = true;
      const id = nonEmpty(obj.agentId);
      if (id !== null) {
        t.recordId = own(head(id, ID_MAX_CHARS));
        t.agentId = t.recordId;
      }
      state.links.setThread(t, linkInfo(t));
    }
    if (t.agentName === null) {
      const name = nonEmpty(obj.agentName);
      if (name !== null) {
        t.agentName = brief(name.trim());
        state.links.touch(t); // its dispatch node's title
      }
    }
  }

  // ---- sidecars ----

  /**
   * A whole sidecar file (the latest version decides; an invalid or oversized one counts as none): the title sidecar
   * (spec 7, reference 1.4) or an agent's `.meta.json` (spec 6, reference 5.2).
   */
  private meta(state: SessionState, event: Extract<RawEvent, { source: 'meta' }>, changes: Change[]): void {
    if (event.agentId === null) {
      state.sidecarTitle = titleOfSidecar(event.payload);
      return;
    }
    const t = this.thread(state, event.agentId);
    const before = this.modelOf(t, null);
    t.meta = agentMetaOf(event.payload);
    state.links.setThread(t, linkInfo(t));
    if (this.modelOf(t, null) !== before) this.modelChanged(state, t, changes);
  }

  /** The model of a record's nodes: the record's own, else (an agent thread's records have none) the sidecar's. */
  private modelOf(t: Thread, rec: Rec | null): string | null {
    return rec?.model ?? (t.stem !== null ? (t.meta?.model ?? null) : null);
  }

  /** The thread's model changed: the `raw` of the details of its shown reply nodes follows (their text is not kept). */
  private modelChanged(state: SessionState, t: Thread, changes: Change[]): void {
    for (const uuid of t.chain.chain) {
      const rec = t.recs.get(uuid)!;
      if (rec.type !== 'assistant' || rec.model !== null) continue;
      for (const nf of rec.nodes) {
        if (!state.nodes.has(nf.id)) continue;
        const model = this.modelOf(t, rec);
        const raw = nf.call !== null && nf.call.result !== null ? this.resultRaw(t, nf.call) : model !== null ? { model } : null;
        changes.push({ type: 'node_updated', sessionId: state.session.id, id: nf.id, patch: {}, detail: { raw } });
      }
    }
  }

  /** The facts of a new record (and the details of its nodes, into `ctx` and the cache); its unknown label if any. */
  private newRec(state: SessionState, t: Thread, obj: Obj, subtype: unknown, ts: string | null, ctx: LineCtx): { rec: Rec; unknown?: string } {
    const uuid = obj.uuid as string;
    const type = obj.type as string;
    const rec: Rec = {
      uuid,
      type,
      nodes: [],
      partCount: 0,
      opensTurn: false,
      status: null,
      auth: null,
      usage: null,
      usageNow: null,
      model: null,
      cwd: nonEmpty(obj.cwd) === null ? t.cwd : own((obj.cwd as string).slice(0, PATH_MAX_CHARS)),
      result: null,
      ts,
      after: null,
      attachedTo: null,
    };
    const unknown = (): { rec: Rec; unknown: string } => ({ rec, unknown: unknownTypeName('qwen', `${type}/${typeof subtype === 'string' ? subtype : ''}`) });
    const sp = isObject(obj.systemPayload) ? obj.systemPayload : {};
    const node = (part: string, kind: GraphNode['kind'], title: string, summary: string, systemSubtype: string | null, detail: Partial<NodeDetail>): void => {
      const nf: NodeFacts = { id: qwenNodeId(state.session.id, t.agentId, uuid, part), rec, kind, title, summary, systemSubtype, ts, call: null, extras: null };
      rec.nodes.push(nf);
      this.fresh(t, ctx, nf.id, detail);
    };
    switch (type) {
      case 'user': {
        // A message delivered to a running agent (reference 5.2, `externalInputKind`): not typed into this thread as a
        // prompt, so a system node in the current turn, as notices are (spec 4.1).
        const external = obj.externalInputKind;
        if (t.stem !== null && subtype === null && (external === 'message' || external === 'notification')) {
          const text = (isObject(obj.systemPayload) ? str(obj.systemPayload.displayText) : null) ?? partsText(obj);
          node('system', 'system', external === 'message' ? 'Message' : 'Notification', brief(text), 'external_input', { text });
          break;
        }
        const kind = classifyUser(obj);
        if (kind === 'unknown') return unknown();
        if (kind === 'hidden') break;
        if (kind === 'notice') {
          const text = str(sp.displayText) ?? partsText(obj);
          node('system', 'system', subtype === 'cron' ? 'Cron' : 'Notification', brief(text), subtype as string, { text });
          break;
        }
        const { text: shown, images } = promptText(obj);
        const text = [shown, ...Array<string>(images).fill('[image]')].filter((s) => s !== '').join('\n');
        if (kind === 'mod-prompt') node('system', 'system', 'Mod prompt', brief(text), 'mod_prompt', { text });
        else node('prompt', 'prompt', 'Prompt', brief(text), null, { text });
        rec.opensTurn = kind !== 'mid-turn-prompt';
        rec.status = 'running';
        if (isObject(obj.executionContext)) rec.auth = nonEmpty(obj.executionContext.authType);
        if ((kind === 'prompt' || kind === 'mod-prompt') && t.firstPrompt === null) {
          const title = promptTitle(head(firstPromptText(obj), PREFIX_MAX));
          if (title !== null) t.firstPrompt = own(title);
        }
        break;
      }
      case 'assistant': {
        if (subtype !== null && subtype !== 'realtime_message') return unknown();
        rec.model = nonEmpty(obj.model) === null ? null : brief(obj.model as string);
        rec.usage = usageFields(obj.usageMetadata);
        this.appendParts(state, t, rec, obj, ts, ctx);
        break;
      }
      case 'tool_result': {
        if (subtype !== null) {
          if (typeof subtype === 'string' && QUIET_RESULTS.has(subtype)) break;
          return unknown();
        }
        rec.result = this.resultFacts(t, rec, obj, ctx);
        break;
      }
      case 'system': {
        switch (subtype) {
          case 'chat_compression': {
            // The two counts only: compressedHistory never enters a detail (spec 4.4).
            const info = isObject(sp.info) ? sp.info : {};
            const before = typeof info.originalTokenCount === 'number' ? info.originalTokenCount : null;
            const after = typeof info.newTokenCount === 'number' ? info.newTokenCount : null;
            const text = `Context compressed: ${before ?? '?'} → ${after ?? '?'} tokens`;
            node('compact', 'system', 'Compact', text, 'compact', { text, raw: { originalTokenCount: before, newTokenCount: after } });
            break;
          }
          case 'slash_command': {
            const raw = nonEmpty(sp.rawCommand);
            if (sp.phase === 'invocation' && sp.hiddenInvocation !== true && raw !== null) node('command', 'system', 'Command', brief(raw), 'slash_command', { text: raw });
            break;
          }
          case 'turn_result': {
            rec.status = 'idle';
            if (sp.state === 'error') {
              const text = errorText(sp.error);
              node('turn-end', 'system', 'Turn failed', brief(text), 'interrupt', { text });
            } else if (sp.state === 'cancelled') node('turn-end', 'system', 'Interrupted', '', 'interrupt', {});
            break;
          }
          case 'session_model':
            rec.auth = nonEmpty(sp.authType);
            break;
          case 'custom_title':
            break;
          default:
            if (typeof subtype === 'string' && QUIET_SYSTEM.has(subtype)) break;
            return unknown();
        }
        break;
      }
    }
    return { rec };
  }

  /**
   * Nodes of an assistant record's parts (spec 4.1), numbered on from the parts read before (fragments). Their details
   * leave out the model: it is added when a node is emitted (an agent thread's comes from its sidecar).
   */
  private appendParts(state: SessionState, t: Thread, rec: Rec, obj: Obj, ts: string | null, ctx: LineCtx): void {
    const parts = isObject(obj.message) && Array.isArray(obj.message.parts) ? obj.message.parts : [];
    const base = rec.partCount;
    rec.partCount += parts.length;
    parts.forEach((p, j) => {
      if (!isObject(p)) return;
      const i = base + j;
      const add = (part: string, kind: GraphNode['kind'], title: string, summary: string, detail: Partial<NodeDetail>): NodeFacts => {
        const nf: NodeFacts = { id: qwenNodeId(state.session.id, t.agentId, rec.uuid, part), rec, kind, title, summary, systemSubtype: null, ts, call: null, extras: null };
        rec.nodes.push(nf);
        this.fresh(t, ctx, nf.id, detail);
        return nf;
      };
      if (isObject(p.functionCall)) {
        const fc = p.functionCall;
        const name = nonEmpty(fc.name) === null ? 'unknown' : brief(fc.name as string);
        const callId = nonEmpty(fc.id) === null ? null : own(fc.id as string);
        let part = callId !== null ? `call:${callId}` : `call#${i}`;
        if (rec.nodes.some((n) => n.id === qwenNodeId(state.session.id, t.agentId, rec.uuid, part))) part = `call#${i}`;
        const args = fc.args;
        const dispatch = DISPATCH_TOOLS.has(name);
        const rawLabel = dispatch && isObject(args) ? nonEmpty(args.subagent_type) : null;
        const label = rawLabel !== null ? brief(rawLabel) : null;
        const nf = add(part, dispatch ? 'subagent' : 'tool', label ?? name, own(toolSummary(args)), { input: args ?? null });
        const call: Call = {
          nf,
          thread: t,
          callId,
          name,
          inputKey: inputKeyOf(name, args),
          files: dispatch ? {} : nodeFiles(qwenTouches(name, args).map((x) => ({ path: own(x.path.slice(0, PATH_MAX_CHARS)), action: x.action })), rec.cwd),
          result: null,
          shown: null,
          dispatch,
          label,
          child: null,
        };
        nf.call = call;
        if (dispatch) state.dispatchByNode.set(nf.id, call);
        return;
      }
      if (typeof p.text === 'string') {
        if (p.text.trim() === '') return;
        if (p.thought === true) add(`thought:${i}`, 'thinking', 'Thinking', brief(p.text), { text: p.text });
        else add(`text:${i}`, 'text', 'Text', brief(p.text), { text: p.text });
        return;
      }
      // Media (reference 2.2: inlineData, fileData) is an [image]; any other shape (a signature alone, an empty or
      // unknown part, a functionResponse) shows nothing.
      if (isObject(p.inlineData) || isObject(p.fileData)) add(`text:${i}`, 'text', 'Text', '[image]', { text: '[image]' });
    });
  }

  /** A tool result's facts (spec 4.2); its output goes to `ctx` and the cache, keyed by the record. */
  private resultFacts(t: Thread, rec: Rec, obj: Obj, ctx: LineCtx): ResultFacts {
    const parts = isObject(obj.message) && Array.isArray(obj.message.parts) ? obj.message.parts : [];
    const fr = parts.map((p) => (isObject(p) && isObject(p.functionResponse) ? p.functionResponse : null)).find((x) => x !== null) ?? null;
    const tcr = isObject(obj.toolCallResult) ? obj.toolCallResult : {};
    const response = fr !== null && isObject(fr.response) ? fr.response : {};
    const callId = nonEmpty(fr?.id) ?? nonEmpty(tcr.callId);
    const output = outputOf(parts);
    ctx.output = output ?? null;
    this.cachePut(t, `r:${rec.uuid}`, { output: ctx.output });
    const display = str(tcr.resultDisplay);
    return {
      callId: callId === null ? null : own(callId),
      name: nonEmpty(fr?.name) === null ? null : brief(fr!.name as string),
      failed: tcr.status === 'error' || tcr.status === 'cancelled' || response.error !== undefined,
      cancelled: tcr.status === 'cancelled',
      display: display === null ? null : brief(display),
      call: null,
    };
  }

  /**
   * A later line with a known uuid (spec 4.1): an assistant record's parts and latest usage join it. Any other fragment
   * (of a user, tool_result or system record; or of another type than the record's) adds nothing and is counted: its
   * merge would need the earlier text, which is not kept.
   */
  private fragment(state: SessionState, t: Thread, rec: Rec, obj: Obj, ts: string | null, ctx: LineCtx, changes: Change[]): string | undefined {
    if (obj.type !== rec.type || rec.type !== 'assistant') return FRAGMENT_IGNORED;
    if (obj.subtype !== undefined && obj.subtype !== null && obj.subtype !== 'realtime_message') return FRAGMENT_IGNORED;
    const usage = usageFields(obj.usageMetadata);
    if (usage !== null) rec.usage = usage;
    this.appendParts(state, t, rec, obj, ts, ctx);
    const at = t.chain.indexOf(rec.uuid);
    if (at < 0) return undefined; // off the chain: its facts wait for it
    const chain = t.chain.chain;
    const dirty = new Set<NodeFacts>();
    for (let i = chain.length - 1; i >= at; i--) this.unwind(t, t.recs.get(chain[i]!)!, dirty);
    this.walk(state, t, at, ctx, dirty, changes);
    for (const nf of dirty) this.refresh(state, t, nf, ctx, changes);
    return undefined;
  }

  // ---- the chain ----

  /** The chain changed: the records that left are undone and their nodes removed; those that joined are walked. */
  private reconcile(state: SessionState, t: Thread, removed: readonly string[], added: readonly string[], ctx: LineCtx, changes: Change[]): void {
    const dirty = new Set<NodeFacts>();
    for (let k = removed.length - 1; k >= 0; k--) this.unwind(t, t.recs.get(removed[k]!)!, dirty);
    for (const uuid of removed) for (const nf of t.recs.get(uuid)!.nodes) this.removeNode(state, nf.id, changes);
    if (added.length > 0) this.walk(state, t, t.chain.indexOf(added[0]!), ctx, dirty, changes);
    for (const nf of dirty) this.refresh(state, t, nf, ctx, changes);
  }

  /** Takes back what a record did on the walk (newest records first): its result's pairing, its calls, its usage. */
  private unwind(t: Thread, rec: Rec, dirty: Set<NodeFacts>): void {
    const res = rec.result;
    if (res !== null && res.call !== null) {
      res.call.result = null;
      dirty.add(res.call.nf);
      res.call = null;
    }
    for (let k = rec.nodes.length - 1; k >= 0; k--) {
      const call = rec.nodes[k]!.call;
      if (call === null || call.callId === null) continue;
      const list = t.open.get(call.callId);
      if (list === undefined) continue;
      const at = list.lastIndexOf(call);
      if (at >= 0) list.splice(at, 1);
      if (list.length === 0) t.open.delete(call.callId);
    }
    if (rec.attachedTo !== null) {
      rec.attachedTo.extras?.delete(rec.uuid);
      dirty.add(rec.attachedTo);
      rec.attachedTo = null;
    }
    rec.after = null;
  }

  /** Walks the chain from index `from` with the walk state stored before it, emitting each record's nodes as derived. */
  private walk(state: SessionState, t: Thread, from: number, ctx: LineCtx, dirty: Set<NodeFacts>, changes: Change[]): void {
    const chain = t.chain.chain;
    let ws: Walk = from > 0 ? { ...t.recs.get(chain[from - 1]!)!.after! } : { prev: null, prevTs: null, turn: null, auth: null, status: null, reply: null };
    for (let i = from; i < chain.length; i++) {
      const rec = t.recs.get(chain[i]!)!;
      this.step(state, t, rec, ws, ctx, dirty, changes);
      rec.after = ws;
      ws = { ...ws };
    }
  }

  /** One record of the walk. */
  private step(state: SessionState, t: Thread, rec: Rec, ws: Walk, ctx: LineCtx, dirty: Set<NodeFacts>, changes: Change[]): void {
    const res = rec.result;
    if (res !== null) {
      const call = this.findCall(t, res, ws);
      if (call !== null) {
        call.result = rec;
        res.call = call;
        dirty.add(call.nf);
      } else if (ctx.rec === rec) ctx.orphan = true;
    }
    // An agent thread's records carry no auth type (reference 5.2), so its usage takes the "other" rule (spec 4.5):
    // borrowing the main thread's would make the numbers depend on which file was read first.
    rec.usageNow = rec.usage === null ? null : qwenUsage(rec.usage, ws.auth);
    rec.nodes.forEach((nf, k) => {
      if (rec.opensTurn && k === 0) ws.turn = nf.id;
      const ts = nf.ts ?? ws.prevTs ?? EPOCH;
      // The thread's first node hangs off the dispatch call it is linked to (a spawn edge), if any.
      if (ws.prev !== null) this.emit(state, t, nf, ws.prev.id, 'sequence', ws.turn, ts, ctx, changes);
      else this.emit(state, t, nf, this.linkNode(state, t), 'spawn', ws.turn, ts, ctx, changes);
      ws.prev = nf;
      ws.prevTs = ts;
      const call = nf.call;
      if (call !== null && call.callId !== null) {
        const list = t.open.get(call.callId);
        if (list === undefined) t.open.set(call.callId, [call]);
        else list.push(call);
      }
    });
    if (rec.nodes.length === 0 && rec.usageNow !== null && ws.prev !== null) {
      (ws.prev.extras ??= new Map()).set(rec.uuid, rec.usageNow);
      rec.attachedTo = ws.prev;
      dirty.add(ws.prev);
    }
    if (rec.auth !== null) ws.auth = rec.auth;
    if (rec.status !== null) ws.status = rec.status;
    if (rec.type === 'assistant') ws.reply = rec.nodes.some((n) => n.call !== null) ? rec : null;
  }

  /** The call a result pairs with (spec 4.2): by id, the nearest on the chain without a result; without, by name in the reply it follows. */
  private findCall(t: Thread, res: ResultFacts, ws: Walk): Call | null {
    if (res.callId !== null) {
      const list = t.open.get(res.callId);
      if (list === undefined) return null;
      for (let k = list.length - 1; k >= 0; k--) if (list[k]!.result === null) return list[k]!;
      return null;
    }
    if (ws.reply === null) return null;
    for (const nf of ws.reply.nodes) {
      const c = nf.call;
      if (c !== null && c.result === null && (res.name === null || c.name === res.name)) return c;
    }
    return null;
  }

  // ---- nodes ----

  /** The node as its facts and place say. */
  private build(state: SessionState, t: Thread, nf: NodeFacts, parentId: string | null, turnId: string | null, timestamp: string): GraphNode {
    const call = nf.call;
    let usage = nf.rec.nodes[0] === nf ? nf.rec.usageNow : null;
    if (nf.extras !== null) for (const u of nf.extras.values()) usage = addUsage(usage, u);
    let status: GraphNode['status'] = null;
    let endedAt: string | null = null;
    let durationMs: number | null = null;
    if (call !== null) {
      const res = call.result;
      if (res === null) status = 'running';
      else {
        status = res.result!.failed ? 'failed' : 'succeeded';
        endedAt = res.ts ?? timestamp;
        durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(timestamp)) || 0;
      }
    }
    return {
      id: nf.id,
      sessionId: state.session.id,
      turnId,
      agentId: t.agentId,
      childAgentId: call?.child?.agentId ?? null,
      parentId,
      kind: nf.kind,
      status,
      timestamp,
      confirmed: true,
      title: call !== null && call.dispatch ? dispatchTitle(call) : nf.title,
      summary: nf.summary,
      toolName: call?.name ?? null,
      toolUseId: call?.callId ?? null,
      messageId: nf.rec.uuid,
      durationMs,
      endedAt,
      usage,
      systemSubtype: nf.systemSubtype,
      ...filesFields(call?.files ?? {}),
      ...inputKeyFields(call?.inputKey),
    };
  }

  /** Emits one node of the walk: added (with its detail), or what differs; and the edge into it (of `kind`). */
  private emit(
    state: SessionState,
    t: Thread,
    nf: NodeFacts,
    parentId: string | null,
    kind: 'sequence' | 'spawn',
    turnId: string | null,
    timestamp: string,
    ctx: LineCtx,
    changes: Change[],
  ): void {
    const sid = state.session.id;
    const node = this.build(state, t, nf, parentId, turnId, timestamp);
    const old = state.nodes.get(nf.id);
    const call = nf.call;
    if (old === undefined) {
      let detail: Partial<NodeDetail> = ctx.fresh.get(nf.id) ?? this.cached(t, nf.id) ?? { unreadable: true };
      const model = nf.rec.type === 'assistant' ? this.modelOf(t, nf.rec) : null;
      if (model !== null) detail = { ...detail, raw: { model } };
      if (call !== null && call.result !== null) detail = { ...detail, ...this.resultDetail(t, call, ctx) };
      if (call !== null) call.shown = call.result;
      if (call !== null && call.dispatch) state.links.show(call);
      state.nodes.set(nf.id, node);
      changes.push({ type: 'node_added', node, detail });
      if (parentId !== null) changes.push({ type: 'edge_added', edge: { id: `${parentId}->${nf.id}`, sessionId: sid, from: parentId, to: nf.id, kind } });
      return;
    }
    this.update(state, t, old, node, call, ctx, changes);
    if (old.parentId !== parentId) {
      if (old.parentId !== null && state.nodes.has(old.parentId)) changes.push({ type: 'edge_removed', sessionId: sid, id: `${old.parentId}->${nf.id}` });
      if (parentId !== null) changes.push({ type: 'edge_added', edge: { id: `${parentId}->${nf.id}`, sessionId: sid, from: parentId, to: nf.id, kind } });
    }
  }

  /** Re-derives a node outside the walk (a call whose result changed, a node whose attached usage changed). */
  private refresh(state: SessionState, t: Thread, nf: NodeFacts, ctx: LineCtx, changes: Change[]): void {
    const old = state.nodes.get(nf.id);
    if (old === undefined) return;
    this.update(state, t, old, this.build(state, t, nf, old.parentId, old.turnId, old.timestamp), nf.call, ctx, changes);
  }

  /** Emits what differs between an emitted node and `next`, and a call's result detail when its result changed. */
  private update(state: SessionState, t: Thread, old: GraphNode, next: GraphNode, call: Call | null, ctx: LineCtx, changes: Change[]): void {
    const patch = nodePatch(old, next);
    const detail = call !== null && call.shown !== call.result ? this.resultDetail(t, call, ctx) : undefined;
    if (call !== null) call.shown = call.result;
    if (Object.keys(patch).length === 0 && detail === undefined) return;
    state.nodes.set(next.id, { ...old, ...patch });
    changes.push({ type: 'node_updated', sessionId: state.session.id, id: next.id, patch, ...(detail !== undefined ? { detail } : {}) });
  }

  /** A call's result detail: the paired result's output (from the line, else the cache), or none. */
  private resultDetail(t: Thread, call: Call, ctx: LineCtx): Partial<NodeDetail> {
    const res = call.result;
    let output: unknown = null;
    if (res !== null) output = ctx.rec === res ? ctx.output : (this.cached(t, `r:${res.uuid}`)?.output ?? null);
    return { output, raw: this.resultRaw(t, call) };
  }

  /** The `raw` of a call's result detail: model, result display, cancellation (null when none). */
  private resultRaw(t: Thread, call: Call): Obj | null {
    const facts = call.result?.result ?? null;
    const raw: Obj = {};
    const model = this.modelOf(t, call.nf.rec);
    if (model !== null) raw.model = model;
    if (facts !== null && facts.display !== null) raw.resultDisplay = facts.display;
    if (facts !== null && facts.cancelled) raw.cancelled = true;
    return Object.keys(raw).length > 0 ? raw : null;
  }

  private removeNode(state: SessionState, id: string, changes: Change[]): void {
    if (!state.nodes.delete(id)) return;
    changes.push({ type: 'node_removed', sessionId: state.session.id, id }); // the store drops its edges
    const call = state.dispatchByNode.get(id);
    if (call === undefined) return;
    // A dispatch node left: its thread's first node loses the parent now (it may come back within this event, in which
    // case the spawn edge, dropped with the node, is added again when the links are recomputed).
    state.links.hide(call);
    const child = call.child;
    if (child === null || child.link !== call) return;
    const first = this.firstNode(state, child);
    const node = first === null ? undefined : state.nodes.get(first);
    if (node === undefined || node.parentId !== id) return;
    state.nodes.set(node.id, { ...node, parentId: null });
    changes.push({ type: 'node_updated', sessionId: state.session.id, id: node.id, patch: { parentId: null } });
  }

  // ---- subagent links ----

  /** The node of the dispatch call the thread hangs off (when it is shown). */
  private linkNode(state: SessionState, t: Thread): string | null {
    return t.link !== null && state.nodes.has(t.link.nf.id) ? t.link.nf.id : null;
  }

  /** The thread's first shown node (its chain's first record that shows one). */
  private firstNode(state: SessionState, t: Thread): string | null {
    for (const uuid of t.chain.chain) {
      const rec = t.recs.get(uuid)!;
      if (rec.nodes.length > 0) return state.nodes.has(rec.nodes[0]!.id) ? rec.nodes[0]!.id : null;
    }
    return null;
  }

  /**
   * Applies what the link index decided since the last event (spec 6, reference 5.3; the rules are in qwen-links.ts):
   * each call whose child changed shows it (childAgentId, title), and each thread decided again or touched has its first
   * node hang off its call by a spawn edge, or off nothing. Costs what the event touched.
   */
  private relink(state: SessionState, ctx: LineCtx, changes: Change[]): void {
    const { changed, touched } = state.links.settle();
    if (changed.length === 0 && touched.length === 0) return;
    const calls = new Set<Call>();
    for (const t of changed) {
      const old = t.link;
      if (old !== null && old.child === t) {
        old.child = null;
        calls.add(old);
      }
    }
    for (const t of changed) {
      t.link = state.links.linkOf(t);
      if (t.link !== null) {
        t.link.child = t;
        calls.add(t.link);
      }
    }
    for (const t of touched) if (t.link !== null) calls.add(t.link);
    for (const c of calls) this.refresh(state, c.thread, c.nf, ctx, changes);
    for (const t of touched) this.placeFirst(state, t, changes);
  }

  /** The thread's first node hangs off its dispatch node (a spawn edge), or off nothing. */
  private placeFirst(state: SessionState, t: Thread, changes: Change[]): void {
    const first = this.firstNode(state, t);
    if (first === null) return;
    const node = state.nodes.get(first)!;
    const parent = this.linkNode(state, t);
    if (node.parentId === parent) return;
    const sid = state.session.id;
    if (node.parentId !== null && state.nodes.has(node.parentId)) changes.push({ type: 'edge_removed', sessionId: sid, id: `${node.parentId}->${first}` });
    state.nodes.set(first, { ...node, parentId: parent });
    changes.push({ type: 'node_updated', sessionId: sid, id: first, patch: { parentId: parent } });
    if (parent !== null) changes.push({ type: 'edge_added', edge: { id: `${parent}->${first}`, sessionId: sid, from: parent, to: first, kind: 'spawn' } });
  }

  // ---- the detail cache ----

  /** The details of a node of the line being applied: emitted from `ctx`, remembered in the cache. */
  private fresh(t: Thread, ctx: LineCtx, id: string, detail: Partial<NodeDetail>): void {
    ctx.fresh.set(id, detail);
    this.cachePut(t, id, detail);
  }

  private cachePut(t: Thread, key: string, detail: Partial<NodeDetail>): void {
    const old = t.details.get(key);
    if (old !== undefined) {
      t.details.delete(key);
      t.detailChars -= old.size;
    }
    const size = detailChars(detail);
    if (size > DETAIL_CACHE_CHARS) return;
    t.details.set(key, { detail, size });
    t.detailChars += size;
    for (const [k, e] of t.details) {
      if (t.detailChars <= DETAIL_CACHE_CHARS) break;
      t.details.delete(k);
      t.detailChars -= e.size;
    }
  }

  private cached(t: Thread, key: string): Partial<NodeDetail> | undefined {
    const e = t.details.get(key);
    return e === undefined ? undefined : { ...e.detail };
  }

  // ---- restarts ----

  /** The thread's file is read again from its start: everything its old content made is removed. */
  private resetThread(state: SessionState, t: Thread, changes: Change[]): void {
    for (const rec of t.recs.values()) {
      for (const nf of rec.nodes) {
        this.removeNode(state, nf.id, changes);
        const call = nf.call;
        if (call !== null && call.dispatch) state.dispatchByNode.delete(nf.id);
      }
    }
    // The sidecar is another file: it stays, and so does the link until the links are recomputed.
    Object.assign(t, this.blankThread(t.key, t.stem), { meta: t.meta, link: t.link });
    if (t.stem !== null) state.links.setThread(t, linkInfo(t)); // its id is decided again by its first record
  }

  // ---- session ----

  /**
   * The session as a function of what was read (spec 7, 8): title = the last custom_title of the main file, else the
   * title sidecar (source manual or auto), else its first prompt; cwd = its first record's; git branch = the latest
   * one its records name; started = its first record's time, last activity = the latest time read (agent threads
   * too); status = running when the last status record on the main chain is a prompt, idle when it is a turn_result or
   * there is none (agent threads never count).
   */
  private commitSession(state: SessionState, changes: Change[]): void {
    const main = state.threads.get(MAIN);
    let maxMs: number | null = null;
    for (const th of state.threads.values()) if (th.maxMs !== null) maxMs = maxMs === null ? th.maxMs : Math.max(maxMs, th.maxMs);
    const first = main?.firstMs ?? null;
    const startedAt = first === null ? EPOCH : new Date(first).toISOString();
    const lastActivityAt = new Date(Math.max(maxMs ?? Number.NEGATIVE_INFINITY, Date.parse(startedAt))).toISOString();
    const chain = main?.chain.chain ?? [];
    const last = chain.length === 0 ? undefined : main!.recs.get(chain[chain.length - 1]!);
    const next: Session = {
      ...state.session,
      projectId: state.projectId,
      cwd: main?.cwd ?? null,
      title: main?.title ?? state.sidecarTitle ?? main?.firstPrompt ?? null,
      gitBranch: main?.gitBranch ?? null,
      status: last?.after?.status === 'running' ? 'running' : 'idle',
      startedAt,
      lastActivityAt,
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

/** The numeric fields of a `usageMetadata` (a small copy; null when it has none). */
function usageFields(v: unknown): Obj | null {
  if (!isObject(v)) return null;
  const out: Obj = {};
  for (const k of USAGE_FIELDS) if (typeof v[k] === 'number' && Number.isFinite(v[k])) out[k] = v[k];
  return Object.keys(out).length === 0 ? null : out;
}

/** A dispatch node's title (spec 6): the linked agent's sidecar agentType, its records' agentName, the call's subagent_type, the tool name. */
function dispatchTitle(call: Call): string {
  const child = call.child;
  return child?.meta?.agentType ?? child?.agentName ?? call.label ?? call.name;
}

/** What an agent thread's link depends on: its id (records', else sidecar's, else file's) and its valid sidecar. */
function linkInfo(t: Thread): LinkInfo {
  const m = t.meta;
  return { realId: t.recordId ?? m?.agentId ?? t.stem!, sidecar: m === null ? null : { toolUseId: m.toolUseId, parentAgentId: m.parentAgentId } };
}

/** The order of dispatch calls for linking: main thread first, then agent threads by key; chain order; part order. */
function callOrder(a: Call, b: Call): number {
  if (a.thread !== b.thread) return a.thread.key < b.thread.key ? -1 : 1;
  return a.thread.chain.indexOf(a.nf.rec.uuid) - b.thread.chain.indexOf(b.nf.rec.uuid) || a.nf.rec.nodes.indexOf(a.nf) - b.nf.rec.nodes.indexOf(b.nf);
}

/**
 * The first-prompt title's text (reference 6, rule 3, the product's rule): `systemPayload.displayText` whenever that
 * key exists (empty: none, the next prompt is tried), otherwise the first text part.
 */
function firstPromptText(obj: Obj): string {
  const sp = obj.systemPayload;
  if (isObject(sp) && 'displayText' in sp) return typeof sp.displayText === 'string' ? sp.displayText : '';
  const parts = isObject(obj.message) && Array.isArray(obj.message.parts) ? obj.message.parts : [];
  for (const p of parts) if (isObject(p) && typeof p.text === 'string' && p.thought !== true) return p.text;
  return '';
}

/** The title sidecar's name (reference 1.4) when its source is manual or auto; null when it is not, or it is invalid or too large. */
function titleOfSidecar(payload: string): string | null {
  if (payload.length > TITLE_SIDECAR_MAX_CHARS) return null;
  let v: unknown;
  try {
    v = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isObject(v) || (v.source !== 'manual' && v.source !== 'auto')) return null;
  const name = nonEmpty(v.displayName);
  return name === null ? null : brief(name.trim());
}

/** An agent sidecar's fields (reference 5.2); null when it is invalid or too large. */
function agentMetaOf(payload: string): AgentMeta | null {
  if (payload.length > AGENT_META_MAX_CHARS) return null;
  let v: unknown;
  try {
    v = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isObject(v)) return null;
  const id = (x: unknown): string | null => {
    const s = nonEmpty(x);
    return s === null ? null : own(head(s, ID_MAX_CHARS));
  };
  const label = (x: unknown): string | null => {
    const s = nonEmpty(x);
    return s === null ? null : brief(s.trim());
  };
  return { agentId: id(v.agentId), agentType: label(v.agentType), toolUseId: id(v.toolUseId), parentAgentId: id(v.parentAgentId), model: label(v.model) };
}

/** Text parts of a record joined (a notice without displayText). */
function partsText(obj: Obj): string {
  const parts = isObject(obj.message) && Array.isArray(obj.message.parts) ? obj.message.parts : [];
  let out = '';
  for (const p of parts) if (isObject(p) && typeof p.text === 'string' && p.thought !== true) out += p.text;
  return out;
}

/** The text of a turn_result's `error`: a string, an object's message, else its JSON. */
function errorText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (isObject(e) && typeof e.message === 'string') return e.message;
  if (e === undefined || e === null) return '';
  return JSON.stringify(e) ?? '';
}
