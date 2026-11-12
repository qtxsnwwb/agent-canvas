import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from 'node:inspector/promises';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { loadConfig, type Config } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { ClaudeFileSource } from '../src/sources/claude.js';
import { openCursorDb, type CursorDbReader, type DbResult } from '../src/sources/cursor/db.js';
import { CursorSource } from '../src/sources/cursor/source.js';
import { openStore } from '../src/store/store.js';

/*
 * Benchmark of a first Cursor import, a restart on unchanged data and a rebuild, through the real CursorSource ->
 * Pipeline -> store on temp databases (synthetic data shaped like real Cursor records: tool bubbles with 2-8 KB
 * params / result, turns of ~60 bubbles, task_v2 dispatches with their subagent conversations).
 *
 * Skipped by default. Run:
 *   CLAUDE_CANVAS_BENCH=1 npx --yes pnpm@10 vitest run packages/server/test/cursor-import.bench.test.ts
 * Sizes (main-conversation bubbles; one 300-bubble subagent per 500 main bubbles): CLAUDE_CANVAS_BENCH_SIZES=5000,10000,20000
 * Hard limits (only with CLAUDE_CANVAS_BENCH_ASSERT=1): 20k first import < 60 s, longest event-loop stall < 200 ms.
 */

const BENCH = process.env.CLAUDE_CANVAS_BENCH === '1';
const ASSERT = process.env.CLAUDE_CANVAS_BENCH_ASSERT === '1';
const SIZES = (process.env.CLAUDE_CANVAS_BENCH_SIZES ?? '5000,10000,20000').split(',').map((s) => Number(s.trim()));
const SUB_BUBBLES = 300;
const TURN = 60;
const T0 = Date.parse('2026-11-01T08:00:00.000Z');
const MAIN = 'bench-main-0000';

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

const WORDS = 'const value function return import export async await string number object array promise error result file path read write'.split(' ');
function words(r: () => number, bytes: number): string {
  const out: string[] = [];
  let n = 0;
  while (n < bytes) {
    const w = WORDS[Math.floor(r() * WORDS.length)]!;
    out.push(w);
    n += w.length + 1;
  }
  return out.join(' ');
}

const TOOLS = ['read_file_v2', 'run_terminal_command_v2', 'ripgrep_raw_search', 'edit_file_v2', 'glob_file_search'];

interface Bubble {
  bubbleId: string;
  type: 1 | 2;
  [k: string]: unknown;
}

/** One conversation's bubbles: turns of TURN bubbles (prompt, thinking, text and tool calls; the last ends the turn). */
function conversation(prefix: string, count: number, t0: number, seed: number, dispatchAt: Map<number, string> = new Map()): Bubble[] {
  const r = rng(seed);
  const out: Bubble[] = [];
  for (let i = 0; i < count; i++) {
    const at = t0 + i * 1000;
    const iso = new Date(at).toISOString();
    const id = `${prefix}-b${String(i).padStart(6, '0')}`;
    const pos = i % TURN;
    const lastOfTurn = pos === TURN - 1 || i === count - 1;
    const base = { bubbleId: id, createdAt: iso, startedAtMs: at, completedAtMs: at + 400, tokenCount: { inputTokens: 100, outputTokens: 50 } };
    let b: Bubble;
    const sub = dispatchAt.get(i);
    if (pos === 0) {
      b = { ...base, type: 1, text: `Prompt ${i}: ${words(r, 200)}`, tokenCount: { inputTokens: 0, outputTokens: 0 } };
    } else if (sub !== undefined) {
      b = {
        ...base,
        type: 2,
        capabilityType: 15,
        text: '',
        toolFormerData: {
          name: 'task_v2',
          status: 'completed',
          toolCallId: `call-${sub}`,
          params: JSON.stringify({ description: `Explore ${sub}`, prompt: words(r, 1500), subagentType: 'explore' }),
          result: JSON.stringify({ agentId: sub, summary: words(r, 1500) }),
          toolCallBinary: 'B'.repeat(1024),
        },
      };
    } else if (pos === 1) {
      b = { ...base, type: 2, capabilityType: 30, text: '', thinking: { text: words(r, 600), signature: 'sig' }, thinkingDurationMs: 900 };
    } else if (lastOfTurn || pos % 7 === 0) {
      b = { ...base, type: 2, text: words(r, 400) };
    } else {
      const name = TOOLS[Math.floor(r() * TOOLS.length)]!;
      const paramsBytes = 1000 + Math.floor(r() * 3000);
      const resultBytes = 1000 + Math.floor(r() * 5000);
      b = {
        ...base,
        type: 2,
        capabilityType: 15,
        text: '',
        toolFormerData: {
          name,
          status: 'completed',
          toolCallId: `call-${id}`,
          params: JSON.stringify({ command: words(r, 40), targetFile: `src/${id}.ts`, explanation: words(r, paramsBytes) }),
          result: JSON.stringify(name === 'run_terminal_command_v2' ? { exitCode: 0, output: words(r, resultBytes) } : { contents: words(r, resultBytes) }),
          rawArgs: '{"raw":true}',
          toolCallBinary: 'B'.repeat(1024),
        },
      };
    }
    if (lastOfTurn) b.turnDurationMs = 30_000;
    out.push(b);
  }
  return out;
}

