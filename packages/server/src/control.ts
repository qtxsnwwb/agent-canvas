import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { removeSync } from './fs-remove.js';

/**
 * The service's control key (spec 2026-11-25-background-service-design.md 5): a random key written to the data
 * directory at every start; a stop request (`POST /api/control/stop`) must carry it in CONTROL_HEADER. Only a process
 * that can read the data directory can stop the service; a web page can neither read the file nor send the request
 * (the route refuses any request with an Origin).
 */
export const CONTROL_KEY_FILE = 'control.key';
export const CONTROL_HEADER = 'x-agent-canvas-key';

const KEY_PATTERN = /^[0-9a-f]{64}$/;

const keyPath = (dataDir: string): string => path.join(dataDir, CONTROL_KEY_FILE);

/**
 * Writes a new key (32 random bytes, 64 hex characters) to `<dataDir>/control.key`, replacing any earlier one; the file
 * is created anew with mode 0600 (read and write for this user only; on Windows the data directory's inherited
 * permissions apply).
 */
export function createControlKey(dataDir: string): string {
  const key = crypto.randomBytes(32).toString('hex');
  const file = keyPath(dataDir);
  // Removed first: an existing file keeps its mode on overwrite, and that mode may be looser.
  removeSync(file);
  fs.writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
  return key;
}

/** The key in `<dataDir>/control.key`; null when there is none or it is not a key. */
export function readControlKey(dataDir: string): string | null {
  try {
    const key = fs.readFileSync(keyPath(dataDir), 'utf8').trim();
    return KEY_PATTERN.test(key) ? key : null;
  } catch {
    return null;
  }
}

/** Removes `<dataDir>/control.key` when it still holds `key` (a newer service's key stays). Never throws. */
export function removeControlKey(dataDir: string, key: string): void {
  try {
    if (readControlKey(dataDir) === key) removeSync(keyPath(dataDir));
  } catch {
    // best effort: the next start replaces it
  }
}

/** Whether `given` (a request header's value) is the key; compared in constant time. */
export function keyMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string' || expected === '') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
