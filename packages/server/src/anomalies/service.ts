import { performance } from 'node:perf_hooks';
import {
  ANOMALY_DEFAULT_RANGE,
  ANOMALY_KINDS,
  ANOMALY_LIST_MAX,
  ANOMALY_RANGES,
  ORIGINS,
  costAnomalies,
  costBaseline,
  type Anomaly,
  type AnomalyCountsResponse,
  type AnomalyKind,
  type AnomalyListItem,
  type AnomalyListResponse,
  type AnomalyRange,
  type AnomalySessionCount,
  type CostBaseline,
  type GraphNode,
  type Origin,
  type SeqChange,
  type Session,
  type SessionAnomaliesResponse,
  type TurnCost,
} from '@agent-canvas/shared';
import { rangeStartMs } from '../files/aggregate.js';
import { SessionSummaryCache, sessionIdOfChange, type SessionSummarySource, type SummaryEntry } from '../stats/session-cache.js';
import { STATS_CACHE_CAPACITY, STATS_YIELD_AFTER_MS } from '../stats/service.js';
import { FAILED_SUMMARY, isRunningStatus, summarizeAnomalies, type AnomalySummary } from './summary.js';

/**
 * The service behind the anomaly routes (spec section 4) and the anomaly notifications' change feed (spec 5).
 *
 * - Per-session summaries (summary.ts: loop / failures / churn anomalies + turn costs) in a SessionSummaryCache, the
 *   stats service's design: cached by session, invalidated through noteChanges (a status change is a change too: it
 *   arrives as session_upserted), recomputed only when needed, paged reads that yield, LRU-bounded. Its reads are its
 *   own, not shared with the stats and file caches (see buildServer for why). Concurrent reads of one session (a
 *   request's refresh and a background recompute) share one read and one summary.
 * - `cost` anomalies are judged at query time: the finished turn costs of every session (whatever the request's
 *   filters), grouped by (project, origin), one costBaseline per group (with its origin: Cursor is judged on time only),
 *   costAnomalies per session. The result is cached under a version bumped by every summary computed, so requests with
 *   nothing changed reuse it.
 * - Requests do not wait for a cold build for long: when the summaries are not all ready within `answerWaitMs`, the
 *   answer is built from the summaries computed so far and says `computing` (the build goes on in the background).
 *   `computing` is also true until the start-up work is over (pipeline.startupDone).
 * - A session whose summary throws is counted in failedSessions and skipped; its failed summary stays cached until the
 *   session changes, so it is retried then. A failed read is counted too, and retried by every request (as the stats
 *   service does).
 * - Every summary computed is shown to the onSummary listeners (the notification service), with the latest time the
 *   session was seen running. While `live()` holds (a notification switch for loop / failures is on) and the start-up
 *   work is over, a change to a running session schedules a background recompute of that session alone: at most one in
 *   flight per session, armed `liveDelayMs` after the first change of a burst (later changes do not push it back), and
 *   never sooner than `liveCostFactor` times the previous recompute's duration after it ended; a change newer than the
 *   read it used arms another one.
 */

/** What the anomaly service reads: the same as the stats service (storeStatsSource: paged node reads). */
export type AnomaliesSource = SessionSummarySource;

const CLOSED = 'anomalies service closed';

/** Most turn costs kept over all cached summaries (≈150 B each): the real dataset has ≈5,800. */
export const ANOMALIES_CACHE_MAX_WEIGHT = 1_000_000;
/** A request waits this long for the summaries; after that it answers with what is ready (`computing`). */
export const ANOMALY_ANSWER_WAIT_MS = 1000;
/** A running session's change is followed by a recompute this long after the first change of a burst. */
export const ANOMALY_LIVE_DELAY_MS = 1000;
/**
 * ... and never sooner than this many times the previous recompute's duration after it ended: a 100,000-node session
 * (≈550 ms measured) is recomputed at most every ≈3.3 s while it runs, about 15 % of one core.
 */
export const ANOMALY_LIVE_COST_FACTOR = 6;
/** A session that left running this recently still counts as running (its last changes may complete an anomaly). */
export const ANOMALY_RUNNING_GRACE_MS = 5000;

