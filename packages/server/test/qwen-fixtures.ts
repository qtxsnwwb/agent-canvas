import type { RawEvent } from '../src/store/store.js';

// Invented Qwen Code transcript data, built from docs/formats/qwen-code.md sections 2-4 (no real session was seen;
// ids, paths and text are fake). One builder per record kind of reference 2.3, each with the envelope the recorder
// writes (uuid, parentUuid, sessionId, timestamp, type, subtype, cwd, version), and a recorder (`Log`) that appends
// with the recorder's parent rule: every record's parentUuid is the current tail, which it then becomes (unless told
// otherwise), and `rewindTo` sets the tail back the way /rewind does.

export const SID = '3b1e0c9a-5d2f-4e61-8a70-1c2d3e4f5a6b';
export const CWD = '/home/u/app';
export const PROJECT = 'home-u-app';
/** Epoch ms of the first record. */
export const T0 = Date.parse('2026-11-16T09:00:00.000Z');
export const isoOf = (ms: number): string => new Date(ms).toISOString();

type Obj = Record<string, unknown>;

export interface Envelope {
  uuid: string;
  parentUuid: string | null;
  sessionId?: string;
  /** ISO string (the recorder's form); a number or junk only in tests of bad input. */
  timestamp?: unknown;
  cwd?: string;
  version?: string;
}

/** One line: the envelope, then the record's own fields (a field left undefined is not written). */
export function line(type: string, subtype: string | undefined, env: Envelope, body: Obj = {}): string {
  return JSON.stringify({
    uuid: env.uuid,
    parentUuid: env.parentUuid,
    sessionId: env.sessionId ?? SID,
    timestamp: env.timestamp,
    type,
    subtype,
    cwd: env.cwd ?? CWD,
    version: env.version ?? '0.27.4',
    gitBranch: 'main',
    ...body,
  });
}

// ---- parts ----

export const text = (t: string): Obj => ({ text: t });
export const thought = (t: string, signature?: string): Obj => ({ text: t, thought: true, ...(signature !== undefined ? { thoughtSignature: signature } : {}) });
export const signatureOnly = (signature = 'c2ln'): Obj => ({ thoughtSignature: signature });
export const image = (): Obj => ({ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } });
export const fcall = (name: string, args: unknown, id?: string): Obj => ({ functionCall: { ...(id !== undefined ? { id } : {}), name, args } });
export const fresponse = (name: string, response: Obj, id?: string): Obj => ({ functionResponse: { ...(id !== undefined ? { id } : {}), name, response } });
export const HOOK = '<qwen:user-prompt-submit-context>\nbranch: main\n</qwen:user-prompt-submit-context>';

/** usageMetadata (OpenAI-compatible shape: total = prompt + candidates). */
export const usageMeta = (prompt: number, candidates: number, cached = 0, thoughts = 0, total = prompt + candidates): Obj => ({
  promptTokenCount: prompt,
  candidatesTokenCount: candidates,
  cachedContentTokenCount: cached,
  thoughtsTokenCount: thoughts,
  totalTokenCount: total,
});

// ---- record builders (reference 2.3) ----

export interface PromptOpts {
  /** The model-bound parts (default: the typed text, then the hook part). */
  parts?: Obj[];
  /** systemPayload; null: none (an ACP client / an old record). Default: displayText = typed, hookContext. */
  payload?: Obj | null;
  authType?: string;
  provenance?: string;
}
export const userPrompt = (typed: string, env: Envelope, o: PromptOpts = {}): string =>
  line('user', undefined, env, {
    provenance: o.provenance ?? 'real_user',
    executionContext: { modelId: 'qwen3-coder-plus', ...(o.authType !== undefined ? { authType: o.authType } : {}), approvalMode: 'default' },
    message: { role: 'user', parts: o.parts ?? [text(`${typed}\n\n--- Content from referenced files ---\n(none)`), text(HOOK)] },
    ...(o.payload === null ? {} : { systemPayload: o.payload ?? { displayText: typed, hookContext: 'branch: main' } }),
    promptId: `${SID}########0`,
  });
