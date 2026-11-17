import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import type { SourceRead } from '../source.js';

/**
 * DeepSeek Harness's container (docs/formats/deepseek-harness.md section 2): a plain concatenation of independent,
 * standard, checksummed Zstandard frames; frame 1 holds the header line alone, each later frame one append batch of
 * whole JSONL lines. Frame boundaries are found by walking the frame headers (a port of dsh's own `scanZstdFrames`,
 * `jsonl/zstd.ts:48-104`), and each frame is decompressed on its own with `zlib.zstdDecompressSync` (Node >= 22.15):
 * nothing relies on one call decoding several frames.
 */

/** Why the DeepSeek source cannot run on this Node (shown in diagnostics). */
export const DSH_UNAVAILABLE = '需要 Node 22.15 或更高';

/** Whether this runtime's node:zlib (or `z`) has `zstdDecompressSync` (Node >= 22.15). */
export function zstdAvailable(z: { zstdDecompressSync?: unknown } = zlib as { zstdDecompressSync?: unknown }): boolean {
  return typeof z.zstdDecompressSync === 'function';
}

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]; // 0xFD2FB528 little-endian
const DICT_ID_BYTES = [0, 1, 2, 4];

/** Bytes wanted by the frame walk: `n` bytes at `pos` (fewer come back at the end of the data). */
interface Need {
  pos: number;
  n: number;
}
type WalkEnd = { end: number } | { torn: true } | { corrupt: true };

/**
 * Walks one frame header and its block headers from `start`, asking for the bytes it needs (never the block payloads),
 * in data that ends at `limit`. `end`: the offset just past the frame (its checksum included); `torn`: the data ends
 * inside the frame (even inside the magic); `corrupt`: `start` is not a frame start (another magic, reserved
 * descriptor bits, a reserved block type).
 */
function* walkFrame(start: number, limit: number): Generator<Need, WalkEnd, Uint8Array> {
  const magic = yield { pos: start, n: 4 };
  for (let i = 0; i < magic.length; i++) if (magic[i] !== MAGIC[i]) return { corrupt: true };
  if (magic.length < 4) return { torn: true };
  const fhd = (yield { pos: start + 4, n: 1 })[0];
  if (fhd === undefined) return { torn: true };
  if ((fhd & 0x18) !== 0) return { corrupt: true };
  const singleSegment = (fhd & 0x20) !== 0;
  const fcsFlag = fhd >> 6;
  const contentSizeBytes = fcsFlag === 0 ? (singleSegment ? 1 : 0) : 1 << fcsFlag;
  let pos = start + 5 + (singleSegment ? 0 : 1) + DICT_ID_BYTES[fhd & 3]! + contentSizeBytes;
  for (;;) {
    if (pos >= limit) return { torn: true };
    const h = yield { pos, n: 3 };
    if (h.length < 3) return { torn: true };
    const v = h[0]! | (h[1]! << 8) | (h[2]! << 16);
    const type = (v >> 1) & 3;
    if (type === 3) return { corrupt: true };
    pos += 3 + (type === 1 ? 1 : v >>> 3);
    if ((v & 1) === 1) break;
  }
  if ((fhd & 0x04) !== 0) pos += 4;
  return pos > limit ? { torn: true } : { end: pos };
}

function walkInBuffer(buf: Uint8Array, start: number): WalkEnd {
  const walk = walkFrame(start, buf.length);
  let step = walk.next();
  while (step.done !== true) step = walk.next(buf.subarray(step.value.pos, Math.min(buf.length, step.value.pos + step.value.n)));
  return step.value;
}

async function walkInFile(handle: fs.FileHandle, start: number, size: number): Promise<WalkEnd> {
  const walk = walkFrame(start, size);
  let step = walk.next();
  while (step.done !== true) step = walk.next(await bytesAt(handle, step.value.pos, Math.min(size, step.value.pos + step.value.n)));
  return step.value;
}

/** Walks Zstandard frame headers from `from`. `tornStart`: offset of an incomplete last frame. `corruptAt`: first offset that is not a frame. */
export function scanZstdFrames(buf: Uint8Array, from = 0): { frames: { start: number; end: number }[]; tornStart: number | null; corruptAt: number | null } {
  const frames: { start: number; end: number }[] = [];
  let pos = from;
  while (pos < buf.length) {
    const r = walkInBuffer(buf, pos);
    if ('torn' in r) return { frames, tornStart: pos, corruptAt: null };
    if ('corrupt' in r) return { frames, tornStart: null, corruptAt: pos };
    frames.push({ start: pos, end: r.end });
    pos = r.end;
  }
  return { frames, tornStart: null, corruptAt: null };
}

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

const sha1 = (b: Uint8Array): string => createHash('sha1').update(b).digest('hex');

/** Bytes before the resume offset covered by the tail fingerprint. */
const TAIL_BYTES = 64;

