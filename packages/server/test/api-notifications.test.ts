import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_NOTIFICATION_SETTINGS, type Diagnostics, type NotificationSettingsResponse } from '@agent-canvas/shared';
import { buildServer } from '../src/api/server.js';
import { start, type Running } from '../src/cli.js';
import { loadConfig, type Config } from '../src/config.js';
import type { DeliveryStatus, NotificationMessage } from '../src/notify/desktop.js';
import { NotificationService, type ServiceNotifier } from '../src/notify/service.js';
import { Pipeline } from '../src/pipeline.js';
import { openStore, type Store } from '../src/store/store.js';

class FakeNotifier implements ServiceNotifier {
  sent: NotificationMessage[] = [];
  failWith: string | null = null;
  async notify(m: NotificationMessage): Promise<void> {
    if (this.failWith !== null) throw new Error(this.failWith);
    this.sent.push(m);
  }
  status(): DeliveryStatus {
    return { available: true, lastError: this.failWith, lastErrorAt: null };
  }
  async close(): Promise<void> {}
}

let tmp: string;

describe('通知接口', () => {
  let config: Config;
  let store: Store;
  let pipeline: Pipeline;
  let notifier: FakeNotifier;
  let service: NotificationService;
  let app: FastifyInstance;
  const enabled = { ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true };

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-notify-api-'));
    config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null, cursorDbPath: null });
    store = openStore(':memory:');
    pipeline = new Pipeline(store, config);
    notifier = new FakeNotifier();
    service = new NotificationService({ store, pipeline, notifier });
    app = buildServer({ store, pipeline, config, notifications: service });
    service.start('http://127.0.0.1:4999');
  });
  afterEach(async () => {
    await service.close();
    await app.close();
    store.close();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  });

  test('GET 设置：默认值和投递状态', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/notifications/settings' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      settings: DEFAULT_NOTIFICATION_SETTINGS,
      status: { available: true, lastError: null, lastErrorAt: null, lastSentAt: null, lastSentKind: null, settingsError: null },
    });
  });

  test('PUT 设置：整体替换，返回新的设置；GET 读回', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/notifications/settings', payload: enabled });
    expect(res.statusCode).toBe(200);
    expect((res.json() as NotificationSettingsResponse).settings).toEqual(enabled);
    expect((await app.inject({ method: 'GET', url: '/api/notifications/settings' })).json().settings).toEqual(enabled);
  });

  test.each([
    ['缺字段', { enabled: true }],
    ['范围外', { ...DEFAULT_NOTIFICATION_SETTINGS, finishedMinSeconds: -1 }],
    ['类型错', { ...DEFAULT_NOTIFICATION_SETTINGS, stuck: 1 }],
    ['数组', [1, 2]],
    ['字符串', 'on'],
  ])('PUT 不合法（%s）：400，设置不变', async (_name, body) => {
    const res = await app.inject({ method: 'PUT', url: '/api/notifications/settings', payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/\S/);
    expect(service.getSettings().settings).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });

  test('PUT 损坏的 JSON 或空的请求体：400', async () => {
    const bad = await app.inject({ method: 'PUT', url: '/api/notifications/settings', payload: '{oops', headers: { 'content-type': 'application/json' } });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/notifications/settings' })).statusCode).toBe(400);
  });

  test('POST 测试通知：成功 { ok: true }；失败也是 200 { ok: false, error }', async () => {
    const ok = await app.inject({ method: 'POST', url: '/api/notifications/test' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect(notifier.sent).toEqual([{ title: 'Agent Canvas 测试通知', body: '通知工作正常。', url: 'http://127.0.0.1:4999/' }]);
    notifier.failWith = '找不到系统命令 notify-send，无法发桌面通知';
    const bad = await app.inject({ method: 'POST', url: '/api/notifications/test' });
    expect(bad.statusCode).toBe(200);
    expect(bad.json()).toEqual({ ok: false, error: notifier.failWith });
  });

  test('只接受来自本机的请求', async () => {
    const foreign = { origin: 'https://evil.example' };
    expect((await app.inject({ method: 'GET', url: '/api/notifications/settings', headers: foreign })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/notifications/settings', payload: enabled, headers: foreign })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/notifications/test', headers: { 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403);
    expect(notifier.sent).toEqual([]);
    expect(service.getSettings().settings).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });

  test('诊断里有通知一行', async () => {
    await app.inject({ method: 'POST', url: '/api/notifications/test' });
    const d = (await app.inject({ method: 'GET', url: '/api/diagnostics' })).json() as Diagnostics;
    expect(d.notifications).toEqual({
      enabled: false,
      available: true,
      lastSentAt: expect.any(String),
      lastSentKind: 'test',
      lastError: null,
      lastErrorAt: null,
      settingsError: null,
    });
  });

  test('hooks：Claude Code 的 StopFailure 在入库之前交给引擎，结果只发“出错中断”', async () => {
    service.putSettings(enabled);
    const hook = (name: string, extra: object = {}) =>
      app.inject({
        method: 'POST',
        url: '/hooks',
        payload: { hook_event_name: name, session_id: 's1', cwd: '/w/tea-shop', transcript_path: path.join(config.projectsDir, '-w-tea-shop', 's1.jsonl'), ...extra },
      });
    await hook('UserPromptSubmit', { prompt: 'hi' });
    await vi.waitFor(() => expect(pipeline.loadedSessionCount()).toBe(1));
    await hook('StopFailure', { error: 'rate_limit' });
    await vi.waitFor(() => expect(notifier.sent).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(notifier.sent.map((m) => m.title)).toEqual(['出错中断 · tea-shop']);
  });
});

describe('hooks 里直接说明出错的事件（修复轮 1）', () => {
  let store: Store;
  let pipeline: Pipeline;
  let notifier: FakeNotifier;
  let service: NotificationService;
  let app: FastifyInstance;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-notify-hooks-'));
    const config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null, cursorDbPath: null });
    store = openStore(':memory:');
    pipeline = new Pipeline(store, config);
    notifier = new FakeNotifier();
    service = new NotificationService({ store, pipeline, notifier, graceMs: 60_000 });
    service.putSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true, finishedMinSeconds: 0 });
    app = buildServer({ store, pipeline, config, notifications: service });
    service.start('http://127.0.0.1:4999');
  });
  afterEach(async () => {
    await service.close();
    await app.close();
    store.close();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  });

  test('Codex 的 Interrupt：立即发出错中断（不等宽限期）', async () => {
    const hook = (name: string, extra: object = {}) =>
      app.inject({
        method: 'POST',
        url: '/hooks?origin=codex',
        payload: { hook_event_name: name, session_id: 'cx1', cwd: '/w/tea-shop', turn_id: 't1', model: 'm', ...extra },
      });
    await hook('UserPromptSubmit', { prompt: 'hi' });
    await vi.waitFor(() => expect(store.getSession('cx1')?.status).toBe('running'));
    await hook('Interrupt');
    await vi.waitFor(() => expect(notifier.sent).toHaveLength(1));
    expect(notifier.sent[0]!.title).toMatch(/^出错中断 · /);
  });
});

