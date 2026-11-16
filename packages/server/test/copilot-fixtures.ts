import type { RawEvent } from '../src/store/store.js';

// Invented GitHub Copilot CLI session data (research-copilot.md section 6 shape; fake paths, ids and text).

export const SID = '5f3c2b9e-aaaa-4bbb-8ccc-000000000abc';
export const CWD = '/home/dev/demo';
export const PROJECT = '-home-dev-demo';
export const EVENTS_REL = `${SID}/events.jsonl`;
export const EVENTS_KEY = `copilot:${EVENTS_REL}`;
export const WORKSPACE_REL = `${SID}/workspace.yaml`;
export const WORKSPACE_KEY = `copilot:${WORKSPACE_REL}`;

/** Event id `0b1e6c1a-1111-4a00-8000-0000000000xx` with xx = n in hex. */
export const E = (n: number): string => `0b1e6c1a-1111-4a00-8000-${n.toString(16).padStart(12, '0')}`;

/** The example session of the research notes (section 6), one JSON line per event. */
export function exampleRecords(): Record<string, unknown>[] {
  return [
    { type: 'session.start', id: E(1), timestamp: '2026-11-10T09:00:00.000Z', parentId: null, data: { sessionId: SID, version: 1, producer: 'copilot-agent', copilotVersion: '1.0.110', startTime: '2026-11-10T09:00:00.000Z', selectedModel: 'claude-sonnet-4.5', context: { cwd: CWD, gitRoot: CWD, repository: 'octo/demo', repositoryHost: 'github.com', hostType: 'github', branch: 'main', headCommit: 'abc1234' } } },
    { type: 'user.message', id: E(2), timestamp: '2026-11-10T09:00:05.000Z', parentId: E(1), data: { content: 'Fix the typo in README', transformedContent: 'Fix the typo in README', attachments: [], interactionId: 'int-1' } },
    { type: 'assistant.turn_start', id: E(3), timestamp: '2026-11-10T09:00:06.000Z', parentId: E(2), data: { turnId: '0', interactionId: 'int-1' } },
    { type: 'assistant.reasoning', id: E(4), timestamp: '2026-11-10T09:00:07.000Z', parentId: E(3), data: { reasoningId: 'r-1', content: 'Need to open README first.' } },
    { type: 'assistant.message', id: E(5), timestamp: '2026-11-10T09:00:08.000Z', parentId: E(4), data: { messageId: 'm-1', content: '', toolRequests: [{ toolCallId: 'call_01', name: 'view', arguments: { path: '/home/dev/demo/README.md' }, type: 'function', intentionSummary: 'view the file at /home/dev/demo/README.md.' }], interactionId: 'int-1', turnId: '0' } },
    { type: 'tool.execution_start', id: E(6), timestamp: '2026-11-10T09:00:08.100Z', parentId: E(5), data: { toolCallId: 'call_01', toolName: 'view', arguments: { path: '/home/dev/demo/README.md' }, turnId: '0' } },
    { type: 'tool.execution_complete', id: E(7), timestamp: '2026-11-10T09:00:08.300Z', parentId: E(6), data: { toolCallId: 'call_01', success: true, result: { content: '1. # Demo\n2. Teh demo app.', detailedContent: '1. # Demo\n2. Teh demo app.' }, turnId: '0' } },
    { type: 'tool.execution_start', id: E(8), timestamp: '2026-11-10T09:00:10.000Z', parentId: E(7), data: { toolCallId: 'call_02', toolName: 'bash', arguments: { command: 'npm test', description: 'Run tests' } } },
    { type: 'tool.execution_complete', id: E(9), timestamp: '2026-11-10T09:00:12.000Z', parentId: E(8), data: { toolCallId: 'call_02', success: false, error: { message: 'Command exited with code 1', code: 'failure' } } },
    { type: 'assistant.message', id: E(10), timestamp: '2026-11-10T09:00:14.000Z', parentId: E(9), data: { messageId: 'm-2', content: 'Fixed the typo.', toolRequests: [], turnId: '0' } },
    { type: 'assistant.turn_end', id: E(11), timestamp: '2026-11-10T09:00:14.100Z', parentId: E(10), data: { turnId: '0' } },
    { type: 'session.resume', id: E(12), timestamp: '2026-11-11T10:00:00.000Z', parentId: E(11), data: { resumeTime: '2026-11-11T10:00:00.000Z', eventCount: 12, context: { cwd: CWD, branch: 'main' } } },
    { type: 'subagent.started', id: E(13), timestamp: '2026-11-11T10:00:20.000Z', parentId: E(12), data: { toolCallId: 'call_03', agentName: 'explore', agentDisplayName: 'Explore', agentDescription: 'Read-only search' } },
    { type: 'tool.execution_start', id: E(14), timestamp: '2026-11-11T10:00:21.000Z', parentId: E(13), agentId: 'agent-explore-1', data: { toolCallId: 'call_04', toolName: 'grep', arguments: { pattern: 'TODO', path: CWD }, parentToolCallId: 'call_03' } },
    { type: 'subagent.completed', id: E(15), timestamp: '2026-11-11T10:00:30.000Z', parentId: E(14), data: { toolCallId: 'call_03', agentName: 'explore', agentDisplayName: 'Explore', durationMs: 10000, totalToolCalls: 1 } },
    { type: 'session.shutdown', id: E(16), timestamp: '2026-11-11T10:05:00.000Z', parentId: E(15), data: { shutdownType: 'routine', sessionStartTime: 1762765200000, totalApiDurationMs: 4200, codeChanges: { linesAdded: 1, linesRemoved: 1, filesModified: ['README.md'] }, modelMetrics: { 'claude-sonnet-4.5': { requests: { count: 3 }, usage: { inputTokens: 5000, outputTokens: 300 } } }, currentModel: 'claude-sonnet-4.5' } },
  ];
}
export const exampleLines = (): string[] => exampleRecords().map((r) => JSON.stringify(r));

