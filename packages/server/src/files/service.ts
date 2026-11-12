import {
  FILES_DEFAULT_LIMIT,
  FILES_DEFAULT_RANGE,
  FILES_DEFAULT_SORT,
  FILES_LIMIT_MAX,
  FILES_QUERY_MAX,
  FILES_RANGES,
  FILES_SORTS,
  ORIGINS,
  type FilesRange,
  type FilesSort,
  type Origin,
  type ProjectFilesResponse,
  type SeqChange,
  type SessionFilesResponse,
} from '@agent-canvas/shared';
import { SessionSummaryCache } from '../stats/session-cache.js';
import { STATS_CACHE_CAPACITY, STATS_YIELD_AFTER_MS, type StatsSource } from '../stats/service.js';
import { aggregateProjectFiles, rangeStartMs } from './aggregate.js';
import { sessionFilesResponse, summarizeSessionFiles, type SessionFilesSummary } from './summary.js';

/** What the file service reads: the same as the stats service (storeStatsSource: paged node reads). */
export type FilesSource = StatsSource;

const CLOSED = 'files service closed';

/**
 * Most touches (SummaryTouch, ≈150 B each) kept over all cached file summaries: ≈150 MB worst case. The real dataset has
 * ≈45,000.
 */
export const FILES_CACHE_MAX_TOUCHES = 1_000_000;

export interface FilesQuery {
  projectId: string;
  origin: Origin | null;
  range: FilesRange;
  changedOnly: boolean;
  q: string | null;
  sort: FilesSort;
  limit: number;
}

const one = (v: unknown): v is string | undefined => v === undefined || typeof v === 'string';

/**
 * The query string of GET /api/files. projectId is required; origin ('' = any), range (default `all`), changedOnly
 * (`1` / `0`, default `1`), q (at most FILES_QUERY_MAX characters; '' = none), sort (default `recent`), limit (a positive
 * integer, default FILES_DEFAULT_LIMIT; above FILES_LIMIT_MAX it is clamped). Anything else, or a repeated parameter, is
 * an error (400). An unknown projectId is not (empty result).
 */
export function parseFilesQuery(query: Record<string, unknown>): FilesQuery | { error: string } {
  const { projectId, origin, range, changedOnly, q, sort, limit } = query;
  for (const [name, v] of Object.entries({ projectId, origin, range, changedOnly, q, sort, limit })) {
    if (!one(v)) return { error: `${name} must be given once` };
  }
  if (typeof projectId !== 'string' || projectId === '') return { error: 'projectId is required' };
  if (origin !== undefined && origin !== '' && !(ORIGINS as readonly string[]).includes(origin as string)) {
    return { error: `unknown origin (expected ${ORIGINS.join(', ')})` };
  }
  if (range !== undefined && !(FILES_RANGES as readonly string[]).includes(range as string)) {
    return { error: `unknown range (expected ${FILES_RANGES.join(', ')})` };
  }
  if (changedOnly !== undefined && changedOnly !== '1' && changedOnly !== '0') return { error: 'changedOnly must be 1 or 0' };
  if (typeof q === 'string' && q.length > FILES_QUERY_MAX) return { error: `q is longer than ${FILES_QUERY_MAX} characters` };
  if (sort !== undefined && !(FILES_SORTS as readonly string[]).includes(sort as string)) {
    return { error: `unknown sort (expected ${FILES_SORTS.join(', ')})` };
  }
  let parsedLimit = FILES_DEFAULT_LIMIT;
  if (limit !== undefined) {
    if (!/^\s*\d+\s*$/.test(limit as string) || Number(limit) < 1) return { error: 'limit must be a positive integer' };
    parsedLimit = Math.min(FILES_LIMIT_MAX, Number(limit));
  }
  return {
    projectId,
    origin: origin === undefined || origin === '' ? null : (origin as Origin),
    range: (range as FilesRange | undefined) ?? FILES_DEFAULT_RANGE,
    changedOnly: changedOnly !== '0',
    q: q === undefined || q === '' ? null : (q as string),
    sort: (sort as FilesSort | undefined) ?? FILES_DEFAULT_SORT,
    limit: parsedLimit,
  };
}

export interface FilesServiceOptions {
  /** Most session file summaries kept (least recently used evicted). Default STATS_CACHE_CAPACITY. */
  capacity?: number;
  /** Most touches kept over all summaries. Default FILES_CACHE_MAX_TOUCHES. */
  maxTouches?: number;
  now?: () => number;
  yieldAfterMs?: number;
}

/**
 * The service behind the file routes: per-session file summaries in a SessionSummaryCache (the stats service's design,
 * see session-cache.ts: cached by session + change marker, invalidated through noteChanges, concurrent requests
 * sharing one refresh, LRU-bounded, paged reads that yield), aggregated per request.
 */
export class FilesService {
  private readonly cache: SessionSummaryCache<SessionFilesSummary>;
  private readonly now: () => number;

  constructor(private readonly source: FilesSource, options: FilesServiceOptions = {}) {
    this.cache = new SessionSummaryCache(source, {
      summarize: summarizeSessionFiles,
      weight: (summary) => summary.touchCount,
      capacity: options.capacity ?? STATS_CACHE_CAPACITY,
      maxWeight: options.maxTouches ?? FILES_CACHE_MAX_TOUCHES,
      yieldAfterMs: options.yieldAfterMs ?? STATS_YIELD_AFTER_MS,
      closedMessage: CLOSED,
    });
    this.now = options.now ?? Date.now;
  }

  noteChanges(changes: readonly SeqChange[]): void {
    this.cache.noteChanges(changes);
  }

  cacheSize(): number {
    return this.cache.size();
  }

  /** Touches retained over all cached summaries (for tests). */
  retainedTouchCount(): number {
    return this.cache.retainedWeight();
  }

  /** Builds (or refreshes) every session's file summary ahead of a request (see StatsService.warm). Never rejects. */
  async warm(): Promise<void> {
    try {
      await this.cache.snapshot();
    } catch {
      // closed, or the source failed: a request will try again
    }
  }

  /** Stops a refresh in progress at its next session or page boundary; every later request is refused. */
  close(): void {
    this.cache.close();
  }

  /** One session's files; null for an unknown session. */
  async session(sessionId: string): Promise<SessionFilesResponse | null> {
    const entry = await this.cache.one(sessionId);
    return entry === null ? null : sessionFilesResponse(entry.session, entry.summary);
  }

  /** `importing`: passed through to the response (pipeline.importing() at answer time). */
  async project(query: FilesQuery, importing = false): Promise<ProjectFilesResponse> {
    const snap = await this.cache.snapshot();
    return aggregateProjectFiles({
      entries: snap.entries,
      projects: this.source.projects(),
      projectId: query.projectId,
      origin: query.origin,
      fromMs: rangeStartMs(query.range, this.now()),
      changedOnly: query.changedOnly,
      q: query.q,
      sort: query.sort,
      limit: query.limit,
      failedSessions: snap.failed,
      importing,
    });
  }
}
