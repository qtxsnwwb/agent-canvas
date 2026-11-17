import type { Change, GraphNode, NodeDetail, Session, Usage } from '@agent-canvas/shared';
import { normaliseCwd } from '../sources/cursor/project.js';
import type { RawEvent } from '../store/store.js';
import { addFlags, emptyFlags, nextParent, showsAll, walkBranch, type BranchFlags, type BranchLine, type BranchWalk } from './buddy-branch.js';
import { classifyUserMessage, humanText, isCompactAgent } from './buddy-prompt.js';
import { buddyUsage } from './buddy-usage.js';
import { promptTitle } from './codex.js';
import { buddyTouches, filesFields, nodeFiles, type RawTouch } from './files.js';
import { nodePatch } from './gemini.js';
import { inputKeyFields, inputKeyOf } from './input-key.js';
import { summarize } from './summary.js';
import type { AgentNormalizer, BatchItem, BatchResult, NormalizeResult } from './types.js';
import { unknownTypeName } from './unknown-type.js';

/*
 * The WorkBuddy / CodeBuddy Code normalizer (spec 4.2-4.6, docs/formats/buddy-family.md sections 2-9). Both products
 * write the same JSONL: OpenAI Agents SDK items (`message`, `reasoning`, `function_call`, `function_call_result`) plus
 * custom "fact" records, linked into a `parentId` tree. The source delivers one line per event, `offset` = the line's
 * byte offset (strictly increasing within one generation of the file). A session file is the main thread of its
 * session; a subagent file is an agent thread (agentId = its file stem, which the parent's Agent-tool result names in
 * `providerData.toolResult.subAgent.sessionId`).
 *
 * Each line is applied once, in order, to its thread and emits the changes it causes. A thread keeps small per-line
 * facts (ids, parent ids, flags, the node a line made, usage counts) and the emitted nodes; nothing of a line's text
 * (prompt, reply, tool input or output) is kept once the line was applied.
 *
 * The active branch (format reference 7, buddy-branch.ts): without a fork marker every line is shown and nothing is
 * walked. Once a marker (a `resend-fork-notice` or a content-filter notice) is in the file, the shown lines are the
 * walk's. Appending a conversation entry that extends the branch tip is O(1); the walk is redone (O(lines)) when a
 * marker arrives, or when an entry does not extend the tip (a fork without a marker). After a walk the thread is
 * reconciled: nodes whose line left the branch are removed (`node_removed`; kept as a skeleton without detail), nodes
 * whose line joined again are added back from their skeleton (with an empty detail: the text is not kept), and the
 * parents, turns, call results and usage of the shown nodes are re-derived from the per-line facts.
 *
 * Node ids: `buddy:<session id>[/<agent id>]:@<offset>` (one node per line at most). A line at or before the last
 * offset read of its thread means the file is read again from its start (rewritten or cut by a failed append): what the
 * thread made is removed and the thread is rebuilt from the new lines.
 */

const EPOCH = '1970-01-01T00:00:00.000Z';
const MAIN = '';
/** The writer's CUSTOM_INPUT_ITEM_TYPES plus session-meta (format reference 3): facts, never conversation entries. */
const CUSTOM_TYPES = new Set([
  'custom-title',
  'ai-title',
  'file-history-snapshot',
  'summary',
  'topic',
  'goal-result',
  'goal-progress',
  'goal-state',
  'turn-metrics',
  'resend-fork-notice',
  'acp-terminal-state',
  'request-recovery',
  'model-usage',
  'credit-usage',
  'context-usage',
  'checkpoint-restore',
  'session-meta',
]);
/** SDK item types this normalizer reads. */
const ITEM_TYPES = new Set(['message', 'reasoning', 'function_call', 'function_call_result', 'function_call_output']);
/** SDK item types that may appear but show nothing (counted as unknown; still conversation entries of the tree). */
const UNHANDLED_ITEMS = new Set(['hosted_tool_call', 'computer_call', 'computer_call_result', 'unknown']);
/** The subagent dispatch tool's names (format reference 1.5 "Agent tool"; Task as in Claude Code). */
const SUBAGENT_TOOLS = new Set(['Task', 'Agent', 'task', 'agent']);
const SUMMARY_KEYS = ['command', 'file_path', 'filePath', 'path', 'notebook_path', 'target_file', 'pattern', 'query', 'url', 'description', 'prompt'];
const PREFIX_MAX = 2048;
const ID_MAX = 200;
const PATH_MAX_CHARS = 4096;
const MAX_TOUCHES = 64;
const AUTO = 'auto';

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const isoOfMs = (ms: number): string => new Date(ms).toISOString();
/** A copy of `s` sharing no memory with the line it was cut from (see grok.ts `own`). */
const own = (s: string): string => (' ' + s).slice(1);
const ownId = (s: string): string => own(s.slice(0, ID_MAX));
const idOf = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? ownId(v) : null);
const brief = (v: unknown): string => own(summarize(typeof v === 'string' ? head(v, PREFIX_MAX) : v));

function head(s: string, n: number): string {
  if (s.length <= n) return s;
  const code = s.charCodeAt(n - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

/** The id of a Buddy node: `buddy:<session id>[/<agent id>]:<part>`. */
export function buddyNodeId(sessionId: string, agentId: string | null, part: string): string {
  return `buddy:${sessionId}${agentId === null ? '' : `/${agentId}`}:${part}`;
}

/** A line's time: epoch ms (format reference 2); a date string accepted defensively (D13). Null when absent or invalid. */
function msOf(v: unknown): number | null {
  let ms: number | null = null;
  if (typeof v === 'number' && Number.isFinite(v)) ms = v;
  else if (typeof v === 'string') {
    const p = Date.parse(v);
    if (!Number.isNaN(p)) ms = p;
  }
  if (ms === null || ms <= 0 || ms > 8.64e15) return null;
  return Math.floor(ms);
}

/** The text of an assistant message: `output_text` parts (and refusals) joined; a string content as it is. */
function assistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const p of content) {
    if (!isObject(p)) continue;
    if ((p.type === 'output_text' || p.type === 'text') && typeof p.text === 'string') parts.push(p.text);
    else if (p.type === 'refusal' && typeof p.refusal === 'string') parts.push(p.refusal);
  }
  return parts.join('');
}

/** Text parts of a content (`.text` of each part, or the string). */
function partsText(content: unknown, sep: string): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const p of content) {
    if (typeof p === 'string') out.push(p);
    else if (isObject(p) && typeof p.text === 'string') out.push(p.text);
  }
  return out.join(sep);
}

