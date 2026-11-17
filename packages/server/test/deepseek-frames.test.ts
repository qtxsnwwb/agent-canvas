import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readDshLines, scanZstdFrames, zstdAvailable } from '../src/sources/deepseek/zstd-frames.js';
import { appendBatch, appendTorn, eventLine, events, fileBytes, frameOf, HAS_ZSTD, headerLine, NO_ZSTD_REASON, truncateTo, writeSession } from './deepseek-fixtures.js';

// DeepSeek Harness container: concatenated zstd frames (format reference 2), read frame by frame from a byte offset.

if (!HAS_ZSTD) console.warn(NO_ZSTD_REASON);

let tmp: string;
let file: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-dsh-frames-'));
  file = path.join(tmp, 'session.v4.jsonl.zstd');
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

type Line = { offset: number; text: string };

/**
 * Reads the file the way the pipeline does: from the stored offset and state, while the offset moves (or a restart was
 * reported), keeping the lines of the current generation (a truncated read starts the list over).
 */
class Tail {
  offset = 0;
  state: string | null = null;
  lines: Line[] = [];
  restarts = 0;
  constructor(readonly maxBytes = 64 * 1024) {}
  async read(): Promise<Line[]> {
    const got: Line[] = [];
    for (let i = 0; i < 100_000; i++) {
      const from = this.offset;
      const res = await readDshLines(file, from, this.maxBytes, this.state);
      if (res.truncated) {
        this.restarts++;
        this.lines = [];
        got.length = 0;
      }
      this.lines.push(...res.lines);
      got.push(...res.lines);
      this.offset = res.newOffset;
      if (res.state !== undefined) this.state = res.state;
      if (res.newOffset === from && !res.truncated) return got;
    }
    throw new Error('reader did not settle');
  }
}

const texts = (lines: Line[]): string[] => lines.map((l) => l.text);
const ordinals = (lines: Line[]): number[] => lines.map((l) => l.offset);
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe('zstdAvailable', () => {
  test('true only when zstdDecompressSync is a function', () => {
    expect(zstdAvailable({ zstdDecompressSync: () => Buffer.alloc(0) })).toBe(true);
    expect(zstdAvailable({})).toBe(false);
    expect(zstdAvailable({ zstdDecompressSync: 'no' })).toBe(false);
    expect(zstdAvailable()).toBe(HAS_ZSTD);
  });
});

describe.skipIf(!HAS_ZSTD)('scanZstdFrames', () => {
  test('finds every frame boundary; the frames are what Node writes (checksum flag on)', () => {
    const frames = [frameOf([headerLine()]), frameOf(events(0, 3)), frameOf([eventLine(3, 'x'.repeat(200_000))]), frameOf(events(4, 1))];
    const buf = Buffer.concat(frames);
    let at = 0;
    const want = frames.map((f) => ({ start: at, end: (at += f.length) }));
    expect(scanZstdFrames(buf)).toEqual({ frames: want, tornStart: null, corruptAt: null });
    expect(scanZstdFrames(buf, want[2]!.start)).toEqual({ frames: want.slice(2), tornStart: null, corruptAt: null });
    expect(scanZstdFrames(buf, buf.length)).toEqual({ frames: [], tornStart: null, corruptAt: null });
    // Each frame: magic, a descriptor with the checksum bit, and 4 checksum bytes at the end.
    for (const f of frames) {
      expect(f.readUInt32LE(0)).toBe(0xfd2fb528);
      expect(f[4]! & 0x04).toBe(0x04);
    }
    expect(scanZstdFrames(new Uint8Array(0))).toEqual({ frames: [], tornStart: null, corruptAt: null });
  });

  test('a last frame cut anywhere (even inside the magic) is torn; the frames before it are complete', () => {
    const head = frameOf([headerLine()]);
    const last = frameOf(events(0, 20));
    for (let keep = 1; keep < last.length; keep++) {
      const buf = Buffer.concat([head, last.subarray(0, keep)]);
      expect(scanZstdFrames(buf), `keep ${keep}`).toEqual({ frames: [{ start: 0, end: head.length }], tornStart: head.length, corruptAt: null });
    }
  });

  test('bytes that are not a frame start are corrupt (garbage, a partial non-magic, reserved descriptor bits, reserved block type)', () => {
    const head = frameOf([headerLine()]);
    const one = [{ start: 0, end: head.length }];
    expect(scanZstdFrames(Buffer.concat([head, Buffer.from('{"type":"x"}\n')]))).toEqual({ frames: one, tornStart: null, corruptAt: head.length });
    expect(scanZstdFrames(Buffer.concat([head, Buffer.from([0x28, 0xb5, 0x00])]))).toEqual({ frames: one, tornStart: null, corruptAt: head.length });
    const reserved = Buffer.from(frameOf(events(0, 1)));
    reserved[4] = reserved[4]! | 0x08;
    expect(scanZstdFrames(Buffer.concat([head, reserved]))).toEqual({ frames: one, tornStart: null, corruptAt: head.length });
    // A frame whose first block header says type 3 (reserved).
    const f = Buffer.from(frameOf(events(0, 1)));
    const fhd = f[4]!;
    const fcsFlag = fhd >> 6;
    const single = (fhd & 0x20) !== 0;
    const blockAt = 5 + (single ? 0 : 1) + [0, 1, 2, 4][fhd & 3]! + [single ? 1 : 0, 2, 4, 8][fcsFlag]!;
    f[blockAt] = f[blockAt]! | 0x06;
    expect(scanZstdFrames(Buffer.concat([head, f]))).toEqual({ frames: one, tornStart: null, corruptAt: head.length });
    // Corrupt from the very start.
    expect(scanZstdFrames(Buffer.from('not zstd'))).toEqual({ frames: [], tornStart: null, corruptAt: 0 });
  });
});

