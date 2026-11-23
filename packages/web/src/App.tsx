import { useEffect, useRef, useState } from 'react';
import type { AttentionResponse } from '@agent-canvas/shared';
import { headerCount } from './attention';
import { api, openLiveAttention, type AttentionLiveState } from './client';
import { MaskProvider, MaskSwitch, useMask } from './MaskContext';
import { Anomalies } from './pages/Anomalies';
import { Attention } from './pages/Attention';
import { Diagnostics } from './pages/Diagnostics';
import { Files } from './pages/Files';
import { Notifications } from './pages/Notifications';
import { Home } from './pages/Home';
import { SessionPage } from './pages/Session';
import { Stats } from './pages/Stats';
import { parseHash, type Route } from './route';

export { parseHash, type Route } from './route';

export function App() {
  return (
    <MaskProvider>
      <AppBody />
    </MaskProvider>
  );
}

function AppBody() {
  const mask = useMask();
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

  // The attention state, live on every page (the header's count) over the app's one sessions-scope subscription, which
  // the home page's session list shares; the attention page renders it and hands its writes' answers back.
  const [attention, setAttention] = useState<AttentionLiveState>({ response: null, problem: null });
  const attentionLive = useRef<ReturnType<typeof openLiveAttention> | null>(null);
  useEffect(() => {
    const live = openLiveAttention(setAttention);
    attentionLive.current = live;
    return () => { attentionLive.current = null; live.close(); };
  }, []);
  const acceptAttention = (r: AttentionResponse): void => attentionLive.current?.accept(r);
  const waiting = headerCount(attention.response);

  return (
    <div className="app">
      <header>
        <a href="#/">Agent Canvas</a>
        <a className="header-link" href="#/attention" aria-current={route.page === 'attention' ? 'page' : undefined}
          aria-label={waiting === null ? '待处理' : `待处理，${waiting} 个会话在等你`}>
          待处理{waiting !== null && <span className="header-count" aria-hidden="true">{waiting}</span>}
        </a>
        <a className="header-link header-link-next" href="#/stats" aria-current={route.page === 'stats' ? 'page' : undefined}>统计</a>
        <a className="header-link header-link-next" href="#/files" aria-current={route.page === 'files' ? 'page' : undefined}>文件</a>
        <a className="header-link header-link-next" href="#/anomalies" aria-current={route.page === 'anomalies' ? 'page' : undefined}>异常</a>
        <a className="header-link header-link-next" href="#/notifications" aria-current={route.page === 'notifications' ? 'page' : undefined}>
          通知{notifyOn && <span className="header-dot" role="img" aria-label="已开启" title="通知已开启" />}
        </a>
        <a className="header-link header-link-next" href="#/diagnostics">诊断</a>
        <MaskSwitch />
      </header>
      {!mask.ready ? (
        <p className="muted session-loading">加载中…</p>
      ) : route.page === 'session' ? (
        <SessionPage key={route.sessionId} sessionId={route.sessionId} filePath={route.filePath ?? null} nodeId={route.nodeId ?? null} />
      ) : route.page === 'diagnostics' ? (
        <Diagnostics />
      ) : route.page === 'stats' ? (
        <Stats />
      ) : route.page === 'files' ? (
        <Files />
      ) : route.page === 'anomalies' ? (
        <Anomalies query={route.query} />
      ) : route.page === 'attention' ? (
        <Attention live={attention} onResponse={acceptAttention} />
      ) : route.page === 'notifications' ? (
        <Notifications onEnabledChange={setNotifyOn} />
      ) : (
        <Home projectId={route.projectId} />
      )}
    </div>
  );
}
