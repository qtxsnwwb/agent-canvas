import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import type { Origin, Project, StatsBucket, StatsDay, StatsResponse, StatsTokens, StatsTool } from '@agent-canvas/shared';
import { api } from '../client';
import { ORIGIN_LOOK, projectTitle, stripProjects } from '../home';
import {
  DEFAULT_STATS_FILTER, STATS_FILTER_KEY, STATS_RANGE_OPTIONS, availableOrigins, bucketLabel, bucketLong, columnLayout,
  coverageNotes, dayIndexAt, seriesBucket, seriesTitle,
  durationTickLabel, durationTicks, effectiveStatsFilter, formatAvg, formatCount, formatRate, formatSpan, formatTokenCount,
  formatTokenTriple, isEmptyStats, NONE, TOKEN_CAPTION, TOKEN_PARTS, tokenCells, labelEvery, labelIndices, parseStatsFilter, projectRowName, rangeLabel, roundedEndRect,
  serializeStatsFilter, sessionHref, shownNoTokenOrigins, splitTools, stackSegments, statsQueryString,
  type StatsFilter, type StatsOriginFilter,
} from '../stats';

/** How many (origin, tool) bars are drawn; the rest is one line of text. */
const TOOL_BARS = 12;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function loadFilter(): StatsFilter {
  try { return parseStatsFilter(window.localStorage.getItem(STATS_FILTER_KEY)); } catch { return { ...DEFAULT_STATS_FILTER }; }
}

function saveFilter(f: StatsFilter): void {
  try { window.localStorage.setItem(STATS_FILTER_KEY, serializeStatsFilter(f)); } catch { /* storage unavailable: not remembered */ }
}

const originName = (o: Origin): string => ORIGIN_LOOK[o].label;

/** A small filled square in the origin's series colour: the identity key beside a name (the name stays in ink). */
function Swatch({ origin }: { origin: Origin }) {
  return <span className="stats-swatch" style={{ background: `var(--series-${origin})` }} aria-hidden="true" />;
}

function Legend({ origins }: { origins: readonly Origin[] }) {
  if (origins.length < 2) return null;
  return (
    <ul className="stats-legend" aria-label="图例">
      {origins.map((o) => <li key={o}><Swatch origin={o} />{originName(o)}</li>)}
    </ul>
  );
}

function SectionHead({ id, title, caption }: { id: string; title: string; caption: string }) {
  return (
    <>
      <h2 id={id}>{title}</h2>
      <p className="stats-caption">{caption}</p>
    </>
  );
}

/** The element's content width, kept up to date. */
function useWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

// ---- filters ----

function FilterRow({ filter, projects, onChange }: {
  filter: StatsFilter; projects: Project[] | null; onChange: (f: StatsFilter) => void;
}) {
  const origins = projects === null ? [] : availableOrigins(projects);
  const originOptions: { value: StatsOriginFilter; label: string }[] = [
    { value: 'all', label: '全部' }, ...origins.map((o) => ({ value: o, label: originName(o) })),
  ];
  const projectOptions = projects === null ? [] : stripProjects(projects, filter.origin, filter.projectId);
  return (
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
  );
}

// ---- totals ----

function Tile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stats-tile">
      <div className="stats-tile-label">{label}</div>
      <div className="stats-tile-value">{value}</div>
      {sub !== undefined && <div className="stats-tile-sub">{sub}</div>}
    </div>
  );
}

function Totals({ data }: { data: StatsResponse }) {
  const t = data.totals;
  const noTokens = shownNoTokenOrigins(data);
  const tokenSub = t.tokens === null
    ? '这些来源没有 token 数据'
    : noTokens.length > 0 ? `不含 ${noTokens.map(originName).join('、')}（没有 token 数据）` : undefined;
  return (
    <section aria-labelledby="stats-totals-h">
      <SectionHead id="stats-totals-h" title="总量"
        caption="只算范围内开始的轮次（轮次 = 会话页上的轮次卡片）；工具调用含子代理内部的调用，所以比轮次卡片上的数多。token 和会话页一样分新输入、缓存读取、输出三类。" />
      <div className="stats-tiles">
        <Tile label="会话" value={formatCount(t.sessions)} />
        <Tile label="轮次" value={formatCount(t.turns)} />
        <Tile label="活跃时长" value={formatSpan(t.activeMs)} />
        <Tile label="工具调用" value={formatCount(t.toolCalls)} sub={`耗时合计 ${formatSpan(t.toolMs)}`} />
        <Tile label="失败率" value={formatRate(t.failureRate)} sub={`${formatCount(t.failed)} / ${formatCount(t.finished)} 次已结束的调用`} />
        <Tile
          label="token"
          value={t.tokens === null ? NONE : (
            <>
              {TOKEN_PARTS.map((p) => (
                <span key={p.key} className="stats-tile-line">{formatTokenCount(t.tokens![p.key])}<small>{p.label}</small></span>
              ))}
            </>
          )}
          sub={tokenSub}
        />
      </div>
    </section>
  );
}

