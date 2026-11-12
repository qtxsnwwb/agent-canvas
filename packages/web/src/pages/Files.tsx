import { useCallback, useEffect, useState } from 'react';
import type { Origin, Project, ProjectFile, ProjectFilesResponse } from '@agent-canvas/shared';
import { api } from '../client';
import { ChangeMarks, PathLabel } from '../canvas/FilePanel';
import {
  CODEX_NOTE, DEFAULT_FILES_FILTER, FILES_FILTER_KEY, FILES_RANGE_OPTIONS, FILES_SCOPE_NOTE, FILES_SORT_OPTIONS,
  effectiveFilesFilter, filesQueryString, parseFilesFilter, serializeFilesFilter, type FilesFilter, type FilesOriginFilter,
} from '../files';
import { ORIGIN_LOOK, projectTitle, relativeTime } from '../home';
import { OriginBadge } from '../OriginBadge';
import { sessionFileHash } from '../route';
import { useNow } from '../useNow';

/** The path filter is sent this long after the last keystroke. */
const TYPING_MS = 250;

function loadFilter(): FilesFilter {
  try { return parseFilesFilter(window.localStorage.getItem(FILES_FILTER_KEY)); } catch { return { ...DEFAULT_FILES_FILTER }; }
}
function saveFilter(f: FilesFilter): void {
  try { window.localStorage.setItem(FILES_FILTER_KEY, serializeFilesFilter(f)); } catch { /* not remembered */ }
}
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function fullTime(iso: string | null): string | undefined {
  if (iso === null) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString('zh-CN', { hour12: false });
}

