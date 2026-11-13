import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { describe, expect, test, vi } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { migrateAll, startStorageMaintenance, vacuumIfDue } from '../src/store/migrate-storage.js';
import { openStore, type Store } from '../src/store/store.js';

/*
 * Benchmark of compressed storage at the real shape, scaled down: Claude Code transcripts of tool calls (input 0.5-3 KB),
 * tool results (1-6 KB) and replies (1-4 KB), about 3.5 KB per raw row, through the real Pipeline -> store on temp
 * databases. Reports (1) ingest throughput plain vs compressed, (2) full rebuild plain vs compressed, (3) the background
 * migration of the plain database (time, longest event-loop stall), (4) sizes: database file and the raw_event /
 * node_detail tables before the migration, after it, and after VACUUM.
 *
 * "Plain" is this version with encodeBody forced to store text (as the previous version did); the filler text is cut
 * from this repository's own sources (synthetic, compresses like code and logs).
 *
 * Skipped by default. Run:
 *   AGENT_CANVAS_BENCH=1 npx --yes pnpm@10 vitest run packages/server/test/storage.bench.test.ts
 * Raw rows (default 200000): AGENT_CANVAS_BENCH_STORAGE_ROWS=50000; temp directory (several GB at the default size):
 * AGENT_CANVAS_BENCH_TMP=<dir> (default the OS temp directory)
 * Targets (asserted only with AGENT_CANVAS_BENCH_ASSERT=1): rebuild <= 1.3x plain; the two tables <= 30% of plain.
 */

const BENCH = process.env.AGENT_CANVAS_BENCH === '1';
const ASSERT = process.env.AGENT_CANVAS_BENCH_ASSERT === '1';
const ROWS = Number(process.env.AGENT_CANVAS_BENCH_STORAGE_ROWS ?? '200000');
const LINES_PER_SESSION = 1500;

const mode = vi.hoisted(() => ({ plain: false }));
vi.mock('../src/store/codec.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/store/codec.js')>();
  return { ...orig, encodeBody: (text: string) => (mode.plain ? { data: text, enc: 0 as const } : orig.encodeBody(text)) };
});

/** Deterministic PRNG (mulberry32). */
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

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
function corpus(): string {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) out.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(SRC);
  return out.join('\n');
}

/** Writes the projects directory; returns the raw rows written and their total bytes. */
function writeTranscripts(projectsDir: string, rows: number): { rows: number; bytes: number } {
  const text = corpus();
  const r = rng(42);
  const slice = (n: number): string => {
    const at = Math.floor(r() * (text.length - n - 1));
    return text.slice(at, at + n);
  };
  const hex = (n: number): string => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');
  let written = 0;
  let bytes = 0;
  let t = Date.parse('2026-10-01T00:00:00.000Z');
  for (let s = 0; written < rows; s++) {
    const sessionId = `bench-${String(s).padStart(5, '0')}-${hex(8)}`;
    const dir = path.join(projectsDir, `D--bench-p${s % 20}`);
    fs.mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    let parent: string | null = null;
    const base = (type: string, uuid: string): Record<string, unknown> => ({
      type, uuid, parentUuid: parent, timestamp: new Date((t += 1000)).toISOString(), sessionId,
      cwd: 'D:\\bench\\project', gitBranch: 'main', isSidechain: false, userType: 'external', version: '2.1.0',
    });
    const push = (rec: Record<string, unknown>): void => {
      const line = JSON.stringify(rec);
      lines.push(line);
      bytes += Buffer.byteLength(line) + 1;
      written += 1;
      parent = rec.uuid as string;
    };
    push({ ...base('user', `u-${hex(12)}`), message: { role: 'user', content: slice(300) } });
    while (lines.length < LINES_PER_SESSION && written < rows) {
      const toolId = `toolu_${hex(24)}`;
      push({
        ...base('assistant', `a-${hex(12)}`),
        message: { id: `msg_${hex(24)}`, role: 'assistant', model: 'claude-x', content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: slice(500 + Math.floor(r() * 2500)), description: slice(60) } }], stop_reason: 'tool_use', usage: { input_tokens: Math.floor(r() * 9000), output_tokens: Math.floor(r() * 900) } },
      });
      push({ ...base('user', `r-${hex(12)}`), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: slice(1000 + Math.floor(r() * 5000)) }] } });
      push({
        ...base('assistant', `t-${hex(12)}`),
        message: { id: `msg_${hex(24)}`, role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: slice(1000 + Math.floor(r() * 3000)) }], stop_reason: null, usage: { input_tokens: 10, output_tokens: 5 } },
      });
    }
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
  }
  return { rows: written, bytes };
}

const MB = (n: number): string => (n / 1024 / 1024).toFixed(1);

function tableBytes(file: string): Record<string, number> {
  const db = new Database(file, { readonly: true });
  try {
    const rows = db.prepare(`SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name`).all() as { name: string; bytes: number }[];
    return Object.fromEntries(rows.map((r) => [r.name, r.bytes]));
  } finally {
    db.close();
  }
}

