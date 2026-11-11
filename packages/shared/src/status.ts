import type { Session, SessionStatus } from './model.js';

/** A `running` session with no activity for longer than this is displayed as `stale`. */
export const STALE_AFTER_MS = 15 * 60_000;

/** Display status: the stored status, or `stale` for a `running` session that has gone quiet. */
export type EffectiveSessionStatus = SessionStatus | 'stale';

/**
 * Derived, never stored. Only `running` degrades: `awaiting_permission` / `awaiting_input` legitimately wait on the
 * user for any length of time.
 */
export function effectiveStatus(session: Pick<Session, 'status' | 'lastActivityAt'>, nowMs: number): EffectiveSessionStatus {
  if (session.status === 'running' && nowMs - Date.parse(session.lastActivityAt) > STALE_AFTER_MS) return 'stale';
  return session.status;
}
