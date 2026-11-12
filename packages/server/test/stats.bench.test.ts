import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import type { Change, GraphNode, Origin, Session } from '@agent-canvas/shared';
import { StatsService, storeStatsSource, type StatsSource } from '../src/stats/service.js';
import { summarizeSession } from '../src/stats/summary.js';
import { openStore } from '../src/store/store.js';

/*
 * Benchmark of GET /api/stats's computation on temp databases: (1) about 200,000 derived nodes in 40 sessions (one large
 * session of 40,000 nodes, 39 of about 4,100), (2) 3,000 small sessions (about 250,000 nodes): the first request (every
 * summary built), a request after one session changed (only it re-read), and a request with nothing changed (a filter
 * switch, no session read). Reports wall time and the longest event-loop stall during each.
 *
 * Skipped by default. Run:
 *   AGENT_CANVAS_BENCH=1 npx --yes pnpm@10 vitest run packages/server/test/stats.bench.test.ts
 * Hard limits (only with AGENT_CANVAS_BENCH_ASSERT=1): first request < 3 s, after a change < 1 s.
 */

const BENCH = process.env.AGENT_CANVAS_BENCH === '1';
const ASSERT = process.env.AGENT_CANVAS_BENCH_ASSERT === '1';
const T0 = Date.parse('2026-10-01T08:00:00.000Z');
const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const TURN = 60;
const TOOLS = ['Bash', 'Read', 'Edit', 'Grep', 'Glob', 'Write'];
const ORIGIN_OF: Origin[] = ['claude', 'codex', 'cursor'];

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

const iso = (ms: number): string => new Date(ms).toISOString();

function sessionChanges(index: number, count: number, startMs?: number): Change[] {
  const r = rng(index + 1);
  const id = `bench-s${String(index).padStart(3, '0')}`;
  const origin = ORIGIN_OF[index % 3]!;
  const start = startMs ?? T0 + index * 24 * 3600_000;
  const nodes: GraphNode[] = [];
  let turnId = '';
  let agent: string | null = null;
  for (let i = 0; i < count; i++) {
    const at = start + i * 2000;
    const pos = i % TURN;
    if (pos === 0) turnId = `${id}-turn${i}`;
    if (pos === 10) agent = r() < 0.3 ? `${id}-ag${i}` : null;
    if (pos === 40) agent = null;
    const inner = agent !== null && pos > 10 && pos < 40;
    const kind = pos === 0 ? 'prompt' : pos === 10 && agent !== null ? 'subagent' : r() < 0.5 ? 'tool' : r() < 0.5 ? 'text' : 'thinking';
    const call = kind === 'tool' || kind === 'subagent';
    const status = call ? (r() < 0.08 ? 'failed' : 'succeeded') : null;
    nodes.push({
      id: `${id}-n${i}`, sessionId: id, turnId: inner ? null : turnId, agentId: inner ? agent : null, parentId: null, kind,
      status, timestamp: iso(at), confirmed: true, title: kind, summary: 'x'.repeat(120),
      toolName: kind === 'tool' ? TOOLS[Math.floor(r() * TOOLS.length)]! : kind === 'subagent' ? 'Task' : null,
      toolUseId: call ? `${id}-tu${i}` : null, messageId: `${id}-m${Math.floor(i / 3)}`,
      durationMs: call ? Math.floor(r() * 5000) : null, endedAt: call ? iso(at + 1500) : null,
      usage: origin !== 'cursor' && kind === 'text' ? { inputTokens: 1000, outputTokens: 200 } : null,
      systemSubtype: null, childAgentId: kind === 'subagent' ? agent : null,
    });
  }
  const session: Session = {
    id, projectId: `proj-${index % 7}`, origin, cwd: null, title: null, gitBranch: null, status: 'idle', sourceDeleted: false,
    startedAt: iso(start), lastActivityAt: iso(start + count * 2000),
  };
  return [{ type: 'session_upserted', session }, ...nodes.map((node): Change => ({ type: 'node_added', node, detail: {} }))];
}

/** Runs `fn` while measuring the longest gap between event-loop turns (a 1 ms interval timer). */
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

/** The store source, counting session reads. */
function countingSource(store: ReturnType<typeof openStore>): { source: StatsSource; reads: () => number } {
  const base = storeStatsSource(store);
  let reads = 0;
  return {
    source: { ...base, readSession: (id) => { reads++; return base.readSession(id); } },
    reads: () => reads,
  };
}