function fileBytes(file: string): number {
  let n = 0;
  for (const f of [file, `${file}-wal`]) {
    try {
      n += fs.statSync(f).size;
    } catch {
      // missing
    }
  }
  return n;
}

/** Longest gap of a 2 ms interval timer while `fn` runs (the event-loop stall). */
async function withStall<T>(fn: () => Promise<T>): Promise<{ value: T; stallMs: number; ms: number }> {
  let last = performance.now();
  let stall = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    stall = Math.max(stall, now - last - 2);
    last = now;
  }, 2);
  const t0 = performance.now();
  try {
    const value = await fn();
    return { value, stallMs: stall, ms: performance.now() - t0 };
  } finally {
    clearInterval(timer);
  }
}

async function ingestAndRebuild(config: Config, dbFile: string): Promise<{ ingestMs: number; rebuildMs: number; store: Store }> {
  const store = openStore(dbFile);
  const p = new Pipeline(store, config);
  const t0 = performance.now();
  await p.scanAll();
  await p.idle();
  const ingestMs = performance.now() - t0;
  const t1 = performance.now();
  p.rebuild();
  const rebuildMs = performance.now() - t1;
  return { ingestMs, rebuildMs, store };
}

/** A copy of a database as the previous version left it: storage migration not recorded (its rows are plain). */
function oldCopy(from: string, to: string): void {
  fs.copyFileSync(from, to);
  const db = new Database(to);
  try {
    db.exec(`DELETE FROM meta WHERE key LIKE 'storage:%'`);
  } finally {
    db.close();
  }
}

