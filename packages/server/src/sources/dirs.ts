import fs from 'node:fs';

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
