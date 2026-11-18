import os from 'node:os';
import path from 'node:path';

export interface Config {
  projectsDir: string;
  /**
   * Codex rollout files (`AGENT_CANVAS_CODEX_DIR`, default `~/.codex/sessions`); null = Codex is not read (the
   * variable set to the empty string).
   */
  codexSessionsDir: string | null;
  /**
   * Cursor's state database (`AGENT_CANVAS_CURSOR_DB`, default defaultCursorDbPath()); null = Cursor is not read (the
   * variable set to the empty string). Only ever opened read-only.
   */
  cursorDbPath: string | null;
  /**
   * Gemini CLI's directory (`AGENT_CANVAS_GEMINI_DIR`, else `$GEMINI_CLI_HOME/.gemini`, else `~/.gemini`); null =
   * Gemini CLI is not read (the variable set to the empty string). See resolveToolDir.
   */
  geminiDir: string | null;
  /** Grok Build's directory (`AGENT_CANVAS_GROK_DIR`, else `$GROK_HOME`, else `~/.grok`); null = not read. */
  grokDir: string | null;
  /** Copilot CLI's directory (`AGENT_CANVAS_COPILOT_DIR`, else `$COPILOT_HOME`, else `~/.copilot`); null = not read. */
  copilotDir: string | null;
  /** DeepSeek Harness's home (`AGENT_CANVAS_DSH_DIR`, else `$DSH_HOME`, else `~/.dsh`); null = not read. */
  deepseekDir: string | null;
  /**
   * WorkBuddy's directories: `AGENT_CANVAS_WORKBUDDY_DIR` (one; the empty string: none, not read), else
   * `$WORKBUDDY_CONFIG_DIR` (one), else both `~/.workbuddy` and `~/.workbuddy-ai`. Empty = not read.
   */
  workbuddyDirs: readonly string[];
  /** CodeBuddy Code's directory (`AGENT_CANVAS_CODEBUDDY_DIR`, else `$CODEBUDDY_CONFIG_DIR`, else `~/.codebuddy`); null = not read. */
  codebuddyDir: string | null;
  /**
   * Doubao Work's "User Data"-level directories: `AGENT_CANVAS_DOUBAO_DIR` (one; the empty string: none, not read),
   * else defaultDoubaoDirs(). Empty = not read.
   */
  doubaoDirs: readonly string[];
  /**
   * Qwen Code's runtime base (`AGENT_CANVAS_QWEN_DIR`, else `$QWEN_RUNTIME_DIR`, else `$QWEN_HOME`, else `~/.qwen`; in
   * the three variables a leading `~` is the home directory and a relative path resolves against the working
   * directory); null = not read. Its source reads `<qwenDir>/projects`.
   */
  qwenDir: string | null;
  dataDir: string;
  dbPath: string;
  host: '127.0.0.1';
  port: number;
  /** Hot-set rescan period: stats only files of recently touched sessions and failed files. */
  rescanMs: number;
  /** Full directory listing period: new files chokidar missed, deletions. */
  fullScanMs: number;
  /** Normalizer state of sessions untouched for this long is dropped (re-hydrated on demand). */
  evictAfterMs: number;
  /** Built web UI directory, served by a later task. */
  webDist: string | null;
}

/**
 * Where Cursor keeps its state database on `platform`: Windows `%APPDATA%\Cursor\User\globalStorage\state.vscdb`
 * (APPDATA unset: `<home>\AppData\Roaming`), macOS `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`,
 * elsewhere `~/.config/Cursor/User/globalStorage/state.vscdb`.
 */
export function defaultCursorDbPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const tail = ['Cursor', 'User', 'globalStorage', 'state.vscdb'];
  if (platform === 'win32') {
    const appData = env.APPDATA !== undefined && env.APPDATA !== '' ? env.APPDATA : path.win32.join(home, 'AppData', 'Roaming');
    return path.win32.join(appData, ...tail);
  }
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', ...tail);
  return path.posix.join(home, '.config', ...tail);
}

/**
 * Where Doubao Work keeps its "User Data"-level directories on `platform`, the standalone client first, then the Doubao
 * app's work mode: Windows `%LOCALAPPDATA%\DoubaoWork\User Data` and `%LOCALAPPDATA%\Doubao\User Data` (LOCALAPPDATA
 * unset or empty: `<home>\AppData\Local`), macOS `~/Library/Application Support/DoubaoWork` and `…/Doubao`; none
 * elsewhere (there is no client).
 */
export function defaultDoubaoDirs(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string[] {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA !== undefined && env.LOCALAPPDATA !== '' ? env.LOCALAPPDATA : path.win32.join(home, 'AppData', 'Local');
    return [path.win32.join(local, 'DoubaoWork', 'User Data'), path.win32.join(local, 'Doubao', 'User Data')];
  }
  if (platform === 'darwin') {
    const support = path.posix.join(home, 'Library', 'Application Support');
    return [path.posix.join(support, 'DoubaoWork'), path.posix.join(support, 'Doubao')];
  }
  return [];
}

/**
 * Several tool directories, in resolveToolDir's order: the explicit override → our variable `ownVar` naming one
 * directory (the empty string: none, the tool is not read) → the tool's own variable `toolVar` naming one (unset or
 * empty: skipped; null: the tool has none) → `fallback`.
 */
function resolveToolDirs(
  override: readonly string[] | undefined,
  env: NodeJS.ProcessEnv,
  ownVar: string,
  toolVar: string | null,
  fallback: () => readonly string[],
): readonly string[] {
  if (override !== undefined) return override;
  const own = env[ownVar];
  if (own !== undefined) return own === '' ? [] : [own];
  const tool = toolVar === null ? undefined : env[toolVar];
  if (tool !== undefined && tool !== '') return [tool];
  return fallback();
}

