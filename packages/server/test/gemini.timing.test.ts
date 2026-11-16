import { expect, test } from 'vitest';
import { GeminiNormalizer } from '../src/normalize/gemini.js';
import { metaLine, PROJECT, transcript, userMsg } from './gemini-fixtures.js';

// Timing-sensitive Gemini normalizer check (the timing project: one file at a time, after the others, retried).
// Moved from normalize-gemini.test.ts (fix round 1, I2): under full-suite load its wall-clock bound could be missed.

/** A session of `n` messages: users, and gemini messages with 8 calls each, every gemini message re-appended 3×. */
function bigSession(n: number): { lines: string[]; ids: string[] } {
  const out = [metaLine()];
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const mid = `big-${i}`;
    ids.push(mid);
    if (i % 2 === 0) {
      out.push(JSON.stringify(userMsg(mid, `prompt ${i}`)));
      continue;
    }
    const calls = (status: string) => Array.from({ length: 8 }, (_, k) => ({ id: `c${i}-${k}`, name: 'read_file', args: { file_path: `/home/dev/demo-app/f${k}.ts` }, status, timestamp: '2026-11-16T09:41:30.000Z' }));
    const base = { id: mid, timestamp: '2026-11-16T09:41:29.000Z', type: 'gemini', content: `reply ${i}` };
    out.push(JSON.stringify(base), JSON.stringify({ ...base, toolCalls: calls('scheduled') }), JSON.stringify({ ...base, toolCalls: calls('success') }));
  }
  return { lines: out, ids };
}
const loaded = (lines: string[]): GeminiNormalizer => {
  const n = new GeminiNormalizer();
  n.applyBatch(transcript(lines).map((event) => ({ event, projectId: PROJECT })));
  return n;
};

test('I2: removing every node of a 5,000-message session, and 1,250 messages by removeIds, each well under 1 s', () => {
  const { lines, ids } = bigSession(5000);
  const all = loaded(lines);
  let t = performance.now();
  const out = all.apply(transcript([JSON.stringify({ $rewindTo: 'unknown-id' })], { startOffset: 1e9 })[0]!, PROJECT);
  const rewindMs = performance.now() - t;
  expect(out.changes.filter((c) => c.type === 'node_removed').length).toBe(2500 + 2500 * 9);
  const some = loaded(lines);
  t = performance.now();
  const out2 = some.apply(transcript([JSON.stringify({ $patch: { removeIds: ids.filter((_, i) => i % 4 === 1) } })], { startOffset: 1e9 })[0]!, PROJECT);
  const patchMs = performance.now() - t;
  expect(out2.changes.filter((c) => c.type === 'node_removed').length).toBe(1250 * 9);
  expect(rewindMs).toBeLessThan(1000);
  expect(patchMs).toBeLessThan(1000);
});
