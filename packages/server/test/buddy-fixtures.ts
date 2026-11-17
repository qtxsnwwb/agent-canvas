import type { RawEvent } from '../src/store/store.js';

// Invented WorkBuddy / CodeBuddy Code transcript data, built from docs/formats/buddy-family.md sections 2-7 (no real
// session was seen; ids, paths and text are fake). One builder per record type, with the envelope the writer adds.

export const SID = '3f0c9b1e-5a2d-4c6e-8f10-2b3c4d5e6f70';
/** A subagent's store id (its file stem under `<SID>/subagents/`). */
export const CHILD = 'agent-7d1e2f3a';
export const GRANDCHILD = 'agent-9b8c7d6e';
export const CWD = '/home/dev/repo';
export const PROJECT = 'home-dev-repo';
/** Epoch ms of the first line. */
export const T0 = 1_790_000_000_000;
export const isoOf = (ms: number): string => new Date(ms).toISOString();

type Obj = Record<string, unknown>;

/** The envelope fields (format reference 2); a field left undefined is not written, as JSON.stringify drops it. */
export interface Envelope {
  id?: string;
  parentId?: string;
  logicalParentId?: string;
  timestamp?: number | string;
  sessionId?: string;
  /** null: no cwd key (summary / topic lines, session-meta). */
  cwd?: string | null;
  status?: string;
  providerData?: Obj;
  /** Extra top-level fields (written after the record's own fields). */
  extra?: Obj;
}

/** One line in the writer's key order: id, parentId, logicalParentId, timestamp, type, role, then the rest. */
export function record(type: string, env: Envelope, body: Obj = {}, role?: string): string {
  const out: Obj = {
    id: env.id,
    parentId: env.parentId,
    logicalParentId: env.logicalParentId,
    timestamp: env.timestamp,
    type,
    role,
    ...(env.status !== undefined ? { status: env.status } : {}),
    ...body,
    ...(env.providerData !== undefined ? { providerData: env.providerData } : {}),
    ...(env.sessionId !== undefined ? { sessionId: env.sessionId } : {}),
    ...(env.cwd !== undefined && env.cwd !== null ? { cwd: env.cwd } : {}),
    ...env.extra,
  };
  return JSON.stringify(out);
}

// ---- content parts ----

export const inputText = (text: string): Obj => ({ type: 'input_text', text });
export const outputText = (text: string): Obj => ({ type: 'output_text', text });
/** The client wrapper of format reference 4.1: hidden context, then the typed text in `<user_query>`. */
export const wrapped = (typed: string, role = 'user-context'): string =>
  `<system-reminder data-role="${role}">\n<user_info>OS: linux</user_info>\n</system-reminder>\n<user_query>${typed}</user_query>`;
export const reminder = (role: string, body = 'current_time: 2026-11-17'): string => `<system-reminder data-role="${role}">\n${body}\n</system-reminder>`;

// ---- SDK items ----

export const userMessage = (content: string | Obj[], env: Envelope): string =>
  record('message', env, { content: typeof content === 'string' ? [inputText(content)] : content }, 'user');
/** A user message whose content is a bare string (the SDK allows it). */
export const userMessageString = (content: string, env: Envelope): string => record('message', env, { content }, 'user');
export const assistantMessage = (content: string | Obj[], env: Envelope): string =>
  record('message', { status: 'completed', ...env }, { content: typeof content === 'string' ? [outputText(content)] : content }, 'assistant');
export const systemMessage = (text: string, env: Envelope): string => record('message', env, { content: [inputText(text)] }, 'system');
export const reasoningItem = (parts: { raw?: string[]; summary?: string[] }, env: Envelope): string =>
  record('reasoning', env, {
    content: (parts.summary ?? []).map(inputText),
    ...(parts.raw !== undefined ? { rawContent: parts.raw.map((text) => ({ type: 'reasoning_text', text })) } : {}),
  });