/** A Cursor state database with one main conversation of `n` bubbles and n/500 subagents of SUB_BUBBLES bubbles. */
function makeCursorDb(root: string, n: number): { dbPath: string; records: number } {
  const global = path.join(root, 'User', 'globalStorage');
  fs.mkdirSync(global, { recursive: true });
  fs.mkdirSync(path.join(root, 'User', 'workspaceStorage'), { recursive: true });
  const dbPath = path.join(global, 'state.vscdb');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER,
      isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT, subagentTypeName TEXT);
  `);
  const kv = db.prepare(`INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)`);
  const header = db.prepare(
    `INSERT OR REPLACE INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value, subagentTypeName)
     VALUES (?, 'ws-1', ?, ?, 0, ?, ?, NULL, ?, NULL)`,
  );
  const subCount = Math.max(1, Math.round(n / 500));
  const subs = Array.from({ length: subCount }, (_, k) => `bench-sub-${String(k).padStart(4, '0')}`);
  const dispatchAt = new Map<number, string>();
  subs.forEach((s, k) => {
    let at = Math.floor(((k + 0.5) * n) / subCount);
    if (at % TURN === 0) at += 1;
    dispatchAt.set(at, s);
  });
  let records = 0;
  const put = (id: string, bubbles: Bubble[], createdAt: number, isSub: boolean, extra: Record<string, unknown>): void => {
    const lastUpdatedAt = createdAt + bubbles.length * 1000;
    const value = {
      type: 'head',
      composerId: id,
      name: isSub ? null : 'Benchmark conversation',
      createdAt,
      lastUpdatedAt,
      unifiedMode: 'agent',
      isDraft: false,
      isArchived: false,
      workspaceIdentifier: { id: 'ws-1', uri: { fsPath: 'd:\\work\\bench', path: '/d:/work/bench', scheme: 'file' } },
    };
    header.run(id, createdAt, lastUpdatedAt, isSub ? 1 : 0, lastUpdatedAt, JSON.stringify(value));
    const list = bubbles.map((b) => ({ bubbleId: b.bubbleId, type: b.type, grouping: { kind: 'none' } }));
    for (let p = 0; p * 256 < list.length; p++) {
      kv.run(`composerConvHeaders:${id}:${String(p).padStart(6, '0')}`, Buffer.from(JSON.stringify(list.slice(p * 256, (p + 1) * 256))));
    }
    const data = {
      _v: 10,
      composerId: id,
      name: value.name,
      status: 'completed',
      createdAt,
      lastUpdatedAt,
      unifiedMode: 'agent',
      modelConfig: { modelName: 'synthetic-model' },
      fullConversationHeadersOnly: [],
      ...extra,
    };
    kv.run(`composerData:${id}`, Buffer.from(JSON.stringify(data)));
    for (const b of bubbles) kv.run(`bubbleId:${id}:${b.bubbleId}`, Buffer.from(JSON.stringify({ _v: 3, ...b, codebaseContextChunks: [], richText: '' })));
    records += bubbles.length + 1;
  };
  db.transaction(() => {
    put(MAIN, conversation('m', n, T0, 1, dispatchAt), T0, false, { subagentComposerIds: subs });
    subs.forEach((s, k) => {
      const at = [...dispatchAt].find(([, id]) => id === s)![0];
      put(s, conversation(`s${k}`, SUB_BUBBLES, T0 + at * 1000 + 10, 100 + k), T0 + at * 1000 + 10, true, {
        subagentInfo: { parentComposerId: MAIN, rootParentConversationId: MAIN, toolCallId: `call-${s}`, subagentTypeName: 'explore', subagentType: 1 },
      });
    });
  })();
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  return { dbPath, records };
}

/** Longest gap between ticks of a 5 ms interval timer: how long the event loop was blocked at a stretch. */
function stallMeter(): { stop: () => number } {
  let last = performance.now();
  let max = 0;
  const t = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last);
    last = now;
  }, 5);
  return {
    stop: () => {
      clearInterval(t);
      return max;
    },
  };
}

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function counts(dbPath: string): Record<string, number> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const one = (sql: string): number => db.prepare(sql).pluck().get() as number;
    return {
      raw: one(`SELECT COUNT(*) FROM raw_event`),
      nodes: one(`SELECT COUNT(*) FROM node`),
      edges: one(`SELECT COUNT(*) FROM edge`),
      changes: one(`SELECT COUNT(*) FROM change_log`),
      details: one(`SELECT COUNT(*) FROM node_detail`),
      sessions: one(`SELECT COUNT(*) FROM session`),
      lastSeq: (db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'change_log'`).pluck().get() as number | undefined) ?? 0,
    };
  } finally {
    db.close();
  }
}

