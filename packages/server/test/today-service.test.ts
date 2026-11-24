import { afterEach, describe, expect, test } from 'vitest';
import type { GraphNode, Origin, SeqChange, Session, TodayUsage } from '@agent-canvas/shared';
import { SessionSummaryCache, type SessionSummarySource } from '../src/stats/session-cache.js';
import { summarizeSession, type SessionSummary } from '../src/stats/summary.js';
import { TODAY_META_KEY, TODAY_THROTTLE_MS, TodayService } from '../src/stats/today-service.js';
import type { Timers } from '../src/timers.js';

// Invented data only; a fake clock and fake timers (injected), days are UTC days unless a test says otherwise.
// Review Focus 2 (a running 100,000-node session) is in today-service.timing.test.ts.

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const T0 = Date.parse('2026-11-24T10:00:00.000Z');
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const iso = (ms: number): string => new Date(ms).toISOString();
/** Several event-loop turns: lets an async recompute (cache snapshot, source reads) finish. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
};

class Clock {
  now = T0;
  private pending: { fn: () => void; at: number }[] = [];
  readonly timers: Timers = {
    setTimeout: (fn, ms) => {
      const t = { fn, at: this.now + Math.max(0, ms) };
      this.pending.push(t);
      return t;
    },
    clearTimeout: (h) => {
      this.pending = this.pending.filter((t) => t !== h);
    },
    setInterval: () => {
      throw new Error('the today service uses no interval');
    },
    clearInterval: () => {},
  };
  pendingCount(): number {
    return this.pending.length;
  }
  /** Moves the clock forward by `ms`, firing each timer due on the way at its own time. */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      const due = this.pending.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.pending = this.pending.filter((t) => t !== due);
      this.now = Math.max(this.now, due.at);
      due.fn();
      await flush();
    }
    this.now = end;
    await flush();
  }
}

/** Sessions held in memory, read through a real SessionSummaryCache (reads counted). */
class World {
  private readonly data = new Map<string, { session: Session; nodes: GraphNode[] }>();
  private seq = 0;
  private n = 0;
  reads = 0;
  snapshots = 0;
  readonly source: SessionSummarySource = {
    sessions: () => [...this.data.values()].map((d) => d.session),
    readSession: async (id) => {
      this.reads++;
      const d = this.data.get(id);
      return d === undefined ? null : { session: d.session, nodes: [...d.nodes], seq: this.seq };
    },
  };
  readonly cache = new SessionSummaryCache<SessionSummary>(this.source, {
    summarize: summarizeSession, weight: (s) => s.calls.length, capacity: 1000, maxWeight: 1e9, yieldAfterMs: 1e9, closedMessage: 'closed',
  });
  /** When set, a snapshot (already taken from the cache) is handed over only once it resolves. */
  hold: Promise<void> | null = null;
  /** What the service is given: the cache, its snapshots counted (one per recompute). */
  readonly counted = {
    snapshot: async () => {
      this.snapshots++;
      const snap = await this.cache.snapshot();
      if (this.hold !== null) await this.hold;
      return snap;
    },
  };

