import { memo, useCallback, useEffect, useReducer, useState } from 'react';
import { openLiveSession, type LiveSession } from '../client';
import { Canvas } from '../canvas/Canvas';
import { Drawer } from '../canvas/Drawer';
import { useCanvas } from '../canvas/useCanvas';
import { sessionStatusView } from '../labels';
import { useNow } from '../useNow';

function hasKeys(obj: object): boolean {
  for (const _ in obj) return true;
  return false;
}

/**
 * Memoized on `live` alone, so the info bar's per-second and per-update re-renders do not reach React Flow; it
 * re-renders when the canvas snapshot or the selection changes. Every handler passed to Canvas is stable.
 */
const SessionCanvas = memo(function SessionCanvas({ live }: { live: LiveSession }) {
  const canvas = useCanvas(live);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Drop a selection whose node is no longer in the view (its turn was folded, it went into an "earlier" node, a
  // resync removed it): hidden at once, and cleared so the drawer cannot reopen by itself when the node comes back.
  const selected = selectedId !== null && canvas.view.nodes.has(selectedId) ? selectedId : null;
  useEffect(() => {
    if (selectedId !== null && selected === null) setSelectedId(null);
  }, [selectedId, selected]);
  // The selected node is never folded away by later updates (see CanvasModel.setKeepVisible).
  const { setKeepVisible } = canvas;
  useEffect(() => { setKeepVisible(selected); }, [selected, setKeepVisible]);
  // Only graph nodes open the drawer; a vanished node (or a turn summary) leaves selectedNode null and closes it.
  const selectedView = selected !== null ? canvas.view.nodes.get(selected) : undefined;
  const selectedNode = selectedView?.type === 'node' ? selectedView.node : null;
  const closeDrawer = useCallback(() => setSelectedId(null), []);
  // "暂无节点" only when the live graph really has no nodes; "布局中…" while the model is starting or the view has
  // nodes none of which is placed yet.
  const empty = !hasKeys(live.getGraph().nodes);
  const laying = !empty && canvas.layoutError === null
    && (!canvas.ready || (canvas.view.nodes.size > 0 && !hasKeys(canvas.positions)));
  return (
    <>
      {canvas.layoutError !== null && <div className="canvas-error">布局失败，正在自动重试：{canvas.layoutError}</div>}
      <div className={`canvas-area${selectedNode !== null ? ' cc-drawer-open' : ''}`}>
        <Canvas
          snapshot={canvas}
          selectedId={selected}
          onSelect={setSelectedId}
          onToggleTurn={canvas.toggleTurn}
          onShowFullTurn={canvas.showFullTurn}
          onFollowingChange={canvas.setAutoFold}
        />
        {selectedNode !== null && <Drawer sessionId={live.getSession().id} node={selectedNode} onClose={closeDrawer} />}
        {empty && <div className="canvas-empty muted">暂无节点</div>}
        {laying && <div className="canvas-empty muted">布局中…</div>}
      </div>
    </>
  );
});

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
      <SessionCanvas key={session.id} live={live} />
    </div>
  );
}
