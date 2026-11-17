import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import { readGuardedLines } from '../guarded-reader.js';
import type { SourceRead } from '../source.js';

/** Most bytes of the last complete line read that the line guard covers (its end, when the line is longer). */
export const BUDDY_LINE_GUARD_MAX = 64 * 1024;
const VERSION = 'b1';

/** The line guard: bytes [start, end of what was read) and their SHA-1. */
interface LineGuard {
  start: number;
  hash: string;
}

/** `b1:<start>:<sha1>|<readGuardedLines state>`; start -1 = no line guard yet. Anything else: an inner state alone. */
function parse(state: string | null): { guard: LineGuard | null; inner: string | null } {
  if (state === null) return { guard: null, inner: null };
  const bar = state.indexOf('|');
  const head = bar === -1 ? '' : state.slice(0, bar);
  const [v, start, hash] = head.split(':');
  if (v !== VERSION || start === undefined || hash === undefined) return { guard: null, inner: state };
  const inner = state.slice(bar + 1);
  const n = Number(start);
  return { guard: Number.isInteger(n) && n >= 0 ? { start: n, hash } : null, inner: inner === '' ? null : inner };
}

function format(guard: LineGuard | null, inner: string | null): string {
  return `${VERSION}:${guard === null ? -1 : guard.start}:${guard === null ? '-' : guard.hash}|${inner ?? ''}`;
}

/** Marks a file that is not there (ENOENT): not a rewrite. */
const GONE = Symbol('gone');

/** SHA-1 of bytes [from, to) of the file; null when the file is shorter or cannot be read; GONE when it does not exist. */
async function hashRange(file: string, from: number, to: number): Promise<string | null | typeof GONE> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(file, 'r');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? GONE : null;
  }
  try {
    const buf = Buffer.alloc(to - from);
    let done = 0;
    while (done < buf.length) {
      const { bytesRead } = await handle.read(buf, done, buf.length - done, from + done);
      if (bytesRead === 0) return null;
      done += bytesRead;
    }
    return createHash('sha1').update(buf).digest('hex');
  } finally {
    await handle.close();
  }
}

/**
 * readGuardedLines plus a guard on the last complete line read (up to its last BUDDY_LINE_GUARD_MAX bytes). Every
 * Buddy line ends in the same `"sessionId":…,"cwd":…}` text, so the shared guard's 64-byte tail cannot tell a
 * rolled-back batch from the one written in its place when both end on the same byte; the whole last line (it starts
 * with the entry's `id` and `timestamp`) can. A mismatch is read as a rewrite: from the start, `truncated: true`.
 * The shared reader's behaviour for other sources is unchanged; its state is carried inside this one.
 */
export async function readBuddyLines(absPath: string, fromOffset: number, maxBytes: number, state: string | null): Promise<SourceRead> {
  const prev = parse(state);
  if (fromOffset > 0 && prev.guard !== null && prev.guard.start < fromOffset) {
    const now = await hashRange(absPath, prev.guard.start, fromOffset);
    if (now === GONE) {
      // Vanished (between the pipeline's stat and this read): whatever the shared reader says of a missing file, and
      // the stored state kept, so no generation is bumped and a file that comes back reads on.
      const res = await readGuardedLines(absPath, fromOffset, maxBytes, prev.inner);
      return res.lines.length === 0 && !res.truncated ? { ...res, state: undefined } : withGuard(res, absPath, prev, fromOffset);
    }
    if (now !== prev.guard.hash) {
      const res = await readGuardedLines(absPath, 0, maxBytes, null);
      return withGuard({ ...res, truncated: true }, absPath, null, null);
    }
  }
  const res = await readGuardedLines(absPath, fromOffset, maxBytes, prev.inner);
  return withGuard(res, absPath, prev, fromOffset);
}

/** The read with this guard's state: unchanged (undefined) when nothing was read and the inner state held. */
async function withGuard(res: SourceRead, absPath: string, prev: { guard: LineGuard | null; inner: string | null } | null, fromOffset: number | null): Promise<SourceRead> {
  const restarted = res.truncated || prev === null;
  const inner = res.state === undefined ? (restarted ? null : prev!.inner) : res.state;
  const last = res.lines[res.lines.length - 1];
  let guard: LineGuard | null;
  if (last !== undefined) {
    guard = { start: Math.max(last.offset, res.newOffset - BUDDY_LINE_GUARD_MAX), hash: '' };
  } else if (!restarted && res.newOffset === fromOffset) {
    if (res.state === undefined) return { ...res, state: undefined }; // nothing read, both guards hold
    guard = prev!.guard;
  } else if (!restarted && prev!.guard !== null) {
    // Only blank lines read: the window grows over them from the last line's start.
    guard = { start: Math.max(prev!.guard.start, res.newOffset - BUDDY_LINE_GUARD_MAX), hash: '' };
  } else {
    guard = null;
  }
  if (guard !== null && guard.hash === '') {
    const hash = guard.start < res.newOffset ? await hashRange(absPath, guard.start, res.newOffset) : null;
    guard = typeof hash === 'string' ? { start: guard.start, hash } : null;
  }
  return { ...res, state: format(guard, inner) };
}
