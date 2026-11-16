import type { RawEvent } from '../src/store/store.js';

// Invented Gemini CLI session content, shaped like the example of research-gemini.md section 6 (fake ids, paths, text).

export const SID = '3f9c2a1b-7d4e-4c1a-9b2f-0e6d5c4b3a21';
export const SUB_ID = '5a6b7c8d-1111-4222-8333-944455556666';
export const SLUG = 'demo-app';
export const PROJECT = 'gemini:demo-app';
export const MAIN_REL = `${SLUG}/chats/session-2026-11-16T09-41-3f9c2a1b.jsonl`;
export const SUB_REL = `${SLUG}/chats/${SID}/${SUB_ID}.jsonl`;
export const MAIN_KEY = `gemini:${MAIN_REL}`;
export const SUB_KEY = `gemini:${SUB_REL}`;

export const M1 = 'a1e0c3d2-0001-4f00-8000-000000000001';
export const M2 = 'a1e0c3d2-0002-4f00-8000-000000000002';
export const M3 = 'a1e0c3d2-0003-4f00-8000-000000000003';
export const M4 = 'a1e0c3d2-0004-4f00-8000-000000000004';
export const M5 = 'a1e0c3d2-0005-4f00-8000-000000000005';
export const CALL_READ = 'call_1763286084880_0';
export const CALL_SHELL = 'call_1763286091400_0';

export const metaLine = (sessionId = SID, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    sessionId,
    projectHash: '9d5e3c0f1a2b4c6d8e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d',
    startTime: '2026-11-16T09:41:07.120Z',
    lastUpdated: '2026-11-16T09:41:07.120Z',
    kind: 'main',
    ...extra,
  });

export const thought = { subject: 'Locating the CLI entry', description: 'Need to see how args are parsed.', timestamp: '2026-11-16T09:41:23.010Z' };
export const tokens2 = { input: 5210, output: 42, cached: 4096, thoughts: 118, tool: 0, total: 5370 };
export const tokens4 = { input: 6011, output: 210, cached: 5120, thoughts: 0, tool: 0, total: 6221 };

export const userMsg = (id: string, text: string, ts = '2026-11-16T09:41:20.501Z'): Record<string, unknown> => ({ id, timestamp: ts, content: [{ text }], type: 'user' });

const m2Base = {
  id: M2,
  timestamp: '2026-11-16T09:41:24.880Z',
  content: "I'll read the file first.",
  type: 'gemini',
  thoughts: [thought],
  tokens: tokens2,
  model: 'gemini-2.5-pro',
};
export const readCall = (status: string, withResult: boolean): Record<string, unknown> => ({
  id: CALL_READ,
  name: 'read_file',
  args: { file_path: '/home/dev/demo-app/src/cli.ts' },
  status,
  timestamp: withResult ? '2026-11-16T09:41:25.102Z' : '2026-11-16T09:41:24.885Z',
  displayName: 'ReadFile',
  description: withResult ? 'src/cli.ts' : 'Reads a file',
  renderOutputAsMarkdown: true,
  ...(withResult
    ? { result: [{ functionResponse: { id: CALL_READ, name: 'read_file', response: { output: "import { parseArgs } from 'node:util';\n..." } } }], resultDisplay: '' }
    : {}),
});
export const m2 = (stage: 0 | 1 | 2): Record<string, unknown> =>
  stage === 0 ? { ...m2Base } : { ...m2Base, toolCalls: [readCall(stage === 1 ? 'scheduled' : 'success', stage === 2)] };
export const m3 = {
  id: M3,
  timestamp: '2026-11-16T09:41:25.110Z',
  content: [{ functionResponse: { id: CALL_READ, name: 'read_file', response: { output: "import { parseArgs } from 'node:util';\n..." } } }],
  type: 'user',
};
export const shellCall = (status = 'error'): Record<string, unknown> => ({
  id: CALL_SHELL,
  name: 'run_shell_command',
  args: { command: 'npm test', description: 'Run tests' },
  status,
  timestamp: '2026-11-16T09:41:40.020Z',
  result: [{ functionResponse: { id: CALL_SHELL, name: 'run_shell_command', response: { error: 'Command exited with code 1' } } }],
  resultDisplay: 'Command exited with code 1',
});
export const m4 = (status = 'error'): Record<string, unknown> => ({
  id: M4,
  timestamp: '2026-11-16T09:41:31.400Z',
  content: '',
  type: 'gemini',
  tokens: tokens4,
  model: 'gemini-2.5-pro',
  toolCalls: [shellCall(status)],
});
export const m5 = { id: M5, timestamp: '2026-11-16T09:41:41.000Z', content: 'Tool call was rejected by the user.', type: 'info' };
export const TITLE = 'Add --verbose flag to CLI';

