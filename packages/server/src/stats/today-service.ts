import type { SeqChange, TodayUsage } from '@agent-canvas/shared';
import type { Store } from '../store/store.js';
import { realTimers, type Timers } from '../timers.js';
import { localDayKey } from './aggregate.js';
import type { SessionSummaryCache, SummaryEntry } from './session-cache.js';
import { turnGrowing, type SessionSummary } from './summary.js';
import { computeToday } from './today.js';

/**
 * Recompute at most this often while sessions change, and this often while today has a growing open turn; while the
 * start-up work is going on, how often it is checked for being over.
 */
export const TODAY_THROTTLE_MS = 30_000;
/** meta key of the over-state (JSON of OverState). */
export const TODAY_META_KEY = 'todayUsage';

export interface TodayServiceDeps {
  /** The stats page's summary cache (StatsService.summaryCache()): only changed sessions are read again. */
  cache: Pick<SessionSummaryCache<SessionSummary>, 'snapshot'>;
  store: Pick<Store, 'getMeta' | 'setMeta'>;
  /** The line (the notification settings' usageLineTokens, 0 -> null), read at every computation. */
  line: () => number | null;
  /**
   * Start-up work done and not importing. While false nothing is computed on a timer (a get() still computes) and a
   * crossing is consumed, never reported later; once true again, one baseline computation follows.
   */
  ready: () => boolean;
  /** Usage grew past the line (at most once per day and line); the notification service decides about its switches. */
  onCross?: (usage: TodayUsage) => void;
  now?: () => number;
  dayKey?: (ms: number) => string;
  timers?: Timers;
}

/** Stored under TODAY_META_KEY: today, this line, already over it (whether or not a notification went out). */
interface OverState {
  day: string;
  line: number | null;
  over: boolean;
}

const H = 3_600_000;

/** The first instant of the day after `nowMs`'s, by `dayKey` itself (no fixed 24 h: DST days, an injected zone). */
function nextDayStart(nowMs: number, dayKey: (ms: number) => string): number {
  const today = dayKey(nowMs);
  let lo = nowMs;
  let hi = nowMs + 26 * H; // a local day lasts at most 25 h
  if (dayKey(hi) === today) return hi; // a clock or zone oddity: look again then
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (dayKey(mid) === today) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** A turn started today whose duration still grows (turnGrowing, the rule of turnDurationMs): it needs a tick. */
function growingToday(entries: readonly SummaryEntry<SessionSummary>[], today: string, nowMs: number, dayKey: (ms: number) => string): boolean {
  for (const { summary } of entries) {
    for (const t of summary.turns) {
      if (t.dated && turnGrowing(t, nowMs) && dayKey(t.startMs) === today) return true;
    }
  }
  return false;
}

function parseState(raw: string | null): OverState | null {
  if (raw === null) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown> | null;
    if (typeof o !== 'object' || o === null) return null;
    const { day, line, over } = o;
    if (typeof day !== 'string' || !(line === null || typeof line === 'number') || typeof over !== 'boolean') return null;
    return { day, line, over };
  } catch {
    return null;
  }
}

/**
 * Today's usage (spec 2026-11-24-today-usage-design.md 5, 6): computeToday over the summary cache's snapshot, with the
 * line and whether it is reached.
 *
 * - When: the first get() or change; then at most once per TODAY_THROTTLE_MS while changes arrive (noteChanges), also
 *   every TODAY_THROTTLE_MS while today has a growing open turn (the summaries come from the cache, nothing is read
 *   again), once at the next local day start (from `dayKey`), and at once on settingsChanged(). Never on a timer when
 *   nothing changed and nothing is open. get() never waits for the throttle: it answers with the latest result.
 * - Start-up work (ready() false: the initial scan, a rebuild, an import; checked at construction too): no change-driven,
 *   tick or midnight computation; changes stay noted and ready() is checked every TODAY_THROTTLE_MS instead. Once it
 *   holds, one baseline computation runs, so the first change after it is judged against what start-up left.
 * - Over-state (meta TODAY_META_KEY, `{ day, line, over }`): after each computation, when the stored day or line is not
 *   today's / the current one, or nothing is stored, the state starts again from the current value without a report;
 *   otherwise `over` stays true once reached (so the same day and line report at most once) and an under -> over step
 *   is reported through onCross, unless the computation is a baseline: the first one since construction or since
 *   ready() was last seen false, a settingsChanged() one, or one while ready() is false (the crossing is consumed then,
 *   never reported later).
 * - onUpdate listeners get every result that differs from the previous one (asOf aside).
 */
