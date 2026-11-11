/**
 * Synthetic Codex rollout lines, shaped like real records (`{ timestamp, ordinal, type, payload, metadata }`) with
 * invented content. Only what the file source needs: the `session_meta` first line and a few ordinary records.
 */
export interface ThreadMeta {
  /** Thread id (also the uuid in the file name). */
  id: string;
  /** Root thread id; defaults to `id` (a root thread). */
  sessionId?: string;
  /** Present on subagent threads only. */
  parent?: string;
  cwd: string;
}

let ordinal = 0;
const ts = (): string => new Date(Date.UTC(2026, 10, 11, 3, 0, ordinal)).toISOString();

export function sessionMetaLine(t: ThreadMeta): string {
  const payload: Record<string, unknown> = {
    session_id: t.sessionId ?? t.id,
    id: t.id,
    timestamp: ts(),
    cwd: t.cwd,
    originator: 'Codex Desktop',
    cli_version: '0.142.5',
    model_provider: 'openai',
    source: t.parent
      ? { subagent: { thread_spawn: { parent_thread_id: t.parent, depth: 1, agent_path: '/root/helper', agent_nickname: 'Helper' } } }
      : 'vscode',
  };
  if (t.parent) payload.parent_thread_id = t.parent;
  return JSON.stringify({ timestamp: ts(), ordinal: ordinal++, type: 'session_meta', payload, metadata: {} });
}

export function eventLine(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: ts(), ordinal: ordinal++, type, payload, metadata: {} });
}

export const taskStarted = (turnId: string): string => eventLine('event_msg', { type: 'task_started', turn_id: turnId });
export const taskComplete = (turnId: string): string =>
  eventLine('event_msg', { type: 'task_complete', turn_id: turnId, duration_ms: 1200, error: null });

/** File body: the lines, each ending in a newline. */
export const rollout = (...lines: string[]): string => lines.map((l) => `${l}\n`).join('');

/** `YYYY/MM/DD/rollout-<time>-<thread>.jsonl` (relative to the sessions directory). */
export const rolloutRel = (thread: string, day = '2026/11/11', time = '2026-11-11T03-00-00'): string =>
  `${day}/rollout-${time}-${thread}.jsonl`;

export const indexLine = (id: string, threadName: string, updatedAt = '2026-11-11T03:00:00.000000Z'): string =>
  JSON.stringify({ id, thread_name: threadName, updated_at: updatedAt });
