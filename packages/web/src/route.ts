/**
 * The page a location hash names. Kept apart from App.tsx so that tests (and anything else that only needs the route)
 * do not load the whole application.
 */
export type Route =
  | { page: 'home'; projectId: string | null }
  /** `filePath`: `#/s/<id>/f/<path>` opens the session's file panel at that file (absent on the plain session route). */
  | { page: 'session'; sessionId: string; filePath?: string }
  | { page: 'diagnostics' }
  | { page: 'notifications' }
  | { page: 'stats' }
  | { page: 'files' };

const FILE_SEGMENT = '/f/';

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#/, '');
  const decode = (s: string): string | null => {
    try {
      return decodeURIComponent(s);
    } catch {
      return null;
    }
  };
  if (h === '/diagnostics') return { page: 'diagnostics' };
  if (h === '/notifications') return { page: 'notifications' };
  if (h === '/stats') return { page: 'stats' };
  if (h === '/files') return { page: 'files' };
  if (h.startsWith('/s/')) {
    const rest = h.slice(3);
    // The id is encoded (no literal '/'), so the first '/f/' starts the file part. A file part that cannot be decoded
    // (or is empty) falls back to the plain session route.
    const cut = rest.indexOf(FILE_SEGMENT);
    if (cut > 0) {
      const id = decode(rest.slice(0, cut));
      if (id) {
        const filePath = decode(rest.slice(cut + FILE_SEGMENT.length));
        return filePath ? { page: 'session', sessionId: id, filePath } : { page: 'session', sessionId: id };
      }
    } else {
      const id = decode(rest);
      if (id) return { page: 'session', sessionId: id };
    }
  }
  if (h.startsWith('/p/')) {
    const id = decode(h.slice(3));
    if (id) return { page: 'home', projectId: id };
  }
  return { page: 'home', projectId: null };
}

/** The session page. */
export function sessionHash(sessionId: string): string {
  return `#/s/${encodeURIComponent(sessionId)}`;
}

/** The session page with its file panel open at `path` (parseHash gives back the same id and path). */
export function sessionFileHash(sessionId: string, path: string): string {
  return `${sessionHash(sessionId)}${FILE_SEGMENT}${encodeURIComponent(path)}`;
}