describe.skipIf(!HAS_ZSTD)('readDshLines', () => {
  const header = headerLine();
  const batches = [events(0, 3), events(3, 1), events(4, 5), events(9, 2)];
  const all = [header, ...batches.flat()];

  test('one line per row, offset = line ordinal (header 0); frame by frame equals one-shot', async () => {
    await writeSession(file, header, batches);
    const size = (await fs.stat(file)).size;
    const oneShot = await readDshLines(file, 0, 1 << 30, null);
    expect(oneShot.truncated).toBe(false);
    expect(oneShot.newOffset).toBe(size);
    expect(texts(oneShot.lines)).toEqual(all);
    expect(ordinals(oneShot.lines)).toEqual(range(all.length));
    expect(JSON.parse(oneShot.state!)).toMatchObject({ lines: all.length });
    expect(Object.keys(JSON.parse(oneShot.state!)).sort()).toEqual(['head', 'lines', 'tail']);

    // maxBytes 1: one frame per call (a frame is never split), same lines, same ordinals.
    const tail = new Tail(1);
    let calls = 0;
    for (;;) {
      const from = tail.offset;
      const res = await readDshLines(file, from, 1, tail.state);
      calls++;
      tail.lines.push(...res.lines);
      tail.offset = res.newOffset;
      if (res.state !== undefined) tail.state = res.state;
      if (res.newOffset === from) break;
    }
    expect(calls).toBe(batches.length + 2); // header frame, each batch, then one call that finds nothing new
    expect(tail.lines).toEqual(oneShot.lines);
    expect(tail.state).toBe(oneShot.state);
  });

  test('nothing new: no lines, the same offset, the state left as it is', async () => {
    await writeSession(file, header, batches);
    const first = await readDshLines(file, 0, 1 << 20, null);
    const again = await readDshLines(file, first.newOffset, 1 << 20, first.state!);
    expect(again).toEqual({ lines: [], newOffset: first.newOffset, truncated: false });
  });

  test('a missing file reads as nothing; a file with only part of the header frame waits', async () => {
    expect(await readDshLines(file, 0, 1024, null)).toEqual({ lines: [], newOffset: 0, truncated: false });
    const h = frameOf([header]);
    await fs.writeFile(file, h.subarray(0, 5));
    expect(await readDshLines(file, 0, 1024, null)).toEqual({ lines: [], newOffset: 0, truncated: false });
    await fs.writeFile(file, h);
    const res = await readDshLines(file, 0, 1024, null);
    expect(res.lines).toEqual([{ offset: 0, text: header }]);
  });

  test('appends: ordinals stay contiguous across reads; the state survives a restart (a fresh call with what was stored)', async () => {
    await writeSession(file, header, [batches[0]!]);
    const t = new Tail();
    expect(ordinals(await t.read())).toEqual([0, 1, 2, 3]);
    await appendBatch(file, batches[1]!);
    await appendBatch(file, batches[2]!);
    expect(ordinals(await t.read())).toEqual([4, 5, 6, 7, 8, 9]);
    // "Restart": a new reader object handed the stored offset and state only.
    const resumed = new Tail();
    resumed.offset = t.offset;
    resumed.state = t.state;
    await appendBatch(file, batches[3]!);
    expect(texts(await resumed.read())).toEqual(batches[3]);
    expect(ordinals(resumed.lines)).toEqual([10, 11]);
    expect(resumed.restarts).toBe(0);
  });

  test('a torn last frame is left for the next read, which completes it', async () => {
    await writeSession(file, header, [batches[0]!]);
    const t = new Tail();
    await t.read();
    const done = t.offset;
    const whole = await appendTorn(file, batches[1]!.concat(batches[2]!), 9);
    expect(await t.read()).toEqual([]);
    expect(t.offset).toBe(done);
    // Grows but still incomplete.
    await fs.appendFile(file, whole.subarray(9, whole.length - 1));
    expect(await t.read()).toEqual([]);
    expect(t.offset).toBe(done);
    // dsh's writer truncates the torn frame at its start and appends the recovered events again, then a new batch.
    await truncateTo(file, done);
    await fs.appendFile(file, whole);
    await appendBatch(file, batches[3]!);
    expect(texts(await t.read())).toEqual([...batches[1]!, ...batches[2]!, ...batches[3]!]);
    expect(t.restarts).toBe(0);
    expect(ordinals(t.lines)).toEqual(range(all.length));
  });

  describe('a rewrite restarts from 0 (truncated) and yields the new content', () => {
    test('the file is shorter than the stored offset (an append rolled back)', async () => {
      await writeSession(file, header, batches);
      const t = new Tail();
      await t.read();
      await writeSession(file, header, [batches[0]!]);
      expect(texts(await t.read())).toEqual([header, ...batches[0]!]);
      expect(t.restarts).toBe(1);
      expect(ordinals(t.lines)).toEqual([0, 1, 2, 3]);
    });

    test('the first frame changed (same size: a tool rewrote the header cwd)', async () => {
      await writeSession(file, header, batches);
      const t = new Tail();
      await t.read();
      const other = headerLine({ cwd: 'D:\\Projects\\Dema' });
      expect(other.length).toBe(header.length);
      const before = (await fs.stat(file)).size;
      await writeSession(file, other, batches);
      expect((await fs.stat(file)).size).toBe(before);
      expect(texts(await t.read())).toEqual([other, ...batches.flat()]);
      expect(t.restarts).toBe(1);
    });

    test('the bytes at the resume offset are not a frame start (the file was rewritten longer)', async () => {
      await writeSession(file, header, [batches[0]!]);
      const t = new Tail();
      await t.read();
      const resumeAt = t.offset;
      // Same header frame; one bigger batch where there were two frames: the resume offset lands inside it.
      const rewritten = fileBytes(header, [[...events(0, 3, 'other/type'), ...events(3, 40, 'other/type')]]);
      expect(rewritten.length).toBeGreaterThan(resumeAt + 8);
      await fs.writeFile(file, rewritten);
      expect(scanZstdFrames(rewritten, resumeAt).corruptAt).toBe(resumeAt);
      const got = await t.read();
      expect(t.restarts).toBe(1);
      expect(got).toHaveLength(44);
      expect(got[1]!.text).toContain('other/type');
    });

    test('the tail fingerprint changed while the file grew (last batch replaced by one of the same size, then appended to)', async () => {
      await writeSession(file, header, [batches[0]!, events(3, 1, 'aaaa')]);
      const t = new Tail();
      await t.read();
      const replaced = fileBytes(header, [batches[0]!, events(3, 1, 'bbbb')]);
      expect(replaced.length).toBe(t.offset);
      await fs.writeFile(file, replaced);
      await appendBatch(file, batches[2]!);
      const got = await t.read();
      expect(t.restarts).toBe(1);
      expect(texts(got)).toEqual([header, ...batches[0]!, ...events(3, 1, 'bbbb'), ...batches[2]!]);
      expect(ordinals(got)).toEqual(range(got.length));
    });

    test('a non-zero offset without a state restarts (the line ordinal is unknown)', async () => {
      await writeSession(file, header, batches);
      const first = await readDshLines(file, 0, 1 << 20, null);
      const res = await readDshLines(file, first.newOffset, 1 << 20, null);
      expect(res.truncated).toBe(true);
      expect(res.lines).toEqual(first.lines);
    });
  });

  test('a corrupt frame: the frames before it are kept, no restart loop, reading goes on once the bytes are valid again', async () => {
    await writeSession(file, header, [batches[0]!]);
    const good = (await fs.stat(file)).size;
    await fs.appendFile(file, Buffer.from('garbage that is not zstd\n'));
    const t = new Tail();
    expect(texts(await t.read())).toEqual([header, ...batches[0]!]);
    expect(t.offset).toBe(good);
    for (let i = 0; i < 3; i++) expect(await t.read()).toEqual([]);
    expect(t.restarts).toBe(0);
    // A complete frame whose content fails its checksum is corrupt too.
    await truncateTo(file, good);
    const bad = Buffer.from(frameOf(batches[1]!));
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 0xff;
    await fs.appendFile(file, bad);
    expect(await t.read()).toEqual([]);
    expect(t.restarts).toBe(0);
    // Repaired: the writer truncated and appended a valid frame.
    await truncateTo(file, good);
    await appendBatch(file, batches[1]!);
    expect(texts(await t.read())).toEqual(batches[1]);
    expect(t.restarts).toBe(0);
  });

  test('a frame larger than maxBytes is read whole in one call', async () => {
    const big = [eventLine(0, 'tool/result', { text: 'y'.repeat(300_000), r: Math.random() })];
    await writeSession(file, header, [big, batches[1]!]);
    const t = new Tail(1024);
    expect(texts(await t.read())).toEqual([header, ...big, ...batches[1]!]);
  });

  test('blank lines and CR are not rows', async () => {
    await fs.writeFile(file, Buffer.concat([frameOf([header]), frameOf([eventLine(0) + '\r', '', eventLine(1)])]));
    const res = await readDshLines(file, 0, 1 << 20, null);
    expect(res.lines).toEqual([
      { offset: 0, text: header },
      { offset: 1, text: eventLine(0) },
      { offset: 2, text: eventLine(1) },
    ]);
  });
});

