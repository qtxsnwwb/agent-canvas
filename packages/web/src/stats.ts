/* Pure helpers for the stats page (pages/Stats.tsx): formatting, the per-day chart's scales and layout, the filter
   state, and small reads of the StatsResponse. No React, no DOM. */
import {
  ORIGINS, STATS_DEFAULT_RANGE, STATS_RANGES,
  type Origin, type Project, type StatsBucket, type StatsProject, type StatsRange, type StatsResponse, type StatsTokens,
  type StatsTool,
} from '@agent-canvas/shared';
import { formatTokens } from './canvas/replay';

const S = 1000;
const M = 60 * S;
const H = 60 * M;

/** Shown for a value that has no data (never 0, which would read like a measurement). */
export const NONE = '—';

const oneDecimal = (x: number): string => x.toFixed(1).replace(/\.0$/, '');
const grouped = (n: number): string => Math.round(n).toLocaleString('en-US');

// ---- formatting ----

/** A duration in friendly Chinese units: "350 毫秒", "4.2 秒", "3 分 5 秒", "2 小时 5 分"; "—" when unknown. */
export function formatSpan(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return NONE;
  if (ms === 0) return '0 秒';
  if (ms < S) return `${Math.round(ms)} 毫秒`;
  if (ms < 10 * S) return `${oneDecimal(Math.floor(ms / 100) / 10)} 秒`;
  const sec = Math.floor(ms / S);
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) {
    const s = sec % 60;
    return s === 0 ? `${Math.floor(sec / 60)} 分` : `${Math.floor(sec / 60)} 分 ${s} 秒`;
  }
  const h = Math.floor(sec / 3600);
  if (h >= 100) return `${grouped(h)} 小时`;
  const m = Math.floor((sec % 3600) / 60);
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}

/** A count: "12,345", then "12.3 万" from 100,000; "—" when unknown. */
export function formatCount(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return NONE;
  if (Math.abs(n) < 100_000) return grouped(n);
  return `${oneDecimal(n / 10_000)} 万`;
}

/** A 0..1 rate as a percentage; "—" when there is no denominator. */
export function formatRate(r: number | null): string {
  if (r === null || !Number.isFinite(r)) return NONE;
  if (r === 0) return '0%';
  if (r < 0.001) return '<0.1%';
  if (r < 0.1) return `${oneDecimal(r * 100)}%`;
  return `${Math.round(r * 100)}%`;
}

/** An average (per turn): one decimal at most. */
export function formatAvg(n: number | null): string {
  return n === null || !Number.isFinite(n) ? NONE : oneDecimal(n);
}

/** Tokens as on the session page's timeline ("950", "12.3k", "1.3M"); "—" when there is no data. */
export function formatTokenCount(n: number | null): string {
  return n === null || !Number.isFinite(n) ? NONE : formatTokens(n);
}

/** The three token categories, in the order every place shows them (the session page names them the same way). */
export const TOKEN_PARTS: readonly { key: keyof StatsTokens; label: string; short: string }[] = [
  { key: 'input', label: '新输入', short: '新' },
  { key: 'cachedInput', label: '缓存读取', short: '缓存' },
  { key: 'output', label: '输出', short: '出' },
];

/** One line under token tables: what the three categories mean, and that Cursor has none. */
export const TOKEN_CAPTION =
  'token 分三类：新输入 = 没从缓存读的输入（含写入缓存的），缓存读取 = 从缓存读的输入，输出含推理；Cursor 没有 token 数据，显示“—”。';

/** One cell per category (TOKEN_PARTS order); "—" each when there is no data. */
export function tokenCells(t: StatsTokens | null): string[] {
  return TOKEN_PARTS.map((p) => (t === null ? NONE : formatTokenCount(t[p.key])));
}

/** "新输入 1.5k · 缓存读取 2.4M · 输出 200" (tooltips, screen readers), or "—". */
export function formatTokenTriple(t: StatsTokens | null): string {
  if (t === null) return NONE;
  return TOKEN_PARTS.map((p) => `${p.label} ${formatTokenCount(t[p.key])}`).join(' · ');
}

function dayParts(day: string): [number, number, number] {
  const [y, m, d] = day.split('-').map(Number);
  return [y ?? 0, m ?? 1, d ?? 1];
}

