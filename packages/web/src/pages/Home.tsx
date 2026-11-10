import { useEffect, useRef, useState } from 'react';
import type { Project, Session } from '@claude-canvas/shared';
import { api, openLiveSessions } from '../client';
import { sessionStatusView } from '../labels';
import { createThrottle } from '../throttle';
import { useNow } from '../useNow';

const PROJECTS_REFRESH_MS = 500;

const byActivityDesc = (a: Session, b: Session): number =>
  a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0;

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
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

  return (
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
  );
}