  session(id: string, o: Partial<Session> = {}): Session {
    return this.data.get(id)?.session ?? {
      id, projectId: 'p1', origin: 'claude', cwd: null, title: null, gitBranch: null, status: 'idle', sourceDeleted: false,
      startedAt: iso(T0), lastActivityAt: iso(T0), ...o,
    };
  }
  /** A finished turn of `id` started at `atMs` with [input, output] tokens; returns the changes (already noted by the cache). */
  turn(id: string, atMs: number, input: number, output: number, o: Partial<Session> = {}): SeqChange[] {
    const session = { ...this.session(id, o), ...o };
    const key = `T${this.n++}`;
    const nodes = this.data.get(id)?.nodes ?? [];
    nodes.push(this.node(id, atMs, { kind: 'prompt', turnId: key }));
    nodes.push(this.node(id, atMs + 1000, { turnId: key, usage: { inputTokens: input, cachedInputTokens: 0, outputTokens: output } }));
    return this.put(session, nodes);
  }
  put(session: Session, nodes: GraphNode[]): SeqChange[] {
    this.data.set(session.id, { session, nodes });
    const changes: SeqChange[] = [{ type: 'session_upserted', session, seq: ++this.seq }];
    this.cache.noteChanges(changes);
    return changes;
  }
  remove(id: string): SeqChange[] {
    const session = this.data.get(id)!.session;
    this.data.delete(id);
    const changes: SeqChange[] = [{ type: 'session_upserted', session: { ...session, sourceDeleted: true }, seq: ++this.seq }];
    this.cache.noteChanges(changes);
    return changes;
  }
  node(sessionId: string, atMs: number, o: Partial<GraphNode> = {}): GraphNode {
    return {
      id: `n${this.n++}`, sessionId, turnId: null, agentId: null, parentId: null, kind: 'text', status: null, timestamp: iso(atMs),
      confirmed: true, title: 't', summary: 'words', toolName: null, toolUseId: null, messageId: null, durationMs: null, usage: null,
      systemSubtype: null, childAgentId: null, endedAt: null, ...o,
    };
  }
}

class MetaStore {
  readonly meta = new Map<string, string>();
  getMeta(key: string): string | null {
    return this.meta.get(key) ?? null;
  }
  setMeta(key: string, value: string): void {
    this.meta.set(key, value);
  }
  state(): unknown {
    const raw = this.meta.get(TODAY_META_KEY);
    return raw === undefined ? null : JSON.parse(raw);
  }
}

interface Rig {
  clock: Clock;
  world: World;
  store: MetaStore;
  svc: TodayService;
  updates: TodayUsage[];
  crosses: TodayUsage[];
  set: { line: number | null; ready: boolean };
  /** Records `changes` as the server does (the cache already noted them): the service is told. */
  note(changes: SeqChange[]): void;
}

const services: TodayService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.close();
});

function rig(o: { line?: number | null; ready?: boolean; now?: number; dayKey?: (ms: number) => string; world?: World; store?: MetaStore; clock?: Clock } = {}): Rig {
  const clock = o.clock ?? new Clock();
  if (o.now !== undefined) clock.now = o.now;
  const world = o.world ?? new World();
  const store = o.store ?? new MetaStore();
  const set = { line: o.line === undefined ? null : o.line, ready: o.ready ?? true };
  const updates: TodayUsage[] = [];
  const crosses: TodayUsage[] = [];
  const svc = new TodayService({
    cache: world.counted,
    store,
    line: () => set.line,
    ready: () => set.ready,
    onCross: (u) => crosses.push(u),
    now: () => clock.now,
    dayKey: o.dayKey ?? utcDay,
    timers: clock.timers,
  });
  services.push(svc);
  svc.onUpdate((u) => updates.push(u));
  return { clock, world, store, svc, updates, crosses, set, note: (changes) => svc.noteChanges(changes) };
}