/** "11/2": the per-day chart's x labels. */
export function dayLabel(day: string): string {
  const [, m, d] = dayParts(day);
  return `${m}/${d}`;
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const;

/** "2026-11-12 周四": the tooltip's date. Computed on the calendar date itself, so no time zone gets in the way. */
export function dayLong(day: string): string {
  const [y, m, d] = dayParts(day);
  return `${day} 周${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}`;
}

// ---- the series' bucket (StatsResponse.bucket: a day, or a Monday-based week dated by its Monday) ----

/** The bucket of byDay; a server without the field sends days. */
export function seriesBucket(r: Pick<StatsResponse, 'bucket'>): StatsBucket {
  return r.bucket ?? 'day';
}

export function seriesTitle(bucket: StatsBucket): string {
  return bucket === 'week' ? '每周的活跃时长' : '每天的活跃时长';
}

/** The x label of a bucket: its day, or its week's Monday ("11/9"). */
export function bucketLabel(day: string, _bucket: StatsBucket): string {
  return dayLabel(day);
}

/** The tooltip / table date: "2026-11-12 周四", or "2026-11-09 至 11/15 这一周" (the year repeated when it changes). */
export function bucketLong(day: string, bucket: StatsBucket): string {
  if (bucket === 'day') return dayLong(day);
  const [y, m, d] = dayParts(day);
  const end = new Date(Date.UTC(y, m - 1, d + 6));
  const endText = end.getUTCFullYear() === y
    ? `${end.getUTCMonth() + 1}/${end.getUTCDate()}`
    : end.toISOString().slice(0, 10);
  return `${day} 至 ${endText} 这一周`;
}

/** The covered days, for the line under the page title. */
export function rangeLabel(range: StatsResponse['range']): string {
  if (range.from === null) return `截至 ${range.to}`;
  return range.from === range.to ? range.to : `${range.from} 至 ${range.to}`;
}

// ---- the per-day chart ----

const NICE_STEPS = [
  S, 2 * S, 5 * S, 10 * S, 15 * S, 30 * S,
  M, 2 * M, 5 * M, 10 * M, 15 * M, 30 * M,
  H, 2 * H, 3 * H, 4 * H, 6 * H, 12 * H, 24 * H,
] as const;

/** The duration axis: a clean step, from 0 up to the first multiple covering `maxMs`, at most 4 intervals. */
export function durationTicks(maxMs: number, intervals = 4): { step: number; max: number; ticks: number[] } {
  const v = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : 0;
  if (v === 0) return { step: M, max: M, ticks: [0, M] };
  let step: number | undefined = NICE_STEPS.find((s) => Math.ceil(v / s) <= intervals);
  // Beyond a day per column (only with odd data): 1-2-5 steps in hours.
  for (let mag = 10; step === undefined; mag *= 10) {
    step = [5 * mag, 10 * mag, 20 * mag].map((h) => h * H).find((s) => Math.ceil(v / s) <= intervals);
  }
  const n = Math.max(1, Math.ceil(v / step));
  return { step, max: n * step, ticks: Array.from({ length: n + 1 }, (_, i) => i * step!) };
}

/** A y tick label: seconds when the step is under a minute, minutes under an hour, then hours ("1.5 小时"). */
export function durationTickLabel(v: number, step: number): string {
  if (v === 0) return '0';
  if (step < M) return `${oneDecimal(v / S)} 秒`;
  if (v < H) return `${oneDecimal(v / M)} 分`;
  return `${oneDecimal(v / H)} 小时`;
}

export interface ColumnLayout {
  /** Number of days. */
  count: number;
  /** Width of one day's slot. */
  band: number;
  /** Width of the drawn column: at most 24 px, leaving at least a 2 px gap where the slot allows. */
  barWidth: number;
  /** Left edge of day `i`'s column, relative to the plot's left edge. */
  x(i: number): number;
}

export function columnLayout(n: number, plotWidth: number): ColumnLayout {
  const band = n > 0 ? plotWidth / n : plotWidth;
  const barWidth = Math.max(1, Math.min(24, band * 0.7, band - 2));
  return { count: n, band, barWidth, x: (i) => i * band + (band - barWidth) / 2 };
}

/** The day slot under a pointer x (relative to the plot's left edge), clamped to the range. */
export function dayIndexAt(x: number, layout: ColumnLayout): number {
  return Math.max(0, Math.min(layout.count - 1, Math.floor(x / layout.band)));
}

const LABEL_STEPS: Record<StatsBucket, readonly number[]> = {
  day: [1, 2, 3, 7, 14, 28, 56, 91, 182, 366],
  week: [1, 2, 4, 8, 13, 26, 52, 104],
};

/** Label every k-th bucket (day or week) so that labels `labelWidth` wide never collide. */
export function labelEvery(n: number, plotWidth: number, labelWidth: number, bucket: StatsBucket = 'day'): number {
  if (n <= 0 || plotWidth <= 0) return 1;
  const band = plotWidth / n;
  return LABEL_STEPS[bucket].find((k) => k * band >= labelWidth) ?? Math.ceil(labelWidth / band);
}

/** Which days get a label: every k-th counting back from the last (today is always labelled). */
export function labelIndices(n: number, k: number): number[] {
  const out: number[] = [];
  for (let i = (n - 1) % k; i < n; i += k) if (i >= 0) out.push(i);
  return out;
}

export interface StackSegment {
  /** Index of the value (the series) this segment draws. */
  index: number;
  /** Drawn top and height: a non-top segment gives up `gap` px at its top to the surface gap. */
  y: number;
  height: number;
  /** The highest segment of the stack: it carries the rounded data end. */
  top: boolean;
  /** The segment's full extent (top, bottom) before the gap: the tooltip's hit test. */
  y0: number;
  y1: number;
}

/** Stacks `values` bottom-up from `baseY` (SVG y grows downward), `pxPerUnit` px per unit; zero values draw nothing. */
export function stackSegments(values: readonly number[], pxPerUnit: number, baseY: number, gap = 2): StackSegment[] {
  let topIndex = -1;
  values.forEach((v, i) => { if (v > 0) topIndex = i; });
  const out: StackSegment[] = [];
  let cum = 0;
  values.forEach((v, index) => {
    if (!(v > 0)) return;
    const y1 = baseY - cum * pxPerUnit;
    cum += v;
    const y0 = baseY - cum * pxPerUnit;
    const top = index === topIndex;
    const cut = top ? 0 : gap;
    const height = Math.max(0, y1 - y0 - cut);
    out.push({ index, y: y1 - height, height, top, y0, y1 });
  });
  return out;
}

/** A column with its data end (the top) rounded by `r` px and square at the baseline. '' for nothing to draw. */
export function roundedEndRect(x: number, y: number, w: number, h: number, r: number): string {
  if (!(w > 0) || !(h > 0)) return '';
  const k = Math.min(r, w / 2, h);
  const n = (v: number): string => String(Math.round(v * 100) / 100);
  return `M${n(x)} ${n(y + h)}V${n(y + k)}A${n(k)} ${n(k)} 0 0 1 ${n(x + k)} ${n(y)}H${n(x + w - k)}`
    + `A${n(k)} ${n(k)} 0 0 1 ${n(x + w)} ${n(y + k)}V${n(y + h)}Z`;
}

// ---- filter state ----

export type StatsOriginFilter = 'all' | Origin;
export interface StatsFilter {
  range: StatsRange;
  origin: StatsOriginFilter;
  /** null = every project. */
  projectId: string | null;
}

/** Remembered in this browser, like the home page's origin filter. */
export const STATS_FILTER_KEY = 'agent-canvas.stats';
export const DEFAULT_STATS_FILTER: StatsFilter = { range: STATS_DEFAULT_RANGE, origin: 'all', projectId: null };

export const STATS_RANGE_OPTIONS: readonly { value: StatsRange; label: string }[] = [
  { value: '7d', label: '最近 7 天' },
  { value: '30d', label: '最近 30 天' },
  { value: 'all', label: '全部' },
];

/** A stored filter; each unknown or malformed part falls back to its default. */
export function parseStatsFilter(raw: string | null): StatsFilter {
  if (raw === null) return { ...DEFAULT_STATS_FILTER };
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return { ...DEFAULT_STATS_FILTER }; }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ...DEFAULT_STATS_FILTER };
  const o = v as Record<string, unknown>;
  const range = (STATS_RANGES as readonly unknown[]).includes(o.range) ? (o.range as StatsRange) : DEFAULT_STATS_FILTER.range;
  const origin = o.origin === 'all' || (ORIGINS as readonly unknown[]).includes(o.origin) ? (o.origin as StatsOriginFilter) : 'all';
  const projectId = typeof o.projectId === 'string' && o.projectId !== '' ? o.projectId : null;
  return { range, origin, projectId };
}