/**
 * The reader state (opaque to the pipeline): `head` = `<length>:<sha1>` of frame 1, `tail` = SHA-1 of the last (up to)
 * 64 bytes before the resume offset, `lines` = the ordinal the next line gets; `corrupt` (only when true) = the bytes
 * at the resume offset are not a decodable frame (the read waits there for them to change); `restarted` (only when true) =
 * this generation already began with a restart because the bytes at a resume offset were not a frame, so damage met at
 * a resume offset now stops the read there instead of restarting again (at most one such restart per generation).
 */
interface DshState {
  head: string;
  tail: string;
  lines: number;
  corrupt?: true;
  restarted?: true;
}

function parseState(state: string | null): DshState | null {
  if (state === null) return null;
  try {
    const s = JSON.parse(state) as Partial<DshState> | null;
    if (typeof s?.head === 'string' && typeof s.tail === 'string' && typeof s.lines === 'number' && Number.isSafeInteger(s.lines) && s.lines >= 0) {
      return { head: s.head, tail: s.tail, lines: s.lines, ...(s.corrupt === true ? { corrupt: true as const } : {}), ...(s.restarted === true ? { restarted: true as const } : {}) };
    }
  } catch {
    // not ours: start over
  }
  return null;
}

const stateText = (s: DshState): string =>
  JSON.stringify({ head: s.head, tail: s.tail, lines: s.lines, ...(s.corrupt === true ? { corrupt: true } : {}), ...(s.restarted === true ? { restarted: true } : {}) });

/** The lines of one decompressed frame, or null when it does not decode to whole lines (corrupt). */
function frameLines(frame: Uint8Array): string[] | null {
  let text: string;
  try {
    text = (zlib as unknown as { zstdDecompressSync(b: Uint8Array): Buffer }).zstdDecompressSync(frame).toString('utf8');
  } catch {
    return null;
  }
  if (text === '') return [];
  if (!text.endsWith('\n')) return null; // dsh never writes a frame that ends inside a line
  const out: string[] = [];
  for (const raw of text.slice(0, -1).split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() !== '') out.push(line);
  }
  return out;
}

/**
 * One decoded line per JSONL row. offset = line ordinal (header 0, then 1, 2, …). state = JSON {head, tail, lines}.
 *
 * Reads complete frames from `fromOffset` (always the end of a complete frame, or 0): at most one `maxBytes` slice of
 * the file per call, or the one frame starting there when that frame alone is larger. A torn last frame is left for the
 * next call. A rewrite — the file is shorter than `fromOffset`, frame 1 changed, the tail fingerprint changed, the bytes
 * at `fromOffset` are not a frame start, or a non-zero offset comes without a state — restarts from 0 with
 * `truncated: true`. A complete frame that is not a frame or does not decode stops the read before it: the frames
 * before it are kept and reading goes on once the bytes there are a valid frame. Damage costs at most one restart per
 * generation (the "not a frame start" rule spends it; damage met afterwards, at any offset, stops the read there), so a
 * damaged file is never re-stored over and over.
 * One open handle and one stat per call; the new fingerprints are taken from the bytes this call read.
 */
export async function readDshLines(absPath: string, fromOffset: number, maxBytes: number, state: string | null): Promise<SourceRead> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(absPath, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { lines: [], newOffset: 0, truncated: false };
    throw err;
  }
  try {
    const { size } = await handle.stat();
    const prev = fromOffset > 0 ? parseState(state) : null;
    let restart = fromOffset > 0 && (prev === null || size < fromOffset);
    // The tail bytes of [0, fromOffset) as they are now: checked against the stored fingerprint, reused for the new one.
    let before: Buffer = Buffer.alloc(0);
    if (!restart && prev !== null) {
      const [lenText, headHash] = prev.head.split(':');
      const headLen = Number(lenText);
      if (!(headLen > 0 && headLen <= fromOffset) || sha1(await bytesAt(handle, 0, headLen)) !== headHash) restart = true;
      else {
        before = await bytesAt(handle, Math.max(0, fromOffset - TAIL_BYTES), fromOffset);
        if (sha1(before) !== prev.tail) restart = true;
      }
    }
    let damageRestart = false;
    for (let attempt = 0; ; attempt++) {
      const start = restart ? 0 : fromOffset;
      const base: DshState | null = restart || fromOffset === 0 ? null : prev;
      if (start === 0) before = Buffer.alloc(0);
      const read = await readFrames(handle, size, start, maxBytes, base?.lines ?? 0);
      // The bytes at the resume offset are not a frame: a rewrite (spec 10.6), unless this offset is already known to be
      // damaged or this generation already spent its restart on damage (then stop here and wait for the bytes to change).
      if (read.corruptAt === start && start > 0 && base !== null && base.corrupt !== true && base.restarted !== true && attempt === 0) {
        restart = true;
        damageRestart = true;
        continue;
      }
      const corrupt = read.corruptAt !== null && read.corruptAt === read.newOffset;
      const lines = read.lines;
      let head = base?.head ?? null;
      if (read.headFrame !== null) head = `${read.headFrame.length}:${sha1(read.headFrame)}`;
      if (read.newOffset === 0 || head === null) {
        // Nothing complete yet (an empty file, a torn header frame).
        return restart ? { lines, newOffset: 0, truncated: true, state: null } : { lines, newOffset: 0, truncated: false };
      }
      const moved = read.newOffset !== start;
      // Nothing new (nothing appended, a torn last frame, or still the damaged frame found before): the state holds. Damage
      // newly found right at the resume offset is recorded (the state changes, the offset does not).
      if (!restart && !moved && !(corrupt && base?.corrupt !== true)) return { lines, newOffset: start, truncated: false };
      const consumed = read.bytes.subarray(0, read.newOffset - start);
      const joined = consumed.length >= TAIL_BYTES ? consumed : Buffer.concat([before, consumed]);
      const next: DshState = {
        head,
        tail: sha1(joined.subarray(Math.max(0, joined.length - TAIL_BYTES))),
        lines: (base?.lines ?? 0) + lines.length,
        ...(corrupt ? { corrupt: true as const } : {}),
        ...(damageRestart || (!restart && base?.restarted === true) ? { restarted: true as const } : {}),
      };
      return { lines, newOffset: read.newOffset, truncated: restart, state: stateText(next) };
    }
  } finally {
    await handle.close();
  }
}

