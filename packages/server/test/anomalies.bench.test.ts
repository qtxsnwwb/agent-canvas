import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, test } from 'vitest';
import { costAnomalies, costBaseline, type Change, type GraphNode, type Origin, type Session, type TurnCost } from '@agent-canvas/shared';
import { AnomaliesService } from '../src/anomalies/service.js';
import { summarizeAnomalies } from '../src/anomalies/summary.js';
import { FilesService } from '../src/files/service.js';
import { StatsService, storeStatsSource, type StatsSource } from '../src/stats/service.js';
import { openStore } from '../src/store/store.js';

/*
 * Benchmark of the anomaly service on a temp database shaped like the real one (spec section 2): about 217,000 derived
 * nodes in 37 sessions, one of them 100,000 nodes, about 5,800 turns, with loops and failure streaks sprinkled in.
 * Reports: the start-up warm-up (stats, files, then anomalies, reads shared) and a cold anomaly build alone, each with the
 * longest event-loop stall; a request after one session changed (only it re-read); a request with nothing changed; one
 * full cost re-derivation over every turn; one background recompute of the 100,000-node session.
 *
 * Skipped by default. Run:
 *   AGENT_CANVAS_BENCH=1 npx --yes pnpm@10 vitest run packages/server/test/anomalies.bench.test.ts
 * Hard limits (only with AGENT_CANVAS_BENCH_ASSERT=1): unchanged request < 50 ms, after a change < 1 s.
 */

const BENCH = process.env.AGENT_CANVAS_BENCH === '1';
const ASSERT = process.env.AGENT_CANVAS_BENCH_ASSERT === '1';
const T0 = Date.parse('2026-09-01T08:00:00.000Z');
const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const TURN = 37;
const TOOLS = ['Bash', 'Read', 'Edit', 'Grep', 'Glob', 'Write'];
const ORIGIN_OF: Origin[] = ['claude', 'codex', 'cursor'];

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
const hex = (n: number): string => n.toString(16).padStart(16, '0');

