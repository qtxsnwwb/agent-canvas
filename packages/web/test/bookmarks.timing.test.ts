import { expect, test } from 'vitest';
import type { Bookmark } from '@agent-canvas/shared';
import { bookmarkRows, filterBookmarkRows } from '../src/bookmarks';
import { createPageMasker, IDENTITY_MASKER, type PageMasker } from '../src/masking';

/** CI's shared runners are slower: the bound grows by AGENT_CANVAS_TIMING_SCALE there (see vitest.config.ts). */
const TIMING_SCALE = Math.max(1, Number(process.env.AGENT_CANVAS_TIMING_SCALE) || 1);
const BOUND_MS = 200;

/** 5,000 invented bookmarks: half steps, some with long labels, a few whose step or session is gone. */
function many(): Bookmark[] {
  const out: Bookmark[] = [];
  const start = Date.parse('2026-01-01T00:00:00.000Z');
  for (let i = 0; i < 5_000; i++) {
    const step = i % 2 === 0;
    out.push({
      id: i + 1, sessionId: `s${i % 700}`, nodeId: step ? `n${i}` : null, note: i % 3 === 0 ? '' : `第 ${i} 个备注 note ${i}`,
      createdAt: new Date(start + i * 60_000).toISOString(), noteUpdatedAt: null,
      snapshot: {
        sessionTitle: `会话 ${i % 700} 修 bug ${i}`, origin: i % 5 === 0 ? 'codex' : 'claude', projectId: `D--work-proj${i % 40}`,
        cwd: `D:/work/proj${i % 40}`, nodeKind: step ? 'tool' : null, toolName: step ? 'Bash' : null,
        stepLabel: step ? `Bash · npm test -- --grep case-${i} ${'x'.repeat(i % 60)}` : null, nodeAt: step ? new Date(start).toISOString() : null,
      },
      now: {
        session: i % 97 !== 0, node: i % 31 !== 0, sessionTitle: i % 97 === 0 ? null : `会话 ${i % 700} 新标题`, sourceDeleted: false,
        projectName: i % 97 === 0 ? null : `proj${i % 40}`,
      },
    });
  }
  return out;
}

function measure(m: PageMasker): { ms: number; shown: number } {
  const list = many();
  const t0 = performance.now();
  const rows = bookmarkRows(list, m);
  const shown = filterBookmarkRows(rows, 'NOTE 4').length;
  return { ms: performance.now() - t0, shown };
}

test(`5,000 个书签：建行加一次筛选在 ${BOUND_MS} ms 以内（遮蔽关着、开着）`, () => {
  const off = measure(IDENTITY_MASKER);
  const on = measure(createPageMasker({ customTerms: ['FalconProject'], numbered: false }));
  console.log(`5,000 bookmarks, rows + one filter: masking off ${off.ms.toFixed(1)} ms, on ${on.ms.toFixed(1)} ms (bound ${BOUND_MS * TIMING_SCALE} ms)`);
  expect(off.shown).toBeGreaterThan(0);
  expect(on.shown).toBe(off.shown);
  expect(off.ms).toBeLessThan(BOUND_MS * TIMING_SCALE);
  expect(on.ms).toBeLessThan(BOUND_MS * TIMING_SCALE);
});
