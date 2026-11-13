import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import type { Change, GraphNode, NodeDetail } from '@agent-canvas/shared';
import { SEARCH_BUILD_BATCH_BYTES, SEARCH_BUILD_BATCH_ROWS, indexTextOf, type SearchIndexDetail } from '../src/store/search-index.js';
import { openStore } from '../src/store/store.js';

/*
 * Benchmark of the content search index at the real shape: about 215,000 nodes in 2,150 sessions, index text about
 * 150 MB (short prompts and replies, thinking, tool calls with inputs and outputs, some of them large; 15% of the
 * texts Chinese), written straight through Store.applyChanges (one call per session, as a rebuild does).
 *
 * For each detail level (full, column, none) it reports: ingest time with the index maintained versus without it
 * (`off`: same store, no index rows), the per-node overhead; the index size on disk (dbstat of search_fts*); the
 * background build time over the unindexed database and its longest batch (event-loop stall); query times (first run
 * and median of 5) for a rare term, a common term (thousands of matches), a very common one (tens of thousands), a CJK
 * term, a path-like term and a 2-character term, with the number of candidates the index gave; the cost of one node
 * updated 2,000 times; the open-time consistency check.
 *
 * The filler text is cut from this repository's own sources (code, paths, comments); Chinese texts are built from a
 * small word list. Synthetic only.
 *
 * Skipped by default. Run:
 *   AGENT_CANVAS_BENCH=1 npx --yes pnpm@10 vitest run packages/server/test/search.bench.test.ts
 * Nodes (default 215000): AGENT_CANVAS_BENCH_SEARCH_NODES; detail levels (default full,column,none):
 * AGENT_CANVAS_BENCH_SEARCH_MODES; temp directory (about 1 GB per database): AGENT_CANVAS_BENCH_TMP.
 */

const BENCH = process.env.AGENT_CANVAS_BENCH === '1';
const NODES = Number(process.env.AGENT_CANVAS_BENCH_SEARCH_NODES ?? '215000');
const MODES = (process.env.AGENT_CANVAS_BENCH_SEARCH_MODES ?? 'full,column,none').split(',') as SearchIndexDetail[];
const NODES_PER_SESSION = 100;
const DAY = 24 * 60 * 60 * 1000;
const END = Date.parse('2026-11-13T00:00:00.000Z');

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

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
function sources(): { text: string; files: string[] } {
  const out: string[] = [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'test') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) {
        out.push(fs.readFileSync(p, 'utf8'));
        files.push(`D:/work/agent-canvas/${path.relative(SRC, p).split(path.sep).join('/')}`);
      }
    }
  };
  walk(SRC);
  return { text: out.join('\n'), files };
}

const CJK_WORDS = (
  '我们 你们 这个 那个 已经 可以 需要 应该 因为 所以 但是 如果 然后 现在 之前 之后 问题 方法 函数 文件 目录 数据 数据库 ' +
  '服务 页面 接口 测试 结果 错误 报错 日志 配置 修改 删除 添加 检查 运行 构建 部署 版本 分支 提交 合并 会话 节点 工具 ' +
  '输出 输入 检索 索引 压缩 迁移 重建 性能 时间 内存 磁盘 空间 用户 系统 网络 请求 返回 参数 类型 字段 一下 看看 处理'
).split(' ');

interface Planted { rare: number; common: number; cjk: number }

