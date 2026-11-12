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

/** What the stats service reads: the session list, one session's derived graph, the projects (for names). */
export interface StatsSource {
  sessions(): Session[];
  /** `seq`: a change sequence number at least that of every change reflected in the returned nodes. */
  graph(sessionId: string): { session: Session; nodes: GraphNode[]; seq: number } | null;
  projects(): Pick<Project, 'id' | 'cwd'>[];
}

export function storeStatsSource(store: Store): StatsSource {
  return {
    sessions: () => store.sessionProjectIds().flatMap((id) => store.listSessions(id)),
    // getGraph's seq is the store's last assigned seq at read time (it reflects every change up to it).
    graph: (sessionId) => store.getGraph(sessionId),
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

export const STATS_CACHE_CAPACITY = 500;
/** Building summaries gives the event loop a turn once this much time has passed since the last one. */
export const STATS_YIELD_AFTER_MS = 10;

export interface StatsServiceOptions {
  /** Most session summaries kept (least recently used evicted). Default STATS_CACHE_CAPACITY. */
  capacity?: number;
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

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

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
  private readonly now: () => number;
  private readonly dayKey: (ms: number) => string;
  private readonly yieldAfterMs: number;
  /** Bumped by every noteChanges; a refresh started at an older generation may miss a change. */
  private generation = 0;
  private pass = 0;
  private inflight: { generation: number; promise: Promise<Snapshot> } | null = null;

  constructor(private readonly source: StatsSource, options: StatsServiceOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? STATS_CACHE_CAPACITY);
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
        const graph = this.source.graph(id);
        if (graph === null) continue; // gone since the listing
        const summary = summarizeSession(graph.session, graph.nodes);
        this.remember(id, { seq: graph.seq, summary, pass });
        entries.push({ session, summary });
      } catch {
        failed++;
      }
    }
    return { entries, failed, projects };
  }

  private remember(id: string, entry: CacheEntry): void {
    this.cache.delete(id);
    if (this.cache.size >= this.capacity) {
      const [oldestId, oldest] = this.cache.entries().next().value as [string, CacheEntry];
      if (oldest.pass === entry.pass) return; // everything cached was used by this refresh: keep it
      this.cache.delete(oldestId);
    }
    this.cache.set(id, entry);
    if ((this.changed.get(id) ?? -Infinity) <= entry.seq) this.changed.delete(id);
  }
}
