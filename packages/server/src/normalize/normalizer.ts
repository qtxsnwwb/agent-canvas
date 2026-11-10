import {
  TERMINAL_STATUSES,
  type Change,
  type GraphNode,
  type NodeDetail,
  type Session,
} from '@claude-canvas/shared';
import type { RawEvent } from '../store/store.js';
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
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export class Normalizer {
  private readonly sessions = new Map<string, SessionState>();

  apply(event: RawEvent, projectId: string): NormalizeResult {
    try {
      if (event.source === 'transcript') return this.applyTranscript(event, projectId);
      return { changes: [] }; // hook and meta events arrive in later tasks
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
    if (!KNOWN_TYPES.has(type)) return { changes: [], unknownRecordType: type };
    const uuid = str(parsed.uuid);
    if (uuid === null) return type === 'attachment' ? { changes: [] } : { changes: [], unknownRecordType: `${type}:malformed` };
    const record = { ...parsed, type, uuid } as TranscriptRecord;

    const changes: Change[] = [];
    const state = this.stateFor(event.sessionId, record, projectId, changes);
    const classified = classifyRecord(record);
    const agentId = event.agentId;

    this.updateSession(state, record, projectId, impliedStatus(classified, agentId !== null), changes);
    if (classified.kind === 'prompt') state.turnByAgent.set(agentId ?? '', str(record.promptId) ?? uuid);

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
        title: null,
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
      };
      this.sessions.set(sessionId, state);
      changes.push({ type: 'session_upserted', session });
    }
    return state;
  }

  /** Emits one session_upserted per actual change of the session object. */
  private updateSession(
    state: SessionState,
    record: TranscriptRecord,
    projectId: string,
    status: Session['status'] | null,
    changes: Change[],
  ): void {
    const s = state.session;
    const ts = str(record.timestamp);
    const cwd = str(record.cwd);
    const gitBranch = str(record.gitBranch);
    const next: Session = {
      ...s,
      lastActivityAt: ts ?? s.lastActivityAt,
      cwd: cwd ?? s.cwd,
      gitBranch: gitBranch ?? s.gitBranch,
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
      turnId: state.turnByAgent.get(agentId ?? '') ?? null,
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
    this.emitNode(state, record.uuid, node, spec.detail, changes);
  }

  private emitNode(state: SessionState, uuid: string, node: GraphNode, detail: Partial<NodeDetail>, changes: Change[]): void {
    state.nodes.set(node.id, node);
    state.lastNodeByUuid.set(uuid, node.id);
    changes.push({ type: 'node_added', node, detail });
    this.emitSequenceEdge(state, node, changes);
  }

  private emitSequenceEdge(state: SessionState, node: GraphNode, changes: Change[]): void {
    if (node.parentId === null) return;
    changes.push({
      type: 'edge_added',
      edge: {
        id: `${node.parentId}->${node.id}`,
        sessionId: state.session.id,
        from: node.parentId,
        to: node.id,
        kind: 'sequence',
      },
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
      const patch: Partial<GraphNode> = {
        confirmed: true,
        summary,
        parentId: base.parentId,
        turnId: base.turnId,
        messageId: c.meta.messageId,
      };
      const updated = { ...existing, ...patch };
      state.nodes.set(id, updated);
      changes.push({ type: 'node_updated', sessionId: state.session.id, id, patch, detail: { input: c.input } });
      this.emitSequenceEdge(state, updated, changes);
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
    this.emitNode(state, record.uuid, node, { input: c.input }, changes);
  }

  private applyToolResults(
    state: SessionState,
    c: Extract<Classified, { kind: 'tool_results' }>,
    changes: Change[],
  ): void {
    for (const r of c.results) {
      const id = `tool:${r.toolUseId}`;
      const node = state.nodes.get(id);
      if (!node || (node.status !== null && TERMINAL_STATUSES.includes(node.status))) continue;
      const patch: Partial<GraphNode> = { status: r.isError ? 'failed' : 'succeeded' };
      state.nodes.set(id, { ...node, ...patch });
      changes.push({ type: 'node_updated', sessionId: state.session.id, id, patch, detail: { output: r.content } });
    }
  }
}
