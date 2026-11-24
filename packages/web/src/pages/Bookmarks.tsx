import { useEffect, useMemo, useReducer, useState, type KeyboardEvent } from 'react';
import {
  BOOKMARKS_EMPTY_TEXT, BOOKMARK_FILTER_PLACEHOLDER, bookmarkRows, bookmarksTitle, createBookmarkPageController, filterBookmarkRows,
  type BookmarkEditing, type BookmarkRowView,
} from '../bookmarks';
import { api, openLiveBookmarks, type BookmarksLiveState } from '../client';
import { useMask } from '../MaskContext';
import { dismissClick } from './Attention';

function fullTime(iso: string): string | undefined {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString('zh-CN', { hour12: false });
}

export interface BookmarksViewProps {
  /** The rows shown (filtered). */
  rows: BookmarkRowView[];
  /** All bookmarks (the title's count; 0: the empty state). */
  total: number;
  /** No list yet. */
  loading: boolean;
  /** The last fetch failed (it is retried). */
  failed: boolean;
  query: string;
  onQuery(q: string): void;
  editing: BookmarkEditing | null;
  toast: { id: number } | null;
  /** A delete or undo that failed. */
  error: string | null;
  /** A notice for this page (a bookmark whose session is gone). */
  notice: string | null;
  onDismissNotice?(): void;
  /** A row was clicked (a link also navigates by itself). */
  onOpen(row: BookmarkRowView): void;
  onEdit(row: BookmarkRowView): void;
  onDraft(text: string): void;
  onCommit(): void;
  onCancel(): void;
  onDelete(row: BookmarkRowView): void;
  onUndo(): void;
}

/** The note box: Enter or leaving it saves, Escape cancels (not while an input method is composing). */
function NoteEditor({ editing, onDraft, onCommit, onCancel }: Pick<BookmarksViewProps, 'onDraft' | 'onCommit' | 'onCancel'> & { editing: BookmarkEditing }) {
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); onCommit(); }
    else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  };
  return (
    // autoFocus: the box appears because the user asked to edit the note.
    <input className="bookmark-note-input" aria-label="备注" placeholder="写一句备注（可不填），回车保存" autoFocus value={editing.draft}
      readOnly={editing.saving} aria-invalid={editing.error !== null ? true : undefined}
      onChange={(e) => onDraft(e.target.value)} onKeyDown={onKeyDown} onBlur={() => onCommit()} />
  );
}

/** One row: kind, note, time; the step's label and what is missing; project · origin · “title”. */
function BookmarkRow(props: BookmarksViewProps & { row: BookmarkRowView }) {
  const { row, editing, onOpen, onEdit, onDelete } = props;
  const mine = editing !== null && editing.id === row.id ? editing : null;
  const body = (
    <>
      <span className="bookmark-line">
        <span className="bookmark-star" aria-hidden="true">★</span>
        <span className={`bookmark-kind bookmark-kind-${row.kind}`}>{row.kindLabel}</span>
        {mine !== null ? <NoteEditor {...props} editing={mine} /> : (
          <span className={row.hasNote ? 'bookmark-note' : 'bookmark-note is-empty'}>{row.noteText}</span>
        )}
        <span className="bookmark-time" title={fullTime(row.createdAt)}>{row.time}</span>
      </span>
      {(row.stepLabel !== null || row.badge !== null) && (
        <span className="bookmark-sub">
          {row.stepLabel !== null && <span className="bookmark-step">{row.stepLabel}</span>}
          {row.badge !== null && <span className="bookmark-badge">⚠ {row.badge}</span>}
        </span>
      )}
      <span className="bookmark-meta">
        <span title={row.cwd ?? undefined}>{`${row.project} · ${row.originLabel} · “${row.title}”`}</span>
        {row.sourceDeleted && <span className="tag">源文件已删除</span>}
      </span>
    </>
  );
  return (
    <li className="bookmark-row">
      {mine !== null ? (
        <div className="bookmark-link is-editing">{body}</div>
      ) : row.open.kind === 'missing-session' ? (
        <button type="button" className="bookmark-link" onClick={() => onOpen(row)}>{body}</button>
      ) : (
        <a className="bookmark-link" href={row.open.href}
          onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) onOpen(row); }}>{body}</a>
      )}
      <span className="bookmark-actions">
        <button type="button" className="attention-btn" disabled={mine !== null} onClick={dismissClick(() => onEdit(row))}>改备注</button>
        <button type="button" className="attention-btn" onClick={dismissClick(() => onDelete(row))}>删除</button>
      </span>
      {mine?.error != null && <p className="notify-field-error bookmark-error" role="alert">{mine.error}</p>}
    </li>
  );
}

