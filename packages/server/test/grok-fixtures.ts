import type { RawEvent } from '../src/store/store.js';

// Invented Grok Build session data (research-grok.md section A6 shape; fake paths, ids and text).

export const SID = '9a1f0c3e-2b4d-4e6f-8a0b-1c2d3e4f5a6b';
export const CHILD = '4c5d6e7f-0a1b-4c2d-9e3f-0a1b2c3d4e5f';
export const CWD = '/home/dev/demo';
/** CWD as Grok encodes it into a directory name (urlencoding). */
export const DIR = '%2Fhome%2Fdev%2Fdemo';
export const PROJECT = '-home-dev-demo';
export const UPDATES_REL = `${DIR}/${SID}/updates.jsonl`;
export const SUMMARY_REL = `${DIR}/${SID}/summary.json`;
export const UPDATES_KEY = `grok:${UPDATES_REL}`;
export const CHILD_UPDATES_REL = `${DIR}/${CHILD}/updates.jsonl`;
export const CHILD_SUMMARY_REL = `${DIR}/${CHILD}/summary.json`;
export const CHILD_UPDATES_KEY = `grok:${CHILD_UPDATES_REL}`;
export const SUMMARY_ENTRY_KEY = `grok:@summary/${SID}`;
/** Unix seconds of the example's first line. */
export const T0 = 1794301200;
export const iso = (sec: number): string => new Date(sec * 1000).toISOString();

type Obj = Record<string, unknown>;

/** summary.json of a session (fields from research-grok.md A2 / A6). */
export function summaryJson(opts: { id?: string; cwd?: string | null; title?: string | null; summary?: string; kind?: string; parent?: string; model?: string; extra?: Obj } = {}): string {
  const s: Obj = {
    info: opts.cwd === null ? { id: opts.id ?? SID } : { id: opts.id ?? SID, cwd: opts.cwd ?? CWD },
    session_summary: opts.summary ?? 'Fix failing unit test',
    created_at: iso(T0),
    updated_at: iso(T0 + 130),
    last_active_at: iso(T0 + 130),
    num_messages: 7,
    num_chat_messages: 4,
    current_model_id: opts.model ?? 'grok-build',
    chat_format_version: 2,
    git_root_dir: CWD,
    head_branch: 'main',
    head_commit: 'abc1234',
    ...(opts.title === null ? {} : { generated_title: opts.title ?? 'Fix failing unit test in parser' }),
    ...(opts.kind !== undefined ? { session_kind: opts.kind } : {}),
    ...(opts.parent !== undefined ? { parent_session_id: opts.parent } : {}),
    ...opts.extra,
  };
  return JSON.stringify(s, null, 2);
}

/** A `session/update` line. `meta` goes on `params` (default) or on `params.update`. */
export function upd(update: Obj, opts: { ts?: number; meta?: Obj; metaOn?: 'params' | 'update'; sessionId?: string } = {}): string {
  const u: Obj = { ...update };
  const params: Obj = { sessionId: opts.sessionId ?? SID, update: u };
  if (opts.meta !== undefined) {
    if (opts.metaOn === 'update') u._meta = { ...(u._meta as Obj | undefined), ...opts.meta };
    else params._meta = opts.meta;
  }
  return JSON.stringify({ timestamp: opts.ts ?? T0, method: 'session/update', params });
}

/** An `_x.ai/session/update` line (shape guessed, research A6). */
export function ext(update: Obj, opts: { ts?: number; sessionId?: string } = {}): string {
  return JSON.stringify({ timestamp: opts.ts ?? T0, method: '_x.ai/session/update', params: { sessionId: opts.sessionId ?? SID, update } });
}

export const text = (t: string): Obj => ({ type: 'text', text: t });
export const chunk = (kind: 'user' | 'agent' | 'thought', t: string, opts: { ts?: number; promptId?: string; metaOn?: 'params' | 'update' } = {}): string =>
  upd({ sessionUpdate: `${kind === 'thought' ? 'agent_thought' : `${kind}_message`}_chunk`, content: text(t) }, { ts: opts.ts, ...(opts.promptId !== undefined ? { meta: { promptId: opts.promptId }, metaOn: opts.metaOn } : {}) });

/** The example session of research-grok.md A6 (one turn, promptId p1), with the search_replace call's tool name. */
export function exampleLines(): string[] {
  const m = (extra: Obj = {}): { meta: Obj } => ({ meta: { promptId: 'p1', ...extra } });
  return [
    upd({ sessionUpdate: 'user_message_chunk', content: text('Fix the failing test') }, { ts: T0, ...m({ promptIndex: 0 }) }),
    upd({ sessionUpdate: 'agent_thought_chunk', content: text('Run the tests first.') }, { ts: T0 + 2, ...m({ totalTokens: 5120 }) }),
    upd({ sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'npm test', kind: 'execute', status: 'pending', rawInput: { command: 'npm test', description: 'Run tests' } }, { ts: T0 + 3, ...m() }),
    upd({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'failed', content: [{ type: 'content', content: text('1 test failed') }] }, { ts: T0 + 9, ...m() }),
    upd(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_2',
        title: 'Edit src/parser.ts',
        kind: 'edit',
        status: 'pending',
        locations: [{ path: `${CWD}/src/parser.ts` }],
        rawInput: { file_path: 'src/parser.ts', old_string: 'a<b', new_string: 'a<=b' },
        _meta: { toolName: 'search_replace' },
      },
      { ts: T0 + 15, ...m() },
    ),
    upd({ sessionUpdate: 'tool_call_update', toolCallId: 'call_2', status: 'completed' }, { ts: T0 + 16, ...m() }),
    upd({ sessionUpdate: 'agent_message_chunk', content: text('Fixed the off-by-one.') }, { ts: T0 + 18, ...m({ totalTokens: 6900 }) }),
    ext({ sessionUpdate: 'turn_completed', prompt_id: 'p1', usage: { inputTokens: 6200, outputTokens: 700, cachedReadTokens: 4000, cacheCreationTokens: 0, reasoningTokens: 120 } }, { ts: T0 + 19 }),
  ];
}

/** Transcript raw events of lines of one file (offsets as the line reader gives them). */
export function transcript(lines: string[], opts: { key?: string; sessionId?: string; agentId?: string | null; projectId?: string | null; startOffset?: number } = {}): RawEvent[] {
  let offset = opts.startOffset ?? 0;
  return lines.map((line) => {
    const e: RawEvent = {
      source: 'transcript',
      origin: 'grok',
      file: opts.key ?? (opts.agentId ? CHILD_UPDATES_KEY : UPDATES_KEY),
      offset,
      line,
      recordType: 'x',
      sessionId: opts.sessionId ?? SID,
      agentId: opts.agentId ?? null,
      projectId: opts.projectId === undefined ? PROJECT : opts.projectId,
    };
    offset += Buffer.byteLength(line) + 1;
    return e;
  });
}

/** The summary entry meta event the source derives from summary.json (payload as GrokFileSource.indexEntries writes it). */
export function summaryEntry(payload: Obj, opts: { sessionId?: string; projectId?: string } = {}): RawEvent {
  const sid = opts.sessionId ?? SID;
  return { source: 'meta', origin: 'grok', file: `grok:@summary/${sid}`, sessionId: sid, agentId: null, payload: JSON.stringify(payload), projectId: opts.projectId ?? PROJECT };
}