/** workspace.yaml of the example (keys from third-party readers). */
export const WORKSPACE_YAML = [
  `id: ${SID}`,
  `cwd: ${CWD}`,
  `git_root: ${CWD}`,
  'repository: octo/demo',
  'branch: main',
  'name: Fix README typo',
  'summary: Fix the README',
  'created_at: 2026-11-10T09:00:00.000Z',
  'updated_at: 2026-11-11T10:05:00.000Z',
  '',
].join('\n');

let seq = 0x1000;
/** An event line of the given type (fresh id, timestamp `at`, optional agentId). */
export function ev(type: string, data: Record<string, unknown>, opts: { at?: string; agentId?: string; id?: string } = {}): string {
  seq += 1;
  const rec: Record<string, unknown> = { type, id: opts.id ?? E(seq), timestamp: opts.at ?? '2026-11-12T08:00:00.000Z', parentId: null, data };
  if (opts.agentId !== undefined) rec.agentId = opts.agentId;
  return JSON.stringify(rec);
}

/** A session.start line (fixed id E(1)). */
export const startLine = (cwd: string = CWD): string =>
  JSON.stringify({ type: 'session.start', id: E(1), timestamp: '2026-11-12T08:00:00.000Z', parentId: null, data: { sessionId: SID, version: 1, producer: 'copilot-agent', copilotVersion: '1.0.110', startTime: '2026-11-12T08:00:00.000Z', selectedModel: 'gpt-5', context: { cwd, branch: 'dev' } } });

/** Transcript raw events of lines of one file. */
export function transcript(lines: string[], opts: { key?: string; sessionId?: string; projectId?: string | null; startOffset?: number } = {}): RawEvent[] {
  let offset = opts.startOffset ?? 0;
  return lines.map((line) => {
    const e: RawEvent = {
      source: 'transcript',
      origin: 'copilot',
      file: opts.key ?? EVENTS_KEY,
      offset,
      line,
      recordType: 'x',
      sessionId: opts.sessionId ?? SID,
      agentId: null,
      projectId: opts.projectId === undefined ? PROJECT : opts.projectId,
    };
    offset += Buffer.byteLength(line) + 1;
    return e;
  });
}

/** A workspace.yaml meta raw event. */
export function workspace(payload: string, opts: { sessionId?: string; projectId?: string | null } = {}): RawEvent {
  return { source: 'meta', origin: 'copilot', file: WORKSPACE_KEY, sessionId: opts.sessionId ?? SID, agentId: null, payload, projectId: opts.projectId === undefined ? PROJECT : opts.projectId };
}