export interface AnomalyListQuery {
  range: AnomalyRange;
  origin: Origin | null;
  projectId: string | null;
  kind: AnomalyKind | null;
}

/**
 * The query string of GET /api/anomalies. An empty or absent range means ANOMALY_DEFAULT_RANGE; an empty or absent
 * origin / projectId / kind means no filter. An unknown range, origin or kind, or a repeated parameter, is an error
 * (400); an unknown projectId is not (empty result, as GET /api/stats).
 */
export function parseAnomalyListQuery(query: Record<string, unknown>): AnomalyListQuery | { error: string } {
  const { range, origin, projectId, kind } = query;
  for (const [name, v] of Object.entries({ range, origin, projectId, kind })) {
    if (v !== undefined && typeof v !== 'string') return { error: `${name} must be given once` };
  }
  if (range !== undefined && range !== '' && !(ANOMALY_RANGES as readonly unknown[]).includes(range)) {
    return { error: `unknown range (expected ${ANOMALY_RANGES.join(', ')})` };
  }
  if (origin !== undefined && origin !== '' && !(ORIGINS as readonly unknown[]).includes(origin)) {
    return { error: `unknown origin (expected ${ORIGINS.join(', ')})` };
  }
  if (kind !== undefined && kind !== '' && !(ANOMALY_KINDS as readonly unknown[]).includes(kind)) {
    return { error: `unknown kind (expected ${ANOMALY_KINDS.join(', ')})` };
  }
  return {
    range: range === undefined || range === '' ? ANOMALY_DEFAULT_RANGE : (range as AnomalyRange),
    origin: origin === undefined || origin === '' ? null : (origin as Origin),
    projectId: projectId === undefined || projectId === '' ? null : (projectId as string),
    kind: kind === undefined || kind === '' ? null : (kind as AnomalyKind),
  };
}

/**
 * A summary computed for a session (onSummary). `runningUntil`: the latest time (wall clock, ms) the session was seen
 * running — Infinity while it runs, the moment it left running when that was at most ANOMALY_RUNNING_GRACE_MS ago, else
 * null.
 */
export interface AnomalySummaryEvent {
  session: Session;
  anomalies: readonly Anomaly[];
  runningUntil: number | null;
}

