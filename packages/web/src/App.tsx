import { useEffect, useState } from 'react';
import { Diagnostics } from './pages/Diagnostics';
import { Home } from './pages/Home';
import { SessionPage } from './pages/Session';

export type Route =
  | { page: 'home'; projectId: string | null }
  | { page: 'session'; sessionId: string }
  | { page: 'diagnostics' };

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

export function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  useEffect(() => {
    const onHash = (): void => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <div className="app">
      <header>
        <a href="#/">Agent Canvas</a>
        <a className="header-link" href="#/diagnostics">诊断</a>
      </header>
      {route.page === 'session' ? (
        <SessionPage key={route.sessionId} sessionId={route.sessionId} />
      ) : route.page === 'diagnostics' ? (
        <Diagnostics />
      ) : (
        <Home projectId={route.projectId} />
      )}
    </div>
  );
}