/** Reasoning text (format reference 3.4, D3): `rawContent[].text` of `reasoning_text` parts, else `content[].text`. */
function reasoningText(rec: Obj): string {
  if (Array.isArray(rec.rawContent)) {
    const raw = rec.rawContent
      .filter((p): p is Obj => isObject(p) && (p.type === 'reasoning_text' || p.type === undefined) && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('');
    if (raw.trim() !== '') return raw;
  }
  return partsText(rec.content, '');
}

/** A tool output as text (format reference 3.6): a string; `{type:text}`; parts; `.text` / `.content` / `.output`. */
function outputText(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const p of v) {
      if (typeof p === 'string') out.push(p);
      else if (!isObject(p)) continue;
      else if (typeof p.text === 'string') out.push(p.text);
      else if (p.type === 'input_image' || p.type === 'image_blob_ref' || p.type === 'image') out.push('[image]');
      else if (p.type === 'input_file' || p.type === 'file') out.push('[file]');
    }
    return out.join('\n');
  }
  if (isObject(v)) {
    for (const k of ['text', 'content', 'output']) if (typeof v[k] === 'string') return v[k] as string;
  }
  return null;
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

/** A concrete model name (not the router placeholder `auto`), or null. */
const concreteModel = (v: unknown): string | null => {
  const s = nonEmpty(v);
  return s === null || s.toLowerCase() === AUTO ? null : brief(s);
};

const addUsage = (a: Usage | null, b: Usage | null): Usage | null => {
  if (b === null) return a;
  if (a === null) return { ...b };
  return { inputTokens: a.inputTokens + b.inputTokens, cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0), outputTokens: a.outputTokens + b.outputTokens };
};

const sameUsage = (a: Usage | null, b: Usage | null): boolean =>
  a === b || (a !== null && b !== null && a.inputTokens === b.inputTokens && a.outputTokens === b.outputTokens && (a.cachedInputTokens ?? 0) === (b.cachedInputTokens ?? 0));

interface Turn {
  /** conversationRequestId (null: a turn a prompt without one opened, until an output names one). */
  c: string | null;
  /** The turn's first shown node (its turnId). */
  first: string | null;
}

/** One model response (a messageId), or one usage record / node without a messageId (`own`). */
interface Resp {
  own: boolean;
  /** Usage candidates: the line and its usage. */
  cands: { line: number; usage: Usage; total: number }[];
  /** Lines of the response that made a node, in line order. */
  nodes: number[];
  /** The largest usage of the shown candidates (the first of equal ones). */
  best: Usage | null;
  bestTotal: number;
  /** The line whose node the usage is on (-1: nowhere). */
  target: number;
  /** First shown candidate line, and the line of the last shown node before it (-1: none). */
  firstCand: number;
  attachBase: number;
}

interface ResultFacts {
  callId: string;
  status: 'succeeded' | 'failed';
  endedAt: string;
  childId: string | null;
  label: string | null;
}

/** A tool call's state: never its arguments or output (they go out in the node's detail). */
interface Call {
  nodeId: string;
  callId: string;
  thread: Thread;
  name: string | null;
  /** Status without a result: running, or failed for a draft that never runs (truncated / aborted / discarded). */
  baseStatus: 'running' | 'failed';
  baseEnded: string | null;
  /** The result line paired with it (-1: none), and the one before a reconcile. */
  result: number;
  before: number;
  facts: ResultFacts | null;
  messageId: string | null;
  inputKey: string | undefined;
  argSummary: string;
  argLabel: string | null;
  touches: RawTouch[];
  cwd: string | null;
  /** A subagent dispatch by its tool name. */
  dispatch: boolean;
  /** The child thread its result names (registered in childCalls). */
  childId: string | null;
}

interface Line extends BranchLine {
  /** Shown (on the active branch, or everything is shown). */
  active: boolean;
  /** The node this line made (null: none, or the line was never shown). */
  node: string | null;
  turn: Turn | null;
  call: Call | null;
  result: ResultFacts | null;
  /** The response a usage record, or a node with a messageId / usage, belongs to. */
  resp: Resp | null;
}

interface Thread {
  agentId: string | null;
  lastOffset: number;
  lines: Line[];
  flags: BranchFlags;
  /** A walk is in force (false: everything shown); the line the walk started at. */
  walked: boolean;
  tipIdx: number;
  /** Count of shown entries per id (while a walk is in force). */
  activeIds: Map<string, number>;
  /** model-usage lines waiting for an entry with their parentId to be shown. */
  waiting: Map<string, number[]>;
  /** Last shown node (the next one hangs off it), its line and time. */
  prev: string | null;
  prevLine: number;
  prevTs: string | null;
  lastTs: string | null;
  cur: Turn | null;
  turns: Turn[];
  turnsByC: Map<string, Turn>;
  /** Shown calls without a result, by callId (in order). */
  open: Map<string, Call[]>;
  resps: Map<string, Resp>;
  /** Line (of a node) -> responses whose usage is on it. */
  contrib: Map<number, Resp[]>;
  /** Removed nodes (skeletons without detail). */
  hidden: Map<string, GraphNode>;
  minMs: number | null;
  maxMs: number | null;
  cwd: string | null;
  customTitle: string | null;
  aiTitle: string | null;
  topic: string | null;
  firstPrompt: string | null;
  /** First concrete model of the thread and the session sequence number it came at. */
  firstModel: { model: string; seq: number } | null;
  /** The dispatch this agent thread hangs off. */
  linkedTo: Call | null;
}

interface SessionState {
  session: Session;
  started: boolean;
  emitted: boolean;
  projectId: string;
  threads: Map<string, Thread>;
  /** Every shown node as emitted. */
  nodes: Map<string, GraphNode>;
  callByNode: Map<string, Call>;
  /** Child (agent) id -> the calls naming it, in the order they named it. */
  childCalls: Map<string, Call[]>;
  /** Lines applied (orders the threads' first concrete models). */
  seq: number;
  /** The session's concrete model (replaces `auto`); nodes of `auto` lines and the model they show. */
  concrete: string | null;
  autoNodes: Map<string, string>;
  concreteDirty: boolean;
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

const pushTo = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
};

export class BuddyNormalizer implements AgentNormalizer {
  private readonly sessions = new Map<string, SessionState>();
  private readonly restored = new Set<string>();

  constructor(private readonly origin: 'workbuddy' | 'codebuddy') {}

  apply(event: RawEvent, projectId: string): NormalizeResult {
    const r = this.applyBatch([{ event, projectId }]);
    const unknown = r.unknown[0];
    return unknown === undefined ? { changes: r.changes } : { changes: r.changes, unknownRecordType: unknown };
  }