/** One session's changes (one applyChanges call). Deterministic per session index. */
function sessionChanges(s: number, src: { text: string; files: string[] }, planted: Planted): { changes: Change[]; nodes: number } {
  const r = rng(1000 + s);
  const slice = (n: number): string => {
    const at = Math.floor(r() * (src.text.length - n - 1));
    return src.text.slice(at, at + n);
  };
  const between = (lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo));
  const chinese = (bytes: number): string => {
    const words: string[] = [];
    let n = 0;
    while (n < bytes) {
      const w = CJK_WORDS[Math.floor(r() * CJK_WORDS.length)]!;
      words.push(w);
      n += Buffer.byteLength(w) + 1;
      if (r() < 0.1) words.push('，');
    }
    if (r() < 0.05) {
      words.splice(Math.floor(r() * words.length), 0, '检索索引');
      planted.cjk += 1;
    }
    return words.join('');
  };
  const plant = (t: string): string => {
    if (r() < 1 / 10_000) {
      planted.rare += 1;
      return `${t} zqxv-rare-marker ${slice(20)}`;
    }
    if (r() < 1 / 40) {
      planted.common += 1;
      return `${slice(30)} common-planted-term ${t}`;
    }
    return t;
  };
  const id = `bench-${String(s).padStart(5, '0')}`;
  const last = END - Math.floor(r() * 180 * DAY);
  const count = Math.min(NODES_PER_SESSION, NODES - s * NODES_PER_SESSION);
  let t = last - count * 60_000;
  const changes: Change[] = [
    {
      type: 'session_upserted',
      session: {
        id, projectId: `D--work-p${s % 20}`, origin: s % 3 === 0 ? 'cursor' : s % 3 === 1 ? 'codex' : 'claude', cwd: 'D:\\work\\p',
        title: slice(40), gitBranch: 'main', status: 'idle', sourceDeleted: false, startedAt: new Date(t).toISOString(),
        lastActivityAt: new Date(last).toISOString(),
      },
    },
  ];
  for (let i = 0; i < count; i++) {
    t += 60_000;
    const k = r();
    const kind: GraphNode['kind'] = k < 0.08 ? 'prompt' : k < 0.33 ? 'text' : k < 0.45 ? 'thinking' : 'tool';
    let detail: Partial<NodeDetail>;
    let toolName: string | null = null;
    if (kind === 'tool') {
      const file = src.files[Math.floor(r() * src.files.length)]!;
      const which = r();
      toolName = which < 0.4 ? 'Bash' : which < 0.7 ? 'Read' : which < 0.9 ? 'Edit' : 'Grep';
      const input =
        toolName === 'Bash'
          ? { command: plant(`cd D:/work/agent-canvas && ${slice(between(30, 300))}`), description: slice(between(10, 60)) }
          : toolName === 'Read'
            ? { file_path: file }
            : toolName === 'Edit'
              ? { file_path: file, old_string: slice(between(20, 200)), new_string: slice(between(20, 200)) }
              : { pattern: slice(between(5, 30)), path: file };
      const big = r() < 0.08;
      const output = big ? slice(between(2000, 8000)) + slice(between(0, 12_000)) : plant(slice(between(0, 600)));
      detail = { input, output };
    } else {
      const lim = kind === 'prompt' ? [50, 800] : kind === 'text' ? [100, 1200] : [100, 1000];
      const body = r() < 0.15 ? chinese(between(lim[0]!, lim[1]!)) : slice(between(lim[0]!, lim[1]!));
      detail = { text: plant(body) };
    }
    const node: GraphNode = {
      id: `${id}-n${i}`, sessionId: id, turnId: null, agentId: r() < 0.1 ? 'agent-x' : null, childAgentId: null, parentId: null, kind,
      status: kind === 'tool' ? 'succeeded' : null, timestamp: new Date(t).toISOString(), confirmed: true,
      title: kind === 'tool' ? toolName! : kind, summary: (detail.text ?? JSON.stringify(detail.input) ?? '').replace(/\s+/g, ' ').slice(0, 199),
      toolName, toolUseId: null, messageId: null, durationMs: null, endedAt: null, usage: null, systemSubtype: null,
    };
    changes.push({ type: 'node_added', node, detail });
  }
  return { changes, nodes: count };
}

