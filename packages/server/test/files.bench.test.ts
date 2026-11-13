import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, test } from 'vitest';
import type { Change, FileAction, GraphNode, Origin, Session } from '@agent-canvas/shared';
import { FilesService, type FilesQuery } from '../src/files/service.js';
import { StatsService, storeStatsSource, type StatsSource } from '../src/stats/service.js';
import { openStore } from '../src/store/store.js';

/*
 * Benchmark of the file routes' computation on a temp database at the real dataset's shape (2026-11-12): 36 sessions,
 * about 214,000 derived nodes (four of 30–40k), about 45,000 file touches over about 6,000 distinct files in 6 projects.
 * Reports wall time and the longest event-loop stall for: the first /api/files request (every summary built), a filter
 * switch (nothing read), a request after one session changed (only it re-read), and /api/sessions/:id/files of the
 * largest session, cold; and the start-up warm-up (stats, then files) with and without shared reads.
 *
 * Skipped by default. Run:
 *   AGENT_CANVAS_BENCH=1 npx --yes pnpm@10 vitest run packages/server/test/files.bench.test.ts
 * Hard limits (only with AGENT_CANVAS_BENCH_ASSERT=1): first request < 3 s, later ones < 1 s.
 */

const BENCH = process.env.AGENT_CANVAS_BENCH === '1';
const ASSERT = process.env.AGENT_CANVAS_BENCH_ASSERT === '1';
const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const DAY = 24 * 3600_000;
const ORIGIN_OF: Origin[] = ['claude', 'codex', 'cursor'];
const PROJECTS = 6;
/** Distinct files per project: 6 × 1,000 = 6,000 in all. */
const FILES_PER_PROJECT = 1000;
/** Share of nodes that touch a file: 45,000 / 214,000. */
const TOUCH_SHARE = 0.21;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const iso = (ms: number): string => new Date(ms).toISOString();

function sessionChanges(index: number, count: number, startMs: number): Change[] {
  const r = rng(index + 1);
  const id = `bench-s${String(index).padStart(3, '0')}`;
  const origin = ORIGIN_OF[index % 3]!;
  const project = index % PROJECTS;
  const cwd = `D:/work/proj${project}`;
  const step = Math.max(1, Math.floor((40 * DAY) / count / 4));
  const nodes: GraphNode[] = [];
  for (let i = 0; i < count; i++) {
    const at = startMs + i * step;
    const touches = r() < TOUCH_SHARE;
    const action: FileAction = origin === 'codex' ? (r() < 0.9 ? 'edit' : 'write') : r() < 0.6 ? 'read' : r() < 0.9 ? 'edit' : 'write';
    // Skewed towards a few hot files, as real projects are.
    const file = Math.floor(FILES_PER_PROJECT * r() ** 2);
    const spell = r() < 0.1 ? `d:\\work\\proj${project}\\src\\f${file}.ts` : `${cwd}/src/f${file}.ts`;
    nodes.push({
      id: `${id}-n${i}`, sessionId: id, turnId: `${id}-t${Math.floor(i / 60)}`, agentId: null, parentId: null,
      kind: touches ? 'tool' : r() < 0.5 ? 'text' : 'tool', status: 'succeeded', timestamp: iso(at), confirmed: true,
      title: 'x', summary: 'x'.repeat(120), toolName: touches ? 'Edit' : 'Bash', toolUseId: `${id}-tu${i}`, messageId: null,
      durationMs: 100, endedAt: iso(at + 100), usage: null, systemSubtype: null, childAgentId: null,
      ...(touches ? { files: [{ path: spell, action }] } : {}),
    });
  }
  const session: Session = {
    id, projectId: `D--work-proj${project}`, origin, cwd: `D:\\work\\proj${project}`, title: `session ${index}`, gitBranch: null,
    status: 'idle', sourceDeleted: false, startedAt: iso(startMs), lastActivityAt: iso(startMs + count * step),
  };
  return [{ type: 'session_upserted', session }, ...nodes.map((node): Change => ({ type: 'node_added', node, detail: {} }))];
}

async function measured<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number; stallMs: number }> {
  let last = performance.now();
  let stallMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    stallMs = Math.max(stallMs, now - last);
    last = now;
  }, 1);
  const t = performance.now();
  try {
    const result = await fn();
    const ms = performance.now() - t;
    stallMs = Math.max(stallMs, performance.now() - last);
    return { result, ms, stallMs };
  } finally {
    clearInterval(timer);
  }
}
const line = (name: string, m: { ms: number; stallMs: number }): string =>
  `${name}: ${m.ms.toFixed(0)} ms (longest stall ${m.stallMs.toFixed(0)} ms)`;

