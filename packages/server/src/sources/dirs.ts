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

/**
 * The subdirectory of each file-only tool's directory that its source reads; '' = the tool directory itself (Doubao
 * Work's "User Data"-level directories, whose profiles the source finds below them).
 */
const SOURCE_SUBDIR: Record<FileOnlyOrigin, string> = {
  gemini: 'tmp',
  grok: 'sessions',
  copilot: 'session-state',
  deepseek: 'sessions',
  workbuddy: 'projects',
  codebuddy: 'projects',
  doubao: '',
};

/** The single-directory file-only origins that sourceDirOf answers for (the three added by the more-sources plan). */
export type SingleDirOrigin = 'gemini' | 'grok' | 'copilot';

/**
 * The directory the source of a file-only origin reads (`<geminiDir>/tmp`, `<grokDir>/sessions`,
 * `<copilotDir>/session-state`); null when that origin is disabled. Never created or read here.
 */
export function sourceDirOf(config: Pick<Config, 'geminiDir' | 'grokDir' | 'copilotDir'>, origin: SingleDirOrigin): string | null {
  const root = origin === 'gemini' ? config.geminiDir : origin === 'grok' ? config.grokDir : config.copilotDir;
  return root === null || root === '' ? null : path.join(root, SOURCE_SUBDIR[origin]);
}

/** The configured tool directories of a file-only origin (none when disabled), before SOURCE_SUBDIR is applied. */
function toolDirsOf(config: Pick<Config, ToolDirKey>, origin: FileOnlyOrigin): readonly (string | null)[] {
  switch (origin) {
    case 'gemini': return [config.geminiDir];
    case 'grok': return [config.grokDir];
    case 'copilot': return [config.copilotDir];
    case 'deepseek': return [config.deepseekDir];
    case 'workbuddy': return config.workbuddyDirs;
    case 'codebuddy': return [config.codebuddyDir];
    case 'doubao': return config.doubaoDirs;
  }
}

/** The Config keys naming the file-only tools' directories. */
export type ToolDirKey = 'geminiDir' | 'grokDir' | 'copilotDir' | 'deepseekDir' | 'workbuddyDirs' | 'codebuddyDir' | 'doubaoDirs';

/**
 * Every directory the source of a file-only origin reads, in configured order: `<geminiDir>/tmp`, `<grokDir>/sessions`,
 * `<copilotDir>/session-state`, `<deepseekDir>/sessions`, each `<workbuddyDir>/projects`, `<codebuddyDir>/projects`,
 * each Doubao "User Data" directory itself. Empty when that origin is disabled. Never created or read here.
 */
export function sourceDirsOf(config: Pick<Config, ToolDirKey>, origin: FileOnlyOrigin): string[] {
  const sub = SOURCE_SUBDIR[origin];
  const out: string[] = [];
  for (const root of toolDirsOf(config, origin)) {
    if (root === null || root === '') continue;
    out.push(sub === '' ? root : path.join(root, sub));
  }
  return out;
}
