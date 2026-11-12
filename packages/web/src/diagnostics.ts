import { ORIGINS, type Diagnostics, type Origin } from '@claude-canvas/shared';

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

/** The hook events `claude-canvas hooks install --codex` registers in `~/.codex/hooks.json`. */
export const EXPECTED_CODEX_HOOK_EVENTS: readonly string[] = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'PostCompact',
  'Interrupt',
];

/** The hook events `claude-canvas hooks install --cursor` registers in `~/.cursor/hooks.json`. */
export const EXPECTED_CURSOR_HOOK_EVENTS: readonly string[] = ['sessionStart', 'beforeSubmitPrompt', 'stop', 'subagentStop', 'sessionEnd'];

export const EXPECTED_HOOK_EVENTS_BY_ORIGIN: Record<Origin, readonly string[]> = {
  claude: EXPECTED_HOOK_EVENTS,
  codex: EXPECTED_CODEX_HOOK_EVENTS,
  cursor: EXPECTED_CURSOR_HOOK_EVENTS,
};

/** The origin of a file by its store key: Codex files are `codex:`-prefixed, Cursor conversations `cursor:`-prefixed. */
export function fileOrigin(path: string): Origin {
  return path.startsWith('codex:') ? 'codex' : path.startsWith('cursor:') ? 'cursor' : 'claude';
}

/** Whether hooks were received, and how long ago, from the time of the last one (null: never). */
export function hookState(lastAt: string | null, nowMs: number): { hooks: DiagnosticsSummary['hooks']; hookAgeMs: number | null } {
  const last = lastAt === null ? Number.NaN : Date.parse(lastAt);
  const hookAgeMs = Number.isNaN(last) ? null : Math.max(0, nowMs - last);
  // A present but unparseable timestamp is not "never received": hooks did arrive, we just cannot date them.
  const hooks: DiagnosticsSummary['hooks'] =
    lastAt === null ? 'never' : hookAgeMs === null ? 'quiet' : hookAgeMs <= HOOK_QUIET_MS ? 'recent' : 'quiet';
  return { hooks, hookAgeMs };
}

export interface OriginHooks {
  origin: Origin;
  events: Diagnostics['hookEvents'];
  /** That origin's expected events never received, in its list's order. */
  missing: string[];
  /** The latest `lastAt` among its events; null when none. */
  lastAt: string | null;
}

/**
 * The hooks section, one entry per origin (ORIGINS order): Claude Code always (the page looks as before on a
 * Claude-only install), Codex once its sessions directory exists, or any Codex hook event or file is known (the
 * default directory is configured even where Codex is not installed, so being configured alone says nothing).
 */
export function hooksByOrigin(d: Diagnostics): OriginHooks[] {
  const codexKnown = d.codex.sessionsDirExists || d.files.some((f) => fileOrigin(f.path) === 'codex');
  const cursorKnown = d.cursor.dbExists || d.files.some((f) => fileOrigin(f.path) === 'cursor');
  const out: OriginHooks[] = [];
  for (const origin of ORIGINS) {
    const events = d.hookEvents.filter((e) => e.origin === origin);
    if (origin !== 'claude' && events.length === 0 && !(origin === 'codex' && codexKnown) && !(origin === 'cursor' && cursorKnown)) continue;
    const seen = new Set(events.map((e) => e.eventName));
    let lastAt: string | null = null;
    for (const e of events) {
      if (lastAt === null) { lastAt = e.lastAt; continue; }
      const t = Date.parse(e.lastAt);
      const best = Date.parse(lastAt);
      if (!Number.isNaN(t) && (Number.isNaN(best) || t > best)) lastAt = e.lastAt;
    }
    out.push({ origin, events, missing: EXPECTED_HOOK_EVENTS_BY_ORIGIN[origin].filter((e) => !seen.has(e)), lastAt });
  }
  return out;
}

/** Whether the page shows the Cursor block: the database exists, or any Cursor data is known (a configured path alone says nothing). */
export function cursorBlockVisible(d: Diagnostics): boolean {
  return d.cursor.dbExists
    || d.hookEvents.some((e) => e.origin === 'cursor')
    || d.files.some((f) => fileOrigin(f.path) === 'cursor')
    || cursorUnknownRecords(d).length > 0;
}

/** Unknown records that come from Cursor: bubble shapes the normalizer does not know (`bubble:...`) or `cursor:...` types. */
export function cursorUnknownRecords(d: Diagnostics): Diagnostics['unknownRecords'] {
  return d.unknownRecords.filter((r) => r.recordType.startsWith('bubble:') || r.recordType.startsWith('cursor:'));
}

/** The Cursor block's "last poll" text. */
export function cursorPollLine(lastPollAt: string | null, nowMs: number): string {
  if (lastPollAt === null) return '尚未轮询';
  const t = Date.parse(lastPollAt);
  return Number.isNaN(t) ? '时间无法识别' : formatAge(nowMs - t);
}

/** Cursor's hook events for the Cursor block (always an entry, empty when none arrived). */
export function cursorHooks(d: Diagnostics): OriginHooks {
  return hooksByOrigin({ ...d, cursor: { ...d.cursor, dbExists: true } }).find((h) => h.origin === 'cursor')
    ?? { origin: 'cursor', events: [], missing: [], lastAt: null };
}

/** The Codex block's line about the sessions directory. */
export function codexDirLine(codex: Diagnostics['codex']): string {
  if (codex.sessionsDir === null) return 'Codex 会话目录：未启用';
  return `Codex 会话目录：${codex.sessionsDir}（${codex.sessionsDirExists ? '存在' : '不存在，Codex 似乎没有安装'}）`;
}

export function summarizeDiagnostics(d: Diagnostics, nowMs: number): DiagnosticsSummary {
  const { hooks, hookAgeMs } = hookState(d.lastHookAt, nowMs);
  const seen = new Set(d.hookEvents.filter((e) => e.origin === 'claude').map((e) => e.eventName));
  const behind = d.files.filter((f) => f.offset < f.size);
  return {
    hooks,
    hookAgeMs,
    /** Claude Code's events never received (hooksByOrigin gives every origin's). */
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
