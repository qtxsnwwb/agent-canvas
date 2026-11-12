import {
  ORIGINS,
  STATS_DEFAULT_RANGE,
  STATS_RANGES,
  type GraphNode,
  type Origin,
  type Project,
  type SeqChange,
  type StatsRange,
  type StatsResponse,
} from '@agent-canvas/shared';
import type { Store } from '../store/store.js';
import { aggregateStats, localDayKey } from './aggregate.js';
import { SessionSummaryCache, turn, type SessionSummarySource } from './session-cache.js';
import { summarizeSession, type SessionSummary } from './summary.js';

/** What the stats service reads: the session list, one session's derived nodes, the projects (for names). */
/**
 * What the stats service reads: the session list, one session's derived nodes (see SessionSummarySource), the projects
 * (for names).
 */
export interface StatsSource extends SessionSummarySource {
  projects(): Pick<Project, 'id' | 'cwd'>[];
}

const CLOSED = 'stats service closed';

/** Nodes per page of storeStatsSource's session read (one page ≈ 10 ms of the event loop for typical node bodies). */
export const STATS_PAGE_SIZE = 5000;

/**
 * Reads a session in primary-key pages (store.nodePage: no edges, no rowid sort in SQL), giving the event loop a turn
 * between pages; no statement or iterator stays open across a turn. The rows are put back in rowid (snapshot) order.
 */
export function storeStatsSource(store: Store, options: { pageSize?: number } = {}): StatsSource {
  const pageSize = Math.max(1, options.pageSize ?? STATS_PAGE_SIZE);
  return {
    sessions: () => store.sessionProjectIds().flatMap((id) => store.listSessions(id)),
    async readSession(sessionId, stopped) {
      const seq = store.lastSeq();
      const session = store.getSession(sessionId);
      if (session === null) return null;
      const rows: { rowid: number; node: GraphNode }[] = [];
      let after: string | null = null;
      for (;;) {
        const page = store.nodePage(sessionId, after, pageSize);
        for (const row of page) rows.push(row);
        if (page.length < pageSize) break;
        after = page[page.length - 1]!.node.id;
        await turn();
        if (stopped?.() === true) throw new Error(CLOSED);
      }
      rows.sort((a, b) => a.rowid - b.rowid);
      return { session, nodes: rows.map((r) => r.node), seq };
    },
    projects: () => store.listProjects(Date.now()),
  };
}

export interface StatsQuery { range: StatsRange; origin: Origin | null; projectId: string | null }

/**
 * The query string of GET /api/stats. range defaults to STATS_DEFAULT_RANGE; an empty origin / projectId means no
 * filter. An unknown range or origin, or a repeated parameter, is an error (400); an unknown projectId is not.
 */
export function parseStatsQuery(query: Record<string, unknown>): StatsQuery | { error: string } {
  const { range, origin, projectId } = query;
  if (range !== undefined && !(typeof range === 'string' && (STATS_RANGES as readonly string[]).includes(range))) {
    return { error: `unknown range (expected ${STATS_RANGES.join(', ')})` };
  }
  if (origin !== undefined && !(typeof origin === 'string' && (origin === '' || (ORIGINS as readonly string[]).includes(origin)))) {
    return { error: `unknown origin (expected ${ORIGINS.join(', ')})` };
  }
  if (projectId !== undefined && typeof projectId !== 'string') return { error: 'projectId must be given once' };
  return {
    range: (range as StatsRange | undefined) ?? STATS_DEFAULT_RANGE,
    origin: origin === undefined || origin === '' ? null : (origin as Origin),
    projectId: projectId === undefined || projectId === '' ? null : projectId,
  };
}

/**
 * Most summaries kept: far above realistic session counts, so every session stays cached and only changed ones are
 * recomputed. Memory is bounded by STATS_CACHE_MAX_CALLS.
 */
export const STATS_CACHE_CAPACITY = 20_000;
/**
 * Most per-call entries (SummaryCall, ≈100 B each) kept across all cached summaries: ≈100 MB worst case. The real
 * 210,000-node dataset has ≈100,000 calls. Turns are per prompt and small.
 */
export const STATS_CACHE_MAX_CALLS = 1_000_000;
/** Building summaries gives the event loop a turn once this much time has passed since the last one. */
export const STATS_YIELD_AFTER_MS = 10;

export interface StatsServiceOptions {
  /** Most session summaries kept (least recently used evicted). Default STATS_CACHE_CAPACITY. */
  capacity?: number;
  /** Most SummaryCall entries kept over all summaries. Default STATS_CACHE_MAX_CALLS. */
  maxCalls?: number;
  now?: () => number;
  dayKey?: (ms: number) => string;
  yieldAfterMs?: number;
}

/**
 * Session summaries in a SessionSummaryCache (see session-cache.ts): cached by session id, invalidated through
 * noteChanges (fed from pipeline.onChanges), recomputed only when a request needs them; concurrent requests share one
 * refresh; an LRU of at most `capacity` summaries and `maxCalls` retained calls.
 */
export class StatsService {
  private readonly cache: SessionSummaryCache<SessionSummary>;
  private readonly now: () => number;
  private readonly dayKey: (ms: number) => string;

  constructor(private readonly source: StatsSource, options: StatsServiceOptions = {}) {
    this.cache = new SessionSummaryCache(source, {
      summarize: summarizeSession,
      weight: (summary) => summary.calls.length,
      capacity: options.capacity ?? STATS_CACHE_CAPACITY,
      maxWeight: options.maxCalls ?? STATS_CACHE_MAX_CALLS,
      yieldAfterMs: options.yieldAfterMs ?? STATS_YIELD_AFTER_MS,
      closedMessage: CLOSED,
    });
    this.now = options.now ?? Date.now;
    this.dayKey = options.dayKey ?? localDayKey;
  }

  noteChanges(changes: readonly SeqChange[]): void {
    this.cache.noteChanges(changes);
  }

  cacheSize(): number {
    return this.cache.size();
  }

  /**
   * Builds (or refreshes) every session summary ahead of a request: the same shared refresh a request runs, so a request
   * arriving meanwhile waits for it instead of starting another. Never rejects.
   */
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

  async get(query: StatsQuery): Promise<StatsResponse> {
    const snap = await this.cache.snapshot();
    const projects = this.source.projects();
    return aggregateStats({
      entries: snap.entries, projects, ...query, nowMs: this.now(), dayKey: this.dayKey, failedSessions: snap.failed,
    });
  }

  /** Calls retained over all cached summaries (for tests). */
  retainedCallCount(): number {
    return this.cache.retainedWeight();
  }
}
