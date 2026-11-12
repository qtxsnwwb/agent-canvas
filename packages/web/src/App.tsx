import { useEffect, useState } from 'react';
import { api } from './client';
import { Diagnostics } from './pages/Diagnostics';
import { Notifications } from './pages/Notifications';
import { Home } from './pages/Home';
import { SessionPage } from './pages/Session';
import { Stats } from './pages/Stats';
import { parseHash, type Route } from './route';

export { parseHash, type Route } from './route';

export function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  useEffect(() => {
    const onHash = (): void => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Only the header's small "on" marker depends on it; the settings page reports changes, a failed load shows no marker.
  const [notifyOn, setNotifyOn] = useState(false);
  useEffect(() => {
    let live = true;
    api.notificationSettings().then((r) => { if (live) setNotifyOn(r.settings.enabled); }, () => {});
    return () => { live = false; };
  }, []);

  return (
    <div className="app">
      <header>
        <a href="#/">Agent Canvas</a>
        <a className="header-link" href="#/stats" aria-current={route.page === 'stats' ? 'page' : undefined}>统计</a>
        <a className="header-link header-link-next" href="#/notifications" aria-current={route.page === 'notifications' ? 'page' : undefined}>
          通知{notifyOn && <span className="header-dot" role="img" aria-label="已开启" title="通知已开启" />}
        </a>
        <a className="header-link header-link-next" href="#/diagnostics">诊断</a>
      </header>
      {route.page === 'session' ? (
        <SessionPage key={route.sessionId} sessionId={route.sessionId} />
      ) : route.page === 'diagnostics' ? (
        <Diagnostics />
      ) : route.page === 'stats' ? (
        <Stats />
      ) : route.page === 'notifications' ? (
        <Notifications onEnabledChange={setNotifyOn} />
      ) : (
        <Home projectId={route.projectId} />
      )}
    </div>
  );
}
