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

const sha1 = (b: Buffer): string => createHash('sha1').update(b).digest('hex');

/** Bytes [from, to) of the open file (fewer when the file is shorter now). */
async function bytesAt(handle: fs.FileHandle, from: number, to: number): Promise<Buffer> {
  const buf = Buffer.alloc(Math.max(0, to - from));
  let done = 0;
  while (done < buf.length) {
    const { bytesRead } = await handle.read(buf, done, buf.length - done, from + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return buf.subarray(0, done);
}

/**
 * readNewLines plus a guard: SHA-1 of the first and of the last (up to) 64 bytes already read; a mismatch means
 * rewritten. A file shorter than `fromOffset`, or whose guarded bytes changed, is read again from the start with
 * `truncated: true`, so a rewrite is noticed even when the file did not get shorter (a change between the guarded ends
 * is not). Without a stored guard (`state` null) reading goes on from `fromOffset` and the guard starts there. The
 * state returned covers the bytes up to `newOffset`; undefined when nothing was read and the stored one still holds.
 * Everything else (line splitting, budget, CRLF, blank and partial lines, a missing file) is readNewLines' own.
 *
 * One open handle, one stat: lines are read up to the size seen then. The new guard is hashed from the very bytes
 * this call checked and read (never from a later read of the file), so a rewrite made while reading leaves a guard
 * that does not match the file, and the next call reports the rewrite.
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
    // The guarded ends of [0, fromOffset) as they are now: compared with the stored guard, and reused for the new one.
    let head: Buffer = Buffer.alloc(0);
    let tail: Buffer = Buffer.alloc(0);
    if (!truncated && fromOffset > 0) {
      head = await bytesAt(handle, 0, Math.min(GUARD_BYTES, fromOffset));
      tail = await bytesAt(handle, Math.max(0, fromOffset - GUARD_BYTES), fromOffset);
      if (guard !== null) truncated = sha1(head) !== guard.head || sha1(tail) !== guard.tail;
    }
    const start = truncated ? 0 : fromOffset;
    if (start === 0) {
      head = Buffer.alloc(0);
      tail = Buffer.alloc(0);
    }
    const { lines, newOffset } = await readLinesAt(handle, size, start, maxBytes, (bytes) => {
      if (head.length < GUARD_BYTES) head = Buffer.concat([head, bytes.subarray(0, GUARD_BYTES - head.length)]);
      const joined = bytes.length >= GUARD_BYTES ? bytes : Buffer.concat([tail, bytes]);
      tail = Buffer.from(joined.subarray(Math.max(0, joined.length - GUARD_BYTES)));
    });
    if (!truncated && newOffset === fromOffset && (guard !== null || newOffset === 0)) return { lines, newOffset, truncated };
    const next = newOffset === 0 ? null : `${STATE_VERSION}:${sha1(head)}:${sha1(tail)}`;
    return { lines, newOffset, truncated, state: next };
  } finally {
    await handle.close();
  }
}
