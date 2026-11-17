import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, test } from 'vitest';
import { BuddyNormalizer } from '../src/normalize/buddy.js';
import { buddyEvents, Chain, openaiUsage, PROJECT, SID } from './buddy-fixtures.js';

// Timing- and memory-sensitive: 200,000 Buddy lines with a rewind every 20,000 are applied in pages (as the pipeline
// does); appending is O(1) per line, the branch walk runs only at the tombstones, and no text is held.
// Runs in the serial "timing" Vitest project.

const TIMING_SCALE = Math.max(1, Number(process.env.AGENT_CANVAS_TIMING_SCALE) || 1);
const gapBound = (ms: number): number => ms * TIMING_SCALE;

/** A forced garbage collection (node: --expose-gc enabled at run time for a fresh context's `gc`). */
function gcFn(): () => void {
  v8.setFlagsFromString('--expose-gc');
  return vm.runInNewContext('gc') as () => void;
}

const LINES = 200_000;
const MARKER_EVERY = 20_000;
const PAGE = 500;
const OUTPUT = 'o'.repeat(1024);

/** A long session: prompt, reasoning, call + 1 KB result, reply, repeated; a rewind of the last request every MARKER_EVERY lines. */
function longSession(): { lines: string[]; markers: number } {
  const c = new Chain();
  let k = 0;
  let markers = 0;
  let lastPrompt: string | null = null;
  let nextMarker = MARKER_EVERY;
  while (c.lines.length < LINES) {
    if (c.lines.length >= nextMarker && lastPrompt !== null) {
      c.rewind(lastPrompt); // drops the request's outputs
      markers += 1;
      nextMarker += MARKER_EVERY;
    }
    lastPrompt = c.peekId();
    c.prompt(`step ${k}: ${'p'.repeat(200)}`);
    c.think([`thinking ${k} ${'t'.repeat(300)}`], `m${k}a`);
    c.call('Read', `call_${k}`, { file_path: `src/f${k % 97}.ts` }, `m${k}a`, { usage: openaiUsage(1000 + k, 20, 500) });
    c.result('Read', `call_${k}`, { type: 'text', text: OUTPUT }, `m${k}a`);
    c.reply(`done ${k} ${'r'.repeat(300)}`, `m${k}b`, { usage: openaiUsage(1200 + k, 30, 600) });
    k += 1;
  }
  return { lines: c.lines, markers };
}

describe('Buddy normalizer: a 200,000-line session', () => {
  test('linear in pages, walks only at tombstones, holds no text', () => {
    const gc = gcFn();
    const { lines, markers } = longSession();
    expect(markers).toBeGreaterThanOrEqual(9);
    const events = buddyEvents(lines);
    const bytes = lines.reduce((s, l) => s + l.length, 0);
    gc();
    const before = process.memoryUsage().heapUsed;
    const n = new BuddyNormalizer('workbuddy');
    const pageMs: number[] = [];
    let removed = 0;
    let added = 0;
    const t0 = performance.now();
    for (let i = 0; i < events.length; i += PAGE) {
      const s = performance.now();
      const r = n.applyBatch(events.slice(i, i + PAGE).map((event) => ({ event, projectId: PROJECT })));
      pageMs.push(performance.now() - s);
      for (const ch of r.changes) {
        if (ch.type === 'node_removed') removed += 1;
        else if (ch.type === 'node_added') added += 1;
      }
      expect(r.unknown.every((u) => u === undefined)).toBe(true);
    }
    const total = performance.now() - t0;
    gc();
    const held = process.memoryUsage().heapUsed - before;
    const pages = pageMs.length;
    const head = pageMs.slice(1, 21).reduce((a, b) => a + b, 0);
    const tail = pageMs.slice(pages - 21, pages - 1).reduce((a, b) => a + b, 0);
    console.log(
      `[buddy timing] ${LINES} lines (${(bytes / 1e6).toFixed(0)} MB), ${markers} rewinds: total ${total.toFixed(0)} ms, max page ${Math.max(...pageMs).toFixed(1)} ms, first20 ${head.toFixed(1)} ms, last20 ${tail.toFixed(1)} ms, held ${(held / 1e6).toFixed(1)} MB (${(held / LINES).toFixed(0)} B/line)`,
    );
    expect(n.hasSession(SID)).toBe(true);
    expect(removed).toBeGreaterThanOrEqual(markers * 3); // each rewind drops at least the request's reasoning, call and reply
    expect(added).toBeGreaterThan(LINES / 2);
    // Linear: the last pages are not slower than the first (appending never re-walks the file).
    expect(tail).toBeLessThan(head * 3 + gapBound(100));
    expect(total).toBeLessThan(gapBound(15_000));
    // A page with a tombstone walks the whole file once: still short.
    expect(Math.max(...pageMs)).toBeLessThan(gapBound(500));
    // Held: per-line facts and the shown nodes' small fields (summaries are capped), not the lines.
    expect(held / LINES).toBeLessThan(2_500);
  });

  test('tool outputs are not held: 4 KB outputs hold no more than 16-byte ones', () => {
    const gc = gcFn();
    const heldWith = (output: string): number => {
      const c = new Chain();
      for (let k = 0; c.lines.length < 40_000; k++) {
        c.prompt(`step ${k}`);
        c.call('Bash', `call_${k}`, { command: `run ${k}` }, `m${k}`, { usage: openaiUsage(100, 10) });
        c.result('Bash', `call_${k}`, output, `m${k}`);
        c.reply(`done ${k}`, `m${k}b`);
      }
      const events = buddyEvents(c.lines);
      c.lines.length = 0;
      gc();
      const before = process.memoryUsage().heapUsed;
      const n = new BuddyNormalizer('codebuddy');
      for (let i = 0; i < events.length; i += PAGE) n.applyBatch(events.slice(i, i + PAGE).map((event) => ({ event, projectId: PROJECT })));
      gc();
      const held = process.memoryUsage().heapUsed - before; // the input lines are alive in both measurements
      expect(n.hasSession(SID)).toBe(true);
      expect(events.length).toBe(40_000);
      return held;
    };
    const small = heldWith('o'.repeat(16));
    const large = heldWith('o'.repeat(4096));
    const extra = 10_000 * 4080; // characters more in the large run (10,000 results)
    console.log(`[buddy timing] held with 16 B outputs ${(small / 1e6).toFixed(1)} MB, with 4 KB outputs ${(large / 1e6).toFixed(1)} MB (${(extra / 1e6).toFixed(0)} MB more output read)`);
    expect(large - small).toBeLessThan(extra / 10);
  });
});