export const midTurn = (typed: string, env: Envelope, authType?: string): string =>
  line('user', 'mid_turn_user_message', env, {
    executionContext: { modelId: 'qwen3-coder-plus', ...(authType !== undefined ? { authType } : {}), approvalMode: 'default' },
    message: { role: 'user', parts: [text(typed)] },
    systemPayload: { displayText: typed },
  });
export const notification = (displayText: string | undefined, env: Envelope, subtype: 'notification' | 'cron' = 'notification', partText = '<task-notification>done</task-notification>'): string =>
  line('user', subtype, env, {
    provenance: 'system',
    message: { role: 'user', parts: [text(partText)] },
    systemPayload: { ...(displayText !== undefined ? { displayText } : {}), backgroundTask: { taskId: 'Explore-call_b7', status: 'completed', kind: 'agent', toolUseId: 'call_b7' } },
  });
export const realtimeUser = (t: string, env: Envelope): string => line('user', 'realtime_message', env, { message: { role: 'user', parts: [text(t)] } });
export const hiddenUser = (subtype: 'goal_runtime' | 'agent_mention' | 'agent_message', env: Envelope): string =>
  line('user', subtype, env, { provenance: subtype === 'goal_runtime' ? 'goal_runtime' : 'external_agent', message: { role: 'user', parts: [text('internal')] } });

export interface AssistantOpts {
  model?: string | null;
  usage?: Obj | null;
  subtype?: string;
}
export const assistant = (parts: Obj[], env: Envelope, o: AssistantOpts = {}): string =>
  line('assistant', o.subtype, env, {
    provenance: 'assistant_output',
    ...(o.model === null ? {} : { model: o.model ?? 'qwen3-coder-plus' }),
    message: { role: 'model', parts },
    ...(o.usage === null || o.usage === undefined ? {} : { usageMetadata: o.usage }),
    contextWindowSize: 1_000_000,
  });

export interface ResultOpts {
  /** functionResponse.id and toolCallResult.callId (null: neither). */
  id?: string | null;
  status?: string;
  resultDisplay?: unknown;
  /** response body: `{output}` by default; `{error}` with `error`. */
  error?: string;
  subtype?: string;
  /** Omit toolCallResult.status (a subagent file's success). */
  noStatus?: boolean;
}
export const toolResult = (name: string, output: unknown, env: Envelope, o: ResultOpts = {}): string => {
  const id = o.id === undefined ? undefined : (o.id ?? undefined);
  const response = o.error !== undefined ? { error: o.error } : { output };
  return line('tool_result', o.subtype, env, {
    provenance: 'tool_result',
    message: { role: 'user', parts: [fresponse(name, response, id)] },
    toolCallResult: {
      ...(id !== undefined ? { callId: id } : {}),
      ...(o.noStatus === true ? {} : { status: o.status ?? (o.error !== undefined ? 'error' : 'success') }),
      ...(o.resultDisplay !== undefined ? { resultDisplay: o.resultDisplay } : {}),
      error: {},
    },
  });
};

export const system = (subtype: string, payload: Obj | undefined, env: Envelope, extra: Obj = {}): string =>
  line('system', subtype, env, { provenance: 'system', ...(payload !== undefined ? { systemPayload: payload } : {}), ...extra });
export const compression = (env: Envelope, original = 182_000, now = 21_000): string =>
  system(
    'chat_compression',
    {
      info: { originalTokenCount: original, newTokenCount: now, compressionStatus: 1 },
      compressedHistory: [
        { role: 'user', parts: [text('<summary>SECRET-HISTORY the earlier conversation</summary>')] },
        { role: 'model', parts: [text('Got it.')] },
      ],
      contextPrefixLength: 0,
      summaryPrefixLength: 2,
    },
    env,
  );
export const slashCommand = (rawCommand: string, env: Envelope, phase: 'invocation' | 'result' = 'invocation', hidden = false): string =>
  system('slash_command', { phase, rawCommand, ...(hidden ? { hiddenInvocation: true } : {}), ...(phase === 'result' ? { outputHistoryItems: [{ type: 'about' }] } : {}) }, env);
export const customTitle = (title: string, env: Envelope, titleSource?: 'manual' | 'auto'): string => system('custom_title', { customTitle: title, ...(titleSource !== undefined ? { titleSource } : {}) }, env);
export const turnResult = (state: 'completed' | 'cancelled' | 'error', env: Envelope, error?: unknown): string =>
  system('turn_result', { promptId: `${SID}########0`, state, ...(error !== undefined ? { error } : {}), endedAt: 0 }, env);
