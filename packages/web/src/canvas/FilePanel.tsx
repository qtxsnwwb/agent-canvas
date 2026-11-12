import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Origin, SessionFile, SessionFilesResponse } from '@agent-canvas/shared';
import { api } from '../client';
import {
  ACTION_LABEL, CODEX_NOTE, FILES_SCOPE_NOTE, SESSION_FILE_SORTS, SESSION_FILE_VIEW_KEY, findSessionFile, groupTouches,
  parseSessionFileView, serializeSessionFileView, sessionFilesEmpty, splitPath, viewSessionFiles, type FileStep,
  type SessionFileView,
} from '../files';
import { relativeTime } from '../home';
import { NODE_STATUS_LABEL } from '../labels';
import { useNow } from '../useNow';

/** After the session changes, the list is fetched again this long after the last change. */
const REFRESH_MS = 1_500;

function loadView(): SessionFileView {
  try { return parseSessionFileView(window.localStorage.getItem(SESSION_FILE_VIEW_KEY)); } catch { return parseSessionFileView(null); }
}
function saveView(v: SessionFileView): void {
  try { window.localStorage.setItem(SESSION_FILE_VIEW_KEY, serializeSessionFileView(v)); } catch { /* not remembered */ }
}

function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('zh-CN', { hour12: false });
}
function fullTime(iso: string | null): string | undefined {
  if (iso === null) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString('zh-CN', { hour12: false });
}

/** A path: the directory part muted (it gives way first when space runs out), the file name emphasised. */
export function PathLabel({ path, full }: { path: string; full: string }) {
  const { dir, name } = splitPath(path);
  return (
    <span className="file-path" title={full}>
      {dir !== '' && <span className="file-dir">{dir}</span>}
      <span className="file-name">{name}</span>
    </span>
  );
}

/** "写入" / "删除" markers of a file. */
export function ChangeMarks({ created, deleted }: { created: boolean; deleted: boolean }) {
  return (
    <>
      {created && <span className="file-mark file-mark-write" title="新建或整个写入（工具分不清是哪一种）">写入</span>}
      {deleted && <span className="file-mark file-mark-delete" title="被删除过">删除</span>}
    </>
  );
}

function StepRow({ step, picked, onPick }: { step: FileStep; picked: boolean; onPick(nodeId: string): void }) {
  const bad = step.status === 'failed' || step.status === 'denied';
  return (
    <li>
      <button type="button" className={`file-step${picked ? ' is-picked' : ''}`} aria-current={picked ? 'true' : undefined}
        onClick={() => onPick(step.nodeId)} title={`在画布上找到这一步（${fullTime(step.at) ?? step.at}）`}>
        <span className="file-step-actions">
          {step.actions.map((a) => <span key={a} className={`file-act file-act-${a}`}>{ACTION_LABEL[a]}</span>)}
        </span>
        <span className="file-step-tool">{step.toolName ?? '工具'}</span>
        {step.agentId !== null && <span className="file-step-agent">子代理</span>}
        {step.status !== null && step.status !== 'succeeded' && (
          <span className={`file-step-status${bad ? ' is-bad' : ''}`}>{NODE_STATUS_LABEL[step.status] ?? step.status}</span>
        )}
        <span className="file-step-time">{clock(step.at)}</span>
      </button>
    </li>
  );
}