export function serializeStatsFilter(f: StatsFilter): string {
  return JSON.stringify({ range: f.range, origin: f.origin, projectId: f.projectId });
}

/** The `/api/stats` query: the range always, origin and project only when filtered. */
export function statsQueryString(f: StatsFilter): string {
  const parts = [`range=${encodeURIComponent(f.range)}`];
  if (f.origin !== 'all') parts.push(`origin=${encodeURIComponent(f.origin)}`);
  if (f.projectId !== null) parts.push(`projectId=${encodeURIComponent(f.projectId)}`);
  return parts.join('&');
}

/** The origins some project has, in the fixed order. */
export function availableOrigins(projects: readonly Project[]): Origin[] {
  const seen = new Set(projects.flatMap((p) => p.origins));
  return ORIGINS.filter((o) => seen.has(o));
}

/**
 * The filter in force: an origin that no project has (or any origin while only one exists, when the switch is hidden)
 * becomes 全部, a project that no longer exists becomes 全部项目. Before the project list has loaded (`null`) the stored
 * choice is used as is.
 */
export function effectiveStatsFilter(f: StatsFilter, projects: readonly Project[] | null): StatsFilter {
  if (projects === null) return f;
  const origins = availableOrigins(projects);
  const origin = f.origin !== 'all' && origins.length > 1 && origins.includes(f.origin) ? f.origin : 'all';
  const projectId = f.projectId !== null && projects.some((p) => p.id === f.projectId) ? f.projectId : null;
  return { range: f.range, origin, projectId };
}