/** The page as rendered from its state (no fetching: Bookmarks below does that). */
export function BookmarksView(props: BookmarksViewProps) {
  const { rows, total, loading, failed, query, onQuery, toast, error, notice, onDismissNotice, onUndo } = props;
  return (
    <div className="stats bookmarks-page">
      <div className="stats-head bookmarks-head">
        <div>
          <h1>{loading ? '书签' : bookmarksTitle(total)}</h1>
          <p className="muted">收藏的会话和步骤，新的在前。点一行打开会话，定位到那一步。</p>
        </div>
        <input type="search" className="bookmarks-filter" placeholder={BOOKMARK_FILTER_PLACEHOLDER} aria-label="筛选书签"
          value={query} onChange={(e) => onQuery(e.target.value)} />
      </div>
      {failed && (
        <p className="error stats-state" role="status">
          {loading ? '书签没能加载出来，正在重试…' : '书签没能刷新，正在重试；下面是上一次的结果。'}
        </p>
      )}
      {notice !== null && (
        <p className="bookmarks-notice" role="status">
          <span>{notice}</span>
          {onDismissNotice !== undefined && <button type="button" aria-label="关闭提示" onClick={onDismissNotice}>×</button>}
        </p>
      )}
      {error !== null && <p className="error stats-state" role="alert">{error}</p>}
      {loading ? (
        !failed && <p className="muted stats-state">加载中…</p>
      ) : total === 0 ? (
        <section className="stats-empty">
          <p className="muted">{BOOKMARKS_EMPTY_TEXT}</p>
        </section>
      ) : rows.length === 0 ? (
        <p className="muted stats-state">没有符合筛选的书签</p>
      ) : (
        <section className="files-card bookmarks-card" aria-label="书签列表">
          <ul className="bookmarks-items">
            {rows.map((row) => <BookmarkRow key={row.id} {...props} row={row} />)}
          </ul>
        </section>
      )}
      {toast !== null && (
        <div className="bookmarks-toast" role="status">
          <span>已删除书签</span>
          <button type="button" className="attention-btn" onClick={onUndo}>撤销</button>
        </div>
      )}
    </div>
  );
}

/**
 * `#/bookmarks` (bookmarks spec 4): every bookmark, live (refetched on each `bookmarks` push). `onStepGone`: a bookmark
 * whose step is gone was clicked; its link opens the session, which then shows `text` once (App.tsx).
 */
export function Bookmarks({ onStepGone }: { onStepGone(sessionId: string, text: string): void }) {
  const { list: m } = useMask();
  const [live, setLive] = useState<BookmarksLiveState>({ bookmarks: null, failed: false });
  useEffect(() => {
    const l = openLiveBookmarks(setLive);
    return () => l.close();
  }, []);
  const [ctrl] = useState(() => createBookmarkPageController(api));
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const unsubscribe = ctrl.subscribe(rerender);
    return () => { unsubscribe(); ctrl.close(); };
  }, [ctrl]);
  useEffect(() => { if (live.bookmarks !== null) ctrl.listChanged(live.bookmarks); }, [ctrl, live.bookmarks]);
  const page = ctrl.state();
  // Rebuilt when the list or what the page's writes change in it does, not on every keystroke in a note box.
  const revision = ctrl.revision();
  const shown = useMemo(
    () => (live.bookmarks === null ? null : ctrl.visible(live.bookmarks)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revision stands for the controller's hidden rows and saved notes
    [ctrl, live.bookmarks, revision],
  );
  const rows = useMemo(() => (shown === null ? [] : bookmarkRows(shown, m)), [shown, m]);
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => filterBookmarkRows(rows, query), [rows, query]);
  const [notice, setNotice] = useState<string | null>(null);
  const onOpen = (row: BookmarkRowView): void => {
    if (row.open.kind === 'missing-session') setNotice(row.open.notice);
    else if (row.open.kind === 'missing-step') onStepGone(row.sessionId, row.open.notice);
  };
  return (
    <BookmarksView
      rows={filtered} total={rows.length} loading={shown === null} failed={live.failed} query={query} onQuery={setQuery}
      editing={page.editing} toast={page.toast} error={page.error} notice={notice} onDismissNotice={() => setNotice(null)}
      onOpen={onOpen} onEdit={(row) => ctrl.startEdit(row.id, row.note)} onDraft={(t) => ctrl.setDraft(t)}
      onCommit={() => void ctrl.commitEdit()} onCancel={() => ctrl.cancelEdit()} onDelete={(row) => void ctrl.remove(row.id)}
      onUndo={() => void ctrl.undo()}
    />
  );
}