function FileRow({ file, expanded, now, pickedNode, onToggle, onPick, rowRef }: {
  file: SessionFile; expanded: boolean; now: number; pickedNode: string | null;
  onToggle(path: string): void; onPick(nodeId: string): void; rowRef(path: string, el: HTMLLIElement | null): void;
}) {
  const steps = useMemo(() => (expanded ? groupTouches(file.touches) : []), [expanded, file.touches]);
  const stepsId = `file-steps-${encodeURIComponent(file.path)}`;
  return (
    <li className={`file-item${expanded ? ' is-open' : ''}`} ref={(el) => rowRef(file.path, el)}>
      <button type="button" className="file-row" aria-expanded={expanded} aria-controls={expanded ? stepsId : undefined}
        onClick={() => onToggle(file.path)}>
        <span className="file-caret" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <PathLabel path={file.relativePath} full={file.path} />
        <span className="file-counts">
          {file.reads > 0 && <span className="file-count" title={`读了 ${file.reads} 次`}>读 {file.reads}</span>}
          {file.changes > 0 && <span className="file-count file-count-change" title={`改了 ${file.changes} 次（改、写入、删除合计）`}>改 {file.changes}</span>}
          <ChangeMarks created={file.created} deleted={file.deleted} />
        </span>
        <span className="file-when" title={fullTime(file.lastAt)}>{file.lastAt !== null ? relativeTime(file.lastAt, now) : ''}</span>
      </button>
      {expanded && (
        <div id={stepsId}>
          {file.touchesTruncated && <p className="file-note">步骤太多，只列出最近的 {file.touches.length} 步。</p>}
          <ol className="file-steps" aria-label={`${file.relativePath} 的步骤`}>
            {steps.map((s) => <StepRow key={s.nodeId} step={s} picked={s.nodeId === pickedNode} onPick={onPick} />)}
          </ol>
        </div>
      )}
    </li>
  );
}

export interface FilePanelProps {
  sessionId: string;
  origin: Origin;
  /** Notified on every session change: the list is fetched again (debounced). */
  subscribe(fn: () => void): () => void;
  /** Open this file (expanded, scrolled into view); a new `seq` is a new request (the deep link). */
  target: { path: string; seq: number } | null;
  /** The step last picked from the panel (marked). */
  pickedNode: string | null;
  /** A line about the last pick (e.g. it could not be shown and its turn was selected instead). */
  note: string | null;
  onPick(nodeId: string): void;
  onClose(): void;
}

type Load = { data: SessionFilesResponse | null; error: string | null };

/**
 * The session's files (spec 4): one row per file, expandable to its steps; a step selects its node on the canvas.
 * Fetched when opened and again after the session changes; expanded files and the scroll position are kept.
 */
