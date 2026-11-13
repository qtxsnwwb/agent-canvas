import { useEffect, useState } from 'react';
import type { AnomalyListResponse, Origin, Project } from '@agent-canvas/shared';
import {
  ANOMALY_COMPUTING_NOTE, ANOMALY_HEURISTIC_NOTE, ANOMALY_POLL_MS, anomaliesHash, anomaliesQueryString, effectiveAnomaliesFilter,
  kindChips, listNotes, listRows, parseAnomaliesQuery, surfaceState, type AnomaliesFilter, type AnomaliesOriginFilter, type ListRow,
} from '../anomalies';
import { PathLabel } from '../canvas/FilePanel';
import { api } from '../client';
import { ORIGIN_LOOK, projectTitle, relativeTime, stripProjects } from '../home';
import { OriginBadge } from '../OriginBadge';
import { STATS_RANGE_OPTIONS, availableOrigins } from '../stats';
import { useNow } from '../useNow';

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function fullTime(iso: string): string | undefined {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString('zh-CN', { hour12: false });
}

/** The stats page's controls (range, origin, project), plus the kinds as chips with their totals. */
function FilterRow({ filter, projects, totals, onChange }: {
  filter: AnomaliesFilter; projects: Project[] | null; totals: AnomalyListResponse['totals'] | null; onChange(f: AnomaliesFilter): void;
}) {
  const origins = projects === null ? [] : availableOrigins(projects);
  const originOptions: { value: AnomaliesOriginFilter; label: string }[] = [
    { value: 'all', label: '全部' }, ...origins.map((o: Origin) => ({ value: o, label: ORIGIN_LOOK[o].label })),
  ];
  const projectOptions = projects === null ? [] : stripProjects(projects, filter.origin, filter.projectId);
  return (
    <>
      <div className="stats-filters">
        <div className="view-switch" role="group" aria-label="时间范围">
          {STATS_RANGE_OPTIONS.map((o) => (
            <button key={o.value} type="button" aria-pressed={filter.range === o.value} onClick={() => onChange({ ...filter, range: o.value })}>
              {o.label}
            </button>
          ))}
        </div>
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
        {projects !== null && projects.length > 0 && (
          <label className="stats-project">
            <span className="visually-hidden">项目</span>
            <select value={filter.projectId ?? ''} onChange={(e) => onChange({ ...filter, projectId: e.target.value === '' ? null : e.target.value })}>
              <option value="">全部项目</option>
              {projectOptions.map((p) => <option key={p.id} value={p.id}>{projectTitle(p)}</option>)}
            </select>
          </label>
        )}
      </div>
      <div className="anomaly-chips" role="group" aria-label="类型">
        {kindChips(totals, filter.kind).map((c) => (
          <button key={c.kind ?? 'all'} type="button" className={`anomaly-chip${c.kind !== null ? ` anomaly-chip-${c.kind}` : ''}`}
            aria-pressed={c.pressed} onClick={() => onChange({ ...filter, kind: c.kind })}>
            {c.label}
            {c.count !== null && <span className="anomaly-chip-count">{c.count}</span>}
          </button>
        ))}
      </div>
    </>
  );
}

function Row({ row, now }: { row: ListRow; now: number }) {
  return (
    <li>
      <a className="anomaly-item" href={row.href} title="打开这个会话，并定位到这一步">
        <span className="anomaly-item-head">
          <OriginBadge origin={row.origin} iconOnly />
          <span className="anomaly-item-title">{row.title}</span>
          <span className="anomaly-row-time" title={fullTime(row.at)}>{relativeTime(row.at, now)}</span>
        </span>
        <span className="anomaly-item-body">
          <span className={`anomaly-kind anomaly-kind-${row.kind}`}>{row.kindLabel}</span>
          <span className="anomaly-row-basis">{row.basis}</span>
        </span>
        {row.path !== null && <span className="anomaly-row-path"><PathLabel path={row.path.shown} full={row.path.full} /></span>}
      </a>
    </li>
  );
}

