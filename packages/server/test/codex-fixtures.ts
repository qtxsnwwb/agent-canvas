/**
 * Synthetic Codex rollout records for normalizer tests, shaped like the real ones (`{ timestamp, ordinal, type,
 * payload }`, turn ids where Codex puts them) with invented content. A CodexThread is one rollout file: each method
 * appends one line and returns the raw event the Codex file source would produce for it.
 */
import { applyChanges, emptyGraph, type Change, type Graph, type Session } from '@agent-canvas/shared';
import type { AgentNormalizer } from '../src/normalize/types.js';
import type { RawEvent } from '../src/store/store.js';

const BASE_TIME = Date.parse('2026-11-11T03:00:00.000Z');
let tick = 0;
/** Strictly increasing record times across every thread (one second apart). */
export const nextTime = (): string => new Date(BASE_TIME + ++tick * 1000).toISOString();
export const timeMs = (iso: string): number => Date.parse(iso);

export interface ThreadSpec {
  /** Thread id. */
  id: string;
  /** Root thread id; defaults to `id` (a root thread). */
  sessionId?: string;
  /** Parent thread id (subagent threads only). */
  parent?: string;
  cwd?: string;
  nickname?: string;
  agentPath?: string;
  /** Put nickname / path / parent only under `source.subagent.thread_spawn` (not at the top level of the meta). */
  spawnSourceOnly?: boolean;
  /** `subagent_history_start_ordinal`: the records before it are the parent's history copied into this file. */
  historyStart?: number;
  projectId?: string;
}

export class CodexThread {
  readonly id: string;
  readonly sessionId: string;
  readonly agentId: string | null;
  readonly file: string;
  readonly projectId: string;
  /** Every line of the file so far. */
  readonly lines: string[] = [];
  /** Turn id put on the records (set by `started`). */
  turn: string | null = null;
  private ordinal = 0;
  private offset = 0;

  constructor(private readonly spec: ThreadSpec) {
    this.id = spec.id;
    this.sessionId = spec.sessionId ?? spec.id;
    this.agentId = this.sessionId === spec.id ? null : spec.id;
    this.file = `codex:2026/11/11/rollout-2026-11-11T03-00-00-${spec.id}.jsonl`;
    this.projectId = spec.projectId ?? 'p1';
  }

  /** One line of this file as a raw event (`over` replaces top-level fields of the record). */
  record(type: string, payload: Record<string, unknown>, over: Record<string, unknown> = {}): RawEvent {
    const timestamp = typeof over.timestamp === 'string' ? over.timestamp : nextTime();
    const line = JSON.stringify({ timestamp, ordinal: this.ordinal++, type, payload, ...over });
    return this.line(line, type);
  }

  /** A raw line as is (garbage, truncated JSON, …). */
  line(text: string, recordType = 'unknown'): RawEvent {
    this.lines.push(text);
    const offset = this.offset;
    this.offset += Buffer.byteLength(text) + 1;
    return {
      source: 'transcript',
      origin: 'codex',
      file: this.file,
      offset,
      line: text,
      recordType,
      sessionId: this.sessionId,
      agentId: this.agentId,
      projectId: this.projectId,
    };
  }

  private turnMeta(): Record<string, unknown> {
    return { internal_chat_message_metadata_passthrough: { turn_id: this.turn, create_time: 1793071175 } };
  }

  meta(over: Record<string, unknown> = {}): RawEvent {
    const s = this.spec;
    const payload: Record<string, unknown> = {
      session_id: this.sessionId,
      id: this.id,
      timestamp: new Date(BASE_TIME).toISOString(),
      cwd: s.cwd ?? '/work/app',
      originator: 'Codex Desktop',
      cli_version: '0.142.5',
      source: 'vscode',
      thread_source: 'user',
      model_provider: 'openai',
      history_mode: 'paginated',
    };
    if (s.parent !== undefined) {
      payload.thread_source = 'subagent';
      payload.source = {
        subagent: {
          thread_spawn: { parent_thread_id: s.parent, depth: 1, agent_path: s.agentPath ?? null, agent_nickname: s.nickname ?? null, agent_role: null },
        },
      };
      if (!s.spawnSourceOnly) {
        payload.parent_thread_id = s.parent;
        if (s.nickname !== undefined) payload.agent_nickname = s.nickname;
        if (s.agentPath !== undefined) payload.agent_path = s.agentPath;
      }
    }
    if (s.historyStart !== undefined) payload.subagent_history_start_ordinal = s.historyStart;
    return this.record('session_meta', { ...payload, ...over });
  }

