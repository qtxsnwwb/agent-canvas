import fs from 'node:fs';
import path from 'node:path';
import type { FileOnlyOrigin } from '@agent-canvas/shared';
import type { Config } from '../config.js';

/**
 * Whether `p` names a directory that exists now (stat only; anything that cannot be stat'ed is "no"). A file source
 * whose directory fails this is not created at start (spec 4.2): a directory that appears later is read after the next
 * start.
 */
export function isExistingDir(p: string | null): boolean {
  if (p === null || p === '') return false;
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The subdirectory of each file-only tool's directory that its source reads. */
const SOURCE_SUBDIR: Record<FileOnlyOrigin, string> = { gemini: 'tmp', grok: 'sessions', copilot: 'session-state' };

/**
 * The directory the source of a file-only origin reads (`<geminiDir>/tmp`, `<grokDir>/sessions`,
 * `<copilotDir>/session-state`); null when that origin is disabled. Never created or read here.
 */
export function sourceDirOf(config: Pick<Config, 'geminiDir' | 'grokDir' | 'copilotDir'>, origin: FileOnlyOrigin): string | null {
  const root = origin === 'gemini' ? config.geminiDir : origin === 'grok' ? config.grokDir : config.copilotDir;
  return root === null || root === '' ? null : path.join(root, SOURCE_SUBDIR[origin]);
}
