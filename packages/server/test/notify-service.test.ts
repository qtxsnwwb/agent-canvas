import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { DEFAULT_NOTIFICATION_SETTINGS, type Origin, type SeqChange, type Session } from '@agent-canvas/shared';
import type { DeliveryStatus, NotificationMessage } from '../src/notify/desktop.js';
import { NotificationService, TEST_BODY, TEST_TITLE, TICK_MS, type ServiceNotifier, type Timers } from '../src/notify/service.js';
import { loadNotificationSettings, NOTIFICATIONS_META_KEY } from '../src/notify/settings.js';
import { openStore, type Store } from '../src/store/store.js';
import type { PollSource } from '../src/sources/poll.js';

const T0 = Date.parse('2026-11-12T10:00:00.000Z');

class FakeNotifier implements ServiceNotifier {
  sent: NotificationMessage[] = [];
  failWith: string | null = null;
  closed = false;
  async notify(m: NotificationMessage): Promise<void> {
    if (this.failWith !== null) throw new Error(this.failWith);
    this.sent.push(m);
  }
  status(): DeliveryStatus {
    return { available: this.failWith === null, lastError: this.failWith, lastErrorAt: this.failWith === null ? null : new Date(T0).toISOString() };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakePipeline {
  listeners = new Set<(c: SeqChange[]) => void>();
  importingNow = false;
  polls: PollSource[] = [];
  lastPollAt: string | null = null;
  onChanges(l: (c: SeqChange[]) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  importing(): boolean {
    return this.importingNow;
  }
  pollSources(): readonly PollSource[] {
    return this.polls;
  }
  pollStatus(origin: Origin): { lastPollAt: string | null; lastError: string | null } | null {
    return this.polls.some((p) => p.origin === origin) ? { lastPollAt: this.lastPollAt, lastError: null } : null;
  }
  emit(sessions: Session[]): void {
    const changes = sessions.map((session, i): SeqChange => ({ type: 'session_upserted', session, seq: i + 1 }));
    for (const l of this.listeners) l(changes);
  }
}

let now: number;
let store: Store;
let pipeline: FakePipeline;
let notifier: FakeNotifier;
let ticks: (() => void)[];
let service: NotificationService;
const timers: Timers = {
  setInterval: (fn, ms) => {
    expect(ms).toBe(TICK_MS);
    ticks.push(fn);
    return fn;
  },
  clearInterval: (h) => {
    ticks = ticks.filter((t) => t !== h);
  },
};

const session = (status: Session['status'], over: Partial<Session> = {}): Session => ({
  id: 's1',
  projectId: 'D--w-tea-shop',
  origin: 'claude',
  cwd: 'D:\\w\\tea-shop',
  title: '修登录页',
  gitBranch: null,
  status,
  sourceDeleted: false,
  startedAt: new Date(T0).toISOString(),
  lastActivityAt: new Date(now).toISOString(),
  ...over,
});
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
const make = (): NotificationService =>
  new NotificationService({ store, pipeline: pipeline as never, notifier, now: () => now, timers });

beforeEach(() => {
  now = T0;
  store = openStore(':memory:');
  pipeline = new FakePipeline();
  notifier = new FakeNotifier();
  ticks = [];
  service = make();
});
afterEach(async () => {
  await service.close();
  store.close();
});

describe('设置', () => {
  test('没有保存过：默认值（关闭）', () => {
    expect(service.getSettings()).toEqual({
      settings: DEFAULT_NOTIFICATION_SETTINGS,
      status: { available: true, lastError: null, lastErrorAt: null, lastSentAt: null, lastSentKind: null, settingsError: null },
    });
  });

  test('保存后重启仍在', () => {
    const next = { ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true, stuckMinutes: 30 };
    expect(service.putSettings(next)).toMatchObject({ ok: true, response: { settings: next } });
    expect(JSON.parse(store.getMeta(NOTIFICATIONS_META_KEY)!)).toEqual(next);
    expect(make().getSettings().settings).toEqual(next);
  });

  test('不合法的设置：拒绝，原设置不变', () => {
    const r = service.putSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, stuckMinutes: 0 });
    expect(r.ok).toBe(false);
    expect(store.getMeta(NOTIFICATIONS_META_KEY)).toBeNull();
  });

  test.each([
    ['损坏的 JSON', '{not json', /不是合法的 JSON/],
    ['超出范围', JSON.stringify({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true, finishedMinSeconds: -5 }), /不合法/],
    ['类型不对', JSON.stringify({ enabled: 'yes' }), /不合法/],
  ])('保存的设置%s：按默认值（关闭）处理，并在诊断里说明', (_name, raw, why) => {
    store.setMeta(NOTIFICATIONS_META_KEY, raw);
    const loaded = loadNotificationSettings(store);
    expect(loaded.settings).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    expect(loaded.error).toMatch(why);
    const s = make();
    expect(s.getSettings().settings.enabled).toBe(false);
    expect(s.diagnostics().settingsError).toMatch(why);
    s.putSettings({ ...DEFAULT_NOTIFICATION_SETTINGS });
    expect(s.diagnostics().settingsError).toBeNull();
  });
});

describe('接线', () => {
  beforeEach(() => {
    service.putSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true });
    service.start('http://127.0.0.1:4999/');
  });

