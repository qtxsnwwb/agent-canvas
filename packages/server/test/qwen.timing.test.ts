import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, test } from 'vitest';
import type { Change } from '@agent-canvas/shared';
import { QwenNormalizer } from '../src/normalize/qwen.js';
import type { RawEvent } from '../src/store/store.js';
import { fcall, Log, PROJECT, qwenEvents, rewindRecord, SID, text, thought, turnResult, usageMeta } from './qwen-fixtures.js';

// Timing- and memory-sensitive (Review Focus 2 and 5 of the plan): long Qwen Code sessions with many re-roots far
// back are applied in pages, as the pipeline does. Appending is O(1) per record and a re-root costs the records it
// removes and adds, never the length of the session. Runs in the serial "timing" Vitest project.

const TIMING_SCALE = Math.max(1, Number(process.env.AGENT_CANVAS_TIMING_SCALE) || 1);
const gapBound = (ms: number): number => ms * TIMING_SCALE;

/** A forced garbage collection (node: --expose-gc enabled at run time for a fresh context's `gc`). */
function gcFn(): () => void {
  v8.setFlagsFromString('--expose-gc');
  return vm.runInNewContext('gc') as () => void;
}

const RECORDS = 60_000;
const REROOT_EVERY = 3_000;
const PAGE = 500;
const OUTPUT = 'o'.repeat(1024);

/** One turn: prompt, reply (thinking, text, a call; usage), the call's 1 KB result, a final reply (usage), turn_result. */
function turn(log: Log, k: number, output = OUTPUT): void {
  log.prompt(`step ${k}: ${'p'.repeat(200)}`);
  log.reply([thought(`thinking ${k} ${'t'.repeat(300)}`), text(`looking ${k}`), fcall('read_file', { file_path: `src/f${k % 97}.ts` }, `call_${k}`)], { usage: usageMeta(1000 + k, 20, 500) });
  log.result('read_file', output, { id: `call_${k}` });
  log.reply([text(`done ${k} ${'r'.repeat(300)}`)], { usage: usageMeta(1200 + k, 30, 600) });
  log.add((env) => turnResult('completed', env));
}

function apply(n: QwenNormalizer, events: RawEvent[], pageMs?: number[]): { removed: number; added: number } {
  let removed = 0;
  let added = 0;
  for (let i = 0; i < events.length; i += PAGE) {
    const s = performance.now();
    const r = n.applyBatch(events.slice(i, i + PAGE).map((event) => ({ event, projectId: PROJECT })));
    pageMs?.push(performance.now() - s);
    for (const c of r.changes) {
      if (c.type === 'node_removed') removed += 1;
      else if (c.type === 'node_added') added += 1;
    }
    expect(r.unknown.every((u) => u === undefined)).toBe(true);
  }
  return { removed, added };
}

