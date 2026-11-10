import { useEffect, useRef, useState } from 'react';
import { SEARCH_MIN_CHARS, type Project, type SearchField, type SearchHit, type Session } from '@claude-canvas/shared';
import { api, openLiveSessions } from '../client';
import { sessionStatusView } from '../labels';
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

function SearchResults({ result, q, now }: { result: SearchResult | null; q: string; now: number }) {
  if (result === null || result.q !== q) return <p className="muted search-note">搜索中…</p>;
  if (result.error !== null) return <p className="error">搜索失败：{result.error}</p>;
  const hits: SearchHit[] = result.hits ?? [];
  if (hits.length === 0) return <p className="muted search-note">没有匹配的会话</p>;
  return (
    <ul className="search-results">
      {hits.map(({ session: s, matches }) => {
        const status = sessionStatusView(s, now);
        return (
          <li key={s.id}>
            <a href={`#/s/${encodeURIComponent(s.id)}`}>
              <div className="session-title">{s.title ?? s.id.slice(0, 8)}</div>
              <div className="muted">
                {s.cwd !== null && <span>{s.cwd} · </span>}
                <span className={`status status-${status.status}`}>{status.label}</span>
                <span> · {formatTime(s.lastActivityAt)}</span>
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
  const selected = useRef(projectId);
  selected.current = projectId;

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
    if (projectId === null) return;
    let alive = true;
    api.sessions(projectId).then(
      (s) => { if (alive) { setSessions(s); setError(null); } },
      (e: unknown) => { if (alive) setError(String(e)); },
    );
    return () => { alive = false; };
  }, [projectId]);

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
  const searching = q.length >= SEARCH_MIN_CHARS;

  return (
    <>
    <div className="search-bar">
      <input
        type="search"
        value={query}
        placeholder="搜索历史会话：标题、分支、目录、提示内容"
        aria-label="搜索历史会话"
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') onQuery(''); }}
      />
    </div>
    {searching ? (
      <SearchResults result={result} q={q} now={now} />
    ) : (
    <div className="home">
      {error !== null && <p className="error">加载失败：{error}</p>}
      <nav className="projects">
        <h2>项目</h2>
        {projects.length === 0 && <p className="muted">暂无项目</p>}
        <ul>
          {projects.map((p) => (
            <li key={p.id} className={p.id === projectId ? 'selected' : undefined}>
              <a href={`#/p/${encodeURIComponent(p.id)}`}>
                <div className="project-name">{p.cwd ?? p.id}</div>
                <div className="muted">{p.sessionCount} 个会话，{p.activeSessionCount} 个活跃</div>
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <section className="sessions">
        <h2>会话</h2>
        {projectId === null && <p className="muted">请选择一个项目</p>}
        {projectId !== null && sessions.length === 0 && <p className="muted">暂无会话</p>}
        <ul>
          {sessions.map((s) => {
            const status = sessionStatusView(s, now);
            return (
            <li key={s.id}>
              <a href={`#/s/${encodeURIComponent(s.id)}`}>
                <div className="session-title">{s.title ?? s.id.slice(0, 8)}</div>
                <div className="muted">
                  <span className={`status status-${status.status}`}>{status.label}</span>
                  {s.gitBranch !== null && <span> · {s.gitBranch}</span>}
                  <span> · {formatTime(s.lastActivityAt)}</span>
                  {s.sourceDeleted && <span className="tag"> 源文件已删除</span>}
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
