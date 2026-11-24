import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_NOTIFICATION_SETTINGS, type ServerMessage, type TodayUsage } from '@agent-canvas/shared';
import { buildServer, createTodayService } from '../src/api/server.js';
import { loadConfig, type Config } from '../src/config.js';
import type { DeliveryStatus, NotificationMessage } from '../src/notify/desktop.js';
import { NotificationService, type ServiceNotifier } from '../src/notify/service.js';
import { Pipeline } from '../src/pipeline.js';
import { StatsService, storeStatsSource } from '../src/stats/service.js';
import { TODAY_THROTTLE_MS, type TodayService } from '../src/stats/today-service.js';
import { openStore, type RawEvent, type Store } from '../src/store/store.js';
import type { Timers } from '../src/timers.js';
import { assistantBlock, userPrompt } from './fixtures.js';

// In-memory store, temp dirs, a fake notifier, a fake clock and fake timers for the today service; port 0 only.

const T0 = Date.parse('2026-11-24T10:00:00.000Z');
const HOST = '127.0.0.1:4999';
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const iso = (ms: number): string => new Date(ms).toISOString();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const linesOf = (events: RawEvent[]): string => events.map((e) => (e.source === 'transcript' ? e.line : '') + '\n').join('');

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

describe('今天的用量接口', () => {
  let tmp: string;
  let config: Config;
  let store: Store;
  let pipeline: Pipeline;
  let notifier: FakeNotifier;
  let notifications: NotificationService;
  let stats: StatsService;
  let today: TodayService;
  let app: FastifyInstance;
  let now: number;
  let pending: { fn: () => void; at: number }[];
  const sockets: WebSocket[] = [];
  const received = new WeakMap<WebSocket, string[]>();

  const timers: Timers = {
    setTimeout: (fn, ms) => {
      const t = { fn, at: now + ms };
      pending.push(t);
      return t;
    },
    clearTimeout: (h) => {
      pending = pending.filter((t) => t !== h);
    },
    setInterval: () => 0,
    clearInterval: () => {},
  };
  /** Moves the fake clock, firing the today service's timers due on the way. */
  async function advance(ms: number): Promise<void> {
    const end = now + ms;
    for (;;) {
      const due = pending.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      pending = pending.filter((t) => t !== due);
      now = Math.max(now, due.at);
      due.fn();
      await sleep(10);
    }
    now = end;
  }

  async function turn(id: string, at: number): Promise<void> {
    const file = path.join(config.projectsDir, 'proj', `${id}.jsonl`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, linesOf([
      userPrompt(`${id}-u${at}`, null, '修一下', { timestamp: iso(at) }),
      assistantBlock(`${id}-a${at}`, `${id}-u${at}`, { type: 'text', text: '好了' }, { timestamp: iso(at + 1000), stopReason: 'end_turn' }),
    ]));
    await pipeline.ingestFile(file);
  }

  async function connect(): Promise<WebSocket> {
    const address = app.server.listening ? `http://127.0.0.1:${(app.server.address() as { port: number }).port}` : await app.listen({ port: 0, host: '127.0.0.1' });
    const ws = new WebSocket(address.replace('http', 'ws') + '/ws');
    sockets.push(ws);
    const raw: string[] = [];
    received.set(ws, raw);
    ws.on('message', (d) => raw.push(d.toString()));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return ws;
  }
  const todayOf = (ws: WebSocket): TodayUsage[] =>
    received.get(ws)!.map((r) => JSON.parse(r) as ServerMessage).flatMap((m) => (m.type === 'today' ? [m.usage] : []));
  const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: HOST } });
  const putSettings = (body: unknown) => app.inject({ method: 'PUT', url: '/api/notifications/settings', headers: { host: HOST }, payload: body as object });

  beforeEach(async () => {
    now = T0;
    pending = [];
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-api-today-'));
    config = loadConfig({}, { deepseekDir: null, workbuddyDirs: [], codebuddyDir: null, doubaoDirs: [], qwenDir: null, geminiDir: null, grokDir: null, copilotDir: null, projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null, cursorDbPath: null });
    store = openStore(':memory:');
    pipeline = new Pipeline(store, config);
    notifier = new FakeNotifier();
    notifications = new NotificationService({ store, pipeline, notifier });
    stats = new StatsService(storeStatsSource(store), { now: () => now, dayKey: utcDay });
    // The start-up work is over unless a test says otherwise (a bare pipeline never runs its initial scan).
    vi.spyOn(pipeline, 'startupDone').mockReturnValue(true);
    today = createTodayService({ store, pipeline, cache: stats.summaryCache(), notifications, now: () => now, dayKey: utcDay, timers });
    app = buildServer({ store, pipeline, config, notifications, stats, today });
    notifications.start('http://127.0.0.1:4999');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const s of sockets.splice(0)) s.terminate();
    await app.close();
    today.close();
    stats.close();
    await notifications.close();
    store.close();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  });

  test('GET /api/today：今天的用量，带提醒线和是否越线（线来自通知设置，0 = 没有线）', async () => {
    await turn('s1', T0 - 3600_000);
    const res = await get('/api/today');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ day: '2026-11-24', turns: 1, main: 15, tokens: { input: 10, cachedInput: 0, output: 5 }, lineTokens: null, over: false });
    expect((await putSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, usageLineTokens: 15 })).statusCode).toBe(200);
    expect((await get('/api/today')).json()).toMatchObject({ main: 15, lineTokens: 15, over: true });
    // Only from this machine, like every route.
    expect((await app.inject({ method: 'GET', url: '/api/today', headers: { host: HOST, origin: 'https://evil.example' } })).statusCode).toBe(403);
  });

  test('WebSocket：sessions 订阅在变化后（节流窗口到时）收到 today；改设置后马上收到；会话订阅收不到', async () => {
    const sessions = await connect();
    const one = await connect();
    sessions.send(JSON.stringify({ type: 'subscribe', scope: 'sessions' }));
    one.send(JSON.stringify({ type: 'subscribe', scope: 'session', sessionId: 's1', sinceSeq: 0 }));
    await sleep(50);
    expect((await get('/api/today')).json()).toMatchObject({ main: 0 });
    await vi.waitFor(() => expect(todayOf(sessions)).toHaveLength(1));

    await turn('s1', T0 - 3600_000);
    await sleep(50);
    expect(todayOf(sessions)).toHaveLength(1); // within the throttle window
    await advance(TODAY_THROTTLE_MS);
    await vi.waitFor(() => expect(todayOf(sessions)).toHaveLength(2));
    expect(todayOf(sessions)[1]).toMatchObject({ day: '2026-11-24', main: 15, lineTokens: null, over: false });

    expect((await putSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true, usageLineTokens: 10 })).statusCode).toBe(200);
    await vi.waitFor(() => expect(todayOf(sessions)).toHaveLength(3));
    expect(todayOf(sessions)[2]).toMatchObject({ main: 15, lineTokens: 10, over: true });
    expect(todayOf(one)).toEqual([]);
    // Setting a line onto an exceeded value never notifies.
    expect(notifier.sent).toEqual([]);
  });

  test('用量涨过线（启动工作已完成、开关都开着）：发一条桌面通知；启动期间涨过线：不发，之后也不补', async () => {
    const done = vi.spyOn(pipeline, 'startupDone').mockReturnValue(false);
    expect((await putSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true, usageLineTokens: 20 })).statusCode).toBe(200);
    await turn('s1', T0 - 3600_000);
    // Within the throttle window the answer is the latest result (computed for the settings change).
    expect((await get('/api/today')).json()).toMatchObject({ main: 0, lineTokens: 20, over: false });
    await advance(TODAY_THROTTLE_MS);
    await vi.waitFor(async () => expect((await get('/api/today')).json()).toMatchObject({ main: 15, over: false }));
    await turn('s1', T0 - 1800_000);
    await advance(TODAY_THROTTLE_MS);
    await vi.waitFor(async () => expect((await get('/api/today')).json()).toMatchObject({ main: 30, over: true }));
    expect(notifier.sent).toEqual([]);

    // Next day, start-up done: growth past the line notifies once.
    done.mockReturnValue(true);
    await advance(Date.parse('2026-11-25T00:00:00.000Z') - now);
    await vi.waitFor(async () => expect((await get('/api/today')).json()).toMatchObject({ day: '2026-11-25', main: 0, over: false }));
    await turn('s1', now);
    await turn('s1', now + 2000);
    await advance(TODAY_THROTTLE_MS);
    await vi.waitFor(() => expect(notifier.sent).toHaveLength(1));
    expect(notifier.sent[0]).toEqual({ title: '今天的用量超过了你设的线', body: '新输入 + 输出 30，提醒线 20', url: 'http://127.0.0.1:4999/#/stats' });
    await turn('s1', now + 4000);
    await advance(TODAY_THROTTLE_MS);
    await sleep(50);
    expect(notifier.sent).toHaveLength(1);
  });

  test('只改了别的设置（例如卡住阈值）：不重算，上次计算之后涨过线的照常提醒', async () => {
    expect((await putSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true, usageLineTokens: 20 })).statusCode).toBe(200);
    await turn('s1', T0 - 3600_000);
    await turn('s1', T0 - 1800_000);
    expect((await putSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true, usageLineTokens: 20, stuckMinutes: 30 })).statusCode).toBe(200);
    await advance(TODAY_THROTTLE_MS);
    await vi.waitFor(() => expect(notifier.sent).toHaveLength(1));
    expect(notifier.sent[0]!.body).toBe('新输入 + 输出 30，提醒线 20');
  });

  test('打开用量提醒之前涨过线的：打开时不补发，之后也不发', async () => {
    expect((await putSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true, usage: false, usageLineTokens: 20 })).statusCode).toBe(200);
    await turn('s1', T0 - 3600_000);
    await turn('s1', T0 - 1800_000);
    expect((await putSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true, usage: true, usageLineTokens: 20 })).statusCode).toBe(200);
    await vi.waitFor(async () => expect((await get('/api/today')).json()).toMatchObject({ main: 30, over: true }));
    await advance(TODAY_THROTTLE_MS);
    await turn('s1', T0 - 900_000);
    await advance(TODAY_THROTTLE_MS);
    await sleep(50);
    expect(notifier.sent).toEqual([]);
  });

  test('没有通知服务的服务器（嵌入、测试）：线从存着的通知设置读', async () => {
    const plain = new Pipeline(store, config);
    const other = buildServer({ store, pipeline: plain, config });
    try {
      store.setMeta('notifications', JSON.stringify({ ...DEFAULT_NOTIFICATION_SETTINGS, usageLineTokens: 1_000 }));
      const res = await other.inject({ method: 'GET', url: '/api/today', headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ lineTokens: 1_000, over: false });
    } finally {
      await other.close();
    }
  });
});