describe('start 接线', () => {
  const apps: Running[] = [];
  beforeEach(async () => {
    vi.stubEnv('AGENT_CANVAS_CODEX_DIR', '');
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-notify-start-'));
    await fs.mkdir(path.join(tmp, 'projects'), { recursive: true });
  });
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close().catch(() => undefined);
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
    vi.unstubAllEnvs();
  });

  test('设置可读写并在重启后保留；hook 驱动“等你确认权限”的通知；网址指向会话页', async () => {
    const notifier = new FakeNotifier();
    const overrides = { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), port: 0 };
    const app = await start(overrides, { notifier });
    apps.push(app);
    const put = await fetch(`${app.url}/api/notifications/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true }),
    });
    expect(put.status).toBe(200);
    await vi.waitFor(async () => expect(((await (await fetch(`${app.url}/api/diagnostics`)).json()) as Diagnostics).importing).toBe(false));
    const hook = (name: string, extra: object = {}) =>
      fetch(`${app.url}/hooks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hook_event_name: name,
          session_id: 'sess-1',
          cwd: '/w/tea-shop',
          transcript_path: path.join(overrides.projectsDir, '-w-tea-shop', 'sess-1.jsonl'),
          ...extra,
        }),
      });
    await hook('UserPromptSubmit', { prompt: 'hi' });
    await new Promise((r) => setTimeout(r, 100));
    await hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    await vi.waitFor(() => expect(notifier.sent).toHaveLength(1));
    expect(notifier.sent[0]).toEqual({ title: '等你确认权限 · tea-shop', body: '未命名会话\nClaude Code', url: `${app.url}/#/s/sess-1` });
    apps.splice(0);
    await app.close();

    const again = await start(overrides, { notifier: new FakeNotifier() });
    apps.push(again);
    const got = (await (await fetch(`${again.url}/api/notifications/settings`)).json()) as NotificationSettingsResponse;
    expect(got.settings.enabled).toBe(true);
  });
});