/** How resolveToolDir turns a variable's value into the directory (default for both: the value as given). */
interface ToolDirReading {
  /** For the value of one of the tool's own variables. */
  fromToolVar?: (value: string) => string;
  /** For the value of our variable. */
  fromOwnVar?: (value: string) => string;
}

/**
 * A tool directory, first hit wins: the explicit override (null included) → our variable `ownVar` (the empty string:
 * null, the tool is not read), through `reading.fromOwnVar` → the tool's own variables `toolVars` in order (each unset or
 * empty: skipped), through `reading.fromToolVar` → `fallback` (under the home directory).
 */
function resolveToolDir(
  override: string | null | undefined,
  env: NodeJS.ProcessEnv,
  ownVar: string,
  toolVars: string | readonly string[],
  fallback: string,
  reading: ToolDirReading = {},
): string | null {
  const { fromToolVar = (v: string) => v, fromOwnVar = (v: string) => v } = reading;
  if (override !== undefined) return override;
  const own = env[ownVar];
  if (own !== undefined) return own === '' ? null : fromOwnVar(own);
  for (const toolVar of typeof toolVars === 'string' ? [toolVars] : toolVars) {
    const tool = env[toolVar];
    if (tool !== undefined && tool !== '') return fromToolVar(tool);
  }
  return fallback;
}

/**
 * A directory named the way Qwen Code reads its own variables: a leading `~` (alone, or followed by `/`, or on Windows
 * by `\`, the separators of the platform) is `home`, a relative path resolves against the working directory, an
 * absolute one is kept as given. Exported for tests (`platform` lets them try the other platforms).
 */
export function userPath(value: string, home: string, platform: NodeJS.Platform = process.platform): string {
  if (value === '~') return home;
  if (value.startsWith('~/') || (platform === 'win32' && value.startsWith('~\\'))) return path.join(home, value.slice(2));
  return path.isAbsolute(value) ? value : path.resolve(value);
}

/** Explicit overrides win over environment variables, which win over defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const dataDir = overrides.dataDir ?? env.AGENT_CANVAS_DATA_DIR ?? path.join(os.homedir(), '.agent-canvas');
  const projectsDir = overrides.projectsDir ?? env.AGENT_CANVAS_PROJECTS_DIR ?? path.join(os.homedir(), '.claude', 'projects');
  const codexEnv = env.AGENT_CANVAS_CODEX_DIR;
  const codexSessionsDir =
    overrides.codexSessionsDir !== undefined
      ? overrides.codexSessionsDir
      : codexEnv === undefined
        ? path.join(os.homedir(), '.codex', 'sessions')
        : codexEnv === ''
          ? null
          : codexEnv;
  const cursorEnv = env.AGENT_CANVAS_CURSOR_DB;
  const cursorDbPath =
    overrides.cursorDbPath !== undefined
      ? overrides.cursorDbPath
      : cursorEnv === undefined
        ? defaultCursorDbPath(process.platform, env)
        : cursorEnv === ''
          ? null
          : cursorEnv;
  const home = os.homedir();
  const geminiDir = resolveToolDir(overrides.geminiDir, env, 'AGENT_CANVAS_GEMINI_DIR', 'GEMINI_CLI_HOME', path.join(home, '.gemini'), { fromToolVar: (v) => path.join(v, '.gemini') });
  const grokDir = resolveToolDir(overrides.grokDir, env, 'AGENT_CANVAS_GROK_DIR', 'GROK_HOME', path.join(home, '.grok'));
  const copilotDir = resolveToolDir(overrides.copilotDir, env, 'AGENT_CANVAS_COPILOT_DIR', 'COPILOT_HOME', path.join(home, '.copilot'));
  const deepseekDir = resolveToolDir(overrides.deepseekDir, env, 'AGENT_CANVAS_DSH_DIR', 'DSH_HOME', path.join(home, '.dsh'));
  const workbuddyDirs = resolveToolDirs(overrides.workbuddyDirs, env, 'AGENT_CANVAS_WORKBUDDY_DIR', 'WORKBUDDY_CONFIG_DIR', () => [
    path.join(home, '.workbuddy'),
    path.join(home, '.workbuddy-ai'),
  ]);
  const codebuddyDir = resolveToolDir(overrides.codebuddyDir, env, 'AGENT_CANVAS_CODEBUDDY_DIR', 'CODEBUDDY_CONFIG_DIR', path.join(home, '.codebuddy'));
  const doubaoDirs = resolveToolDirs(overrides.doubaoDirs, env, 'AGENT_CANVAS_DOUBAO_DIR', null, () => defaultDoubaoDirs(process.platform, env, home));
  const qwenPath = (v: string): string => userPath(v, home);
  const qwenDir = resolveToolDir(overrides.qwenDir, env, 'AGENT_CANVAS_QWEN_DIR', ['QWEN_RUNTIME_DIR', 'QWEN_HOME'], path.join(home, '.qwen'), { fromToolVar: qwenPath, fromOwnVar: qwenPath });
  return {
    host: '127.0.0.1',
    port: 4317,
    rescanMs: 3000,
    fullScanMs: 60_000,
    evictAfterMs: 600_000,
    webDist: null,
    ...overrides,
    projectsDir,
    codexSessionsDir,
    cursorDbPath,
    geminiDir,
    grokDir,
    copilotDir,
    deepseekDir,
    workbuddyDirs,
    codebuddyDir,
    doubaoDirs,
    qwenDir,
    dataDir,
    dbPath: overrides.dbPath ?? path.join(dataDir, 'data.db'),
  };
}
