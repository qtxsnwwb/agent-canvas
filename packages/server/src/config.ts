import os from 'node:os';
import path from 'node:path';

export interface Config {
  projectsDir: string;
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

/** Explicit overrides win over environment variables, which win over defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const dataDir = overrides.dataDir ?? env.CLAUDE_CANVAS_DATA_DIR ?? path.join(os.homedir(), '.claude-canvas');
  const projectsDir = overrides.projectsDir ?? env.CLAUDE_CANVAS_PROJECTS_DIR ?? path.join(os.homedir(), '.claude', 'projects');
  return {
    host: '127.0.0.1',
    port: 4317,
    rescanMs: 3000,
    fullScanMs: 60_000,
    evictAfterMs: 600_000,
    webDist: null,
    ...overrides,
    projectsDir,
    dataDir,
    dbPath: overrides.dbPath ?? path.join(dataDir, 'data.db'),
  };
}
