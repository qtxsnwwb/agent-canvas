import { createHash } from 'node:crypto';
import type { Change, GraphNode, NodeDetail, Session, Usage } from '@agent-canvas/shared';
import { parseWorkspaceYaml, type CopilotWorkspace } from '../sources/copilot/workspace.js';
import type { RawEvent } from '../store/store.js';
import { promptTitle } from './codex.js';
import { copilotTouches, filesFields, nodeFiles } from './files.js';
import { nodePatch } from './gemini.js';
import { inputKeyFields, inputKeyOf } from './input-key.js';
import { summarize } from './summary.js';
import type { AgentNormalizer, BatchItem, BatchResult, NormalizeResult } from './types.js';
import { unknownTypeName } from './unknown-type.js';

/*
 * The GitHub Copilot CLI normalizer (spec 5.3). A session's `events.jsonl` is a list of events in file order; each event
 * is applied once, in order, to the session's state and emits the graph changes it causes (O(1) work per event, apart
 * from the event's own content). Node ids come from the session id and the event's `id` (a hash of the line when it
 * has none); a tool call's node from its `toolCallId`. An event whose node already exists adds nothing, so a file
 * re-read from the start (Copilot rewrites it after damage) never duplicates a node.
 *
 * Threads: events without `agentId` are the main thread; events with one form that agent's thread, chained on their
 * own. A thread's first node hangs off the call that started the agent (spawn edge), found in this order: the event's
 * `data.parentToolCallId`; a call whose `toolCallId` equals the `agentId`; the oldest `subagent.started` not yet
 * claimed. A thread none applies to is shown unattached (parentId null) and is attached later if an event of it names
 * its call, or a call with its id appears.
 */

const EPOCH = '1970-01-01T00:00:00.000Z';
const MAIN = '';
/**
 * Known types that produce no node (spec 5.3 "其余已知但无需显示", and the SDK's other display-free events): never
 * reported. session.resume / session.context_changed are read for status and branch, session.model_change not at all.
 */
const IGNORED = new Set([
  'assistant.turn_start',
  'assistant.turn_end',
  'assistant.intent',
  'assistant.idle',
  'assistant.usage',
  'assistant.message_delta',
  'assistant.reasoning_delta',
  'session.resume',
  'session.info',
  'session.idle',
  'session.warning',
  'session.model_change',
  'session.context_changed',
  'session.title_changed',
  'session.usage_info',
  'session.mode_changed',
  'session.plan_changed',
  'session.todos_changed',
  'session.workspace_file_changed',
  'session.compaction_start',
  'session.compaction_summarized',
  'session.remote_steerable_changed',
  'session.task_complete',
  'session.journal_link',
  'tool.user_requested',
  'tool.execution_partial_result',
  'tool.execution_progress',
  'tool.shell_output',
  'subagent.selected',
  'subagent.deselected',
  'subagent.configured',
  'pending_messages.modified',
  'system.message',
  'skill.invoked',
  'model.call_failure',
  'model.call_finished',
]);
/** Prefixes of display-free event families (`hook.start`, `permission.requested`, …). */
const IGNORED_PREFIXES = ['hook.', 'permission.', 'user_input.', 'elicitation.', 'exit_plan_mode.', 'ide.'];
/** Events that bring an ended session back to running (spec: `session.resume` after `session.shutdown`). */
const REVIVE = new Set(['session.start', 'session.resume', 'user.message']);
const SUBAGENT_TOOLS = new Set(['task']);
const SUMMARY_KEYS = ['command', 'fullCommandText', 'path', 'file_path', 'filePath', 'fileName', 'pattern', 'url', 'query', 'prompt', 'description'];

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
function msOf(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}
const isoOfMs = (ms: number): string => new Date(ms).toISOString();

/** The id of a Copilot node: `copilot:<session id>:<part>` (part = an event id, `call:<toolCallId>`, …). */
export function copilotNodeId(sessionId: string, part: string): string {
  return `copilot:${sessionId}:${part}`;
}

/** `arguments` as the tool got them: a JSON string parsed when it parses (spec 5.3), else as given. */
function parseArgs(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}

function toolSummary(args: unknown): string {
  if (!isObject(args)) return args === undefined || args === null ? '' : summarize(args);
  for (const k of SUMMARY_KEYS) {
    const v = nonEmpty(args[k]);
    if (v !== null) return summarize(v.trim());
  }
  for (const v of Object.values(args)) if (typeof v === 'string' && v.trim() !== '') return summarize(v.trim());
  return Object.keys(args).length === 0 ? '' : summarize(args);
}

