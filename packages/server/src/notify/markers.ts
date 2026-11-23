import type { GraphNode, Origin } from '@agent-canvas/shared';

/*
 * The judgements of "this turn failed or was interrupted" (attention spec 4.1), shared by the notification engine and
 * the attention page so both say the same about a session. See the engine's header comment for the markers per origin.
 */

/**
 * A main-thread node that by itself marks the current turn as failed or interrupted (engine.ts header comment): a
 * `system` node with systemSubtype `interrupt` (any origin), or a Cursor call node that is `failed` because the
 * conversation was aborted. `isAbortedCall` is asked only for a main-thread Cursor node that is `failed` and not an
 * interrupt node. A subagent thread's node never is one.
 */
export function isErrorMarkerNode(
  origin: Origin,
  node: Pick<GraphNode, 'kind' | 'systemSubtype' | 'status' | 'agentId'>,
  isAbortedCall: () => boolean,
): boolean {
  if (node.agentId !== null) return false;
  if (node.kind === 'system' && node.systemSubtype === 'interrupt') return true;
  return node.status === 'failed' && origin === 'cursor' && isAbortedCall();
}

/**
 * When an error marker node (isErrorMarkerNode) marks its turn as failed: an interrupt node from its own time, an
 * aborted Cursor call from its end (else its start). Used by the notification engine (node_added) and the attention page.
 */
export function errorMarkerAt(node: Pick<GraphNode, 'kind' | 'systemSubtype' | 'timestamp' | 'endedAt'>): string {
  return node.kind === 'system' && node.systemSubtype === 'interrupt' ? node.timestamp : (node.endedAt ?? node.timestamp);
}

/**
 * Hooks that by themselves say the current turn failed or was interrupted (main thread): Claude Code `StopFailure`,
 * Codex `Interrupt`, Cursor `stop` whose `status` is `error` or `aborted`. Codex `Stop` carries no failure field. The
 * origins without hooks (Gemini CLI, Grok Build, Copilot CLI, DeepSeek Harness, WorkBuddy, CodeBuddy Code, Doubao Work,
 * Qwen Code) never have one.
 */
export function isErrorHook(origin: Origin, eventName: string, payload: Readonly<Record<string, unknown>> | null): boolean {
  switch (origin) {
    case 'claude':
      return eventName === 'StopFailure';
    case 'codex':
      return eventName === 'Interrupt';
    case 'cursor':
      return eventName === 'stop' && (payload?.status === 'error' || payload?.status === 'aborted');
    case 'gemini':
    case 'grok':
    case 'copilot':
    case 'deepseek':
    case 'workbuddy':
    case 'codebuddy':
    case 'doubao':
    case 'qwen':
      return false; // no hooks
  }
}
