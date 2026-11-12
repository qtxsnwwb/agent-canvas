import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { SEARCH_MIN_CHARS, type Project, type SearchField, type SearchHit, type Session } from '@claude-canvas/shared';
import { api, openLiveSessions } from '../client';
import { sessionStatusView } from '../labels';
import {
  effectiveOriginFilter, filterEmptyMessage, heroTotals, matchesOrigin, ORIGIN_FILTER_KEY, ORIGIN_FILTER_OPTIONS, originLook, parseOriginFilter,
  projectCountsExact, projectLook, projectName, projectTitle, relativeTime, shownProjectId, showOriginFilter, stripProjects,
  type OriginFilter,
} from '../home';
import { OriginBadge } from '../OriginBadge';
import { createSearcher, highlightParts, type SearchResult } from '../search';
import { createThrottle } from '../throttle';
import { useNow } from '../useNow';

const PROJECTS_REFRESH_MS = 500;
/** Active counts depend on the clock (running sessions go stale), so refetch even when no event arrives. */
const PROJECTS_POLL_MS = 60_000;

const FIELD_LABEL: Record<SearchField, string> = { title: '标题', id: '会话 id', branch: '分支', cwd: '目录', prompt: '提示' };

const byActivityDesc = (a: Session, b: Session): number =>
  a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0;

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function Highlighted({ text, q }: { text: string; q: string }) {
  return (
    <>
      {highlightParts(text, q).map((p, i) => (p.match ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </>
  );
}

function readOriginFilter(): OriginFilter {
  try { return parseOriginFilter(window.localStorage.getItem(ORIGIN_FILTER_KEY)); } catch { return 'all'; }
}

/** 全部 / Claude Code / Codex / Cursor; shown only when some project has Codex or Cursor sessions. */
function OriginFilterSwitch({ value, onChange }: { value: OriginFilter; onChange(value: OriginFilter): void }) {
  return (
    <div className="origin-filter">
      <div className="view-switch" role="group" aria-label="来源">
        {ORIGIN_FILTER_OPTIONS.map((o) => (
          <button key={o.value} type="button" data-origin={o.value} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SearchResults({ result, q, now, filter }: { result: SearchResult | null; q: string; now: number; filter: OriginFilter }) {
  if (result === null || result.q !== q) return <p className="muted search-note">搜索中…</p>;
  if (result.error !== null) return <p className="error">搜索失败：{result.error}</p>;
  const all: SearchHit[] = result.hits ?? [];
  const hits = all.filter((h) => matchesOrigin(filter, h.session.origin));
  if (hits.length === 0) {
    return (
      <p className="muted search-note">
        {all.length === 0 || filter === 'all' ? '没有匹配的会话' : `没有匹配的 ${originLook(filter).label} 会话（其他来源有 ${all.length} 个）`}
      </p>
    );
  }
  return (
    <ul className="search-results">
      {hits.map(({ session: s, matches }) => {
        const status = sessionStatusView(s, now);
        return (
          <li key={s.id}>
            <a className="session-card" href={`#/s/${encodeURIComponent(s.id)}`}>
              <div className="session-title">{s.title ?? s.id.slice(0, 8)}</div>
              <div className="session-meta">
                <span className={`status status-${status.status}`}>{status.label}</span>
                <OriginBadge origin={s.origin} />
                {s.cwd !== null && <span className="chip" title={s.cwd}>📁 {projectName(s.cwd)}</span>}
                <span className="muted" title={formatTime(s.lastActivityAt)}>{relativeTime(s.lastActivityAt, now)}</span>
              </div>
              {matches.map((m, i) => (
                <div key={i} className="search-match">
                  <span className="search-field">{FIELD_LABEL[m.field]}</span>
                  <Highlighted text={m.snippet} q={q} />
                </div>
              ))}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export function Home({ projectId }: { projectId: string | null }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();
  const [chosenFilter, setChosenFilter] = useState<OriginFilter>(readOriginFilter);
  const chooseFilter = (value: OriginFilter): void => {
    try { window.localStorage.setItem(ORIGIN_FILTER_KEY, value); } catch { /* storage unavailable: not remembered */ }
    setChosenFilter(value);
  };
  // Without any Codex or Cursor project the filter is hidden and has no effect.
  const filter = effectiveOriginFilter(chosenFilter, projects);
  // With no project in the address, the busiest visible one is shown (the page is never an empty "pick something");
  // a project in the address is shown even when the filter hides it.
  const shownId = shownProjectId(projectId, projects, filter);
  const selected = useRef(shownId);
  selected.current = shownId;

  // Projects: initial load, plus a throttled refetch whenever any session changes (counts move with status). A throttle,
  // not a debounce: during a long import upserts never stop, and the list must still refresh (at most every 500 ms).
  useEffect(() => {
    let alive = true;
    const loadProjects = (): void => {
      api.projects().then(
        (p) => { if (alive) { setProjects(p); setError(null); } },
        (e: unknown) => { if (alive) setError(String(e)); },
      );
    };
    const loadSessions = (): void => {
      const id = selected.current;
      if (id === null) return;
      api.sessions(id).then(
        (s) => { if (alive && selected.current === id) setSessions(s); },
        (e: unknown) => { if (alive) setError(String(e)); },
      );
    };
    loadProjects();
    const refresh = createThrottle(loadProjects, PROJECTS_REFRESH_MS);
    const poll = setInterval(loadProjects, PROJECTS_POLL_MS);
    const live = openLiveSessions(
      (s) => {
        if (s.projectId === selected.current) {
          setSessions((prev) => [...prev.filter((x) => x.id !== s.id), s].sort(byActivityDesc));
        }
        refresh.trigger();
      },
      // Upserts missed while disconnected are not replayed: refetch both lists.
      { onReconnect: () => { loadProjects(); loadSessions(); } },
    );
    return () => {
      alive = false;
      clearInterval(poll);
      refresh.cancel();
      live.close();
    };
  }, []);

  useEffect(() => {
    setSessions([]);
    if (shownId === null) return;
    let alive = true;
    api.sessions(shownId).then(
      (s) => { if (alive) { setSessions(s); setError(null); } },
      (e: unknown) => { if (alive) setError(String(e)); },
    );
    return () => { alive = false; };
  }, [shownId]);

  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const searcher = useRef<ReturnType<typeof createSearcher> | null>(null);
  useEffect(() => {
    const s = createSearcher({ search: api.search, onResult: setResult });
    searcher.current = s;
    return () => { s.dispose(); searcher.current = null; };
  }, []);
  const onQuery = (value: string): void => {
    setQuery(value);
    searcher.current?.query(value);
  };
  const q = query.trim();
  const searching = Array.from(q).length >= SEARCH_MIN_CHARS;

  // Session counts come per project across origins: under a filter they are shown only where they are exact.
  const totals = heroTotals(projects, filter);
  const strip = stripProjects(projects, filter, shownId);
  const shown = projects.find((p) => p.id === shownId);
  const shownSessions = sessions.filter((s) => matchesOrigin(filter, s.origin));

  return (
    <>
    <div className="hero">
      <h1><span className="hero-wave" aria-hidden="true">👋</span> 现在都在忙什么？</h1>
      <p className="hero-sub">
        {totals.projects} 个项目
        {filter !== 'all' && <> · 只看 {originLook(filter).label}</>}
        {totals.sessions !== null && totals.active !== null && (
          <>
            {' '}· {totals.sessions} 个会话 ·{' '}
            {totals.active > 0 ? <strong className="hero-live">{totals.active} 个正在进行</strong> : '此刻都在休息'}
          </>
        )}
      </p>
      <div className="search-bar">
        <input
          type="search"
          value={query}
          placeholder="搜一搜：标题、分支、目录、说过的话"
          aria-label="搜索历史会话"
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') onQuery(''); }}
        />
      </div>
    </div>
    {searching ? (
      <SearchResults result={result} q={q} now={now} filter={filter} />
    ) : (
    <div className="home">
      {error !== null && <p className="error">加载失败：{error}</p>}
      {showOriginFilter(projects) && <OriginFilterSwitch value={chosenFilter} onChange={chooseFilter} />}
      <nav className="project-strip" aria-label="项目">
        {projects.length === 0 && <p className="muted">还没有项目。在任意目录里用一次 Claude Code、Codex 或 Cursor，它就会出现在这里。</p>}
        {filterEmptyMessage(projects, filter) !== null && <p className="muted">{filterEmptyMessage(projects, filter)}</p>}
        {strip.map((p) => {
          const look = projectLook(p.id);
          const path = p.cwd ?? p.id;
          return (
            <a key={p.id} className={`project-tile${p.id === shownId ? ' selected' : ''}`} href={`#/p/${encodeURIComponent(p.id)}`}
              aria-current={p.id === shownId ? 'true' : undefined} style={{ ['--hue' as string]: look.hue } as CSSProperties}>
              <span className="project-avatar" aria-hidden="true">{look.emoji}</span>
              <span className="project-text">
                <span className="project-name">{projectTitle(p)}</span>
                <span className="project-path" title={path}>{path}</span>
              </span>
              <span className="project-counts">
                {projectCountsExact(p, filter) && (
                  <>
                    <span className="chip">{p.sessionCount} 个会话</span>
                    {p.activeSessionCount > 0 && <span className="chip chip-live">{p.activeSessionCount} 个进行中</span>}
                  </>
                )}
                {filter === 'all' && p.origins.length > 1 && (
                  <span className="origin-dots">{p.origins.map((o) => <OriginBadge key={o} origin={o} iconOnly />)}</span>
                )}
              </span>
            </a>
          );
        })}
      </nav>
      <section className="sessions">
        <h2>{shown !== undefined ? `${projectTitle(shown)} 的会话` : '会话'}</h2>
        {shownId !== null && sessions.length === 0 && <p className="muted">这个项目还没有会话</p>}
        {sessions.length > 0 && shownSessions.length === 0 && filter !== 'all' && (
          <p className="muted">这个项目没有 {originLook(filter).label} 会话</p>
        )}
        <ul className="session-grid">
          {shownSessions.map((s) => {
            const status = sessionStatusView(s, now);
            return (
            <li key={s.id}>
              <a className={`session-card is-${status.status}`} href={`#/s/${encodeURIComponent(s.id)}`}>
                <div className="session-title">{s.title ?? s.id.slice(0, 8)}</div>
                <div className="session-meta">
                  <span className={`status status-${status.status}`}>{status.label}</span>
                  <OriginBadge origin={s.origin} />
                  {s.gitBranch !== null && <span className="chip chip-branch" title={s.gitBranch}>🌿 {s.gitBranch}</span>}
                  <span className="muted" title={formatTime(s.lastActivityAt)}>{relativeTime(s.lastActivityAt, now)}</span>
                  {s.sourceDeleted && <span className="tag">源文件已删除</span>}
                </div>
              </a>
            </li>
            );
          })}
        </ul>
      </section>
    </div>
    )}
    </>
  );
}
