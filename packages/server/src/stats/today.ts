import { ORIGINS, type Origin, type Session, type StatsTokens, type TodayOrigin, type TodayUsage } from '@agent-canvas/shared';
import { addDays, localDayKey } from './aggregate.js';
import { turnDurationMs, type SessionSummary } from './summary.js';

/**
 * Today's usage (spec 2026-11-24-today-usage-design.md, 3.1-3.3): a pure function of the summaries, the clock and the
 * day function, giving the numbers the stats page gives for today's `byDay` entry (range 7d), plus the "usual" figure.
 * Time of day is measured in minutes since the start of the local day, whose start is derived from `dayKey` itself
 * (the first minute with the same day key), so an injected day function carries its own notion of local time.
 */

const MIN = 60_000;

export function computeToday(
  entries: readonly { session: Session; summary: SessionSummary }[],
  nowMs: number,
  dayKey: (ms: number) => string = localDayKey,
): Omit<TodayUsage, 'lineTokens' | 'over'> {
  const today = dayKey(nowMs);

  // Token data is a property of all entries (the stats page's rule).
  const withSessions = new Set<Origin>();
  const withUsage = new Set<Origin>();
  for (const { session, summary } of entries) {
    withSessions.add(session.origin);
    if (summary.usageNodes > 0) withUsage.add(session.origin);
  }
  const noData = (o: Origin): boolean => withSessions.has(o) && !withUsage.has(o);

  // First whole minute of a local day (days are monotonic in time; a day starts within 26 h before any of its instants).
  const startCache = new Map<string, number>();
  const dayStartMin = (ms: number): number => {
    const day = dayKey(ms);
    const known = startCache.get(day);
    if (known !== undefined) return known;
    let hi = Math.floor(ms / MIN);
    let lo = hi - 26 * 60;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (dayKey(mid * MIN) === day) hi = mid;
      else lo = mid + 1;
    }
    startCache.set(day, lo);
    return lo;
  };
  const minuteOfDay = (ms: number): number => Math.floor(ms / MIN) - dayStartMin(ms);
  const nowMinute = minuteOfDay(nowMs);

  const first = addDays(today, -7);
  const acc = new Map<Origin, { turns: number; activeMs: number; input: number; cachedInput: number; output: number }>();
  let usualTotal = 0;
  let usualSeen = false;

  const book = (origin: Origin, atMs: number, input: number, output: number, cachedInput: number, turns: number, activeMs: number): void => {
    const day = dayKey(atMs);
    if (day === today) {
      let a = acc.get(origin);
      if (!a) acc.set(origin, (a = { turns: 0, activeMs: 0, input: 0, cachedInput: 0, output: 0 }));
      a.turns += turns;
      a.activeMs += activeMs;
      a.input += input;
      a.cachedInput += cachedInput;
      a.output += output;
    } else if (day >= first && day < today && !noData(origin)) {
      usualSeen = true;
      if (minuteOfDay(atMs) < nowMinute) usualTotal += input + output;
    }
  };

  for (const { session, summary } of entries) {
    for (const t of summary.turns) {
      if (t.dated) book(session.origin, t.startMs, t.inputTokens, t.outputTokens, t.cachedInputTokens, 1, turnDurationMs(t, nowMs));
    }
    for (const x of summary.extras) {
      if (x.dated) book(session.origin, x.atMs, x.inputTokens, x.outputTokens, x.cachedInputTokens, 0, 0);
    }
  }

  const byOrigin: TodayOrigin[] = [];
  let turns = 0;
  let activeMs = 0;
  const sum = { input: 0, cachedInput: 0, output: 0 };
  let anyData = acc.size === 0;
  for (const origin of ORIGINS) {
    const a = acc.get(origin);
    if (a === undefined) continue;
    const data = !noData(origin);
    byOrigin.push({
      origin, turns: a.turns, activeMs: a.activeMs,
      tokens: data ? { input: a.input, cachedInput: a.cachedInput, output: a.output } : null,
    });
    turns += a.turns;
    activeMs += a.activeMs;
    if (data) {
      anyData = true;
      sum.input += a.input;
      sum.cachedInput += a.cachedInput;
      sum.output += a.output;
    }
  }
  const tokens: StatsTokens | null = anyData ? sum : null;
  return {
    day: today,
    asOf: new Date(nowMs).toISOString(),
    turns,
    activeMs,
    tokens,
    main: tokens === null ? null : tokens.input + tokens.output,
    byOrigin,
    usualMain: usualSeen ? usualTotal / 7 : null,
  };
}
