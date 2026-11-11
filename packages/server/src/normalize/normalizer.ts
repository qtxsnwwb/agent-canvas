import { isDeepStrictEqual } from 'node:util';
import {
  TERMINAL_STATUSES,
  type Change,
  type GraphEdge,
  type GraphNode,
  type NodeDetail,
  type NodeStatus,
  type Session,
} from '@claude-canvas/shared';
import type { RawEvent } from '../store/store.js';
import { parseHook, type HookDescription, type HookNodeEffect } from './hooks.js';
import { summarize } from './summary.js';
import {
  classifyRecord,
  impliedStatus,
  type AssistantBlock,
  type Classified,
  type MessageMeta,
  type TranscriptRecord,
} from './transcript.js';

export interface NormalizeResult {
  changes: Change[];
  unknownRecordType?: string;
}

const EPOCH = '1970-01-01T00:00:00.000Z';
/** Title sources, highest priority first. */
const TITLE_PRIORITY = ['custom', 'agentName', 'hook', 'prompt'] as const;
type TitleSource = (typeof TITLE_PRIORITY)[number];
const PROMPT_TITLE_CHARS = 60;

/** Prompt text as a title: trimmed, line breaks folded into single spaces, first 60 code points; null when nothing is left. */
function promptTitle(text: string): string | null {
  const folded = text.trim().replace(/\s*(?:\r\n|[\r\n])\s*/g, ' ');
  if (folded.replace(/\[image\]/g, '').trim() === '') return null; // empty, or only image placeholders
  return Array.from(folded).slice(0, PROMPT_TITLE_CHARS).join('');
}

const KNOWN_TYPES = new Set(['user', 'assistant', 'system', 'attachment']);
/** The tool an agent's thread calls last when it hands its result back (desktop app; seen in real transcripts, 2026-11-11). */
const HANDBACK_TOOL = 'SubagentHandback';

/**
 * How several end signals for one dispatch combine, whatever order they come in (commutative and associative): a
 * failure wins over a success (the agent was resumed and then failed, or the notification knows better than the
 * thread's last record), and otherwise the earlier time.
 */
function mergeEnd(a: AgentEnd, b: AgentEnd): AgentEnd {
  if (a.status !== b.status) return a.status === 'failed' ? a : b;
  return a.at <= b.at ? a : b;
}

/** `<status>` values of a task notification that mean the task is over, and how (anything else is not an end). */
const NOTIFIED_END: Readonly<Record<string, 'succeeded' | 'failed'>> = {
  completed: 'succeeded', failed: 'failed', killed: 'failed', stopped: 'failed', cancelled: 'failed', canceled: 'failed',
  error: 'failed', timeout: 'failed',
};

/** In-memory state for one session; later tasks extend this with batch/subagent bookkeeping. */
interface SessionState {
  session: Session;
  /** Event time at which the session status was last set (transcript timestamp or hook receivedAt). */
  statusAt: string;
  nodes: Map<string, GraphNode>;
  /** tool node id -> original tool input (permission matching needs it). */
  toolInputs: Map<string, unknown>;
  /**
   * Tool nodes whose terminal status came from a transcript tool_result (final). A terminal status not listed here
   * was set by a hook and is still corrected by a later tool_result (content plane wins), except `denied`.
   */
  terminalFromContent: Set<string>;
  /** Tool nodes whose durationMs was supplied by a hook's duration_ms (not derived from start/end times). */
  durationFromHook: Set<string>;
  /** record uuid -> id of the last node that record produced. */
  lastNodeByUuid: Map<string, string>;
  /** uuid of a record that produced no node -> its parentUuid. */
  passthrough: Map<string, string | null>;
  /** agentId ('' for the main thread) -> current turn id. */
  turnByAgent: Map<string, string>;
  /** agentId ('' for the main thread) -> currently open run of same-message tool_use nodes. */
  batches: Map<string, Batch>;
  /** agentId -> first node produced by that agent. */
  firstNodeByAgent: Map<string, string>;
  /** agentId -> dispatch (tool) node id, known from the agent meta. */
  dispatchByAgent: Map<string, string>;
  /** toolUseId -> agent meta, kept so the dispatch node can be updated when it appears later. */
  agentMetas: Map<string, AgentMeta>;
  /** agents whose spawn edge was already emitted. */
  spawned: Set<string>;
  /** Dispatch node ids known to be background launches (their launch answer was read). */
  asyncIds: Set<string>;
  /** Those of them still open (no end signal yet). */
  asyncDispatch: Set<string>;
  /** agentId -> its background launches (dispatch node ids). */
  launches: Map<string, string[]>;
  /** Background dispatch node id -> its agent, once known. */
  agentOfLaunch: Map<string, string>;
  /** Background dispatch node id -> when the same agent's next background launch started (it had ended by then). */
  nextLaunchAt: Map<string, string>;
  /**
   * Every time the session became `ended`. A background agent still open at such a moment was cut off with it, and
   * does not come back when the session is resumed (the process it ran in is gone).
   */
  sessionEnds: string[];
  /** agentId -> every end signal seen for the agent's thread. */
  agentSignals: Map<string, AgentSignal[]>;
  /**
   * Dispatch node id -> the end signals that apply to it: `direct` name the dispatch itself (a task notification, the
   * end of the session, the hook for a foreground agent); `routed` are the agent's thread signals falling in this
   * launch's window (recomputed whenever the agent's signals or launches change).
   */
  dispatchSignals: Map<string, { direct: AgentEnd[]; routed: AgentEnd[] }>;
  /** Dispatch nodes whose current end was written from those signals. */
  agentEnded: Set<string>;
  /** toolUseId -> a task notification seen before its launch was known to be a background one. */
  notified: Map<string, AgentEnd[]>;
  /** The first main-thread prompt has been seen (whether or not it gave a title). */
  firstPromptSeen: boolean;
}

interface AgentEnd { at: string; status: 'succeeded' | 'failed' }
/** An end signal for an agent's thread; `viaHook`: the SubagentStop hook (which also ends a foreground agent's dispatch). */
interface AgentSignal extends AgentEnd { viaHook: boolean }

interface Placement {
  node: GraphNode;
  edgeKind: GraphEdge['kind'];
  /** first batch member that needs the retroactive `:fork` edge. */
  forkFirst: string | null;
  /** earlier batch members that join into this node. */
  joinFrom: string[];
}

