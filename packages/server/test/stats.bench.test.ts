import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, test } from 'vitest';
import type { Change, GraphNode, Origin, Session } from '@agent-canvas/shared';
import { StatsService, storeStatsSource } from '../src/stats/service.js';
import { summarizeSession } from '../src/stats/summary.js';
import { openStore } from '../src/store/store.js';

/*
 * Benchmark of GET /api/stats's computation on a temp database of about 200,000 derived nodes in 40 sessions (one large
 * session of 40,000 nodes, 39 of about 4,100): the first request (every summary built), a request after one session
 * changed (only it rebuilt), and a request with nothing changed (a filter switch). Reports wall time and the longest
 * event-loop stall during each.
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

function sessionChanges(index: number, count: number): Change[] {
  const r = rng(index + 1);
  const id = `bench-s${String(index).padStart(3, '0')}`;
  const origin = ORIGIN_OF[index % 3]!;
  const start = T0 + index * 24 * 3600_000;
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
      const svc = new StatsService(storeStatsSource(store), { now: () => NOW });
      const first = await measured(() => svc.get({ range: 'all', origin: null, projectId: null }));
      const changed = store.applyChanges([{
        type: 'node_added',
        node: {
          ...(store.getGraph('bench-s005')!.nodes[0]!), id: 'bench-extra', kind: 'tool', status: 'succeeded', toolName: 'Bash',
          agentId: null, turnId: 'bench-s005-turn0', timestamp: iso(NOW - 1000),
        },
        detail: {},
      }]);
      svc.noteChanges(changed);
      const second = await measured(() => svc.get({ range: 'all', origin: null, projectId: null }));
      const third = await measured(() => svc.get({ range: '30d', origin: 'claude', projectId: null }));
      // The largest session on its own (read + summarize), for the in-session stall.
      const big = await measured(async () => {
        const fresh = new StatsService({ ...storeStatsSource(store), sessions: () => [store.getSession('bench-s000')!] });
        return fresh.get({ range: 'all', origin: null, projectId: null });
      });
      let t = performance.now();
      const graph = store.getGraph('bench-s000')!;
      const readMs = performance.now() - t;
      t = performance.now();
      summarizeSession(graph.session, graph.nodes);
      const summarizeMs = performance.now() - t;
      console.log(`  largest session split: read ${readMs.toFixed(0)} ms, summarize ${summarizeMs.toFixed(0)} ms`);
      const line = (name: string, m: { ms: number; stallMs: number }): string =>
        `${name}: ${m.ms.toFixed(0)} ms (longest stall ${m.stallMs.toFixed(0)} ms)`;
      console.log(
        `stats benchmark, ${total} nodes / 40 sessions, ${first.result.totals.toolCalls} tool calls, ${first.result.totals.turns} turns\n` +
          `  ${line('first request', first)}\n  ${line('after one session changed', second)}\n` +
          `  ${line('unchanged (filter switch)', third)}\n  ${line('largest session alone (40,000 nodes)', big)}`,
      );
      expect(second.result.totals.toolCalls).toBe(first.result.totals.toolCalls + 1);
      if (ASSERT) {
        expect(first.ms).toBeLessThan(3000);
        expect(second.ms).toBeLessThan(1000);
      }
    } finally {
      store.close();
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20 }).catch(() => undefined);
    }
  });
});
