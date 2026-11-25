import fs from 'node:fs';
import path from 'node:path';

/*
 * Use this instead of fs.rmSync: on Node 25 (Windows) fs.rmSync ends the process with 0xC0000409, uncatchable, when
 * the path has non-ASCII characters (a data directory under C:\Users\张三\ for example). unlinkSync, rmdirSync,
 * lstatSync and readdirSync are not affected.
 */

function missing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function ignoringMissing(remove: () => void): void {
  try {
    remove();
  } catch (err) {
    if (!missing(err)) throw err;
  }
}

/**
 * Removes `target` as fs.rmSync with `force: true` does: a missing path is fine; a file (or symbolic link, not
 * followed) is unlinked; a directory is removed with its contents when `recursive` is set, else it throws
 * ERR_FS_EISDIR. Other errors propagate.
 */
export function removeSync(target: string, opts: { recursive?: boolean } = {}): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (err) {
    if (missing(err)) return;
    throw err;
  }
  if (!stat.isDirectory()) return ignoringMissing(() => fs.unlinkSync(target));
  if (opts.recursive !== true) {
    throw Object.assign(new Error(`Path is a directory: ${target}`), { code: 'ERR_FS_EISDIR', path: target });
  }
  for (const entry of fs.readdirSync(target)) removeSync(path.join(target, entry), { recursive: true });
  ignoringMissing(() => fs.rmdirSync(target));
}