export const sessionModel = (authType: string, env: Envelope): string => system('session_model', { modelId: 'qwen3-coder-plus', authType }, env);
export const rewindRecord = (env: Envelope, truncatedCount = 3): string => system('rewind', { truncatedCount }, env);

/** Every system subtype of reference 2.3 that shows nothing (and is not counted as unknown), with a plausible payload. */
export const QUIET_SYSTEM: Record<string, Obj | undefined> = {
  rewind: { truncatedCount: 1 },
  at_command: { filesRead: ['a.ts'], status: 'success', userText: '@a.ts' },
  ui_telemetry: { uiEvent: { 'event.name': 'qwen-code.api_response', input_token_count: 999999 } },
  session_model: { modelId: 'm', authType: 'openai' },
  session_approval_mode: { mode: 'default' },
  session_workflow_mode: { enabled: false },
  session_source: { sourceType: 'cli' },
  parent_session: { parentSessionId: 'aaaaaaaa-0000-0000-0000-000000000000' },
  session_execution_engine: { engine: 'legacy' },
  turn_attempt: undefined,
  file_history_snapshot: { snapshots: [] },
  attribution_snapshot: { snapshot: {} },
  user_text_elements: { content: 'x', textElements: [] },
  memory_catalog_snapshot: undefined,
  omni_recall: { recalled: [] },
  background_task_completed: { displayText: 'done' },
  branch_checkpoint: { v: 1 },
  goal_state: { goal: 'g' },
  goal_turn_end: { toolCallId: 'c' },
  agent_bootstrap: { kind: 'fork', history: [] },
  agent_launch_prompt: { displayText: 'go' },
  agent_retry: { attempt: 2 },
  agent_session_ready: { callId: 'c', subagentSessionReady: true },
};
/** The records that are not conversation records (reference 2.3): never a leaf, never a link. */
export const NON_CONVERSATION = ['session_artifact_event', 'session_artifact_snapshot', 'session_sources_snapshot', 'managed_session_header_v1', 'managed_session_event_v1', 'managed_session_commit_v1', 'managed_session_snapshot_base_v1'];

// ---- the recorder ----

export interface AddOpts {
  /** The record's parentUuid (default: the tail). */
  parent?: string | null;
  /** Becomes the tail (default true; false for title / source re-anchors and snapshots). */
  advance?: boolean;
  /** Its uuid (default: a fresh one). */
  uuid?: string;
  /** Its time in ms (default: T0 + one second per record). */
  ms?: number;
}

/** What every record of a subagent file carries (reference 5.2); `agentId: null` leaves the field out. */
export interface AgentFields {
  agentId: string | null;
  agentName?: string | null;
}

/**
 * A line as a subagent file holds it (reference 5.2): the envelope plus agentId, agentName, agentColor, isSidechain;
 * no `model` and no `provenance`.
 */
export function asAgentLine(l: string, a: AgentFields): string {
  const obj = JSON.parse(l) as Obj;
  delete obj.model;
  delete obj.provenance;
  return JSON.stringify({
    ...obj,
    ...(a.agentId !== null ? { agentId: a.agentId } : {}),
    ...(a.agentName !== null ? { agentName: a.agentName ?? 'Explore' } : {}),
    agentColor: 'blue',
    isSidechain: true,
  });
}

/** Appends records the way the recorder does (reference 4.1); with `agent`, as the subagent transcript writer does (5.2). */
export class Log {
  readonly lines: string[] = [];
  /** The recorder's tail (lastRecordUuid). */
  tail: string | null = null;
  private n = 0;
  constructor(readonly opts: { prefix?: string; sessionId?: string; t0?: number; agent?: AgentFields } = {}) {}