export class TodayService {
  private readonly now: () => number;
  private readonly dayKey: (ms: number) => string;
  private readonly timers: Timers;
  private readonly listeners = new Set<(usage: TodayUsage) => void>();
  private latest: TodayUsage | null = null;
  /** JSON of the latest result without asOf (what decides a push). */
  private latestKey: string | null = null;
  private running: Promise<void> | null = null;
  /** A computation asked for while one runs (it starts after); `baseline` if any asker wanted one. */
  private queued: { baseline: boolean; promise: Promise<void> } | null = null;
  /** A change was noted since the last computation began. */
  private dirty = false;
  /** The last result had a growing open turn today. */
  private growing = false;
  private lastRunAt = -Infinity;
  private timer: unknown = null;
  private timerAt: number | null = null;
  private midnight: unknown = null;
  /** undefined: not read from meta yet. */
  private state: OverState | null | undefined = undefined;
  /** The next computation while ready is a baseline: none yet since construction, or ready() was seen false since. */
  private needBaseline = true;
  /** ready() was seen false: the timer only checks it, and a baseline computation follows once it holds. */
  private waiting = false;
  private closed = false;

  constructor(private readonly deps: TodayServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.dayKey = deps.dayKey ?? localDayKey;
    this.timers = deps.timers ?? realTimers;
    // Start-up work in progress (start(): before the initial scan): the baseline follows once it is over, also when no
    // change or request comes first. Nothing is computed here.
    if (!this.isReady()) this.schedule();
  }

  /** The latest result; computed first when there is none yet, or when a change is pending and the window has passed. */
  async get(): Promise<TodayUsage> {
    if (this.closed) throw new Error('today service closed');
    if (this.running !== null) await this.running.catch(() => undefined);
    if (this.latest === null || (this.dirty && this.now() - this.lastRunAt >= TODAY_THROTTLE_MS)) await this.request(false);
    if (this.latest === null) throw new Error('today service closed');
    return this.latest;
  }

  /** Fed from pipeline.onChanges: a recompute is due within TODAY_THROTTLE_MS of the previous one. */
  noteChanges(changes: readonly SeqChange[]): void {
    if (changes.length === 0 || this.closed) return;
    this.dirty = true;
    this.isReady(); // an import starting: wait instead of recomputing
    this.schedule();
  }

  /** The notification settings changed (the line may have): recompute now; never reports a crossing. */
  settingsChanged(): void {
    this.request(true).catch(() => undefined);
  }

  onUpdate(listener: (usage: TodayUsage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Stops every timer; nothing is computed or pushed after it. */
  close(): void {
    this.closed = true;
    this.clearTimer();
    if (this.midnight !== null) this.timers.clearTimeout(this.midnight);
    this.midnight = null;
    this.listeners.clear();
  }

  // ---------------------------------------------------------------- internals

  /** deps.ready(), noting a false answer (wait, then a baseline). A throwing check counts as not ready. */
  private isReady(): boolean {
    let ready = false;
    try {
      ready = this.deps.ready();
    } catch {
      // not ready
    }
    if (!ready) {
      this.needBaseline = true;
      this.waiting = true;
    }
    return ready;
  }

  private request(baseline: boolean): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.queued !== null) {
      this.queued.baseline ||= baseline;
      return this.queued.promise;
    }
    if (this.running === null) return this.begin(baseline);
    const queued = { baseline, promise: Promise.resolve() };
    const go = (): Promise<void> => {
      this.queued = null;
      return this.begin(queued.baseline);
    };
    queued.promise = this.running.then(go, go);
    this.queued = queued;
    return queued.promise;
  }

