import type { Diagnostics } from '@claude-canvas/shared';

/** The hook events `claude-canvas hooks install` registers. Kept in step with docs/hooks-snippet.json by a test. */
export const EXPECTED_HOOK_EVENTS: readonly string[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PermissionDenied',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'Notification',
  'Stop',
  'StopFailure',
  'PostCompact',
  'SessionEnd',
];

/** No hook for longer than this and the status turns `quiet`. */
export const HOOK_QUIET_MS = 10 * 60 * 1000;
export const FILES_BEHIND_MAX = 200;
export const SAMPLE_DISPLAY_MAX = 2000;

export interface DiagnosticsSummary {
  hooks: 'never' | 'recent' | 'quiet';
  hookAgeMs: number | null;
  missingHookEvents: string[];
  filesTotal: number;
  /** Files with offset < size, at most FILES_BEHIND_MAX of them. */
  filesBehind: { path: string; offset: number; size: number }[];
  /** Count of all files with offset < size (filesBehind may be cut). */
  behindTotal: number;
  unknownTotal: number;
}

export function summarizeDiagnostics(d: Diagnostics, nowMs: number): DiagnosticsSummary {
  const last = d.lastHookAt === null ? Number.NaN : Date.parse(d.lastHookAt);
  const hookAgeMs = Number.isNaN(last) ? null : Math.max(0, nowMs - last);
  // A present but unparseable timestamp is not "never received": hooks did arrive, we just cannot date them.
  const hooks: DiagnosticsSummary['hooks'] =
    d.lastHookAt === null ? 'never' : hookAgeMs === null ? 'quiet' : hookAgeMs <= HOOK_QUIET_MS ? 'recent' : 'quiet';
  const seen = new Set(d.hookEvents.map((e) => e.eventName));
  const behind = d.files.filter((f) => f.offset < f.size);
  return {
    hooks,
    hookAgeMs,
    missingHookEvents: EXPECTED_HOOK_EVENTS.filter((e) => !seen.has(e)),
    filesTotal: d.files.length,
    behindTotal: behind.length,
    filesBehind: behind.slice(0, FILES_BEHIND_MAX).map((f) => ({ path: f.path, offset: f.offset, size: f.size })),
    unknownTotal: d.unknownRecords.reduce((n, r) => n + r.count, 0),
  };
}

/** "N 秒前" / "N 分钟前" / "N 小时前". */
export function formatAge(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  return `${Math.floor(s / 3600)} 小时前`;
}

/** Unknown-record samples hold raw conversation content: show at most this much of one. */
export function truncateSample(sample: string): string {
  return sample.length > SAMPLE_DISPLAY_MAX ? `${sample.slice(0, SAMPLE_DISPLAY_MAX)}…` : sample;
}

export type PollResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Polls `load` with a chained timer: the next request is scheduled `intervalMs` after the previous one settles
 * (success or failure), so at most one is in flight and results are delivered in order. `stop()` cancels the timer
 * and suppresses the result of a request still in flight.
 */
export function createPoller<T>(deps: {
  load(): Promise<T>;
  onResult(r: PollResult<T>): void;
  intervalMs: number;
}): { start(): void; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let started = false;
  const tick = (): void => {
    timer = null;
    const settle = (r: PollResult<T>): void => {
      if (stopped) return;
      deps.onResult(r);
      timer = setTimeout(tick, deps.intervalMs);
    };
    deps.load().then(
      (value) => settle({ ok: true, value }),
      (e: unknown) => settle({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
  };
  return {
    start() {
      if (started || stopped) return;
      started = true;
      tick();
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
