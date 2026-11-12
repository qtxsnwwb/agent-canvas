/**
 * The page a location hash names. Kept apart from App.tsx so that tests (and anything else that only needs the route)
 * do not load the whole application.
 */
export type Route =
  | { page: 'home'; projectId: string | null }
  | { page: 'session'; sessionId: string }
  | { page: 'diagnostics' }
  | { page: 'notifications' }
  | { page: 'stats' };

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
  if (h.startsWith('/s/')) {
    const id = decode(h.slice(3));
    if (id) return { page: 'session', sessionId: id };
  }
  if (h.startsWith('/p/')) {
    const id = decode(h.slice(3));
    if (id) return { page: 'home', projectId: id };
  }
  return { page: 'home', projectId: null };
}