export interface LiveTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: LiveTimers = {
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface AnomaliesServiceOptions {
  /** Most session summaries kept (also bounds the per-session state). Default STATS_CACHE_CAPACITY. */
  capacity?: number;
  /** Most turn costs kept over all summaries. Default ANOMALIES_CACHE_MAX_WEIGHT. */
  maxWeight?: number;
  yieldAfterMs?: number;
  /** Wall clock (ms): ranges, the running grace. */
  now?: () => number;
  /** Monotonic clock (ms) for the live recompute's pacing. Default performance.now. */
  clock?: () => number;
  /** pipeline.startupDone(): until it holds, answers say `computing` and nothing is recomputed in the background. */
  startupDone?: () => boolean;
  answerWaitMs?: number;
  /** Whether running sessions are recomputed in the background on change (the notification switches). Default never. */
  live?: () => boolean;
  liveDelayMs?: number;
  liveCostFactor?: number;
  timers?: LiveTimers;
  /** The summary function (tests). Default summarizeAnomalies. */
  summarize?: (session: Session, nodes: GraphNode[]) => AnomalySummary;
}

/** Everything the routes answer from: per session, its record and all its anomalies (cost included), by `at`. */
interface Derived {
  key: string;
  complete: boolean;
  failed: number;
  sessions: Map<string, { session: Session; anomalies: Anomaly[] }>;
}

interface LiveState {
  timer: unknown;
  running: boolean;
  lastDurationMs: number;
  lastEndAt: number;
}

interface RunState {
  running: boolean;
  /** Wall clock of the last time the session was seen running (null: never). */
  lastRunningAt: number | null;
}

type Read = { session: Session; nodes: GraphNode[]; seq: number } | null;

/** ms of an anomaly's `at`; unparseable counts as 0 (detection only emits parseable ones). */
const atMs = (a: Anomaly): number => {
  const ms = Date.parse(a.at);
  return Number.isNaN(ms) ? 0 : ms;
};

/** By `at`, then id. */
export function byAtThenId(a: Anomaly, b: Anomaly): number {
  return atMs(a) - atMs(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const emptyTotals = (): Record<AnomalyKind, number> => ({ loop: 0, failures: 0, churn: 0, cost: 0 });

/** Puts `key` at the most recent end of an insertion-ordered map, dropping the oldest entries beyond `max`. */
function touch<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as K);
}

export class AnomaliesService {
  private readonly cache: SessionSummaryCache<AnomalySummary>;
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly clock: () => number;
  private readonly startupDone: () => boolean;
  private readonly answerWaitMs: number;
  private readonly live: () => boolean;
  private readonly liveDelayMs: number;
  private readonly liveCostFactor: number;
  private readonly timers: LiveTimers;
  private readonly summarizeFn: (session: Session, nodes: GraphNode[]) => AnomalySummary;
  /** The latest summary computed per session (answers while the summaries are still being built); LRU of `capacity`. */
  private readonly latest = new Map<string, SummaryEntry<AnomalySummary>>();
  /** Reads in flight by session id (shared by the cache's refresh and one()). */
  private readonly reading = new Map<string, Promise<Read>>();
  /** The summary of a read's node list (one summary per read, whoever asked). */
  private readonly summaryOfRead = new WeakMap<GraphNode[], AnomalySummary>();
  /** Session id -> seq of the latest read / the latest change noted. */
  private readonly readSeq = new Map<string, number>();
  private readonly changedSeq = new Map<string, number>();
  /** Sessions whose last read failed. */
  private readonly failedReads = new Set<string>();
  /** Bumped by every summary computed. */
  private version = 0;
  private derived: Derived | null = null;
  private derivations = 0;
  private readonly listeners = new Set<(event: AnomalySummaryEvent) => void>();
  private readonly runState = new Map<string, RunState>();
  private readonly liveState = new Map<string, LiveState>();
  private liveRecomputes = 0;
  private closed = false;

  constructor(private readonly source: AnomaliesSource, options: AnomaliesServiceOptions = {}) {
    this.summarizeFn = options.summarize ?? summarizeAnomalies;
    this.capacity = Math.max(1, options.capacity ?? STATS_CACHE_CAPACITY);
    const shared: AnomaliesSource = {
      sessions: () => source.sessions(),
      readSession: (id, stopped) => this.sharedRead(id, stopped),
    };
    this.cache = new SessionSummaryCache(shared, {
      summarize: (session, nodes) => this.summarize(session, nodes),
      weight: (summary) => summary.costs.length + summary.anomalies.length,
      capacity: this.capacity,
      maxWeight: options.maxWeight ?? ANOMALIES_CACHE_MAX_WEIGHT,
      yieldAfterMs: options.yieldAfterMs ?? STATS_YIELD_AFTER_MS,
      closedMessage: CLOSED,
    });
    this.now = options.now ?? Date.now;
    this.clock = options.clock ?? (() => performance.now());
    this.startupDone = options.startupDone ?? (() => true);
    this.answerWaitMs = Math.max(0, options.answerWaitMs ?? ANOMALY_ANSWER_WAIT_MS);
    this.live = options.live ?? (() => false);
    this.liveDelayMs = Math.max(0, options.liveDelayMs ?? ANOMALY_LIVE_DELAY_MS);
    this.liveCostFactor = Math.max(0, options.liveCostFactor ?? ANOMALY_LIVE_COST_FACTOR);
    this.timers = options.timers ?? realTimers;
  }

  // ---------------------------------------------------------------- change feed

