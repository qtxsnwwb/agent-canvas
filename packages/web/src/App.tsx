import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { headerCount } from './attention';
import { api, openLiveAttention, openLiveToday, type AttentionLiveState, type LiveAttention, type LiveToday, type TodayLiveState } from './client';
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
import { TodayHeaderLink } from './TodayHeaderLink';

export { parseHash, type Route } from './route';

/** A layout effect in the browser; a plain one when rendered on the server (tests), which has no layout to measure. */
const useClientLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

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
  // the home page's session list shares; the attention page renders it and runs its writes through it.
  const [attention, setAttention] = useState<AttentionLiveState>({ response: null, problem: null });
  const attentionLive = useRef<LiveAttention | null>(null);
  useEffect(() => {
    const live = openLiveAttention(setAttention);
    attentionLive.current = live;
    return () => { attentionLive.current = null; live.close(); };
  }, []);
  // Stable for the page's effects; without the live state (not opened yet, or closed) a write's answer is not applied.
  const attentionActions = useMemo<Pick<LiveAttention, 'write' | 'hidden'>>(() => ({
    write: (call) => attentionLive.current?.write(call) ?? call().then(() => {}),
    hidden: () => attentionLive.current?.hidden() ?? api.attention(true).then((r) => r.hidden),
  }), []);
  const waiting = headerCount(attention.response);

  // Today's usage, live on every page (the header's 今天 and the stats page's block) over the same subscription.
  const [today, setToday] = useState<TodayLiveState>({ usage: null, failed: false });
  const todayLive = useRef<LiveToday | null>(null);
  useEffect(() => {
    const live = openLiveToday(setToday);
    todayLive.current = live;
    return () => { todayLive.current = null; live.close(); };
  }, []);
  // The stats page asks for a fresh result when it opens (on a quiet day the server then brings asOf up to date).
  const refreshToday = useMemo(() => () => todayLive.current?.refresh(), []);

  // The header's measured height in --header-real (the session page subtracts it; --header-h until measured): on a
  // phone the links take a third row. Not --header-h itself, which sizes the header (that would never shrink again).
  const headerRef = useRef<HTMLElement>(null);
  useClientLayoutEffect(() => {
    const el = headerRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement;
    const apply = (): void => root.style.setProperty('--header-real', `${el.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el, { box: 'border-box' });
    return () => { ro.disconnect(); root.style.removeProperty('--header-real'); };
  }, []);

  return (
    <div className="app">
      <header ref={headerRef}>
        <a href="#/">Agent Canvas</a>
        <a className="header-link" href="#/attention" aria-current={route.page === 'attention' ? 'page' : undefined}
          aria-label={waiting === null ? '待处理' : `待处理，${waiting} 个会话在等你`}>
          待处理{waiting !== null && <span className="header-count" aria-hidden="true">{waiting}</span>}
        </a>
        <TodayHeaderLink usage={today.usage} />
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
        <Stats today={today} onOpen={refreshToday} />
      ) : route.page === 'files' ? (
        <Files />
      ) : route.page === 'anomalies' ? (
        <Anomalies query={route.query} />
      ) : route.page === 'attention' ? (
        <Attention live={attention} actions={attentionActions} />
      ) : route.page === 'notifications' ? (
        <Notifications onEnabledChange={setNotifyOn} focus={route.focus ?? null} />
      ) : (
        <Home projectId={route.projectId} />
      )}
    </div>
  );
}
