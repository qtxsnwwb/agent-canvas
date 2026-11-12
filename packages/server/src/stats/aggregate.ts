import {
  ORIGINS,
  projectDisplayName,
  STATS_BY_DAY_MAX,
  STATS_MOST_FAILING,
  STATS_MOST_FAILING_MIN_CALLS,
  STATS_SLOWEST,
  STATS_TOP_PROJECTS,
  STATS_TOP_TOOLS,
  STATS_WEEKLY_AFTER_DAYS,
  type Origin,
  type Project,
  type Session,
  type StatsBucket,
  type StatsDay,
  type StatsFailingTool,
  type StatsMeasures,
  type StatsOrigin,
  type StatsProject,
  type StatsRange,
  type StatsResponse,
  type StatsSlowCall,
  type StatsTokens,
  type StatsTool,
} from '@agent-canvas/shared';
import { turnDurationMs, type SessionSummary } from './summary.js';

/**
 * Aggregation of session summaries into a StatsResponse: a pure function of the summaries, the range, the filters, the
 * clock and the day function (see StatsResponse in shared for every field's meaning).
 */

export interface AggregateInput {
  /** Every session with its summary (all of them, unfiltered: noTokenData looks at the whole dataset). */
  entries: { session: Session; summary: SessionSummary }[];
  /** Sessions whose summary could not be computed (reported in coverage). */
  failedSessions: number;
  /** For project names (projectDisplayName); a project not listed is named after its id. */
  projects: Pick<Project, 'id' | 'cwd'>[];
  range: StatsRange;
  origin: Origin | null;
  projectId: string | null;
  nowMs: number;
  /** Local day (`YYYY-MM-DD`) of a time. */
  dayKey: (ms: number) => string;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** `YYYY-MM-DD` of `ms` in the local time zone of this process. */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayIndex(key: string): number {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}
function dayOfIndex(i: number): string {
  const t = new Date(i * 86_400_000);
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Calendar arithmetic on a day key (no time zone involved). */
export function addDays(key: string, days: number): string {
  return dayOfIndex(dayIndex(key) + days);
}

/** The Monday starting the week of a day key (calendar arithmetic; day index 0, 1970-01-01, was a Thursday). */
export function weekStart(key: string): string {
  const i = dayIndex(key);
  return dayOfIndex(i - (((i + 3) % 7) + 7) % 7);
}

/** Nearest-rank percentile of ascending `sorted`; null when empty. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

interface Acc {
  sessions: Set<string>;
  turns: number;
  activeMs: number;
  toolCalls: number;
  finished: number;
  failed: number;
  toolMs: number;
  input: number;
  cachedInput: number;
  output: number;
  /** Origins that contributed activity. */
  origins: Set<Origin>;
}
const newAcc = (): Acc => ({
  sessions: new Set(), turns: 0, activeMs: 0, toolCalls: 0, finished: 0, failed: 0, toolMs: 0, input: 0, cachedInput: 0, output: 0, origins: new Set(),
});

interface Part {
  turns: number;
  activeMs: number;
  toolCalls: number;
  finished: number;
  failed: number;
  toolMs: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

function add(acc: Acc, sessionId: string, origin: Origin, part: Part, turns: number, activeMs: number): void {
  acc.sessions.add(sessionId);
  acc.origins.add(origin);
  acc.turns += turns;
  acc.activeMs += activeMs;
  acc.toolCalls += part.toolCalls;
  acc.finished += part.finished;
  acc.failed += part.failed;
  acc.toolMs += part.toolMs;
  acc.input += part.inputTokens;
  acc.cachedInput += part.cachedInputTokens;
  acc.output += part.outputTokens;
}
function merge(into: Acc, from: Acc): void {
  for (const s of from.sessions) into.sessions.add(s);
  for (const o of from.origins) into.origins.add(o);
  into.turns += from.turns;
  into.activeMs += from.activeMs;
  into.toolCalls += from.toolCalls;
  into.finished += from.finished;
  into.failed += from.failed;
  into.toolMs += from.toolMs;
  into.input += from.input;
  into.cachedInput += from.cachedInput;
  into.output += from.output;
}

const tokensOf = (acc: Acc): StatsTokens => ({ input: acc.input, cachedInput: acc.cachedInput, output: acc.output });

const rate = (failed: number, finished: number): number | null => (finished > 0 ? failed / finished : null);

function measures(acc: Acc, noData: ReadonlySet<Origin>): StatsMeasures {
  const hasData = [...acc.origins].some((o) => !noData.has(o));
  return {
    sessions: acc.sessions.size,
    turns: acc.turns,
    activeMs: acc.activeMs,
    toolCalls: acc.toolCalls,
    finished: acc.finished,
    failed: acc.failed,
    failureRate: rate(acc.failed, acc.finished),
    toolMs: acc.toolMs,
    tokens: hasData ? tokensOf(acc) : null,
  };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const bySlowest = (a: StatsSlowCall, b: StatsSlowCall): number =>
  b.durationMs - a.durationMs || cmp(a.sessionId, b.sessionId) || cmp(a.nodeId, b.nodeId);

interface ToolAcc { origin: Origin; toolName: string; calls: number; finished: number; failed: number; durations: number[] }

export function aggregateStats(input: AggregateInput): StatsResponse {
  const { range, nowMs, dayKey } = input;
  const today = dayKey(nowMs);
  const from = range === '7d' ? addDays(today, -6) : range === '30d' ? addDays(today, -29) : null;
  const inRange = (day: string): boolean => day <= today && (from === null || day >= from);

  // Token data is a property of the whole dataset, not of the range or the filters.
  const withSessions = new Set<Origin>();
  const withUsage = new Set<Origin>();
  for (const { session, summary } of input.entries) {
    withSessions.add(session.origin);
    if (summary.usageNodes > 0) withUsage.add(session.origin);
  }
  const noTokenData = ORIGINS.filter((o) => withSessions.has(o) && !withUsage.has(o));
  const noData = new Set(noTokenData);

  const totals = newAcc();
  const byOrigin = new Map<Origin, Acc>();
  const turnDurations = new Map<Origin, number[]>();
  const byProject = new Map<string, Acc>();
  const byDay = new Map<string, Map<Origin, Acc>>();
  const tools = new Map<string, ToolAcc>();
  const slow: StatsSlowCall[] = [];
  /** Turns and extras in scope without a usable time: in no day, no range, no number. */
  let undated = 0;
  /** Earliest active day in scope, any range (set inside `record`). */
  const active: { first: string | null } = { first: null };

  const accOf = <K>(map: Map<K, Acc>, key: K): Acc => {
    let acc = map.get(key);
    if (!acc) map.set(key, (acc = newAcc()));
    return acc;
  };
  const record = (session: Session, day: string, part: Part, turns: number, activeMs: number): void => {
    if (active.first === null || day < active.first) active.first = day;
    if (!inRange(day)) return;
    const { id, origin, projectId } = session;
    add(totals, id, origin, part, turns, activeMs);
    add(accOf(byOrigin, origin), id, origin, part, turns, activeMs);
    add(accOf(byProject, projectId), id, origin, part, turns, activeMs);
    let d = byDay.get(day);
    if (!d) byDay.set(day, (d = new Map()));
    add(accOf(d, origin), id, origin, part, turns, activeMs);
  };

  for (const { session, summary } of input.entries) {
    if (input.origin !== null && session.origin !== input.origin) continue;
    if (input.projectId !== null && session.projectId !== input.projectId) continue;
    const turnIn: boolean[] = [];
    for (const t of summary.turns) {
      if (!t.dated) {
        undated++;
        turnIn.push(false);
        continue;
      }
      const day = dayKey(t.startMs);
      const duration = turnDurationMs(t, nowMs);
      const part: Part = { ...t, turns: 1, activeMs: duration };
      record(session, day, part, 1, duration);
      turnIn.push(inRange(day));
      if (inRange(day)) {
        let list = turnDurations.get(session.origin);
        if (!list) turnDurations.set(session.origin, (list = []));
        list.push(duration);
      }
    }
    for (const x of summary.extras) {
      if (x.dated) record(session, dayKey(x.atMs), { ...x, turns: 0, activeMs: 0 }, 0, 0);
      else undated++;
    }
    for (const c of summary.calls) {
      if (!(c.turn >= 0 ? turnIn[c.turn] : c.atMs > 0 && inRange(dayKey(c.atMs)))) continue;
      const key = `${session.origin}\u0000${c.toolName}`;
      let tool = tools.get(key);
      if (!tool) tools.set(key, (tool = { origin: session.origin, toolName: c.toolName, calls: 0, finished: 0, failed: 0, durations: [] }));
      tool.calls++;
      if (c.finished) tool.finished++;
      if (c.failed) tool.failed++;
      if (c.durationMs !== null) {
        tool.durations.push(c.durationMs);
        // Bounded top-k: only a call that beats the current 10th is materialized.
        if (slow.length < STATS_SLOWEST || c.durationMs >= slow[slow.length - 1]!.durationMs) {
          slow.push({
            sessionId: session.id, nodeId: c.nodeId, projectId: session.projectId, origin: session.origin, toolName: c.toolName,
            durationMs: c.durationMs, startedAt: Number.isFinite(c.atMs) ? new Date(c.atMs).toISOString() : '',
          });
          slow.sort(bySlowest);
          if (slow.length > STATS_SLOWEST) slow.pop();
        }
      }
    }
  }

  const origins = ORIGINS.filter((o) => (byOrigin.get(o)?.sessions.size ?? 0) > 0);

  // The series: every day of the range; for `all`, from the first active day, by week beyond
  // STATS_WEEKLY_AFTER_DAYS days; at most the most recent STATS_BY_DAY_MAX entries.
  let rangeFrom: string | null = from;
  let bucket: StatsBucket = 'day';
  if (range === 'all') {
    rangeFrom = active.first !== null && active.first <= today ? active.first : null;
    if (rangeFrom !== null && dayIndex(today) - dayIndex(rangeFrom) + 1 > STATS_WEEKLY_AFTER_DAYS) bucket = 'week';
  }
  const step = bucket === 'week' ? 7 : 1;
  const seriesEnd = bucket === 'week' ? weekStart(today) : today;
  let seriesFrom = rangeFrom === null ? null : bucket === 'week' ? weekStart(rangeFrom) : rangeFrom;
  let byDayTruncated = false;
  if (seriesFrom !== null && (dayIndex(seriesEnd) - dayIndex(seriesFrom)) / step + 1 > STATS_BY_DAY_MAX) {
    seriesFrom = addDays(seriesEnd, -(STATS_BY_DAY_MAX - 1) * step);
    byDayTruncated = true;
  }
  const days: StatsDay[] = [];
  if (seriesFrom !== null) {
    for (let i = dayIndex(seriesFrom), end = dayIndex(seriesEnd); i <= end; i += step) {
      const day = dayOfIndex(i);
      // The bucket's days (only days in range carry data: byDay holds nothing else).
      const perDay = Array.from({ length: step }, (_, k) => byDay.get(dayOfIndex(i + k)));
      const all = newAcc();
      const parts = origins.map((origin) => {
        const acc = newAcc();
        for (const d of perDay) {
          const part = d?.get(origin);
          if (part !== undefined) merge(acc, part);
        }
        merge(all, acc);
        return {
          origin, turns: acc.turns, activeMs: acc.activeMs, toolCalls: acc.toolCalls, failed: acc.failed, toolMs: acc.toolMs,
          tokens: noData.has(origin) ? null : tokensOf(acc),
        };
      });
      const hasData = origins.some((o) => !noData.has(o));
      days.push({
        day, turns: all.turns, activeMs: all.activeMs, toolCalls: all.toolCalls, failed: all.failed, toolMs: all.toolMs,
        tokens: hasData ? tokensOf(all) : null, byOrigin: parts,
      });
    }
  }

  const originRows: StatsOrigin[] = origins.map((origin) => {
    const m = measures(byOrigin.get(origin)!, noData);
    const durations = (turnDurations.get(origin) ?? []).sort((a, b) => a - b);
    return {
      origin, ...m,
      medianTurnMs: percentile(durations, 50),
      avgToolCallsPerTurn: m.turns > 0 ? m.toolCalls / m.turns : null,
      avgTokensPerTurn: m.tokens !== null && m.turns > 0
        ? { input: m.tokens.input / m.turns, cachedInput: m.tokens.cachedInput / m.turns, output: m.tokens.output / m.turns }
        : null,
    };
  });

  const projectCwd = new Map(input.projects.map((p) => [p.id, p.cwd]));
  const projectRows = [...byProject]
    .map(([id, acc]) => ({ id, acc, name: projectDisplayName({ id, cwd: projectCwd.get(id) ?? null }) }))
    .sort((a, b) => b.acc.activeMs - a.acc.activeMs || cmp(a.name, b.name) || cmp(a.id, b.id));
  const byProjectRows: StatsProject[] = projectRows
    .slice(0, STATS_TOP_PROJECTS)
    .map((p) => ({ projectId: p.id, name: p.name, projectCount: 1, ...measures(p.acc, noData) }));
  if (projectRows.length > STATS_TOP_PROJECTS) {
    const rest = newAcc();
    for (const p of projectRows.slice(STATS_TOP_PROJECTS)) merge(rest, p.acc);
    byProjectRows.push({ projectId: null, name: '其他', projectCount: projectRows.length - STATS_TOP_PROJECTS, ...measures(rest, noData) });
  }

  const toolRows: StatsTool[] = [...tools.values()].map((t) => {
    const sorted = t.durations.sort((a, b) => a - b);
    return {
      origin: t.origin, toolName: t.toolName, calls: t.calls, finished: t.finished, failed: t.failed,
      failureRate: rate(t.failed, t.finished), timedCalls: sorted.length, totalMs: sorted.reduce((a, b) => a + b, 0),
      medianMs: percentile(sorted, 50), p95Ms: percentile(sorted, 95),
    };
  });
  const byTool = [...toolRows]
    .sort((a, b) => b.totalMs - a.totalMs || b.calls - a.calls || cmp(a.origin, b.origin) || cmp(a.toolName, b.toolName))
    .slice(0, STATS_TOP_TOOLS);
  const mostFailing: StatsFailingTool[] = toolRows
    .filter((t) => t.failed > 0 && t.calls >= STATS_MOST_FAILING_MIN_CALLS)
    .sort((a, b) => b.failed - a.failed || (b.failureRate ?? 0) - (a.failureRate ?? 0) || cmp(a.origin, b.origin) || cmp(a.toolName, b.toolName))
    .slice(0, STATS_MOST_FAILING)
    .map(({ origin, toolName, calls, finished, failed, failureRate }) => ({ origin, toolName, calls, finished, failed, failureRate }));
  const slowest = slow;

  return {
    generatedAt: new Date(nowMs).toISOString(),
    range: { range, from: rangeFrom, to: today },
    filters: { origin: input.origin, projectId: input.projectId },
    totals: measures(totals, noData),
    byDay: days,
    bucket,
    byOrigin: originRows,
    byProject: byProjectRows,
    byTool,
    slowest,
    mostFailing,
    coverage: {
      sessionsByOrigin: originRows.map((o) => ({ origin: o.origin, sessions: o.sessions })),
      noTokenData,
      failedSessions: input.failedSessions,
      firstActiveDay: active.first,
      byDayTruncated,
      undatedTurns: undated,
    },
  };
}