describe('TodayService: throttle', () => {
  test('nothing is computed before the first get() or change; then nothing on a timer without a change or an open turn', async () => {
    const r = rig();
    r.world.turn('s1', T0 - H, 100, 50);
    await r.clock.advance(5 * MIN);
    expect(r.world.snapshots).toBe(0);
    const u = await r.svc.get();
    expect(u).toMatchObject({ day: '2026-11-24', main: 150, turns: 1, lineTokens: null, over: false });
    expect(r.world.snapshots).toBe(1);
    await r.clock.advance(5 * MIN);
    expect(r.world.snapshots).toBe(1);
    // get() without a change returns the latest without recomputing.
    expect(await r.svc.get()).toBe(u);
    expect(r.world.snapshots).toBe(1);
  });

  test('100 change batches in 10 s: one recompute, 30 s after the previous one', async () => {
    const r = rig();
    await r.svc.get();
    for (let i = 0; i < 100; i++) {
      r.note(r.world.turn(`s${i % 5}`, T0 - H, 10, 0));
      await r.clock.advance(100);
    }
    expect(r.world.snapshots).toBe(1);
    // Within the window a get() answers with the latest (stale) result at once.
    expect((await r.svc.get()).main).toBe(0);
    await r.clock.advance(TODAY_THROTTLE_MS - 10 * S - 1);
    expect(r.world.snapshots).toBe(1);
    await r.clock.advance(1);
    expect(r.world.snapshots).toBe(2);
    expect((await r.svc.get()).main).toBe(1000);
    await r.clock.advance(5 * MIN);
    expect(r.world.snapshots).toBe(2);
    expect(r.updates.map((u) => u.main)).toEqual([0, 1000]);
  });

  test('the first change computes at once; get() after the window with a change pending recomputes first', async () => {
    const r = rig();
    r.note(r.world.turn('s1', T0 - H, 10, 5));
    await r.clock.advance(0);
    expect(r.world.snapshots).toBe(1);
    expect(r.updates.map((u) => u.main)).toEqual([15]);
    await r.clock.advance(TODAY_THROTTLE_MS);
    r.note(r.world.turn('s1', T0 - H, 10, 5));
    expect((await r.svc.get()).main).toBe(30);
    expect(r.world.snapshots).toBe(2);
  });

  test('an open turn today: one recompute every 30 s from the cache (no session re-read) until it goes stale', async () => {
    const r = rig();
    r.world.turn('s1', T0 - 10 * MIN, 100, 50, { status: 'running', lastActivityAt: iso(T0) });
    const first = await r.svc.get();
    expect(r.world.reads).toBe(1);
    await r.clock.advance(2 * MIN);
    expect(r.world.snapshots).toBe(5);
    expect(r.world.reads).toBe(1);
    expect(r.updates.map((u) => u.activeMs - first.activeMs)).toEqual([0, 30 * S, 60 * S, 90 * S, 120 * S]);
    // STALE_AFTER_MS (15 min) after its last activity it stops growing: one more recompute, then none.
    await r.clock.advance(20 * MIN);
    const settled = r.world.snapshots;
    await r.clock.advance(10 * MIN);
    expect(r.world.snapshots).toBe(settled);
    expect(r.world.reads).toBe(1);
  });

  test('an open turn that started yesterday does not tick', async () => {
    const r = rig();
    r.world.turn('s1', T0 - 11 * H, 100, 50, { status: 'running', lastActivityAt: iso(T0) });
    await r.svc.get();
    await r.clock.advance(5 * MIN);
    expect(r.world.snapshots).toBe(1);
  });

  test('a recompute that only moves asOf is not pushed', async () => {
    const r = rig({ line: 1000 });
    r.world.turn('s1', T0 - H, 100, 50);
    await r.svc.get();
    await r.clock.advance(S);
    r.svc.settingsChanged();
    await flush();
    expect(r.world.snapshots).toBe(2);
    expect(r.updates).toHaveLength(1);
  });

  test('close() cancels every timer; nothing runs after it', async () => {
    const r = rig();
    r.world.turn('s1', T0 - 10 * MIN, 100, 50, { status: 'running', lastActivityAt: iso(T0) });
    await r.svc.get();
    r.note(r.world.turn('s2', T0 - H, 1, 1));
    expect(r.clock.pendingCount()).toBeGreaterThan(0);
    r.svc.close();
    expect(r.clock.pendingCount()).toBe(0);
    r.note(r.world.turn('s2', T0 - H, 1, 1));
    r.svc.settingsChanged();
    await r.clock.advance(H);
    expect(r.world.snapshots).toBe(1);
  });
});

