import { performance } from 'node:perf_hooks';
import type { Change, GraphNode, SeqChange, Session } from '@agent-canvas/shared';

/**
 * A cache of per-session summaries, shared by the stats service and the file service: each keeps one, with its own
 * summarize function, over the same kind of source.
 *
 * - A summary is cached by session id, valid while no change newer than the graph it was built from has been reported
 *   for that session (noteChanges, fed from pipeline.onChanges); nothing is recomputed until a request needs it.
 * - snapshot(): every listed session's summary, refreshing stale and missing ones. Concurrent callers share one refresh
 *   (a caller arriving after a change waits for a refresh that includes it). Building gives the event loop a turn once
 *   `yieldAfterMs` has passed since the last one; the source's paged read yields between pages.
 * - The cache is an LRU of at most `capacity` summaries and `maxWeight` total weight; a refresh never evicts a summary
 *   it has itself used (with more sessions than capacity, the overflow is recomputed each time rather than everything).
 * - A session whose read or summary fails is skipped and counted (`failed`); the others are unaffected.
 */

/** Gives the event loop a turn. */
export const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** What a summary cache reads: the session list and one session's derived nodes. */
export interface SessionSummarySource {
  sessions(): Session[];
  /**
   * `nodes` in snapshot order (store rowid order). `seq`: a change seq taken before the read began; any change committed
   * to the session during the read has a higher seq, so it marks the summary stale (noteChanges) for the next request.
   * `stopped`: checked between pages of a long read; once true the read gives up (throws).
   */
  readSession(sessionId: string, stopped?: () => boolean): Promise<{ session: Session; nodes: GraphNode[]; seq: number } | null>;
}

export interface SessionSummaryCacheOptions<S> {
  summarize: (session: Session, nodes: GraphNode[]) => S;
  /** A summary's share of `maxWeight` (e.g. its number of calls). */
  weight: (summary: S) => number;
  capacity: number;
  maxWeight: number;
  yieldAfterMs: number;
  /** The message of the error a closed cache throws. */
  closedMessage: string;
}

export interface SummaryEntry<S> { session: Session; summary: S }
export interface SummarySnapshot<S> { entries: SummaryEntry<S>[]; failed: number }

/** `session`: the record read with the nodes (one() answers with it; a change to it is a noted change too). */
interface CacheEntry<S> { seq: number; session: Session; summary: S; weight: number; pass: number }

export function sessionIdOfChange(c: Change): string {
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

export class SessionSummaryCache<S> {
  private readonly cache = new Map<string, CacheEntry<S>>();
  /** Session id -> seq of the latest change reported for it. */
  private readonly changed = new Map<string, number>();
  private readonly capacity: number;
  private readonly maxWeight: number;
  private retained = 0;
  /** Bumped by every noteChanges; a refresh started at an older generation may miss a change. */
  private generation = 0;
  private pass = 0;
  private inflight: { generation: number; promise: Promise<SummarySnapshot<S>> } | null = null;
  private closed = false;

  constructor(private readonly source: SessionSummarySource, private readonly options: SessionSummaryCacheOptions<S>) {
    this.capacity = Math.max(1, options.capacity);
    this.maxWeight = Math.max(0, options.maxWeight);
  }

  noteChanges(changes: readonly SeqChange[]): void {
    if (changes.length === 0) return;
    for (const c of changes) {
      const id = sessionIdOfChange(c);
      if ((this.changed.get(id) ?? -Infinity) < c.seq) this.changed.set(id, c.seq);
    }
    this.generation++;
  }

  size(): number {
    return this.cache.size;
  }

  /** Total weight retained over all cached summaries. */
  retainedWeight(): number {
    return this.retained;
  }

  /** Stops a refresh in progress at its next session or page boundary; every later call is refused. */
  close(): void {
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }

  /** Every listed session's summary (see the class comment). */
  async snapshot(): Promise<SummarySnapshot<S>> {
    for (;;) {
      if (this.closed) throw new Error(this.options.closedMessage);
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

  /**
   * One session's summary: the cached one when still valid, else read and summarized (and cached). null for an unknown
   * session. A read or summary failure rejects.
   */
  async one(sessionId: string): Promise<SummaryEntry<S> | null> {
    if (this.closed) throw new Error(this.options.closedMessage);
    const cached = this.fresh(sessionId);
    if (cached !== undefined) {
      this.cache.delete(sessionId); // LRU: move to the most recent end
      this.cache.set(sessionId, cached);
      return { session: cached.session, summary: cached.summary };
    }
    const read = await this.source.readSession(sessionId, () => this.closed);
    if (read === null) return null;
    const summary = this.options.summarize(read.session, read.nodes);
    this.remember(sessionId, {
      seq: read.seq, session: read.session, summary, weight: this.options.weight(summary), pass: this.pass,
    });
    return { session: read.session, summary };
  }

  private fresh(id: string): CacheEntry<S> | undefined {
    const cached = this.cache.get(id);
    if (cached !== undefined && cached.seq >= (this.changed.get(id) ?? -Infinity)) return cached;
    return undefined;
  }

  private clearInflight(entry: { generation: number; promise: Promise<SummarySnapshot<S>> }): void {
    if (this.inflight === entry) this.inflight = null;
  }

  private async refresh(): Promise<SummarySnapshot<S>> {
    const pass = ++this.pass;
    const sessions = this.source.sessions();
    const entries: SummaryEntry<S>[] = [];
    let failed = 0;
    let lastYield = performance.now();
    const stopped = (): boolean => this.closed;
    for (const session of sessions) {
      if (performance.now() - lastYield >= this.options.yieldAfterMs) {
        await turn();
        lastYield = performance.now();
      }
      if (this.closed) throw new Error(this.options.closedMessage);
      const id = session.id;
      const cached = this.fresh(id);
      if (cached !== undefined) {
        this.cache.delete(id); // LRU: move to the most recent end
        cached.pass = pass;
        this.cache.set(id, cached);
        entries.push({ session, summary: cached.summary });
        continue;
      }
      try {
        const read = await this.source.readSession(id, stopped);
        if (read === null) continue; // gone since the listing
        const summary = this.options.summarize(read.session, read.nodes);
        this.remember(id, { seq: read.seq, session: read.session, summary, weight: this.options.weight(summary), pass });
        entries.push({ session, summary });
      } catch {
        if (this.closed) throw new Error(this.options.closedMessage);
        failed++;
      }
    }
    return { entries, failed };
  }

  /**
   * Caches `entry`, evicting least recently used summaries while over capacity or over maxWeight; a summary used by the
   * current refresh is never evicted for it (the new one is then not cached), nor is one heavier than maxWeight cached.
   */
  private remember(id: string, entry: CacheEntry<S>): void {
    this.forget(id);
    if (entry.weight > this.maxWeight) return;
    while (this.cache.size >= this.capacity || this.retained + entry.weight > this.maxWeight) {
      const [oldestId, oldest] = this.cache.entries().next().value as [string, CacheEntry<S>];
      if (oldest.pass === entry.pass) return; // everything cached was used by this refresh: keep it
      this.forget(oldestId);
    }
    this.cache.set(id, entry);
    this.retained += entry.weight;
    if ((this.changed.get(id) ?? -Infinity) <= entry.seq) this.changed.delete(id);
  }

  private forget(id: string): void {
    const old = this.cache.get(id);
    if (old === undefined) return;
    this.cache.delete(id);
    this.retained -= old.weight;
  }
}