const sessionsCount = Math.ceil(NODES / NODES_PER_SESSION);
const MB = (b: number): string => `${(b / 1024 / 1024).toFixed(1)} MB`;
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function ingest(dbPath: string, detail: SearchIndexDetail | 'off', src: ReturnType<typeof sources>, measureText: boolean): Promise<{ ms: number; textBytes: number; planted: Planted }> {
  const store = openStore(dbPath, { searchDetail: detail });
  const planted: Planted = { rare: 0, common: 0, cjk: 0 };
  let textBytes = 0;
  let ms = 0;
  try {
    for (let s = 0; s < sessionsCount; s++) {
      if (s % 50 === 0) await new Promise((resolve) => setImmediate(resolve)); // keeps vitest's worker RPC alive
      const { changes } = sessionChanges(s, src, planted);
      if (measureText) {
        for (const c of changes) if (c.type === 'node_added') textBytes += Buffer.byteLength(indexTextOf(c.node, c.detail ?? {}));
      }
      const t0 = performance.now();
      store.applyChanges(changes);
      ms += performance.now() - t0;
    }
  } finally {
    store.close();
  }
  return { ms, textBytes, planted };
}

function indexSize(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(`SELECT COALESCE(SUM(pgsize), 0) FROM dbstat WHERE name LIKE 'search_fts%'`).pluck().get() as number;
  } finally {
    db.close();
  }
}

const QUERIES: [string, string][] = [
  ['rare 3+ chars', 'zqxv-rare-marker'],
  ['common (thousands)', 'common-planted-term'],
  ['very common', 'function'],
  ['CJK', '检索索引'],
  ['path-like', 'server/src/store/store.ts'],
  ['2 characters', '索引'],
  // long queries: every trigram is common (detail none / column: an AND of ~100 trigrams)
  ['long, present', 'Texts shorter than this many UTF-8 bytes are stored as they are (compression would gain little, cost a call).'],
  ['long, absent', 'the session and the store of the node are not the same as the state of the index in this test'],
];

function queries(dbPath: string, detail: SearchIndexDetail): string[] {
  const store = openStore(dbPath, { searchDetail: detail });
  const raw = new Database(dbPath, { readonly: true });
  const lines: string[] = [];
  try {
    for (const [label, q] of QUERIES) {
      const times: number[] = [];
      let result = store.searchContent(q, { nowMs: END });
      for (let i = 0; i < 6; i++) {
        const t0 = performance.now();
        result = store.searchContent(q, { nowMs: END });
        times.push(performance.now() - t0);
      }
      let candidates = '-';
      let matchMs = '-';
      if (Array.from(q).length >= 3) {
        const expr = detail === 'full' ? `"${q}"` : [...new Set(Array.from({ length: Array.from(q).length - 2 }, (_, i) => Array.from(q).slice(i, i + 3).join('')))].map((x) => `"${x}"`).join(' AND ');
        const t0 = performance.now();
        candidates = String(raw.prepare(`SELECT COUNT(*) FROM search_fts WHERE search_fts MATCH ?`).pluck().get(expr));
        matchMs = (performance.now() - t0).toFixed(1);
      }
      lines.push(
        `  ${label.padEnd(20)} ${JSON.stringify(q).padEnd(28)} first ${times[0]!.toFixed(1).padStart(7)} ms, median ${median(times.slice(1)).toFixed(1).padStart(7)} ms; ` +
          `hits ${String(result.hits.length).padStart(3)} in ${new Set(result.hits.map((h) => h.sessionId)).size} sessions, truncated ${result.truncated}; candidates ${candidates} (match ${matchMs} ms)`,
      );
    }
  } finally {
    raw.close();
    store.close();
  }
  return lines;
}