// ---- per-day active time ----

const PLOT_H = 200;
const M_TOP = 12;
const M_BOTTOM = 26;
const M_LEFT = 64;
const M_RIGHT = 20;
const X_LABEL_W = 40;

function DayChart({ days, origins, truncated, bucket }: { days: StatsDay[]; origins: Origin[]; truncated: boolean; bucket: StatsBucket }) {
  const unit = bucket === 'week' ? '周' : '天';
  const [boxRef, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<{ day: number; origin: number | null } | null>(null);
  const plotW = Math.max(0, width - M_LEFT - M_RIGHT);
  const n = days.length;
  const layout = columnLayout(n, plotW);
  const dayTotal = (d: StatsDay): number => d.byOrigin.reduce((s, o) => s + o.activeMs, 0);
  const axis = durationTicks(Math.max(0, ...days.map(dayTotal)));
  const baseY = M_TOP + PLOT_H;
  const px = PLOT_H / axis.max;
  const stacks = days.map((d) => stackSegments(d.byOrigin.map((o) => o.activeMs), px, baseY));
  const labels = labelIndices(n, labelEvery(n, plotW, X_LABEL_W, bucket));
  const svgH = M_TOP + PLOT_H + M_BOTTOM;

  const onPointer = (e: PointerEvent<SVGRectElement>): void => {
    const box = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (box === undefined || n === 0) return;
    const day = dayIndexAt(e.clientX - box.left - M_LEFT, layout);
    const y = e.clientY - box.top;
    const seg = stacks[day]!.find((s) => y >= s.y0 && y <= s.y1);
    setActive({ day, origin: seg === undefined ? null : seg.index });
  };
  const lastActive = (): number => {
    for (let i = n - 1; i >= 0; i--) if (dayTotal(days[i]!) > 0) return i;
    return n - 1;
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (n === 0) return;
    const cur = active?.day ?? lastActive();
    const next = e.key === 'ArrowLeft' ? cur - 1 : e.key === 'ArrowRight' ? cur + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null;
    if (next === null) return;
    e.preventDefault();
    setActive({ day: Math.max(0, Math.min(n - 1, next)), origin: null });
  };

  const a = active !== null && active.day < n ? active : null;
  const aDay = a === null ? null : days[a.day]!;
  const tipLeft = a === null ? 0 : M_LEFT + layout.x(a.day) + layout.barWidth / 2;
  const tipFlip = tipLeft > width - 230;
  const activeText = aDay === null ? '' : `${bucketLong(aDay.day, bucket)}，合计 ${formatSpan(dayTotal(aDay))}`
    + (origins.length > 1 ? '；' + aDay.byOrigin.map((o) => `${originName(o.origin)} ${formatSpan(o.activeMs)}`).join('，') : '');

  return (
    <>
      <Legend origins={origins} />
      <div
        ref={boxRef} className="stats-daychart" tabIndex={0} role="group"
        aria-label={`${seriesTitle(bucket)}图。用左右方向键逐${unit}查看。`}
        onFocus={() => setActive((x) => x ?? (n > 0 ? { day: lastActive(), origin: null } : null))}
        onBlur={() => setActive(null)} onKeyDown={onKey}
      >
        {width > 0 && (
          <svg width={width} height={svgH} aria-hidden="true">
            {axis.ticks.map((t) => {
              const y = baseY - t * px;
              return (
                <g key={t}>
                  {t > 0 && <line x1={M_LEFT} x2={M_LEFT + plotW} y1={y} y2={y} className="stats-grid" />}
                  <text x={M_LEFT - 8} y={y} dy="0.35em" textAnchor="end" className="stats-tick">{durationTickLabel(t, axis.step)}</text>
                </g>
              );
            })}
            {a !== null && (
              <rect x={M_LEFT + a.day * layout.band} y={M_TOP} width={layout.band} height={PLOT_H} className="stats-hover-band" />
            )}
            {stacks.map((segs, i) => segs.map((s) => {
              const origin = days[i]!.byOrigin[s.index]!.origin;
              const x = M_LEFT + layout.x(i);
              const fill = `var(--series-${origin})`;
              return s.top
                ? <path key={`${i}-${origin}`} d={roundedEndRect(x, s.y, layout.barWidth, s.height, 4)} fill={fill} />
                : <rect key={`${i}-${origin}`} x={x} y={s.y} width={layout.barWidth} height={s.height} fill={fill} />;
            }))}
            <line x1={M_LEFT} x2={M_LEFT + plotW} y1={baseY} y2={baseY} className="stats-axis" />
            {labels.map((i) => (
              <text key={i} x={M_LEFT + layout.x(i) + layout.barWidth / 2} y={baseY + 17} textAnchor="middle" className="stats-tick">
                {bucketLabel(days[i]!.day, bucket)}
              </text>
            ))}
            {/* The hit area: the whole plot, snapped to the day under the pointer (wider and taller than any column). */}
            <rect x={M_LEFT} y={0} width={plotW} height={svgH} fill="transparent"
              onPointerMove={onPointer} onPointerDown={onPointer} onPointerLeave={() => setActive(null)} />
          </svg>
        )}
        {aDay !== null && a !== null && (
          <div className="stats-tip" style={tipFlip ? { right: width - tipLeft + 12, top: M_TOP } : { left: tipLeft + 12, top: M_TOP }}>
            <div className="stats-tip-date">{bucketLong(aDay.day, bucket)}</div>
            <div className="stats-tip-row">
              <strong>{formatSpan(dayTotal(aDay))}</strong><span>{bucket === 'week' ? '这周合计' : '合计'} · {formatCount(aDay.turns)} 轮</span>
            </div>
            {aDay.byOrigin.map((o, k) => (
              <div key={o.origin} className={`stats-tip-row${a.origin === k ? ' is-active' : ''}`}>
                <span className="stats-tip-key" style={{ background: `var(--series-${o.origin})` }} />
                <strong>{formatSpan(o.activeMs)}</strong><span>{originName(o.origin)}</span>
              </div>
            ))}
          </div>
        )}
        <span className="visually-hidden" aria-live="polite">{activeText}</span>
      </div>
      {truncated && <p className="stats-note">时间太长，图里只画了最近 366 {unit}；上面的总量和下面的表包含全部时间。</p>}
      <details className="stats-details">
        <summary>看每{unit}的数字</summary>
        <div className="stats-table-wrap">
          <table className="stats-table">
            <thead>
              <tr>
                <th>{bucket === 'week' ? '周' : '日期'}</th>
                {origins.length > 1 && origins.map((o) => <th key={o} className="num">{originName(o)}</th>)}
                <th className="num">活跃时长</th><th className="num">轮次</th>
              </tr>
            </thead>
            <tbody>
              {days.filter((d) => dayTotal(d) > 0 || d.turns > 0).reverse().map((d) => (
                <tr key={d.day}>
                  <td>{bucketLong(d.day, bucket)}</td>
                  {origins.length > 1 && d.byOrigin.map((o) => <td key={o.origin} className="num">{formatSpan(o.activeMs)}</td>)}
                  <td className="num">{formatSpan(dayTotal(d))}</td><td className="num">{formatCount(d.turns)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="stats-note">只列出有活动的{bucket === 'week' ? '周' : '日子'}。</p>
      </details>
    </>
  );
}

// ---- token columns (three categories, one sub-column each) ----

/** The header row above the token sub-columns: the group name spanning them. */
function TokenGroupHead({ title }: { title: string }) {
  return <th className="num stats-th-group" colSpan={TOKEN_PARTS.length} scope="colgroup">{title}</th>;
}

function TokenSubHeads() {
  return <>{TOKEN_PARTS.map((p) => <th key={p.key} className="num stats-th-sub" scope="col">{p.label}</th>)}</>;
}

function TokenCells({ tokens }: { tokens: StatsTokens | null }) {
  const cells = tokenCells(tokens);
  const title = formatTokenTriple(tokens);
  return <>{cells.map((c, i) => <td key={TOKEN_PARTS[i]!.key} className="num" title={title}>{c}</td>)}</>;
}

// ---- three origins compared ----

function OriginTable({ data }: { data: StatsResponse }) {
  return (
    <section aria-labelledby="stats-origins-h">
      <SectionHead id="stats-origins-h" title="三家对比"
        caption="这些指标不依赖工具名，可以直接比。轮次 = 会话页上的轮次卡片；中位时长：一半的轮次比它短；每轮平均工具调用含子代理内部的调用。" />
      <div className="stats-table-wrap">
        <table className="stats-table">
          <thead>
            <tr>
              <th rowSpan={2}>来源</th><th rowSpan={2} className="num">会话</th><th rowSpan={2} className="num">轮次</th>
              <th rowSpan={2} className="num">每轮中位时长</th><th rowSpan={2} className="num">每轮平均工具调用</th>
              <th rowSpan={2} className="num">失败率</th><TokenGroupHead title="每轮平均 token" />
            </tr>
            <tr><TokenSubHeads /></tr>
          </thead>
          <tbody>
            {data.byOrigin.map((o) => (
              <tr key={o.origin}>
                <td><Swatch origin={o.origin} />{originName(o.origin)}</td>
                <td className="num">{formatCount(o.sessions)}</td>
                <td className="num">{formatCount(o.turns)}</td>
                <td className="num">{formatSpan(o.medianTurnMs)}</td>
                <td className="num">{formatAvg(o.avgToolCallsPerTurn)}</td>
                <td className="num">{formatRate(o.failureRate)}</td>
                <TokenCells tokens={o.avgTokensPerTurn} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="stats-note">{TOKEN_CAPTION}</p>
    </section>
  );
}

// ---- where tool time goes ----

function ToolBars({ data }: { data: StatsResponse }) {
  const { shown, rest } = splitTools(data.byTool, TOOL_BARS, data.totals);
  const [active, setActive] = useState<{ i: number; top: number } | null>(null);
  const max = Math.max(0, ...shown.map((t) => t.totalMs));
  const origins = data.byOrigin.map((o) => o.origin).filter((o) => shown.some((t) => t.origin === o));
  const multi = data.byOrigin.length > 1;
  const show = useCallback((i: number, el: HTMLElement) => setActive({ i, top: el.offsetTop + el.offsetHeight }), []);
  const tip: StatsTool | undefined = active === null ? undefined : shown[active.i];
  return (
    <section aria-labelledby="stats-tools-h">
      <SectionHead id="stats-tools-h" title="时间花在哪类工具上"
        caption="每次调用的耗时加起来；并行的调用各算各的，所以合计可以比活跃时长还长。工具名用各家自己的叫法，不合并；含子代理内部的调用。" />
      {shown.length === 0 ? (
        <p className="muted">这段时间没有工具调用。</p>
      ) : (
        <>
          <Legend origins={origins} />
          <div className="stats-bars" onMouseLeave={() => setActive(null)}>
            {shown.map((t, i) => {
              const pct = max > 0 ? (t.totalMs / max) * 100 : 0;
              return (
                <div
                  key={`${t.origin}:${t.toolName}`} className={`stats-bar-row${active?.i === i ? ' is-active' : ''}`} tabIndex={0}
                  aria-label={`${t.toolName}（${originName(t.origin)}）：耗时合计 ${formatSpan(t.totalMs)}，${formatCount(t.calls)} 次调用，中位 ${formatSpan(t.medianMs)}`}
                  onMouseEnter={(e) => show(i, e.currentTarget)} onFocus={(e) => show(i, e.currentTarget)} onBlur={() => setActive(null)}
                >
                  <div className="stats-bar-name" title={t.toolName}>
                    <span className="stats-bar-tool">{t.toolName}</span>
                    {multi && <span className="stats-bar-origin">{originName(t.origin)}</span>}
                  </div>
                  <svg className="stats-bar-svg" width="100%" height="14" aria-hidden="true">
                    {pct > 0 && (
                      <>
                        {/* Rounded at the data end, square at the baseline: a rounded bar with its left half squared off. */}
                        <rect x="0" y="0" width={`${pct}%`} height="14" rx="4" fill={`var(--series-${t.origin})`} />
                        <rect x="0" y="0" width={`${pct / 2}%`} height="14" fill={`var(--series-${t.origin})`} />
                      </>
                    )}
                  </svg>
                  <div className="stats-bar-value">
                    <strong>{formatSpan(t.totalMs)}</strong>
                    <span> · {formatCount(t.calls)} 次 · 中位 {formatSpan(t.medianMs)}</span>
                  </div>
                </div>
              );
            })}
            {tip !== undefined && active !== null && (
              <div className="stats-tip stats-tip-bars" style={{ top: active.top }}>
                <div className="stats-tip-date">{tip.toolName} · {originName(tip.origin)}</div>
                <div className="stats-tip-row"><strong>{formatSpan(tip.totalMs)}</strong><span>耗时合计</span></div>
                <div className="stats-tip-row"><strong>{formatCount(tip.calls)}</strong><span>次调用</span></div>
                <div className="stats-tip-row"><strong>{formatSpan(tip.medianMs)}</strong><span>中位</span></div>
                <div className="stats-tip-row"><strong>{formatSpan(tip.p95Ms)}</strong><span>P95（95% 的调用比它快）</span></div>
                <div className="stats-tip-row"><strong>{formatRate(tip.failureRate)}</strong><span>失败率（{formatCount(tip.failed)} 次）</span></div>
              </div>
            )}
          </div>
          {rest !== null && (
            <p className="stats-note">其余工具：共 {formatCount(rest.calls)} 次调用，耗时合计 {formatSpan(rest.ms)}。</p>
          )}
        </>
      )}
    </section>
  );
}

// ---- slowest calls, most failing tools, projects ----

function ToolName({ origin, name, multi }: { origin: Origin; name: string; multi: boolean }) {
  return (
    <span className="stats-tool">
      <Swatch origin={origin} />
      <span className="stats-mono">{name}</span>
      {multi && <span className="stats-bar-origin">{originName(origin)}</span>}
    </span>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function Slowest({ data, projectNames }: { data: StatsResponse; projectNames: Map<string, string> }) {
  const multi = data.byOrigin.length > 1;
  return (
    <section aria-labelledby="stats-slow-h">
      <SectionHead id="stats-slow-h" title="最慢的 10 次调用"
        caption="范围内耗时最长的已结束调用，含子代理内部的。点工具名打开那个会话。" />
      {data.slowest.length === 0 ? <p className="muted">没有已结束的调用。</p> : (
        <div className="stats-table-wrap">
          <table className="stats-table">
            <thead><tr><th>工具</th><th className="num">耗时</th><th>项目</th><th>开始于</th></tr></thead>
            <tbody>
              {data.slowest.map((c) => (
                <tr key={`${c.sessionId}:${c.nodeId}`}>
                  <td><a href={sessionHref(c.sessionId)} title="打开这个会话"><ToolName origin={c.origin} name={c.toolName} multi={multi} /></a></td>
                  <td className="num">{formatSpan(c.durationMs)}</td>
                  <td className="wrap">{projectNames.get(c.projectId) ?? c.projectId}</td>
                  <td>{formatWhen(c.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function MostFailing({ data }: { data: StatsResponse }) {
  const multi = data.byOrigin.length > 1;
  return (
    <section aria-labelledby="stats-fail-h">
      <SectionHead id="stats-fail-h" title="最常失败的工具"
        caption="失败或被拒绝的次数；失败率 = 失败 ÷ 已结束的调用，还在跑的不算。调用不到 5 次的不上榜。" />
      {data.mostFailing.length === 0 ? <p className="muted">没有失败过的工具，真棒。</p> : (
        <div className="stats-table-wrap">
          <table className="stats-table">
            <thead><tr><th>工具</th><th className="num">失败</th><th className="num">已结束</th><th className="num">失败率</th></tr></thead>
            <tbody>
              {data.mostFailing.map((t) => (
                <tr key={`${t.origin}:${t.toolName}`}>
                  <td><ToolName origin={t.origin} name={t.toolName} multi={multi} /></td>
                  <td className="num">{formatCount(t.failed)}</td>
                  <td className="num">{formatCount(t.finished)}</td>
                  <td className="num">{formatRate(t.failureRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ByProject({ data }: { data: StatsResponse }) {
  return (
    <section aria-labelledby="stats-proj-h">
      <SectionHead id="stats-proj-h" title="按项目"
        caption="按活跃时长排序，最多列 20 个，其余合成一行。" />
      <div className="stats-table-wrap">
        <table className="stats-table">
          <thead>
            <tr>
              <th rowSpan={2}>项目</th><th rowSpan={2} className="num">会话</th><th rowSpan={2} className="num">轮次</th>
              <th rowSpan={2} className="num">活跃时长</th><th rowSpan={2} className="num">失败率</th><TokenGroupHead title="token" />
            </tr>
            <tr><TokenSubHeads /></tr>
          </thead>
          <tbody>
            {data.byProject.map((p) => (
              <tr key={p.projectId ?? '\u0000other'}>
                <td className="wrap">{p.projectId === null ? projectRowName(p) : <a href={`#/p/${encodeURIComponent(p.projectId)}`}>{projectRowName(p)}</a>}</td>
                <td className="num">{formatCount(p.sessions)}</td>
                <td className="num">{formatCount(p.turns)}</td>
                <td className="num">{formatSpan(p.activeMs)}</td>
                <td className="num">{formatRate(p.failureRate)}</td>
                <TokenCells tokens={p.tokens} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="stats-note">{TOKEN_CAPTION}</p>
    </section>
  );
}

// ---- the page ----

function StatsBody({ data, projectNames }: { data: StatsResponse; projectNames: Map<string, string> }) {
  if (isEmptyStats(data)) {
    return (
      <section className="stats-empty">
        <p className="stats-empty-title">这段时间没有活动</p>
        <p className="muted">换个时间范围或筛选条件试试。</p>
      </section>
    );
  }
  const origins = data.byOrigin.map((o) => o.origin);
  const bucket = seriesBucket(data);
  return (
    <>
      <Totals data={data} />
      <section aria-labelledby="stats-days-h">
        <SectionHead id="stats-days-h" title={seriesTitle(bucket)}
          caption={(bucket === 'week'
            ? '时间跨度超过 62 天，按周（周一到周日）合计，横轴标的是每周的周一。'
            : '')
            + '每一轮算在它开始的那一天。轮次时长 = 最后一个节点结束 − 提示的时间；进行中的轮次算到现在，超过 15 分钟没动静就不再增长。'} />
        <DayChart days={data.byDay} origins={origins} truncated={data.coverage.byDayTruncated} bucket={bucket} />
      </section>
      {data.byOrigin.length > 1 && <OriginTable data={data} />}
      <ToolBars data={data} />
      <div className="stats-pair">
        <Slowest data={data} projectNames={projectNames} />
        <MostFailing data={data} />
      </div>
      <ByProject data={data} />
    </>
  );
}

type Load = { data: StatsResponse | null; loading: boolean; error: string | null };

export function Stats() {
  const [chosen, setChosen] = useState<StatsFilter>(loadFilter);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectsSettled, setProjectsSettled] = useState(false);
  const [load, setLoad] = useState<Load>({ data: null, loading: true, error: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    api.projects().then(
      (p) => { if (live) { setProjects(p); setProjectsSettled(true); } },
      () => { if (live) setProjectsSettled(true); }, // without the list the stored filter is used as is
    );
    return () => { live = false; };
  }, []);

  const filter = effectiveStatsFilter(chosen, projects);
  const query = statsQueryString(filter);

  useEffect(() => {
    if (!projectsSettled) return;
    let live = true;
    // The previous result stays on screen (dimmed) until the new one arrives.
    setLoad((l) => ({ ...l, loading: true }));
    api.stats(query).then(
      (data) => { if (live) setLoad({ data, loading: false, error: null }); },
      (e: unknown) => { if (live) setLoad((l) => ({ data: l.data, loading: false, error: errorText(e) })); },
    );
    return () => { live = false; };
  }, [query, attempt, projectsSettled]);

  const change = (f: StatsFilter): void => {
    saveFilter(f);
    setChosen(f);
  };

  const projectNames = new Map<string, string>();
  for (const p of projects ?? []) projectNames.set(p.id, projectTitle(p));
  for (const p of load.data?.byProject ?? []) if (p.projectId !== null && !projectNames.has(p.projectId)) projectNames.set(p.projectId, p.name);

  const retry = <button type="button" className="notify-btn stats-retry" onClick={() => setAttempt((x) => x + 1)}>再试一次</button>;

  return (
    <div className="stats">
      <div className="stats-head">
        <h1>统计</h1>
        <p className="muted">
          {load.data !== null ? `${rangeLabel(load.data.range)} · ` : ''}所有会话合在一起看：时间花在哪、哪些调用最慢、哪些最常失败。
        </p>
      </div>
      <FilterRow filter={filter} projects={projects} onChange={change} />
      {load.data === null ? (
        load.error !== null
          ? <p className="error stats-state">加载失败：{load.error} {retry}</p>
          : <p className="muted stats-state">加载中…</p>
      ) : (
        <>
          {load.error !== null && <p className="error stats-state">刷新失败：{load.error}。下面是上一次的结果。{retry}</p>}
          {coverageNotes(load.data).map((line) => <p key={line} className="stats-note stats-coverage">{line}</p>)}
          <div className={`stats-body${load.loading ? ' is-loading' : ''}`} aria-busy={load.loading}>
            <StatsBody data={load.data} projectNames={projectNames} />
          </div>
        </>
      )}
    </div>
  );
}
