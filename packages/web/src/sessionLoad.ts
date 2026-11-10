/**
 * What the session page shows: 'loading' until the live session opens; 'missing' when opening failed with HTTP 404 or
 * a later resync found the session gone (LiveSession.isGone); 'error' for any other failure; otherwise 'ready'.
 * `error` is null while there is none.
 */
export type SessionLoadState = 'loading' | 'missing' | 'error' | 'ready';

export function sessionLoadState(error: unknown, live: { isGone(): boolean } | null): SessionLoadState {
  if (error !== null) {
    const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined;
    return status === 404 ? 'missing' : 'error';
  }
  if (live === null) return 'loading';
  return live.isGone() ? 'missing' : 'ready';
}
