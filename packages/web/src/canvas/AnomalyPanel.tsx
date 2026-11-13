import { memo, useCallback, useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { SessionAnomaliesResponse } from '@agent-canvas/shared';
import {
  ANOMALY_COMPUTING_NOTE, ANOMALY_EMPTY_SESSION, ANOMALY_HEURISTIC_NOTE, ANOMALY_POLL_MS, ANOMALY_REFRESH_MS, surfaceState,
  type PanelRow,
} from '../anomalies';
import { api } from '../client';
import { relativeTime } from '../home';
import { createThrottle } from '../throttle';
import { useNow } from '../useNow';
import { PathLabel } from './FilePanel';

export interface AnomalyLoad {
  data: SessionAnomaliesResponse | null;
  error: string | null;
  /** Fetch again now (the panel's 再试一次, or the panel being opened). */
  reload(): void;
}

/**
 * The session's anomalies, for the toolbar button, the card markers and the panel: fetched now, again (throttled) while
 * the session changes, and every ANOMALY_POLL_MS while the answer says `computing`. One request at a time.
 */
export function useSessionAnomalies(sessionId: string, subscribe: (fn: () => void) => () => void): AnomalyLoad {
  const [load, setLoad] = useState<{ data: SessionAnomaliesResponse | null; error: string | null }>({ data: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    let inFlight = false;
    let again = false;
    let poll: ReturnType<typeof setTimeout> | null = null;
    const fetchNow = (): void => {
      if (inFlight) { again = true; return; }
      inFlight = true;
      if (poll !== null) { clearTimeout(poll); poll = null; }
      api.sessionAnomalies(sessionId).then(
        (data) => {
          if (!alive) return;
          setLoad({ data, error: null });
          if (data.computing) poll = setTimeout(fetchNow, ANOMALY_POLL_MS);
        },
        (e: unknown) => { if (alive) setLoad((l) => ({ data: l.data, error: e instanceof Error ? e.message : String(e) })); },
      ).finally(() => {
        inFlight = false;
        if (alive && again) { again = false; fetchNow(); }
      });
    };
    fetchNow();
    const refresh = createThrottle(() => { if (alive) fetchNow(); }, ANOMALY_REFRESH_MS);
    const unsubscribe = subscribe(refresh.trigger);
    return () => {
      alive = false;
      unsubscribe();
      refresh.cancel();
      if (poll !== null) clearTimeout(poll);
    };
  }, [sessionId, subscribe, attempt]);
  const reload = useCallback(() => setAttempt((x) => x + 1), []);
  return useMemo(() => ({ data: load.data, error: load.error, reload }), [load, reload]);
}

function fullTime(iso: string): string | undefined {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString('zh-CN', { hour12: false });
}

function Row({ row, now, picked, onPick }: { row: PanelRow; now: number; picked: boolean; onPick(nodeId: string, href: string): void }) {
  // A real link (it can be opened in a new tab or copied); a plain click also works when the address is already this one.
  const onClick = (e: MouseEvent<HTMLAnchorElement>): void => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    onPick(row.nodeId, row.href);
  };
  return (
    <li>
      <a className={`anomaly-row${picked ? ' is-picked' : ''}`} href={row.href} aria-current={picked ? 'true' : undefined}
        onClick={onClick} title="在画布上找到这一步">
        <span className="anomaly-row-head">
          <span className={`anomaly-kind anomaly-kind-${row.kind}`}>{row.kindLabel}</span>
          <span className="anomaly-row-time" title={fullTime(row.at)}>{relativeTime(row.at, now)}</span>
        </span>
        <span className="anomaly-row-basis">{row.basis}</span>
        {row.path !== null && <span className="anomaly-row-path"><PathLabel path={row.path.shown} full={row.path.full} /></span>}
        {(row.turnText !== null || row.agentText !== null) && (
          <span className="anomaly-row-where">
            {row.turnText ?? '所在轮次不明'}
            {row.agentText !== null && <span className="anomaly-row-agent">{row.agentText}</span>}
          </span>
        )}
      </a>
    </li>
  );
}

export interface AnomalyPanelProps {
  load: AnomalyLoad;
  /** null until the first answer (see panelRows). */
  rows: PanelRow[] | null;
  /** The node last asked for (the address's node): its row is marked. */
  pickedNode: string | null;
  onPick(nodeId: string, href: string): void;
  onClose(): void;
}

/** The session's anomalies (spec 6): one row per anomaly; a row is a link to its last node, which it selects and locates. */
export const AnomalyPanel = memo(function AnomalyPanel({ load, rows, pickedNode, onPick, onClose }: AnomalyPanelProps) {
  const now = useNow(30_000);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
  };
  const state = surfaceState(rows, load.error, (r) => r.length === 0);
  return (
    <aside className="cc-drawer file-panel anomaly-panel" aria-labelledby="anomaly-panel-title" onKeyDown={onKeyDown}>
      <div className="file-panel-head anomaly-panel-head">
        <div className="cc-drawer-line">
          <h2 id="anomaly-panel-title" className="cc-drawer-title">异常</h2>
          {rows !== null && rows.length > 0 && <span className="file-panel-total">共 {rows.length} 条</span>}
          <button type="button" className="cc-drawer-close" onClick={onClose} aria-label="关闭异常面板">×</button>
        </div>
      </div>
      <div className="file-panel-body">
        {load.error !== null && (
          <p className="file-error">
            {state === 'error' ? '加载失败' : '刷新失败，下面是上一次的结果'}：{load.error}
            <button type="button" className="file-link-btn" onClick={load.reload}>再试一次</button>
          </p>
        )}
        {load.data?.computing === true && <p className="file-note file-note-pick" role="status">{ANOMALY_COMPUTING_NOTE}</p>}
        {state === 'loading' && <p className="muted file-state">加载中…</p>}
        {state === 'empty' && (
          <div className="file-empty">
            <p className="file-empty-title">{ANOMALY_EMPTY_SESSION}</p>
          </div>
        )}
        {rows !== null && rows.length > 0 && (
          <ul className="anomaly-list">
            {rows.map((r) => <Row key={r.key} row={r} now={now} picked={r.nodeId === pickedNode} onPick={onPick} />)}
          </ul>
        )}
      </div>
      <div className="file-panel-foot">
        <p>{ANOMALY_HEURISTIC_NOTE}点一条在画布上定位到相关的那一步。</p>
      </div>
    </aside>
  );
});