/** `args` goes in as given (the writer's own form is a JSON string; an object is accepted defensively). */
export const functionCall = (name: string, callId: string, args: unknown, env: Envelope): string =>
  record('function_call', { status: 'completed', ...env }, { name, callId, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
export const functionCallObjectArgs = (name: string, callId: string, args: Obj, env: Envelope): string =>
  record('function_call', { status: 'completed', ...env }, { name, callId, arguments: args });
export const functionCallResult = (name: string, callId: string, output: unknown, env: Envelope): string =>
  record('function_call_result', { status: 'completed', ...env }, { name, callId, output });
/** The legacy spelling the writer still tests for. */
export const functionCallOutput = (name: string, callId: string, output: unknown, env: Envelope): string =>
  record('function_call_output', { status: 'completed', ...env }, { name, callId, output });

// ---- custom ("fact") records ----

export const customTitle = (customTitleText: string, env: Envelope): string => record('custom-title', env, { customTitle: customTitleText });
export const aiTitle = (title: string, env: Envelope): string => record('ai-title', env, { aiTitle: title });
export const topicRecord = (topic: string, env: Envelope): string => record('topic', { ...env, cwd: null, sessionId: undefined }, { topic });
export const sessionMeta = (meta: Obj, env: Envelope): string => record('session-meta', { ...env, cwd: null }, { meta });
export const fileHistorySnapshot = (env: Envelope, messageId = 'u-1'): string =>
  record('file-history-snapshot', env, { messageId, isSnapshotUpdate: true, snapshot: { messageId, trackedFileBackups: { 'src/a.ts': { backupFileName: '9f2c@v1', version: 1, backupTime: T0 } }, updatedFilePaths: ['src/a.ts'] } });
export const modelUsage = (messageId: string | null, rawUsage: Obj, env: Envelope, extra: Obj = {}): string =>
  record('model-usage', { ...env, providerData: { ...(messageId !== null ? { messageId } : {}), rawUsage, ...extra, ...env.providerData } });
export const creditUsage = (env: Envelope): string => record('credit-usage', { ...env, providerData: { conversationRequestId: 'req-x', credit: 1.5, source: 'generation_tool', stageId: 's1' } });
export const contextUsage = (env: Envelope): string => record('context-usage', env, { contextTokens: 1200, usageByCategory: { systemPrompt: 100, conversation: 900, tools: 100, mcp: 0, skills: 100, version: 1 } });
export const turnMetrics = (env: Envelope): string => record('turn-metrics', env, { durationMs: 4200, tokenDelta: 3000, source: 'turn' });
export const acpTerminalState = (env: Envelope): string => record('acp-terminal-state', env, { requestId: 'req-x', rootRequestId: 'req-x', stopReason: 'end_turn', cost: { amount: 0.01, currency: 'USD' } });
export const requestRecovery = (env: Envelope): string => record('request-recovery', env, { requestId: 'req-x', userMessageId: 'u-1', attempt: 1 });
/** A rewind / edit tombstone: `parentId` = the new head (absent = empty conversation). */
export const resendForkNotice = (env: Envelope, editedUserItemId?: string): string =>
  record('resend-fork-notice', { ...env, providerData: { skipRun: true, resendFork: true } }, editedUserItemId !== undefined ? { editedUserItemId } : {});
export const checkpointRestore = (env: Envelope): string => record('checkpoint-restore', env, { operationId: 'op-1' });
export const summaryRecord = (text: string, env: Envelope): string => record('summary', { ...env, cwd: null }, { summary: text });
export const goalState = (env: Envelope): string => record('goal-state', env, { goal: 'ship it' });
export const goalProgress = (env: Envelope): string => record('goal-progress', env, { progress: 'half' });
export const goalResult = (env: Envelope): string => record('goal-result', env, { result: 'done' });

/** Every custom type of the writer's CUSTOM_INPUT_ITEM_TYPES list plus session-meta, each as one line. */
export function everyCustomLine(env: Envelope): string[] {
  return [
    customTitle('t', env),
    aiTitle('a', env),
    fileHistorySnapshot(env),
    summaryRecord('s', env),
    topicRecord('p', env),
    goalResult(env),
    goalProgress(env),
    goalState(env),
    turnMetrics(env),
    resendForkNotice(env),
    acpTerminalState(env),
    requestRecovery(env),
    modelUsage('resp-x', { prompt_tokens: 1, completion_tokens: 1 }, env),
    creditUsage(env),
    contextUsage(env),
    checkpointRestore(env),
    sessionMeta({ 'codebuddy.ai/hostKind': 'cli' }, env),
  ];
}

// ---- a conversation chain ----

/**
 * Builds a conversation the way the writer appends it: ids `<prefix>-<n>`, each conversation entry's `parentId` the
 * previous entry (custom records hang off the current tip or nothing), timestamps T0 + n seconds, a
 * conversationRequestId per prompt and a messageId per model response (unless told otherwise).
 */
export class Chain {
  readonly lines: string[] = [];
  /** The id of the latest conversation entry (null before the first). */
  tip: string | null = null;
  private n = 0;
  request: string | null = null;
  private requests = 0;
  constructor(
    readonly opts: { prefix?: string; sessionId?: string; cwd?: string; t0?: number; model?: string; requestIds?: boolean } = {},
  ) {}

  private nextId(): string {
    this.n += 1;
    return `${this.opts.prefix ?? 'e'}-${this.n}`;
  }
  /** Time of the line about to be written. */
  now(): number {
    return (this.opts.t0 ?? T0) + this.n * 1000;
  }
  private env(o: { id?: string; parentId?: string | null; pd?: Obj; ts?: number; cwd?: string }): Envelope {
    const id = o.id ?? this.nextId();
    return {
      id,
      ...(o.parentId === null ? {} : { parentId: o.parentId ?? this.tip ?? undefined }),
      timestamp: o.ts ?? (this.opts.t0 ?? T0) + this.n * 1000,
      sessionId: this.opts.sessionId ?? SID,
      cwd: o.cwd ?? this.opts.cwd ?? CWD,
      ...(o.pd !== undefined ? { providerData: o.pd } : {}),
    };
  }
  private add(line: string, id: string | undefined, advance: boolean): string {
    this.lines.push(line);
    if (advance && id !== undefined) this.tip = id;
    return line;
  }
  /** providerData of a model output item of response `messageId`. */
  out(messageId: string | null, extra: Obj = {}): Obj {
    return {
      ...(this.request !== null && this.opts.requestIds !== false ? { conversationRequestId: this.request } : {}),
      ...(messageId !== null ? { messageId } : {}),
      model: this.opts.model ?? 'glm-5.2',
      requestModelId: this.opts.model ?? 'glm-5.2',
      agent: 'cli',
      ...extra,
    };
  }

  /** A human prompt (wrapped as the desktop client sends it unless `bare`); opens a new request. */
  prompt(typed: string, o: { bare?: boolean; pd?: Obj; id?: string; parentId?: string | null } = {}): string {
    this.requests += 1;
    this.request = `req-${this.requests}`;
    const env = this.env({ id: o.id, parentId: o.parentId, pd: { agent: 'cli', ...(this.opts.requestIds !== false ? { conversationRequestId: this.request } : {}), ...o.pd } });
    return this.add(userMessage(o.bare === true ? typed : wrapped(typed), env), env.id, true);
  }
  /** Any user-role message with the given providerData and content (not a new request). */
  user(content: string | Obj[], pd: Obj = {}, o: { id?: string; parentId?: string | null; logicalParentId?: string } = {}): string {
    const env = { ...this.env({ id: o.id, parentId: o.parentId, pd }), ...(o.logicalParentId !== undefined ? { logicalParentId: o.logicalParentId } : {}) };
    return this.add(userMessage(content, env), env.id, true);
  }
  reply(text: string, messageId: string | null, o: { usage?: Obj; pd?: Obj; id?: string; parentId?: string | null } = {}): string {
    const env = this.env({ id: o.id, parentId: o.parentId, pd: this.out(messageId, { ...(o.usage !== undefined ? { rawUsage: o.usage } : {}), ...o.pd }) });
    return this.add(assistantMessage(text, env), env.id, true);
  }
  think(raw: string[], messageId: string | null, o: { summary?: string[]; pd?: Obj; id?: string } = {}): string {
    const env = this.env({ id: o.id, pd: this.out(messageId, o.pd) });
    return this.add(reasoningItem({ raw, summary: o.summary }, env), env.id, true);
  }
  call(name: string, callId: string, args: unknown, messageId: string | null, o: { usage?: Obj; pd?: Obj; id?: string; parentId?: string | null } = {}): string {
    const env = this.env({ id: o.id, parentId: o.parentId, pd: this.out(messageId, { ...(o.usage !== undefined ? { rawUsage: o.usage } : {}), ...o.pd }) });
    return this.add(functionCall(name, callId, args, env), env.id, true);
  }
  result(name: string, callId: string, output: unknown, messageId: string | null, o: { status?: string; pd?: Obj; id?: string; legacy?: boolean } = {}): string {
    const env = { ...this.env({ id: o.id, pd: this.out(messageId, o.pd) }), status: o.status ?? 'completed' };
    return this.add((o.legacy === true ? functionCallOutput : functionCallResult)(name, callId, output, env), env.id, true);
  }
  system(text: string, pd: Obj = {}, o: { id?: string } = {}): string {
    const env = this.env({ id: o.id, pd });
    return this.add(systemMessage(text, env), env.id, true);
  }
  /** A custom record hanging off the current tip (or nothing): never advances the tip. */
  fact(build: (env: Envelope) => string, o: { parentId?: string | null; withId?: boolean } = {}): string {
    const env = this.env({ parentId: o.parentId });
    if (o.withId === false) delete env.id;
    return this.add(build(env), undefined, false);
  }
  /** A rewind / edit tombstone whose parentId is `head` (null: empty conversation); the next entry hangs off `head`. */
  rewind(head: string | null): string {
    const env = this.env({ parentId: head });
    this.tip = head;
    return this.add(resendForkNotice(env), undefined, false);
  }
  /** A compaction boundary: a user message with no parentId, logicalParentId = the old tip, summary flags. */
  compactBoundary(summary: string, pd: Obj = { isCompacted: true, isSummary: true, compactType: 'auto' }): string {
    const old = this.tip;
    const env = { ...this.env({ parentId: null, pd }), ...(old !== null ? { logicalParentId: old } : {}) };
    return this.add(userMessage(`<cb_summary>${summary}</cb_summary>`, env), env.id, true);
  }
  /** Moves the tip (the next entry hangs off `id`). */
  at(id: string | null): this {
    this.tip = id;
    return this;
  }
  /** The id the next entry will get. */
  peekId(): string {
    return `${this.opts.prefix ?? 'e'}-${this.n + 1}`;
  }
}

/** Raw events of one file's lines, offsets as byte offsets of the lines (as the Buddy source reads them). */
export function buddyEvents(
  lines: readonly string[],
  opts: { origin?: 'workbuddy' | 'codebuddy'; sessionId?: string; agentId?: string | null; projectId?: string | null; startOffset?: number; key?: string } = {},
): RawEvent[] {
  let offset = opts.startOffset ?? 0;
  const origin = opts.origin ?? 'codebuddy';
  const sid = opts.sessionId ?? SID;
  const agentId = opts.agentId ?? null;
  return lines.map((line) => {
    const e: RawEvent = {
      source: 'transcript',
      origin,
      file: opts.key ?? `${origin}:${PROJECT}/${agentId === null ? `${sid}.jsonl` : `${sid}/subagents/${agentId}.jsonl`}`,
      offset,
      line,
      recordType: 'x',
      sessionId: sid,
      agentId,
      projectId: opts.projectId === undefined ? PROJECT : opts.projectId,
    };
    offset += Buffer.byteLength(line) + 1;
    return e;
  });
}

/** OpenAI-style raw usage (prompt includes cache reads). */
export const openaiUsage = (prompt: number, completion: number, cached = 0): Obj => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: prompt + completion,
  ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
});

