/**
 * The page a location hash names. Kept apart from App.tsx so that tests (and anything else that only needs the route)
 * do not load the whole application.
 */
export type Route =
  | { page: 'home'; projectId: string | null }
  /**
   * `filePath`: `#/s/<id>/f/<path>` opens the session's file panel at that file; `nodeId`: `#/s/<id>/n/<nodeId>` opens
   * the session with that node selected and brought into view. Both are absent on the plain session route, and a route
   * carries at most one of them.
   */
  | { page: 'session'; sessionId: string; filePath?: string; nodeId?: string }
  | { page: 'diagnostics' }
  | { page: 'notifications' }
  | { page: 'stats' }
  | { page: 'files' }
  /** `query`: what follows `#/anomalies?` (the page's filter, see anomalies.ts parseAnomaliesQuery); '' when none. */
  | { page: 'anomalies'; query: string };

const FILE_SEGMENT = '/f/';
const NODE_SEGMENT = '/n/';

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
  if (h === '/anomalies') return { page: 'anomalies', query: '' };
  if (h.startsWith('/anomalies?')) return { page: 'anomalies', query: h.slice('/anomalies?'.length) };
  if (h.startsWith('/s/')) {
    const rest = h.slice(3);
    // The id is encoded (no literal '/'), so the first '/f/' or '/n/' starts the file or node part (whichever comes
    // first wins; the rest is that part's value). A part that cannot be decoded (or is empty) falls back to the plain
    // session route.
    const f = rest.indexOf(FILE_SEGMENT);
    const n = rest.indexOf(NODE_SEGMENT);
    const cut = f < 0 ? n : n < 0 ? f : Math.min(f, n);
    if (cut > 0) {
      const id = decode(rest.slice(0, cut));
      if (id) {
        const isFile = cut === f;
        const value = decode(rest.slice(cut + (isFile ? FILE_SEGMENT : NODE_SEGMENT).length));
        if (!value) return { page: 'session', sessionId: id };
        return isFile ? { page: 'session', sessionId: id, filePath: value } : { page: 'session', sessionId: id, nodeId: value };
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

/** The session page with `nodeId` selected and brought into view (parseHash gives back the same id and node id). */
export function sessionNodeHash(sessionId: string, nodeId: string): string {
  return `${sessionHash(sessionId)}${NODE_SEGMENT}${encodeURIComponent(nodeId)}`;
}