function FilterRow({ filter, qInput, projects, onChange, onQuery }: {
  filter: FilesFilter; qInput: string; projects: Project[]; onChange(f: FilesFilter): void; onQuery(q: string): void;
}) {
  const project = projects.find((p) => p.id === filter.projectId);
  const origins: Origin[] = project?.origins ?? [];
  const originOptions: { value: FilesOriginFilter; label: string }[] = [
    { value: 'all', label: '全部' }, ...origins.map((o) => ({ value: o, label: ORIGIN_LOOK[o].label })),
  ];
  return (
    <div className="stats-filters files-filters">
      <label className="stats-project">
        <span className="visually-hidden">项目</span>
        <select value={filter.projectId ?? ''} onChange={(e) => onChange({ ...filter, projectId: e.target.value, origin: 'all' })}>
          {projects.map((p) => <option key={p.id} value={p.id} title={p.cwd ?? p.id}>{projectTitle(p)}</option>)}
        </select>
      </label>
      {origins.length > 1 && (
        <div className="view-switch" role="group" aria-label="来源">
          {originOptions.map((o) => (
            <button key={o.value} type="button" data-origin={o.value} aria-pressed={filter.origin === o.value}
              onClick={() => onChange({ ...filter, origin: o.value })}>
              {o.label}
            </button>
          ))}
        </div>
      )}
      <div className="view-switch" role="group" aria-label="时间范围">
        {FILES_RANGE_OPTIONS.map((o) => (
          <button key={o.value} type="button" aria-pressed={filter.range === o.value} onClick={() => onChange({ ...filter, range: o.value })}>
            {o.label}
          </button>
        ))}
      </div>
      <label className="file-switch">
        <input type="checkbox" role="switch" className="notify-switch" checked={filter.changedOnly}
          onChange={(e) => onChange({ ...filter, changedOnly: e.target.checked })} />
        只看改过的
      </label>
      <input type="search" className="file-filter files-page-filter" placeholder="按路径过滤" aria-label="按路径过滤"
        value={qInput} maxLength={200} onChange={(e) => onQuery(e.target.value)} />
      <div className="view-switch" role="group" aria-label="排序">
        {FILES_SORT_OPTIONS.map((o) => (
          <button key={o.value} type="button" aria-pressed={filter.sort === o.value} onClick={() => onChange({ ...filter, sort: o.value })}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function FileItem({ file, expanded, now, onToggle }: { file: ProjectFile; expanded: boolean; now: number; onToggle(path: string): void }) {
  const listId = `files-sessions-${encodeURIComponent(file.path)}`;
  return (
    <li className={`file-item files-item${expanded ? ' is-open' : ''}`}>
      <button type="button" className="file-row files-row" aria-expanded={expanded} aria-controls={expanded ? listId : undefined}
        onClick={() => onToggle(file.path)}>
        <span className="file-caret" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <PathLabel path={file.relativePath} full={file.path} />
        <span className="file-counts">
          <span className="file-count" title={`${file.sessionCount} 个会话动过它`}>{file.sessionCount} 个会话</span>
          {file.reads > 0 && <span className="file-count">读 {file.reads}</span>}
          {file.changes > 0 && <span className="file-count file-count-change">改 {file.changes}</span>}
          <ChangeMarks created={file.created} deleted={file.deleted} />
        </span>
        <span className="file-when" title={fullTime(file.lastAt)}>
          {file.lastAt !== null ? relativeTime(file.lastAt, now) : ''}
          {file.lastOrigin !== null && <OriginBadge origin={file.lastOrigin} iconOnly />}
        </span>
      </button>
      {expanded && (
        <div id={listId}>
          <ul className="files-sessions" aria-label={`动过 ${file.relativePath} 的会话`}>
            {file.sessions.map((s) => (
              <li key={s.sessionId}>
                <a className="files-session" href={sessionFileHash(s.sessionId, file.path)} title="在这个会话里看这个文件">
                  <OriginBadge origin={s.origin} />
                  <span className="files-session-title">{s.title ?? s.sessionId.slice(0, 8)}</span>
                  <span className="file-counts">
                    {s.reads > 0 && <span className="file-count">读 {s.reads}</span>}
                    {s.changes > 0 && <span className="file-count file-count-change">改 {s.changes}</span>}
                  </span>
                  <span className="file-when" title={fullTime(s.lastAt)}>{s.lastAt !== null ? relativeTime(s.lastAt, now) : ''}</span>
                </a>
              </li>
            ))}
          </ul>
          {file.sessionsTruncated && (
            <p className="file-note">只列出最近的 {file.sessions.length} 个会话，共 {file.sessionCount} 个。</p>
          )}
        </div>
      )}
    </li>
  );
}

function FilesBody({ data, now, expanded, onToggle }: {
  data: ProjectFilesResponse; now: number; expanded: ReadonlySet<string>; onToggle(path: string): void;
}) {
  if (data.files.length === 0) {
    return (
      <section className="stats-empty">
        <p className="stats-empty-title">没有符合条件的文件</p>
        <p className="muted">换个时间范围、关掉“只看改过的”或者改改过滤框试试。</p>
      </section>
    );
  }
  return (
    <section className="files-card" aria-label="文件">
      <ul className="file-list">
        {data.files.map((f) => <FileItem key={f.path} file={f} expanded={expanded.has(f.path)} now={now} onToggle={onToggle} />)}
      </ul>
      {data.truncated && (
        <p className="stats-note">只显示前 {data.files.length} 个，共 {data.totalFiles} 个，用上面的过滤框缩小范围。</p>
      )}
    </section>
  );
}

type Load = { data: ProjectFilesResponse | null; loading: boolean; error: string | null };

export function Files() {
  const now = useNow(30_000);
  const [chosen, setChosen] = useState<FilesFilter>(loadFilter);
  const [qInput, setQInput] = useState('');
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ data: null, loading: true, error: null });
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    let live = true;
    api.projects().then(
      (p) => { if (live) { setProjects(p); setProjectsError(null); } },
      (e: unknown) => { if (live) setProjectsError(errorText(e)); },
    );
    return () => { live = false; };
  }, [attempt]);

  // The path filter reaches the query TYPING_MS after the last keystroke.
  useEffect(() => {
    const t = setTimeout(() => setChosen((f) => (f.q === qInput ? f : { ...f, q: qInput })), TYPING_MS);
    return () => clearTimeout(t);
  }, [qInput]);

  const filter = effectiveFilesFilter(chosen, projects);
  const query = projects !== null && filter.projectId !== null ? filesQueryString(filter) : null;

  useEffect(() => {
    if (query === null) return;
    let live = true;
    // The previous result stays on screen (dimmed) until the new one arrives.
    setLoad((l) => ({ ...l, loading: true }));
    api.files(query).then(
      (data) => { if (live) setLoad({ data, loading: false, error: null }); },
      (e: unknown) => { if (live) setLoad((l) => ({ data: l.data, loading: false, error: errorText(e) })); },
    );
    return () => { live = false; };
  }, [query, attempt]);

  const change = (f: FilesFilter): void => {
    saveFilter(f);
    setChosen(f);
  };
  const toggle = useCallback((path: string) => {
    setExpanded((s) => {
      const next = new Set(s);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);

  const retry = <button type="button" className="notify-btn stats-retry" onClick={() => setAttempt((x) => x + 1)}>再试一次</button>;
  const data = load.data;

  return (
    <div className="stats files-page">
      <div className="stats-head">
        <h1>文件</h1>
        <p className="muted">按项目看哪些文件被读过、改过，是哪些会话动的。点一个文件看动过它的会话。</p>
      </div>
      {projects === null ? (
        projectsError !== null
          ? <p className="error stats-state">加载失败：{projectsError} {retry}</p>
          : <p className="muted stats-state">加载中…</p>
      ) : projects.length === 0 ? (
        <section className="stats-empty files-card">
          <p className="stats-empty-title">还没有项目</p>
          <p className="muted">有了会话之后这里会列出它们动过的文件。</p>
        </section>
      ) : (
        <>
          <FilterRow filter={filter} qInput={qInput} projects={projects} onChange={change} onQuery={setQInput} />
          <p className="stats-caption files-caption">{FILES_SCOPE_NOTE}{CODEX_NOTE}搜索和列目录不算。</p>
          {data === null ? (
            load.error !== null
              ? <p className="error stats-state">加载失败：{load.error} {retry}</p>
              : <p className="muted stats-state">加载中…</p>
          ) : (
            <>
              {load.error !== null && <p className="error stats-state">刷新失败：{load.error}。下面是上一次的结果。{retry}</p>}
              {data.importing && <p className="stats-note stats-coverage">数据还在导入，数字会继续变化。</p>}
              {data.failedSessions > 0 && <p className="stats-note stats-coverage">有 {data.failedSessions} 个会话算不出来，已跳过。</p>}
              {data.truncatedNodes > 0 && (
                <p className="stats-note stats-coverage">有 {data.truncatedNodes} 步一次动了 50 个以上的文件，多出的没有算进来。</p>
              )}
              <div className={`stats-body${load.loading ? ' is-loading' : ''}`} aria-busy={load.loading}>
                <FilesBody data={data} now={now} expanded={expanded} onToggle={toggle} />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