/**
 * The example session: one request with reasoning, a Bash call and its result, a reply; an `ai-title`; usage on the
 * call and the reply (one response each); the second request dispatches a subagent (Agent tool) whose result names
 * CHILD. Returns the lines and the ids the tests refer to.
 */
export function exampleMain(): { lines: string[]; ids: Record<string, string> } {
  const c = new Chain();
  const ids: Record<string, string> = {};
  c.fact((env) => sessionMeta({ 'codebuddy.ai/hostKind': 'cli' }, env), { parentId: null });
  ids.p1 = c.peekId();
  c.prompt('fix the failing test');
  ids.r1 = c.peekId();
  c.think(['The test reads fixtures/a.json.'], 'resp-1');
  ids.c1 = c.peekId();
  c.call('Bash', 'call_abc', { command: 'npm test' }, 'resp-1', { usage: openaiUsage(1000, 50, 600) });
  c.fact((env) => fileHistorySnapshot(env));
  ids.res1 = c.peekId();
  c.result('Bash', 'call_abc', { type: 'text', text: '1 failed, 12 passed' }, 'resp-1');
  ids.c2 = c.peekId();
  c.call('Read', 'call_r', { file_path: 'src/a.ts' }, 'resp-2', { usage: openaiUsage(1200, 30, 1000) });
  ids.res2 = c.peekId();
  c.result('Read', 'call_r', 'export const a = 1;', 'resp-2');
  ids.a1 = c.peekId();
  c.reply('Fixed: the fixture path was wrong.', 'resp-3', { usage: openaiUsage(1500, 20, 1100) });
  c.fact((env) => aiTitle('Fix failing fixture test', env));
  c.fact((env) => turnMetrics(env));
  ids.p2 = c.peekId();
  c.prompt('now review it with a subagent');
  ids.sub = c.peekId();
  c.call('Task', 'call_sub', { subagent_type: 'reviewer', description: 'Review the fix', prompt: 'Review src/a.ts' }, 'resp-4', { usage: openaiUsage(1600, 40, 1500) });
  ids.subres = c.peekId();
  c.result('Task', 'call_sub', 'Looks good.', 'resp-4', {
    pd: { toolResult: { content: 'Looks good.', subAgent: { sessionId: CHILD, afterId: 'x', lastId: 'y', descriptor: { version: 1, sessionId: CHILD, rootSessionId: SID, parentSessionId: SID, parentToolCallId: 'call_sub', role: 'reviewer', description: 'Review the fix', mode: 'attached', createdAt: T0 } } } },
  });
  ids.a2 = c.peekId();
  c.reply('The reviewer agrees.', 'resp-5', { usage: openaiUsage(1700, 10, 1600) });
  return { lines: c.lines, ids };
}

/** The subagent CHILD's file: its lines carry the subagent's runtime session id, not the stem. */
export function exampleChild(): { lines: string[]; ids: Record<string, string> } {
  const c = new Chain({ prefix: 'c', sessionId: 'runtime-uuid-of-child', t0: T0 + 30_000 });
  const ids: Record<string, string> = {};
  ids.p = c.peekId();
  c.user('Review src/a.ts', { agent: 'reviewer', conversationRequestId: 'creq-1', isMeta: true });
  ids.a = c.peekId();
  c.request = 'creq-1';
  c.reply('Reviewed: fine.', 'cresp-1', { usage: openaiUsage(500, 10) });
  return { lines: c.lines, ids };
}