  noteChanges(changes: readonly SeqChange[]): void {
    if (changes.length === 0) return;
    this.cache.noteChanges(changes);
    if (this.closed) return;
    const now = this.now();
    const touched = new Set<string>();
    for (const c of changes) {
      const id = sessionIdOfChange(c);
      touched.add(id);
      if ((this.changedSeq.get(id) ?? -Infinity) < c.seq) touch(this.changedSeq, id, c.seq, this.capacity);
      if (c.type === 'session_upserted') this.noteStatus(c.session, now, true);
    }
    if (!this.wantLive()) return;
    for (const id of touched) if (this.runningUntil(id, now) !== null) this.scheduleLive(id);
  }

  /** Listens to every summary computed (see AnomalySummaryEvent); returns the unsubscribe. */
  onSummary(listener: (event: AnomalySummaryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Builds (or refreshes) every session's summary ahead of a request (see StatsService.warm). Never rejects. */
  async warm(): Promise<void> {
    try {
      await this.cache.snapshot();
    } catch {
      // closed, or the source failed: a request will try again
    }
  }

  /** Stops a refresh in progress at its next session or page boundary and the live recomputes; later requests fail. */
  close(): void {
    this.closed = true;
    this.cache.close();
    for (const st of this.liveState.values()) {
      if (st.timer !== null) this.timers.clearTimeout(st.timer);
      st.timer = null;
    }
  }

  // ---------------------------------------------------------------- routes

  /**
   * GET /api/sessions/:id/anomalies; null for an unknown session; 'failed' when its detection threw (the route answers
   * 500, as the file route does for a session it cannot summarize).
   */
  async session(sessionId: string): Promise<SessionAnomaliesResponse | null | 'failed'> {
    const entry = await this.cache.one(sessionId);
    if (entry === null) return null;
    if (entry.summary.failed) return 'failed';
    const d = await this.state();
    const own = entry.summary.anomalies;
    const cost = (d.sessions.get(sessionId)?.anomalies ?? []).filter((a) => a.kind === 'cost');
    return { anomalies: [...own, ...cost].sort(byAtThenId), computing: this.computing(d) };
  }

  /** GET /api/anomalies. */
  async list(query: AnomalyListQuery): Promise<AnomalyListResponse> {
    const d = await this.state();
    const fromMs = rangeStartMs(query.range, this.now());
    const totals = emptyTotals();
    const matched: AnomalyListItem[] = [];
    for (const { session, anomalies } of d.sessions.values()) {
      if (query.origin !== null && session.origin !== query.origin) continue;
      if (query.projectId !== null && session.projectId !== query.projectId) continue;
      for (const a of anomalies) {
        if (fromMs !== null && !(Date.parse(a.at) >= fromMs)) continue;
        totals[a.kind]++;
        if (query.kind !== null && a.kind !== query.kind) continue;
        matched.push({ ...a, projectId: session.projectId, origin: session.origin, sessionTitle: session.title });
      }
    }
    matched.sort((a, b) => atMs(b) - atMs(a) || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return {
      items: matched.slice(0, ANOMALY_LIST_MAX),
      totals,
      truncated: matched.length > ANOMALY_LIST_MAX,
      computing: this.computing(d),
      failedSessions: d.failed,
    };
  }

  /** GET /api/anomalies/counts. */
  async counts(): Promise<AnomalyCountsResponse> {
    const d = await this.state();
    const counts: Record<string, AnomalySessionCount> = {};
    for (const [id, { anomalies }] of d.sessions) {
      if (anomalies.length === 0) continue;
      const byKind: Partial<Record<AnomalyKind, number>> = {};
      for (const a of anomalies) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
      counts[id] = { total: anomalies.length, byKind };
    }
    return { counts, computing: this.computing(d) };
  }

  // ---------------------------------------------------------------- for tests

  cacheSize(): number {
    return this.cache.size();
  }

  /** How many times the cost baselines were computed. */
  derivationCount(): number {
    return this.derivations;
  }

  /** How many background recomputes of running sessions ran. */
  liveRecomputeCount(): number {
    return this.liveRecomputes;
  }

  /** Sizes of the per-session state (bounded by `capacity`, pruned when a session is no longer listed). */
  stateSizes(): Record<string, number> {
    return {
      latest: this.latest.size, runState: this.runState.size, liveState: this.liveState.size,
      readSeq: this.readSeq.size, changedSeq: this.changedSeq.size, failedReads: this.failedReads.size,
    };
  }

  // ---------------------------------------------------------------- internals

  private isStartupDone(): boolean {
    try {
      return this.startupDone();
    } catch {
      return false;
    }
  }

  private computing(d: Derived): boolean {
    return !d.complete || !this.isStartupDone();
  }

  /** One read per session at a time, whoever asks; records its seq and whether it failed. */
  private sharedRead(sessionId: string, stopped?: () => boolean): Promise<Read> {
    const current = this.reading.get(sessionId);
    if (current !== undefined) return current;
    const promise = (async (): Promise<Read> => {
      try {
        const read = await this.source.readSession(sessionId, stopped);
        this.failedReads.delete(sessionId);
        if (read !== null) touch(this.readSeq, sessionId, read.seq, this.capacity);
        return read;
      } catch (err) {
        if (!this.closed && this.failedReads.size < this.capacity) this.failedReads.add(sessionId);
        throw err;
      }
    })();
    this.reading.set(sessionId, promise);
    const clear = (): void => {
      if (this.reading.get(sessionId) === promise) this.reading.delete(sessionId);
    };
    void promise.then(clear, clear);
    return promise;
  }

  /**
   * The cache's summarize: never throws (a failure is a failed summary), one per read (a second caller of the same read
   * gets the same summary, and the listeners hear it once), records it and tells the listeners.
   */
  private summarize(session: Session, nodes: GraphNode[]): AnomalySummary {
    const known = this.summaryOfRead.get(nodes);
    if (known !== undefined) return known;
    let summary: AnomalySummary;
    try {
      summary = this.summarizeFn(session, nodes);
    } catch {
      summary = FAILED_SUMMARY;
    }
    this.summaryOfRead.set(nodes, summary);
    touch(this.latest, session.id, { session, summary }, this.capacity);
    this.version++;
    const now = this.now();
    this.noteStatus(session, now, false);
    if (!summary.failed && this.listeners.size > 0) {
      const event: AnomalySummaryEvent = { session, anomalies: summary.anomalies, runningUntil: this.runningUntil(session.id, now, session) };
      for (const l of this.listeners) {
        try {
          l(event);
        } catch {
          // a listener's failure is its own
        }
      }
    }
    return summary;
  }

  /** A session record seen: from the change feed (authoritative), or with a summary (only when nothing is known). */
  private noteStatus(session: Session, now: number, fromFeed: boolean): void {
    const prev = this.runState.get(session.id);
    if (!fromFeed && prev !== undefined) return;
    const running = isRunningStatus(session.status);
    touch(this.runState, session.id, {
      running,
      lastRunningAt: running || prev?.running === true ? now : (prev?.lastRunningAt ?? null),
    }, this.capacity);
  }

  /** See AnomalySummaryEvent.runningUntil. */
  private runningUntil(sessionId: string, now: number, session?: Session): number | null {
    if (session !== undefined && isRunningStatus(session.status)) return Infinity;
    const st = this.runState.get(sessionId);
    if (st === undefined) return null;
    if (st.running) return Infinity;
    return st.lastRunningAt !== null && now - st.lastRunningAt <= ANOMALY_RUNNING_GRACE_MS ? st.lastRunningAt : null;
  }

  private wantLive(): boolean {
    try {
      return this.live() && this.isStartupDone();
    } catch {
      return false;
    }
  }

  private scheduleLive(sessionId: string): void {
    let st = this.liveState.get(sessionId);
    if (st === undefined) {
      st = { timer: null, running: false, lastDurationMs: 0, lastEndAt: -Infinity };
      touch(this.liveState, sessionId, st, this.capacity);
    }
    if (st.timer !== null || st.running) return; // armed, or in flight (it re-arms itself when a change is newer)
    const sinceEnd = this.clock() - st.lastEndAt;
    const delay = Math.max(this.liveDelayMs, this.liveCostFactor * st.lastDurationMs - sinceEnd);
    const state = st;
    st.timer = this.timers.setTimeout(() => {
      state.timer = null;
      void this.runLive(sessionId, state);
    }, delay);
  }

  private async runLive(sessionId: string, st: LiveState): Promise<void> {
    if (this.closed) return;
    st.running = true;
    const t0 = this.clock();
    try {
      this.liveRecomputes++;
      await this.cache.one(sessionId);
    } catch {
      // a failed read: the next change tries again
    } finally {
      st.running = false;
      st.lastEndAt = this.clock();
      st.lastDurationMs = st.lastEndAt - t0;
      // A change newer than the read used (e.g. a shared read begun before it): once more.
      const stale = (this.changedSeq.get(sessionId) ?? -Infinity) > (this.readSeq.get(sessionId) ?? -Infinity);
      if (stale && !this.closed && this.wantLive() && this.runningUntil(sessionId, this.now()) !== null) this.scheduleLive(sessionId);
    }
  }

  /** Forgets every per-session record of the sessions not listed any more (deleted). */
  private prune(listed: ReadonlySet<string>): void {
    for (const map of [this.latest, this.runState, this.readSeq, this.changedSeq] as Map<string, unknown>[]) {
      for (const id of [...map.keys()]) if (!listed.has(id)) map.delete(id);
    }
    for (const id of [...this.failedReads]) if (!listed.has(id)) this.failedReads.delete(id);
    for (const [id, st] of [...this.liveState]) {
      if (listed.has(id)) continue;
      if (st.timer !== null) this.timers.clearTimeout(st.timer);
      this.liveState.delete(id);
    }
  }

  /**
   * The summaries to answer from: every session's when they are ready within answerWaitMs, else those computed so far
   * (`complete` false; the refresh goes on). Cost anomalies judged over all of them.
   */
  private async state(): Promise<Derived> {
    if (this.closed) throw new Error(CLOSED);
    const snapshot = this.cache.snapshot();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const waited = await Promise.race([
      snapshot.then(
        (snap) => ({ snap }),
        (err: unknown) => ({ err }),
      ),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), this.answerWaitMs);
      }),
    ]);
    if (timer !== null) clearTimeout(timer);
    if (waited !== null && 'err' in waited) {
      if (this.closed) throw new Error(CLOSED);
      throw waited.err;
    }
    if (waited !== null) {
      const { entries, failed } = waited.snap;
      this.prune(new Set(this.source.sessions().map((s) => s.id)));
      return this.derive(entries, true, failed);
    }
    // Partial: the summaries so far, and the sessions whose last read failed.
    return this.derive([...this.latest.values()], false, this.failedReads.size);
  }

