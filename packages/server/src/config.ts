import os from 'node:os';
import path from 'node:path';

export interface Config {
  projectsDir: string;
  /**
   * Codex rollout files (`CLAUDE_CANVAS_CODEX_DIR`, default `~/.codex/sessions`); null = Codex is not read (the
   * variable set to the empty string).
   */
  codexSessionsDir: string | null;
  /**
   * Cursor's state database (`CLAUDE_CANVAS_CURSOR_DB`, default defaultCursorDbPath()); null = Cursor is not read (the
   * variable set to the empty string). Only ever opened read-only.
   */
  cursorDbPath: string | null;
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

/** Explicit overrides win over environment variables, which win over defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const dataDir = overrides.dataDir ?? env.CLAUDE_CANVAS_DATA_DIR ?? path.join(os.homedir(), '.claude-canvas');
  const projectsDir = overrides.projectsDir ?? env.CLAUDE_CANVAS_PROJECTS_DIR ?? path.join(os.homedir(), '.claude', 'projects');
  const codexEnv = env.CLAUDE_CANVAS_CODEX_DIR;
  const codexSessionsDir =
    overrides.codexSessionsDir !== undefined
      ? overrides.codexSessionsDir
      : codexEnv === undefined
        ? path.join(os.homedir(), '.codex', 'sessions')
        : codexEnv === ''
          ? null
          : codexEnv;
  const cursorEnv = env.CLAUDE_CANVAS_CURSOR_DB;
  const cursorDbPath =
    overrides.cursorDbPath !== undefined
      ? overrides.cursorDbPath
      : cursorEnv === undefined
        ? defaultCursorDbPath(process.platform, env)
        : cursorEnv === ''
          ? null
          : cursorEnv;
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
    dataDir,
    dbPath: overrides.dbPath ?? path.join(dataDir, 'data.db'),
  };
}