  /** The uuid the next record will get. */
  peek(): string {
    return `${this.opts.prefix ?? 'r'}-${String(this.n + 1).padStart(4, '0')}`;
  }
  /** Time (ms) of the record about to be written. */
  now(): number {
    return (this.opts.t0 ?? T0) + (this.n + 1) * 1000;
  }
  /** Appends `build(env)`; returns the record's uuid. */
  add(build: (env: Envelope) => string, o: AddOpts = {}): string {
    const uuid = o.uuid ?? this.peek();
    const ms = o.ms ?? this.now();
    this.n += 1;
    const env: Envelope = { uuid, parentUuid: o.parent === undefined ? this.tail : o.parent, sessionId: this.opts.sessionId ?? SID, timestamp: isoOf(ms) };
    const l = build(env);
    this.lines.push(this.opts.agent === undefined ? l : asAgentLine(l, this.opts.agent));
    if (o.advance !== false) this.tail = uuid;
    return uuid;
  }
  /** /rewind to just after `uuid` (the record before the target turn): the tail goes back, then a rewind marker. */
  rewindTo(uuid: string | null): string {
    this.tail = uuid;
    return this.add((env) => rewindRecord(env));
  }
  /** Moves the tail (the next record hangs off `uuid`). */
  at(uuid: string | null): this {
    this.tail = uuid;
    return this;
  }
  prompt(typed: string, o: PromptOpts & AddOpts = {}): string {
    return this.add((env) => userPrompt(typed, env, o), o);
  }
  reply(parts: Obj[], o: AssistantOpts & AddOpts = {}): string {
    return this.add((env) => assistant(parts, env, o), o);
  }
  result(name: string, output: unknown, o: ResultOpts & AddOpts = {}): string {
    return this.add((env) => toolResult(name, output, env, o), o);
  }
  sys(subtype: string, payload?: Obj, o: AddOpts = {}): string {
    return this.add((env) => system(subtype, payload, env), o);
  }
}

/** Raw events of one file's lines, `offset` = byte offset of the line (as the source reads them). */
export function qwenEvents(lines: readonly string[], opts: { sessionId?: string; agentId?: string | null; projectId?: string | null; startOffset?: number } = {}): RawEvent[] {
  let offset = opts.startOffset ?? 0;
  const sid = opts.sessionId ?? SID;
  const agentId = opts.agentId ?? null;
  return lines.map((l) => {
    const e: RawEvent = {
      source: 'transcript',
      origin: 'qwen',
      file: agentId === null ? `qwen:${PROJECT}/chats/${sid}.jsonl` : `qwen:${PROJECT}/subagents/${sid}/agent-${agentId}.jsonl`,
      offset,
      line: l,
      recordType: 'x',
      sessionId: sid,
      agentId,
      projectId: opts.projectId === undefined ? PROJECT : opts.projectId,
    };
    offset += Buffer.byteLength(l) + 1;
    return e;
  });
}

/** The file-name form of an agent id (reference 5.2: every character outside [a-zA-Z0-9_-] becomes `_`). */
export const agentStem = (agentId: string): string => agentId.replace(/[^a-zA-Z0-9_-]/g, '_');

/** The raw events of a subagent file `agent-<stem>.jsonl`; the event's agent id is the stem (the source's form). */
export function agentEvents(stem: string, lines: readonly string[], opts: { sessionId?: string; startOffset?: number } = {}): RawEvent[] {
  return qwenEvents(lines, { ...opts, agentId: stem });
}

/** A whole-file sidecar as the pipeline delivers it: a meta raw event (agent sidecar with `agentStem`, else the title sidecar). */
export function metaEvent(payload: string, o: { agentStem?: string; sessionId?: string } = {}): RawEvent {
  const sid = o.sessionId ?? SID;
  const stem = o.agentStem ?? null;
  return {
    source: 'meta',
    origin: 'qwen',
    file: stem === null ? `qwen:${PROJECT}/chats/${sid}.title.json` : `qwen:${PROJECT}/subagents/${sid}/agent-${stem}.meta.json`,
    sessionId: sid,
    agentId: stem,
    payload,
  };
}

/** `<sessionId>.title.json` (reference 1.4). */
export const titleSidecar = (displayName: unknown, source: unknown): string => JSON.stringify({ version: 1, displayName, source, updatedAt: '2026-11-16T09:12:44.512Z' });