  test('变更流驱动引擎，发出的通知交给投递；诊断记下最近一次', async () => {
    pipeline.emit([session('idle')]);
    pipeline.emit([session('running')]);
    now += 1000;
    pipeline.emit([session('awaiting_permission')]);
    await flush();
    expect(notifier.sent).toEqual([{ title: '等你确认权限 · tea-shop', body: '修登录页\nClaude Code', url: 'http://127.0.0.1:4999/#/s/s1' }]);
    expect(service.diagnostics()).toEqual({
      enabled: true,
      available: true,
      lastSentAt: new Date(now).toISOString(),
      lastSentKind: 'permission',
      lastError: null,
      lastErrorAt: null,
      settingsError: null,
    });
  });

  test('项目名取自 API 的项目列表（与页面同名），不是会话自己的 cwd', async () => {
    const sub = { cwd: 'D:\\w\\tea-shop\\packages\\api' };
    store.applyChanges([
      { type: 'session_upserted', session: session('idle', { id: 'other' }) },
      { type: 'session_upserted', session: session('idle', sub) },
    ]);
    pipeline.emit([session('running', sub)]);
    now += 1000;
    pipeline.emit([session('awaiting_permission', sub)]);
    await flush();
    expect(notifier.sent[0]!.title).toBe('等你确认权限 · tea-shop');
  });

  test('项目不在列表里时：按会话的 cwd 命名', async () => {
    pipeline.emit([session('running', { projectId: 'weird-id', cwd: 'D:\\elsewhere' })]);
    now += 1000;
    pipeline.emit([session('awaiting_permission', { projectId: 'weird-id', cwd: 'D:\\elsewhere' })]);
    await flush();
    expect(notifier.sent[0]!.title).toBe('等你确认权限 · elsewhere');
  });

  test('导入期间不发；该来源的轮询还没完成第一轮时不发', async () => {
    pipeline.importingNow = true;
    pipeline.emit([session('running')]);
    now += 1000;
    pipeline.emit([session('awaiting_permission')]);
    pipeline.importingNow = false;
    pipeline.polls = [{ origin: 'cursor' } as PollSource];
    const k = (status: Session['status']): Session => session(status, { id: 'k1', origin: 'cursor' });
    pipeline.emit([k('running')]);
    now += 1000;
    pipeline.emit([k('idle')]);
    pipeline.emit([k('running')]);
    now += 61_000;
    pipeline.emit([k('idle')]);
    await flush();
    expect(notifier.sent).toEqual([]);
    pipeline.lastPollAt = new Date(now).toISOString();
    pipeline.emit([k('running')]);
    now += 61_000;
    pipeline.emit([k('idle')]);
    await flush();
    expect(notifier.sent.map((m) => m.title)).toEqual(['跑完了 · tea-shop']);
  });

  test('定时器驱动卡住检查；close 后停止订阅和定时器', async () => {
    pipeline.emit([session('idle')]);
    pipeline.emit([session('running')]);
    now += 15 * 60_000 + 1;
    expect(ticks).toHaveLength(1);
    ticks[0]!();
    await flush();
    expect(notifier.sent.map((m) => m.title)).toEqual(['卡住了 · tea-shop']);
    await service.close();
    expect(ticks).toHaveLength(0);
    expect(pipeline.listeners.size).toBe(0);
    expect(notifier.closed).toBe(true);
  });

  test('引擎里的异常被拦住：不影响变更流的其它订阅者', () => {
    const other: SeqChange[][] = [];
    pipeline.onChanges((c) => other.push(c));
    const bad = { type: 'session_upserted', session: null, seq: 1 } as unknown as SeqChange;
    expect(() => {
      for (const l of pipeline.listeners) l([bad]);
    }).not.toThrow();
    expect(other).toHaveLength(1);
  });

  test('投递失败：不抛，原因在状态里', async () => {
    notifier.failWith = '找不到系统命令 notify-send，无法发桌面通知';
    pipeline.emit([session('running')]);
    now += 1000;
    pipeline.emit([session('awaiting_permission')]);
    await flush();
    expect(service.getSettings().status).toMatchObject({ available: false, lastError: notifier.failWith, lastSentAt: null });
  });
});

describe('测试通知', () => {
  test('不受总开关限制；固定的标题、正文，网址是首页', async () => {
    service.start('http://127.0.0.1:4999');
    expect(await service.test()).toEqual({ ok: true });
    expect(notifier.sent).toEqual([{ title: TEST_TITLE, body: TEST_BODY, url: 'http://127.0.0.1:4999/' }]);
    expect(TEST_TITLE).toBe('Agent Canvas 测试通知');
    expect(TEST_BODY).toBe('通知工作正常。');
    expect(service.diagnostics()).toMatchObject({ enabled: false, lastSentKind: 'test' });
  });

  test('失败时返回原因', async () => {
    notifier.failWith = 'powershell.exe 退出码 1';
    expect(await service.test()).toEqual({ ok: false, error: 'powershell.exe 退出码 1' });
  });
});

test('StopFailure hook：开始之前忽略，开始后交给引擎', async () => {
  service.putSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true });
  service.handleHook('claude', 'StopFailure', 's1', null);
  service.start('http://127.0.0.1:4999');
  pipeline.emit([session('running')]);
  now += 1000;
  service.handleHook('claude', 'StopFailure', 's1', null);
  pipeline.emit([session('idle')]);
  await flush();
  expect(notifier.sent.map((m) => m.title)).toEqual(['出错中断 · tea-shop']);
});