describe('TodayService: midnight', () => {
  test('a computation runs at the next local midnight; the day changes and the over-state starts again', async () => {
    const r = rig({ line: 100, now: Date.parse('2026-11-24T23:59:00.000Z') });
    r.world.turn('s1', Date.parse('2026-11-24T23:00:00.000Z'), 100, 50);
    expect(await r.svc.get()).toMatchObject({ day: '2026-11-24', main: 150, over: true });
    expect(r.store.state()).toEqual({ day: '2026-11-24', line: 100, over: true });
    await r.clock.advance(MIN - 1);
    expect(r.world.snapshots).toBe(1);
    await r.clock.advance(1);
    expect(r.world.snapshots).toBe(2);
    expect(r.updates.at(-1)).toMatchObject({ day: '2026-11-25', main: 0, over: false, asOf: '2026-11-25T00:00:00.000Z' });
    expect(r.store.state()).toEqual({ day: '2026-11-25', line: 100, over: false });
    // Growth past the same line on the new day notifies again.
    r.note(r.world.turn('s1', Date.parse('2026-11-25T00:00:10.000Z'), 80, 40));
    await r.clock.advance(TODAY_THROTTLE_MS);
    expect(r.crosses.map((u) => u.day)).toEqual(['2026-11-25']);
    // Re-armed: the next midnight runs too.
    const before = r.world.snapshots;
    await r.clock.advance(24 * H);
    expect(r.world.snapshots).toBe(before + 1);
    expect(r.updates.at(-1)!.day).toBe('2026-11-26');
  });

  test('the next day start comes from the day function (UTC+8 here: 16:00Z)', async () => {
    const r = rig({ dayKey: (ms) => utcDay(ms + 8 * H) });
    expect((await r.svc.get()).day).toBe('2026-11-24');
    await r.clock.advance(Date.parse('2026-11-24T16:00:00.000Z') - T0 - 1);
    expect(r.world.snapshots).toBe(1);
    await r.clock.advance(1);
    expect(r.world.snapshots).toBe(2);
    expect(r.updates.at(-1)!.day).toBe('2026-11-25');
  });
});