/** A dispatch's agent name from its arguments. */
function agentFromArgs(args: unknown): string | null {
  if (!isObject(args)) return null;
  for (const k of ['agent_type', 'agentType', 'agentName', 'name']) {
    const v = nonEmpty(args[k]);
    if (v !== null) return v;
  }
  return null;
}

/** Session usage from `session.shutdown.data.modelMetrics`: every model's usage summed (spec 5.3). */
function shutdownUsage(metrics: unknown): Usage | null {
  if (!isObject(metrics)) return null;
  let input = 0;
  let cached = 0;
  let output = 0;
  let any = false;
  for (const m of Object.values(metrics)) {
    if (!isObject(m) || !isObject(m.usage)) continue;
    const u = m.usage;
    any = true;
    // Usage categories (shared Usage): cache writes count as new input, cache reads as cached input.
    input += num(u.inputTokens) + num(u.cacheWriteTokens);
    cached += num(u.cacheReadTokens);
    output += num(u.outputTokens);
  }
  return any ? { inputTokens: input, cachedInputTokens: cached, outputTokens: output } : null;
}

interface Thread {
  agentId: string | null;
  /** The last node of the thread. */
  prev: string | null;
  prevTs: string | null;
  /** The thread's open turn (its latest prompt). */
  turn: string | null;
  /** The thread's first node. */
  first: string | null;
  /** Call key (toolCallId) of the dispatch this agent thread hangs off; null = unlinked. */
  linkedTo: string | null;
  /** The thread's first event was read (linking steps 2 and 3 apply to it only). */
  seen: boolean;
}

interface Call {
  key: string;
  nodeId: string;
  toolCallId: string | null;
  toolName: string | null;
  args: unknown;
  hasArgs: boolean;
  messageId: string | null;
  timestamp: string;
  status: 'running' | 'succeeded' | 'failed';
  /** tool.execution_complete was read: its status is final (subagent.* events no longer change it). */
  completed: boolean;
  /** Time of the first record that made the call terminal (GraphNode.endedAt: later corrections keep it). */
  endedAt: string | null;
  output: unknown;
  /** subagent.started named this call, or its tool runs a subagent. */
  subagent: boolean;
  agentTitle: string | null;
  agentDescription: string | null;
  childAgentId: string | null;
  detailSig: string;
}

interface SessionState {
  session: Session;
  /** A session.start / session.resume or a node was read: the session exists (garbage alone makes none). */
  started: boolean;
  emitted: boolean;
  projectId: string;
  projectFromRecords: boolean;
  startTime: string | null;
  startCwd: string | null;
  branch: string | null;
  workspace: CopilotWorkspace;
  /** The main thread's first prompt's title (undefined: no prompt yet). */
  firstPrompt: string | null | undefined;
  ended: boolean;
  minMs: number | null;
  maxMs: number | null;
  /** The latest time read (fallback timestamp of an untimed event). */
  lastTs: string | null;
  threads: Map<string, Thread>;
  nodes: Map<string, GraphNode>;
  calls: Map<string, Call>;
  /** toolCallIds of subagent.started events not yet claimed by an agent thread, oldest first. */
  pendingStarts: string[];
  /** toolCallId -> the agent thread linked to it (first one wins). */
  agentOfCall: Map<string, string>;
  /** Call key -> agent threads linked to it (their dispatch node may not exist yet). */
  linkedThreads: Map<string, Thread[]>;
  /** Ids of the events applied (a hash of the line for an event without one). */
  seen: Set<string>;
}

/** What a new node needs; everything else is decided by its place in the thread. */
interface NodeSpec {
  id: string;
  kind: GraphNode['kind'];
  title: string;
  summary: string;
  timestamp: string | null;
  messageId?: string | null;
  usage?: Usage | null;
  systemSubtype?: string | null;
  /** The node opens a turn (a prompt). */
  opensTurn?: boolean;
  /** Belongs to no turn (the session-level shutdown node). */
  noTurn?: boolean;
  detail: Partial<NodeDetail>;
}

export class CopilotNormalizer implements AgentNormalizer {
  private readonly sessions = new Map<string, SessionState>();
  private readonly restored = new Set<string>();

