import { FILE_ONLY_ORIGINS, ORIGINS, type Diagnostics, type FileOnlyOrigin, type FileSourceStatus, type Origin } from '@agent-canvas/shared';
import { ORIGIN_LOOK } from './home';

/** The hook events `agent-canvas hooks install` registers. Kept in step with docs/hooks-snippet.json by a test. */
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

/** The hook events `agent-canvas hooks install --codex` registers in `~/.codex/hooks.json`. */
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

/** The hook events `agent-canvas hooks install --cursor` registers in `~/.cursor/hooks.json`. */
export const EXPECTED_CURSOR_HOOK_EVENTS: readonly string[] = ['sessionStart', 'beforeSubmitPrompt', 'stop', 'subagentStop', 'sessionEnd'];

export const EXPECTED_HOOK_EVENTS_BY_ORIGIN: Record<Origin, readonly string[]> = {
  claude: EXPECTED_HOOK_EVENTS,
  codex: EXPECTED_CODEX_HOOK_EVENTS,
  cursor: EXPECTED_CURSOR_HOOK_EVENTS,
  // No hooks are installed for these origins.
  gemini: [],
  grok: [],
  copilot: [],
  deepseek: [],
  workbuddy: [],
  codebuddy: [],
  doubao: [],
  qwen: [],
};

/**
 * The origin of a file by its store key: every origin but Claude Code prefixes its keys with `<origin>:` (Codex files,
 * Cursor conversations, Gemini CLI / Grok Build / Copilot CLI files); Claude Code's are unprefixed.
 */