export const FilePanel = memo(function FilePanel({ sessionId, origin, subscribe, target, pickedNode, note, onPick, onClose }: FilePanelProps) {
  const now = useNow(30_000);
  const [load, setLoad] = useState<Load>({ data: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const [view, setViewState] = useState<SessionFileView>(loadView);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [missing, setMissing] = useState<string | null>(null);
  const setView = useCallback((next: SessionFileView) => { saveView(next); setViewState(next); }, []);

  // Fetch now, and again REFRESH_MS after the session last changed (one request at a time).
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let again = false;
    const fetchNow = (): void => {
      if (inFlight) { again = true; return; }
      inFlight = true;
      api.sessionFiles(sessionId).then(
        (data) => { if (alive) setLoad({ data, error: null }); },
        (e: unknown) => { if (alive) setLoad((l) => ({ data: l.data, error: e instanceof Error ? e.message : String(e) })); },
      ).finally(() => {
        inFlight = false;
        if (alive && again) { again = false; fetchNow(); }
      });
    };
    fetchNow();
    const unsubscribe = subscribe(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; if (alive) fetchNow(); }, REFRESH_MS);
    });
    return () => {
      alive = false;
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [sessionId, subscribe, attempt]);

  const files = load.data?.files ?? null;
  const shown = useMemo(() => (files === null ? [] : viewSessionFiles(files, view)), [files, view]);
  const empty = files === null ? null : sessionFilesEmpty(files, view);

  // The deep link's file: expand it, make sure the switch and the filter do not hide it, scroll it into view.
  const rows = useRef(new Map<string, HTMLLIElement>());
  const rowRef = useCallback((path: string, el: HTMLLIElement | null) => {
    if (el === null) rows.current.delete(path); else rows.current.set(path, el);
  }, []);
  const handled = useRef<number | null>(null);
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  useEffect(() => {
    if (target === null || files === null || handled.current === target.seq) return;
    handled.current = target.seq;
    const file = findSessionFile(files, target.path);
    if (file === undefined) { setMissing(target.path); return; }
    setMissing(null);
    if ((view.changedOnly && !file.changed) || view.q !== '') setView({ ...view, changedOnly: view.changedOnly && file.changed, q: '' });
    setExpanded((s) => new Set(s).add(file.path));
    setScrollTo(file.path);
  }, [target, files, view, setView]);
  useLayoutEffect(() => {
    if (scrollTo === null) return;
    const el = rows.current.get(scrollTo);
    if (el === undefined) return;
    el.scrollIntoView({ block: 'start' });
    el.querySelector<HTMLButtonElement>('.file-row')?.focus({ preventScroll: true });
    setScrollTo(null);
  });

  const toggle = useCallback((path: string) => {
    setExpanded((s) => {
      const next = new Set(s);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
  };

  const data = load.data;
  const codex = origin === 'codex';
  return (
    <aside className="cc-drawer file-panel" aria-label="这个会话的文件" onKeyDown={onKeyDown}>
      <div className="file-panel-head">
        <div className="cc-drawer-line">
          <span className="cc-drawer-title">文件</span>
          {data !== null && (
            <span className="file-panel-total">
              共 {data.totals.files} 个{data.totals.changedFiles > 0 ? `，改过 ${data.totals.changedFiles} 个` : ''}
            </span>
          )}
          <button type="button" className="cc-drawer-close" onClick={onClose} aria-label="关闭文件面板">×</button>
        </div>
        <div className="file-controls">
          <label className="file-switch">
            <input type="checkbox" role="switch" className="notify-switch" checked={view.changedOnly}
              onChange={(e) => setView({ ...view, changedOnly: e.target.checked })} />
            只看改过的
          </label>
          <input type="search" className="file-filter" placeholder="按路径过滤" aria-label="按路径过滤" value={view.q}
            maxLength={200} onChange={(e) => setView({ ...view, q: e.target.value })} />
        </div>
        <div className="view-switch file-sort" role="group" aria-label="排序">
          {SESSION_FILE_SORTS.map((o) => (
            <button key={o.value} type="button" aria-pressed={view.sort === o.value} onClick={() => setView({ ...view, sort: o.value })}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
      <div className="file-panel-body">
        {note !== null && <p className="file-note file-note-pick" role="status">{note}</p>}
        {missing !== null && <p className="file-note" role="status">这个会话里没有找到 {missing}。</p>}
        {load.error !== null && (
          <p className="file-error">
            {data === null ? '加载失败' : '刷新失败，下面是上一次的结果'}：{load.error}
            <button type="button" className="file-link-btn" onClick={() => setAttempt((x) => x + 1)}>再试一次</button>
          </p>
        )}
        {data === null && load.error === null && <p className="muted file-state">加载中…</p>}
        {empty === 'none' && (
          <div className="file-empty">
            <p className="file-empty-title">这个会话还没读写过文件</p>
            {codex && <p className="muted">{CODEX_NOTE}</p>}
          </div>
        )}
        {empty === 'readOnly' && (
          <div className="file-empty">
            <p className="file-empty-title">没有改过的文件</p>
            <p className="muted">只读过 {files!.length} 个文件。</p>
            <button type="button" className="file-link-btn" onClick={() => setView({ ...view, changedOnly: false })}>看读过的文件</button>
          </div>
        )}
        {data !== null && data.truncated === true && (
          <p className="file-note file-note-pick" role="status">
            只显示前 {data.files.length} 个文件，共 {data.totalFiles ?? data.totals.files} 个（过滤也只在这些里面找）。
          </p>
        )}
        {empty === 'noMatch' &&<p className="muted file-state">没有符合条件的文件。</p>}
        {shown.length > 0 && (
          <ul className="file-list">
            {shown.map((f) => (
              <FileRow key={f.path} file={f} expanded={expanded.has(f.path)} now={now} pickedNode={pickedNode}
                onToggle={toggle} onPick={onPick} rowRef={rowRef} />
            ))}
          </ul>
        )}
      </div>
      <div className="file-panel-foot">
        <p>{FILES_SCOPE_NOTE}{codex ? CODEX_NOTE : ''}</p>
        {data !== null && data.truncatedNodes > 0 && (
          <p>有 {data.truncatedNodes} 步一次动了 50 个以上的文件，多出的没有算进来。</p>
        )}
      </div>
    </aside>
  );
});