interface Batch {
  messageId: string;
  /** parent shared by every member (the first member's parent). */
  parentId: string | null;
  members: string[];
}

interface AgentMeta {
  agentId: string;
  toolUseId: string;
  agentType: string;
  description: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Milliseconds from `start` to `end` (never negative); null when either time cannot be parsed. */
function elapsedMs(start: string, end: string): number | null {
  const a = Date.parse(start);
  const b = Date.parse(end);
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.max(0, b - a);
}

export class Normalizer {
  private readonly sessions = new Map<string, SessionState>();
  /**
   * Current title per source, per session. Kept outside SessionState so a title arriving before its session exists is
   * not lost, and replaying raw events in order (also after an eviction) rebuilds the same values.
   */
  private readonly titleSources = new Map<string, Partial<Record<TitleSource, string>>>();
  private readonly pendingAgentMetas = new Map<string, AgentMeta[]>();
  /** Sessions without state whose pre-session memory (titles, pending agent metas) was restored by restorePreSession. */
  private readonly preSessionRestored = new Set<string>();

  apply(event: RawEvent, projectId: string): NormalizeResult {
    try {
      if (event.source === 'transcript') return this.applyTranscript(event, projectId);
      if (event.source === 'meta') return this.applyMeta(event);
      return this.applyHook(event, projectId);
    } catch {
      return { changes: [], unknownRecordType: 'normalizer-error' };
    }
  }

  dropSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    // Dropped state is rebuilt by replaying raw events in order, which restores every source's value (and discards
    // values from an ingest that was rolled back). A session that has no state yet is restored by restorePreSession.
    this.titleSources.delete(sessionId);
    this.pendingAgentMetas.delete(sessionId);
    this.preSessionRestored.delete(sessionId);
  }

  /** True when the session has no state and its pre-session memory has not been restored since it was last dropped. */
  needsPreSessionReplay(sessionId: string): boolean {
    return !this.sessions.has(sessionId) && !this.preSessionRestored.has(sessionId);
  }

  /**
   * For a session that has committed raw events but no session yet (e.g. only a custom-title record): rebuilds what
   * the Normalizer keeps before a session exists — title sources and pending agent metas — from those events, in
   * ingest order, exactly as applying them would. Nothing else is derived and no changes are produced.
   */
  restorePreSession(sessionId: string, events: Iterable<RawEvent>): void {
    this.dropSession(sessionId);
    try {
      for (const ev of events) this.replayPreSession(ev);
    } catch (err) {
      this.dropSession(sessionId);
      throw err;
    }
    if (!this.sessions.has(sessionId)) this.preSessionRestored.add(sessionId);
  }

  private replayPreSession(event: RawEvent): void {
    const ignored: Change[] = [];
    if (event.source === 'meta') {
      this.applyMeta(event);
      return;
    }
    if (event.source === 'hook') {
      const parsed = parseHook(event.eventName, event.payload);
      if (parsed.ok) this.setTitle(parsed.hook.sessionId, 'hook', parsed.hook.title, ignored);
      return;
    }
    if (event.agentId !== null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.line);
    } catch {
      return;
    }
    if (!isObject(parsed) || (parsed.type !== 'custom-title' && parsed.type !== 'agent-name')) return;
    const custom = parsed.type === 'custom-title';
    this.setTitle(event.sessionId, custom ? 'custom' : 'agentName', str(parsed[custom ? 'customTitle' : 'agentName']), ignored);
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Number of sessions held in memory. */
  sessionCount(): number {
    return this.sessions.size;
  }