describe('TodayService: crossing the line', () => {
  /** Adds tokens today (a new turn of s1) and lets the throttled recompute run. */
  const grow = async (r: Rig, tokens: number): Promise<TodayUsage> => {
    r.note(r.world.turn('s1', T0 - H, tokens, 0));
    await r.clock.advance(TODAY_THROTTLE_MS);
    return r.svc.get();
  };

  test('under -> over with start-up done: onCross once; staying over or crossing again the same day and line: none', async () => {
    const r = rig({ line: 1000 });
    expect(await r.svc.get()).toMatchObject({ main: 0, lineTokens: 1000, over: false });
    expect(await grow(r, 600)).toMatchObject({ main: 600, over: false });
    expect(r.crosses).toEqual([]);
    expect(await grow(r, 500)).toMatchObject({ main: 1100, over: true });
    expect(r.crosses).toHaveLength(1);
    expect(r.crosses[0]).toMatchObject({ main: 1100, lineTokens: 1000, over: true });
    expect(r.store.state()).toEqual({ day: '2026-11-24', line: 1000, over: true });
    await grow(r, 100);
    expect(r.crosses).toHaveLength(1);
    // Back under (a session gone), then over again: still the same day and line, no second notification.
    r.note(r.world.remove('s1'));
    await r.clock.advance(TODAY_THROTTLE_MS);
    expect(await r.svc.get()).toMatchObject({ main: 0, over: false });
    expect(await grow(r, 2000)).toMatchObject({ over: true });
    expect(r.crosses).toHaveLength(1);
  });

  test('exactly at the line counts as over', async () => {
    const r = rig({ line: 1000 });
    await r.svc.get();
    expect(await grow(r, 1000)).toMatchObject({ main: 1000, over: true });
    expect(r.crosses).toHaveLength(1);
  });

  test('line raised above today: a later growth past it notifies once; lowered onto an exceeded value: none, over pushed', async () => {
    const r = rig({ line: 1000 });
    await r.svc.get();
    await grow(r, 1200);
    expect(r.crosses).toHaveLength(1);
    r.set.line = 2000;
    r.svc.settingsChanged();
    await flush();
    expect(r.updates.at(-1)).toMatchObject({ main: 1200, lineTokens: 2000, over: false });
    expect(r.store.state()).toEqual({ day: '2026-11-24', line: 2000, over: false });
    expect(r.crosses).toHaveLength(1);
    await grow(r, 900);
    expect(r.crosses).toHaveLength(2);
    expect(r.crosses[1]).toMatchObject({ main: 2100, lineTokens: 2000 });
    r.set.line = 1500;
    r.svc.settingsChanged();
    await flush();
    expect(r.updates.at(-1)).toMatchObject({ main: 2100, lineTokens: 1500, over: true });
    expect(r.crosses).toHaveLength(2);
    // Set where there was none, onto an exceeded value: colour only.
    r.set.line = null;
    r.svc.settingsChanged();
    await flush();
    expect(r.updates.at(-1)).toMatchObject({ lineTokens: null, over: false });
    r.set.line = 500;
    r.svc.settingsChanged();
    await flush();
    expect(r.updates.at(-1)).toMatchObject({ lineTokens: 500, over: true });
    expect(r.crosses).toHaveLength(2);
  });

  test('a settings change never notifies, also when usage grew past the line since the last computation', async () => {
    const r = rig({ line: 1000 });
    await r.svc.get();
    r.note(r.world.turn('s1', T0 - H, 1500, 0));
    r.svc.settingsChanged(); // e.g. the usage switch turned on: no catch-up
    await flush();
    expect(r.updates.at(-1)).toMatchObject({ main: 1500, over: true });
    expect(r.crosses).toEqual([]);
    await grow(r, 100);
    expect(r.crosses).toEqual([]);
  });

  test('not ready (start-up work, import) when crossing: none then, none after it is done', async () => {
    const r = rig({ line: 1000, ready: false });
    await r.svc.get();
    expect(await grow(r, 1500)).toMatchObject({ over: true });
    expect(r.crosses).toEqual([]);
    expect(r.store.state()).toEqual({ day: '2026-11-24', line: 1000, over: true });
    r.set.ready = true;
    await grow(r, 100);
    expect(r.crosses).toEqual([]);
  });

  test('no token data today (Cursor only): main null, never over, never notified', async () => {
    const r = rig({ line: 1 });
    const c = r.world.session('c1', { origin: 'cursor' as Origin });
    r.world.put(c, [r.world.node('c1', T0 - H, { kind: 'prompt', turnId: 'CT' }), r.world.node('c1', T0 - H + 1000, { turnId: 'CT' })]);
    expect(await r.svc.get()).toMatchObject({ main: null, tokens: null, lineTokens: 1, over: false });
    expect(r.crosses).toEqual([]);
  });

  test('restart: stored over for today and this line -> no onCross at start nor later that day; over shown at once', async () => {
    const store = new MetaStore();
    store.setMeta(TODAY_META_KEY, JSON.stringify({ day: '2026-11-24', line: 1000, over: true }));
    const r = rig({ line: 1000, store });
    r.world.turn('s1', T0 - H, 1200, 0);
    expect(await r.svc.get()).toMatchObject({ main: 1200, over: true });
    expect(r.crosses).toEqual([]);
    await grow(r, 100);
    expect(r.crosses).toEqual([]);
  });

  test('restart: crossed while the service was off (stored under) -> baseline, no onCross', async () => {
    const store = new MetaStore();
    store.setMeta(TODAY_META_KEY, JSON.stringify({ day: '2026-11-24', line: 1000, over: false }));
    const r = rig({ line: 1000, store });
    r.world.turn('s1', T0 - H, 1200, 0);
    expect(await r.svc.get()).toMatchObject({ over: true });
    expect(r.crosses).toEqual([]);
    expect(store.state()).toEqual({ day: '2026-11-24', line: 1000, over: true });
  });

  test('restart: state from yesterday -> baseline for today, no onCross; a later growth past the line notifies', async () => {
    const store = new MetaStore();
    store.setMeta(TODAY_META_KEY, JSON.stringify({ day: '2026-11-23', line: 1000, over: true }));
    const r = rig({ line: 1000, store });
    r.world.turn('s1', T0 - H, 1200, 0);
    expect(await r.svc.get()).toMatchObject({ over: true });
    expect(r.crosses).toEqual([]);
    expect(store.state()).toEqual({ day: '2026-11-24', line: 1000, over: true });

    const store2 = new MetaStore();
    store2.setMeta(TODAY_META_KEY, JSON.stringify({ day: '2026-11-23', line: 1000, over: true }));
    const r2 = rig({ line: 1000, store: store2 });
    r2.world.turn('s1', T0 - H, 200, 0);
    expect(await r2.svc.get()).toMatchObject({ over: false });
    expect(store2.state()).toEqual({ day: '2026-11-24', line: 1000, over: false });
    await grow(r2, 900);
    expect(r2.crosses).toHaveLength(1);
  });

  test('a damaged stored state counts as none (baseline)', async () => {
    const store = new MetaStore();
    store.setMeta(TODAY_META_KEY, '{oops');
    const r = rig({ line: 1000, store });
    r.world.turn('s1', T0 - H, 1200, 0);
    expect(await r.svc.get()).toMatchObject({ over: true });
    expect(r.crosses).toEqual([]);
    expect(store.state()).toEqual({ day: '2026-11-24', line: 1000, over: true });
  });
});