  apply(event: RawEvent, projectId: string): NormalizeResult {
    const changes: Change[] = [];
    let unknown: string | undefined;
    if (event.source === 'hook') return { changes }; // Copilot CLI has no hooks of ours
    try {
      const state = this.stateFor(event.sessionId, projectId);
      unknown = event.source === 'meta' ? this.meta(state, event, projectId) : this.record(state, event.line, projectId, changes);
      if (state.started) this.commitSession(state, changes);
    } catch {
      unknown = 'copilot:normalizer-error';
    }
    return unknown === undefined ? { changes } : { changes, unknownRecordType: unknown };
  }

  /** Events one by one (each event's changes depend only on the events before it). */
  applyBatch(items: readonly BatchItem[]): BatchResult {
    const changes: Change[] = [];
    const unknown: (string | undefined)[] = [];
    for (const { event, projectId } of items) {
      const r = this.apply(event, projectId);
      for (const c of r.changes) changes.push(c);
      unknown.push(r.unknownRecordType);
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

  /** Before the session exists only a workspace.yaml (or records that made no session) can be stored: re-applied. */
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
        session: { id: sessionId, projectId, origin: 'copilot', cwd: null, title: null, gitBranch: null, status: 'running', sourceDeleted: false, startedAt: EPOCH, lastActivityAt: EPOCH },
        started: false,
        emitted: false,
        projectId,
        projectFromRecords: false,
        startTime: null,
        startCwd: null,
        branch: null,
        workspace: {},
        firstPrompt: undefined,
        ended: false,
        minMs: null,
        maxMs: null,
        lastTs: null,
        threads: new Map(),
        nodes: new Map(),
        calls: new Map(),
        pendingStarts: [],
        agentOfCall: new Map(),
        linkedThreads: new Map(),
        seen: new Set(),
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /** A workspace.yaml (the session's `title` file): title and fallback cwd. */
  private meta(state: SessionState, event: Extract<RawEvent, { source: 'meta' }>, projectId: string): string | undefined {
    if (!event.file.endsWith('/workspace.yaml')) return undefined;
    state.workspace = parseWorkspaceYaml(event.payload);
    if (!state.projectFromRecords && projectId !== 'unknown') state.projectId = projectId;
    return undefined;
  }

  private thread(state: SessionState, agentId: string | null): Thread {
    const key = agentId ?? MAIN;
    let t = state.threads.get(key);
    if (t === undefined) {
      t = { agentId, prev: null, prevTs: null, turn: null, first: null, linkedTo: null, seen: false };
      state.threads.set(key, t);
    }
    return t;
  }

  // ---- records ----

  /** One line of the event log. Returns its unknown label, if any. */
  private record(state: SessionState, line: string, projectId: string, changes: Change[]): string | undefined {
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      return 'copilot:invalid-json';
    }
    if (!isObject(rec)) return 'copilot:not-an-object';
    const type = rec.type;
    if (typeof type !== 'string') return unknownTypeName('copilot', type);
    const known = HANDLED.has(type) || IGNORED.has(type) || IGNORED_PREFIXES.some((p) => type.startsWith(p));
    if (!known) return unknownTypeName('copilot', type);

    // An event read before (same id: the file was re-read after Copilot rewrote it) changes nothing.
    const eventKey = nonEmpty(rec.id) ?? `h${createHash('sha256').update(line).digest('hex').slice(0, 16)}`;
    if (state.seen.has(eventKey)) return undefined;
    state.seen.add(eventKey);
    if (projectId !== 'unknown' && !state.projectFromRecords) {
      state.projectId = projectId;
      state.projectFromRecords = true;
    }
    const msTime = msOf(rec.timestamp);
    if (msTime !== null) {
      state.minMs = state.minMs === null ? msTime : Math.min(state.minMs, msTime);
      state.maxMs = state.maxMs === null ? msTime : Math.max(state.maxMs, msTime);
    }
    const ts = msTime === null ? null : isoOfMs(msTime);
    const data = isObject(rec.data) ? rec.data : {};
    const agentId = nonEmpty(rec.agentId);
    const t = this.thread(state, agentId);
    if (agentId !== null) this.linkThread(state, t, data, changes);
    if (REVIVE.has(type)) state.ended = false;

    switch (type) {
      case 'session.start': {
        state.startTime ??= isoOrNull(data.startTime) ?? ts;
        const ctx = isObject(data.context) ? data.context : {};
        state.startCwd ??= nonEmpty(ctx.cwd);
        state.branch = nonEmpty(ctx.branch) ?? state.branch;
        this.start(state, changes);
        break;
      }
      case 'session.resume':
      case 'session.context_changed': {
        const ctx = isObject(data.context) ? data.context : data;
        state.branch = nonEmpty(ctx.branch) ?? state.branch;
        if (type === 'session.resume') this.start(state, changes);
        break;
      }
      case 'user.message': {
        const text = str(data.content) ?? '';
        if (text.trim() === '') break;
        const added = this.addNode(state, t, { id: copilotNodeId(state.session.id, eventKey), kind: 'prompt', title: 'Prompt', summary: summarize(text), timestamp: ts, opensTurn: true, detail: { text } }, changes);
        if (added && agentId === null && state.firstPrompt === undefined) state.firstPrompt = promptTitle(text);
        break;
      }
      case 'assistant.reasoning': {
        const text = str(data.content) ?? '';
        if (text.trim() === '') break;
        this.addNode(state, t, { id: copilotNodeId(state.session.id, eventKey), kind: 'thinking', title: 'Thinking', summary: summarize(text), timestamp: ts, detail: { text } }, changes);
        break;
      }
      case 'assistant.message': {
        const text = str(data.content) ?? '';
        const messageId = nonEmpty(data.messageId);
        if (text.trim() !== '') {
          this.addNode(state, t, { id: copilotNodeId(state.session.id, eventKey), kind: 'text', title: 'Text', summary: summarize(text), timestamp: ts, messageId, detail: { text } }, changes);
        }
        if (Array.isArray(data.toolRequests)) {
          data.toolRequests.forEach((req, i) => {
            if (!isObject(req)) return;
            const call = this.ensureCall(state, t, nonEmpty(req.toolCallId), `${eventKey}:req#${i}`, ts, changes, messageId);
            if (call.toolName === null) call.toolName = nonEmpty(req.name);
            if (!call.hasArgs && req.arguments !== undefined) {
              call.args = parseArgs(req.arguments);
              call.hasArgs = true;
            }
            this.refreshCall(state, call, changes);
          });
        }
        break;
      }
      case 'tool.execution_start': {
        const call = this.ensureCall(state, t, nonEmpty(data.toolCallId), `${eventKey}:call`, ts, changes, null);
        call.toolName = nonEmpty(data.toolName) ?? call.toolName;
        if (data.arguments !== undefined) {
          call.args = parseArgs(data.arguments);
          call.hasArgs = true;
        }
        this.refreshCall(state, call, changes);
        break;
      }
      case 'tool.execution_complete': {
        const key = nonEmpty(data.toolCallId);
        if (key === null) break; // nothing to attach it to
        const call = this.ensureCall(state, t, key, key, ts, changes, null);
        call.status = data.success === true ? 'succeeded' : 'failed';
        call.completed = true;
        call.endedAt ??= ts ?? call.timestamp;
        const result = isObject(data.result) ? str(data.result.content) : null;
        const error = isObject(data.error) ? str(data.error.message) : null;
        const output = result ?? error;
        if (output !== null) call.output = output;
        this.refreshCall(state, call, changes);
        break;
      }
      case 'subagent.started':
      case 'subagent.completed':
      case 'subagent.failed': {
        const key = nonEmpty(data.toolCallId);
        if (key === null) break;
        const call = this.ensureCall(state, t, key, key, ts, changes, null);
        call.subagent = true;
        call.agentTitle = nonEmpty(data.agentDisplayName) ?? nonEmpty(data.agentName) ?? call.agentTitle;
        if (type === 'subagent.started') {
          call.agentDescription = nonEmpty(data.agentDescription) ?? call.agentDescription;
          if (!state.agentOfCall.has(key) && !state.pendingStarts.includes(key)) state.pendingStarts.push(key);
        } else if (!call.completed && call.status === 'running') {
          call.status = type === 'subagent.failed' || data.cancelled === true ? 'failed' : 'succeeded';
          call.endedAt ??= ts ?? call.timestamp;
          if (type === 'subagent.failed' && call.output === undefined) {
            const error = str(data.error);
            if (error !== null) call.output = error;
          }
        }
        this.refreshCall(state, call, changes);
        break;
      }
      case 'session.compaction_complete': {
        const text = str(data.summaryContent) ?? '';
        this.addSystem(state, t, eventKey, ts, 'Compact', 'compact', summarize(text), { text }, changes);
        break;
      }
      case 'session.truncation': {
        const removed = num(data.tokensRemovedDuringTruncation);
        this.addSystem(state, t, eventKey, ts, 'Truncation', 'compact', removed > 0 ? `${removed} tokens removed` : '', { raw: data }, changes);
        break;
      }
      case 'session.error': {
        const text = str(data.message) ?? '';
        this.addSystem(state, t, eventKey, ts, 'Error', 'error', summarize(text), { text }, changes);
        break;
      }
      case 'abort': {
        const text = str(data.reason) ?? '';
        this.addSystem(state, t, eventKey, ts, 'Interrupted', 'interrupt', summarize(text), { text }, changes);
        break;
      }
      case 'session.shutdown': {
        state.ended = true;
        const usage = shutdownUsage(data.modelMetrics);
        const raw = { shutdownType: data.shutdownType ?? null, modelMetrics: data.modelMetrics ?? null, codeChanges: data.codeChanges ?? null, currentModel: data.currentModel ?? null };
        this.addNode(
          state,
          t,
          { id: copilotNodeId(state.session.id, eventKey), kind: 'system', title: 'Session ended', summary: summarize(str(data.shutdownType) ?? ''), timestamp: ts, usage, systemSubtype: 'shutdown', noTurn: true, detail: { raw } },
          changes,
        );
        break;
      }
      default:
        break; // ignored types
    }
    if (ts !== null) state.lastTs = ts;
    return undefined;
  }

  private start(state: SessionState, changes: Change[]): void {
    if (state.started) return;
    state.started = true;
    this.commitSession(state, changes);
  }

  private addSystem(state: SessionState, t: Thread, eventKey: string, ts: string | null, title: string, subtype: string, summary: string, detail: Partial<NodeDetail>, changes: Change[]): void {
    this.addNode(state, t, { id: copilotNodeId(state.session.id, eventKey), kind: 'system', title, summary, timestamp: ts, systemSubtype: subtype, detail }, changes);
  }

  /** The node a thread's next node hangs off: its last node, else (agent thread) the linked dispatch when it exists. */
  private parentOf(state: SessionState, t: Thread): { from: string; kind: 'sequence' | 'spawn' } | null {
    if (t.prev !== null) return { from: t.prev, kind: 'sequence' };
    if (t.linkedTo === null) return null;
    const call = state.calls.get(t.linkedTo);
    return call === undefined ? null : { from: call.nodeId, kind: 'spawn' };
  }

  /** Adds a node at the end of its thread (with the edge into it). False when a node of that id exists already. */
  private addNode(state: SessionState, t: Thread, spec: NodeSpec, changes: Change[]): boolean {
    if (state.nodes.has(spec.id)) return false;
    this.start(state, changes);
    const sid = state.session.id;
    if (spec.opensTurn === true) t.turn = spec.id;
    const parent = this.parentOf(state, t);
    const timestamp = spec.timestamp ?? t.prevTs ?? state.lastTs ?? state.startTime ?? EPOCH;
    const node: GraphNode = {
      id: spec.id,
      sessionId: sid,
      turnId: spec.noTurn === true ? null : t.turn,
      agentId: t.agentId,
      childAgentId: null,
      parentId: parent?.from ?? null,
      kind: spec.kind,
      status: null,
      timestamp,
      confirmed: true,
      title: spec.title,
      summary: spec.summary,
      toolName: null,
      toolUseId: null,
      messageId: spec.messageId ?? null,
      durationMs: null,
      endedAt: null,
      usage: spec.usage ?? null,
      systemSubtype: spec.systemSubtype ?? null,
    };
    state.nodes.set(node.id, node);
    changes.push({ type: 'node_added', node, detail: spec.detail });
    if (parent !== null) changes.push({ type: 'edge_added', edge: { id: `${parent.from}->${node.id}`, sessionId: sid, from: parent.from, to: node.id, kind: parent.kind } });
    t.prev = node.id;
    t.prevTs = timestamp;
    t.first ??= node.id;
    return true;
  }

  // ---- calls ----

  /**
   * The call of `toolCallId` (else of `fallbackKey`: a call without an id, never matched by another event), created
   * with its node at the end of thread `t` on first sight.
   */
  private ensureCall(state: SessionState, t: Thread, toolCallId: string | null, fallbackKey: string, ts: string | null, changes: Change[], messageId: string | null): Call {
    const key = toolCallId ?? fallbackKey;
    const existing = state.calls.get(key);
    if (existing !== undefined) return existing;
    const nodeId = copilotNodeId(state.session.id, `call:${key}`);
    const timestamp = ts ?? t.prevTs ?? state.lastTs ?? state.startTime ?? EPOCH;
    const call: Call = {
      key,
      nodeId,
      toolCallId,
      toolName: null,
      args: undefined,
      hasArgs: false,
      messageId,
      timestamp,
      status: 'running',
      completed: false,
      endedAt: null,
      output: undefined,
      subagent: false,
      agentTitle: null,
      agentDescription: null,
      childAgentId: null,
      detailSig: '',
    };
    state.calls.set(key, call);
    const detail = callDetail(call);
    call.detailSig = JSON.stringify(detail) ?? '';
    this.addNode(state, t, { id: nodeId, kind: 'tool', title: 'unknown', summary: '', timestamp, messageId, detail }, changes);
    if (toolCallId === null) return call;
    // Agent threads seen before their dispatch: linked to it by a parentToolCallId already, or (step 2) named like it.
    const agent = state.agentOfCall.get(key);
    if (agent !== undefined) {
      call.childAgentId = agent;
      this.refreshCall(state, call, changes);
    }
    for (const other of state.linkedThreads.get(key) ?? []) this.attach(state, other, changes);
    const named = state.threads.get(key);
    if (named !== undefined && named.linkedTo === null && named !== t) this.link(state, named, key, changes);
    return call;
  }

  /** Emits what differs between the call's node and its current state. */
  private refreshCall(state: SessionState, call: Call, changes: Change[]): void {
    const old = state.nodes.get(call.nodeId);
    if (old === undefined) return;
    const subagent = call.subagent || call.childAgentId !== null || (call.toolName !== null && SUBAGENT_TOOLS.has(call.toolName));
    const args = call.hasArgs ? call.args : undefined;
    const files = nodeFiles(copilotTouches(call.toolName, args), state.startCwd);
    const durationMs = call.endedAt === null ? null : Math.max(0, Date.parse(call.endedAt) - Date.parse(old.timestamp)) || 0;
    const next: GraphNode = {
      ...old,
      files: undefined,
      filesTruncated: undefined,
      kind: subagent ? 'subagent' : 'tool',
      title: subagent ? (call.agentTitle ?? agentFromArgs(args) ?? call.toolName ?? 'task') : (call.toolName ?? 'unknown'),
      summary: toolSummary(args) || summarize(call.agentDescription ?? ''),
      status: call.status,
      toolName: call.toolName,
      toolUseId: call.toolCallId,
      childAgentId: call.childAgentId,
      endedAt: call.endedAt,
      durationMs,
      ...filesFields(files),
      ...inputKeyFields(call.hasArgs ? inputKeyOf(call.toolName, args) : undefined),
    };
    const patch = nodePatch(old, next);
    const detail = callDetail(call);
    const sig = JSON.stringify(detail) ?? '';
    const detailChanged = sig !== call.detailSig;
    if (Object.keys(patch).length === 0 && !detailChanged) return;
    state.nodes.set(call.nodeId, { ...old, ...patch });
    call.detailSig = sig;
    changes.push({ type: 'node_updated', sessionId: state.session.id, id: call.nodeId, patch, ...(detailChanged ? { detail } : {}) });
  }

  // ---- agent threads ----

  /** On an event of an agent thread: links a new thread (three steps), or a still unlinked one named by the event. */
  private linkThread(state: SessionState, t: Thread, data: Obj, changes: Change[]): void {
    const first = !t.seen;
    t.seen = true;
    if (t.linkedTo !== null) return;
    const named = nonEmpty(data.parentToolCallId);
    if (named !== null && named !== t.agentId) return this.link(state, t, named, changes);
    if (!first) return; // steps 2 and 3 apply at the thread's first event only
    if (t.agentId !== null && state.calls.has(t.agentId) && !this.threadOwnsCall(state, t, t.agentId)) return this.link(state, t, t.agentId, changes);
    const start = state.pendingStarts.shift();
    if (start !== undefined) this.link(state, t, start, changes);
  }

  private threadOwnsCall(state: SessionState, t: Thread, key: string): boolean {
    const call = state.calls.get(key);
    return call !== undefined && state.nodes.get(call.nodeId)?.agentId === t.agentId;
  }

  /** Links agent thread `t` to the call `key`: the call becomes its dispatch; its first node hangs off it. */
  private link(state: SessionState, t: Thread, key: string, changes: Change[]): void {
    if (t.agentId === null) return;
    t.linkedTo = key;
    const linked = state.linkedThreads.get(key);
    if (linked === undefined) state.linkedThreads.set(key, [t]);
    else linked.push(t);
    const at = state.pendingStarts.indexOf(key);
    if (at !== -1) state.pendingStarts.splice(at, 1);
    if (!state.agentOfCall.has(key)) state.agentOfCall.set(key, t.agentId);
    const call = state.calls.get(key);
    if (call !== undefined && call.childAgentId === null && state.agentOfCall.get(key) === t.agentId) {
      call.childAgentId = t.agentId;
      this.refreshCall(state, call, changes);
    }
    this.attach(state, t, changes);
  }

  /** Hangs the first node of linked thread `t` off its dispatch, when both exist and it hangs off nothing yet. */
  private attach(state: SessionState, t: Thread, changes: Change[]): void {
    if (t.first === null || t.linkedTo === null) return;
    const call = state.calls.get(t.linkedTo);
    const first = state.nodes.get(t.first);
    if (call === undefined || first === undefined || first.parentId !== null) return;
    if (call.childAgentId === null && t.agentId !== null) {
      call.childAgentId = t.agentId;
      this.refreshCall(state, call, changes);
    }
    const sid = state.session.id;
    state.nodes.set(first.id, { ...first, parentId: call.nodeId });
    changes.push({ type: 'node_updated', sessionId: sid, id: first.id, patch: { parentId: call.nodeId } });
    changes.push({ type: 'edge_added', edge: { id: `${call.nodeId}->${first.id}`, sessionId: sid, from: call.nodeId, to: first.id, kind: 'spawn' } });
  }

  // ---- session ----

  /**
   * The session as a function of what was read: title = workspace `name`, else `summary`, else the first main-thread
   * prompt; cwd = the session.start cwd, else the workspace's; started = session.start's startTime, else the earliest
   * time read; status ended after session.shutdown (until a resume / start / prompt), else running (spec 4.5: the
   * display turns a quiet running session stale).
   */
  private commitSession(state: SessionState, changes: Change[]): void {
    const ws = state.workspace;
    const title = nonEmpty(ws.name)?.trim() ?? nonEmpty(ws.summary)?.trim() ?? state.firstPrompt ?? null;
    const startedAt = state.startTime ?? (state.minMs === null ? EPOCH : isoOfMs(state.minMs));
    const lastMs = Math.max(state.maxMs ?? Number.NEGATIVE_INFINITY, Date.parse(startedAt));
    const next: Session = {
      ...state.session,
      projectId: state.projectId,
      cwd: state.startCwd ?? ws.cwd ?? null,
      title,
      gitBranch: state.branch,
      status: state.ended ? 'ended' : 'running',
      startedAt,
      lastActivityAt: isoOfMs(lastMs),
    };
    const s = state.session;
    const same =
      s.projectId === next.projectId &&
      s.cwd === next.cwd &&
      s.title === next.title &&
      s.gitBranch === next.gitBranch &&
      s.status === next.status &&
      s.startedAt === next.startedAt &&
      s.lastActivityAt === next.lastActivityAt;
    if (same && state.emitted) return;
    state.emitted = true;
    state.session = next;
    changes.push({ type: 'session_upserted', session: next });
  }
}

/** Types read by `record` (beyond the ignore list). */
const HANDLED = new Set([
  'session.start',
  'session.resume',
  'session.context_changed',
  'user.message',
  'assistant.reasoning',
  'assistant.message',
  'tool.execution_start',
  'tool.execution_complete',
  'subagent.started',
  'subagent.completed',
  'subagent.failed',
  'session.compaction_complete',
  'session.truncation',
  'session.error',
  'abort',
  'session.shutdown',
]);

function isoOrNull(v: unknown): string | null {
  const ms = msOf(v);
  return ms === null ? null : isoOfMs(ms);
}

function callDetail(call: Call): Partial<NodeDetail> {
  return { input: call.hasArgs ? (call.args ?? null) : null, ...(call.output !== undefined ? { output: call.output } : {}) };
}
