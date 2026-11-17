import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

// Invented DeepSeek Harness (dsh) session data, shaped after docs/formats/deepseek-harness.md (sections 1, 2, 4.1, 5):
// fake ids, paths and text. Files are built at test time with node:zlib's own zstd (checksum flag on, as dsh does).

type Obj = Record<string, unknown>;

export const SID = 'f3a9c1d2-5b6e-4a7f-8c9d-0e1f2a3b4c5d';
export const CHILD = '7b8c9d0e-1f2a-4b3c-9d4e-5f6a7b8c9d0e';
export const GRANDCHILD = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
export const CWD = 'D:\\Projects\\Demo';
/** CWD as Claude Code encodes it (the project id). */
export const PROJECT = 'D--Projects-Demo';
/** Epoch ms of the example's header. */
export const T0 = 1789626545611;
export const V4 = 'session.v4.jsonl.zstd';

/** Whether this Node has zstd in node:zlib (Node >= 22.15); tests that need it skip otherwise. */
export const HAS_ZSTD = typeof (zlib as { zstdCompressSync?: unknown }).zstdCompressSync === 'function';
export const NO_ZSTD_REASON = 'node:zlib has no zstd on this Node (needs 22.15 or later): DeepSeek container tests skipped';

/** dsh's `projectKey(cwd)` (format reference 1.2). */
export function projectKey(cwd: string): string {
  let out = '';
  let inSep = false;
  for (let i = 0; i < cwd.length; i++) {
    const ch = cwd[i]!;
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!inSep) out += '-';
      inSep = true;
      continue;
    }
    inSep = false;
    out += /[A-Za-z0-9._-]/.test(ch) ? ch : `~${cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  const slug = out.replace(/^-+/, '') || 'root';
  return `--${slug.slice(0, 251)}--`;
}

/** dsh's `encodeSegment(id)` (format reference 1.2). */
export function encodeSegment(id: string): string {
  if (id === '.' || id === '..') return id.replace(/\./g, '~002E');
  let out = '';
  for (let i = 0; i < id.length; i++) {
    const ch = id[i]!;
    out += /[A-Za-z0-9._-]/.test(ch) ? ch : `~${id.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/** `<projectKey(cwd)>/<encodeSegment(id)>/<name>`: a session file's path relative to `<dsh home>/sessions`. */
export const sessionRel = (id: string, cwd: string | null = CWD, name = V4): string => `${cwd === null ? '_no-cwd' : projectKey(cwd)}/${encodeSegment(id)}/${name}`;

/** The header line (format reference 4.1). */
export function headerLine(opts: { id?: string; cwd?: string | null; parent?: string; origin?: 'subagent'; depth?: number; seeded?: boolean; version?: number; extra?: Obj } = {}): string {
  const h: Obj = {
    type: 'session',
    version: opts.version ?? 4,
    id: opts.id ?? SID,
    createdAt: T0,
    ...(opts.cwd === null ? {} : { cwd: opts.cwd ?? CWD }),
    ...(opts.parent !== undefined ? { parentSession: opts.parent } : {}),
    isSeeded: opts.seeded ?? false,
    ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
    delegationDepth: opts.depth ?? (opts.parent !== undefined ? 1 : 0),
    ...opts.extra,
  };
  return JSON.stringify(h);
}

/** An event row `{type, seq, time, data}` (format reference 4.2). */
export const eventLine = (seq: number, type = 'turn/start', data: Obj = { turn: 1 }): string => JSON.stringify({ type, seq, time: T0 + 100 + seq, data });

/** One standard zstd frame of `lines` (each followed by `\n`), with the content checksum, as dsh writes it. */
export function frameOf(lines: readonly string[]): Buffer {
  const z = zlib as unknown as { zstdCompressSync(b: Buffer, o: object): Buffer; constants: Record<string, number> };
  return z.zstdCompressSync(Buffer.from(lines.map((l) => `${l}\n`).join('')), { params: { [z.constants.ZSTD_c_checksumFlag!]: 1 } });
}

/** The bytes of a session file: the header alone in frame 1, then one frame per batch. */
export const fileBytes = (header: string, batches: readonly (readonly string[])[] = []): Buffer => Buffer.concat([frameOf([header]), ...batches.map((b) => frameOf(b))]);

/** Writes a session file (header frame + one frame per batch), creating its directories. */
export async function writeSession(file: string, header: string, batches: readonly (readonly string[])[] = []): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, fileBytes(header, batches));
}

/** Appends one batch (one frame), as dsh's writer does. */
export async function appendBatch(file: string, lines: readonly string[]): Promise<void> {
  await fs.appendFile(file, frameOf(lines));
}

/** Appends the first `keep` bytes of a batch's frame: a torn last frame. Returns the whole frame (to complete it later). */
export async function appendTorn(file: string, lines: readonly string[], keep: number): Promise<Buffer> {
  const frame = frameOf(lines);
  await fs.appendFile(file, frame.subarray(0, keep));
  return frame;
}

/** Cuts the file to `size` bytes (dsh's writer truncating a torn frame, or rolling back a failed append). */
export async function truncateTo(file: string, size: number): Promise<void> {
  await fs.truncate(file, size);
}

/** `n` consecutive event rows starting at `seq`. */
export const events = (seq: number, n: number, type?: string): string[] => Array.from({ length: n }, (_, i) => eventLine(seq + i, type));
