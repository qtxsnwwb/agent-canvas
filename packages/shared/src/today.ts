import type { Origin } from './model.js';
import type { StatsTokens } from './stats.js';

/** One origin's share of today (spec 2026-11-24-today-usage-design.md). */
export interface TodayOrigin {
  origin: Origin;
  turns: number;
  activeMs: number;
  /** null: the origin has no token data (the stats page's rule, over all entries). */
  tokens: StatsTokens | null;
}

export interface TodayUsage {
  /** `YYYY-MM-DD`, local. */
  day: string;
  /** ISO time of the computation (the block's "截至"). */
  asOf: string;
  turns: number;
  activeMs: number;
  /** null only when today has origins and none of them has token data. */
  tokens: StatsTokens | null;
  /** tokens.input + tokens.output (cache reads never count); null when tokens is null. */
  main: number | null;
  /** Origins with a turn or an extra today, ORIGINS order. */
  byOrigin: TodayOrigin[];
  /** Average over the 7 days before today of the main number up to the same time of day; null when no origin of those days has token data. */
  usualMain: number | null;
  /** Filled by TodayService (null: no line). */
  lineTokens: number | null;
  /** Filled by TodayService: main !== null && lineTokens !== null && main >= lineTokens. */
  over: boolean;
}