/** Adds one main-thread tool call to `sessionId`'s first turn; returns the committed changes. */
function oneMoreCall(store: ReturnType<typeof openStore>, sessionId: string): ReturnType<typeof store.applyChanges> {
  const first = store.nodePage(sessionId, null, 1)[0]!.node;
  return store.applyChanges([{
    type: 'node_added',
    node: { ...first, id: `${sessionId}-extra`, kind: 'tool', status: 'succeeded', toolName: 'Bash', agentId: null, turnId: `${sessionId}-turn0`, timestamp: iso(NOW - 1000) },
    detail: {},
  }]);
}

describe.skipIf(!BENCH)('stats benchmark', () => {
  test('200,000 nodes in 40 sessions: first request, after one change, unchanged', { timeout: 600_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-stats-bench-'));
    const store = openStore(path.join(dir, 'bench.db'));
    try {
      let total = 0;
      for (let i = 0; i < 40; i++) {
        const count = i === 0 ? 40_000 : 4_100;
        store.applyChanges(sessionChanges(i, count));
        total += count;
      }
      const { source, reads } = countingSource(store);
      const svc = new StatsService(source, { now: () => NOW });
      const first = await measured(() => svc.get({ range: 'all', origin: null, projectId: null }));
      svc.noteChanges(oneMoreCall(store, 'bench-s005'));
      const readsBefore = reads();
      const second = await measured(() => svc.get({ range: 'all', origin: null, projectId: null }));
      const changedReads = reads() - readsBefore;
      const third = await measured(() => svc.get({ range: '30d', origin: 'claude', projectId: null }));
      // The largest session on its own (paged read + summarize), for the in-session stall.
      const big = await measured(async () => {
        const fresh = new StatsService({ ...storeStatsSource(store), sessions: () => [store.getSession('bench-s000')!] });
        return fresh.get({ range: 'all', origin: null, projectId: null });
      });
      let t = performance.now();
      const read = (await storeStatsSource(store).readSession('bench-s000'))!;
      const readMs = performance.now() - t;
      t = performance.now();
      summarizeSession(read.session, read.nodes);
      const summarizeMs = performance.now() - t;
      console.log(
        `stats benchmark, ${total} nodes / 40 sessions, ${first.result.totals.toolCalls} tool calls, ${first.result.totals.turns} turns\n` +
          `  ${line('first request', first)}\n  ${line(`after one session changed (${changedReads} session read)`, second)}\n` +
          `  ${line(`unchanged (filter switch, ${reads() - readsBefore - changedReads} session reads)`, third)}\n` +
          `  ${line('largest session alone (40,000 nodes)', big)}\n` +
          `  largest session split: paged read ${readMs.toFixed(0)} ms (yields between pages), summarize ${summarizeMs.toFixed(0)} ms`,
      );
      expect(second.result.totals.toolCalls).toBe(first.result.totals.toolCalls + 1);
      expect(changedReads).toBe(1);
      if (ASSERT) {
        expect(first.ms).toBeLessThan(3000);
        expect(second.ms).toBeLessThan(1000);
      }
    } finally {
      store.close();
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20 }).catch(() => undefined);
    }
  });

  test('3,000 small sessions: first request, unchanged, after one change', { timeout: 600_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-stats-bench-'));
    const store = openStore(path.join(dir, 'bench.db'));
    try {
      let total = 0;
      for (let i = 0; i < 3000; i++) {
        const count = 60 + (i % 5) * 12; // 60–108 nodes: one or two turns each
        // Spread over the 25 days before NOW.
        store.applyChanges(sessionChanges(i, count, NOW - 25 * 24 * 3600_000 + (i % 25) * 24 * 3600_000 + i * 1000));
        total += count;
      }
      const { source, reads } = countingSource(store);
      const svc = new StatsService(source, { now: () => NOW });
      const first = await measured(() => svc.get({ range: 'all', origin: null, projectId: null }));
      const afterFirst = reads();
      const unchanged = await measured(() => svc.get({ range: '30d', origin: 'codex', projectId: null }));
      const unchangedReads = reads() - afterFirst;
      svc.noteChanges(oneMoreCall(store, 'bench-s1234'));
      const changed = await measured(() => svc.get({ range: 'all', origin: null, projectId: null }));
      const changedReads = reads() - afterFirst - unchangedReads;
      console.log(
        `stats benchmark, ${total} nodes / 3000 sessions, ${first.result.totals.toolCalls} tool calls\n` +
          `  ${line('first request', first)}\n  ${line(`unchanged (filter switch, ${unchangedReads} session reads)`, unchanged)}\n` +
          `  ${line(`after one session changed (${changedReads} session read)`, changed)}`,
      );
      expect(first.result.totals.sessions).toBe(3000);
      expect(unchangedReads).toBe(0);
      expect(changedReads).toBe(1);
    } finally {
      store.close();
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20 }).catch(() => undefined);
    }
  });

  // The shape of the real dataset measured on 2026-11-12: 36 sessions, about 214,000 nodes (four of 30–40k nodes),
  // about 120,000 tool calls. Reports where a cold request's time goes (SQL + JSON parse, summaries, aggregation).
  test('real shape: 36 sessions / 214,000 nodes: cold request split', { timeout: 600_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-stats-bench-'));
    const store = openStore(path.join(dir, 'bench.db'));
    try {
      const sizes = [40_000, 38_000, 34_000, 30_000, ...Array.from({ length: 32 }, () => 2_250)];
      let total = 0;
      sizes.forEach((count, i) => {
        store.applyChanges(sessionChanges(i, count, NOW - 40 * 24 * 3600_000 + i * 24 * 3600_000));
        total += count;
      });
      const src = storeStatsSource(store);
      const ids = src.sessions().map((x) => x.id);
      let readMs = 0;
      let summarizeMs = 0;
      const t0 = performance.now();
      for (const id of ids) {
        let t = performance.now();
        const read = (await src.readSession(id))!;
        readMs += performance.now() - t;
        t = performance.now();
        summarizeSession(read.session, read.nodes);
        summarizeMs += performance.now() - t;
      }
      const splitMs = performance.now() - t0;
      // The SQL alone (no JSON parse), on a second connection, for the split.
      const raw = new Database(path.join(dir, 'bench.db'), { readonly: true });
      const page = raw.prepare('SELECT id, body FROM node WHERE session_id = ? AND id > ? ORDER BY id LIMIT ?');
      let t = performance.now();
      let bytes = 0;
      for (const id of ids) {
        for (let after = ''; ;) {
          const rows = page.all(id, after, 5000) as { id: string; body: string }[];
          for (const r of rows) bytes += r.body.length;
          if (rows.length < 5000) break;
          after = rows[rows.length - 1]!.id;
        }
      }
      const sqlMs = performance.now() - t;
      // Only the fields a summary needs, extracted in SQL (one JSON parse per body in SQLite), then parsed in JS.
      const FIELDS = ['id', 'agentId', 'turnId', 'kind', 'status', 'timestamp', 'endedAt', 'durationMs', 'childAgentId', 'toolName', 'messageId', 'usage'];
      const slim = raw.prepare(`SELECT id, json_extract(body, ${FIELDS.map((f) => `'$.${f}'`).join(', ')}) AS f FROM node WHERE session_id = ? AND id > ? ORDER BY id LIMIT ?`);
      t = performance.now();
      let slimRows = 0;
      for (const id of ids) {
        for (let after = ''; ;) {
          const rows = slim.all(id, after, 5000) as { id: string; f: string }[];
          for (const r of rows) { JSON.parse(r.f); slimRows++; }
          if (rows.length < 5000) break;
          after = rows[rows.length - 1]!.id;
        }
      }
      const slimMs = performance.now() - t;
      raw.close();
      const svc = new StatsService(storeStatsSource(store), { now: () => NOW });
      const cold = await measured(() => svc.get({ range: 'all', origin: null, projectId: null }));
      const warm = await measured(() => svc.get({ range: 'all', origin: null, projectId: null }));
      console.log(
        `stats benchmark, real shape: ${total} nodes / ${sizes.length} sessions, ${cold.result.totals.toolCalls} tool calls, ` +
          `${(bytes / 1e6).toFixed(0)} MB of node bodies
` +
          `  ${line('cold request (all)', cold)}
  ${line('warm request (all)', warm)}
` +
          `  split over all sessions (${splitMs.toFixed(0)} ms): read ${readMs.toFixed(0)} ms (SQL alone ${sqlMs.toFixed(0)} ms), ` +
          `summarize ${summarizeMs.toFixed(0)} ms; slim read (SQL json_extract + parse, ${slimRows} rows) ${slimMs.toFixed(0)} ms`,
      );
    } finally {
      store.close();
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20 }).catch(() => undefined);
    }
  });
});