describe.skipIf(!BENCH)('files benchmark', () => {
  test('real shape: 36 sessions / 214,000 nodes / 45,000 touches', { timeout: 600_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-files-bench-'));
    const store = openStore(path.join(dir, 'bench.db'));
    try {
      const sizes = [40_000, 38_000, 34_000, 30_000, ...Array.from({ length: 32 }, () => 2_250)];
      let total = 0;
      sizes.forEach((count, i) => {
        store.applyChanges(sessionChanges(i, count, NOW - 40 * DAY + i * DAY / 2));
        total += count;
      });
      const base = storeStatsSource(store);
      let reads = 0;
      const source: StatsSource = { ...base, readSession: (id, stopped) => { reads++; return base.readSession(id, stopped); } };
      const svc = new FilesService(source, { now: () => NOW });
      const q: FilesQuery = { projectId: 'D--work-proj0', origin: null, range: 'all', changedOnly: true, q: null, sort: 'recent', limit: 200 };

      const first = await measured(() => svc.project(q));
      const afterFirst = reads;
      const sw = await measured(() => svc.project({ ...q, range: '30d', changedOnly: false, sort: 'changes', q: 'f1' }));
      const switchReads = reads - afterFirst;
      const other = await measured(() => svc.project({ ...q, projectId: 'D--work-proj3', range: '7d' }));
      store.applyChanges([]); // no-op
      const committed = store.applyChanges([{
        type: 'node_added',
        node: { ...store.nodePage('bench-s005', null, 1)[0]!.node, id: 'bench-s005-extra', timestamp: iso(NOW - 1000), files: [{ path: 'D:/work/proj5/new.ts', action: 'write' }] },
        detail: {},
      }]);
      svc.noteChanges(committed);
      const beforeChange = reads;
      const changed = await measured(() => svc.project({ ...q, projectId: 'D--work-proj5' }));
      const changedReads = reads - beforeChange;
      const cold = new FilesService(storeStatsSource(store), { now: () => NOW });
      const big = await measured(() => cold.session('bench-s000'));

      // The start-up warm-up: stats then files, each reading every session (before), or sharing reads (after).
      const warmup = async (linked: boolean) => {
        const sb = storeStatsSource(store);
        let n = 0;
        const counting: StatsSource = { ...sb, readSession: (id, stopped) => { n++; return sb.readSession(id, stopped); } };
        const stats = new StatsService(counting, { now: () => NOW });
        const files = new FilesService(counting, { now: () => NOW });
        if (linked) files.shareReadsWith(stats);
        const m = await measured(async () => {
          await stats.warm();
          await files.warm();
        });
        return { ...m, reads: n };
      };
      const warmBefore = await warmup(false);
      const warmAfter = await warmup(true);
      // Totals of the dataset, from the warm cache.
      let touches = 0;
      let distinct = 0;
      for (let p = 0; p < PROJECTS; p++) {
        const r = await svc.project({ ...q, projectId: `D--work-proj${p}`, changedOnly: false, limit: 200 });
        distinct += r.totalFiles;
      }
      for (const s of base.sessions()) touches += (await svc.session(s.id))!.files.reduce((n, f) => n + f.reads + f.changes, 0);
      console.log(
        `files benchmark, ${total} nodes / ${sizes.length} sessions, ${touches} touches, ${distinct} distinct files\n` +
          `  ${line(`first request (${afterFirst} session reads)`, first)}\n` +
          `  ${line(`filter switch (${switchReads} session reads)`, sw)}\n` +
          `  ${line('another project, 7d', other)}\n` +
          `  ${line(`after one session changed (${changedReads} session read)`, changed)}\n` +
          `  ${line('session route, largest session (40,000 nodes), cold', big)}
` +
          `  ${line(`warm-up stats + files, separate reads (${warmBefore.reads} session reads)`, warmBefore)}
` +
          `  ${line(`warm-up stats + files, shared reads (${warmAfter.reads} session reads)`, warmAfter)}`,
      );
      expect(switchReads).toBe(0);
      expect(warmAfter.reads).toBe(sizes.length);
      expect(changedReads).toBe(1);
      expect(changed.result.files.some((f) => f.relativePath === 'new.ts')).toBe(true);
      if (ASSERT) {
        expect(first.ms).toBeLessThan(3000);
        expect(sw.ms).toBeLessThan(1000);
        expect(changed.ms).toBeLessThan(1000);
      }
    } finally {
      store.close();
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20 }).catch(() => undefined);
    }
  });
});
