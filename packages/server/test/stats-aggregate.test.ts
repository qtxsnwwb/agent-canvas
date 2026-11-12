import { describe, expect, test } from 'vitest';
import { STALE_AFTER_MS, type GraphNode, type Origin, type Session, type StatsRange } from '@agent-canvas/shared';
import { addDays, aggregateStats, localDayKey, percentile, type AggregateInput } from '../src/stats/aggregate.js';
import { summarizeSession } from '../src/stats/summary.js';

// The clock: 2026-11-12 12:00 UTC. Days are UTC days unless a test injects another zone.
const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const H = 3600_000;
const iso = (ms: number): string => new Date(ms).toISOString();

function mkSession(id: string, o: Partial<Session> = {}): Session {
  return {
    id, projectId: 'p1', origin: 'claude', cwd: null, title: null, gitBranch: null, status: 'idle',
    sourceDeleted: false, startedAt: iso(NOW), lastActivityAt: iso(NOW), ...o,
  };
}
let seq = 0;
function n(ms: number, o: Partial<GraphNode> = {}): GraphNode {
  return {
    id: `n${seq++}`, sessionId: 's', turnId: null, agentId: null, parentId: null, kind: 'text', status: null,
    timestamp: iso(ms), confirmed: true, title: 't', summary: 'secret words', toolName: null, toolUseId: null,
    messageId: null, durationMs: null, usage: null, systemSubtype: null, childAgentId: null, endedAt: null, ...o,
  };
}
/** A closed turn: prompt at `startMs`, then the given calls (each `{ms after start, name, status, dur}`), ending at +durMs. */
function turn(startMs: number, durMs: number, calls: { name?: string; status?: GraphNode['status']; dur?: number | null; agentId?: string }[] = [], usage?: [number, number]): GraphNode[] {
  const key = `T${seq++}`;
  const out: GraphNode[] = [n(startMs, { kind: 'prompt', turnId: key })];
  calls.forEach((c, i) => {
    out.push(n(startMs + i + 1, {
      kind: 'tool', turnId: c.agentId ? null : key, agentId: c.agentId ?? null, toolName: c.name ?? 'Bash', status: c.status ?? 'succeeded',
      durationMs: c.dur === undefined ? 1000 : c.dur,
    }));
  });
  out.push(n(startMs + durMs, { turnId: key, usage: usage ? { inputTokens: usage[0], outputTokens: usage[1] } : null }));
  return out;
}

function entry(session: Session, nodes: GraphNode[]): AggregateInput['entries'][number] {
  return { session, summary: summarizeSession(session, nodes) };
}
function run(entries: AggregateInput['entries'], o: Partial<AggregateInput> = {}) {
  return aggregateStats({
    entries, failedSessions: 0, projects: [], range: '7d' as StatsRange, origin: null, projectId: null, nowMs: NOW, dayKey: utcDay, ...o,
  });
}

describe('helpers', () => {
  test('addDays works on day keys across months and years', () => {
    expect(addDays('2026-11-12', -6)).toBe('2026-11-06');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  test('localDayKey uses the process local zone', () => {
    const d = new Date(2026, 10, 12, 0, 30);
    expect(localDayKey(d.getTime())).toBe('2026-11-12');
  });
  test('percentile is nearest-rank on sorted values; null with no values', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([1, 2], 50)).toBe(1);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 95)).toBe(19);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBe(95);
  });
});

describe('empty data', () => {
  test('no sessions: zeros, every day of the range, empty lists, tokens null', () => {
    const r = run([]);
    expect(r.totals).toEqual({ sessions: 0, turns: 0, activeMs: 0, toolCalls: 0, finished: 0, failed: 0, failureRate: null, toolMs: 0, tokens: null });
    expect(r.byDay.map((d) => d.day)).toEqual(['2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']);
    expect(r.byDay.every((d) => d.turns === 0 && d.byOrigin.length === 0)).toBe(true);
    expect([r.byOrigin, r.byProject, r.byTool, r.slowest, r.mostFailing]).toEqual([[], [], [], [], []]);
    expect(r.range).toEqual({ range: '7d', from: '2026-11-06', to: '2026-11-12' });
    expect(r.generatedAt).toBe(iso(NOW));
  });
  test('all with no activity: byDay empty, from null', () => {
    const r = run([], { range: 'all' });
    expect(r.byDay).toEqual([]);
    expect(r.range.from).toBeNull();
  });
  test('30d covers 30 days', () => {
    expect(run([], { range: '30d' }).byDay).toHaveLength(30);
  });
});