function build(dbPath: string, detail: SearchIndexDetail): { ms: number; maxBatchMs: number; batches: number } {
  const db = new Database(dbPath);
  db.exec(`DROP TABLE IF EXISTS search_fts; DELETE FROM meta WHERE key LIKE 'search_index%'`);
  db.close();
  const store = openStore(dbPath, { searchDetail: detail });
  let maxBatchMs = 0;
  let batches = 0;
  const t0 = performance.now();
  try {
    for (;;) {
      const b0 = performance.now();
      const { more } = store.searchIndexBatch(SEARCH_BUILD_BATCH_ROWS, SEARCH_BUILD_BATCH_BYTES);
      maxBatchMs = Math.max(maxBatchMs, performance.now() - b0);
      batches += 1;
      if (!more) break;
    }
  } finally {
    store.close();
  }
  return { ms: performance.now() - t0, maxBatchMs, batches };
}

function repeatedUpdates(dbPath: string, detail: SearchIndexDetail): string {
  const store = openStore(dbPath, { searchDetail: detail });
  try {
    const before = indexSizeLive(dbPath);
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) {
      store.applyChanges([{ type: 'node_updated', sessionId: 'bench-00000', id: 'bench-00000-n0', patch: {}, detail: { text: `streamed ${i} ${'word '.repeat(400)}` } }]);
    }
    const ms = performance.now() - t0;
    return `  2,000 updates of one node (2 KB text): ${(ms / 2000).toFixed(2)} ms each; index ${MB(before)} -> ${MB(indexSizeLive(dbPath))}`;
  } finally {
    store.close();
  }
}

function indexSizeLive(dbPath: string): number {
  return indexSize(dbPath);
}

describe.skipIf(!BENCH)('search index benchmark', () => {
  test(
    'index size, build, ingest overhead and query times per detail level',
    async () => {
      const dir = fs.mkdtempSync(path.join(process.env.AGENT_CANVAS_BENCH_TMP ?? os.tmpdir(), 'cc-search-bench-'));
      const src = sources();
      const out: string[] = [`search benchmark: ${NODES} nodes in ${sessionsCount} sessions; corpus ${MB(src.text.length)} from ${src.files.length} files`];
      try {
        const offPath = path.join(dir, 'off.db');
        const off = await ingest(offPath, 'off', src, true);
        out.push(`index text ${MB(off.textBytes)} (avg ${(off.textBytes / NODES).toFixed(0)} B/node); planted rare ${off.planted.rare}, common ${off.planted.common}, CJK ${off.planted.cjk}`);
        out.push(`ingest without index: ${(off.ms / 1000).toFixed(1)} s (${((off.ms * 1000) / NODES).toFixed(0)} µs/node); file ${MB(fs.statSync(offPath).size)}`);
        for (const detail of MODES) {
          const p = path.join(dir, `${detail}.db`);
          const on = await ingest(p, detail, src, false);
          const size = indexSize(p);
          out.push(`detail=${detail}: index ${MB(size)}; ingest ${(on.ms / 1000).toFixed(1)} s (+${(((on.ms - off.ms) * 1000) / NODES).toFixed(0)} µs/node, ${(on.ms / off.ms).toFixed(2)}x)`);
          const t0 = performance.now();
          openStore(p, { searchDetail: detail }).close();
          const t1 = performance.now();
          openStore(p, { searchDetail: detail }).close();
          out.push(`  open (incl. consistency check): first ${(t1 - t0).toFixed(0)} ms, again ${(performance.now() - t1).toFixed(0)} ms`);
          out.push(...queries(p, detail));
          out.push(repeatedUpdates(p, detail));
          // The store's checkpointer thread lets go of the file shortly after close.
          for (const f of [p, `${p}-wal`, `${p}-shm`]) await fs.promises.rm(f, { force: true, maxRetries: 20 });
          const b = build(offPath, detail);
          out.push(`  background build over the unindexed database: ${(b.ms / 1000).toFixed(1)} s in ${b.batches} batches, longest batch ${b.maxBatchMs.toFixed(0)} ms; index ${MB(indexSize(offPath))}`);
        }
      } finally {
        console.log(out.join('\n'));
        await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20 });
      }
      expect(out.length).toBeGreaterThan(1);
    },
    4 * 60 * 60 * 1000,
  );
});
