import { describe, expect, test } from 'vitest';
import { type GraphNode, type Origin, type Session } from '@agent-canvas/shared';
import { aggregateStats, localDayKey } from '../src/stats/aggregate.js';
import { summarizeSession } from '../src/stats/summary.js';
import { computeToday } from '../src/stats/today.js';

// Invented data only. Days are UTC days (a fixed zone) unless a test says otherwise.
const NOW = Date.parse('2026-11-24T10:45:30.000Z');
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const MIN = 60_000;
const H = 3600_000;
const D = 24 * H;
const iso = (ms: number): string => new Date(ms).toISOString();
const at = (day: string, hhmm: string): number => Date.parse(`${day}T${hhmm}:00.000Z`);

function mkSession(id: string, origin: Origin, o: Partial<Session> = {}): Session {
  return {
    id, projectId: 'p1', origin, cwd: null, title: null, gitBranch: null, status: 'idle',
    sourceDeleted: false, startedAt: iso(NOW), lastActivityAt: iso(NOW), ...o,
  };
}
let seq = 0;
function n(ms: number, o: Partial<GraphNode> = {}): GraphNode {
  return {
    id: `n${seq++}`, sessionId: 's', turnId: null, agentId: null, parentId: null, kind: 'text', status: null,
    timestamp: iso(ms), confirmed: true, title: 't', summary: 'words', toolName: null, toolUseId: null,
    messageId: null, durationMs: null, usage: null, systemSubtype: null, childAgentId: null, endedAt: null, ...o,
  };
}
/** A turn: prompt at `startMs`, a final node `durMs` later (carrying usage when given: [input, output, cached]). */
function turn(startMs: number, durMs: number, usage?: [number, number, number?]): GraphNode[] {
  const key = `T${seq++}`;
  return [
    n(startMs, { kind: 'prompt', turnId: key }),
    n(startMs + durMs, {
      turnId: key,
      usage: usage ? { inputTokens: usage[0], cachedInputTokens: usage[2] ?? 0, outputTokens: usage[1] } : null,
    }),
  ];
}
const shutdown = (ms: number, input: number, output: number): GraphNode =>
  n(ms, { kind: 'system', systemSubtype: 'shutdown', usage: { inputTokens: input, cachedInputTokens: 0, outputTokens: output } });
const entry = (session: Session, nodes: GraphNode[]) => ({ session, summary: summarizeSession(session, nodes) });
const compute = (entries: ReturnType<typeof entry>[], nowMs = NOW) => computeToday(entries, nowMs, utcDay);

