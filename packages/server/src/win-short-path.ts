import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isPlainToken } from './hooks-config.js';

/** Asks Windows for a path's 8.3 short form; returns the raw answer (null: no answer). May throw. */
export type ShortNameQuery = (longPath: string) => string | null;

/** Characters cmd.exe would interpret inside the `for` line below (or that end it): such a path is never passed. */
const CMD_UNSAFE = /[%"^&|<>!\r\n]/;

const QUERY_TIMEOUT_MS = 5000;

/** `cmd.exe /d /c for %I in ("<path>") do @echo %~sI`: no new dependency, nothing but the system's own cmd. */
export function queryShortNameWithCmd(longPath: string): string | null {
  const r = spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${longPath}") do @echo %~sI`], {
    encoding: 'utf8',
    timeout: QUERY_TIMEOUT_MS,
    windowsHide: true,
    // The line is passed as written: Node's quoting would turn the inner quotes into \" which cmd does not understand.
    windowsVerbatimArguments: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error !== undefined || r.status !== 0) return null;
  return r.stdout.split(/\r?\n/)[0] ?? null;
}

function sameFile(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  return a.ino !== 0n && a.ino === b.ino && a.dev === b.dev;
}

/**
 * The Windows 8.3 short form of an existing file's absolute path, when it is a plain token (see isPlainToken) naming
 * the same file; null otherwise (8.3 names disabled on the volume, a component without a short name, a query that
 * failed or timed out, an answer that is not the same file). `query` is injectable so tests do not spawn.
 */
export function windowsShortPath(longPath: string, query: ShortNameQuery = queryShortNameWithCmd): string | null {
  if (CMD_UNSAFE.test(longPath) || !path.win32.isAbsolute(longPath)) return null;
  let long: fs.BigIntStats;
  try {
    long = fs.statSync(longPath, { bigint: true });
  } catch {
    return null;
  }
  if (!long.isFile()) return null;
  let answer: string | null;
  try {
    answer = query(longPath);
  } catch {
    return null;
  }
  const short = answer?.trim() ?? '';
  if (short === '' || short === longPath || !isPlainToken(short)) return null;
  // Same drive (or UNC prefix) as the long form, and the very same file.
  if (short.slice(0, 2).toLowerCase() !== longPath.slice(0, 2).toLowerCase() || !fs.existsSync(short)) return null;
  try {
    return sameFile(long, fs.statSync(short, { bigint: true })) ? short : null;
  } catch {
    return null;
  }
}
