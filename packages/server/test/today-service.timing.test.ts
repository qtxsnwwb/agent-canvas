import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, test } from 'vitest';
import type { Change, GraphNode, Session } from '@agent-canvas/shared';
import { FilesService } from '../src/files/service.js';
import { StatsService, storeStatsSource, type StatsSource } from '../src/stats/service.js';
import { TodayService } from '../src/stats/today-service.js';
import { openStore } from '../src/store/store.js';
import type { Timers } from '../src/timers.js';

// Timing-sensitive: runs in the serial "timing" Vitest project (see vitest.config.ts). Temp file store, invented nodes.
//
// Review Focus 2 (today's usage): a running 100,000-node session producing a change every second. The today service
// re-reads it at most once per 30 s (fake clock), and one recompute (paged read, stats and file summaries, computeToday)
// is timed. Measured on the development machine (Windows, Node 25), run on its own: 454-530 ms wall, longest event-loop
// stall 195-276 ms (the synchronous summaries). The bounds leave ~10x headroom.

const TIMING_SCALE = Math.max(1, Number(process.env.AGENT_CANVAS_TIMING_SCALE) || 1);
const bound = (ms: number): number => ms * TIMING_SCALE;
const BOUND_RECOMPUTE_MS = 5000;
const BOUND_STALL_MS = 2500;

const NODES = 100_000;
const S = 1000;
const H = 3_600_000;
const T0 = Date.parse('2026-11-24T10:00:00.000Z');
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const iso = (ms: number): string => new Date(ms).toISOString();

/** A fake clock whose timers fire (in time order) as it is advanced. */
function fakeClock(): { now: () => number; timers: Timers; advance(ms: number): Promise<void> } {
  let now = T0;
  let pending: { fn: () => void; at: number }[] = [];
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      const t = { fn, at: now + Math.max(0, ms) };
      pending.push(t);
      return t;
    },
    clearTimeout: (h) => {
      pending = pending.filter((t) => t !== h);
    },
    setInterval: () => 0,
    clearInterval: () => {},
  };
  return {
    now: () => now,
    timers,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = pending.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        pending = pending.filter((t) => t !== due);
        now = Math.max(now, due.at);
        due.fn();
        await new Promise<void>((r) => setImmediate(r));
      }
      now = end;
    },
  };
}

test('today: a running 100,000-node session changing every second for 60 s is read at most 3 times; one recompute timed', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-today-big-'));
  const store = openStore(path.join(dir, 'today.db'));
  try {
    const sid = 'big-1';
    const start = T0 - 2 * H;
    const session: Session = {
      id: sid, projectId: 'p-big', origin: 'claude', cwd: null, title: null, gitBranch: null, status: 'running', sourceDeleted: false,
      startedAt: iso(start), lastActivityAt: iso(T0),
    };
    const node = (i: number, at: number): GraphNode => ({
      id: `${sid}-n${i}`, sessionId: sid, turnId: `${sid}-t${Math.floor(i / 60)}`, agentId: null, parentId: null,
      kind: i % 60 === 0 ? 'prompt' : i % 2 === 0 ? 'tool' : 'text', status: i % 60 === 0 || i % 2 === 1 ? null : 'succeeded',
      timestamp: iso(at), confirmed: true, title: 'x', summary: 'x'.repeat(80), toolName: i % 60 !== 0 && i % 2 === 0 ? 'Bash' : null,
      toolUseId: null, messageId: `${sid}-m${i}`, durationMs: i % 60 !== 0 && i % 2 === 0 ? 100 : null, endedAt: null,
      usage: i % 60 !== 0 && i % 2 === 1 ? { inputTokens: 10, cachedInputTokens: 100, outputTokens: 2 } : null,
      systemSubtype: null, childAgentId: null,
    });
    const step = Math.floor((2 * H) / NODES);
    const changes: Change[] = [{ type: 'session_upserted', session }];
    for (let i = 0; i < NODES; i++) changes.push({ type: 'node_added', node: node(i, start + i * step), detail: {} });
    for (let i = 0; i < changes.length; i += 10_000) store.applyChanges(changes.slice(i, i + 10_000));

    let reads = 0;
    const base = storeStatsSource(store);
    const source: StatsSource = { ...base, readSession: (id, stopped) => { reads++; return base.readSession(id, stopped); } };
    const clock = fakeClock();
    const stats = new StatsService(source, { now: clock.now, dayKey: utcDay });
    // As buildServer wires them: each stats read of the session also builds its file summary (same stretch).
    const files = new FilesService(storeStatsSource(store));
    files.shareReadsWith(stats);
    const svc = new TodayService({ cache: stats.summaryCache(), store, line: () => null, ready: () => true, now: clock.now, dayKey: utcDay, timers: clock.timers });
    try {
      // One recompute (the first: the session read and summarized): wall time and longest event-loop stall.
      let last = performance.now();
      let stallMs = 0;
      const probe = setInterval(() => {
        const t = performance.now();
        stallMs = Math.max(stallMs, t - last);
        last = t;
      }, 1);
      const t = performance.now();
      const first = await svc.get();
      const wallMs = performance.now() - t;
      clearInterval(probe);
      stallMs = Math.max(stallMs, performance.now() - last);
      expect(first.turns).toBeGreaterThan(1000);

      let n = NODES;
      for (let sec = 1; sec <= 60; sec++) {
        const committed = store.applyChanges([
          { type: 'session_upserted', session: { ...session, lastActivityAt: iso(clock.now()) } },
          { type: 'node_added', node: node(n++, clock.now()), detail: {} },
        ]);
        stats.noteChanges(committed);
        files.noteChanges(committed);
        svc.noteChanges(committed);
        await clock.advance(S);
        await svc.get(); // waits for a recompute in flight (the paged read takes many event-loop turns)
      }
      const latest = await svc.get();
      console.log(
        `[today timing] one recompute of a ${NODES.toLocaleString('en')}-node running session: ${wallMs.toFixed(0)} ms wall, ` +
          `longest event-loop stall ${stallMs.toFixed(0)} ms (stats + file summaries); summary reads over 60 s of changes every second: ${reads}`,
      );
      expect(reads).toBeLessThanOrEqual(3);
      expect(latest.turns).toBeGreaterThanOrEqual(first.turns);
      expect(wallMs).toBeLessThan(bound(BOUND_RECOMPUTE_MS));
      expect(stallMs).toBeLessThan(bound(BOUND_STALL_MS));
    } finally {
      svc.close();
      stats.close();
      files.close();
    }
  } finally {
    store.close();
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20 }).catch(() => undefined);
  }
});
