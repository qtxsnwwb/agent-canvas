import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readGuardedLines } from '../src/sources/guarded-reader.js';
import { readNewLines } from '../src/sources/transcript/reader.js';

// readGuardedLines = readNewLines plus a guard over the bytes already read (the first and the last up to 64 of them),
// so a file rewritten in place is noticed even when it did not get shorter (spec 10 item 6).

let dir: string;
let f: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-guarded-'));
  f = path.join(dir, 'log.jsonl');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10 });
});

const MAX = 8 * 1024 * 1024;
/** `n` near the start of the line. */
const rec = (n: number, pad = 0): string => JSON.stringify({ type: 'x', n, pad: 'p'.repeat(pad) });
/** `n` at the end of the line (a different n changes the line's last bytes). */
const recEnd = (n: number, pad = 0): string => JSON.stringify({ type: 'x', pad: 'p'.repeat(pad), n });

describe('plain append: the same result as readNewLines', () => {
  test('first read, appends, partial last line, CRLF and blank lines', async () => {
    await fs.writeFile(f, `${rec(1)}\r\n\n${rec(2, 100)}\n${rec(3)}`);
    const a = await readGuardedLines(f, 0, MAX, null);
    const plainA = await readNewLines(f, 0, MAX);
    expect({ lines: a.lines, newOffset: a.newOffset, truncated: a.truncated }).toEqual(plainA);
    expect(typeof a.state).toBe('string');

    await fs.appendFile(f, `\n${rec(4, 200)}\n`);
    const b = await readGuardedLines(f, a.newOffset, MAX, a.state ?? null);
    const plainB = await readNewLines(f, a.newOffset, MAX);
    expect({ lines: b.lines, newOffset: b.newOffset, truncated: b.truncated }).toEqual(plainB);
    expect(b.truncated).toBe(false);
    expect(b.lines.map((l) => JSON.parse(l.text).n)).toEqual([3, 4]);
  });

  test('a read budget slices the file exactly as readNewLines does', async () => {
    await fs.writeFile(f, Array.from({ length: 50 }, (_, i) => rec(i, 40)).join('\n') + '\n');
    let off = 0;
    let state: string | null = null;
    for (;;) {
      const g = await readGuardedLines(f, off, 300, state);
      const p = await readNewLines(f, off, 300);
      expect({ lines: g.lines, newOffset: g.newOffset, truncated: g.truncated }).toEqual(p);
      if (g.state !== undefined) state = g.state;
      if (g.newOffset === off) break;
      off = g.newOffset;
    }
    expect(off).toBe((await fs.stat(f)).size);
  });

  test('nothing new: no lines, offset kept, state left as is', async () => {
    await fs.writeFile(f, `${rec(1)}\n`);
    const a = await readGuardedLines(f, 0, MAX, null);
    const b = await readGuardedLines(f, a.newOffset, MAX, a.state ?? null);
    expect(b).toEqual({ lines: [], newOffset: a.newOffset, truncated: false });
    expect(b.state).toBeUndefined();
  });

  test('a missing file reads as readNewLines reads it', async () => {
    const g = await readGuardedLines(path.join(dir, 'gone.jsonl'), 10, MAX, null);
    expect({ lines: g.lines, newOffset: g.newOffset, truncated: g.truncated }).toEqual(await readNewLines(path.join(dir, 'gone.jsonl'), 10, MAX));
  });

  test('no stored guard yet (state null) at a non-zero offset: reads on from there and starts guarding', async () => {
    await fs.writeFile(f, `${rec(1)}\n${rec(2)}\n`);
    const from = Buffer.byteLength(`${rec(1)}\n`);
    const g = await readGuardedLines(f, from, MAX, null);
    expect(g.truncated).toBe(false);
    expect(g.lines).toEqual([{ offset: from, text: rec(2) }]);
    expect(typeof g.state).toBe('string');
  });
});