/**
 * Drives readDshLines as the pipeline's doIngest does (Task 2): from the stored offset and state while the offset moves,
 * at most one restart per call (a second `truncated` in the same call is discarded and the call ends). Each generation
 * keeps the ordinals stored under it.
 */
class Pipelined {
  offset = 0;
  state: string | null = null;
  generations: number[][] = [[]];
  texts: string[][] = [[]];
  truncatedResults = 0;
  constructor(readonly maxBytes: number) {}
  async ingest(): Promise<void> {
    let restarted = false;
    for (let i = 0; i < 100_000; i++) {
      const from = this.offset;
      const res = await readDshLines(file, from, this.maxBytes, this.state);
      if (res.truncated) {
        this.truncatedResults++;
        if (restarted) return;
        restarted = true;
        this.generations.push([]);
        this.texts.push([]);
      }
      this.generations.at(-1)!.push(...res.lines.map((l) => l.offset));
      this.texts.at(-1)!.push(...res.lines.map((l) => l.text));
      this.offset = res.newOffset;
      if (res.state !== undefined) this.state = res.state;
      if (res.newOffset === from && !res.truncated) return;
    }
    throw new Error('reader did not settle');
  }
}

describe.skipIf(!HAS_ZSTD)('readDshLines: damage in a file of several slices', () => {
  const BUDGET = 16 * 1024;
  // Frames of a few KB that do not compress away (hex of pseudo-random bytes).
  const noise = (i: number): string => Array.from({ length: 160 }, (_, k) => ((i * 2654435761 + k * 40503) >>> 0).toString(16).padStart(8, '0')).join('');
  const header = headerLine();
  const batch = (i: number): string[] => [eventLine(2 * i, 'tool/result', { text: noise(2 * i) }), eventLine(2 * i + 1, 'tool/result', { text: noise(2 * i + 1) })];
  const N = 40;
  /** Frames of the file, with their byte ranges. */
  function build(): { frames: Buffer[]; starts: number[]; lines: string[][] } {
    const frames = [frameOf([header]), ...Array.from({ length: N }, (_, i) => frameOf(batch(i)))];
    const starts: number[] = [];
    let at = 0;
    for (const f of frames) {
      starts.push(at);
      at += f.length;
    }
    return { frames, starts, lines: [[header], ...Array.from({ length: N }, (_, i) => batch(i))] };
  }
  /** Byte offsets where the reader's slices start on the clean file (with this budget). */
  async function sliceStarts(maxBytes: number): Promise<number[]> {
    const out: number[] = [];
    let offset = 0;
    let state: string | null = null;
    for (;;) {
      out.push(offset);
      const res = await readDshLines(file, offset, maxBytes, state);
      if (res.state !== undefined) state = res.state;
      if (res.newOffset === offset) return out;
      offset = res.newOffset;
    }
  }
  const damaged = (f: Buffer): Buffer => {
    const b = Buffer.from(f);
    b[b.length - 1] = b[b.length - 1]! ^ 0xff; // content checksum no longer matches
    return b;
  };

  /** 30 ingests: at most one truncated result in all; each generation holds every ordinal before the damage at most once, the last one exactly once. */
  async function expectOneRestartAtMost(p: Pipelined, linesBefore: string[]): Promise<void> {
    for (let i = 0; i < 30; i++) await p.ingest();
    expect(p.truncatedResults).toBeLessThanOrEqual(1);
    for (const g of p.generations) expect(new Set(g).size).toBe(g.length);
    expect(p.generations.at(-1)).toEqual(range(linesBefore.length));
    expect(p.texts.at(-1)).toEqual(linesBefore);
  }

  async function recovers(p: Pipelined, at: number, all: string[][], frames: Buffer[], from: number): Promise<void> {
    const restartsBefore = p.truncatedResults;
    await truncateTo(file, at);
    await fs.appendFile(file, Buffer.concat(frames.slice(from)));
    for (let i = 0; i < 3; i++) await p.ingest();
    expect(p.truncatedResults).toBe(restartsBefore);
    expect(p.texts.at(-1)).toEqual(all.flat());
    expect(p.generations.at(-1)).toEqual(range(all.flat().length));
  }

  test('(a) damage inside a later slice (not at its start)', async () => {
    const { frames, starts, lines } = build();
    await fs.writeFile(file, Buffer.concat(frames));
    const slices = await sliceStarts(BUDGET);
    expect(slices.length).toBeGreaterThan(4);
    // A frame strictly inside the third slice.
    const k = starts.findIndex((s) => s > slices[2]! && s < slices[3]! && !slices.includes(s));
    expect(k).toBeGreaterThan(0);
    await fs.writeFile(file, Buffer.concat([...frames.slice(0, k), damaged(frames[k]!), ...frames.slice(k + 1)]));
    const p = new Pipelined(BUDGET);
    await expectOneRestartAtMost(p, lines.slice(0, k).flat());
    await recovers(p, starts[k]!, lines, frames, k);
  });

  test('(b) damage exactly at a slice boundary (a damaged frame, then garbage at a slice end)', async () => {
    const { frames, starts, lines } = build();
    await fs.writeFile(file, Buffer.concat(frames));
    const slices = await sliceStarts(BUDGET);
    const boundary = slices[2]!;
    const k = starts.indexOf(boundary);
    expect(k).toBeGreaterThan(0);
    await fs.writeFile(file, Buffer.concat([...frames.slice(0, k), damaged(frames[k]!), ...frames.slice(k + 1)]));
    const p = new Pipelined(BUDGET);
    await expectOneRestartAtMost(p, lines.slice(0, k).flat());
    await recovers(p, boundary, lines, frames, k);

    // Garbage where a slice ends: the clean prefix, then bytes that are not a frame.
    await fs.writeFile(file, Buffer.concat([...frames.slice(0, k), Buffer.from('not a zstd frame at all, just some bytes\n'.repeat(20))]));
    const q = new Pipelined(BUDGET);
    await expectOneRestartAtMost(q, lines.slice(0, k).flat());
    await recovers(q, boundary, lines, frames, k);
  });

  test('(c) a tiny budget (one frame per call), damage in the middle', async () => {
    const { frames, starts, lines } = build();
    const k = 11;
    await fs.writeFile(file, Buffer.concat([...frames.slice(0, k), damaged(frames[k]!), ...frames.slice(k + 1)]));
    const p = new Pipelined(1);
    await expectOneRestartAtMost(p, lines.slice(0, k).flat());
    await recovers(p, starts[k]!, lines, frames, k);
  });

  test('damage found on the very first read of a file: no restart at all when it sits inside the slice', async () => {
    const { frames, lines } = build();
    const k = 2;
    await fs.writeFile(file, Buffer.concat([...frames.slice(0, k), damaged(frames[k]!), ...frames.slice(k + 1)]));
    const p = new Pipelined(1 << 20);
    for (let i = 0; i < 10; i++) await p.ingest();
    expect(p.truncatedResults).toBe(0);
    expect(p.texts.at(-1)).toEqual(lines.slice(0, k).flat());
  });
});