describe('TodayService: start-up work', () => {
  const grow = async (r: Rig, tokens: number): Promise<void> => {
    r.note(r.world.turn('s1', T0 - H, tokens, 0));
    await r.clock.advance(TODAY_THROTTLE_MS);
  };

  test('no recompute while start-up work goes on despite changes; one baseline right after it is done; the next crossing reports', async () => {
    const r = rig({ line: 1000, ready: false });
    for (let i = 0; i < 20; i++) {
      r.note(r.world.turn('s1', T0 - H, 100, 0));
      await r.clock.advance(15 * S);
    }
    await r.clock.advance(5 * 60 * S);
    expect(r.world.snapshots).toBe(0);
    expect(r.world.reads).toBe(0);
    // Done: within one check period, one baseline computation (2,000 tokens, over the line: colour only).
    r.set.ready = true;
    await r.clock.advance(TODAY_THROTTLE_MS);
    expect(r.world.snapshots).toBe(1);
    expect(r.updates.at(-1)).toMatchObject({ main: 2000, over: true });
    expect(r.crosses).toEqual([]);
    expect(r.store.state()).toEqual({ day: '2026-11-24', line: 1000, over: true });
    await r.clock.advance(5 * 60 * S);
    expect(r.world.snapshots).toBe(1);
  });

  test('a quiet start (no change, no request): the baseline still runs once start-up is done, so the first change can report', async () => {
    const r = rig({ line: 1000, ready: false });
    r.world.turn('s1', T0 - H, 600, 0);
    await r.clock.advance(2 * 60 * S);
    expect(r.world.snapshots).toBe(0);
    r.set.ready = true;
    await r.clock.advance(TODAY_THROTTLE_MS);
    expect(r.world.snapshots).toBe(1);
    expect(r.updates.at(-1)).toMatchObject({ main: 600, over: false });
    await grow(r, 500);
    expect(r.crosses).toHaveLength(1);
    expect(r.crosses[0]).toMatchObject({ main: 1100, lineTokens: 1000 });
  });

  test('an import later in the day: changes wait, the crossing it causes is consumed by the baseline after it', async () => {
    const r = rig({ line: 1000 });
    await r.svc.get();
    await grow(r, 400);
    const before = r.world.snapshots;
    r.set.ready = false; // importing
    for (let i = 0; i < 10; i++) {
      r.note(r.world.turn('s1', T0 - H, 100, 0));
      await r.clock.advance(10 * S);
    }
    await r.clock.advance(2 * 60 * S);
    expect(r.world.snapshots).toBe(before);
    r.set.ready = true;
    await r.clock.advance(TODAY_THROTTLE_MS);
    expect(r.world.snapshots).toBe(before + 1);
    expect(r.updates.at(-1)).toMatchObject({ main: 1400, over: true });
    expect(r.crosses).toEqual([]);
  });

  test('get() still computes on demand while start-up work goes on (a crossing seen then is consumed)', async () => {
    const r = rig({ line: 1000, ready: false });
    r.world.turn('s1', T0 - H, 400, 0);
    expect(await r.svc.get()).toMatchObject({ main: 400, over: false });
    r.note(r.world.turn('s1', T0 - H, 800, 0));
    await r.clock.advance(TODAY_THROTTLE_MS);
    expect(r.world.snapshots).toBe(1);
    expect(await r.svc.get()).toMatchObject({ main: 1200, over: true });
    expect(r.world.snapshots).toBe(2);
    r.set.ready = true;
    await grow(r, 100);
    expect(r.crosses).toEqual([]);
  });

  test('midnight during start-up work computes nothing; the baseline after it gives the new day', async () => {
    const r = rig({ now: Date.parse('2026-11-24T23:59:00.000Z') });
    await r.svc.get();
    r.set.ready = false;
    r.note(r.world.turn('s1', Date.parse('2026-11-24T23:00:00.000Z'), 5, 5));
    await r.clock.advance(2 * 60 * S);
    expect(r.world.snapshots).toBe(1);
    r.set.ready = true;
    await r.clock.advance(TODAY_THROTTLE_MS);
    expect(r.world.snapshots).toBe(2);
    expect(r.updates.at(-1)!.day).toBe('2026-11-25');
  });
});