type Load = { data: AnomalyListResponse | null; loading: boolean; error: string | null };

/** `#/anomalies`: every session's anomalies, newest first, filtered by range, origin, project and kind (in the address). */
export function Anomalies({ query }: { query: string }) {
  const now = useNow(30_000);
  const chosen = parseAnomaliesQuery(query);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectsSettled, setProjectsSettled] = useState(false);
  const [load, setLoad] = useState<Load>({ data: null, loading: true, error: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    api.projects().then(
      (p) => { if (live) { setProjects(p); setProjectsSettled(true); } },
      () => { if (live) setProjectsSettled(true); }, // without the list the address's filter is used as is
    );
    return () => { live = false; };
  }, []);

  const filter = effectiveAnomaliesFilter(chosen, projects);
  const apiQuery = anomaliesQueryString(filter);

  // Fetched on open and on every filter change; again every ANOMALY_POLL_MS while the answer says `computing`.
  useEffect(() => {
    if (!projectsSettled) return;
    let live = true;
    let poll: ReturnType<typeof setTimeout> | null = null;
    const fetchNow = (dim: boolean): void => {
      // The previous result stays on screen (dimmed on a filter change) until the new one arrives.
      if (dim) setLoad((l) => ({ ...l, loading: true }));
      api.anomalies(apiQuery).then(
        (data) => {
          if (!live) return;
          setLoad({ data, loading: false, error: null });
          if (data.computing) poll = setTimeout(() => fetchNow(false), ANOMALY_POLL_MS);
        },
        (e: unknown) => { if (live) setLoad((l) => ({ data: l.data, loading: false, error: errorText(e) })); },
      );
    };
    fetchNow(true);
    return () => {
      live = false;
      if (poll !== null) clearTimeout(poll);
    };
  }, [apiQuery, attempt, projectsSettled]);

  const change = (f: AnomaliesFilter): void => {
    window.location.hash = anomaliesHash(f);
  };

  const data = load.data;
  const state = surfaceState(data, load.error, (d) => d.items.length === 0);
  const rows = data === null ? [] : listRows(data.items, projects);
  const retry = <button type="button" className="notify-btn stats-retry" onClick={() => setAttempt((x) => x + 1)}>再试一次</button>;

  return (
    <div className="stats anomalies-page">
      <div className="stats-head">
        <h1>异常</h1>
        <p className="muted">在会话里原地打转、失败扎堆、反复改同一个文件、消耗异常高的地方。点一条打开会话，定位到那一步。</p>
      </div>
      <p className="stats-note stats-coverage anomaly-heuristic">{ANOMALY_HEURISTIC_NOTE}</p>
      <FilterRow filter={filter} projects={projects} totals={data?.totals ?? null} onChange={change} />
      {state === 'loading' && <p className="muted stats-state">加载中…</p>}
      {state === 'error' && <p className="error stats-state">加载失败：{load.error} {retry}</p>}
      {data !== null && (
        <>
          {load.error !== null && <p className="error stats-state">刷新失败：{load.error}。下面是上一次的结果。{retry}</p>}
          {data.computing && <p className="stats-note stats-coverage" role="status">{ANOMALY_COMPUTING_NOTE}</p>}
          {listNotes(data).map((line) => <p key={line} className="stats-note stats-coverage">{line}</p>)}
          <div className={`stats-body${load.loading ? ' is-loading' : ''}`} aria-busy={load.loading}>
            {state === 'empty' ? (
              <section className="stats-empty">
                <p className="stats-empty-title">没有发现异常</p>
                <p className="muted">这段时间、这些筛选条件下没有。换个时间范围或筛选条件试试。</p>
              </section>
            ) : (
              <section className="files-card anomaly-card" aria-label="异常列表">
                <ul className="anomaly-items">
                  {rows.map((r) => <Row key={r.key} row={r} now={now} />)}
                </ul>
              </section>
            )}
          </div>
        </>
      )}
    </div>
  );
}
