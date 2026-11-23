import { ATTENTION_LIMITS, attentionKey, type AttentionItem, type AttentionKind, type Session } from '@agent-canvas/shared';

/**
 * What the attention page needs to know about one session (spec 3), kept per session by AttentionService. Times are the
 * stored ISO strings, unchanged (they make up the item's key, which must survive a restart).
 */
export interface SessionMarks {
  session: Session;
  /** Latest main-thread prompt node's timestamp. */
  lastPromptAt: string | null;
  /** Latest error marker (node or hook) at or after lastPromptAt. */
  errorAt: string | null;
  /** Latest error marker node at or after lastPromptAt; `text`: its summary, else its title. */
  errorNode: { id: string; text: string } | null;
  /**
   * The node (main thread or a subagent's) whose status is awaiting_permission, at or after lastPromptAt; the latest one
   * when there are several. `text`: tool name and summary.
   */
  waitingNode: { id: string; timestamp: string; text: string } | null;
  /** The main thread's latest node; `text`: its title. */
  lastMainNode: { id: string; timestamp: string; text: string } | null;
  /** The main thread's latest text node at or after lastPromptAt; `text`: its summary. */
  lastReply: { id: string; text: string } | null;
}

/** An explanation: whitespace runs collapsed, at most ATTENTION_LIMITS.explanationChars code points (the cut marked `…`). */
export function cutExplanation(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  const max = ATTENTION_LIMITS.explanationChars;
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * The session's attention item now, or null (spec 3, plan Global Constraints). In priority order:
 * - awaiting_permission -> `permission` since the waiting node (else the last main-thread node);
 * - idle / awaiting_input with an error marker no main-thread node is later than -> `error` since the marker;
 * - running and quiet for more than `stuckMinutes` (since the later of the last main-thread node and
 *   Session.lastActivityAt, as the notification engine) -> `stuck` since the last main-thread node;
 * - idle / awaiting_input -> `finished` since the last main-thread node.
 * No main-thread prompt, `ended`, `sourceDeleted`: null. `since` is always a main-thread time, never
 * Session.lastActivityAt (hooks, subagents and late records move that one), so a key survives them.
 */
export function decideAttention(m: SessionMarks, nowMs: number, stuckMinutes: number): AttentionItem | null {
  const s = m.session;
  if (s.status === 'ended' || s.sourceDeleted || m.lastPromptAt === null) return null;
  const last = m.lastMainNode;
  const lastAt = last?.timestamp ?? m.lastPromptAt;
  const item = (kind: AttentionKind, since: string, explanation: string | null, nodeId: string | null): AttentionItem => ({
    key: attentionKey(s.id, kind, since),
    sessionId: s.id,
    kind,
    since,
    title: s.title,
    origin: s.origin,
    projectId: s.projectId,
    cwd: s.cwd,
    explanation: cutExplanation(explanation),
    nodeId,
  });
  switch (s.status) {
    case 'awaiting_permission': {
      const w = m.waitingNode;
      return w !== null ? item('permission', w.timestamp, w.text, w.id) : item('permission', lastAt, null, last?.id ?? null);
    }
    case 'idle':
    case 'awaiting_input':
      // The turn ended with the error only when nothing came after the marker on the main thread (spec 3 "以出错或中断
      // 结束"): a main thread that went on without a new prompt (a background task's completion) and stopped is finished.
      if (m.errorAt !== null && !(Date.parse(lastAt) > Date.parse(m.errorAt))) {
        return item('error', m.errorAt, m.errorNode?.text ?? null, m.errorNode?.id ?? last?.id ?? null);
      }
      return item('finished', lastAt, m.lastReply?.text ?? null, m.lastReply?.id ?? last?.id ?? null);
    case 'running': {
      // Quiet as the notifications see it (the later of the last main-thread node and lastActivityAt, so a working
      // subagent keeps it from "stuck"); `since` stays the main-thread node, so the key does not move with the subagent.
      const activity = Date.parse(s.lastActivityAt);
      const quietFrom = Number.isFinite(activity) ? Math.max(Date.parse(lastAt), activity) : Date.parse(lastAt);
      return nowMs - quietFrom > stuckMinutes * 60_000 ? item('stuck', lastAt, last?.text ?? null, last?.id ?? null) : null;
    }
    default:
      return null;
  }
}