describe('range and day attribution', () => {
  test('turns outside the range are cut; a session partly in range counts once with only its in-range turns', () => {
    const s = mkSession('s1');
    const r = run([entry(s, [
      ...turn(NOW - 8 * 24 * H, 60_000, [{}]), // 2026-11-04: out
      ...turn(NOW - 2 * 24 * H, 60_000, [{}]), // 11-10
      ...turn(NOW - 1 * H, 30_000, [{}, {}]), // 11-12
    ])]);
    expect(r.totals.sessions).toBe(1);
    expect(r.totals.turns).toBe(2);
    expect(r.totals.toolCalls).toBe(3);
    expect(r.totals.activeMs).toBe(90_000);
    expect(r.byDay.find((d) => d.day === '2026-11-10')!.turns).toBe(1);
    expect(r.byDay.find((d) => d.day === '2026-11-12')!.toolCalls).toBe(2);
  });

  test('the first day of the range is included, the day before is not; a turn after today is not', () => {
    const r = run([entry(mkSession('s1'), [
      ...turn(Date.parse('2026-11-06T00:00:00Z'), 1000),
      ...turn(Date.parse('2026-11-05T23:59:59Z'), 1000),
      ...turn(Date.parse('2026-11-13T00:00:01Z'), 1000),
    ])]);
    expect(r.totals.turns).toBe(1);
  });

  test('a turn spanning midnight belongs, whole, to the day it started (in the injected zone)', () => {
    // 23:30 → 00:30 in UTC+8 (15:30Z → 16:30Z on 11-11).
    const plus8 = (ms: number): string => utcDay(ms + 8 * H);
    const start = Date.parse('2026-11-11T15:30:00Z');
    const r = run([entry(mkSession('s1'), turn(start, H, [{ dur: 5000 }]))], { dayKey: plus8 });
    const day11 = r.byDay.find((d) => d.day === '2026-11-11')!;
    expect([day11.turns, day11.activeMs, day11.toolCalls]).toEqual([1, H, 1]);
    expect(r.byDay.find((d) => d.day === '2026-11-12')!.turns).toBe(0);
    // In UTC the same turn started on 11-11 as well, but at 15:30.
    expect(utcDay(start)).toBe('2026-11-11');
    const r2 = run([entry(mkSession('s1'), turn(Date.parse('2026-11-11T16:30:00Z'), H))], { dayKey: plus8 });
    expect(r2.byDay.find((d) => d.day === '2026-11-12')!.turns).toBe(1);
  });

  test('a subagent-internal call counts on the day of the turn that dispatched it', () => {
    const start = Date.parse('2026-11-10T23:59:00Z');
    const nodes = [
      n(start, { kind: 'prompt', turnId: 'T' }),
      n(start + 1000, { kind: 'subagent', turnId: 'T', status: 'succeeded', childAgentId: 'ag', toolName: 'Task' }),
      n(start + 5 * 60_000, { kind: 'tool', agentId: 'ag', status: 'failed', toolName: 'Bash' }), // 11-11 00:04
    ];
    const r = run([entry(mkSession('s1'), nodes)]);
    const d10 = r.byDay.find((d) => d.day === '2026-11-10')!;
    expect([d10.toolCalls, d10.failed]).toEqual([2, 1]);
    expect(r.byDay.find((d) => d.day === '2026-11-11')!.toolCalls).toBe(0);
  });

  test('all: byDay from the first active day to today', () => {
    const r = run([entry(mkSession('s1'), turn(Date.parse('2026-11-01T10:00:00Z'), 1000))], { range: 'all' });
    expect(r.range).toEqual({ range: 'all', from: '2026-11-01', to: '2026-11-12' });
    expect(r.byDay).toHaveLength(12);
    expect(r.coverage.byDayTruncated).toBe(false);
    expect(r.coverage.firstActiveDay).toBe('2026-11-01');
  });

  test('all over more than 366 days: byDay holds the most recent 366, totals still cover everything', () => {
    const old = Date.parse('2024-01-01T10:00:00Z');
    const r = run([entry(mkSession('s1'), [...turn(old, 1000), ...turn(NOW - H, 1000)])], { range: 'all' });
    expect(r.byDay).toHaveLength(366);
    expect(r.byDay[0]!.day).toBe(addDays('2026-11-12', -365));
    expect(r.byDay[365]!.day).toBe('2026-11-12');
    expect(r.coverage.byDayTruncated).toBe(true);
    expect(r.coverage.firstActiveDay).toBe('2024-01-01');
    expect(r.range.from).toBe('2024-01-01');
    expect(r.totals.turns).toBe(2);
    expect(r.byDay.reduce((a, d) => a + d.turns, 0)).toBe(1);
  });
});