describe('rewrites', () => {
  test('shrink: truncated, read again from the start', async () => {
    await fs.writeFile(f, `${rec(1, 100)}\n${rec(2, 100)}\n`);
    const a = await readGuardedLines(f, 0, MAX, null);
    await fs.writeFile(f, `${rec(9)}\n`);
    const b = await readGuardedLines(f, a.newOffset, MAX, a.state ?? null);
    expect(b.truncated).toBe(true);
    expect(b.lines).toEqual([{ offset: 0, text: rec(9) }]);
    expect(b.newOffset).toBe(Buffer.byteLength(`${rec(9)}\n`));
    expect(typeof b.state).toBe('string');
    expect(b.state).not.toBe(a.state);
  });

  test('head changed, same size: truncated, read again from the start', async () => {
    const first = `${rec(1, 100)}\n${rec(2, 100)}\n`;
    await fs.writeFile(f, first);
    const a = await readGuardedLines(f, 0, MAX, null);
    const rewritten = `${rec(7, 100)}\n${rec(2, 100)}\n`; // same length, the first bytes differ
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(first));
    await fs.writeFile(f, rewritten);
    const b = await readGuardedLines(f, a.newOffset, MAX, a.state ?? null);
    expect(b.truncated).toBe(true);
    expect(b.lines.map((l) => [l.offset, JSON.parse(l.text).n])).toEqual([
      [0, 7],
      [Buffer.byteLength(`${rec(7, 100)}\n`), 2],
    ]);
    expect(b.newOffset).toBe(Buffer.byteLength(rewritten));
  });

  test('tail of what was read changed, file grew: truncated, read again from the start', async () => {
    const first = `${recEnd(1, 100)}\n${recEnd(2, 100)}\n`;
    await fs.writeFile(f, first);
    const a = await readGuardedLines(f, 0, MAX, null);
    const rewritten = `${recEnd(1, 100)}\n${recEnd(5, 100)}\n${recEnd(6)}\n`; // head kept, the end of the last line read replaced, more appended
    expect(Buffer.byteLength(rewritten)).toBeGreaterThan(a.newOffset);
    await fs.writeFile(f, rewritten);
    const b = await readGuardedLines(f, a.newOffset, MAX, a.state ?? null);
    expect(b.truncated).toBe(true);
    expect(b.lines.map((l) => JSON.parse(l.text).n)).toEqual([1, 5, 6]);
    expect(b.lines[0]!.offset).toBe(0);
    expect(b.newOffset).toBe(Buffer.byteLength(rewritten));
  });

  test('a file shorter than 64 bytes rewritten to the same size is noticed too', async () => {
    await fs.writeFile(f, '{"a":1}\n');
    const a = await readGuardedLines(f, 0, MAX, null);
    await fs.writeFile(f, '{"a":2}\n');
    const b = await readGuardedLines(f, a.newOffset, MAX, a.state ?? null);
    expect(b).toMatchObject({ truncated: true, lines: [{ offset: 0, text: '{"a":2}' }], newOffset: 8 });
  });

  test('a rewrite made while the new lines are being read is reported by the next call (the guard is the bytes read)', async () => {
    const line1 = rec(1, 100);
    await fs.writeFile(f, `${line1}\n`);
    const a = await readGuardedLines(f, 0, MAX, null);
    await fs.appendFile(f, `${rec(2, 100)}\n`);
    const full = (await fs.readFile(f, 'utf8')).length;
    // Same size, every byte of the head different: rewritten right after the read of the new lines starts.
    const rewritten = `${rec(8, 100)}\n${rec(9, 100)}\n`;
    expect(rewritten.length).toBe(full);
    const realOpen = fs.open.bind(fs);
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const h = await realOpen(...args);
      let fired = false;
      return new Proxy(h, {
        get(target, prop, receiver) {
          if (prop !== 'read') {
            const v = Reflect.get(target, prop, receiver);
            return typeof v === 'function' ? v.bind(target) : v;
          }
          return async (buf: Buffer, off: number, len: number, pos: number) => {
            const r = await target.read(buf, off, len, pos);
            if (!fired && pos === a.newOffset) {
              fired = true;
              fsSync.writeFileSync(f, rewritten);
            }
            return r;
          };
        },
      });
    });
    let b;
    try {
      b = await readGuardedLines(f, a.newOffset, MAX, a.state ?? null);
    } finally {
      spy.mockRestore();
    }
    expect(b.truncated).toBe(false);
    expect(b.lines.map((l) => JSON.parse(l.text).n)).toEqual([2]); // the old content, read before the rewrite landed
    const c = await readGuardedLines(f, b.newOffset, MAX, b.state ?? null);
    expect(c.truncated).toBe(true);
    expect(c.lines.map((l) => JSON.parse(l.text).n)).toEqual([8, 9]);
  });

  test('after a detected rewrite, the next append reads on normally', async () => {
    await fs.writeFile(f, `${rec(1, 100)}\n`);
    const a = await readGuardedLines(f, 0, MAX, null);
    await fs.writeFile(f, `${rec(2, 100)}\n`);
    const b = await readGuardedLines(f, a.newOffset, MAX, a.state ?? null);
    expect(b.truncated).toBe(true);
    await fs.appendFile(f, `${rec(3)}\n`);
    const c = await readGuardedLines(f, b.newOffset, MAX, b.state ?? null);
    expect(c.truncated).toBe(false);
    expect(c.lines.map((l) => JSON.parse(l.text).n)).toEqual([3]);
  });
});