function sessionChanges(index: number, count: number): Change[] {
  const r = rng(index + 1);
  const id = `bench-s${String(index).padStart(3, '0')}`;
  const origin = ORIGIN_OF[index % 3]!;
  const start = T0 + index * 36 * 3600_000;
  const nodes: GraphNode[] = [];
  let turnId = '';
  let agent: string | null = null;
  /** This turn's pattern: 0 normal, 1 a loop (the same failing call), 2 a failure streak. */
  let pattern = 0;
  for (let i = 0; i < count; i++) {
    const at = start + i * 2000;
    const pos = i % TURN;
    if (pos === 0) {
      turnId = `${id}-turn${i}`;
      const x = r();
      pattern = x < 0.01 ? 1 : x < 0.015 ? 2 : 0;
    }
    if (pos === 8) agent = r() < 0.3 ? `${id}-ag${i}` : null;
    if (pos === 25) agent = null;
    const inner = agent !== null && pos > 8 && pos < 25;
    const kind = pos === 0 ? 'prompt' : pos === 8 && agent !== null ? 'subagent' : r() < 0.6 ? 'tool' : r() < 0.5 ? 'text' : 'thinking';
    const call = kind === 'tool' || kind === 'subagent';
    let status: GraphNode['status'] = call ? (r() < 0.08 ? 'failed' : 'succeeded') : null;
    let key = call ? hex(Math.floor(r() * 2 ** 40)) : undefined;
    if (call && !inner && pattern !== 0 && pos >= 26 && pos <= 32) {
      status = 'failed';
      if (pattern === 1) key = hex(index * 100_000 + i - pos);
    }
    const toolName = kind === 'tool' ? (pattern === 1 && pos >= 26 && pos <= 32 ? 'Bash' : TOOLS[Math.floor(r() * TOOLS.length)]!) : kind === 'subagent' ? 'Task' : null;
    const node: GraphNode = {
      id: `${id}-n${i}`, sessionId: id, turnId: inner ? null : turnId, agentId: inner ? agent : null, parentId: null, kind,
      status, timestamp: iso(at), confirmed: true, title: kind, summary: 'x'.repeat(120), toolName,
      toolUseId: call ? `${id}-tu${i}` : null, messageId: `${id}-m${Math.floor(i / 3)}`,
      durationMs: call ? Math.floor(r() * 5000) : kind === 'thinking' ? 800 : null, endedAt: call ? iso(at + 1500) : null,
      usage: origin !== 'cursor' && kind === 'text' ? { inputTokens: 1000, outputTokens: 200 } : null,
      systemSubtype: null, childAgentId: kind === 'subagent' ? agent : null,
    };
    if (key !== undefined) node.inputKey = key;
    if (toolName === 'Edit' && status === 'succeeded') node.files = [{ path: `/w/${id}/f${Math.floor(r() * 3)}.ts`, action: 'edit' }];
    nodes.push(node);
  }
  const session: Session = {
    id, projectId: `proj-${index % 5}`, origin, cwd: null, title: null, gitBranch: null, status: 'idle', sourceDeleted: false,
    startedAt: iso(start), lastActivityAt: iso(start + count * 2000),
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

describe.skipIf(!BENCH)('anomalies benchmark', () => {
  test('217,000 nodes / 37 sessions (one of 100,000)', { timeout: 900_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-anomalies-bench-'));
    const store = openStore(path.join(dir, 'bench.db'));
    try {
      let total = 0;
      for (let i = 0; i < 37; i++) {
        const count = i === 0 ? 100_000 : 3_250;
        store.applyChanges(sessionChanges(i, count));
        total += count;
      }
      let reads = 0;
      const base = storeStatsSource(store);
      const counting: StatsSource = { ...base, readSession: (id, stopped) => { reads++; return base.readSession(id, stopped); } };

      // Start-up warm-up as start() runs it: stats (sharing reads with files), files, anomalies (its own reads).
      const stats = new StatsService(counting, { now: () => NOW });
      const files = new FilesService(counting, { now: () => NOW });
      // Unpaced, so the steps below measure the recompute itself (the pacing scenario is at the end).
      const anomalies = new AnomaliesService(counting, { now: () => NOW, liveDelayMs: 0, liveCostFactor: 0 });
      files.shareReadsWith(stats);
      const warm = await measured(async () => {
        await stats.warm();
        await files.warm();
        await anomalies.warm();
      });
      const warmReads = reads;
      const first = await measured(() => anomalies.list({ range: 'all', origin: null, projectId: null, kind: null }));
      const counts = await anomalies.counts();

      // The anomaly service alone, cold.
      const alone = new AnomaliesService(storeStatsSource(store), { now: () => NOW, answerWaitMs: 600_000 });
      const cold = await measured(() => alone.counts());

      // Nothing changed: a filter switch.
      const derivations = anomalies.derivationCount();
      const unchanged = await measured(() => anomalies.list({ range: '30d', origin: 'codex', projectId: null, kind: 'loop' }));
      expect(anomalies.derivationCount()).toBe(derivations);

      // One small session changed: only it is re-read.
      const target = 'bench-s005';
      const firstNode = store.nodePage(target, null, 1)[0]!.node;
      const changes = store.applyChanges([{
        type: 'node_added', node: { ...firstNode, id: `${target}-extra`, kind: 'tool', status: 'failed', toolName: 'Bash', agentId: null, timestamp: iso(NOW - 1000), inputKey: hex(1) }, detail: {},
      }]);
      anomalies.noteChanges(changes);
      stats.noteChanges(changes);
      files.noteChanges(changes);
      const readsBefore = reads;
      const changed = await measured(() => anomalies.counts());
      const changedReads = reads - readsBefore;

      // One full cost re-derivation over every turn (what a change costs on top of the re-read).
      const allCosts: { group: string; costs: TurnCost[] }[] = [];
      for (const s of base.sessions()) {
        const read = (await base.readSession(s.id))!;
        allCosts.push({ group: `${s.projectId}\u0000${s.origin}`, costs: summarizeAnomalies(read.session, read.nodes).costs });
      }
      const turns = allCosts.reduce((n, c) => n + c.costs.length, 0);
      let t = performance.now();
      const groups = new Map<string, TurnCost[]>();
      for (const { group, costs } of allCosts) groups.set(group, [...(groups.get(group) ?? []), ...costs]);
      let costCount = 0;
      for (const { group, costs } of allCosts) costCount += costAnomalies(costs, costBaseline(groups.get(group)!)).length;
      const deriveMs = performance.now() - t;

      // The 100,000-node session recomputed alone (a live recompute: paged read + detection + turn costs).
      anomalies.noteChanges(store.applyChanges([{ type: 'session_upserted', session: { ...store.getSession('bench-s000')!, lastActivityAt: iso(NOW) } }]));
      const big = await measured(() => anomalies.session('bench-s000'));
      t = performance.now();
      const bigRead = (await base.readSession('bench-s000'))!;
      const bigReadMs = performance.now() - t;
      t = performance.now();
      summarizeAnomalies(bigRead.session, bigRead.nodes);
      const bigSummarizeMs = performance.now() - t;

      const byKind = first.result.totals;
      console.log(
        `anomalies benchmark, ${total} nodes / 37 sessions, ${turns} main turns, anomalies ${JSON.stringify(byKind)} in ${Object.keys(counts.counts).length} sessions` +
          ` (list ${first.result.items.length}, truncated ${first.result.truncated})\n` +
          `  ${line(`start-up warm-up, stats + files + anomalies (${warmReads} session reads)`, warm)}\n` +
          `  ${line('first anomaly request after the warm-up', first)}\n` +
          `  ${line('anomaly service alone, cold', cold)}\n` +
          `  ${line('unchanged (filter switch, no re-derivation)', unchanged)}\n` +
          `  ${line(`after one session changed (${changedReads} session read)`, changed)}\n` +
          `  full cost re-derivation over ${turns} turns: ${deriveMs.toFixed(1)} ms (${costCount} cost anomalies)\n` +
          `  ${line('100,000-node session recomputed alone', big)}; split: paged read ${bigReadMs.toFixed(0)} ms (yields between pages), summarize ${bigSummarizeMs.toFixed(0)} ms`,
      );
      expect(changedReads).toBe(1);
      expect(first.result.items.length).toBeLessThanOrEqual(200);
      if (ASSERT) {
        expect(unchanged.ms).toBeLessThan(50);
        expect(changed.ms).toBeLessThan(1000);
      }
      // The 100,000-node session changing every second for SCENARIO_MS while the home page polls the counts 500 ms after
      // each change; notifications off. Unpaced (each request recomputes, as before the pacing) vs paced (default).
      const SCENARIO_MS = Number(process.env.AGENT_CANVAS_BENCH_SCENARIO_MS ?? 30_000);
      const scenario = async (paced: boolean): Promise<string> => {
        let summaries = 0;
        let summarizeMs = 0;
        const svc = new AnomaliesService(storeStatsSource(store), {
          now: () => NOW,
          ...(paced ? {} : { liveDelayMs: 0, liveCostFactor: 0 }),
          summarize: (s, n) => {
            const t0 = performance.now();
            try {
              return summarizeAnomalies(s, n);
            } finally {
              if (s.id === 'bench-s000') {
                summaries++;
                summarizeMs += performance.now() - t0;
              }
            }
          },
        });
        await svc.counts();
        summaries = 0;
        summarizeMs = 0;
        const base = store.getSession('bench-s000')!;
        let k = 0;
        const run = await measured(async () => {
          const until = performance.now() + SCENARIO_MS;
          while (performance.now() < until) {
            k++;
            svc.noteChanges(store.applyChanges([
              { type: 'node_added', node: { ...firstNode, id: `bench-s000-live${paced ? 'p' : 'u'}${k}`, sessionId: 'bench-s000', turnId: null, agentId: null, timestamp: iso(NOW - 1000 + k) }, detail: {} },
              { type: 'session_upserted', session: { ...base, lastActivityAt: iso(NOW + k) } },
            ]));
            await new Promise((r) => setTimeout(r, 500));
            await svc.counts();
            await new Promise((r) => setTimeout(r, 500));
          }
        });
        svc.close();
        const perMin = 60_000 / SCENARIO_MS;
        return `${paced ? 'paced' : 'unpaced'}: ${(summaries * perMin).toFixed(0)} recomputes/min of the 100,000-node session, ` +
          `summarize ${(summarizeMs * perMin).toFixed(0)} ms/min blocking (+ the paged reads, which yield), longest stall ${run.stallMs.toFixed(0)} ms`;
      };
      const unpacedLine = await scenario(false);
      const pacedLine = await scenario(true);
      console.log(`  home page polling, 100,000-node session changing every second (${SCENARIO_MS / 1000} s):\n    ${unpacedLine}\n    ${pacedLine}`);
      stats.close();
      files.close();
      anomalies.close();
      alone.close();
    } finally {
      store.close();
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20 }).catch(() => undefined);
    }
  });
});