describe('TodayService: settingsChanged() while a recompute is in flight', () => {
  test('it is queued after the running one and merged as a baseline into a computation already queued', async () => {
    const r = rig({ line: 1000 });
    let release!: () => void;
    r.world.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = r.svc.get(); // in flight: the snapshot is taken (empty), then held
    await flush();
    r.note(r.world.turn('s1', T0 - H, 1500, 0)); // after its snapshot: needs another computation
    await r.clock.advance(TODAY_THROTTLE_MS); // the throttled one is queued behind the running one
    r.svc.settingsChanged(); // merged into the queued one: it becomes a baseline
    r.world.hold = null;
    release();
    await first;
    await flush();
    expect(r.world.snapshots).toBe(2);
    expect(r.updates.map((u) => u.main)).toEqual([0, 1500]);
    expect(r.updates.at(-1)).toMatchObject({ over: true });
    expect(r.crosses).toEqual([]); // a growth crossing, but judged by the settings' baseline
  });

  test('alone, it runs after the running computation with the line read then', async () => {
    const r = rig({ line: 1000 });
    r.world.turn('s1', T0 - H, 1500, 0);
    await r.svc.get();
    let release!: () => void;
    r.world.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    r.note(r.world.turn('s1', T0 - H, 100, 0));
    await r.clock.advance(TODAY_THROTTLE_MS); // a computation in flight, held
    r.set.line = 3000;
    r.svc.settingsChanged();
    r.world.hold = null;
    release();
    await flush();
    expect(r.world.snapshots).toBe(3);
    expect(r.updates.at(-1)).toMatchObject({ main: 1600, lineTokens: 3000, over: false });
    expect(r.store.state()).toEqual({ day: '2026-11-24', line: 3000, over: false });
    expect(r.crosses).toEqual([]);
  });
});