  /** Number of tool inputs held in memory for a session (introspection for tests). */
  toolInputCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.toolInputs.size ?? 0;
  }

  private applyMeta(event: Extract<RawEvent, { source: 'meta' }>): NormalizeResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.payload);
    } catch {
      return { changes: [] };
    }
    if (!isObject(parsed)) return { changes: [] };
    const changes: Change[] = [];
    const state = this.sessions.get(event.sessionId);
    if (event.agentId === null) {
      this.setTitle(event.sessionId, 'custom', str(parsed.customTitle), changes);
      return { changes };
    }
    const toolUseId = str(parsed.toolUseId);
    const agentType = str(parsed.agentType);
    const description = str(parsed.description);
    if (toolUseId === null || agentType === null || description === null) return { changes };
    const meta: AgentMeta = { agentId: event.agentId, toolUseId, agentType, description };
    if (state) this.registerAgentMeta(state, meta, changes);
    else this.pendingAgentMetas.set(event.sessionId, [...(this.pendingAgentMetas.get(event.sessionId) ?? []), meta]);
    return { changes };
  }

  private registerAgentMeta(state: SessionState, meta: AgentMeta, changes: Change[]): void {
    state.agentMetas.set(meta.toolUseId, meta);
    state.dispatchByAgent.set(meta.agentId, `tool:${meta.toolUseId}`);
    this.applyAgentMeta(state, meta, changes);
    // Now that the agent is known, the signals already seen for its thread apply (a background launch read before its
    // meta; a foreground agent whose hook came first).
    const dispatch = `tool:${meta.toolUseId}`;
    if (state.asyncIds.has(dispatch)) this.addLaunch(state, meta.agentId, dispatch);
    this.routeAgentSignals(state, meta.agentId, changes);
  }

  /** Writes the meta onto the dispatch node (if it exists yet) and tries the spawn edge. */
  private applyAgentMeta(state: SessionState, meta: AgentMeta, changes: Change[]): void {
    const id = `tool:${meta.toolUseId}`;
    const node = state.nodes.get(id);
    if (!node) return;
    const patch: Partial<GraphNode> = { childAgentId: meta.agentId, title: meta.agentType, summary: summarize(meta.description) };
    state.nodes.set(id, { ...node, ...patch });
    changes.push({ type: 'node_updated', sessionId: state.session.id, id, patch });
    this.trySpawn(state, meta.agentId, changes);
  }

  /** Emits the spawn edge once both the dispatch node and the agent's first node exist; at most once per agent. */
  private trySpawn(state: SessionState, agentId: string, changes: Change[]): void {
    if (state.spawned.has(agentId)) return;
    const dispatch = state.dispatchByAgent.get(agentId);
    const first = state.firstNodeByAgent.get(agentId);
    if (dispatch === undefined || first === undefined) return;
    const firstNode = state.nodes.get(first);
    if (!state.nodes.has(dispatch) || !firstNode) return;
    state.spawned.add(agentId);
    const patch: Partial<GraphNode> = { parentId: dispatch };
    state.nodes.set(first, { ...firstNode, ...patch });
    changes.push({ type: 'node_updated', sessionId: state.session.id, id: first, patch });
    changes.push({
      type: 'edge_added',
      edge: { id: `${dispatch}->${first}`, sessionId: state.session.id, from: dispatch, to: first, kind: 'spawn' },
    });
  }

  private ensurePlaceholderTool(
    state: SessionState,
    spec: { toolUseId: string; toolName: string; input: unknown; agentId: string | null; timestamp: string },
    changes: Change[],
  ): void {
    const id = `tool:${spec.toolUseId}`;
    const existing = state.nodes.get(id);
    if (existing) {
      // The transcript record came first; a PreToolUse received earlier than that record still moves the start back.
      const patch: Partial<GraphNode> = {};
      this.earlierStart(state, existing, spec.timestamp, patch);
      if (Object.keys(patch).length > 0) {
        state.nodes.set(id, { ...existing, ...patch });
        changes.push({ type: 'node_updated', sessionId: state.session.id, id, patch });
        this.launchMoved(state, id, changes);
      }
      return;
    }
    const node: GraphNode = {
      id,
      sessionId: state.session.id,
      turnId: null,
      agentId: spec.agentId,
      parentId: null,
      kind: spec.toolName === 'Agent' || spec.toolName === 'Task' ? 'subagent' : 'tool',
      status: 'running',
      timestamp: spec.timestamp,
      confirmed: false,
      title: spec.toolName,
      summary: summarize(spec.input),
      toolName: spec.toolName,
      toolUseId: spec.toolUseId,
      messageId: null,
      durationMs: null,
      usage: null,
      systemSubtype: null,
      childAgentId: null,
      endedAt: null,
    };
    state.nodes.set(id, node);
    state.toolInputs.set(id, spec.input);
    changes.push({ type: 'node_added', node, detail: { input: spec.input } });
    const meta = state.agentMetas.get(spec.toolUseId);
    if (meta) this.applyAgentMeta(state, meta, changes);
  }

  /**
   * A tool node's start is the earlier of the times its PreToolUse hook and its transcript tool_use record give (the
   * record can be written after the tool already ran), whichever arrived first. Adds `timestamp` to `patch` when
   * `candidate` is earlier than the node's start, and re-derives a duration that was derived from the old start (a
   * hook's duration_ms stays).
   */
  private earlierStart(state: SessionState, node: GraphNode, candidate: string | null, patch: Partial<GraphNode>): void {
    if (candidate === null) return;
    const next = Date.parse(candidate);
    const current = Date.parse(node.timestamp);
    if (Number.isNaN(next) || (!Number.isNaN(current) && next >= current)) return;
    patch.timestamp = candidate;
    if (node.endedAt !== null && node.durationMs !== null && !state.durationFromHook.has(node.id)) {
      const derived = elapsedMs(candidate, node.endedAt);
      if (derived !== null) patch.durationMs = derived;
    }
  }

  private applyHook(event: Extract<RawEvent, { source: 'hook' }>, projectId: string): NormalizeResult {
    const parsed = parseHook(event.eventName, event.payload);
    if (!parsed.ok) return { changes: [], unknownRecordType: parsed.unknownRecordType };
    const hook = parsed.hook;
    const changes: Change[] = [];
    const at = event.receivedAt;
    const state = this.stateFor(hook.sessionId, { type: 'hook', uuid: '', timestamp: at, cwd: hook.cwd }, projectId, changes);
    // An ended session only comes back on SessionStart / UserPromptSubmit.
    const status = state.session.status === 'ended' && !hook.resumes ? null : hook.status;
    if (status !== null && at > state.statusAt) state.statusAt = at;
    this.updateSession(state, { type: 'hook', uuid: '', timestamp: at }, projectId, status, false, changes);
    // A background agent still open when the session ends was cut off with it.
    this.setTitle(hook.sessionId, 'hook', hook.title, changes);
    if (hook.node) this.applyHookNode(state, hook, hook.node, at, changes);
    return { changes };
  }

  private applyHookNode(state: SessionState, hook: HookDescription, effect: HookNodeEffect, at: string, changes: Change[]): void {
    switch (effect.kind) {
      case 'pre_tool':
        this.ensurePlaceholderTool(
          state,
          { toolUseId: effect.toolUseId, toolName: effect.toolName, input: effect.input, agentId: hook.agentId, timestamp: at },
          changes,
        );
        break;
      case 'permission_request':
        this.markAwaitingPermission(state, hook.agentId, effect, changes);
        break;
      case 'settle':
        // The launch answer of a background agent, arriving late or without its async marker, does not end the agent.
        if (effect.status !== 'denied' && state.asyncIds.has(`tool:${effect.toolUseId}`)) break;
        this.settleTool(state, effect, at, changes);
        break;
      case 'subagent_stop':
        this.finishAgent(state, effect.agentId, { at, status: 'succeeded', viaHook: true }, changes);
        break;
      case 'compact': {
        const id = `compact:${state.session.id}:${at}`;
        if (state.nodes.has(id)) break;
        const node: GraphNode = {
          id,
          sessionId: state.session.id,
          turnId: null,
          agentId: null,
          parentId: null,
          kind: 'system',
          status: null,
          timestamp: at,
          confirmed: false,
          title: 'Compact',
          summary: summarize(effect.summary),
          toolName: null,
          toolUseId: null,
          messageId: null,
          durationMs: null,
          usage: null,
          systemSubtype: 'compact',
          childAgentId: null,
          endedAt: null,
        };
        state.nodes.set(id, node);
        changes.push({ type: 'node_added', node, detail: { text: effect.summary } });
        break;
      }
    }
  }

  /** Newest running node of the same agent with the same tool name and deeply equal input. */
  private markAwaitingPermission(
    state: SessionState,
    agentId: string | null,
    effect: Extract<HookNodeEffect, { kind: 'permission_request' }>,
    changes: Change[],
  ): void {
    let match: GraphNode | null = null;
    for (const node of state.nodes.values()) {
      if (node.status !== 'running' || node.agentId !== agentId || node.toolName !== effect.toolName) continue;
      if (!isDeepStrictEqual(state.toolInputs.get(node.id), effect.input)) continue;
      if (match === null || node.timestamp >= match.timestamp) match = node;
    }
    if (match === null) return;
    const patch: Partial<GraphNode> = { status: 'awaiting_permission' };
    state.nodes.set(match.id, { ...match, ...patch });
    changes.push({ type: 'node_updated', sessionId: state.session.id, id: match.id, patch });
  }

  /**
   * A signal that the agent's thread has ended: the SubagentStop hook, or in its transcript an end_turn record, the
   * hand-back call, or an interrupt (failed). Signals arrive in any order, live or replayed, and before or after the
   * launch and the meta are known; the dispatch node's end is always recomputed from all of them (routeAgentSignals,
   * applyEnd), so it does not depend on the order.
   */
  private finishAgent(state: SessionState, agentId: string, signal: AgentSignal, changes: Change[]): void {
    const list = state.agentSignals.get(agentId) ?? [];
    if (!list.some((x) => x.at === signal.at && x.status === signal.status && x.viaHook === signal.viaHook)) list.push(signal);
    state.agentSignals.set(agentId, list);
    this.routeAgentSignals(state, agentId, changes);
  }

  private addLaunch(state: SessionState, agentId: string, dispatch: string): void {
    const list = state.launches.get(agentId) ?? [];
    if (!list.includes(dispatch)) list.push(dispatch);
    state.launches.set(agentId, list);
    state.agentOfLaunch.set(dispatch, agentId);
  }

  /** A background dispatch's start time moved (a hook earlier than its record): the windows of its agent's launches moved with it. */
  private launchMoved(state: SessionState, id: string, changes: Change[]): void {
    if (!state.asyncIds.has(id)) return;
    const agentId = state.agentOfLaunch.get(id);
    if (agentId !== undefined) this.routeAgentSignals(state, agentId, changes);
    else this.applyEnd(state, id, changes);
  }

  private signalsOf(state: SessionState, id: string): { direct: AgentEnd[]; routed: AgentEnd[] } {
    let entry = state.dispatchSignals.get(id);
    if (!entry) state.dispatchSignals.set(id, (entry = { direct: [], routed: [] }));
    return entry;
  }

  /**
   * Gives each of the agent's thread signals to the dispatch it belongs to. With background launches: the launch that
   * was running at the signal's time (the latest one started at or before it), so an agent launched twice ends each
   * launch with its own signals; a signal older than the first background launch belongs to none of them (an earlier
   * foreground run of the same agent). A launch followed by another launch of the same agent had ended by then
   * (`nextLaunchAt`). Without any background launch: only the hook counts, and it ends the agent's (foreground)
   * dispatch, as it always did; the thread's own records do not (its tool_result does).
   */
  private routeAgentSignals(state: SessionState, agentId: string, changes: Change[]): void {
    const signals = state.agentSignals.get(agentId) ?? [];
    const launches = (state.launches.get(agentId) ?? [])
      .map((id) => ({ id, at: state.nodes.get(id)?.timestamp ?? '' }))
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
    if (launches.length === 0) {
      const dispatch = state.dispatchByAgent.get(agentId);
      if (dispatch === undefined) return;
      this.signalsOf(state, dispatch).routed = signals.filter((x) => x.viaHook);
      this.applyEnd(state, dispatch, changes);
      return;
    }
    launches.forEach((l, i) => {
      this.signalsOf(state, l.id).routed = [];
      const next = launches[i + 1];
      if (next !== undefined) state.nextLaunchAt.set(l.id, next.at);
      else state.nextLaunchAt.delete(l.id);
    });
    for (const signal of signals) {
      let owner: { id: string; at: string } | undefined;
      for (const l of launches) if (l.at <= signal.at) owner = l;
      if (owner !== undefined) this.signalsOf(state, owner.id).routed.push(signal);
    }
    for (const l of launches) this.applyEnd(state, l.id, changes);
  }

  /** A signal that names the dispatch itself (a task notification). */
  private endDispatch(state: SessionState, id: string, end: AgentEnd, changes: Change[]): void {
    const node = state.nodes.get(id);
    if (!node || node.kind !== 'subagent') return;
    const { direct } = this.signalsOf(state, id);
    if (!direct.some((x) => x.at === end.at && x.status === end.status)) direct.push(end);
    this.applyEnd(state, id, changes);
  }

  /**
   * Writes onto the dispatch node what its signals and the session's state add up to; a function of the current state
   * only, so it does not matter in which order things were read. For a background launch, in this order: its own end
   * signals (mergeEnd); else, if the same agent was launched again later, succeeded when that launch started; else, if
   * the session ended after it was launched, failed at the first such end (a later resume does not bring it back);
   * else running. A foreground dispatch only takes hook signals and keeps
   * its first terminal event (its tool_result, a hook), as before; a denied node is never touched.
   */
  private applyEnd(state: SessionState, id: string, changes: Change[]): void {
    const node = state.nodes.get(id);
    if (!node || node.kind !== 'subagent' || node.status === 'denied') return;
    const entry = state.dispatchSignals.get(id);
    const all = entry ? [...entry.direct, ...entry.routed] : [];
    const background = state.asyncIds.has(id);
    const terminal = node.status !== null && TERMINAL_STATUSES.includes(node.status);
    let end: AgentEnd | null = all.length > 0 ? all.reduce(mergeEnd) : null;
    if (end === null && background) {
      const next = state.nextLaunchAt.get(id);
      if (next !== undefined) end = { at: next, status: 'succeeded' };
      else {
        let cut: string | null = null;
        for (const at of state.sessionEnds) if (at >= node.timestamp && (cut === null || at < cut)) cut = at;
        if (cut !== null) end = { at: cut, status: 'failed' };
      }
    }
    const patch: Partial<GraphNode> = {};
    if (end === null) {
      if (!background) return;
      state.asyncDispatch.add(id);
      if (node.status !== 'running') {
        patch.status = 'running';
        patch.endedAt = null;
        patch.durationMs = null;
      }
    } else {
      if (!background && terminal && !state.agentEnded.has(id)) return; // settled by something else first
      if (!background && state.terminalFromContent.has(id)) return; // its tool_result is final
      state.asyncDispatch.delete(id);
      state.agentEnded.add(id);
      if (node.status !== end.status) patch.status = end.status;
      if (node.endedAt !== end.at) patch.endedAt = end.at;
      const durationMs = elapsedMs(node.timestamp, end.at);
      if (node.durationMs !== durationMs) patch.durationMs = durationMs;
    }
    if (Object.keys(patch).length === 0) return;
    state.toolInputs.delete(id);
    state.durationFromHook.delete(id);
    if (background) state.terminalFromContent.delete(id);
    state.nodes.set(id, { ...node, ...patch });
    changes.push({ type: 'node_updated', sessionId: state.session.id, id, patch });
  }

  /**
   * `queue-operation` records with operation `enqueue` carry the task notifications the main thread receives (seen in
   * real transcripts, 2026-11-11): `<task-notification>…<tool-use-id>…</tool-use-id>…<status>completed|failed|…</status>`.
   * For a background agent this is the one end signal that names the dispatch directly and says how it ended.
   */
  private applyQueueOperation(sessionId: string, record: Record<string, unknown>, changes: Change[]): void {
    // Usually a string; a list of text blocks is read the same way.
    const content = Array.isArray(record.content)
      ? (record.content as unknown[]).flatMap((b) => (isObject(b) && typeof b.text === 'string' ? [b.text] : [])).join('')
      : str(record.content);
    // The notification is the whole queued item (a queued user prompt that merely quotes one is not a notification).
    if (record.operation !== 'enqueue' || content === null || !content.trimStart().startsWith('<task-notification>')) return;
    const toolUseId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(content)?.[1]?.trim();
    const reported = /<status>([^<]+)<\/status>/.exec(content)?.[1]?.trim().toLowerCase();
    const state = this.sessions.get(sessionId);
    const status = reported !== undefined ? NOTIFIED_END[reported] : undefined;
    if (!state || toolUseId === undefined || status === undefined) return;
    const end: AgentEnd = { at: str(record.timestamp) ?? state.session.lastActivityAt, status };
    const id = `tool:${toolUseId}`;
    if (state.asyncIds.has(id)) this.endDispatch(state, id, end, changes);
    else if (state.nodes.get(id)?.kind === 'subagent') {
      // Its launch is not known to be a background one yet; kept only for an agent dispatch (not a background shell task).
      state.notified.set(toolUseId, [...(state.notified.get(toolUseId) ?? []), end]);
    }
  }

  /** Moves a tool node to a terminal status unless it is already terminal (then only a missing duration is filled in). */
  private settleTool(
    state: SessionState,
    effect: Extract<HookNodeEffect, { kind: 'settle' }>,
    at: string,
    changes: Change[],
  ): void {
    const id = `tool:${effect.toolUseId}`;
    const node = state.nodes.get(id);
    if (!node) return;
    const terminal = node.status !== null && TERMINAL_STATUSES.includes(node.status);
    const patch: Partial<GraphNode> = {};
    if (!terminal) {
      patch.status = effect.status;
      patch.endedAt = at;
      state.toolInputs.delete(id); // only non-terminal nodes are PermissionRequest candidates
    }
    if (node.durationMs === null) {
      const derived = !terminal && effect.durationMs === null ? elapsedMs(node.timestamp, at) : null;
      const durationMs = effect.durationMs ?? derived;
      if (durationMs !== null) patch.durationMs = durationMs;
      if (effect.durationMs !== null) state.durationFromHook.add(id);
    }
    const withOutput = !terminal && 'output' in effect;
    if (Object.keys(patch).length === 0) return;
    state.nodes.set(id, { ...node, ...patch });
    changes.push({
      type: 'node_updated',
      sessionId: state.session.id,
      id,
      patch,
      ...(withOutput ? { detail: { output: effect.output } } : {}),
    });
  }

  private applyTranscript(event: Extract<RawEvent, { source: 'transcript' }>, projectId: string): NormalizeResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.line);
    } catch {
      return { changes: [], unknownRecordType: 'invalid-json' };
    }
    if (!isObject(parsed)) return { changes: [], unknownRecordType: 'invalid-json' };
    const type = parsed.type;
    if (typeof type !== 'string') return { changes: [], unknownRecordType: 'missing-type' };
    if (type === 'custom-title' || type === 'agent-name') {
      if (event.agentId !== null) return { changes: [] }; // a subagent file's title records say nothing about the session
      const changes: Change[] = [];
      this.setTitle(event.sessionId, type === 'custom-title' ? 'custom' : 'agentName', str(parsed[type === 'custom-title' ? 'customTitle' : 'agentName']), changes);
      return { changes };
    }
    if (type === 'queue-operation') {
      const changes: Change[] = [];
      // Like any record that produces no node, it must not break the parent chain (should it carry a uuid).
      const queueUuid = str(parsed.uuid);
      if (queueUuid !== null) this.sessions.get(event.sessionId)?.passthrough.set(queueUuid, str(parsed.parentUuid));
      this.applyQueueOperation(event.sessionId, parsed, changes);
      return { changes };
    }
    if (!KNOWN_TYPES.has(type)) {
      // Keep the parent chain intact across records we do not understand (only once the session exists).
      const unknownUuid = str(parsed.uuid);
      if (unknownUuid !== null) this.sessions.get(event.sessionId)?.passthrough.set(unknownUuid, str(parsed.parentUuid));
      return { changes: [], unknownRecordType: type };
    }
    const uuid = str(parsed.uuid);
    if (uuid === null) return type === 'attachment' ? { changes: [] } : { changes: [], unknownRecordType: `${type}:malformed` };
    const record = { ...parsed, type, uuid } as TranscriptRecord;

    const changes: Change[] = [];
    const state = this.stateFor(event.sessionId, record, projectId, changes);
    const classified = classifyRecord(record);
    const agentId = event.agentId;

    // A record older than the last status observation (e.g. a lagging transcript) must not overwrite it.
    const recordTime = str(record.timestamp);
    let implied = impliedStatus(classified, agentId !== null);
    if (implied !== null && recordTime !== null) {
      if (recordTime < state.statusAt) implied = null;
      else state.statusAt = recordTime;
    }
    this.updateSession(state, record, projectId, implied, agentId !== null, changes);
    if (classified.kind === 'prompt' && agentId === null) state.turnByAgent.set('', str(record.promptId) ?? uuid);

    const parentUuid = str(record.parentUuid);
    switch (classified.kind) {
      case 'silent':
        state.passthrough.set(uuid, parentUuid);
        break;
      case 'tool_results':
        state.passthrough.set(uuid, parentUuid);
        this.applyToolResults(state, classified, str(record.timestamp) ?? state.session.lastActivityAt, changes);
        break;
      case 'malformed':
        this.addNode(state, record, agentId, changes, {
          kind: 'unknown',
          title: 'Unknown',
          summary: summarize(event.line),
          detail: { raw: record },
        });
        break;
      case 'prompt':
        if (agentId === null) {
          // Only the first main-thread prompt can name the session, even when it yields no usable text.
          if (!state.firstPromptSeen) {
            state.firstPromptSeen = true;
            this.setTitle(state.session.id, 'prompt', promptTitle(classified.text), changes);
          }
        }
        this.addNode(state, record, agentId, changes, {
          kind: 'prompt',
          title: 'Prompt',
          summary: summarize(classified.text),
          detail: { text: classified.text },
        });
        break;
      case 'assistant':
        this.applyAssistant(state, record, agentId, classified, changes);
        break;
      case 'interrupt':
        if (agentId !== null) this.finishAgent(state, agentId, { at: str(record.timestamp) ?? state.session.lastActivityAt, status: 'failed', viaHook: false }, changes);
        this.addNode(state, record, agentId, changes, {
          kind: 'system',
          title: 'Interrupted',
          summary: summarize(classified.text),
          systemSubtype: 'interrupt',
          detail: { text: classified.text },
        });
        break;
      case 'compact':
        this.addNode(state, record, agentId, changes, {
          kind: 'system',
          title: 'Compact',
          summary: '',
          systemSubtype: 'compact',
          detail: { raw: record },
        });
        break;
    }
    return { changes };
  }

  /**
   * Every recognized block in content order. Block 0 keeps the record uuid as its id, block i >= 1 gets `<uuid>#<i>`;
   * tool_use blocks are always `tool:<id>`. Block i hangs off block i-1 (batch rules still apply to tool_use).
   */
  private applyAssistant(
    state: SessionState,
    record: TranscriptRecord,
    agentId: string | null,
    c: Extract<Classified, { kind: 'assistant' }>,
    changes: Change[],
  ): void {
    let prev: string | null = null;
    let first = true;
    // An agent's thread ends with an end_turn message, or (desktop app) with its hand-back call.
    if (agentId !== null && (c.meta.endTurn || c.blocks.some((b) => b.kind === 'tool_use' && b.name === HANDBACK_TOOL))) {
      this.finishAgent(state, agentId, { at: str(record.timestamp) ?? state.session.lastActivityAt, status: 'succeeded', viaHook: false }, changes);
    }
    for (const b of c.blocks) {
      const parentId = first ? this.resolveParent(state, record) : prev;
      first = false;
      const id = b.index === 0 ? record.uuid : `${record.uuid}#${b.index}`;
      switch (b.kind) {
        case 'thinking':
          prev = this.addNode(state, record, agentId, changes, {
            id,
            parentId,
            kind: 'thinking',
            title: 'Thinking',
            summary: summarize(b.text),
            durationMs: b.durationMs,
            meta: c.meta,
            detail: { text: b.text },
          });
          break;
        case 'text':
          prev = this.addNode(state, record, agentId, changes, {
            id,
            parentId,
            kind: 'text',
            title: 'Text',
            summary: summarize(b.text),
            meta: c.meta,
            detail: { text: b.text },
          });
          break;
        case 'tool_use':
          prev = this.applyToolUse(state, record, agentId, b, c.meta, parentId, changes);
          break;
      }
    }
  }

  private stateFor(sessionId: string, record: TranscriptRecord, projectId: string, changes: Change[]): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      const ts = str(record.timestamp) ?? EPOCH;
      const session: Session = {
        id: sessionId,
        projectId,
        cwd: str(record.cwd),
        title: this.bestTitle(sessionId),
        gitBranch: str(record.gitBranch),
        status: 'idle',
        sourceDeleted: false,
        startedAt: ts,
        lastActivityAt: ts,
      };
      state = {
        session,
        statusAt: ts,
        nodes: new Map(),
        toolInputs: new Map(),
        terminalFromContent: new Set(),
        durationFromHook: new Set(),
        lastNodeByUuid: new Map(),
        passthrough: new Map(),
        turnByAgent: new Map(),
        batches: new Map(),
        firstNodeByAgent: new Map(),
        dispatchByAgent: new Map(),
        asyncIds: new Set(),
        asyncDispatch: new Set(),
        launches: new Map(),
        agentOfLaunch: new Map(),
        nextLaunchAt: new Map(),
        sessionEnds: [],
        agentSignals: new Map(),
        dispatchSignals: new Map(),
        agentEnded: new Set(),
        notified: new Map(),
        agentMetas: new Map(),
        spawned: new Set(),
        firstPromptSeen: false,
      };
      this.sessions.set(sessionId, state);
      changes.push({ type: 'session_upserted', session });
      for (const meta of this.pendingAgentMetas.get(sessionId) ?? []) {
        state.agentMetas.set(meta.toolUseId, meta);
        state.dispatchByAgent.set(meta.agentId, `tool:${meta.toolUseId}`);
      }
      this.pendingAgentMetas.delete(sessionId);
    }
    return state;
  }

  /** Emits one session_upserted per actual change of the session object. */
  private updateSession(
    state: SessionState,
    record: TranscriptRecord,
    projectId: string,
    status: Session['status'] | null,
    isSubagent: boolean,
    changes: Change[],
  ): void {
    const s = state.session;
    const ts = str(record.timestamp);
    const cwd = str(record.cwd);
    const gitBranch = str(record.gitBranch);
    const next: Session = {
      ...s,
      lastActivityAt: ts !== null && ts > s.lastActivityAt ? ts : s.lastActivityAt,
      // A subagent may run in another worktree: only the main thread moves cwd/gitBranch.
      cwd: isSubagent ? s.cwd : (cwd ?? s.cwd),
      gitBranch: isSubagent ? s.gitBranch : (gitBranch ?? s.gitBranch),
      projectId: s.projectId === 'unknown' && projectId !== 'unknown' ? projectId : s.projectId,
    };
    this.commitSession(state, next, changes);
    if (status !== null) this.commitSession(state, { ...state.session, status }, changes);
    // The session ending changes what an open background dispatch amounts to (see applyEnd).
    if (state.session.status === 'ended' && s.status !== 'ended') {
      const at = ts ?? state.session.lastActivityAt;
      if (!state.sessionEnds.includes(at)) state.sessionEnds.push(at);
      for (const id of state.asyncIds) this.applyEnd(state, id, changes);
    }
  }

  private bestTitle(sessionId: string): string | null {
    const sources = this.titleSources.get(sessionId);
    if (!sources) return null;
    for (const source of TITLE_PRIORITY) if (sources[source] !== undefined) return sources[source]!;
    return null;
  }

  /** Records `value` as the source's current title (empty values are ignored) and applies the best title to the session. */
  private setTitle(sessionId: string, source: TitleSource, value: string | null, changes: Change[]): void {
    if (value === null || value.trim() === '') return;
    const sources = this.titleSources.get(sessionId) ?? {};
    sources[source] = value;
    this.titleSources.set(sessionId, sources);
    const state = this.sessions.get(sessionId);
    if (state) this.commitSession(state, { ...state.session, title: this.bestTitle(sessionId) }, changes);
  }

  private commitSession(state: SessionState, next: Session, changes: Change[]): void {
    const s = state.session;
    const same =
      s.lastActivityAt === next.lastActivityAt &&
      s.cwd === next.cwd &&
      s.gitBranch === next.gitBranch &&
      s.projectId === next.projectId &&
      s.title === next.title &&
      s.status === next.status;
    if (same) return;
    state.session = next;
    changes.push({ type: 'session_upserted', session: next });
  }

  /** First node-producing ancestor along parentUuid, skipping records that produced no node. */
  private resolveParent(state: SessionState, record: TranscriptRecord): string | null {
    const seen = new Set<string>();
    let cur = str(record.parentUuid);
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      const node = state.lastNodeByUuid.get(cur);
      if (node !== undefined) return node;
      if (!state.passthrough.has(cur)) return null;
      cur = state.passthrough.get(cur) ?? null;
    }
    return null;
  }

  private baseNode(
    state: SessionState,
    record: TranscriptRecord,
    agentId: string | null,
    id: string,
    parentId: string | null,
  ): GraphNode {
    return {
      id,
      sessionId: state.session.id,
      turnId: agentId === null ? (state.turnByAgent.get('') ?? null) : null,
      agentId,
      parentId,
      kind: 'unknown',
      status: null,
      timestamp: str(record.timestamp) ?? state.session.lastActivityAt,
      confirmed: true,
      title: '',
      summary: '',
      toolName: null,
      toolUseId: null,
      messageId: null,
      durationMs: null,
      usage: null,
      systemSubtype: null,
      childAgentId: null,
      endedAt: null,
    };
  }

  private addNode(
    state: SessionState,
    record: TranscriptRecord,
    agentId: string | null,
    changes: Change[],
    spec: {
      kind: GraphNode['kind'];
      title: string;
      summary: string;
      detail: Partial<NodeDetail>;
      durationMs?: number | null;
      meta?: MessageMeta;
      systemSubtype?: string;
      /** Defaults to the record uuid. */
      id?: string;
      /** Defaults to the record's resolved parentUuid chain. */
      parentId?: string | null;
    },
  ): string {
    const id = spec.id ?? record.uuid;
    const parentId = spec.parentId !== undefined ? spec.parentId : this.resolveParent(state, record);
    const node: GraphNode = {
      ...this.baseNode(state, record, agentId, id, parentId),
      kind: spec.kind,
      title: spec.title,
      summary: spec.summary,
      durationMs: spec.durationMs ?? null,
      messageId: spec.meta?.messageId ?? null,
      usage: spec.meta?.usage ?? null,
      systemSubtype: spec.systemSubtype ?? null,
    };
    return this.emitNode(state, record.uuid, node, spec.detail, agentId, false, changes);
  }

  private emitNode(
    state: SessionState,
    uuid: string,
    created: GraphNode,
    detail: Partial<NodeDetail>,
    agentId: string | null,
    isTool: boolean,
    changes: Change[],
  ): string {
    const placed = this.placeInBatch(state, agentId, created, isTool);
    const node = placed.node;
    state.nodes.set(node.id, node);
    state.lastNodeByUuid.set(uuid, node.id);
    changes.push({ type: 'node_added', node, detail });
    this.emitPlacementEdges(state, placed, true, changes);
    this.registerFirstNode(state, agentId, node.id, changes);
    return node.id;
  }

  /**
   * Batch bookkeeping shared by new and confirmed nodes: joins/extends/closes the agent's open batch and
   * returns the node with its final parent plus the extra edges the placement implies.
   */
  private placeInBatch(state: SessionState, agentId: string | null, created: GraphNode, isTool: boolean): Placement {
    const key = agentId ?? '';
    const batch = state.batches.get(key);
    let node = created;
    let edgeKind: GraphEdge['kind'] = 'sequence';
    let joinFrom: string[] = [];
    let forkFirst: string | null = null;
    if (batch && isTool && node.messageId !== null && node.messageId === batch.messageId) {
      // Parallel sibling: fork from the batch's shared parent.
      node = { ...node, parentId: batch.parentId };
      edgeKind = 'fork';
      if (batch.members.length === 1) forkFirst = batch.members[0] ?? null;
      batch.members.push(node.id);
    } else if (batch) {
      state.batches.delete(key);
      if (batch.members.length >= 2) {
        // Join: the first node after a parallel batch hangs off the last member; every member links to it.
        node = { ...node, parentId: batch.members[batch.members.length - 1] ?? null };
        joinFrom = batch.members.slice(0, -1);
      }
    }
    if (isTool && node.messageId !== null && !state.batches.has(key)) {
      state.batches.set(key, { messageId: node.messageId, parentId: node.parentId, members: [node.id] });
    }
    return { node, edgeKind, forkFirst, joinFrom };
  }

  /** Emits the edges of a placement; `withMain` is false when the node's incoming edge already exists. */
  private emitPlacementEdges(state: SessionState, p: Placement, withMain: boolean, changes: Change[]): void {
    const node = p.node;
    if (withMain) this.emitSequenceEdge(state, node, changes, p.edgeKind);
    if (p.forkFirst !== null && node.parentId !== null) {
      changes.push({
        type: 'edge_added',
        edge: { id: `${node.parentId}->${p.forkFirst}:fork`, sessionId: state.session.id, from: node.parentId, to: p.forkFirst, kind: 'fork' },
      });
    }
    for (const from of p.joinFrom) {
      changes.push({
        type: 'edge_added',
        edge: { id: `${from}->${node.id}`, sessionId: state.session.id, from, to: node.id, kind: 'sequence' },
      });
    }
  }

  private registerFirstNode(state: SessionState, agentId: string | null, nodeId: string, changes: Change[]): void {
    if (agentId === null || state.firstNodeByAgent.has(agentId)) return;
    state.firstNodeByAgent.set(agentId, nodeId);
    this.trySpawn(state, agentId, changes);
  }

  private emitSequenceEdge(state: SessionState, node: GraphNode, changes: Change[], kind: GraphEdge['kind'] = 'sequence'): void {
    if (node.parentId === null) return;
    changes.push({
      type: 'edge_added',
      edge: { id: `${node.parentId}->${node.id}`, sessionId: state.session.id, from: node.parentId, to: node.id, kind },
    });
  }

  /** Returns the tool node id. */
  private applyToolUse(
    state: SessionState,
    record: TranscriptRecord,
    agentId: string | null,
    c: Extract<AssistantBlock, { kind: 'tool_use' }>,
    meta: MessageMeta,
    parentId: string | null,
    changes: Change[],
  ): string {
    const id = `tool:${c.toolUseId}`;
    const summary = summarize(c.input);
    state.lastNodeByUuid.set(record.uuid, id);
    const existing = state.nodes.get(id);
    // Only non-terminal nodes keep their input in memory (PermissionRequest matching).
    if (!existing || existing.status === null || !TERMINAL_STATUSES.includes(existing.status)) state.toolInputs.set(id, c.input);
    if (existing) {
      // A hook created this node first; the transcript record now confirms it. status is left alone, but the record
      // carries the authoritative start time and the message usage.
      const base = this.baseNode(state, record, agentId, id, parentId);
      const placed = this.placeInBatch(state, agentId, { ...base, messageId: meta.messageId }, true);
      const pending = state.agentMetas.get(c.toolUseId);
      const patch: Partial<GraphNode> = {
        confirmed: true,
        parentId: placed.node.parentId,
        turnId: base.turnId,
        messageId: meta.messageId,
        usage: meta.usage,
      };
      this.earlierStart(state, existing, str(record.timestamp), patch);
      // An agent meta's description already owns the summary of a dispatch node.
      if (!pending) patch.summary = summary;
      state.nodes.set(id, { ...existing, ...patch });
      changes.push({ type: 'node_updated', sessionId: state.session.id, id, patch, detail: { input: c.input } });
      // The incoming edge is only new when the parent actually changed.
      this.emitPlacementEdges(state, placed, placed.node.parentId !== null && placed.node.parentId !== existing.parentId, changes);
      this.registerFirstNode(state, agentId, id, changes);
      if (pending && existing.childAgentId !== pending.agentId) this.applyAgentMeta(state, pending, changes);
      if (patch.timestamp !== undefined) this.launchMoved(state, id, changes);
      return id;
    }
    const node: GraphNode = {
      ...this.baseNode(state, record, agentId, id, parentId),
      kind: c.name === 'Agent' || c.name === 'Task' ? 'subagent' : 'tool',
      status: 'running',
      title: c.name,
      summary,
      toolName: c.name,
      toolUseId: c.toolUseId,
      messageId: meta.messageId,
      usage: meta.usage,
    };
    this.emitNode(state, record.uuid, node, { input: c.input }, agentId, true, changes);
    const agentMeta = state.agentMetas.get(c.toolUseId);
    if (agentMeta) this.applyAgentMeta(state, agentMeta, changes);
    return id;
  }

  /**
   * The immediate answer to a background Agent launch: from here on the dispatch node follows the agent's end signals
   * (applyEnd) — running while there is none, whatever a hook made of the launch answer before.
   */
  private applyAsyncLaunch(state: SessionState, node: GraphNode, agentId: string | null, output: unknown, changes: Change[]): void {
    const id = node.id;
    const toolUseId = id.slice('tool:'.length);
    state.toolInputs.delete(id);
    state.asyncIds.add(id);
    changes.push({ type: 'node_updated', sessionId: state.session.id, id, patch: {}, detail: { output } });
    const { direct } = this.signalsOf(state, id);
    for (const end of state.notified.get(toolUseId) ?? []) direct.push(end);
    state.notified.delete(toolUseId);
    const known = agentId ?? state.agentMetas.get(toolUseId)?.agentId ?? null;
    if (known !== null) {
      if (!state.dispatchByAgent.has(known)) state.dispatchByAgent.set(known, id);
      this.addLaunch(state, known, id);
      this.routeAgentSignals(state, known, changes);
    } else {
      this.applyEnd(state, id, changes);
    }
  }

  private applyToolResults(
    state: SessionState,
    c: Extract<Classified, { kind: 'tool_results' }>,
    at: string,
    changes: Change[],
  ): void {
    for (const r of c.results) {
      const id = `tool:${r.toolUseId}`;
      const node = state.nodes.get(id);
      if (!node) continue;
      if (c.asyncAgent !== null && node.kind === 'subagent' && !r.isError) {
        this.applyAsyncLaunch(state, node, c.asyncAgent.agentId, r.content, changes);
        continue;
      }
      const status: NodeStatus = r.isError ? 'failed' : 'succeeded';
      const terminal = node.status !== null && TERMINAL_STATUSES.includes(node.status);
      // Final: denied (never overridden) and a status that already came from a tool_result. A hook-derived
      // succeeded/failed is corrected by the content plane.
      const final = terminal && (node.status === 'denied' || state.terminalFromContent.has(id));
      const patch: Partial<GraphNode> = !final && node.status !== status ? { status } : {};
      // endedAt marks the first terminal event only; a later correction keeps it (and the duration derived from it).
      if (!terminal) {
        patch.endedAt = at;
        if (node.durationMs === null) {
          const derived = elapsedMs(node.timestamp, at);
          if (derived !== null) patch.durationMs = derived;
        }
      }
      if (!final) state.terminalFromContent.add(id);
      state.toolInputs.delete(id);
      if (Object.keys(patch).length > 0) state.nodes.set(id, { ...node, ...patch });
      changes.push({ type: 'node_updated', sessionId: state.session.id, id, patch, detail: { output: r.content } });
    }
  }
}