/** `agent-<id>.meta.json` (reference 5.2 `AgentMeta`); a field given as undefined is left out. */
export function agentMeta(o: { agentId: string; agentType?: string; toolUseId?: string; parentAgentId?: string | null; model?: string }): string {
  return JSON.stringify({
    agentId: o.agentId,
    ...(o.agentType !== undefined ? { agentType: o.agentType } : {}),
    description: 'Find callers',
    parentSessionId: SID,
    ...(o.toolUseId !== undefined ? { toolUseId: o.toolUseId } : {}),
    parentAgentId: o.parentAgentId === undefined ? null : o.parentAgentId,
    createdAt: '2026-11-16T09:20:00.000Z',
    status: 'completed',
    isBackgrounded: false,
    ...(o.model !== undefined ? { model: o.model } : {}),
    lastUpdatedAt: '2026-11-16T09:21:12.000Z',
  });
}

/** An `agent` call's arguments (reference 5.1). */
export const agentArgs = (subagentType?: string): Obj => ({ description: 'Find callers', prompt: 'Find every caller of uploadChunk', ...(subagentType !== undefined ? { subagent_type: subagentType } : {}) });

/** The `agent` tool's recorded result display (reference 5.1, `AgentResultDisplay`). */
export const agentResultDisplay = (name: string): Obj => ({ type: 'task_execution', subagentName: name, taskDescription: 'Find callers', taskPrompt: 'Find every caller', status: 'completed', result: 'src/a.ts', toolCalls: [] });

/**
 * A subagent transcript of reference 5.2 (in its records' order): the launching prompt, a round (thinking, text,
 * usage, agentRunId / agentRound), one record per tool call, the call's result without `status`, a tool-lifecycle
 * telemetry record, a final round. `t0` should fall after the dispatch call's time.
 */
export function agentThread(agentId: string, o: { agentName?: string | null; t0?: number; prefix?: string; withId?: boolean } = {}): { log: Log; ids: Record<string, string> } {
  const log = new Log({ prefix: o.prefix ?? 'c', t0: o.t0 ?? T0 + 100_000, agent: { agentId: o.withId === false ? null : agentId, agentName: o.agentName } });
  const ids: Record<string, string> = {};
  ids.p = log.prompt('Find every caller of uploadChunk', { payload: null, parts: [text('Find every caller of uploadChunk')] });
  ids.a1 = log.add((env) => line('assistant', undefined, env, { message: { role: 'model', parts: [thought('Searching first.'), text('Let me grep.')] }, usageMetadata: usageMeta(5120, 64), agentRunId: '7d', agentRound: 1 }));
  ids.c1 = log.add((env) => line('assistant', undefined, env, { message: { role: 'model', parts: [fcall('grep_search', { pattern: 'uploadChunk' }, 'call_c1')] } }));
  ids.r1 = log.result('grep_search', 'src/a.ts:12: uploadChunk(', { id: 'call_c1', noStatus: true });
  ids.tel = log.sys('ui_telemetry', { uiEvent: { 'event.name': 'tool_lifecycle' } });
  ids.a2 = log.add((env) => line('assistant', undefined, env, { message: { role: 'model', parts: [text('One caller: src/a.ts:12.')] }, usageMetadata: usageMeta(5300, 20), agentRunId: '7d', agentRound: 2 }));
  return { log, ids };
}

/**
 * The example session: a prompt; a reply with thinking, text and a read_file call; its result; a final reply; a
 * `turn_result`. Returns the lines and the uuids the tests refer to.
 */
export function exampleSession(): { log: Log; ids: Record<string, string> } {
  const log = new Log();
  const ids: Record<string, string> = {};
  ids.model = log.add((env) => sessionModel('qwen-oauth', env));
  ids.p1 = log.prompt('fix the flaky upload test');
  ids.a1 = log.reply([thought('The test races the cleanup.'), text("I'll look at the test first."), fcall('read_file', { file_path: 'test/upload.test.ts' }, 'call_a1')], {
    usage: usageMeta(18_230, 212, 17_408, 96),
  });
  ids.r1 = log.result('read_file', "import { test } from 'vitest'", { id: 'call_a1', resultDisplay: 'Read 84 lines' });
  ids.a2 = log.reply([text('Fixed: the cleanup now waits.')], { usage: usageMeta(18_600, 40, 18_000, 0) });
  ids.t1 = log.add((env) => turnResult('completed', env));
  return { log, ids };
}
