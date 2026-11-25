/**
 * The 对比 picker (compare spec 3): a modal dialog listing the current session's project's other sessions (the home
 * page's project sessions API), newest activity first, filtered by title; with 「在所有项目里找」 the box's text (at
 * least 2 characters) goes to the search endpoint and its session hits are listed. A row is a link to
 * `#/compare/<current>/<chosen>`. App only (it calls the API): the session page's 「对比…」 and the compare page's 「换一个」
 * open it; the exported viewer never does.
 */
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { Session } from '@agent-canvas/shared';
import { api } from './client';
import { ALL_PROJECTS_TEXT, isPlainClick, pickerList, type PickerList } from './compare';
import { useMask } from './MaskContext';
import { OriginBadge } from './OriginBadge';
import { createSearcher, type SearchResult } from './search';
import { useNow } from './useNow';

function fullTime(iso: string): string | undefined {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString('zh-CN', { hour12: false });
}

export interface ComparePickerViewProps {
  query: string;
  allProjects: boolean;
  list: PickerList;
  onQuery(q: string): void;
  onAllProjects(on: boolean): void;
  onClose(): void;
  dialogRef?: RefObject<HTMLDialogElement>;
  inputRef?: RefObject<HTMLInputElement>;
}

/** The dialog as rendered from its state (no fetching: ComparePicker below does that). */
export function ComparePickerView({ query, allProjects, list, onQuery, onAllProjects, onClose, dialogRef, inputRef }: ComparePickerViewProps) {
  const ids = useId();
  return (
    // The native modal dialog: the page behind is inert (focus stays inside), Esc fires `cancel`.
    <dialog ref={dialogRef} className="export-dialog compare-picker" aria-labelledby={`${ids}-title`}
      onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <div className="export-head">
        <h2 id={`${ids}-title`}>和哪个会话对比？</h2>
        <button type="button" className="export-close" aria-label="关闭" onClick={onClose}>×</button>
      </div>
      <div className="compare-picker-controls">
        <input ref={inputRef} type="text" className="bookmarks-filter compare-picker-filter" value={query}
          placeholder={allProjects ? '输入至少 2 个字：标题、分支、目录…' : '按标题筛选'}
          aria-label={allProjects ? '在所有项目里找会话' : '按标题筛选会话'} aria-controls={`${ids}-list`}
          onChange={(e) => onQuery(e.target.value)} />
        <label className="compare-picker-all">
          <input type="checkbox" checked={allProjects} onChange={(e) => onAllProjects(e.target.checked)} />
          {ALL_PROJECTS_TEXT}
        </label>
      </div>
      <div className="compare-picker-body" id={`${ids}-list`} aria-live="polite">
        {list.state === 'loading' ? (
          <p className="muted compare-picker-note">加载中…</p>
        ) : list.state === 'message' ? (
          <p className="muted compare-picker-note">{list.text}</p>
        ) : (
          <ul className="compare-picker-list">
            {list.rows.map((r) => (
              <li key={r.id}>
                {/* A plain left click navigates here and closes; one opening another tab or window leaves it open. */}
                <a className="compare-picker-row" href={r.href} onClick={(e) => { if (isPlainClick(e)) onClose(); }}>
                  <span className="compare-picker-title">{r.title}</span>
                  <span className="compare-picker-meta">
                    <OriginBadge origin={r.origin} />
                    {r.project !== null && <span className="chip">📁 {r.project}</span>}
                    <span className="muted" title={fullTime(r.at)}>{r.time}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </dialog>
  );
}

/**
 * The picker for `currentId` (the left side): `projectId` its project (null when unknown: the all-projects search
 * only); `otherId` the session already on the right (the compare page's 换一个), not offered again. Opens as a modal
 * with the focus in the filter box; Escape or × closes it and the focus goes back where it was.
 */
export function ComparePicker({ currentId, projectId, otherId = null, onClose }: {
  currentId: string; projectId: string | null; otherId?: string | null; onClose(): void;
}) {
  const { list: m } = useMask();
  const now = useNow();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const d = dialogRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (d !== null && !d.open) d.showModal();
    inputRef.current?.focus();
    return () => {
      if (d?.open) d.close();
      if (previous !== null && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  const [sessions, setSessions] = useState<Session[] | null | 'failed'>(null);
  useEffect(() => {
    if (projectId === null) return;
    let alive = true;
    api.sessions(projectId).then((s) => { if (alive) setSessions(s); }, () => { if (alive) setSessions('failed'); });
    return () => { alive = false; };
  }, [projectId]);

  const [query, setQuery] = useState('');
  const [allProjects, setAllProjects] = useState(projectId === null);
  const [search, setSearch] = useState<SearchResult | null>(null);
  const searcher = useRef<ReturnType<typeof createSearcher> | null>(null);
  useEffect(() => {
    const s = createSearcher({ search: api.search, onResult: setSearch });
    searcher.current = s;
    return () => { s.dispose(); searcher.current = null; };
  }, []);
  const onQuery = (q: string): void => {
    setQuery(q);
    if (allProjects) searcher.current?.query(q);
  };
  const onAllProjects = (on: boolean): void => {
    setAllProjects(on);
    if (on) searcher.current?.query(query);
    inputRef.current?.focus();
  };
  const list = pickerList({ allProjects, query, currentId, projectId, otherId, sessions, search, m, nowMs: now });
  return (
    <ComparePickerView query={query} allProjects={allProjects} list={list} onQuery={onQuery} onAllProjects={onAllProjects}
      onClose={onClose} dialogRef={dialogRef} inputRef={inputRef} />
  );
}
