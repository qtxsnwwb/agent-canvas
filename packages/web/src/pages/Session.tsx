import { useEffect, useReducer, useState } from 'react';
import { openLiveSession, type LiveSession } from '../client';
import { Canvas } from '../canvas/Canvas';
import { useCanvas } from '../canvas/useCanvas';
import { sessionStatusView } from '../labels';
import { useNow } from '../useNow';

function SessionCanvas({ live }: { live: LiveSession }) {
  const canvas = useCanvas(live);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Drop a selection whose node is no longer drawn (e.g. its turn was folded).
  const selected = selectedId !== null && canvas.view.nodes.has(selectedId) ? selectedId : null;
  const empty = canvas.view.nodes.size === 0;
  return (
    <>
      {canvas.layoutError !== null && <div className="canvas-error">布局失败：{canvas.layoutError}</div>}
      <div className="canvas-area">
        <Canvas snapshot={canvas} selectedId={selected} onSelect={setSelectedId} onToggleTurn={canvas.toggleTurn} />
        {empty && <div className="canvas-empty muted">暂无节点</div>}
      </div>
    </>
  );
}

export function SessionPage({ sessionId }: { sessionId: string }) {
  const [live, setLive] = useState<LiveSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const now = useNow();

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
      (e: unknown) => { if (alive) setError(String(e)); },
    );
    return () => {
      alive = false;
      unsubscribe?.();
      current?.close();
    };
  }, [sessionId]);

  if (error !== null) return <p className="error">加载失败：{error}</p>;
  if (live === null) return <p className="muted session-loading">加载中…</p>;
  const session = live.getSession();
  const status = sessionStatusView(session, now);
  return (
    <div className="session-page">
      <div className="session-bar">
        <a href={`#/p/${encodeURIComponent(session.projectId)}`}>← 返回项目</a>
        <h2 title={session.title ?? session.id}>{session.title ?? session.id.slice(0, 8)}</h2>
        <span className={`status status-${status.status}`}>{status.label}</span>
        {session.gitBranch !== null && <span className="muted branch" title={session.gitBranch}>{session.gitBranch}</span>}
        {session.sourceDeleted && <span className="tag">源文件已删除</span>}
      </div>
      <SessionCanvas live={live} />
    </div>
  );
}
