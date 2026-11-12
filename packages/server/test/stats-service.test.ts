import { describe, expect, test } from 'vitest';
import type { GraphNode, SeqChange, Session } from '@agent-canvas/shared';
import { parseStatsQuery, StatsService, type StatsSource } from '../src/stats/service.js';

const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const iso = (ms: number): string => new Date(ms).toISOString();

function mkSession(id: string, o: Partial<Session> = {}): Session {
  return {
    id, projectId: 'p1', origin: 'claude', cwd: null, title: null, gitBranch: null, status: 'idle',
    sourceDeleted: false, startedAt: iso(NOW), lastActivityAt: iso(NOW), ...o,
  };
}
function mkNode(sessionId: string, id: string, ms: number, o: Partial<GraphNode> = {}): GraphNode {
  return {
    id, sessionId, turnId: 'T', agentId: null, parentId: null, kind: 'tool', status: 'succeeded', timestamp: iso(ms),
    confirmed: true, title: 'Bash', summary: '', toolName: 'Bash', toolUseId: null, messageId: null,
    durationMs: 1000, usage: null, systemSubtype: null, childAgentId: null, endedAt: null, ...o,
  };
}

/** An in-memory source with a global seq, counting graph reads. */
class FakeSource implements StatsSource {
  seq = 1;
  reads: string[] = [];
  failing = new Set<string>();
  delayMs = 0;
  readonly data = new Map<string, { session: Session; nodes: GraphNode[] }>();
  add(id: string, calls: number, o: Partial<Session> = {}): void {
    const nodes = [mkNode(id, `${id}-p`, NOW - 3600_000, { kind: 'prompt', status: null, toolName: null })];
    for (let i = 0; i < calls; i++) nodes.push(mkNode(id, `${id}-t${i}`, NOW - 3600_000 + i + 1));
    this.data.set(id, { session: mkSession(id, o), nodes });
    this.seq++;
  }
  /** Adds a call to a session; returns the change the pipeline would report. */
  addCall(id: string): SeqChange {
    const d = this.data.get(id)!;
    const node = mkNode(id, `${id}-x${d.nodes.length}`, NOW - 1000);
    d.nodes.push(node);
    return { type: 'node_added', node, detail: {}, seq: ++this.seq };
  }
  sessions(): Session[] {
    return [...this.data.values()].map((d) => d.session);
  }
  async readSession(sessionId: string) {
    this.reads.push(sessionId);
    if (this.failing.has(sessionId)) throw new Error('broken');
    if (this.delayMs > 0) {
      const until = Date.now() + this.delayMs;
      while (Date.now() < until) { /* busy: a large session */ }
    }
    const d = this.data.get(sessionId);
    return d ? { session: d.session, nodes: d.nodes, seq: this.seq } : null;
  }
  projects() {
    return [];
  }
}

const Q = { range: '7d' as const, origin: null, projectId: null };
const make = (source: StatsSource, capacity?: number, maxCalls?: number) =>
  new StatsService(source, {
    now: () => NOW, dayKey: utcDay, ...(capacity !== undefined ? { capacity } : {}), ...(maxCalls !== undefined ? { maxCalls } : {}),
  });

