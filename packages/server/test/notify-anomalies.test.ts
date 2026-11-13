import { beforeEach, describe, expect, test } from 'vitest';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type Anomaly,
  type NotificationSettings,
  type Origin,
  type Session,
  type SessionStatus,
} from '@agent-canvas/shared';
import type { DeliveryStatus, NotificationMessage } from '../src/notify/desktop.js';
import { NotificationEngine } from '../src/notify/engine.js';
import { NotificationService, type ServiceNotifier } from '../src/notify/service.js';
import { loadNotificationSettings, NOTIFICATIONS_META_KEY } from '../src/notify/settings.js';
import { openStore } from '../src/store/store.js';

/*
 * Anomaly notifications (spec 5): `loop` and `failures` of running sessions, fresh (≤ 2 minutes), once per session +
 * anomaly id (= turn + kind) for the life of the process; the first summary of a session after start only seeds what
 * was already there (start-up import, restart, rebuild never notify), yet an anomaly that arose after start notifies.
 */

const T0 = Date.parse('2026-11-13T10:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

let now: number;
let settings: NotificationSettings;
let suppressed: Set<Origin>;
let engine: NotificationEngine;

function session(id: string, status: SessionStatus = 'running', over: Partial<Session> = {}): Session {
  return {
    id, projectId: 'D--w-tea-shop', origin: 'claude', cwd: 'D:\\w\\tea-shop', title: '修一下登录页', gitBranch: null, status,
    sourceDeleted: false, startedAt: iso(T0 - 3_600_000), lastActivityAt: iso(now), ...over,
  };
}

function anomaly(kind: Anomaly['kind'], turnKey: string, atMs: number, over: Partial<Anomaly> = {}): Anomaly {
  const basis = kind === 'loop' ? 'failed' : kind === 'failures' ? 'streak' : kind === 'churn' ? 'edits' : 'time';
  return {
    id: `${kind}:${turnKey}`, kind, sessionId: 's1', agentId: null, turnKey, basis, count: 3,
    firstNodeId: `${turnKey}-first`, lastNodeId: `${turnKey}/last node`, at: iso(atMs), ...over,
  };
}

const make = (): NotificationEngine =>
  new NotificationEngine({
    now: () => now,
    settings: () => settings,
    suppressed: (o) => suppressed.has(o),
    projectName: () => 'tea-shop',
    sessionUrl: (id) => `http://127.0.0.1:4999/#/s/${encodeURIComponent(id)}`,
    nodeUrl: (id, nodeId) => `http://127.0.0.1:4999/#/s/${encodeURIComponent(id)}/n/${encodeURIComponent(nodeId)}`,
  });

beforeEach(() => {
  now = T0;
  settings = { ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true, loop: true, failures: true };
  suppressed = new Set();
  engine = make(); // "the service starts" at T0
});

describe('anomaly notifications', () => {
  test('a new loop in a running session after start: one notification, title / body / node address', () => {
    expect(engine.handleAnomalies(session('s1'), [], Infinity)).toEqual([]); // first summary: nothing yet
    now = T0 + 60_000;
    const out = engine.handleAnomalies(session('s1'), [anomaly('loop', 'T1', now - 5_000)], Infinity);
    expect(out).toEqual([{
      kind: 'loop', sessionId: 's1', title: '原地打转 · tea-shop', body: '修一下登录页\n同一个调用失败了 3 次 · Claude Code',
      url: 'http://127.0.0.1:4999/#/s/s1/n/T1%2Flast%20node',
    }]);
  });

  test('the count growing 3 → 4 → 5 notifies once; a second loop in a later turn notifies again; failures too', () => {
    engine.handleAnomalies(session('s1'), [], Infinity);
    now = T0 + 10_000;
    expect(engine.handleAnomalies(session('s1'), [anomaly('loop', 'T1', now)], Infinity)).toHaveLength(1);
    now += 3_000;
    expect(engine.handleAnomalies(session('s1'), [anomaly('loop', 'T1', now - 3_000, { count: 4 })], Infinity)).toEqual([]);
    now += 3_000;
    expect(engine.handleAnomalies(session('s1'), [anomaly('loop', 'T1', now - 6_000, { count: 5 })], Infinity)).toEqual([]);
    now += 60_000;
    const out = engine.handleAnomalies(session('s1'), [anomaly('loop', 'T1', T0 + 10_000, { count: 5 }), anomaly('loop', 'T2', now), anomaly('failures', 'T2', now)], Infinity);
    expect(out.map((n) => [n.kind, n.url.split('/n/')[1]])).toEqual([['loop', 'T2%2Flast%20node'], ['failures', 'T2%2Flast%20node']]);
    expect(out[1]!.body).toBe('修一下登录页\n连续 3 次调用失败 · Claude Code');
    expect(out[1]!.title).toBe('失败扎堆 · tea-shop');
  });

  test('start-up import / restart: the first summary of a session never notifies what happened before start', () => {
    // Imported history and a loop 30 s before the restart (still running): seeded, not notified.
    now = T0 + 5_000;
    expect(engine.handleAnomalies(session('s1'), [anomaly('loop', 'T0', T0 - 400 * 86_400_000), anomaly('loop', 'T1', T0 - 30_000)], Infinity)).toEqual([]);
    // The restarted loop keeps going: same id, never notified.
    now = T0 + 20_000;
    expect(engine.handleAnomalies(session('s1'), [anomaly('loop', 'T0', T0 - 400 * 86_400_000), anomaly('loop', 'T1', T0 - 30_000, { count: 6 })], Infinity)).toEqual([]);
  });

  test('restart mid-loop below the threshold: the anomaly reached after start notifies, even in the first summary', () => {
    now = T0 + 30_000;
    const out = engine.handleAnomalies(session('s1'), [anomaly('loop', 'T1', T0 + 25_000)], Infinity);
    expect(out.map((n) => n.kind)).toEqual(['loop']);
  });

  test('a rebuild (every session summarised again, same ids): nothing', () => {
    engine.handleAnomalies(session('s1'), [], Infinity);
    now = T0 + 10_000;
    expect(engine.handleAnomalies(session('s1'), [anomaly('loop', 'T1', now)], Infinity)).toHaveLength(1);
    now += 30_000;
    // The rebuild re-derives the same nodes: the same anomaly ids, now with the import flag on.
    suppressed.add('claude');
    expect(engine.handleAnomalies(session('s1'), [anomaly('loop', 'T1', T0 + 10_000)], Infinity)).toEqual([]);
    suppressed.clear();
    expect(engine.handleAnomalies(session('s1'), [anomaly('loop', 'T1', T0 + 10_000)], Infinity)).toEqual([]);
  });

  test('while imports are suppressed, a new anomaly is not notified (and not later either)', () => {
    engine.handleAnomalies(session('s1'), [], Infinity);
    now = T0 + 10_000;
    suppressed.add('claude');
    expect(engine.handleAnomalies(session('s1'), [anomaly('loop', 'T1', now)], Infinity)).toEqual([]);
    suppressed.clear();
    expect(engine.handleAnomalies(session('s1'), [anomaly('loop', 'T1', now)], Infinity)).toEqual([]);
  });

  test('older than 2 minutes: nothing', () => {
    engine.handleAnomalies(session('s1'), [], Infinity);
    now = T0 + 10 * 60_000;
    expect(engine.handleAnomalies(session('s1'), [anomaly('loop', 'T1', now - 120_001)], Infinity)).toEqual([]);
    expect(engine.handleAnomalies(session('s1'), [anomaly('loop', 'T2', now - 120_000)], Infinity)).toHaveLength(1);
  });

  test('a session not running: nothing', () => {
    engine.handleAnomalies(session('s1', 'idle'), [], null);
    now = T0 + 10_000;
    expect(engine.handleAnomalies(session('s1', 'idle'), [anomaly('loop', 'T1', now)], null)).toEqual([]);
  });

  test('the switch of the kind off, or the master switch off: nothing (and not later when switched on)', () => {
    engine.handleAnomalies(session('s1'), [], Infinity);
    now = T0 + 10_000;
    settings = { ...settings, loop: false };
    expect(engine.handleAnomalies(session('s1'), [anomaly('loop', 'T1', now)], Infinity)).toEqual([]);
    expect(engine.handleAnomalies(session('s1'), [anomaly('failures', 'T1', now)], Infinity)).toHaveLength(1);
    settings = { ...settings, loop: true, enabled: false };
    expect(engine.handleAnomalies(session('s1'), [anomaly('loop', 'T2', now)], Infinity)).toEqual([]);
    settings = { ...settings, enabled: true };
    expect(engine.handleAnomalies(session('s1'), [anomaly('loop', 'T1', now), anomaly('loop', 'T2', now)], Infinity)).toEqual([]);
  });

  test('defaults: both switches off', () => {
    settings = { ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true };
    engine.handleAnomalies(session('s1'), [], Infinity);
    now = T0 + 10_000;
    expect(engine.handleAnomalies(session('s1'), [anomaly('loop', 'T1', now), anomaly('failures', 'T1', now)], Infinity)).toEqual([]);
  });

  test('churn and cost never notify; a deleted source never notifies', () => {
    engine.handleAnomalies(session('s1'), [], Infinity);
    now = T0 + 10_000;
    expect(engine.handleAnomalies(session('s1'), [anomaly('churn', 'T1', now), anomaly('cost', 'T1', now)], Infinity)).toEqual([]);
    expect(engine.handleAnomalies(session('s1', 'running', { sourceDeleted: true }), [anomaly('loop', 'T1', now)], Infinity)).toEqual([]);
  });

  test('sessions are independent: the same anomaly id in another session is its own', () => {
    engine.handleAnomalies(session('s1'), [], Infinity);
    engine.handleAnomalies(session('s2'), [], Infinity);
    now = T0 + 10_000;
    expect(engine.handleAnomalies(session('s1'), [anomaly('loop', 'T1', now)], Infinity)).toHaveLength(1);
    expect(engine.handleAnomalies(session('s2'), [anomaly('loop', 'T1', now, { sessionId: 's2' })], Infinity)).toHaveLength(1);
  });

  test('an untitled session and a node URL that cannot be built fall back as the other kinds do', () => {
    const e = new NotificationEngine({
      now: () => now, settings: () => settings, suppressed: () => false, projectName: () => 'tea-shop',
      sessionUrl: (id) => `http://127.0.0.1:4999/#/s/${id}`,
      nodeUrl: () => { throw new Error('no'); },
    });
    e.handleAnomalies(session('s1', 'running', { title: null }), [], Infinity);
    now = T0 + 10_000;
    const [n] = e.handleAnomalies(session('s1', 'running', { title: null }), [anomaly('loop', 'T1', now)], Infinity);
    expect(n).toMatchObject({ body: '未命名会话\n同一个调用失败了 3 次 · Claude Code', url: 'http://127.0.0.1:4999/#/s/s1' });
  });
});

describe('anomaly notifications: fix round 1', () => {
  test('burst: four parallel subagents and the main thread failing at once give one notification per kind', () => {
    engine.handleAnomalies(session('s1'), [], Infinity);
    now = T0 + 30_000;
    const threads = ['T1', 'ag1:__prelude__', 'ag2:__prelude__', 'ag3:__prelude__', 'ag4:__prelude__'];
    const all = threads.flatMap((t, i) => [
      anomaly('loop', t, now - 5_000 + i * 100, { agentId: i === 0 ? null : `ag${i}` }),
      anomaly('failures', t, now - 4_000 + i * 100, { agentId: i === 0 ? null : `ag${i}`, count: 5 }),
    ]);
    const out = engine.handleAnomalies(session('s1'), all, Infinity);
    expect(out.map((n) => n.kind)).toEqual(['loop', 'failures']);
    expect(out[0]!.body).toBe('修一下登录页\n同一个调用失败了 3 次，等 5 处 · Claude Code');
    expect(out[1]!.body).toBe('修一下登录页\n连续 5 次调用失败，等 5 处 · Claude Code');
    // The most recent one is the click target.
    expect(out[0]!.url).toContain(`/n/${encodeURIComponent('ag4:__prelude__/last node')}`);
    // The others were seen: they never fire later.
    now += 60_000;
    expect(engine.handleAnomalies(session('s1'), all, Infinity)).toEqual([]);
  });

  test('30 s per session and kind: a second loop within 30 s is dropped (and never sent later); after 30 s it goes', () => {
    engine.handleAnomalies(session('s1'), [], Infinity);
    now = T0 + 10_000;
    expect(engine.handleAnomalies(session('s1'), [anomaly('loop', 'T1', now)], Infinity)).toHaveLength(1);
    now += 20_000;
    expect(engine.handleAnomalies(session('s1'), [anomaly('loop', 'T1', T0 + 10_000), anomaly('loop', 'T2', now)], Infinity)).toEqual([]);
    expect(engine.handleAnomalies(session('s2'), [anomaly('loop', 'T2', now, { sessionId: 's2' })], Infinity)).toHaveLength(1);
    now += 11_000;
    expect(engine.handleAnomalies(session('s1'), [anomaly('loop', 'T2', now - 11_000)], Infinity)).toEqual([]);
    expect(engine.handleAnomalies(session('s1'), [anomaly('loop', 'T3', now)], Infinity)).toHaveLength(1);
  });

  test('history never notifies, also when it arrives after an earlier summary of the session (restart, page open)', () => {
    now = T0 + 5_000;
    expect(engine.handleAnomalies(session('s1'), [], Infinity)).toEqual([]); // a page asked during the import
    now = T0 + 20_000;
    expect(engine.handleAnomalies(session('s1'), [anomaly('loop', 'T1', T0 - 30_000)], Infinity)).toEqual([]);
  });

  test('nothing until the start-up work is over; what arose meanwhile never notifies', () => {
    let ready = false;
    const e = new NotificationEngine({
      now: () => now, settings: () => settings, suppressed: () => false, projectName: () => 'tea-shop',
      sessionUrl: (id) => `http://127.0.0.1:4999/#/s/${id}`, anomaliesReady: () => ready,
    });
    now = T0 + 10_000;
    expect(e.handleAnomalies(session('s1'), [anomaly('loop', 'T1', now)], Infinity)).toEqual([]);
    ready = true;
    now += 1_000;
    expect(e.handleAnomalies(session('s1'), [anomaly('loop', 'T1', now - 1_000)], Infinity)).toEqual([]);
    expect(e.handleAnomalies(session('s1'), [anomaly('loop', 'T2', now)], Infinity)).toHaveLength(1);
  });

  test('future-dated beyond 60 s: not fresh', () => {
    now = T0 + 5_000;
    expect(engine.handleAnomalies(session('s1'), [anomaly('loop', 'T1', now + 3_600_000)], Infinity)).toEqual([]);
    expect(engine.handleAnomalies(session('s1'), [anomaly('loop', 'T2', now + 60_000)], Infinity)).toHaveLength(1);
  });

  test('a switch turned on never sends what happened before it, whether or not a summary saw it meanwhile', () => {
    const off = { ...settings, loop: false };
    settings = off;
    engine.handleAnomalies(session('s1'), [], Infinity);
    now = T0 + 60_000; // the loop happens while the switch is off; nobody summarises it
    const loopAt = now;
    now = T0 + 150_000;
    settings = { ...off, loop: true };
    engine.anomalySwitchedOn('loop', now);
    expect(engine.handleAnomalies(session('s1'), [anomaly('loop', 'T1', loopAt)], Infinity)).toEqual([]);
    now += 5_000;
    expect(engine.handleAnomalies(session('s1'), [anomaly('loop', 'T2', now)], Infinity)).toHaveLength(1);
  });

  test('the running grace counts only when the session was seen running at or after the anomaly', () => {
    engine.handleAnomalies(session('s1', 'idle'), [], null);
    now = T0 + 10_000;
    expect(engine.handleAnomalies(session('s1', 'idle'), [anomaly('loop', 'T1', now - 2_000)], now - 3_000)).toEqual([]);
    expect(engine.handleAnomalies(session('s1', 'idle'), [anomaly('loop', 'T2', now - 2_000)], now - 1_000)).toHaveLength(1);
  });
});

describe('NotificationService: anomaly kinds', () => {
  class FakeNotifier implements ServiceNotifier {
    sent: NotificationMessage[] = [];
    async notify(m: NotificationMessage): Promise<void> {
      this.sent.push(m);
    }
    status(): DeliveryStatus {
      return { available: true, lastError: null, lastErrorAt: null };
    }
    async close(): Promise<void> {}
  }
  const pipeline = {
    onChanges: () => () => {},
    importing: () => false,
    pollSources: () => [],
    pollStatus: () => null,
  };
  const noTimers = { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} };

  test('settings: stored ones without the new switches read them as off; PUT accepts and persists them', async () => {
    const store = openStore(':memory:');
    try {
      const { enabled: _e, loop: _l, failures: _f, ...old } = { ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true, loop: true, failures: true };
      store.setMeta(NOTIFICATIONS_META_KEY, JSON.stringify({ ...old, enabled: true }));
      const svc = new NotificationService({ store, pipeline: pipeline as never, notifier: new FakeNotifier(), timers: noTimers });
      expect(svc.getSettings().settings).toMatchObject({ enabled: true, loop: false, failures: false });
      expect(svc.getSettings().status.settingsError).toBeNull();
      expect(svc.wantsAnomalies()).toBe(false);
      const r = svc.putSettings({ ...svc.getSettings().settings, failures: true });
      expect(r.ok).toBe(true);
      expect(svc.wantsAnomalies()).toBe(true);
      expect(loadNotificationSettings(store).settings).toMatchObject({ loop: false, failures: true });
      expect(svc.putSettings({ ...svc.getSettings().settings, enabled: false }).ok).toBe(true);
      expect(svc.wantsAnomalies()).toBe(false);
      await svc.close();
    } finally {
      store.close();
    }
  });

  test('handleAnomalies delivers through the notifier with the node address on this server, and records the kind', async () => {
    const store = openStore(':memory:');
    try {
      const notifier = new FakeNotifier();
      const svc = new NotificationService({ store, pipeline: pipeline as never, notifier, timers: noTimers, now: () => now });
      svc.putSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true, loop: true });
      svc.start('http://127.0.0.1:4999');
      svc.handleAnomalies({ session: session('s 1'), anomalies: [], runningUntil: Infinity });
      now = T0 + 5_000;
      svc.handleAnomalies({ session: session('s 1'), anomalies: [anomaly('loop', 'T1', now, { sessionId: 's 1' })], runningUntil: Infinity });
      await new Promise((r) => setImmediate(r));
      expect(notifier.sent).toEqual([{
        title: '原地打转 · tea-shop', body: '修一下登录页\n同一个调用失败了 3 次 · Claude Code',
        url: 'http://127.0.0.1:4999/#/s/s%201/n/T1%2Flast%20node',
      }]);
      expect(svc.getSettings().status.lastSentKind).toBe('loop');
      // Turned off and on again: an anomaly from before it was turned back on never notifies.
      svc.putSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true, loop: false });
      now = T0 + 40_000;
      const before = now - 1_000;
      svc.putSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true, loop: true });
      svc.handleAnomalies({ session: session('s 1'), anomalies: [anomaly('loop', 'T2', before, { sessionId: 's 1' })], runningUntil: Infinity });
      await new Promise((r) => setImmediate(r));
      expect(notifier.sent).toHaveLength(1);
      await svc.close();
    } finally {
      store.close();
    }
  });
});
