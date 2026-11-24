import type { CompareResponse } from '@agent-canvas/shared';
import type { SessionFilesSummary } from '../files/summary.js';
import type { SessionSummaryCache } from '../stats/session-cache.js';
import type { SessionSummary } from '../stats/summary.js';
import { buildCompare, type CompareInput } from './compare.js';

const one = (v: unknown): v is string | undefined => v === undefined || typeof v === 'string';

/** The query string of GET /api/compare: `a` and `b`, each a non-empty session id given once (400 otherwise). */
export function parseCompareQuery(query: Record<string, unknown>): { a: string; b: string } | { error: string } {
  const { a, b } = query;
  for (const [name, v] of Object.entries({ a, b })) {
    if (!one(v)) return { error: `${name} must be given once` };
    if (v === undefined || v === '') return { error: `${name} is required (a session id)` };
  }
  return { a: a as string, b: b as string };
}

export interface CompareServiceDeps {
  /** The stats page's summary cache (StatsService.summaryCache()). */
  stats: SessionSummaryCache<SessionSummary>;
  /**
   * The file page's summary cache (FilesService.summaryCache()), sharing reads with `stats` (as buildServer links them):
   * the stats read of a session builds its file summary too, so a session is read once.
   */
  files: SessionSummaryCache<SessionFilesSummary>;
  now?: () => number;
}

/**
 * The service behind GET /api/compare: each side from the two caches' single-session reads (`one()`: the cached summary
 * while the session is unchanged, else one paged read), never the whole graph. An unknown id gives a null side.
 */
export class CompareService {
  private readonly now: () => number;

  constructor(private readonly deps: CompareServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  private async side(sessionId: string): Promise<CompareInput | null> {
    const stats = await this.deps.stats.one(sessionId);
    if (stats === null) return null;
    // After the stats read (when there was one) the file summary is usually cached: no second read.
    const files = await this.deps.files.one(sessionId);
    return { session: stats.session, summary: stats.summary, files: files?.summary ?? null };
  }

  async compare(a: string, b: string): Promise<CompareResponse> {
    const [left, right] = await Promise.all([this.side(a), this.side(b)]);
    return buildCompare(left, right, { sameSession: a === b, nowMs: this.now() });
  }
}
