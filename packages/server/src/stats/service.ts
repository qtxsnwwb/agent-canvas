import { performance } from 'node:perf_hooks';
import {
  ORIGINS,
  STATS_DEFAULT_RANGE,
  STATS_RANGES,
  type Change,
  type GraphNode,
  type Origin,
  type Project,
  type SeqChange,
  type Session,
  type StatsRange,
  type StatsResponse,
} from '@agent-canvas/shared';
import type { Store } from '../store/store.js';
import { aggregateStats, localDayKey, type AggregateInput } from './aggregate.js';
import { summarizeSession, type SessionSummary } from './summary.js';

/** Gives the event loop a turn. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** What the stats service reads: the session list, one session's derived nodes, the projects (for names). */
export interface StatsSource {
  sessions(): Session[];
  /**
   * `nodes` in snapshot order (store rowid order). `seq`: a change seq taken before the read began; any change committed
   * to the session during the read has a higher seq, so it marks the summary stale (noteChanges) for the next request.
   */
  readSession(sessionId: string): Promise<{ session: Session; nodes: GraphNode[]; seq: number } | null>;
  projects(): Pick<Project, 'id' | 'cwd'>[];
}

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
    async readSession(sessionId) {
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

interface CacheEntry { seq: number; summary: SessionSummary; pass: number }
interface Snapshot { entries: AggregateInput['entries']; failed: number; projects: AggregateInput['projects'] }

function sessionIdOf(c: Change): string {
  switch (c.type) {
    case 'session_upserted':
      return c.session.id;
    case 'node_added':
      return c.node.sessionId;
    case 'node_updated':
    case 'edge_removed':
      return c.sessionId;
    case 'edge_added':
      return c.edge.sessionId;
  }
}


/**
 * Session summaries cached by session id, valid while no change newer than the graph they were built from has been
 * reported for that session (noteChanges, fed from pipeline.onChanges); nothing is recomputed until a request needs it.
 * Concurrent requests share one refresh (a request arriving after a change waits for a refresh that includes it).
 * The cache is an LRU of at most `capacity` summaries; a refresh never evicts a summary it has itself used (with more
 * sessions than capacity, the overflow is recomputed each time rather than everything).
 */
export class StatsService {
  private readonly cache = new Map<string, CacheEntry>();
  /** Session id -> seq of the latest change reported for it. */
  private readonly changed = new Map<string, number>();
  private readonly capacity: number;
  private readonly maxCalls: number;
  private retainedCalls = 0;
  private readonly now: () => number;
  private readonly dayKey: (ms: number) => string;
  private readonly yieldAfterMs: number;
  /** Bumped by every noteChanges; a refresh started at an older generation may miss a change. */
  private generation = 0;
  private pass = 0;
  private inflight: { generation: number; promise: Promise<Snapshot> } | null = null;

  constructor(private readonly source: StatsSource, options: StatsServiceOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? STATS_CACHE_CAPACITY);
    this.maxCalls = Math.max(0, options.maxCalls ?? STATS_CACHE_MAX_CALLS);
    this.now = options.now ?? Date.now;
    this.dayKey = options.dayKey ?? localDayKey;
    this.yieldAfterMs = options.yieldAfterMs ?? STATS_YIELD_AFTER_MS;
  }

  noteChanges(changes: readonly SeqChange[]): void {
    if (changes.length === 0) return;
    for (const c of changes) {
      const id = sessionIdOf(c);
      if ((this.changed.get(id) ?? -Infinity) < c.seq) this.changed.set(id, c.seq);
    }
    this.generation++;
  }

  cacheSize(): number {
    return this.cache.size;
  }

  async get(query: StatsQuery): Promise<StatsResponse> {
    const snap = await this.snapshot();
    return aggregateStats({ ...snap, ...query, nowMs: this.now(), dayKey: this.dayKey, failedSessions: snap.failed });
  }

  private async snapshot(): Promise<Snapshot> {
    for (;;) {
      const current = this.inflight;
      if (current !== null && current.generation === this.generation) return current.promise;
      if (current !== null) {
        await current.promise.catch(() => undefined);
        if (this.inflight === current) this.inflight = null;
        continue;
      }
      const generation = this.generation;
      const promise = this.refresh();
      const entry = { generation, promise };
      this.inflight = entry;
      void promise.then(
        () => this.clearInflight(entry),
        () => this.clearInflight(entry),
      );
      return promise;
    }
  }

  private clearInflight(entry: { generation: number; promise: Promise<Snapshot> }): void {
    if (this.inflight === entry) this.inflight = null;
  }

  private async refresh(): Promise<Snapshot> {
    const pass = ++this.pass;
    const sessions = this.source.sessions();
    const projects = this.source.projects();
    const entries: Snapshot['entries'] = [];
    let failed = 0;
    let lastYield = performance.now();
    for (const session of sessions) {
      if (performance.now() - lastYield >= this.yieldAfterMs) {
        await turn();
        lastYield = performance.now();
      }
      const id = session.id;
      const cached = this.cache.get(id);
      if (cached !== undefined && cached.seq >= (this.changed.get(id) ?? -Infinity)) {
        this.cache.delete(id); // LRU: move to the most recent end
        cached.pass = pass;
        this.cache.set(id, cached);
        entries.push({ session, summary: cached.summary });
        continue;
      }
      try {
        const read = await this.source.readSession(id);
        if (read === null) continue; // gone since the listing
        const summary = summarizeSession(read.session, read.nodes);
        this.remember(id, { seq: read.seq, summary, pass });
        entries.push({ session, summary });
      } catch {
        failed++;
      }
    }
    return { entries, failed, projects };
  }

  /**
   * Caches `entry`, evicting least recently used summaries while over capacity or over maxCalls; a summary used by the
   * current refresh is never evicted for it (the new one is then not cached), nor is one larger than maxCalls cached.
   */
  private remember(id: string, entry: CacheEntry): void {
    this.forget(id);
    const calls = entry.summary.calls.length;
    if (calls > this.maxCalls) return;
    while (this.cache.size >= this.capacity || this.retainedCalls + calls > this.maxCalls) {
      const [oldestId, oldest] = this.cache.entries().next().value as [string, CacheEntry];
      if (oldest.pass === entry.pass) return; // everything cached was used by this refresh: keep it
      this.forget(oldestId);
    }
    this.cache.set(id, entry);
    this.retainedCalls += calls;
    if ((this.changed.get(id) ?? -Infinity) <= entry.seq) this.changed.delete(id);
  }

  private forget(id: string): void {
    const old = this.cache.get(id);
    if (old === undefined) return;
    this.cache.delete(id);
    this.retainedCalls -= old.summary.calls.length;
  }

  /** Calls retained over all cached summaries (for tests). */
  retainedCallCount(): number {
    return this.retainedCalls;
  }
}