describe('computeToday', () => {
  test('agrees with the stats page', () => {
    let s = 12345;
    const rnd = (): number => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const origins: Origin[] = ['claude', 'codex', 'cursor', 'copilot'];
    const entries: ReturnType<typeof entry>[] = [];
    for (let i = 0; i < 40; i++) {
      const origin = origins[Math.floor(rnd() * origins.length)]!;
      const running = rnd() < 0.15;
      const session = mkSession(`s${i}`, origin, { status: running ? 'running' : 'idle', lastActivityAt: iso(NOW - 5 * MIN) });
      const nodes: GraphNode[] = [];
      const turns = 1 + Math.floor(rnd() * 4);
      for (let t = 0; t < turns; t++) {
        const start = NOW - Math.floor(rnd() * 10 * D);
        const usage: [number, number, number] | undefined =
          origin === 'cursor' || rnd() < 0.2 ? undefined : [Math.floor(rnd() * 5000), Math.floor(rnd() * 900), Math.floor(rnd() * 3000)];
        if (rnd() < 0.1) nodes.push(...turn(0, 1000, usage)); // undated
        else nodes.push(...turn(start, Math.floor(rnd() * 3 * H), usage));
      }
      if (origin === 'copilot' && rnd() < 0.5) nodes.push(shutdown(NOW - Math.floor(rnd() * 3 * D), 700, 70));
      entries.push(entry(session, nodes));
    }
    const today = computeToday(entries, NOW, utcDay);
    const stats = aggregateStats({
      entries, failedSessions: 0, projects: [], range: '7d', origin: null, projectId: null, nowMs: NOW, dayKey: utcDay,
    });
    const day = stats.byDay.find((d) => d.day === '2026-11-24')!;
    expect(today.day).toBe('2026-11-24');
    expect(today.asOf).toBe(iso(NOW));
    expect(day.turns).toBeGreaterThan(0);
    expect(today.turns).toBe(day.turns);
    expect(today.activeMs).toBe(day.activeMs);
    expect(today.tokens).toEqual(day.tokens);
    // The stats series lists every origin of the range (zero rows included); today lists those with a turn or an extra today.
    const active = day.byOrigin.filter((o) => o.turns > 0 || (o.tokens !== null && o.tokens.input + o.tokens.cachedInput + o.tokens.output > 0));
    expect(today.byOrigin.length).toBeGreaterThan(1);
    expect(today.byOrigin).toEqual(active.map((o) => ({ origin: o.origin, turns: o.turns, activeMs: o.activeMs, tokens: o.tokens })));
    for (const o of today.byOrigin) expect(o.tokens === null).toBe(stats.coverage.noTokenData.includes(o.origin));
    expect(today.main).toBe(today.tokens === null ? null : today.tokens.input + today.tokens.output);
  });

  test('a turn that started yesterday 23:50 counts for yesterday', () => {
    const e = entry(mkSession('a', 'claude'), turn(at('2026-11-23', '23:50'), 30 * MIN, [100, 50]));
    const r = compute([e]);
    expect(r.turns).toBe(0);
    expect(r.byOrigin).toEqual([]);
    expect(r.tokens).toEqual({ input: 0, cachedInput: 0, output: 0 });
    expect(r.main).toBe(0);
  });

  test('main is input + output; cache reads never count', () => {
    const e = entry(mkSession('a', 'claude'), turn(at('2026-11-24', '08:00'), MIN, [100, 50, 9000]));
    const r = compute([e]);
    expect(r.tokens).toEqual({ input: 100, cachedInput: 9000, output: 50 });
    expect(r.main).toBe(150);
  });

  test('an extra counts on its own day', () => {
    const nodes = [...turn(at('2026-11-23', '20:00'), MIN), shutdown(at('2026-11-24', '09:00'), 5000, 300)];
    const r = compute([entry(mkSession('c', 'copilot'), nodes)]);
    expect(r.turns).toBe(0);
    expect(r.byOrigin).toEqual([{ origin: 'copilot', turns: 0, activeMs: 0, tokens: { input: 5000, cachedInput: 0, output: 300 } }]);
    expect(r.main).toBe(5300);
  });

  test('Cursor-only day: main null, the origin has no token data', () => {
    const e = entry(mkSession('u', 'cursor'), turn(at('2026-11-24', '09:00'), 10 * MIN));
    const r = compute([e]);
    expect(r.turns).toBe(1);
    expect(r.tokens).toBeNull();
    expect(r.main).toBeNull();
    expect(r.byOrigin).toEqual([{ origin: 'cursor', turns: 1, activeMs: 10 * MIN, tokens: null }]);
  });

  test('Copilot before exit: usage in an older session gives zeros, not null', () => {
    const old = entry(mkSession('old', 'copilot'), [...turn(at('2026-11-10', '09:00'), MIN), shutdown(at('2026-11-10', '10:00'), 900, 90)]);
    const live = entry(mkSession('live', 'copilot', { status: 'running' }), turn(at('2026-11-24', '09:00'), 20 * MIN));
    const r = compute([old, live]);
    expect(r.turns).toBe(1);
    expect(r.byOrigin[0]!.tokens).toEqual({ input: 0, cachedInput: 0, output: 0 });
    expect(r.tokens).toEqual({ input: 0, cachedInput: 0, output: 0 });
    expect(r.main).toBe(0);
  });

  test('usualMain compares the time of day to the minute and averages over 7 days', () => {
    // now 10:45:30. Yesterday: a turn at 10:44 (counted: 100+20) and one at 10:46 (not). The day before: 03:00 (700).
    // Three days back: a Copilot exit extra at 10:44 (1000+10). Eight days back is outside the 7 days.
    const e1 = entry(mkSession('a', 'claude'), [
      ...turn(at('2026-11-23', '10:44'), MIN, [100, 20]),
      ...turn(at('2026-11-23', '10:46'), MIN, [5000, 5000]),
      ...turn(at('2026-11-22', '03:00'), MIN, [600, 100]),
      ...turn(at('2026-11-16', '09:00'), MIN, [999999, 1]),
    ]);
    const e2 = entry(mkSession('c', 'copilot'), [...turn(at('2026-11-21', '10:00'), MIN), shutdown(at('2026-11-21', '10:44'), 1000, 10)]);
    expect(compute([e1, e2]).usualMain).toBe((120 + 700 + 1010) / 7);
  });

  test("usualMain follows the day function's own midnight (a fixed +8 offset)", () => {
    const cst = (ms: number): string => new Date(ms + 8 * H).toISOString().slice(0, 10);
    const now = Date.parse('2026-11-24T02:45:30.000Z'); // 10:45 at +8
    const e = entry(mkSession('a', 'claude'), [
      ...turn(Date.parse('2026-11-23T02:44:00.000Z'), MIN, [70, 0]), // 10:44 local: counted
      ...turn(Date.parse('2026-11-23T02:46:00.000Z'), MIN, [9000, 0]), // 10:46 local: not
      ...turn(Date.parse('2026-11-22T16:30:00.000Z'), MIN, [700, 0]), // 00:30 local on the 23rd: counted
    ]);
    expect(computeToday([e], now, cst).usualMain).toBe(770 / 7);
  });

  test('usualMain is null when the 7 days only have origins without token data', () => {
    const e = entry(mkSession('u', 'cursor'), [...turn(at('2026-11-23', '09:00'), MIN), ...turn(at('2026-11-24', '09:00'), MIN)]);
    expect(compute([e]).usualMain).toBeNull();
  });

  test('usualMain is 0 when the origin has data but no earlier usage at that time of day', () => {
    const e = entry(mkSession('a', 'claude'), turn(at('2026-11-23', '11:00'), MIN, [10, 10]));
    expect(compute([e]).usualMain).toBe(0);
  });

  test('the default day function is the local one', () => {
    const now = Date.now();
    const e = entry(mkSession('a', 'claude'), turn(now - MIN, 1000, [1, 2]));
    expect(computeToday([e], now).day).toBe(localDayKey(now));
  });
});