  private derive(entries: readonly SummaryEntry<AnomalySummary>[], complete: boolean, failedReads: number): Derived {
    const key = `${complete ? 'c' : 'p'}:${this.version}:${entries.length}:${failedReads}`;
    if (this.derived !== null && this.derived.key === key) return this.derived;
    this.derivations++;
    const groups = new Map<string, { origin: Origin; costs: TurnCost[] }>();
    const groupKey = (s: Session): string => `${s.projectId}\u0000${s.origin}`;
    let failed = failedReads;
    for (const { session, summary } of entries) {
      if (summary.failed) {
        failed++;
        continue;
      }
      let group = groups.get(groupKey(session));
      if (group === undefined) groups.set(groupKey(session), (group = { origin: session.origin, costs: [] }));
      for (const c of summary.costs) group.costs.push(c);
    }
    const baselines = new Map<string, CostBaseline>();
    for (const [key, { origin, costs }] of groups) baselines.set(key, costBaseline(costs, { origin }));
    const sessions = new Map<string, { session: Session; anomalies: Anomaly[] }>();
    for (const { session, summary } of entries) {
      if (summary.failed) continue;
      const baseline = baselines.get(groupKey(session));
      const cost = baseline !== undefined && summary.costs.length > 0 ? costAnomalies(summary.costs, baseline) : [];
      const anomalies = cost.length === 0 ? summary.anomalies : [...summary.anomalies, ...cost].sort(byAtThenId);
      sessions.set(session.id, { session, anomalies });
    }
    this.derived = { key, complete, failed, sessions };
    return this.derived;
  }
}
