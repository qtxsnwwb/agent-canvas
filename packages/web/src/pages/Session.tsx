import { useEffect, useMemo, useReducer, useState } from 'react';
import { openLiveSession, type LiveSession } from '../client';
import { ExportDialog } from '../canvas/ExportDialog';
import type { TurnChoice } from '../export';
import { liveSource } from '../liveSource';
import { sessionStatusView } from '../labels';
import { useMask } from '../MaskContext';
import { createMaskedSource } from '../masking';
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
  // The masking switch (spec 5): one numbered masker per session; with the switch on, everything the page shows comes
  // through the masked source (the info bar included). Rebuilt when the switch or the custom terms change.
  const mask = useMask();
  const masker = mask.forSession(sessionId);
  // One source per live session and masker (its functions are stable: the panels refetch when they change).
  const source = useMemo(() => (live === null ? null : createMaskedSource(liveSource(live), masker)), [live, masker]);
  const [turn, setTurn] = useState<TurnChoice | null>(null);
  const [exportOpen, setExportOpen] = useState(false);

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
  const session = source.getSession();
  const status = sessionStatusView(session, now);
  // A file address from a page with the switch on carries the path masked (see masking.ts); a plain one is masked here
  // like the file panel's paths, so both find the file.
  const shownFilePath = filePath === null ? null : masker.text(filePath);
  return (
    <div className="session-page">
      <div className="session-bar">
        <a href={`#/p/${encodeURIComponent(session.projectId)}`}>← 返回项目</a>
        <h2 title={session.title ?? session.id}>{session.title ?? session.id.slice(0, 8)}</h2>
        <span className={`status status-${status.status}`}>{status.label}</span>
        <OriginBadge origin={session.origin} />
        {session.gitBranch !== null && <span className="muted branch" title={session.gitBranch}>{session.gitBranch}</span>}
        {session.sourceDeleted && <span className="tag">源文件已删除</span>}
        <div className="session-bar-end">
          <button type="button" className="files-toggle export-toggle" aria-haspopup="dialog" onClick={() => setExportOpen(true)}
            title="把这个会话导出成 HTML 或 Markdown 文件（可遮蔽密钥）">导出</button>
          <div className="session-bar-tools" ref={setToolbar} />
        </div>
      </div>
      <SessionCanvas key={session.id} source={source} toolbar={toolbar} filePath={shownFilePath} nodeId={nodeId} onTurnChange={setTurn} />
      {exportOpen && <ExportDialog sessionId={session.id} turn={turn} onClose={() => setExportOpen(false)} />}
    </div>
  );
}