  /** Lines one by one; the session row is emitted once, at the end of the batch. */
  applyBatch(items: readonly BatchItem[]): BatchResult {
    const changes: Change[] = [];
    const unknown: (string | undefined)[] = [];
    const touched = new Set<SessionState>();
    for (const { event, projectId } of items) {
      unknown.push(undefined);
      if (event.source !== 'transcript') continue;
      try {
        const state = this.stateFor(event.sessionId, projectId);
        touched.add(state);
        unknown[unknown.length - 1] = this.record(state, event, projectId, changes);
      } catch {
        unknown[unknown.length - 1] = `${this.origin}:normalizer-error`;
      }
    }
    for (const state of touched) {
      try {
        if (state.started) this.commitSession(state, changes);
      } catch {
        unknown[unknown.length - 1] ??= `${this.origin}:normalizer-error`;
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

  /** Before the session exists only lines that made nothing can be stored (a subagent's facts): re-applied. */
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
        session: { id: sessionId, projectId, origin: this.origin, cwd: null, title: null, gitBranch: null, status: 'running', sourceDeleted: false, startedAt: EPOCH, lastActivityAt: EPOCH },
        started: false,
        emitted: false,
        projectId,
        threads: new Map(),
        nodes: new Map(),
        callByNode: new Map(),
        childCalls: new Map(),
        seq: 0,
        concrete: null,
        autoNodes: new Map(),
        concreteDirty: false,
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private thread(state: SessionState, agentId: string | null, changes: Change[]): Thread {
    const key = agentId ?? MAIN;
    let t = state.threads.get(key);
    if (t === undefined) {
      t = this.blankThread(agentId);
      state.threads.set(key, t);
      if (agentId !== null) this.relink(state, t, changes); // a call naming it may have been read already
    }
    return t;
  }

  private blankThread(agentId: string | null): Thread {
    return {
      agentId,
      lastOffset: -1,
      lines: [],
      flags: emptyFlags(),
      walked: false,
      tipIdx: -1,
      activeIds: new Map(),
      waiting: new Map(),
      prev: null,
      prevLine: -1,
      prevTs: null,
      lastTs: null,
      cur: null,
      turns: [],
      turnsByC: new Map(),
      open: new Map(),
      resps: new Map(),
      contrib: new Map(),
      hidden: new Map(),
      minMs: null,
      maxMs: null,
      cwd: null,
      customTitle: null,
      aiTitle: null,
      topic: null,
      firstPrompt: null,
      firstModel: null,
      linkedTo: null,
    };
  }

  private start(state: SessionState, changes: Change[]): void {
    if (state.started) return;
    state.started = true;
    this.commitSession(state, changes); // the session row before its first node
  }

  // ---- lines ----

  private record(state: SessionState, event: Extract<RawEvent, { source: 'transcript' }>, projectId: string, changes: Change[]): string | undefined {
    const t = this.thread(state, event.agentId, changes);
    if (event.offset <= t.lastOffset) this.resetThread(state, t, changes);
    t.lastOffset = event.offset;
    let rec: unknown;
    try {
      rec = JSON.parse(event.line);
    } catch {
      return `${this.origin}:invalid-json`;
    }
    if (!isObject(rec)) return `${this.origin}:not-an-object`;
    const type = rec.type;
    if (typeof type !== 'string') return unknownTypeName(this.origin, type);
    const custom = CUSTOM_TYPES.has(type);
    const known = custom || ITEM_TYPES.has(type) || UNHANDLED_ITEMS.has(type);
    const pd = isObject(rec.providerData) ? rec.providerData : {};
    const parentId = idOf(rec.parentId);
    // An unknown type outside the tree is skipped; one with a parentId is kept as a conversation entry (it may be a
    // link of the chain the walk follows) that shows nothing.
    if (!known && parentId === null) return unknownTypeName(this.origin, type);
    if (projectId !== 'unknown' && (event.agentId === null || state.projectId === 'unknown')) state.projectId = projectId;
    state.seq += 1;
    const ms = msOf(rec.timestamp);
    if (ms !== null) {
      t.minMs = t.minMs === null ? ms : Math.min(t.minMs, ms);
      t.maxMs = t.maxMs === null ? ms : Math.max(t.maxMs, ms);
    }
    const ts = ms === null ? null : isoOfMs(ms);
    const cwd = nonEmpty(rec.cwd);
    if (cwd !== null) t.cwd = own(normaliseCwd(cwd.slice(0, PATH_MAX_CHARS)));
    if (t.agentId === null) this.start(state, changes);
    if (type === 'session-meta') return undefined; // not a line of the conversation (format reference 7)
    const line: Line = {
      id: type === 'file-history-snapshot' ? null : idOf(rec.id), // its legacy id may collide with an entry's (3.9)
      parentId,
      logicalParentId: idOf(rec.logicalParentId),
      type: custom || ITEM_TYPES.has(type) || UNHANDLED_ITEMS.has(type) ? type : 'unknown',
      custom,
      isCompactAgent: isCompactAgent(pd.agent),
      contentFilterNotice: type === 'message' && Boolean(pd.contentFilterNotice),
      resendForkNotice: type === 'resend-fork-notice',
      active: false,
      node: null,
      turn: null,
      call: null,
      result: null,
      resp: null,
    };
    const i = t.lines.length;
    t.lines.push(line);
    const prevEntry = t.flags.lastEntry;
    const compactBefore = t.flags.compact;
    addFlags(t.flags, line, i);
    this.branch(state, t, line, i, prevEntry, compactBefore, changes);
    let unknown: string | undefined;
    if (!known || UNHANDLED_ITEMS.has(type)) unknown = unknownTypeName(this.origin, type);
    else if (custom) this.fact(state, t, line, i, rec, pd, changes);
    else if (line.active) unknown = this.item(state, t, line, i, rec, pd, ts, changes);
    if (ts !== null) t.lastTs = ts;
    this.flushConcrete(state, changes);
    return unknown;
  }

  // ---- the active branch ----

  /** Where line `i` (just added) stands on the branch: O(1) when it extends the tip; else the walk and a reconcile. */
  private branch(state: SessionState, t: Thread, line: Line, i: number, prevEntry: number, compactBefore: boolean, changes: Change[]): void {
    const f = t.flags;
    const marker = line.resendForkNotice || line.contentFilterNotice;
    const all = showsAll(f);
    if (!marker && f.compact === compactBefore) {
      if (all && !t.walked) {
        line.active = true;
        return;
      }
      if (!all && t.walked) {
        if (line.custom) {
          line.active = this.factActive(t, line, prevEntry);
          if (!line.active && line.parentId !== null && line.type === 'model-usage') pushTo(t.waiting, line.parentId, i);
          return;
        }
        if (this.extendsTip(t, line, i, prevEntry)) {
          line.active = true;
          t.tipIdx = i;
          const id = line.id!;
          t.activeIds.set(id, (t.activeIds.get(id) ?? 0) + 1);
          const waiting = t.waiting.get(id);
          if (waiting !== undefined) {
            t.waiting.delete(id);
            for (const j of waiting) {
              t.lines[j]!.active = true;
              this.activateFact(state, t, j, changes);
            }
          }
          return;
        }
      }
    }
    this.reconcile(state, t, walkBranch(t.lines, f), changes);
  }

  /**
   * The new entry `line` at `i` continues the branch: the walk from it reaches the line the current walk started at
   * (format reference 7: its run of one id, else its parent), so the shown set only grows by `line`.
   */
  private extendsTip(t: Thread, line: Line, i: number, prevEntry: number): boolean {
    if (line.id === null || t.tipIdx < 0) return false;
    if (prevEntry >= 0 && t.lines[prevEntry]!.id === line.id) return prevEntry === t.tipIdx;
    const parent = nextParent(line, i, t.flags);
    return parent !== null && parent === t.lines[t.tipIdx]!.id;
  }

  /** A fact is shown when its parentId is a shown entry's id; one without a parentId when the entry before it is shown. */
  private factActive(t: Thread, line: Line, prevEntry: number): boolean {
    if (!t.walked) return true;
    if (line.parentId !== null) return (t.activeIds.get(line.parentId) ?? 0) > 0;
    return prevEntry < 0 || t.lines[prevEntry]!.active;
  }

  /**
   * Re-derives what thread `t` shows from the walk (null: everything): removes the nodes whose line left, adds back
   * those whose line joined (from their skeleton, with an empty detail), and re-derives parents, turns, call results and
   * usage of the shown nodes from the per-line facts. Only differences are emitted.
   */
  private reconcile(state: SessionState, t: Thread, walk: BranchWalk | null, changes: Change[]): void {
    const sid = state.session.id;
    const lines = t.lines;
    const n = lines.length;
    // Which lines are shown.
    t.walked = walk !== null;
    t.tipIdx = walk === null ? -1 : walk.tip;
    t.activeIds.clear();
    t.waiting.clear();
    let lastEntry = -1;
    for (let j = 0; j < n; j++) {
      const l = lines[j]!;
      if (walk === null) l.active = true;
      else if (!l.custom) l.active = walk.set.has(j);
      else l.active = walk.set.has(j) || (l.parentId === null && (lastEntry < 0 || lines[lastEntry]!.active));
      if (!l.custom) {
        lastEntry = j;
        if (walk !== null && l.active && l.id !== null) t.activeIds.set(l.id, (t.activeIds.get(l.id) ?? 0) + 1);
      } else if (walk !== null && !l.active && l.parentId !== null && l.type === 'model-usage') {
        pushTo(t.waiting, l.parentId, j);
      }
    }
    // Nodes whose line left.
    const affected = new Set<Thread>();
    for (const l of lines) if (l.node !== null && !l.active && state.nodes.has(l.node)) this.removeNode(state, t, l.node, affected, changes);
    // Calls, results and turns, in line order.
    for (const l of lines) {
      if (l.call === null) continue;
      l.call.before = l.call.result;
      l.call.result = -1;
      l.call.facts = null;
    }
    for (const turn of t.turns) turn.first = null;
    t.open.clear();
    /** The line of the last shown node before each line's own node (-1: none). */
    const prevAt = new Int32Array(n).fill(-1);
    let prev = -1;
    let cur: Turn | null = null;
    for (let j = 0; j < n; j++) {
      const l = lines[j]!;
      if (!l.active) continue;
      prevAt[j] = prev;
      if (l.turn !== null) cur = l.turn;
      if (l.node !== null) {
        prev = j;
        if (l.turn !== null && l.turn.first === null) l.turn.first = l.node;
      }
      if (l.call !== null && l.call.callId !== '') pushTo(t.open, l.call.callId, l.call);
      if (l.result !== null) {
        const call = t.open.get(l.result.callId)?.pop() ?? null;
        if (call !== null) {
          call.result = j;
          call.facts = l.result;
        }
      }
    }
    t.prevLine = prev;
    t.prev = prev < 0 ? null : lines[prev]!.node;
    t.prevTs = t.prev === null ? null : ((state.nodes.get(t.prev) ?? t.hidden.get(t.prev))?.timestamp ?? null);
    t.cur = cur;
    // Subagent names follow the results.
    for (const l of lines) {
      const call = l.call;
      if (call === null || call.result === call.before) continue;
      const childId = call.facts?.childId ?? null;
      if (childId === call.childId) continue;
      if (call.childId !== null) this.unnameChild(state, call, affected);
      if (childId !== null) this.nameChild(state, call, childId, affected);
    }
    // Usage.
    t.contrib.clear();
    for (const r of t.resps.values()) {
      this.bestOf(t, r);
      r.firstCand = -1;
      for (const c of r.cands) if (lines[c.line]!.active && (r.firstCand < 0 || c.line < r.firstCand)) r.firstCand = c.line;
      r.attachBase = r.firstCand < 0 ? -1 : prevAt[r.firstCand]!;
      r.target = -1;
    }
    for (const r of t.resps.values()) this.place(t, r);
    // Emit the shown nodes as derived (a node that does not change costs no allocation).
    const link = t.linkedTo !== null && state.nodes.has(t.linkedTo.nodeId) ? t.linkedTo.nodeId : null;
    for (let j = 0; j < n; j++) {
      const l = lines[j]!;
      if (!l.active || l.node === null) continue;
      const id = l.node;
      const p = prevAt[j]!;
      const from = p < 0 ? link : lines[p]!.node;
      const kind = p < 0 ? 'spawn' : 'sequence';
      const turnId = l.turn?.first ?? null;
      const usage = this.usageOn(t, j);
      const live = state.nodes.get(id);
      const call = l.call;
      const callChanged = call !== null && call.result !== call.before;
      if (live === undefined) {
        const base = t.hidden.get(id);
        if (base === undefined) continue;
        let next: GraphNode = { ...base, parentId: from, turnId, usage };
        if (call !== null) next = this.callNode(state, call, next);
        t.hidden.delete(id);
        state.nodes.set(id, next);
        changes.push({ type: 'node_added', node: next, detail: {} });
        if (from !== null) changes.push({ type: 'edge_added', edge: { id: `${from}->${id}`, sessionId: sid, from, to: id, kind } });
        if (call !== null && call.childId !== null) this.childThread(state, call.childId, affected);
        continue;
      }
      if (live.parentId === from && live.turnId === turnId && sameUsage(live.usage, usage) && !callChanged) continue;
      let next: GraphNode = { ...live, parentId: from, turnId, usage };
      if (callChanged) next = this.callNode(state, call, next);
      const detail: Partial<NodeDetail> | undefined = callChanged && call.result < 0 ? { output: null } : undefined;
      const oldParent = live.parentId;
      this.update(state, next, changes, detail);
      if (oldParent !== from) {
        if (oldParent !== null && state.nodes.has(oldParent)) changes.push({ type: 'edge_removed', sessionId: sid, id: `${oldParent}->${id}` });
        if (from !== null) changes.push({ type: 'edge_added', edge: { id: `${from}->${id}`, sessionId: sid, from, to: id, kind } });
      }
    }
    for (const child of affected) if (child !== t) this.relink(state, child, changes);
  }

  // ---- facts (custom records) ----

  private fact(state: SessionState, t: Thread, line: Line, i: number, rec: Obj, pd: Obj, changes: Change[]): void {
    switch (rec.type) {
      case 'custom-title': {
        const v = nonEmpty(rec.customTitle);
        if (v !== null) t.customTitle = brief(v.trim());
        return;
      }
      case 'ai-title': {
        const v = nonEmpty(rec.aiTitle);
        if (v !== null) t.aiTitle = brief(v.trim());
        return;
      }
      case 'topic': {
        const v = nonEmpty(rec.topic);
        if (v !== null) t.topic = brief(v.trim());
        return;
      }
      case 'model-usage': {
        const cand = buddyUsage(pd.rawUsage) ?? buddyUsage(pd.usage);
        if (cand === null) return;
        const r = this.resp(t, idOf(pd.messageId), i);
        line.resp = r;
        r.cands.push({ line: i, usage: cand.usage, total: cand.total });
        if (line.active) this.activateFact(state, t, i, changes);
        return;
      }
    }
  }

  /** A model-usage line is (now) shown: its response is re-derived. */
  private activateFact(state: SessionState, t: Thread, i: number, changes: Change[]): void {
    const r = t.lines[i]!.resp;
    if (r === null) return;
    if (r.firstCand < 0 || i < r.firstCand) {
      r.firstCand = i;
      r.attachBase = this.shownBefore(t, i);
    }
    this.refreshResp(state, t, r, changes);
  }

  /** The line of the last shown node before line `i` (the last line: the thread's last node), or -1. */
  private shownBefore(t: Thread, i: number): number {
    if (i === t.lines.length - 1) return t.prevLine;
    for (let j = i - 1; j >= 0; j--) {
      const l = t.lines[j]!;
      if (l.active && l.node !== null) return j;
    }
    return -1;
  }

  // ---- conversation items ----

  private item(state: SessionState, t: Thread, line: Line, i: number, rec: Obj, pd: Obj, ts: string | null, changes: Change[]): string | undefined {
    const nodeId = buddyNodeId(state.session.id, t.agentId, `@${t.lastOffset}`);
    const messageId = idOf(pd.messageId);
    const assistant = rec.type === 'message' && rec.role === 'assistant';
    const outputItem = assistant || rec.type === 'reasoning' || rec.type === 'function_call' || rec.type === 'function_call_result' || rec.type === 'function_call_output';
    const cand = outputItem ? (buddyUsage(pd.rawUsage) ?? buddyUsage(pd.usage) ?? (isObject(rec.message) ? buddyUsage(rec.message.usage) : null)) : null;
    const model = assistant || rec.type === 'reasoning' || rec.type === 'function_call' ? this.rawModel(state, t, pd) : { auto: false };
    const raw = model.raw !== undefined ? { raw: model.raw } : {};
    const prevBefore = t.prevLine;
    let unknown: string | undefined;
    switch (rec.type) {
      case 'message': {
        if (rec.role === 'user') this.userMessage(state, t, line, rec, pd, nodeId, ts, changes);
        else if (assistant) {
          const text = assistantText(rec.content);
          if (text.trim() !== '') this.addLineNode(state, t, line, pd, { ...blankNode(nodeId, 'text', 'Text', brief(text)), messageId }, ts, { text, ...raw }, changes);
        } else if (rec.role === 'system') {
          const text = partsText(rec.content, '\n');
          const separator = pd.isSessionSeparator === true || (line.id !== null && (line.id.startsWith('session-separator-') || line.id.startsWith('clear-')));
          const spec = separator ? { ...blankNode(nodeId, 'system', 'Clear', brief(text)), systemSubtype: 'clear' } : blankNode(nodeId, 'system', 'System', brief(text));
          this.addLineNode(state, t, line, pd, spec, ts, { text }, changes);
        }
        break;
      }
      case 'reasoning': {
        const text = reasoningText(rec);
        if (text.trim() !== '') this.addLineNode(state, t, line, pd, { ...blankNode(nodeId, 'thinking', 'Thinking', brief(text)), messageId }, ts, { text, ...raw }, changes);
        break;
      }
      case 'function_call':
        this.functionCall(state, t, line, rec, pd, nodeId, messageId, ts, raw, changes);
        break;
      case 'function_call_result':
      case 'function_call_output':
        unknown = this.functionResult(state, t, line, i, rec, pd, ts, changes);
        break;
    }
    if (line.node !== null && model.auto) state.autoNodes.set(line.node, model.raw!.model);
    // Usage: one response per messageId; a node or a usage record without one is a response of its own.
    if (cand !== null || (line.node !== null && messageId !== null)) {
      const r = this.resp(t, messageId, i);
      line.resp = r;
      if (line.node !== null) r.nodes.push(i);
      if (cand !== null) {
        r.cands.push({ line: i, usage: cand.usage, total: cand.total });
        if (r.firstCand < 0) {
          r.firstCand = i;
          r.attachBase = prevBefore;
        }
      }
      this.refreshResp(state, t, r, changes);
    }
    return unknown;
  }

  /**
   * `{raw: {model}}` for a model output item (format reference 6.3: model, else requestModelId). The router placeholder
   * `auto` shows the session's concrete model (`auto` while there is none); `auto: true` marks such a node.
   */
  private rawModel(state: SessionState, t: Thread, pd: Obj): { raw?: { model: string }; auto: boolean } {
    const concrete = concreteModel(pd.model) ?? concreteModel(pd.requestModelId);
    if (concrete !== null) {
      if (t.firstModel === null) {
        t.firstModel = { model: concrete, seq: state.seq };
        this.refreshConcrete(state);
      }
      return { raw: { model: concrete }, auto: false };
    }
    const auto = [pd.model, pd.requestModelId].some((v) => typeof v === 'string' && v.toLowerCase() === AUTO);
    if (!auto) return { auto: false };
    return { raw: { model: state.concrete ?? AUTO }, auto: true };
  }

  /** The session's concrete model: the first one read (by sequence) over its threads. */
  private refreshConcrete(state: SessionState): void {
    let best: { model: string; seq: number } | null = null;
    for (const th of state.threads.values()) if (th.firstModel !== null && (best === null || th.firstModel.seq < best.seq)) best = th.firstModel;
    const next = best?.model ?? null;
    if (next === state.concrete) return;
    state.concrete = next;
    state.concreteDirty = true;
  }

  /** Nodes of `auto` lines show the session's concrete model now. */
  private flushConcrete(state: SessionState, changes: Change[]): void {
    if (!state.concreteDirty) return;
    state.concreteDirty = false;
    const want = state.concrete ?? AUTO;
    for (const [id, shown] of state.autoNodes) {
      if (shown === want || !state.nodes.has(id)) continue;
      state.autoNodes.set(id, want);
      changes.push({ type: 'node_updated', sessionId: state.session.id, id, patch: {}, detail: { raw: { model: want } } });
    }
  }

  private userMessage(state: SessionState, t: Thread, line: Line, rec: Obj, pd: Obj, nodeId: string, ts: string | null, changes: Change[]): void {
    const kind = classifyUserMessage(rec);
    if (kind === 'hidden') return;
    if (kind === 'compaction') {
      const text = partsText(rec.content, '\n');
      this.addLineNode(state, t, line, pd, { ...blankNode(nodeId, 'system', 'Compact', brief(text)), systemSubtype: 'compact' }, ts, { text }, changes);
      return;
    }
    const text = humanText(rec.content);
    if (text === null) return;
    const c = idOf(pd.conversationRequestId);
    line.turn = kind === 'prompt' ? this.promptTurn(t, c) : (t.cur ?? this.newTurn(t, c));
    this.addNode(state, t, line, blankNode(nodeId, 'prompt', 'Prompt', brief(text)), ts, { text }, changes);
    if (t.firstPrompt === null) {
      const title = promptTitle(head(text, PREFIX_MAX));
      if (title !== null) t.firstPrompt = own(title);
    }
  }

  // ---- turns ----

  private newTurn(t: Thread, c: string | null): Turn {
    const turn: Turn = { c, first: null };
    t.turns.push(turn);
    if (c !== null && !t.turnsByC.has(c)) t.turnsByC.set(c, turn);
    t.cur = turn;
    return turn;
  }

  /** A prompt opens a turn (or joins the one its request id already names). */
  private promptTurn(t: Thread, c: string | null): Turn {
    const known = c === null ? undefined : t.turnsByC.get(c);
    if (known !== undefined) {
      t.cur = known;
      return known;
    }
    return this.newTurn(t, c);
  }

  /**
   * The turn of a line that is not a prompt: the turn its request id names; a running turn without a request id adopts
   * it (a prompt written without one); another request id opens a turn (a request without a prompt node, e.g. a cron
   * trigger); no request id: the running turn.
   */
  private outputTurn(t: Thread, c: string | null): Turn | null {
    if (c === null) return t.cur;
    const known = t.turnsByC.get(c);
    if (known !== undefined) {
      t.cur = known;
      return known;
    }
    if (t.cur !== null && t.cur.c === null) {
      t.cur.c = c;
      t.turnsByC.set(c, t.cur);
      return t.cur;
    }
    return this.newTurn(t, c);
  }

  // ---- nodes ----

  /** A node of a line that is not a prompt (its turn by request id). */
  private addLineNode(state: SessionState, t: Thread, line: Line, pd: Obj, spec: NodeSpec, ts: string | null, detail: Partial<NodeDetail>, changes: Change[]): void {
    line.turn = this.outputTurn(t, idOf(pd.conversationRequestId));
    this.addNode(state, t, line, spec, ts, detail, changes);
  }

  /** Adds the node of `line` (the thread's last line) at the end of thread `t`, with the edge into it. */
  private addNode(state: SessionState, t: Thread, line: Line, spec: NodeSpec, ts: string | null, detail: Partial<NodeDetail>, changes: Change[]): void {
    this.start(state, changes);
    const id = spec.id;
    const turn = line.turn;
    if (turn !== null && turn.first === null) turn.first = id;
    const link = t.prev === null && t.linkedTo !== null && state.nodes.has(t.linkedTo.nodeId) ? t.linkedTo.nodeId : null;
    const from = t.prev ?? link;
    const timestamp = ts ?? t.prevTs ?? t.lastTs ?? EPOCH;
    const full: GraphNode = { ...spec, sessionId: state.session.id, turnId: turn?.first ?? null, agentId: t.agentId, parentId: from, timestamp, confirmed: true };
    state.nodes.set(id, full);
    line.node = id;
    changes.push({ type: 'node_added', node: full, detail });
    if (from !== null) changes.push({ type: 'edge_added', edge: { id: `${from}->${id}`, sessionId: state.session.id, from, to: id, kind: t.prev === null ? 'spawn' : 'sequence' } });
    t.prev = id;
    t.prevLine = t.lines.length - 1;
    t.prevTs = timestamp;
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

  // ---- usage ----

  /** The response of `messageId` (null: line `i`'s own). */
  private resp(t: Thread, messageId: string | null, i: number): Resp {
    const key = messageId ?? `\u0000${i}`;
    let r = t.resps.get(key);
    if (r === undefined) {
      r = { own: messageId === null, cands: [], nodes: [], best: null, bestTotal: -1, target: -1, firstCand: -1, attachBase: -1 };
      t.resps.set(key, r);
    }
    return r;
  }

  /** The largest usage of the response's shown candidates (the first of equal ones). */
  private bestOf(t: Thread, r: Resp): void {
    r.best = null;
    r.bestTotal = -1;
    for (const c of r.cands) {
      if (!t.lines[c.line]!.active) continue;
      if (c.total > r.bestTotal) {
        r.best = c.usage;
        r.bestTotal = c.total;
      }
    }
  }

  /** The first line of `r` whose node is shown, or -1. */
  private holderOf(t: Thread, r: Resp): number {
    for (const j of r.nodes) {
      const l = t.lines[j]!;
      if (l.active && l.node !== null) return j;
    }
    return -1;
  }

  /**
   * Where a response's usage goes (spec section 10 item 3): its first shown node; a response without a shown node (a
   * model-usage record, a reply without text) goes on the shown node before its first record, or rather on that node's
   * response holder, so that one messageId never carries usage on two nodes.
   */
  private place(t: Thread, r: Resp): void {
    r.target = -1;
    if (r.best === null) return;
    let target = this.holderOf(t, r);
    if (target < 0 && r.attachBase >= 0) {
      const base = t.lines[r.attachBase]!;
      const owner = base.resp;
      target = owner !== null && !owner.own ? this.holderOf(t, owner) : r.attachBase;
      if (target < 0) target = r.attachBase;
    }
    if (target < 0) return;
    r.target = target;
    pushTo(t.contrib, target, r);
  }

  /** The usage on the node of line `j`: the sum of the responses placed on it. */
  private usageOn(t: Thread, j: number): Usage | null {
    let sum: Usage | null = null;
    for (const r of t.contrib.get(j) ?? []) sum = addUsage(sum, r.best);
    return sum;
  }

  /** Re-derives one response after a line of it was applied: its best usage and where it is; emits the nodes that change. */
  private refreshResp(state: SessionState, t: Thread, r: Resp, changes: Change[]): void {
    const oldTarget = r.target;
    this.bestOf(t, r);
    if (oldTarget >= 0) {
      const list = t.contrib.get(oldTarget);
      if (list !== undefined) {
        const rest = list.filter((x) => x !== r);
        if (rest.length === 0) t.contrib.delete(oldTarget);
        else t.contrib.set(oldTarget, rest);
      }
    }
    this.place(t, r);
    for (const j of oldTarget === r.target ? [oldTarget] : [oldTarget, r.target]) {
      if (j < 0) continue;
      const id = t.lines[j]!.node;
      const node = id === null ? undefined : state.nodes.get(id);
      if (node !== undefined) this.update(state, { ...node, usage: this.usageOn(t, j) }, changes);
    }
  }

  // ---- tool calls ----

  private functionCall(state: SessionState, t: Thread, line: Line, rec: Obj, pd: Obj, nodeId: string, messageId: string | null, ts: string | null, raw: { raw?: { model: string } }, changes: Change[]): void {
    const name = nonEmpty(rec.name);
    let input: unknown = rec.arguments;
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        // kept as the string (a call cut at the output limit, format reference 3.5)
      }
    }
    const draft = pd.codebuddyArgumentsTruncated === true || pd.isPartialAborted === true || pd.discard === true;
    const toolName = name === null ? null : brief(name);
    const label = isObject(input) ? nonEmpty(input.subagent_type) : null;
    const call: Call = {
      nodeId,
      callId: idOf(rec.callId) ?? '',
      thread: t,
      name: toolName,
      baseStatus: draft ? 'failed' : 'running',
      baseEnded: draft ? (ts ?? t.lastTs ?? EPOCH) : null,
      result: -1,
      before: -1,
      facts: null,
      messageId,
      inputKey: inputKeyOf(toolName, input),
      argSummary: toolSummary(input),
      argLabel: label === null ? null : brief(label),
      touches: toolName === null ? [] : buddyTouches(toolName, input).slice(0, MAX_TOUCHES).map((x) => ({ path: own(x.path.slice(0, PATH_MAX_CHARS)), action: x.action })),
      cwd: t.cwd,
      dispatch: toolName !== null && SUBAGENT_TOOLS.has(toolName),
      childId: null,
    };
    line.call = call;
    line.turn = this.outputTurn(t, idOf(pd.conversationRequestId));
    const timestamp = ts ?? t.prevTs ?? t.lastTs ?? EPOCH;
    const { sessionId: _s, turnId: _t, agentId: _a, parentId: _p, timestamp: _ts, confirmed: _c, ...spec } = this.callNode(state, call, {
      ...blankNode(nodeId, 'tool', 'tool', ''),
      sessionId: state.session.id,
      turnId: null,
      agentId: t.agentId,
      parentId: null,
      timestamp,
      confirmed: true,
    });
    this.addNode(state, t, line, spec, ts, { input, ...raw }, changes);
    state.callByNode.set(nodeId, call);
    if (call.callId !== '') pushTo(t.open, call.callId, call);
  }

  /**
   * A result (format reference 3.6, 5): paired with the nearest preceding shown call of its callId that has no result;
   * an orphan is dropped and counted. Failed when its status is not completed or it carries an error (D10).
   */
  private functionResult(state: SessionState, t: Thread, line: Line, i: number, rec: Obj, pd: Obj, ts: string | null, changes: Change[]): string | undefined {
    const callId = idOf(rec.callId);
    if (callId === null) return `${this.origin}:orphan-result`;
    const toolResult = isObject(pd.toolResult) ? pd.toolResult : {};
    const failed = (typeof rec.status === 'string' && rec.status !== 'completed') || Boolean(pd.error) || Boolean(toolResult.error);
    const sub = isObject(toolResult.subAgent) ? toolResult.subAgent : null;
    const descriptor = sub !== null && isObject(sub.descriptor) ? sub.descriptor : {};
    const label = nonEmpty(descriptor.role) ?? nonEmpty(descriptor.agentNickname);
    const facts: ResultFacts = {
      callId,
      status: failed ? 'failed' : 'succeeded',
      endedAt: ts ?? t.lastTs ?? EPOCH,
      childId: sub === null ? null : idOf(sub.sessionId),
      label: label === null ? null : brief(label),
    };
    line.result = facts;
    const call = t.open.get(callId)?.pop() ?? null;
    if (call === null) return `${this.origin}:orphan-result`;
    call.result = i;
    call.facts = facts;
    const affected = new Set<Thread>();
    if (facts.childId !== null && facts.childId !== call.childId) {
      if (call.childId !== null) this.unnameChild(state, call, affected);
      this.nameChild(state, call, facts.childId, affected);
    }
    let output: unknown = outputText(rec.output);
    if (output === null) output = rec.output !== undefined ? rec.output : outputText(toolResult.content);
    const node = state.nodes.get(call.nodeId);
    if (node !== undefined) this.update(state, this.callNode(state, call, node), changes, { output });
    for (const child of affected) this.relink(state, child, changes);
    return undefined;
  }

  /** A call's node as its state says. */
  private callNode(state: SessionState, call: Call, old: GraphNode): GraphNode {
    const facts = call.facts;
    const childAgentId = call.childId !== null && state.threads.get(call.childId)?.linkedTo === call ? call.childId : null;
    const subagent = call.dispatch || call.childId !== null;
    const endedAt = facts?.endedAt ?? call.baseEnded;
    const durationMs = endedAt === null ? null : Math.max(0, Date.parse(endedAt) - Date.parse(old.timestamp)) || 0;
    return {
      ...old,
      files: undefined,
      filesTruncated: undefined,
      kind: subagent ? 'subagent' : 'tool',
      title: subagent ? (facts?.label ?? call.argLabel ?? call.name ?? 'subagent') : (call.name ?? 'tool'),
      summary: call.argSummary,
      status: facts?.status ?? call.baseStatus,
      toolName: call.name,
      toolUseId: call.callId === '' ? null : call.callId,
      messageId: call.messageId,
      childAgentId,
      endedAt,
      durationMs,
      ...filesFields(subagent ? {} : nodeFiles(call.touches, call.cwd)),
      ...inputKeyFields(call.inputKey),
    };
  }

  private refreshCall(state: SessionState, call: Call, changes: Change[]): void {
    const node = state.nodes.get(call.nodeId);
    if (node !== undefined) this.update(state, this.callNode(state, call, node), changes);
  }

  // ---- subagent threads ----

  private nameChild(state: SessionState, call: Call, childId: string, affected: Set<Thread>): void {
    if (childId === call.thread.agentId) return;
    call.childId = childId;
    pushTo(state.childCalls, childId, call);
    this.childThread(state, childId, affected);
  }

  private unnameChild(state: SessionState, call: Call, affected: Set<Thread>): void {
    const childId = call.childId;
    if (childId === null) return;
    call.childId = null;
    const list = state.childCalls.get(childId);
    if (list !== undefined) {
      const rest = list.filter((c) => c !== call);
      if (rest.length === 0) state.childCalls.delete(childId);
      else state.childCalls.set(childId, rest);
    }
    this.childThread(state, childId, affected);
  }

  /** Marks the thread `childId` (when read already) for a relink. */
  private childThread(state: SessionState, childId: string, affected: Set<Thread>): void {
    const t = state.threads.get(childId);
    if (t !== undefined) affected.add(t);
  }

  /** The first shown node of a thread (in line order). */
  private firstShown(state: SessionState, t: Thread): string | null {
    for (const l of t.lines) if (l.node !== null && state.nodes.has(l.node)) return l.node;
    return null;
  }

  /**
   * Hangs agent thread `t` off the first shown call naming its id (in the order they named it), or off nothing: the
   * thread's first shown node gets that parent (and a spawn edge), the call its childAgentId.
   */
  private relink(state: SessionState, t: Thread, changes: Change[]): void {
    if (t.agentId === null) return;
    const want = (state.childCalls.get(t.agentId) ?? []).find((c) => c.thread !== t && state.nodes.has(c.nodeId)) ?? null;
    const old = t.linkedTo;
    if (want !== old) {
      t.linkedTo = want;
      if (old !== null) this.refreshCall(state, old, changes);
      if (want !== null) this.refreshCall(state, want, changes);
    }
    const first = this.firstShown(state, t);
    if (first === null) return;
    const node = state.nodes.get(first)!;
    const parent = want?.nodeId ?? null;
    if (node.parentId === parent) return;
    const sid = state.session.id;
    if (node.parentId !== null && state.nodes.has(node.parentId)) changes.push({ type: 'edge_removed', sessionId: sid, id: `${node.parentId}->${node.id}` });
    this.update(state, { ...node, parentId: parent }, changes);
    if (parent !== null) changes.push({ type: 'edge_added', edge: { id: `${parent}->${node.id}`, sessionId: sid, from: parent, to: node.id, kind: 'spawn' } });
  }

  // ---- removal and restarts ----

  /** Removes one shown node (kept as a skeleton); a call's node takes its child link with it. */
  private removeNode(state: SessionState, t: Thread, id: string, affected: Set<Thread>, changes: Change[]): void {
    const node = state.nodes.get(id);
    if (node === undefined) return;
    state.nodes.delete(id);
    t.hidden.set(id, node);
    changes.push({ type: 'node_removed', sessionId: state.session.id, id });
    const call = state.callByNode.get(id);
    if (call === undefined || call.childId === null) return;
    const child = state.threads.get(call.childId);
    if (child !== undefined && child.linkedTo === call) affected.add(child);
  }

  /** The thread's file is read again from its start: everything its old content made is removed. */
  private resetThread(state: SessionState, t: Thread, changes: Change[]): void {
    const affected = new Set<Thread>();
    for (const l of t.lines) {
      if (l.node !== null) {
        if (state.nodes.has(l.node)) this.removeNode(state, t, l.node, affected, changes);
        state.callByNode.delete(l.node);
        state.autoNodes.delete(l.node);
      }
      if (l.call !== null && l.call.childId !== null) this.unnameChild(state, l.call, affected);
    }
    const linkedTo = t.linkedTo;
    Object.assign(t, this.blankThread(t.agentId), { linkedTo });
    this.refreshConcrete(state);
    this.flushConcrete(state, changes);
    for (const child of affected) if (child !== t) this.relink(state, child, changes);
  }

  // ---- session ----

  /**
   * The session as a function of what was read: title = the main file's latest non-empty custom-title, else its latest
   * ai-title, else its latest topic, else its first prompt; cwd = the main file's latest `cwd`; started / last activity
   * = the earliest / latest line time over all threads; status running (spec 4.5 turns a quiet session idle).
   */
  private commitSession(state: SessionState, changes: Change[]): void {
    const main = state.threads.get(MAIN);
    let minMs: number | null = null;
    let maxMs: number | null = null;
    for (const th of state.threads.values()) {
      if (th.minMs !== null) minMs = minMs === null ? th.minMs : Math.min(minMs, th.minMs);
      if (th.maxMs !== null) maxMs = maxMs === null ? th.maxMs : Math.max(maxMs, th.maxMs);
    }
    const startedAt = minMs === null ? EPOCH : isoOfMs(minMs);
    const lastActivityAt = isoOfMs(Math.max(maxMs ?? Number.NEGATIVE_INFINITY, Date.parse(startedAt)));
    const next: Session = {
      ...state.session,
      projectId: state.projectId,
      cwd: main?.cwd ?? null,
      title: main?.customTitle ?? main?.aiTitle ?? main?.topic ?? main?.firstPrompt ?? null,
      gitBranch: null,
      status: 'running',
      startedAt,
      lastActivityAt,
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