describe('definitions', () => {
  test('in-progress turn counts to now; a stale one stops 15 minutes after its last activity', () => {
    const live = mkSession('live', { status: 'running', lastActivityAt: iso(NOW - 60_000) });
    const stale = mkSession('stale', { status: 'running', lastActivityAt: iso(NOW - 2 * STALE_AFTER_MS) });
    const r = run([
      entry(live, [n(NOW - 5 * 60_000, { kind: 'prompt', turnId: 'A' }), n(NOW - 60_000, { turnId: 'A' })]),
      entry(stale, [n(NOW - 3 * STALE_AFTER_MS, { kind: 'prompt', turnId: 'B' }), n(NOW - 2 * STALE_AFTER_MS, { turnId: 'B' })]),
    ]);
    expect(r.totals.activeMs).toBe(5 * 60_000 + STALE_AFTER_MS);
  });

  test('failure rate: failed or denied ÷ finished; running calls are not in the denominator', () => {
    const r = run([entry(mkSession('s1'), turn(NOW - H, 10_000, [
      { status: 'succeeded' }, { status: 'failed' }, { status: 'denied' }, { status: 'running' }, { status: 'awaiting_permission' },
    ]))]);
    expect([r.totals.toolCalls, r.totals.finished, r.totals.failed]).toEqual([5, 3, 2]);
    expect(r.totals.failureRate).toBeCloseTo(2 / 3);
  });

  test('tool time sums parallel calls and can exceed active time', () => {
    const r = run([entry(mkSession('s1'), turn(NOW - H, 2000, [{ dur: 1800 }, { dur: 1800 }]))]);
    expect(r.totals.activeMs).toBe(2000);
    expect(r.totals.toolMs).toBe(3600);
  });

  test('tokens: per origin; an origin with no usage anywhere in the dataset is null and listed', () => {
    const r = run([
      entry(mkSession('c1'), turn(NOW - H, 1000, [], [100, 10])),
      entry(mkSession('x1', { origin: 'cursor' }), turn(NOW - H, 1000, [{}])),
      // Codex has usage, but only outside the range: 0, not null.
      entry(mkSession('k1', { origin: 'codex' }), [...turn(NOW - 20 * 24 * H, 1000, [], [5, 5]), ...turn(NOW - H, 1000)]),
    ]);
    expect(r.coverage.noTokenData).toEqual(['cursor']);
    expect(r.totals.tokens).toEqual({ input: 100, output: 10 });
    const by = Object.fromEntries(r.byOrigin.map((o) => [o.origin, o]));
    expect(by.claude!.tokens).toEqual({ input: 100, output: 10 });
    expect(by.claude!.avgTokensPerTurn).toEqual({ input: 100, output: 10 });
    expect(by.cursor!.tokens).toBeNull();
    expect(by.cursor!.avgTokensPerTurn).toBeNull();
    expect(by.codex!.tokens).toEqual({ input: 0, output: 0 });
    const today = r.byDay.find((d) => d.day === '2026-11-12')!;
    expect(today.byOrigin.map((o) => [o.origin, o.tokens])).toEqual([
      ['claude', { input: 100, output: 10 }], ['codex', { input: 0, output: 0 }], ['cursor', null],
    ]);
  });

  test('only origins without token data in scope: tokens null everywhere', () => {
    const cursor = mkSession('x1', { origin: 'cursor' });
    const r = run([entry(mkSession('c1'), turn(NOW - H, 1000, [], [1, 1])), entry(cursor, turn(NOW - H, 1000))], { origin: 'cursor' });
    expect(r.totals.tokens).toBeNull();
    expect(r.byDay.every((d) => d.tokens === null)).toBe(true);
    expect(r.byProject[0]!.tokens).toBeNull();
    // noTokenData does not depend on the filter.
    expect(r.coverage.noTokenData).toEqual(['cursor']);
  });

  test('byOrigin: only origins with activity in range, ORIGINS order, per-turn measures', () => {
    const r = run([
      entry(mkSession('x1', { origin: 'cursor' }), [...turn(NOW - 3 * H, 1000, [{}, {}]), ...turn(NOW - 2 * H, 3000), ...turn(NOW - H, 2000, [{}])]),
      entry(mkSession('c1'), turn(NOW - H, 4000)),
      entry(mkSession('k1', { origin: 'codex' }), turn(NOW - 30 * 24 * H, 4000)),
    ]);
    expect(r.byOrigin.map((o) => o.origin)).toEqual(['claude', 'cursor']);
    const cursor = r.byOrigin[1]!;
    expect([cursor.sessions, cursor.turns, cursor.medianTurnMs, cursor.avgToolCallsPerTurn]).toEqual([1, 3, 2000, 1]);
    expect(r.coverage.sessionsByOrigin).toEqual([{ origin: 'claude', sessions: 1 }, { origin: 'cursor', sessions: 1 }]);
    expect(r.byDay[6]!.byOrigin.map((o) => o.origin)).toEqual(['claude', 'cursor']);
    expect(r.byDay[0]!.byOrigin.map((o) => [o.origin, o.turns])).toEqual([['claude', 0], ['cursor', 0]]);
  });
});