  private begin(baseline: boolean): Promise<void> {
    const run: Promise<void> = this.compute(baseline).finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  private async compute(baseline: boolean): Promise<void> {
    if (this.closed) return;
    this.dirty = false;
    this.lastRunAt = this.now();
    this.clearTimer();
    let snapshot;
    try {
      snapshot = await this.deps.cache.snapshot();
    } catch (err) {
      if (this.closed) return;
      this.dirty = true; // try again at the next due time
      this.schedule();
      throw err;
    }
    if (this.closed) return;
    const nowMs = this.now();
    const base = computeToday(snapshot.entries, nowMs, this.dayKey);
    const line = this.deps.line();
    const usage: TodayUsage = { ...base, lineTokens: line, over: base.main !== null && line !== null && base.main >= line };
    this.growing = growingToday(snapshot.entries, base.day, nowMs, this.dayKey);
    const ready = this.isReady();
    this.judge(usage, baseline || this.needBaseline || !ready);
    if (ready) {
      this.needBaseline = false;
      this.waiting = false;
    }
    this.latest = usage;
    const { asOf: _asOf, ...rest } = usage;
    const key = JSON.stringify(rest);
    if (key !== this.latestKey) {
      this.latestKey = key;
      for (const listener of [...this.listeners]) {
        try {
          listener(usage);
        } catch {
          // a failing listener must not affect the others
        }
      }
    }
    this.schedule();
    this.armMidnight();
  }

  /** The over-state rule (see the class comment); a baseline never reports. */
  private judge(usage: TodayUsage, baseline: boolean): void {
    const stored = this.loadState();
    const same = stored !== null && stored.day === usage.day && stored.line === usage.lineTokens;
    const was = same && stored.over;
    const next: OverState = { day: usage.day, line: usage.lineTokens, over: was || usage.over };
    const cross = same && !baseline && !was && usage.over;
    if (!same || next.over !== stored.over) this.saveState(next);
    if (cross) {
      try {
        this.deps.onCross?.(usage);
      } catch {
        // the notification service logs its own failures
      }
    }
  }

  private loadState(): OverState | null {
    if (this.state === undefined) {
      try {
        this.state = parseState(this.deps.store.getMeta(TODAY_META_KEY));
      } catch {
        this.state = null;
      }
    }
    return this.state;
  }

  /** Kept in memory even when the write fails (no repeated report while this process runs). */
  private saveState(next: OverState): void {
    this.state = next;
    try {
      this.deps.store.setMeta(TODAY_META_KEY, JSON.stringify(next));
    } catch {
      // a later change writes it again
    }
  }

  /**
   * Arms the timer: while waiting for the start-up work, a check TODAY_THROTTLE_MS from now (an armed one is kept, so a
   * stream of changes never pushes it back); else the throttled recompute for a pending change or a growing open turn;
   * none otherwise.
   */
  private schedule(): void {
    if (this.closed) return;
    if (this.waiting) {
      if (this.timer === null) this.arm(this.now() + TODAY_THROTTLE_MS);
      return;
    }
    if (!this.dirty && !this.growing) {
      this.clearTimer();
      return;
    }
    const at = this.lastRunAt + TODAY_THROTTLE_MS;
    if (this.timer !== null && this.timerAt === at) return;
    this.arm(at);
  }

  private arm(at: number): void {
    this.clearTimer();
    this.timerAt = at;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.timerAt = null;
      this.onTimer();
    }, Math.max(0, at - this.now()));
  }

  private onTimer(): void {
    if (this.closed) return;
    if (!this.isReady()) {
      this.schedule(); // check again later; the noted changes wait
      return;
    }
    // Start-up work just ended: the baseline (needBaseline is set). Otherwise a pending change or a growing turn.
    if (this.waiting || this.dirty || this.growing) this.request(false).catch(() => undefined);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = null;
  }

  /** One timer for the next local day start; it recomputes and arms the next one. */
  private armMidnight(): void {
    if (this.closed || this.midnight !== null) return;
    const nowMs = this.now();
    this.midnight = this.timers.setTimeout(() => {
      this.midnight = null;
      if (!this.isReady()) {
        // During start-up work: the baseline that follows it computes the new day.
        this.schedule();
        this.armMidnight();
        return;
      }
      void this.request(false).catch(() => undefined).finally(() => this.armMidnight());
    }, Math.max(1, nextDayStart(nowMs, this.dayKey) - nowMs));
  }
}
