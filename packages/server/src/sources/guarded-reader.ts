import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import type { SourceRead } from './source.js';
import { readLinesAt } from './transcript/reader.js';

/** Bytes at each end of what was read that the guard covers. */
const GUARD_BYTES = 64;
const STATE_VERSION = 'g1';

interface Guard {
  head: string;
  tail: string;
}

function parseState(state: string | null): Guard | null {
  if (state === null) return null;
  const [v, head, tail] = state.split(':');
  return v === STATE_VERSION && head !== undefined && tail !== undefined ? { head, tail } : null;
}

async function sha1At(handle: fs.FileHandle, from: number, to: number): Promise<string> {
  const buf = Buffer.alloc(to - from);
  let done = 0;
  while (done < buf.length) {
    const { bytesRead } = await handle.read(buf, done, buf.length - done, from + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return createHash('sha1').update(buf.subarray(0, done)).digest('hex');
}

/** The guard over bytes [0, end): SHA-1 of the first and of the last (up to) GUARD_BYTES of them. */
async function guardOf(handle: fs.FileHandle, end: number): Promise<Guard> {
  return { head: await sha1At(handle, 0, Math.min(GUARD_BYTES, end)), tail: await sha1At(handle, Math.max(0, end - GUARD_BYTES), end) };
}

/**
 * readNewLines plus a guard: SHA-1 of the first and of the last (up to) 64 bytes already read; a mismatch means
 * rewritten. A file shorter than `fromOffset`, or whose guarded bytes changed, is read again from the start with
 * `truncated: true`, so a rewrite is noticed even when the file did not get shorter (a change between the guarded ends
 * is not). Without a stored guard (`state` null) reading goes on from `fromOffset` and the guard starts there. The
 * state returned covers the bytes up to `newOffset`; undefined when nothing was read and the stored one still holds.
 * Everything else (line splitting, budget, CRLF, blank and partial lines, a missing file) is readNewLines' own.
 */
export async function readGuardedLines(absPath: string, fromOffset: number, maxBytes: number, state: string | null): Promise<SourceRead> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(absPath, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { lines: [], newOffset: 0, truncated: false };
    throw err;
  }
  try {
    const { size } = await handle.stat();
    const guard = parseState(state);
    let truncated = size < fromOffset;
    if (!truncated && fromOffset > 0 && guard !== null) {
      const now = await guardOf(handle, fromOffset);
      truncated = now.head !== guard.head || now.tail !== guard.tail;
    }
    const start = truncated ? 0 : fromOffset;
    const { lines, newOffset } = await readLinesAt(handle, size, start, maxBytes);
    if (!truncated && newOffset === fromOffset && (guard !== null || newOffset === 0)) return { lines, newOffset, truncated };
    let next: string | null = null;
    if (newOffset > 0) {
      const g = await guardOf(handle, newOffset);
      next = `${STATE_VERSION}:${g.head}:${g.tail}`;
    }
    return { lines, newOffset, truncated, state: next };
  } finally {
    await handle.close();
  }
}