describe('Qwen normalizer: a 60,000-record session', () => {
  test('a re-root back to an early record every 3,000 records: linear in pages, within the gap bound', () => {
    const gc = gcFn();
    const log = new Log();
    turn(log, 0);
    turn(log, 1);
    const early = log.lines.length > 0 ? JSON.parse(log.lines[7]!).uuid as string : ''; // inside the second turn
    let k = 2;
    let reroots = 0;
    let next = REROOT_EVERY;
    while (log.lines.length < RECORDS) {
      if (log.lines.length >= next) {
        log.rewindTo(early);
        reroots += 1;
        next += REROOT_EVERY;
      }
      turn(log, k++);
    }
    expect(reroots).toBeGreaterThanOrEqual(19);
    const events = qwenEvents(log.lines);
    gc();
    const before = process.memoryUsage().heapUsed;
    const n = new QwenNormalizer();
    const pageMs: number[] = [];
    const t0 = performance.now();
    const { removed, added } = apply(n, events, pageMs);
    const total = performance.now() - t0;
    gc();
    const held = process.memoryUsage().heapUsed - before;
    const pages = pageMs.length;
    const head = pageMs.slice(1, 21).reduce((a, b) => a + b, 0);
    const tail = pageMs.slice(pages - 21, pages - 1).reduce((a, b) => a + b, 0);
    console.log(
      `[qwen timing] ${RECORDS} records, ${reroots} re-roots: total ${total.toFixed(0)} ms, max page ${Math.max(...pageMs).toFixed(1)} ms, first20 ${head.toFixed(1)} ms, last20 ${tail.toFixed(1)} ms, ${removed} removed / ${added} added, held ${(held / 1e6).toFixed(1)} MB (${(held / RECORDS).toFixed(0)} B/record)`,
    );
    expect(removed).toBeGreaterThan(reroots * 2_000); // each re-root drops ~3,000 records' nodes
    expect(tail).toBeLessThan(head * 3 + gapBound(100)); // no growth with the length of the file
    expect(total).toBeLessThan(gapBound(6_000));
    // A page holding a re-root stays within the project's ingest gap bound (pipeline.timing.test.ts).
    expect(Math.max(...pageMs)).toBeLessThan(gapBound(250));
    // Held: per-record facts, the shown nodes and the bounded detail cache, not the lines.
    expect(held / RECORDS).toBeLessThan(3_000);
  }, 120_000);

  /** A linear 60,000-record session applied in pages; returns the normalizer, the log and the prompt uuids. */
  function linear(): { n: QwenNormalizer; log: Log; prompts: string[]; events: RawEvent[] } {
    const log = new Log();
    const prompts: string[] = [];
    for (let k = 0; log.lines.length < RECORDS; k++) {
      prompts.push(log.peek());
      turn(log, k, 'ok');
    }
    const events = qwenEvents(log.lines);
    const n = new QwenNormalizer();
    apply(n, events);
    return { n, log, prompts, events };
  }

  /** Times one rewind line whose parent is `to`. */
  function timeRewind(s: { n: QwenNormalizer; log: Log; events: RawEvent[] }, to: string): { ms: number; changes: Change[] } {
    const last = s.events[s.events.length - 1]!;
    const offset = last.source === 'transcript' ? last.offset + Buffer.byteLength(last.line) + 1 : 0;
    s.log.at(to);
    s.log.add((env) => rewindRecord(env));
    const ev = qwenEvents([s.log.lines[s.log.lines.length - 1]!], { startOffset: offset })[0]!;
    const t0 = performance.now();
    const r = s.n.apply(ev, PROJECT);
    const ms = performance.now() - t0;
    expect(r.unknownRecordType).toBeUndefined();
    return { ms, changes: r.changes };
  }

  test('one re-root near the end of a 60,000-record chain costs what it drops, not the chain', () => {
    const s = linear();
    const back = s.prompts[s.prompts.length - 60]!; // 60 turns: 300 records
    const r = timeRewind(s, back);
    const removed = r.changes.filter((c) => c.type === 'node_removed').length;
    console.log(`[qwen timing] re-root dropping 300 of 60,000 records: ${r.ms.toFixed(1)} ms, ${removed} nodes removed`);
    expect(removed).toBe(59 * 5 + 4); // the prompt kept; its reply (3 nodes) and final reply go, and 59 whole turns (5 nodes each)
    expect(r.ms).toBeLessThan(gapBound(50));
    expect(s.n.hasSession(SID)).toBe(true);
  }, 120_000);

  test('one re-root of a 60,000-record chain back to its start: measured (the removals are inherent)', () => {
    const s = linear();
    const r = timeRewind(s, s.prompts[0]!);
    const removed = r.changes.filter((c) => c.type === 'node_removed').length;
    console.log(`[qwen timing] re-root of a 60,000-record chain to its first prompt: ${r.ms.toFixed(1)} ms, ${removed} nodes removed`);
    expect(removed).toBe(RECORDS - 1); // 12,000 turns of 5 nodes; the first prompt stays
    expect(r.ms).toBeLessThan(gapBound(500));
  }, 120_000);

  test('tool outputs are not held: 4 KB outputs hold no more than 16-byte ones', () => {
    const gc = gcFn();
    const heldWith = (output: string): number => {
      const log = new Log();
      for (let k = 0; log.lines.length < 40_000; k++) turn(log, k, output);
      const events = qwenEvents(log.lines);
      log.lines.length = 0;
      gc();
      const before = process.memoryUsage().heapUsed;
      const n = new QwenNormalizer();
      apply(n, events);
      gc();
      const held = process.memoryUsage().heapUsed - before; // the input lines are alive in both measurements
      expect(n.hasSession(SID)).toBe(true);
      return held;
    };
    const small = heldWith('o'.repeat(16));
    const large = heldWith('o'.repeat(4096));
    const extra = 8_000 * 4080; // characters more in the large run (8,000 results)
    console.log(`[qwen timing] held with 16 B outputs ${(small / 1e6).toFixed(1)} MB, with 4 KB outputs ${(large / 1e6).toFixed(1)} MB (${(extra / 1e6).toFixed(0)} MB more output read)`);
    expect(large - small).toBeLessThan(extra / 10);
  }, 120_000);
});