/** Bytes read first when looking for frame 1 (the header frame is a few hundred bytes). */
const HEAD_PROBE_BYTES = 4096;

/**
 * The first line of frame 1 (the header line), or null while frame 1 is not complete, when it is larger than `maxBytes`,
 * not a frame, or does not decode; a missing file is null too. Reads frame 1 only.
 */
export async function readDshHeaderLine(absPath: string, maxBytes: number): Promise<string | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(absPath, 'r');
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    let bytes = await bytesAt(handle, 0, Math.min(size, HEAD_PROBE_BYTES, maxBytes));
    let end: number | null = scanZstdFrames(bytes).frames[0]?.end ?? null;
    if (end === null && bytes.length < size) {
      const walked = await walkInFile(handle, 0, size);
      if (!('end' in walked) || walked.end > maxBytes) return null;
      bytes = await bytesAt(handle, 0, walked.end);
      end = bytes.length === walked.end ? walked.end : null;
    }
    if (end === null) return null;
    return frameLines(bytes.subarray(0, end))?.[0] ?? null;
  } finally {
    await handle.close();
  }
}

interface FramesRead {
  lines: { offset: number; text: string }[];
  /** End of the last complete frame decoded (where the next read resumes). */
  newOffset: number;
  /** The file's bytes from `start` up to at least newOffset (as read by this call). */
  bytes: Buffer;
  /** Bytes of frame 1 when this read decoded it. */
  headFrame: Buffer | null;
  /** Offset of a frame that is not a frame or does not decode, where the read stopped; else null. */
  corruptAt: number | null;
}

/** Complete frames from `start`: one slice of `maxBytes`, or the single frame there when it is larger. */
async function readFrames(handle: fs.FileHandle, size: number, start: number, maxBytes: number, firstOrdinal: number): Promise<FramesRead> {
  const none = (corruptAt: number | null): FramesRead => ({ lines: [], newOffset: start, bytes: Buffer.alloc(0), headFrame: null, corruptAt });
  if (start >= size) return none(null);
  let bytes = await bytesAt(handle, start, Math.min(size, start + Math.max(1, maxBytes)));
  let scan = scanZstdFrames(bytes);
  if (scan.frames.length === 0 && scan.corruptAt === null && start + bytes.length < size) {
    // The frame at `start` is larger than the slice: find its end from its block headers, then read it whole.
    const walked = await walkInFile(handle, start, size);
    if ('torn' in walked) return none(null);
    if ('corrupt' in walked) return none(start);
    bytes = await bytesAt(handle, start, walked.end);
    if (bytes.length < walked.end - start) return none(null);
    scan = { frames: [{ start: 0, end: bytes.length }], tornStart: null, corruptAt: null };
  }
  const lines: { offset: number; text: string }[] = [];
  let ordinal = firstOrdinal;
  let done = 0;
  let headFrame: Buffer | null = null;
  for (const f of scan.frames) {
    const frame = bytes.subarray(f.start, f.end);
    const got = frameLines(frame);
    if (got === null) return { lines, newOffset: start + done, bytes, headFrame, corruptAt: start + f.start };
    if (start + f.start === 0) headFrame = Buffer.from(frame);
    for (const text of got) lines.push({ offset: ordinal++, text });
    done = f.end;
  }
  return { lines, newOffset: start + done, bytes, headFrame, corruptAt: scan.corruptAt === null ? null : start + scan.corruptAt };
}
