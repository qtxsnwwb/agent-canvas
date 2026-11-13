import { useEffect, useMemo, useReducer, useState } from 'react';
import { openLiveSession, type LiveSession } from '../client';
import { liveSource } from '../liveSource';
import { sessionStatusView } from '../labels';
import { OriginBadge } from '../OriginBadge';
import { sessionLoadState } from '../sessionLoad';
import { useNow } from '../useNow';
import { SessionCanvas } from './SessionCanvas';

export function SessionPage({ sessionId, filePath = null, nodeId = null }: { sessionId: string; filePath?: string | null; nodeId?: string | null }) {
  const [live, setLive] = useState<LiveSession | null>(null);
  /** The failure of openLiveSession (null while there is none); see sessionLoadState. */
  const [error, setError] = useState<unknown>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  /** The info bar's right-hand slot; the canvas renders its view switch into it (it owns the mode). */
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null);
  const now = useNow();
  // One source per live session (its functions are stable: the panels refetch when they change).
  const source = useMemo(() => (live === null ? null : liveSource(live)), [live]);

  useEffect(() => {
    let alive = true;
    let current: LiveSession | null = null;
    let unsubscribe: (() => void) | null = null;
    openLiveSession(sessionId).then(
      (l) => {
        if (!alive) { l.close(); return; }
        current = l;
        unsubscribe = l.subscribe(rerender); // the info bar shows live session fields
        setLive(l);
      },
      (e: unknown) => { if (alive) setError(e ?? new Error('unknown error')); },
    );
    return () => {
      alive = false;
      unsubscribe?.();
      current?.close();
    };
  }, [sessionId]);

  // The subscription re-renders this page when a resync finds the session gone (live.isGone()).
  const state = sessionLoadState(error, live);
  if (state === 'missing') {
    return (
      <div className="session-missing">
        <p>会话不存在</p>
        <a href="#/">返回首页</a>
      </div>
    );
  }
  if (state === 'error') return <p className="error">加载失败：{String(error)}</p>;
  if (live === null || source === null) return <p className="muted session-loading">加载中…</p>;
  const session = live.getSession();
  const status = sessionStatusView(session, now);
  return (
    <div className="session-page">
      <div className="session-bar">
        <a href={`#/p/${encodeURIComponent(session.projectId)}`}>← 返回项目</a>
        <h2 title={session.title ?? session.id}>{session.title ?? session.id.slice(0, 8)}</h2>
        <span className={`status status-${status.status}`}>{status.label}</span>
        <OriginBadge origin={session.origin} />
        {session.gitBranch !== null && <span className="muted branch" title={session.gitBranch}>{session.gitBranch}</span>}
        {session.sourceDeleted && <span className="tag">源文件已删除</span>}
        <div className="session-bar-end" ref={setToolbar} />
      </div>
      <SessionCanvas key={session.id} source={source} toolbar={toolbar} filePath={filePath} nodeId={nodeId} />
    </div>
  );
}