// ---- reading the response ----

/** The first `n` tools, and what the rest add up to (from the totals, so tools beyond the API's top 30 count too). */
export function splitTools(
  tools: readonly StatsTool[], n: number, totals: { toolMs: number; toolCalls: number },
): { shown: StatsTool[]; rest: { ms: number; calls: number } | null } {
  const shown = tools.slice(0, n);
  if (tools.length <= n) return { shown, rest: null };
  const ms = Math.max(0, totals.toolMs - shown.reduce((s, t) => s + t.totalMs, 0));
  const calls = Math.max(0, totals.toolCalls - shown.reduce((s, t) => s + t.calls, 0));
  return { shown, rest: { ms, calls } };
}

/** Origins on screen that have no token data at all (the API's list covers the whole dataset). */
export function shownNoTokenOrigins(r: Pick<StatsResponse, 'coverage' | 'byOrigin'>): Origin[] {
  const shown = new Set(r.byOrigin.map((o) => o.origin));
  return ORIGINS.filter((o) => shown.has(o) && r.coverage.noTokenData.includes(o));
}

/** Lines about how complete the numbers are: still importing, turns without a usable time, sessions skipped. */
export function coverageNotes(r: Pick<StatsResponse, 'coverage'>): string[] {
  const c = r.coverage;
  const out: string[] = [];
  if (c.importing === true) out.push('数据还在导入，数字会继续变化。');
  if ((c.undatedTurns ?? 0) > 0) out.push(`有 ${formatCount(c.undatedTurns!)} 个轮次的开始时间无法识别，没有算进任何数字。`);
  if (c.failedSessions > 0) out.push(`有 ${formatCount(c.failedSessions)} 个会话算不出来，已跳过。`);
  return out;
}

/** Nothing happened in the range under the filters. */
export function isEmptyStats(r: Pick<StatsResponse, 'totals'>): boolean {
  return r.totals.sessions === 0 && r.totals.turns === 0 && r.totals.toolCalls === 0;
}

/** A per-project row's name; the merged row says how many projects it holds. */
export function projectRowName(p: Pick<StatsProject, 'projectId' | 'name' | 'projectCount'>): string {
  return p.projectId === null ? `其他（${p.projectCount} 个项目）` : p.name;
}

/** The session page of a session. */
export function sessionHref(sessionId: string): string {
  return `#/s/${encodeURIComponent(sessionId)}`;
}