/** The example file of research section 6, one entry per physical line. */
export function exampleLines(): string[] {
  return [
    metaLine(),
    JSON.stringify(userMsg(M1, 'Add a --verbose flag to cli.ts')),
    JSON.stringify({ $set: { lastUpdated: '2026-11-16T09:41:20.502Z' } }),
    JSON.stringify(m2(0)),
    JSON.stringify({ $set: { lastUpdated: '2026-11-16T09:41:24.881Z' } }),
    JSON.stringify(m2(1)),
    JSON.stringify(m2(2)),
    JSON.stringify(m3),
    JSON.stringify(m4()),
    JSON.stringify(m5),
    JSON.stringify({ $set: { summary: TITLE } }),
  ];
}

/** The same session as a legacy whole-object `.json` (2-space indented). */
export function legacyJson(messages: Record<string, unknown>[], extra: Record<string, unknown> = {}, sessionId = SID): string {
  return JSON.stringify(
    {
      sessionId,
      projectHash: '9d5e3c0f1a2b4c6d8e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d',
      startTime: '2026-11-16T09:41:07.120Z',
      lastUpdated: '2026-11-16T09:41:41.000Z',
      messages,
      ...extra,
    },
    null,
    2,
  );
}

/** A subagent file: metadata, its task prompt and one reply. */
export function subagentLines(subId = SUB_ID): string[] {
  return [
    metaLine(subId, { kind: 'subagent', directories: ['/home/dev/demo-app'] }),
    JSON.stringify({ id: 'sub-0001', timestamp: '2026-11-16T09:42:01.000Z', content: [{ text: 'Investigate the arg parser' }], type: 'user' }),
    JSON.stringify({ id: 'sub-0002', timestamp: '2026-11-16T09:42:05.000Z', content: 'The parser is in src/cli.ts.', type: 'gemini', model: 'gemini-2.5-flash' }),
  ];
}

/** A gemini message dispatching a subagent (tool call with agentId). */
export const dispatchMsg = (status = 'success', subId = SUB_ID): Record<string, unknown> => ({
  id: 'a1e0c3d2-0006-4f00-8000-000000000006',
  timestamp: '2026-11-16T09:42:00.000Z',
  content: '',
  type: 'gemini',
  toolCalls: [
    {
      id: 'call_dispatch_0',
      name: 'codebase_investigator',
      args: { objective: 'Investigate the arg parser' },
      status,
      timestamp: '2026-11-16T09:42:06.000Z',
      agentId: subId,
      ...(status === 'success' ? { result: [{ functionResponse: { id: 'call_dispatch_0', name: 'codebase_investigator', response: { output: 'done' } } }] } : {}),
    },
  ],
});

/** Transcript raw events of a file's lines (byte offsets as the reader gives them). */
export function transcript(lines: string[], opts: { key?: string; sessionId?: string; agentId?: string | null; projectId?: string | null; startOffset?: number } = {}): RawEvent[] {
  let offset = opts.startOffset ?? 0;
  return lines.map((line) => {
    const ev: RawEvent = {
      source: 'transcript',
      origin: 'gemini',
      file: opts.key ?? MAIN_KEY,
      offset,
      line,
      recordType: 'x',
      sessionId: opts.sessionId ?? SID,
      agentId: opts.agentId ?? null,
      projectId: opts.projectId === undefined ? PROJECT : opts.projectId,
    };
    offset += Buffer.byteLength(line) + 1;
    return ev;
  });
}

/** A meta raw event (legacy `.json` content or a project entry). */
export function meta(file: string, payload: string, opts: { sessionId?: string; agentId?: string | null; projectId?: string | null } = {}): RawEvent {
  return {
    source: 'meta',
    origin: 'gemini',
    file,
    sessionId: opts.sessionId ?? SID,
    agentId: opts.agentId ?? null,
    payload,
    projectId: opts.projectId === undefined ? PROJECT : opts.projectId,
  };
}