  started(turnId: string): RawEvent {
    this.turn = turnId;
    return this.record('event_msg', {
      type: 'task_started',
      turn_id: turnId,
      root_turn_id: turnId,
      started_at: 1793071173,
      model_context_window: 258400,
      collaboration_mode_kind: 'default',
    });
  }

  complete(error: string | null = null, turnId: string | null = this.turn): RawEvent {
    const payload: Record<string, unknown> = {
      type: 'task_complete',
      turn_id: turnId,
      root_turn_id: turnId,
      last_agent_message: 'done',
      started_at: 1793071173,
      completed_at: 1793071240,
      duration_ms: 66974,
    };
    if (error !== null) payload.error = { message: error, codex_error_info: 'other' };
    return this.record('event_msg', payload);
  }

  aborted(reason = 'interrupted', turnId: string | null = this.turn): RawEvent {
    return this.record('event_msg', { type: 'turn_aborted', turn_id: turnId, root_turn_id: turnId, reason, started_at: 1793071173 });
  }

  /** The prompt the user actually typed (`item_completed/UserMessage`). */
  user(id: string, text: string): RawEvent {
    return this.item({ type: 'UserMessage', id, client_id: `client-${id}`, content: [{ type: 'text', text, text_elements: [] }] });
  }

  /** Context injection: a `response_item/message` with role user or developer. */
  context(role: 'user' | 'developer', text: string, id = `msg_ctx_${this.ordinal}`): RawEvent {
    return this.record('response_item', { type: 'message', id, role, content: [{ type: 'input_text', text }], ...this.turnMeta() });
  }

  /** Assistant text, preceded by its `item_completed/AgentMessage` duplicate (as Codex writes it). */
  assistant(id: string, text: string, phase: 'commentary' | 'final_answer' = 'final_answer'): RawEvent[] {
    return [
      this.item({ type: 'AgentMessage', id, content: [{ type: 'Text', text }], phase }),
      this.record('response_item', {
        type: 'message',
        status: 'completed',
        id,
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
        phase,
        ...this.turnMeta(),
      }),
    ];
  }

  /** `item_completed/Reasoning` (with the timing) then `response_item/reasoning`, as Codex writes them. */
  reasoning(id: string, summary: string[] = [], durationMs = 1500): RawEvent[] {
    const end = 1793071190000 + this.ordinal * 1000;
    return [
      this.item({ type: 'Reasoning', id, summary_text: [], raw_content: [] }, { started_at_ms: end - durationMs, completed_at_ms: end }),
      this.reasoningRecord(id, summary),
    ];
  }

  reasoningRecord(id: string, summary: string[] = []): RawEvent {
    return this.record('response_item', {
      type: 'reasoning',
      id,
      summary: summary.map((text) => ({ type: 'summary_text', text })),
      encrypted_content: 'gAAAAB-opaque',
      ...this.turnMeta(),
    });
  }

  /** `custom_tool_call` named exec. */
  exec(callId: string, input: string): RawEvent {
    return this.record('response_item', { type: 'custom_tool_call', id: `ctc_${callId}`, status: 'completed', call_id: callId, name: 'exec', input, ...this.turnMeta() });
  }

  /** `function_call` with JSON arguments. */
  call(callId: string, name: string, args: Record<string, unknown>, namespace?: string): RawEvent {
    const payload: Record<string, unknown> = {
      type: 'function_call',
      status: 'completed',
      id: `fc_${callId}`,
      name,
      arguments: JSON.stringify(args),
      call_id: callId,
      ...this.turnMeta(),
    };
    if (namespace !== undefined) payload.namespace = namespace;
    return this.record('response_item', payload);
  }

  spawn(callId: string, taskName: string, message = 'do the sub task'): RawEvent {
    return this.call(callId, 'spawn_agent', { task_name: taskName, fork_turns: 'none', message }, 'collaboration');
  }

  output(callId: string, output: unknown = [{ type: 'input_text', text: 'Script completed' }], kind: 'custom' | 'function' = 'custom'): RawEvent {
    return this.record('response_item', {
      type: kind === 'custom' ? 'custom_tool_call_output' : 'function_call_output',
      id: `out_${callId}`,
      call_id: callId,
      output,
      ...this.turnMeta(),
    });
  }

