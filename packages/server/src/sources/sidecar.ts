import fs from 'node:fs';

/*
 * Small sidecar files of a tool's directory (a path, a JSON summary) read by the file sources outside the line reader:
 * bounded and cached by mtime and size (Gemini CLI's `.project_root` / `projects.json`, Grok Build's `summary.json` /
 * `.cwd`).
 */

/** Number of sidecar file contents read so far (tests: reads are cached by mtime and size). */
export let sidecarReads = 0;

interface Cached<T> {
  mtimeMs: number;
  size: number;
  value: T;
}
const cache = new Map<string, Cached<unknown>>();

/**
 * `parse` of a small file's content, at most `max` bytes, cached per path by mtime and size (re-read only when either
 * changes). Missing, unreadable or larger than `max`: `parse(null)`.
 */
export function readSidecar<T>(file: string, max: number, parse: (text: string | null) => T): T {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    cache.delete(file);
    return parse(null);
  }
  try {
    const st = fs.fstatSync(fd);
    const hit = cache.get(file);
    if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value as T;
    let value: T;
    if (!st.isFile() || st.size > max) value = parse(null);
    else {
      const buf = Buffer.alloc(Math.min(st.size, max));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      sidecarReads += 1;
      value = parse(buf.subarray(0, n).toString('utf8'));
    }
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  } catch {
    return parse(null);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A usable working directory: one absolute path (POSIX `/…`, Windows `X:\…` / `X:/…`, UNC `\\server\share…`) without
 * control characters; anything else (spec 8: a damaged sidecar) is null.
 */
export function asWorkingDir(text: string | null): string | null {
  if (text === null) return null;
  const p = text.replace(/^\uFEFF/, '').replace(/[\r\n]+$/, '').trim();
  if (p === '' || /[\u0000-\u001f\u007f]/.test(p)) return null;
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p)) return p;
  return null;
}
