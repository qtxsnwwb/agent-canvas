import { isDeepStrictEqual } from 'node:util';
import {
  TERMINAL_STATUSES,
  type Change,
  type GraphEdge,
  type GraphNode,
  type NodeDetail,
  type Session,
} from '@claude-canvas/shared';
import type { RawEvent } from '../store/store.js';
import { parseHook, type HookDescription, type HookNodeEffect } from './hooks.js';
import { summarize } from './summary.js';
import { classifyRecord, impliedStatus, type Classified, type MessageMeta, type TranscriptRecord } from './transcript.js';

export interface NormalizeResult {
  changes: Change[];
  unknownRecordType?: string;
}

const EPOCH = '1970-01-01T00:00:00.000Z';
const KNOWN_TYPES = new Set(['user', 'assistant', 'system', 'attachment']);

/** In-memory state for one session; later tasks extend this with batch/subagent bookkeeping. */
interface SessionState {
  session: Session;
  nodes: Map<string, GraphNode>;
  /** tool node id -> original tool input (permission matching needs it). */
  toolInputs: Map<string, unknown>;
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
}

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

export class Normalizer {
  private readonly sessions = new Map<string, SessionState>();
  /** Meta that arrived before its session existed. */
  private readonly pendingTitles = new Map<string, string>();
  private readonly pendingAgentMetas = new Map<string, AgentMeta[]>();

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
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
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
      const title = str(parsed.customTitle);
      if (title === null) return { changes };
      if (state) this.commitSession(state, { ...state.session, title }, changes);
      else this.pendingTitles.set(event.sessionId, title);
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
  }

  /** Writes the meta onto the dispatch node (if it exists yet) and tries the spawn edge. */
  private applyAgentMeta(state: SessionState, meta: AgentMeta, changes: Change[]): void {
    const id = `tool:${meta.toolUseId}`;
    const node = state.nodes.get(id);
    if (!node) return;
    const patch: Partial<GraphNode> = { agentId: meta.agentId, title: meta.agentType, summary: summarize(meta.description) };
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
    if (state.nodes.has(id)) return;
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
    };
    state.nodes.set(id, node);
    state.toolInputs.set(id, spec.input);
    changes.push({ type: 'node_added', node, detail: { input: spec.input } });
    const meta = state.agentMetas.get(spec.toolUseId);
    if (meta) this.applyAgentMeta(state, meta, changes);
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
    this.updateSession(state, { type: 'hook', uuid: '', timestamp: at }, projectId, status, false, changes);
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
        this.settleTool(state, effect, changes);
        break;
      case 'subagent_stop': {
        const dispatch = state.dispatchByAgent.get(effect.agentId);
        if (dispatch !== undefined) this.settleTool(state, { kind: 'settle', toolUseId: dispatch.slice('tool:'.length), status: 'succeeded', durationMs: null }, changes);
        break;
      }
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

  /** Moves a tool node to a terminal status unless it is already terminal (then only a missing duration is filled in). */
  private settleTool(state: SessionState, effect: Extract<HookNodeEffect, { kind: 'settle' }>, changes: Change[]): void {
    const id = `tool:${effect.toolUseId}`;
    const node = state.nodes.get(id);
    if (!node) return;
    const terminal = node.status !== null && TERMINAL_STATUSES.includes(node.status);
    const patch: Partial<GraphNode> = {};
    if (!terminal) patch.status = effect.status;
    if (node.durationMs === null && effect.durationMs !== null) patch.durationMs = effect.durationMs;
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

    this.updateSession(state, record, projectId, impliedStatus(classified, agentId !== null), agentId !== null, changes);
    if (classified.kind === 'prompt' && agentId === null) state.turnByAgent.set('', str(record.promptId) ?? uuid);

    const parentUuid = str(record.parentUuid);
    switch (classified.kind) {
      case 'silent':
        state.passthrough.set(uuid, parentUuid);
        break;
      case 'tool_results':
        state.passthrough.set(uuid, parentUuid);
        this.applyToolResults(state, classified, changes);
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
        this.addNode(state, record, agentId, changes, {
          kind: 'prompt',
          title: 'Prompt',
          summary: summarize(classified.text),
          detail: { text: classified.text },
        });
        break;
      case 'thinking':
        this.addNode(state, record, agentId, changes, {
          kind: 'thinking',
          title: 'Thinking',
          summary: summarize(classified.text),
          durationMs: classified.durationMs,
          meta: classified.meta,
          detail: { text: classified.text },
        });
        break;
      case 'text':
        this.addNode(state, record, agentId, changes, {
          kind: 'text',
          title: 'Text',
          summary: summarize(classified.text),
          meta: classified.meta,
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
      case 'tool_use':
        this.applyToolUse(state, record, agentId, classified, changes);
        break;
    }
    return { changes };
  }

  private stateFor(sessionId: string, record: TranscriptRecord, projectId: string, changes: Change[]): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      const ts = str(record.timestamp) ?? EPOCH;
      const session: Session = {
        id: sessionId,
        projectId,
        cwd: str(record.cwd),
        title: this.pendingTitles.get(sessionId) ?? null,
        gitBranch: str(record.gitBranch),
        status: 'idle',
        sourceDeleted: false,
        startedAt: ts,
        lastActivityAt: ts,
      };
      state = {
        session,
        nodes: new Map(),
        toolInputs: new Map(),
        lastNodeByUuid: new Map(),
        passthrough: new Map(),
        turnByAgent: new Map(),
        batches: new Map(),
        firstNodeByAgent: new Map(),
        dispatchByAgent: new Map(),
        agentMetas: new Map(),
        spawned: new Set(),
      };
      this.sessions.set(sessionId, state);
      this.pendingTitles.delete(sessionId);
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
  ): GraphNode {
    return {
      id,
      sessionId: state.session.id,
      turnId: agentId === null ? (state.turnByAgent.get('') ?? null) : null,
      agentId,
      parentId: this.resolveParent(state, record),
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
    },
  ): void {
    const node: GraphNode = {
      ...this.baseNode(state, record, agentId, record.uuid),
      kind: spec.kind,
      title: spec.title,
      summary: spec.summary,
      durationMs: spec.durationMs ?? null,
      messageId: spec.meta?.messageId ?? null,
      usage: spec.meta?.usage ?? null,
      systemSubtype: spec.systemSubtype ?? null,
    };
    this.emitNode(state, record.uuid, node, spec.detail, agentId, false, changes);
  }

  private emitNode(
    state: SessionState,
    uuid: string,
    created: GraphNode,
    detail: Partial<NodeDetail>,
    agentId: string | null,
    isTool: boolean,
    changes: Change[],
  ): void {
    const placed = this.placeInBatch(state, agentId, created, isTool);
    const node = placed.node;
    state.nodes.set(node.id, node);
    state.lastNodeByUuid.set(uuid, node.id);
    changes.push({ type: 'node_added', node, detail });
    this.emitPlacementEdges(state, placed, true, changes);
    this.registerFirstNode(state, agentId, node.id, changes);
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

  private applyToolUse(
    state: SessionState,
    record: TranscriptRecord,
    agentId: string | null,
    c: Extract<Classified, { kind: 'tool_use' }>,
    changes: Change[],
  ): void {
    const id = `tool:${c.toolUseId}`;
    const summary = summarize(c.input);
    state.toolInputs.set(id, c.input);
    state.lastNodeByUuid.set(record.uuid, id);
    const existing = state.nodes.get(id);
    if (existing) {
      // A hook created this node first; the transcript record now confirms it. status is left alone.
      const base = this.baseNode(state, record, agentId, id);
      const placed = this.placeInBatch(state, agentId, { ...base, messageId: c.meta.messageId }, true);
      const pending = state.agentMetas.get(c.toolUseId);
      const patch: Partial<GraphNode> = {
        confirmed: true,
        parentId: placed.node.parentId,
        turnId: base.turnId,
        messageId: c.meta.messageId,
      };
      // An agent meta's description already owns the summary of a dispatch node.
      if (!pending) patch.summary = summary;
      state.nodes.set(id, { ...existing, ...patch });
      changes.push({ type: 'node_updated', sessionId: state.session.id, id, patch, detail: { input: c.input } });
      // The incoming edge is only new when the parent actually changed.
      this.emitPlacementEdges(state, placed, placed.node.parentId !== null && placed.node.parentId !== existing.parentId, changes);
      this.registerFirstNode(state, agentId, id, changes);
      if (pending && existing.agentId !== pending.agentId) this.applyAgentMeta(state, pending, changes);
      return;
    }
    const node: GraphNode = {
      ...this.baseNode(state, record, agentId, id),
      kind: c.name === 'Agent' || c.name === 'Task' ? 'subagent' : 'tool',
      status: 'running',
      title: c.name,
      summary,
      toolName: c.name,
      toolUseId: c.toolUseId,
      messageId: c.meta.messageId,
      usage: c.meta.usage,
    };
    this.emitNode(state, record.uuid, node, { input: c.input }, agentId, true, changes);
    const meta = state.agentMetas.get(c.toolUseId);
    if (meta) this.applyAgentMeta(state, meta, changes);
  }

  private applyToolResults(
    state: SessionState,
    c: Extract<Classified, { kind: 'tool_results' }>,
    changes: Change[],
  ): void {
    for (const r of c.results) {
      const id = `tool:${r.toolUseId}`;
      const node = state.nodes.get(id);
      if (!node) continue;
      if (node.status !== null && TERMINAL_STATUSES.includes(node.status)) {
        // Already terminal (e.g. a hook got there first): keep status, still record the output.
        changes.push({ type: 'node_updated', sessionId: state.session.id, id, patch: {}, detail: { output: r.content } });
        continue;
      }
      const patch: Partial<GraphNode> = { status: r.isError ? 'failed' : 'succeeded' };
      state.nodes.set(id, { ...node, ...patch });
      changes.push({ type: 'node_updated', sessionId: state.session.id, id, patch, detail: { output: r.content } });
    }
  }
}