  command(id: string, cmd: string, opts: { status?: string; exitCode?: number; durationMs?: number; startedAtMs?: number | null } = {}): RawEvent {
    const ms = opts.durationMs ?? 250;
    return this.item(
      {
      type: 'CommandExecution',
      id,
      process_id: 4242,
      command: ['bash', '-lc', cmd],
      cwd: '/work/app',
      parsed_cmd: [{ type: 'unknown', cmd }],
      source: 'unified_exec_startup',
      status: opts.status ?? 'completed',
      aggregated_output: 'ok',
      exit_code: opts.exitCode ?? 0,
      duration: { secs: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 },
      },
      opts.startedAtMs === undefined ? {} : { started_at_ms: opts.startedAtMs },
    );
  }

  mcp(id: string, server: string, tool: string, status = 'completed'): RawEvent {
    return this.item({
      type: 'McpToolCall',
      id,
      server,
      tool,
      arguments: {},
      status,
      result: { content: [], isError: status === 'failed' },
      duration: { secs: 0, nanos: 120_000_000 },
    });
  }

  activity(callId: string, agentThreadId: string, agentPath: string, kind = 'started'): RawEvent {
    return this.item({ type: 'SubAgentActivity', model: 'gpt-x', reasoning_effort: 'high', id: callId, kind, agent_thread_id: agentThreadId, agent_path: agentPath });
  }

  /**
   * Any `event_msg/item_completed`. By default the item completed at the record's own time and started 250 ms before it
   * (so it falls in the window of the call open just before it); `started_at_ms: null` leaves the field out.
   */
  item(item: Record<string, unknown>, timing: { started_at_ms?: number | null; completed_at_ms?: number } = {}): RawEvent {
    const at = nextTime();
    const atMs = Date.parse(at);
    const payload: Record<string, unknown> = { type: 'item_completed', thread_id: this.id, turn_id: this.turn, item };
    if (timing.started_at_ms !== null) payload.started_at_ms = timing.started_at_ms ?? atMs - 250;
    payload.completed_at_ms = timing.completed_at_ms ?? atMs;
    return this.record('event_msg', payload, { timestamp: at });
  }

  usage(): RawEvent {
    return this.record('token_usage_record', { response_id: `resp_${this.ordinal}`, thread_id: this.id, turn_id: this.turn, usage: { input_tokens: 10 } });
  }

  compaction(): RawEvent {
    return this.record('response_item', { type: 'compaction', id: `cmp_${this.ordinal}`, encrypted_content: 'opaque', ...this.turnMeta() });
  }

  compacted(message = 'summary of the earlier conversation'): RawEvent {
    return this.record('compacted', { message, window_id: 'w2', window_number: 2, replacement_history: [] });
  }
}

/** The per-session title the Codex source emits from `session_index.jsonl`. */
export function titleMeta(sessionId: string, threadName: string, projectId = 'p1'): RawEvent {
  return {
    source: 'meta',
    origin: 'codex',
    file: `codex:index/${sessionId}`,
    sessionId,
    agentId: null,
    payload: JSON.stringify({ id: sessionId, thread_name: threadName, updated_at: '2026-11-11T03:10:00.000000Z' }),
    projectId,
  };
}

export interface RunResult {
  changes: Change[];
  graph: Graph;
  unknown: string[];
  /** The last session object emitted, per session id. */
  sessions: Map<string, Session>;
}

/** Applies the events in order (each with its own projectId), folding the changes into a graph. */
export function run(n: AgentNormalizer, events: RawEvent[]): RunResult {
  const changes: Change[] = [];
  const unknown: string[] = [];
  const sessions = new Map<string, Session>();
  for (const ev of events) {
    const projectId = (ev.source === 'transcript' || ev.source === 'meta') && ev.projectId != null ? ev.projectId : 'unknown';
    const r = n.apply(ev, projectId);
    if (r.unknownRecordType !== undefined) unknown.push(r.unknownRecordType);
    changes.push(...r.changes);
    for (const c of r.changes) if (c.type === 'session_upserted') sessions.set(c.session.id, c.session);
  }
  return { changes, graph: applyChanges(emptyGraph(), changes), unknown, sessions };
}

/** A deterministic pseudo-random interleaving of several threads' events; each thread keeps its own order. */
export function interleave(threads: RawEvent[][], seed: number): RawEvent[] {
  let s = seed >>> 0 || 1;
  const rnd = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
  const queues = threads.map((t) => [...t]);
  const out: RawEvent[] = [];
  for (;;) {
    const live = queues.filter((q) => q.length > 0);
    if (live.length === 0) return out;
    out.push(live[Math.floor(rnd() * live.length)]!.shift()!);
  }
}