describe('filters', () => {
  const data = () => [
    entry(mkSession('a', { projectId: 'p1' }), turn(NOW - H, 1000, [{}])),
    entry(mkSession('b', { projectId: 'p2', origin: 'codex' }), turn(NOW - H, 1000, [{}, {}])),
  ];
  test('origin filter', () => {
    const r = run(data(), { origin: 'codex' });
    expect([r.totals.sessions, r.totals.toolCalls]).toEqual([1, 2]);
    expect(r.filters).toEqual({ origin: 'codex', projectId: null });
  });
  test('project filter', () => {
    const r = run(data(), { projectId: 'p1' });
    expect([r.totals.sessions, r.totals.toolCalls]).toEqual([1, 1]);
  });
  test('origin and project together', () => {
    expect(run(data(), { projectId: 'p1', origin: 'codex' }).totals.sessions).toBe(0);
  });
  test('unknown project: empty result', () => {
    const r = run(data(), { projectId: 'nope' });
    expect(r.totals.sessions).toBe(0);
    expect(r.byProject).toEqual([]);
  });
});

describe('lists', () => {
  test('byProject: by active time, names from cwd, top 20 then one merged row', () => {
    const entries = Array.from({ length: 22 }, (_, i) =>
      entry(mkSession(`s${i}`, { projectId: `proj-${i}` }), turn(NOW - H, (i + 1) * 1000, [{}])));
    const r = run(entries, { projects: [{ id: 'proj-21', cwd: 'D:\\work\\big-one' }] });
    expect(r.byProject).toHaveLength(21);
    expect(r.byProject[0]).toMatchObject({ projectId: 'proj-21', name: 'big-one', activeMs: 22_000, projectCount: 1 });
    expect(r.byProject[19]!.projectId).toBe('proj-2');
    expect(r.byProject[20]).toMatchObject({ projectId: null, name: '其他', projectCount: 2, sessions: 2, turns: 2, activeMs: 3000, toolCalls: 2 });
  });

  test('byTool: per (origin, name), by total time, nearest-rank median and P95, top 30', () => {
    const calls = [
      ...Array.from({ length: 20 }, (_, i) => ({ name: 'Bash', dur: (i + 1) * 100 })),
      { name: 'Read', dur: 50 }, { name: 'Read', dur: null }, { name: 'Read', status: 'running' as const, dur: 9999 },
    ];
    const r = run([
      entry(mkSession('a'), turn(NOW - H, 100_000, calls)),
      entry(mkSession('b', { origin: 'codex' }), turn(NOW - H, 1000, [{ name: 'Bash', dur: 99_999 }])),
    ]);
    expect(r.byTool.map((t) => [t.origin, t.toolName])).toEqual([['codex', 'Bash'], ['claude', 'Bash'], ['claude', 'Read']]);
    expect(r.byTool[1]).toMatchObject({ calls: 20, finished: 20, failed: 0, timedCalls: 20, totalMs: 21_000, medianMs: 1000, p95Ms: 1900 });
    expect(r.byTool[2]).toMatchObject({ calls: 3, finished: 2, timedCalls: 1, totalMs: 50, medianMs: 50, p95Ms: 50 });
    const many = Array.from({ length: 35 }, (_, i) => ({ name: `tool${i}` }));
    expect(run([entry(mkSession('a'), turn(NOW - H, 1000, many))]).byTool).toHaveLength(30);
  });

  test('slowest: the 10 longest finished calls in range, with ids for the link', () => {
    const calls = Array.from({ length: 12 }, (_, i) => ({ name: `t${i}`, dur: (i + 1) * 1000 }));
    const nodes = turn(NOW - H, 100_000, calls);
    const r = run([entry(mkSession('a', { projectId: 'pp' }), [...nodes, ...turn(NOW - 10 * 24 * H, 1, [{ dur: 10 ** 9 }])])]);
    expect(r.slowest).toHaveLength(10);
    expect(r.slowest[0]).toEqual({
      sessionId: 'a', nodeId: nodes[12]!.id, projectId: 'pp', origin: 'claude', toolName: 't11', durationMs: 12_000, startedAt: nodes[12]!.timestamp,
    });
    expect(r.slowest[9]!.durationMs).toBe(3000);
  });

  test('mostFailing: by failures, at least 5 calls, at most 10', () => {
    const calls = [
      ...Array.from({ length: 4 }, () => ({ name: 'Few', status: 'failed' as const })),
      ...Array.from({ length: 5 }, (_, i) => ({ name: 'Edit', status: (i < 2 ? 'failed' : 'succeeded') as GraphNode['status'] })),
      ...Array.from({ length: 6 }, (_, i) => ({ name: 'Bash', status: (i < 3 ? 'denied' : 'succeeded') as GraphNode['status'] })),
      ...Array.from({ length: 6 }, () => ({ name: 'Ok' })),
    ];
    const r = run([entry(mkSession('a'), turn(NOW - H, 1000, calls))]);
    expect(r.mostFailing).toEqual([
      { origin: 'claude', toolName: 'Bash', calls: 6, finished: 6, failed: 3, failureRate: 0.5 },
      { origin: 'claude', toolName: 'Edit', calls: 5, finished: 5, failed: 2, failureRate: 0.4 },
    ]);
  });
});

test('coverage: failed sessions are passed through', () => {
  expect(run([], { failedSessions: 3 }).coverage.failedSessions).toBe(3);
});

test('the response carries no conversation content', () => {
  const r = run([entry(mkSession('a', { title: 'secret title' }), turn(NOW - H, 1000, [{}]))]);
  const json = JSON.stringify(r);
  expect(json).not.toContain('secret');
});

test('origins appear in ORIGINS order in coverage.noTokenData', () => {
  const origins: Origin[] = ['cursor', 'codex'];
  const r = run(origins.map((o, i) => entry(mkSession(`s${i}`, { origin: o }), turn(NOW - H, 1000))));
  expect(r.coverage.noTokenData).toEqual(['codex', 'cursor']);
});
