/**
 * The stats warm-up: builds the session summaries in the background once the service's start-up work is over, so the
 * first open of the stats page normally finds them ready (a cold build of the real dataset takes seconds).
 *
 * - It waits (checking every `pollMs`) until `settled()` holds, which start() wires to pipeline.startupDone(): the
 *   initial scan, a rebuild and every poll source's first round are over. So it never competes with start-up, and it
 *   does not summarize sessions that are still being imported. After `maxWaitMs` it warms anyway (a poll source that
 *   never completes a round must not keep the stats cold for good).
 * - `warm()` is StatsService.warm: the same refresh a request runs, yielding to the event loop as a request does; a
 *   request arriving meanwhile joins it instead of starting another.
 * - `stop()` cancels the wait; a running warm-up is stopped by closing the service (start()'s close does both).
 * - Its timer is unref'd: it never keeps the process alive. Nothing it does throws out of it.
 */

export interface StatsWarmupOptions {
  warm: () => Promise<void>;
  settled: () => boolean;
  /** How often `settled` is checked. Default 1 s. */
  pollMs?: number;
  /** Warm anyway this long after the warm-up was scheduled. Default 2 minutes. */
  maxWaitMs?: number;
}

export interface StatsWarmup {
  /** Resolves once the warm-up has run, or was stopped before it began. Never rejects. */
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

export const STATS_WARMUP_POLL_MS = 1000;
export const STATS_WARMUP_MAX_WAIT_MS = 120_000;

export function startStatsWarmup(options: StatsWarmupOptions): StatsWarmup {
  const pollMs = Math.max(1, options.pollMs ?? STATS_WARMUP_POLL_MS);
  const maxWaitMs = options.maxWaitMs ?? STATS_WARMUP_MAX_WAIT_MS;
  const since = Date.now();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const isSettled = (): boolean => {
    try {
      return options.settled();
    } catch {
      return false;
    }
  };
  const check = (): void => {
    timer = null;
    if (stopped) return finish();
    if (!isSettled() && Date.now() - since < maxWaitMs) {
      timer = setTimeout(check, pollMs);
      timer.unref?.();
      return;
    }
    let warming: Promise<void>;
    try {
      warming = options.warm();
    } catch {
      warming = Promise.resolve();
    }
    void warming.catch(() => undefined).then(finish);
  };
  timer = setTimeout(check, pollMs);
  timer.unref?.();

  return {
    done,
    async stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
        finish();
      }
    },
  };
}