interface RunResult {
  ms: number;
  stallMs: number;
  maxRequestMs: number;
  walPeakMb: number;
  bubbleReads: number;
}

/** One server run: store, pipeline, Cursor source, HTTP API; returns once the source's first round is done and ingested. */
async function run(config: Config, cursorDb: string): Promise<RunResult> {
  let bubbleReads = 0;
  const openDb = (p: string): DbResult<CursorDbReader> => {
    const r = openCursorDb(p);
    if (!r.ok) return r;
    const inner = r.value;
    return {
      ok: true,
      value: {
        headers: () => inner.headers(),
        composerData: (id) => inner.composerData(id),
        bubble: (id, b) => {
          bubbleReads += 1;
          return inner.bubble(id, b);
        },
        headerPages: (id) => inner.headerPages(id),
        close: () => inner.close(),
      },
    };
  };
  const t0 = performance.now();
  const store = openStore(config.dbPath);
  const source = new CursorSource({ dbPath: cursorDb, openDb, intervalMs: 3_600_000 });
  const pipeline = new Pipeline(store, config, { sources: [new ClaudeFileSource(config.projectsDir)], pollSources: [source] });
  const app = buildServer({ store, pipeline, config });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as { port: number };
  const meter = stallMeter();
  let walPeak = 0;
  const walTimer = setInterval(() => {
    walPeak = Math.max(walPeak, fileSize(`${config.dbPath}-wal`));
  }, 100);
  let maxRequestMs = 0;
  let polling = true;
  const requests = (async () => {
    while (polling) {
      const s = performance.now();
      const res = await fetch(`http://127.0.0.1:${port}/api/diagnostics`);
      await res.text();
      maxRequestMs = Math.max(maxRequestMs, performance.now() - s);
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  try {
    await pipeline.scanAll();
    while (source.status().lastPollAt === null) {
      if (source.status().lastError !== null) throw new Error(source.status().lastError!);
      await new Promise((r) => setTimeout(r, 20));
    }
    await pipeline.idle();
  } finally {
    polling = false;
    await requests;
    clearInterval(walTimer);
    walPeak = Math.max(walPeak, fileSize(`${config.dbPath}-wal`));
    await pipeline.close();
    await pipeline.idle();
    await app.close();
    store.close();
  }
  return { ms: performance.now() - t0, stallMs: meter.stop(), maxRequestMs, walPeakMb: walPeak / 1e6, bubbleReads };
}

describe.skipIf(!BENCH)('cursor import benchmark', () => {
  for (const n of SIZES) {
    test(
      `main conversation of ${n} bubbles`,
      async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bench-cursor-'));
        try {
          const cursor = makeCursorDb(path.join(tmp, 'cursor'), n);
          fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
          const config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null, cursorDbPath: null });
          fs.mkdirSync(config.dataDir, { recursive: true });

          const prof = process.env.CLAUDE_CANVAS_BENCH_PROF;
          const inspector = prof ? new Session() : null;
          if (inspector) {
            inspector.connect();
            await inspector.post('Profiler.enable');
            await inspector.post('Profiler.start');
          }
          const first = await run(config, cursor.dbPath);
          if (inspector) {
            const { profile } = await inspector.post('Profiler.stop');
            fs.writeFileSync(path.join(prof!, `first-${n}.cpuprofile`), JSON.stringify(profile));
            inspector.disconnect();
          }
          const afterFirst = counts(config.dbPath);
          const dbMb = fileSize(config.dbPath) / 1e6;

          const restart = await run(config, cursor.dbPath);
          const afterRestart = counts(config.dbPath);

          const store = openStore(config.dbPath);
          const r0 = performance.now();
          new Pipeline(store, config, { sources: [new ClaudeFileSource(config.projectsDir)] }).rebuild();
          const rebuildMs = performance.now() - r0;
          store.close();
          const afterRebuild = counts(config.dbPath);

          const line = {
            bubbles: n,
            records: cursor.records,
            firstImportS: +(first.ms / 1000).toFixed(1),
            recordsPerS: Math.round(cursor.records / (first.ms / 1000)),
            firstStallMs: Math.round(first.stallMs),
            firstMaxRequestMs: Math.round(first.maxRequestMs),
            walPeakMb: +first.walPeakMb.toFixed(1),
            dbMb: +dbMb.toFixed(1),
            changesPerRecord: +(afterFirst.lastSeq / afterFirst.raw).toFixed(2),
            ...afterFirst,
            restartS: +(restart.ms / 1000).toFixed(2),
            restartBubbleReads: restart.bubbleReads,
            restartStallMs: Math.round(restart.stallMs),
            restartNewRaw: afterRestart.raw - afterFirst.raw,
            restartNewChanges: afterRestart.lastSeq - afterFirst.lastSeq,
            rebuildS: +(rebuildMs / 1000).toFixed(1),
            rebuildNodes: afterRebuild.nodes,
            rebuildEdges: afterRebuild.edges,
          };
          console.log(`BENCH ${JSON.stringify(line)}`);
          expect(afterRebuild.nodes).toBe(afterFirst.nodes);
          expect(afterRebuild.edges).toBe(afterFirst.edges);
          if (ASSERT) {
            if (n >= 20_000) expect(first.ms).toBeLessThan(60_000);
            expect(first.stallMs).toBeLessThan(200);
            expect(restart.ms).toBeLessThan(5_000);
            expect(afterRestart.raw).toBe(afterFirst.raw);
            expect(afterRestart.lastSeq).toBe(afterFirst.lastSeq);
          }
        } finally {
          await new Promise((r) => setTimeout(r, 500)); // the checkpointer worker closes its handle asynchronously
          await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 20 }).catch(() => undefined);
        }
      },
      3_600_000,
    );
  }
});