/** Lets the checkpointer copy the WAL into the file, so file sizes compare. */
async function settle(file: string): Promise<void> {
  // The closed store's checkpointer thread may still hold the file for a moment: retry until the WAL is empty.
  for (let attempt = 0; attempt < 100; attempt++) {
    const db = new Database(file);
    let busy = 1;
    try {
      busy = (db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[])[0]?.busy ?? 1;
    } finally {
      db.close();
    }
    let wal = 0;
    try {
      wal = fs.statSync(`${file}-wal`).size;
    } catch {
      wal = 0;
    }
    if (busy === 0 && wal === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!BENCH)('storage benchmark', () => {
  test(`${ROWS} raw rows: ingest, rebuild, migration, VACUUM`, async () => {
    const root = fs.mkdtempSync(path.join(process.env.AGENT_CANVAS_BENCH_TMP ?? os.tmpdir(), 'cc-storage-bench-'));
    try {
      const projectsDir = path.join(root, 'projects');
      const config = loadConfig({}, { projectsDir, dataDir: path.join(root, 'data'), cursorDbPath: null, codexSessionsDir: null });
      const gen = writeTranscripts(projectsDir, ROWS);
      console.log(`raw rows ${gen.rows}, ${MB(gen.bytes)} MB of JSONL, ${(gen.bytes / gen.rows / 1024).toFixed(2)} KB per row`);

      mode.plain = true;
      const plainFile = path.join(root, 'plain.db');
      const plain = await ingestAndRebuild(config, plainFile);
      const details = plain.store.bodyKeyRange().detail;
      plain.store.close();
      await settle(plainFile);
      const plainTables = tableBytes(plainFile);
      const plainSize = fileBytes(plainFile);

      mode.plain = false;
      const compFile = path.join(root, 'compressed.db');
      const comp = await ingestAndRebuild(config, compFile);
      comp.store.close();
      await settle(compFile);
      const compTables = tableBytes(compFile);
      const compSize = fileBytes(compFile);

      fs.rmSync(projectsDir, { recursive: true, force: true });
      // The plain database migrated in the background (as a service would), then VACUUM.
      const migFile = path.join(root, 'migrated.db');
      oldCopy(plainFile, migFile);
      const mig = openStore(migFile);
      const host = { startupDone: () => true, importing: () => false, holdWrites: () => () => undefined };
      const migration = await withStall(async () => {
        const job = startStorageMaintenance(mig, host, { pollMs: 1, freeBytes: () => 0 }); // VACUUM skipped here, run below
        await job.done;
      });
      mig.close();
      await settle(migFile);
      const migTables = tableBytes(migFile);
      const migSize = fileBytes(migFile);
      const mig2 = openStore(migFile);
      const vacuum = await withStall(() => vacuumIfDue(mig2, { host, freeBytes: () => 10 ** 13 }));
      mig2.close();
      await settle(migFile);
      const vacTables = tableBytes(migFile);
      const vacSize = fileBytes(migFile);

      // The synchronous migration (compact) on another copy, for its throughput alone.
      const syncFile = path.join(root, 'sync.db');
      oldCopy(plainFile, syncFile);
      const sync = openStore(syncFile);
      const t0 = performance.now();
      migrateAll(sync);
      const syncMs = performance.now() - t0;
      sync.close();
      await settle(syncFile);

      const two = (t: Record<string, number>): number => (t.raw_event ?? 0) + (t.node_detail ?? 0);
      const breakdown = (t: Record<string, number>): string =>
        Object.entries(t)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([k, v]) => `${k} ${MB(v)}`)
          .join(', ');
      console.log(`plain tables: ${breakdown(plainTables)}\ncompressed tables: ${breakdown(compTables)}`);
      const rows = [
        ['', 'plain', 'compressed', 'ratio'],
        ['ingest (s)', (plain.ingestMs / 1000).toFixed(1), (comp.ingestMs / 1000).toFixed(1), (comp.ingestMs / plain.ingestMs).toFixed(2)],
        ['ingest (rows/s)', String(Math.round(gen.rows / (plain.ingestMs / 1000))), String(Math.round(gen.rows / (comp.ingestMs / 1000))), ''],
        ['rebuild (s)', (plain.rebuildMs / 1000).toFixed(1), (comp.rebuildMs / 1000).toFixed(1), (comp.rebuildMs / plain.rebuildMs).toFixed(2)],
        ['raw_event (MB)', MB(plainTables.raw_event ?? 0), MB(compTables.raw_event ?? 0), ((compTables.raw_event ?? 0) / (plainTables.raw_event ?? 1)).toFixed(2)],
        ['node_detail (MB)', MB(plainTables.node_detail ?? 0), MB(compTables.node_detail ?? 0), ((compTables.node_detail ?? 0) / (plainTables.node_detail ?? 1)).toFixed(2)],
        ['database file (MB)', MB(plainSize), MB(compSize), (compSize / plainSize).toFixed(2)],
      ];
      console.log(`node details ${details}`);
      console.log(rows.map((r) => r.map((c, i) => (i === 0 ? c.padEnd(20) : c.padStart(12))).join('')).join('\n'));
      console.log(
        [
          `migration (background job): ${(migration.ms / 1000).toFixed(1)} s, longest event-loop stall ${migration.stallMs.toFixed(0)} ms`,
          `migration (compact, synchronous): ${(syncMs / 1000).toFixed(1)} s`,
          `VACUUM (worker): ${(vacuum.ms / 1000).toFixed(1)} s, longest event-loop stall ${vacuum.stallMs.toFixed(0)} ms, outcome ${vacuum.value.outcome}`,
          `file: before migration ${MB(plainSize)} MB, after migration ${MB(migSize)} MB, after VACUUM ${MB(vacSize)} MB`,
          `raw_event + node_detail: before ${MB(two(plainTables))} MB, after migration ${MB(two(migTables))} MB, after VACUUM ${MB(two(vacTables))} MB`,
        ].join('\n'),
      );
      if (ASSERT) {
        expect(comp.rebuildMs).toBeLessThanOrEqual(plain.rebuildMs * 1.3);
        expect(two(vacTables)).toBeLessThanOrEqual(two(plainTables) * 0.3);
      }
      expect(vacuum.value.outcome).toBe('done');
    } finally {
      await new Promise((r) => setTimeout(r, 1000)); // closed stores' checkpointer threads let go of their files
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    }
  }, 3_600_000);

  test('edge storage: bytes per edge with Cursor-length node ids', async () => {
    const root = fs.mkdtempSync(path.join(process.env.AGENT_CANVAS_BENCH_TMP ?? os.tmpdir(), 'cc-edge-bench-'));
    const file = path.join(root, 'edges.db');
    const EDGES = Number(process.env.AGENT_CANVAS_BENCH_EDGES ?? '300000');
    try {
      const s = openStore(file);
      const r = rng(7);
      const hex = (n: number): string => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');
      // Cursor node ids: `<conversation id>:<bubble id>`-like, about 80 characters; session ids are UUIDs.
      const sessions = Array.from({ length: 300 }, () => `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`);
      const perSession = Math.ceil(EDGES / sessions.length);
      for (const sid of sessions) {
        const ids = Array.from({ length: perSession + 1 }, () => `${sid}:${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}:b`);
        s.applyChanges(
          ids.slice(1).map((to, i) => ({
            type: 'edge_added' as const,
            edge: { id: `${ids[i]}->${to}`, sessionId: sid, from: ids[i]!, to, kind: 'sequence' as const },
          })),
        );
      }
      s.close();
      const t = tableBytes(file);
      const edgeBytes = Object.entries(t)
        .filter(([k]) => k === 'edge' || k.startsWith('sqlite_autoindex_edge'))
        .reduce((n, [, v]) => n + v, 0);
      console.log(`edges ${perSession * sessions.length}: edge table + its indexes ${MB(edgeBytes)} MB, ${(edgeBytes / (perSession * sessions.length)).toFixed(0)} bytes per edge (${Object.entries(t).filter(([k]) => k.includes('edge')).map(([k, v]) => `${k} ${MB(v)}`).join(', ')})`);
    } finally {
      await new Promise((r) => setTimeout(r, 1000)); // the closed store's checkpointer thread lets go of the file
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    }
  }, 600_000);
});