describe('StatsService', () => {
  test('first request summarizes every session; the next reuses the cache', async () => {
    const src = new FakeSource();
    src.add('a', 2);
    src.add('b', 3);
    const svc = make(src);
    expect((await svc.get(Q)).totals.toolCalls).toBe(5);
    expect(src.reads.sort()).toEqual(['a', 'b']);
    src.reads = [];
    expect((await svc.get({ ...Q, range: '30d' })).totals.toolCalls).toBe(5);
    expect(src.reads).toEqual([]);
  });

  test('a changed session recomputes only its own summary (invalidated through noteChanges, not eagerly)', async () => {
    const src = new FakeSource();
    src.add('a', 2);
    src.add('b', 3);
    const svc = make(src);
    await svc.get(Q);
    src.reads = [];
    svc.noteChanges([src.addCall('a')]);
    expect(src.reads).toEqual([]); // nothing recomputed until asked
    expect((await svc.get(Q)).totals.toolCalls).toBe(6);
    expect(src.reads).toEqual(['a']);
  });

  test('concurrent requests share one computation', async () => {
    const src = new FakeSource();
    src.add('a', 1);
    src.add('b', 1);
    const svc = make(src);
    const [r1, r2, r3] = await Promise.all([svc.get(Q), svc.get({ ...Q, origin: 'claude' }), svc.get({ ...Q, range: 'all' })]);
    expect(src.reads.sort()).toEqual(['a', 'b']);
    expect([r1.totals.toolCalls, r2.totals.toolCalls, r3.totals.toolCalls]).toEqual([2, 2, 2]);
  });

  test('a request after a change made during a computation gets the change', async () => {
    const src = new FakeSource();
    src.add('a', 1);
    const svc = make(src);
    const first = svc.get(Q);
    svc.noteChanges([src.addCall('a')]);
    const second = svc.get(Q);
    await first;
    expect((await second).totals.toolCalls).toBe(2);
  });

  test('a summary read before a change is not kept as current (seq marker)', async () => {
    const src = new FakeSource();
    src.add('a', 1);
    const svc = make(src);
    await svc.get(Q);
    // The change's seq is newer than the cached summary's: recomputed even though noteChanges came "late".
    const change = src.addCall('a');
    svc.noteChanges([change]);
    src.reads = [];
    await svc.get(Q);
    expect(src.reads).toEqual(['a']);
    src.reads = [];
    // An old change (seq not newer than the cached summary) does not invalidate.
    svc.noteChanges([{ ...change, seq: 1 }]);
    await svc.get(Q);
    expect(src.reads).toEqual([]);
  });

  test('the cache is bounded; a full pass does not evict what it has just used', async () => {
    const src = new FakeSource();
    for (const id of ['a', 'b', 'c']) src.add(id, 1);
    const svc = make(src, 2);
    expect((await svc.get(Q)).totals.toolCalls).toBe(3);
    expect(svc.cacheSize()).toBe(2);
    src.reads = [];
    expect((await svc.get(Q)).totals.toolCalls).toBe(3);
    expect(src.reads).toEqual(['c']);
  });

  test('the cache is also bounded by retained calls; a session larger than the bound is never cached', async () => {
    const src = new FakeSource();
    src.add('a', 3);
    src.add('b', 3);
    src.add('c', 10);
    const svc = make(src, undefined, 6);
    expect((await svc.get(Q)).totals.toolCalls).toBe(16);
    expect(svc.retainedCallCount()).toBe(6);
    expect(svc.cacheSize()).toBe(2);
    src.reads = [];
    await svc.get(Q);
    expect(src.reads).toEqual(['c']);
    // A change frees and re-adds its calls: the count stays exact.
    svc.noteChanges([src.addCall('a')]);
    await svc.get(Q);
    expect(svc.retainedCallCount()).toBeLessThanOrEqual(6);
  });

  test('defaults: 3,000 sessions all stay cached; an unchanged request reads nothing, a change reads only its session', async () => {
    const src = new FakeSource();
    for (let i = 0; i < 3000; i++) src.add(`s${i}`, 2);
    const svc = make(src);
    expect((await svc.get(Q)).totals.sessions).toBe(3000);
    expect(svc.cacheSize()).toBe(3000);
    src.reads = [];
    await svc.get({ ...Q, range: 'all' });
    expect(src.reads).toEqual([]);
    svc.noteChanges([src.addCall('s1234')]);
    await svc.get(Q);
    expect(src.reads).toEqual(['s1234']);
  });

  test('a session whose summary fails is skipped and counted, and retried next time', async () => {
    const src = new FakeSource();
    src.add('a', 1);
    src.add('b', 2);
    src.failing.add('a');
    const svc = make(src);
    const r = await svc.get(Q);
    expect(r.totals.toolCalls).toBe(2);
    expect(r.coverage.failedSessions).toBe(1);
    src.failing.clear();
    src.reads = [];
    const r2 = await svc.get(Q);
    expect(r2.coverage.failedSessions).toBe(0);
    expect(src.reads).toEqual(['a']);
  });

  test('a session that disappeared is not counted', async () => {
    const src = new FakeSource();
    src.add('a', 1);
    src.add('b', 1);
    const svc = make(src);
    await svc.get(Q);
    src.data.delete('b');
    expect((await svc.get(Q)).totals.sessions).toBe(1);
  });

  test('building summaries yields to the event loop', async () => {
    const src = new FakeSource();
    for (let i = 0; i < 6; i++) src.add(`s${i}`, 1);
    src.delayMs = 15;
    const svc = new StatsService(src, { now: () => NOW, dayKey: utcDay, yieldAfterMs: 5 });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    try {
      await svc.get(Q);
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThanOrEqual(3);
  });
});

describe('parseStatsQuery', () => {
  test('defaults', () => {
    expect(parseStatsQuery({})).toEqual({ range: '7d', origin: null, projectId: null });
  });
  test('valid values', () => {
    expect(parseStatsQuery({ range: 'all', origin: 'cursor', projectId: 'D--w' })).toEqual({ range: 'all', origin: 'cursor', projectId: 'D--w' });
  });
  test('empty origin / projectId mean "all"', () => {
    expect(parseStatsQuery({ origin: '', projectId: '' })).toEqual({ range: '7d', origin: null, projectId: null });
  });
  test('unknown range or origin, or a repeated parameter, is an error', () => {
    expect(parseStatsQuery({ range: '1y' })).toEqual({ error: expect.stringContaining('range') });
    expect(parseStatsQuery({ origin: 'gemini' })).toEqual({ error: expect.stringContaining('origin') });
    expect(parseStatsQuery({ range: ['7d', '30d'] })).toEqual({ error: expect.stringContaining('range') });
    expect(parseStatsQuery({ projectId: ['a', 'b'] })).toEqual({ error: expect.stringContaining('projectId') });
  });
});
