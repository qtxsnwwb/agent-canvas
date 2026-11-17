import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readDshLines } from '../src/sources/deepseek/zstd-frames.js';
import { eventLine, frameOf, HAS_ZSTD, headerLine, NO_ZSTD_REASON } from './deepseek-fixtures.js';

// Timing- and memory-sensitive: a DeepSeek Harness file of 30,000 frames is read in bounded slices, linearly.
// Runs in the serial "timing" Vitest project.

if (!HAS_ZSTD) console.warn(NO_ZSTD_REASON);

const TIMING_SCALE = Math.max(1, Number(process.env.AGENT_CANVAS_TIMING_SCALE) || 1);
const gapBound = (ms: number): number => ms * TIMING_SCALE;

const FRAMES = 30_000;
const BUDGET = 64 * 1024;

let tmp: string;
let file: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-dsh-timing-'));
  file = path.join(tmp, 'session.v4.jsonl.zstd');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

/** Counts the bytes each fs.open handle reads (the reader opens the file once per call). */
function countReads(): { perCall: number[] } {
  const out = { perCall: [] as number[] };
  const real = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await real(...args);
    const at = out.perCall.push(0) - 1;
    const read = handle.read.bind(handle) as (...a: unknown[]) => Promise<{ bytesRead: number }>;
    (handle as unknown as { read: unknown }).read = async (...a: unknown[]) => {
      const r = await read(...a);
      out.perCall[at]! += r.bytesRead;
      return r;
    };
    return handle;
  });
  return out;
}

describe.skipIf(!HAS_ZSTD)('DeepSeek reader: 30,000 frames', () => {
  test('bounded bytes per read, linear time, every line once in order', async () => {
    let biggest = 0;
    const parts: Buffer[] = [frameOf([headerLine()])];
    for (let i = 0; i < FRAMES; i++) {
      const f = frameOf([eventLine(i, 'assistant/message', { turn: i, text: `reply ${i} ${'z'.repeat(i % 50)}` })]);
      biggest = Math.max(biggest, f.length);
      parts.push(f);
    }
    await fs.writeFile(file, Buffer.concat(parts));
    const size = (await fs.stat(file)).size;

    const reads = countReads();
    let offset = 0;
    let state: string | null = null;
    let count = 0;
    let lastOrdinal = -1;
    const sliceMs: number[] = [];
    const t0 = performance.now();
    for (;;) {
      const s = performance.now();
      const res = await readDshLines(file, offset, BUDGET, state);
      sliceMs.push(performance.now() - s);
      expect(res.truncated).toBe(false);
      for (const l of res.lines) {
        expect(l.offset).toBe(lastOrdinal + 1);
        lastOrdinal = l.offset;
      }
      count += res.lines.length;
      if (res.state !== undefined) state = res.state;
      if (res.newOffset === offset) break;
      offset = res.newOffset;
    }
    const total = performance.now() - t0;
    expect(count).toBe(FRAMES + 1);
    expect(offset).toBe(size);
    // Bounded: no call reads more than the budget plus the guard reads (header frame, tail bytes) and one frame.
    const bound = BUDGET + biggest + 4096;
    expect(Math.max(...reads.perCall)).toBeLessThanOrEqual(bound);
    // Linear: about size / budget calls, and the last slices are not slower than the first (no re-walk from 0).
    expect(reads.perCall.length).toBeLessThan(Math.ceil(size / (BUDGET - biggest)) + 5);
    const n = sliceMs.length;
    const head = sliceMs.slice(1, 11).reduce((a, b) => a + b, 0);
    const tail = sliceMs.slice(n - 11, n - 1).reduce((a, b) => a + b, 0);
    console.log(`[deepseek timing] ${FRAMES} frames, ${(size / 1e6).toFixed(1)} MB, ${n} calls, total ${total.toFixed(0)} ms, max bytes/call ${Math.max(...reads.perCall)}, first10 ${head.toFixed(1)} ms, last10 ${tail.toFixed(1)} ms`);
    expect(tail).toBeLessThan(head * 3 + gapBound(50));
    expect(total).toBeLessThan(gapBound(5_000));
    // Each slice is short: the service stays responsive between them.
    expect(Math.max(...sliceMs)).toBeLessThan(gapBound(250));
  });

  test('nothing new on a 30,000-frame file: a few hundred bytes read, fast', async () => {
    const parts: Buffer[] = [frameOf([headerLine()])];
    for (let i = 0; i < FRAMES; i++) parts.push(frameOf([eventLine(i)]));
    await fs.writeFile(file, Buffer.concat(parts));
    let offset = 0;
    let state: string | null = null;
    for (;;) {
      const res = await readDshLines(file, offset, 1 << 30, state);
      if (res.state !== undefined) state = res.state;
      if (res.newOffset === offset) break;
      offset = res.newOffset;
    }
    const reads = countReads();
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) expect((await readDshLines(file, offset, BUDGET, state)).lines).toEqual([]);
    const ms = performance.now() - t0;
    expect(Math.max(...reads.perCall)).toBeLessThanOrEqual(4096);
    expect(ms).toBeLessThan(gapBound(1_000));
  });
});