export function fileOrigin(path: string): Origin {
  for (const origin of ORIGINS) if (origin !== 'claude' && path.startsWith(`${origin}:`)) return origin;
  return 'claude';
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
  const cursorKnown = d.cursor.dbExists || d.cursor.hasData === true;
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

/**
 * Whether the page shows the Cursor block: the database exists, or any Cursor data is known — stored records (the
 * server's `cursor.hasData`), hooks or unrecognised records (a configured path alone says nothing).
 */
export function cursorBlockVisible(d: Diagnostics): boolean {
  return d.cursor.dbExists
    || d.cursor.hasData === true
    || d.hookEvents.some((e) => e.origin === 'cursor')
    || cursorUnknownRecords(d).length > 0;
}

/**
 * Unknown records that come from Cursor: bubble shapes the normalizer does not know (`bubble:...`), records it could not
 * read (`composer:...`, `bubble:...`) and unknown record types (`cursor:...`).
 */
export function cursorUnknownRecords(d: Diagnostics): Diagnostics['unknownRecords'] {
  return d.unknownRecords.filter((r) => r.recordType.startsWith('bubble:') || r.recordType.startsWith('composer:') || r.recordType.startsWith('cursor:'));
}

/** The Cursor block's line about the database: not enabled / exists / does not exist. */
export function cursorDbLine(cursor: Diagnostics['cursor']): string {
  if (cursor.dbPath === null) return 'Cursor 数据库：未启用';
  return `Cursor 数据库：${cursor.dbPath}（${cursor.dbExists ? '存在' : '不存在，Cursor 似乎没有安装'}）`;
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

/**
 * Unknown records of a file-only origin (Gemini CLI, Grok Build, Copilot CLI, DeepSeek, WorkBuddy, CodeBuddy, 豆包,
 * Qwen Code):
 * their normalizers report every type as `<origin>:<type>`.
 */
export function originUnknownRecords(d: Diagnostics, origin: FileOnlyOrigin): Diagnostics['unknownRecords'] {
  return d.unknownRecords.filter((r) => r.recordType.startsWith(`${origin}:`));
}

export interface FileSourceBlock extends FileSourceStatus {
  origin: FileOnlyOrigin;
  unknown: Diagnostics['unknownRecords'];
}

/**
 * The blocks of the file-only origins (ORIGINS order), each shown once its directory exists or any of its data is
 * known (stored sessions, unknown records). A configured default directory alone says nothing (the tool may not be
 * installed), and a server before `sources` existed shows none.
 */
export function fileSourceBlocks(d: Diagnostics): FileSourceBlock[] {
  const out: FileSourceBlock[] = [];
  for (const origin of FILE_ONLY_ORIGINS) {
    const s = d.sources?.[origin] ?? { dir: null, present: false, reading: false, sessionCount: 0 };
    const unknown = originUnknownRecords(d, origin);
    if (s.present || s.sessionCount > 0 || unknown.length > 0) out.push({ origin, ...s, unknown });
  }
  return out;
}

/**
 * A file-only origin's line about its directory: not enabled / exists and read / exists but not read (it appeared after
 * the service started) / does not exist. `reading` absent (a server from before it existed) counts as read when present.
 */
export function fileSourceDirLine(origin: FileOnlyOrigin, s: FileSourceStatus): string {
  const label = ORIGIN_LOOK[origin].label;
  if (s.dir === null) return `${label} 会话目录：未启用`;
  const state = !s.present
    ? '不存在。目录出现后要重启服务才会读取'
    : s.unavailable !== undefined ? '存在，但无法读取，原因见下' // the reason: fileSourceDetailLines' warning line
    : s.reading === false ? '存在，但服务启动时还没有这个目录，尚未读取。重启服务后读取' : '存在';
  return `${label} 会话目录：${s.dir}（${state}）`;
}

/**
 * The lines a file-only origin's block shows below its directory line, from the optional fields of FileSourceStatus
 * (plan more-sources-cn; a field the server does not send gives no line, so Gemini CLI / Grok / Copilot CLI show none):
 * each folder read when there are several (WorkBuddy, Doubao Work), why the source cannot run (DeepSeek on a Node
 * without zstd), session directories with a format version not read (DeepSeek), sessions found again under another
 * root, profile or project folder (WorkBuddy, CodeBuddy, Doubao Work, Qwen Code), threads timed by file modification time and conversations not
 * read for want of a single main agent (Doubao Work), managed sessions not read (Qwen Code).
 * `warn`: worth a look (shown as a warning).
 */
export function fileSourceDetailLines(s: FileSourceStatus): { text: string; warn: boolean }[] {
  const out: { text: string; warn: boolean }[] = [];
  s.dirs?.forEach((d, i) => out.push({ text: `读取的目录 ${i + 1}：${d.dir}（${d.present ? '存在' : '不存在'}）`, warn: false }));
  if (s.unavailable !== undefined) out.push({ text: `无法读取：${s.unavailable}`, warn: true });
  if (s.legacyFiles !== undefined) out.push({ text: `有其他格式版本文件（不读）的会话目录：${s.legacyFiles} 个。只读第 4 版的 session.v4.jsonl.zstd`, warn: s.legacyFiles > 0 });
  if (s.duplicateSessions !== undefined) out.push({ text: `在另一个目录或配置里重复出现、只读了一份的会话：${s.duplicateSessions} 个`, warn: false });
  if (s.mtimeFallbacks !== undefined) out.push({ text: `时间只能取自文件修改时间的线程：${s.mtimeFallbacks} 个`, warn: s.mtimeFallbacks > 0 });
  if (s.unknownSessions !== undefined) out.push({ text: `没有主代理或有多个主代理、没有读取的对话：${s.unknownSessions} 个`, warn: s.unknownSessions > 0 });
  if (s.unsupportedSessions !== undefined) out.push({ text: `托管会话（格式不支持，没有读取）：${s.unsupportedSessions} 个`, warn: s.unsupportedSessions > 0 });
  return out;
}

/**
 * The line about hook calls dropped by the foreign-payload guard (Diagnostics.foreignHooksDropped); null for a server
 * that does not send it.
 */
export function foreignHooksLine(n: number | undefined): { text: string; warn: boolean } | null {
  if (n === undefined) return null;
  if (n === 0) return { text: '被丢弃的外来 hook 调用：0 次', warn: false };
  return {
    text: `被丢弃的外来 hook 调用：${n} 次。Grok 或 Copilot CLI 读到了为 Claude Code / Cursor 安装的 hook，这些调用已忽略，不影响数据`,
    warn: true,
  };
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
