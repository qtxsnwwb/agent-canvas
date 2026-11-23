import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type AttentionItem,
  type AttentionResponse,
  type Change,
  type GraphNode,
  type ServerMessage,
  type Session,
  type SessionStatus,
} from '@agent-canvas/shared';
import { ATTENTION_META_KEY, AttentionService } from '../src/attention/service.js';
import { ATTENTION_NOT_READY, ATTENTION_TICK_MS, AttentionSlot, buildServer, createAttentionService } from '../src/api/server.js';
import { start, type Running } from '../src/cli.js';
import { loadConfig, type Config } from '../src/config.js';
import { ABORTED_NOTE } from '../src/normalize/cursor.js';
import type { DeliveryStatus, NotificationMessage } from '../src/notify/desktop.js';
import type { ServiceNotifier } from '../src/notify/service.js';
import { saveNotificationSettings } from '../src/notify/settings.js';
import { Pipeline } from '../src/pipeline.js';
import { openStore, type RawEvent, type Store } from '../src/store/store.js';
import { assistantBlock, toolResult, userPrompt } from './fixtures.js';

// In-memory stores and temp dirs only; the injected services push without delay (coalesceMs 0).

const HOST = '127.0.0.1:4999';
const ORIGIN = `http://${HOST}`;
const WRITE_HEADERS = { host: HOST, origin: ORIGIN, 'content-type': 'application/json' };
const EMPTY: AttentionResponse = { items: [], hidden: [], hiddenCount: 0, undeterminable: [], runningCount: 0, autoHideHours: 24 };
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number): string => new Date(ms).toISOString();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const linesOf = (events: RawEvent[]): string => events.map((e) => (e.source === 'transcript' ? e.line : '') + '\n').join('');

/** The three write routes, each with a valid body. */
const WRITES = [
  ['POST', '/api/attention/dismiss', { key: 's1|finished|2026-11-20T10:00:00.000Z' }],
  ['POST', '/api/attention/restore', { key: 's1|finished|2026-11-20T10:00:00.000Z' }],
  ['PUT', '/api/attention/settings', { autoHideHours: 48 }],
] as const;

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

function configFor(tmp: string): Config {
  return loadConfig({}, { deepseekDir: null, workbuddyDirs: [], codebuddyDir: null, doubaoDirs: [], qwenDir: null, geminiDir: null, grokDir: null, copilotDir: null, projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null, cursorDbPath: null });
}

function sessionRow(id: string, status: SessionStatus, at: number, over: Partial<Session> = {}): Session {
  return { id, projectId: 'D--w-tea-shop', origin: 'claude', cwd: 'D:\\w\\tea-shop', title: `会话 ${id}`, gitBranch: null, status, sourceDeleted: false, startedAt: iso(at), lastActivityAt: iso(at), ...over };
}
function nodeRow(sessionId: string, id: string, at: number, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    sessionId,
    turnId: null,
    agentId: null,
    childAgentId: null,
    parentId: null,
    kind: 'text',
    status: null,
    timestamp: iso(at),
    confirmed: true,
    title: 'Text',
    summary: '',
    toolName: null,
    toolUseId: null,
    messageId: null,
    durationMs: null,
    endedAt: null,
    usage: null,
    systemSubtype: null,
    ...over,
  };
}
const addNode = (n: GraphNode, detail: Record<string, unknown> = {}): Change => ({ type: 'node_added', node: n, detail });
const promptAt = (sid: string, id: string, at: number): Change => addNode(nodeRow(sid, id, at, { kind: 'prompt', title: 'Prompt', summary: '帮我修一下' }));

describe('待处理接口', () => {
  let tmp: string;
  let config: Config;
  let store: Store;
  let pipeline: Pipeline;
  let svc: AttentionService;
  let app: FastifyInstance;
  const extraApps: FastifyInstance[] = [];
  const extraServices: AttentionService[] = [];
  const sockets: WebSocket[] = [];
  const received = new WeakMap<WebSocket, string[]>();

  const abs = (rel: string): string => path.join(config.projectsDir, ...rel.split('/'));
  async function write(rel: string, events: RawEvent[]): Promise<void> {
    await fs.mkdir(path.dirname(abs(rel)), { recursive: true });
    await fs.appendFile(abs(rel), linesOf(events));
    await pipeline.ingestFile(abs(rel));
  }
  /** Claude Code session `s1` whose turn ended a minute ago with a reply. */
  async function finishedTurn(): Promise<AttentionItem> {
    const t = Date.now() - MIN;
    await write('proj/s1.jsonl', [
      userPrompt('u1', null, '修一下', { timestamp: iso(t) }),
      assistantBlock('a1', 'u1', { type: 'text', text: '已经改好，测试全部通过' }, { timestamp: iso(t + 1000), stopReason: 'end_turn' }),
    ]);
    const { items } = svc.snapshot();
    expect(items).toHaveLength(1);
    return items[0]!;
  }
  const get = (url: string, a: FastifyInstance = app) => a.inject({ method: 'GET', url, headers: { host: HOST } });
  const send = (method: 'POST' | 'PUT', url: string, body: unknown, headers: Record<string, string> = WRITE_HEADERS, a: FastifyInstance = app) =>
    a.inject({ method, url, headers, payload: typeof body === 'string' ? body : JSON.stringify(body) });

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
  const messagesOf = (ws: WebSocket): ServerMessage[] => received.get(ws)!.map((r) => JSON.parse(r) as ServerMessage);
  const attentionOf = (ws: WebSocket): AttentionResponse[] => messagesOf(ws).flatMap((m) => (m.type === 'attention' ? [m.response] : []));
  const changesOf = (ws: WebSocket): number => messagesOf(ws).filter((m) => m.type === 'changes').length;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-api-attention-'));
    config = configFor(tmp);
    await fs.mkdir(config.projectsDir, { recursive: true });
    store = openStore(':memory:');
    pipeline = new Pipeline(store, config);
    svc = createAttentionService(store, { coalesceMs: 0 });
    app = buildServer({ store, pipeline, config, attention: svc });
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const s of sockets.splice(0)) s.terminate();
    await app.close();
    for (const a of extraApps.splice(0)) await a.close();
    svc.close();
    for (const s of extraServices.splice(0)) s.close();
    store.close();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  });

  test('GET：没有会话时是空的；不缓存', async () => {
    const res = await get('/api/attention');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(EMPTY);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('GET：主列表；?hidden=1 才带已移出的列表', async () => {
    const item = await finishedTurn();
    expect(item).toMatchObject({ sessionId: 's1', kind: 'finished', explanation: '已经改好，测试全部通过' });
    expect((await get('/api/attention')).json()).toEqual({ ...EMPTY, items: [item] });
    expect(svc.dismiss(item.key)).toEqual({ ok: true });
    expect((await get('/api/attention')).json()).toEqual({ ...EMPTY, hiddenCount: 1 });
    expect((await get('/api/attention?hidden=0')).json()).toEqual({ ...EMPTY, hiddenCount: 1 });
    expect((await get('/api/attention?hidden=1')).json()).toEqual({ ...EMPTY, hidden: [{ item, reason: 'dismissed' }], hiddenCount: 1 });
  });

  test('POST 知道了 / 撤销：答复是不带已移出列表的当前状态，并存进数据库', async () => {
    const item = await finishedTurn();
    const dismissed = await send('POST', '/api/attention/dismiss', { key: item.key });
    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.headers['cache-control']).toBe('no-store');
    expect(dismissed.json()).toEqual({ ...EMPTY, hiddenCount: 1 });
    expect(JSON.parse(store.getMeta(ATTENTION_META_KEY)!)).toEqual({ autoHideHours: 24, dismissed: [item.key] });
    // Twice: still fine.
    expect((await send('POST', '/api/attention/dismiss', { key: item.key })).statusCode).toBe(200);
    const restored = await send('POST', '/api/attention/restore', { key: item.key });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toEqual({ ...EMPTY, items: [item] });
    expect(JSON.parse(store.getMeta(ATTENTION_META_KEY)!)).toEqual({ autoHideHours: 24, dismissed: [] });
  });

  test('PUT 时限：答复新的状态；GET 读回；存进数据库', async () => {
    await finishedTurn();
    const res = await send('PUT', '/api/attention/settings', { autoHideHours: 48 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ autoHideHours: 48, hidden: [] });
    expect(res.json().items).toHaveLength(1);
    expect((await get('/api/attention')).json().autoHideHours).toBe(48);
    expect(JSON.parse(store.getMeta(ATTENTION_META_KEY)!).autoHideHours).toBe(48);
  });

  test.each([
    ['不在列表里的 key', '/api/attention/dismiss', { key: 's1|finished|2026-11-20T10:00:00.000Z' }, '这一项已不在列表里'],
    ['没有 key', '/api/attention/dismiss', {}, null],
    ['key 不是字符串', '/api/attention/dismiss', { key: 5 }, null],
    ['空的 key', '/api/attention/dismiss', { key: '' }, null],
    ['数组', '/api/attention/dismiss', ['s1|finished|x'], null],
    ['没被移出的 key', '/api/attention/restore', { key: 'KEY' }, '这一项没有被移出'],
    ['撤销时没有 key', '/api/attention/restore', { other: 1 }, null],
  ])('知道了 / 撤销 不合法（%s）：400，不改状态', async (_name, url, body, error) => {
    const item = await finishedTurn();
    const payload = JSON.parse(JSON.stringify(body).replace('KEY', item.key)) as unknown;
    const res = await send('POST', url, payload);
    expect(res.statusCode).toBe(400);
    if (error !== null) expect(res.json()).toEqual({ error });
    else expect(res.json().error).toMatch(/\S/);
    expect(store.getMeta(ATTENTION_META_KEY)).toBeNull();
    expect(svc.snapshot().items).toEqual([item]);
  });

  test.each([
    ['0', { autoHideHours: 0 }],
    ['721', { autoHideHours: 721 }],
    ['小数', { autoHideHours: 1.5 }],
    ['字符串', { autoHideHours: '24' }],
    ['null', { autoHideHours: null }],
    ['缺字段', {}],
    ['不是对象', 24],
  ])('PUT 时限不合法（%s）：400，不改', async (_name, body) => {
    const res = await send('PUT', '/api/attention/settings', body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/时限/);
    expect(store.getMeta(ATTENTION_META_KEY)).toBeNull();
    expect((await get('/api/attention')).json().autoHideHours).toBe(24);
  });

  test('损坏的 JSON、空的请求体：400', async () => {
    for (const [method, url] of WRITES) {
      expect((await send(method, url, '{oops')).statusCode, url).toBe(400);
      expect((await app.inject({ method, url, headers: WRITE_HEADERS })).statusCode, url).toBe(400);
    }
  });

  test.each([
    ['没有 Origin', { origin: '' }],
    ['别的网站的 Origin', { origin: 'https://evil.example' }],
    ['回环地址但端口不同', { origin: 'http://127.0.0.1:5000' }],
    ['回环地址但主机名不同', { origin: 'http://localhost:4999' }],
    ['Origin 是 null', { origin: 'null' }],
    ['表单提交', { 'content-type': 'application/x-www-form-urlencoded' }],
    ['纯文本', { 'content-type': 'text/plain' }],
    ['跨站', { 'sec-fetch-site': 'cross-site' }],
  ])('写接口只接受本页面的 JSON 请求（%s）：403，不改状态', async (_name, headers) => {
    const item = await finishedTurn();
    const h: Record<string, string> = { ...WRITE_HEADERS };
    for (const [k, v] of Object.entries(headers)) {
      if (v === '') delete h[k];
      else h[k] = v;
    }
    for (const [method, url, body] of WRITES) {
      const res = await send(method, url, url.endsWith('dismiss') ? { key: item.key } : body, h);
      expect(res.statusCode, url).toBe(403);
    }
    expect(store.getMeta(ATTENTION_META_KEY)).toBeNull();
    expect(svc.snapshot()).toEqual({ ...EMPTY, items: [item] });
  });

  test('GET 也只接受本机的请求', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/attention', headers: { host: HOST, origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/attention', headers: { host: 'evil.example' } })).statusCode).toBe(403);
  });

  test('数据库整理（写入被挡住）期间：三个写接口 503，不改状态；之后照常', async () => {
    const item = await finishedTurn();
    const release = pipeline.holdWrites();
    try {
      for (const [method, url, body] of WRITES) {
        const res = await send(method, url, url.endsWith('dismiss') ? { key: item.key } : body);
        expect(res.statusCode, url).toBe(503);
        expect(res.json()).toEqual({ error: '数据库正在整理，稍后再试' });
      }
      expect((await get('/api/attention')).statusCode).toBe(200);
    } finally {
      release();
    }
    expect(store.getMeta(ATTENTION_META_KEY)).toBeNull();
    expect(svc.snapshot().items).toEqual([item]);
    expect((await send('POST', '/api/attention/dismiss', { key: item.key })).statusCode).toBe(200);
  });

  test('WebSocket：sessions 订阅在新增一项后收到 attention（不带已移出列表）；无关的变化不推；会话订阅收不到', async () => {
    const sessions = await connect();
    const one = await connect();
    sessions.send(JSON.stringify({ type: 'subscribe', scope: 'sessions' }));
    one.send(JSON.stringify({ type: 'subscribe', scope: 'session', sessionId: 's1', sinceSeq: 0 }));
    await sleep(50);
    const t = Date.now() - MIN;
    await write('proj/s1.jsonl', [
      userPrompt('u1', null, '读一下', { timestamp: iso(t) }),
      assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/w/f' } }, { timestamp: iso(t + 1000) }),
    ]);
    // A running session: counted, not an item.
    await vi.waitFor(() => expect(attentionOf(sessions)).toHaveLength(1));
    expect(attentionOf(sessions)[0]).toEqual({ ...EMPTY, runningCount: 1 });
    await write('proj/s1.jsonl', [
      toolResult('r1', 'a1', 'tu1', 'file body', false, { timestamp: iso(t + 2000) }),
      assistantBlock('a2', 'r1', { type: 'text', text: '读完了' }, { timestamp: iso(t + 3000), stopReason: 'end_turn' }),
    ]);
    await vi.waitFor(() => expect(attentionOf(sessions)).toHaveLength(2));
    const pushed = attentionOf(sessions)[1]!;
    expect(pushed).toEqual({ ...EMPTY, items: [expect.objectContaining({ sessionId: 's1', kind: 'finished', explanation: '读完了' })] });
    expect(pushed).toEqual(svc.snapshot());

    // Another session that asked nothing: the sessions-scope connection sees it, the list does not change.
    const before = changesOf(sessions);
    pipeline.ingestHook('SessionStart', 's7', JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's7', cwd: '/w' }));
    await vi.waitFor(() => expect(changesOf(sessions)).toBeGreaterThan(before));
    await sleep(100);
    expect(attentionOf(sessions)).toHaveLength(2);
    expect(changesOf(one)).toBeGreaterThan(0);
    expect(attentionOf(one)).toEqual([]);

    // Dismissing pushes too (to every sessions-scope connection).
    expect((await send('POST', '/api/attention/dismiss', { key: pushed.items[0]!.key })).statusCode).toBe(200);
    await vi.waitFor(() => expect(attentionOf(sessions)).toHaveLength(3));
    expect(attentionOf(sessions)[2]).toEqual({ ...EMPTY, hiddenCount: 1 });
    expect(attentionOf(one)).toEqual([]);
  });

  test('tick 每 30 秒一次：只由时间引起的变化也推送；app.close() 后计时器停掉；注入的服务不被关掉', async () => {
    let now = Date.parse('2026-11-20T10:00:00.000Z');
    store.applyChanges([
      { type: 'session_upserted', session: sessionRow('t1', 'idle', now - HOUR) },
      promptAt('t1', 'p1', now - HOUR),
      addNode(nodeRow('t1', 'r1', now - HOUR + 1000, { summary: '好了' })),
    ]);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const own = createAttentionService(store, { coalesceMs: 0, now: () => now });
    extraServices.push(own);
    const timed = buildServer({ store, pipeline, config, attention: own });
    extraApps.push(timed);
    await timed.ready();
    const tick = vi.spyOn(own, 'tick');
    const close = vi.spyOn(own, 'close');
    const pushed: AttentionResponse[] = [];
    own.onUpdate((r) => pushed.push(r));
    expect(own.snapshot().items).toHaveLength(1);

    now += 24 * HOUR; // past the auto-hide limit: only time changed
    vi.advanceTimersByTime(ATTENTION_TICK_MS - 1);
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(pushed).toEqual([{ ...EMPTY, hiddenCount: 1 }]);

    await timed.close();
    extraApps.splice(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * ATTENTION_TICK_MS);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  test('pipeline 的 onHookStored 与 onResync 接到服务上', async () => {
    const noteHook = vi.spyOn(svc, 'noteHook');
    const noteResync = vi.spyOn(svc, 'noteResync');
    await app.inject({ method: 'POST', url: '/hooks', payload: { hook_event_name: 'UserPromptSubmit', session_id: 's9', cwd: '/w', prompt: 'x' } });
    await vi.waitFor(() => expect(noteHook).toHaveBeenCalledWith('s9'));

    // A re-derive is announced through onResync only: catch the listener a fresh server subscribes.
    const resync: ((sessionId: string) => void)[] = [];
    const subscribe = pipeline.onResync.bind(pipeline);
    vi.spyOn(pipeline, 'onResync').mockImplementation((listener) => {
      resync.push(listener);
      return subscribe(listener);
    });
    extraApps.push(buildServer({ store, pipeline, config, attention: svc }));
    expect(resync.length).toBeGreaterThan(0);
    for (const listener of resync) listener('s9');
    expect(noteResync).toHaveBeenCalledWith('s9');
  });

  test('先建服务器、后建服务（start 的做法）：之前 503，之后照常并接上变更流；只能设一次', async () => {
    const slot = new AttentionSlot();
    const later = buildServer({ store, pipeline, config, attention: slot });
    extraApps.push(later);
    const notReady = await get('/api/attention', later);
    expect(notReady.statusCode).toBe(503);
    expect(notReady.json()).toEqual({ error: ATTENTION_NOT_READY });
    for (const [method, url, body] of WRITES) {
      const res = await send(method, url, body, WRITE_HEADERS, later);
      expect(res.statusCode, url).toBe(503);
      expect(res.json()).toEqual({ error: ATTENTION_NOT_READY });
    }

    const late = createAttentionService(store, { coalesceMs: 0 });
    extraServices.push(late);
    slot.set(late);
    expect(slot.get()).toBe(late);
    expect(() => slot.set(late)).toThrow();
    expect((await get('/api/attention', later)).json()).toEqual(EMPTY);
    const item = await finishedTurn(); // through the pipeline: the late service follows the change stream
    expect((await get('/api/attention', later)).json()).toEqual({ ...EMPTY, items: [item] });
    expect((await send('POST', '/api/attention/dismiss', { key: item.key }, WRITE_HEADERS, later)).json()).toEqual({ ...EMPTY, hiddenCount: 1 });
  });

  test('不传服务时 buildServer 自己建一个：stuckMinutes 读通知设置（通知关着也读），Cursor 中止的调用算出错；关服务器时关掉它', async () => {
    const t = Date.now();
    store.applyChanges([
      { type: 'session_upserted', session: sessionRow('run', 'running', t - 10 * MIN) },
      promptAt('run', 'p', t - 10 * MIN),
      { type: 'session_upserted', session: sessionRow('cur-aborted', 'idle', t - 5 * MIN, { origin: 'cursor' }) },
      promptAt('cur-aborted', 'p', t - 5 * MIN),
      addNode(nodeRow('cur-aborted', 'call', t - 4 * MIN, { kind: 'tool', status: 'failed', title: 'Shell', toolName: 'Shell' }), { text: ABORTED_NOTE }),
      { type: 'session_upserted', session: sessionRow('cur-failed', 'idle', t - 5 * MIN, { origin: 'cursor' }) },
      promptAt('cur-failed', 'p', t - 5 * MIN),
      addNode(nodeRow('cur-failed', 'call', t - 4 * MIN, { kind: 'tool', status: 'failed', title: 'Shell', toolName: 'Shell' }), { text: 'exit 1' }),
    ]);
    saveNotificationSettings(store, { ...DEFAULT_NOTIFICATION_SETTINGS, enabled: false, stuckMinutes: 5 });
    const close = vi.spyOn(AttentionService.prototype, 'close');
    const own = buildServer({ store, pipeline, config });
    extraApps.push(own);
    const kinds = async (): Promise<Record<string, string>> =>
      Object.fromEntries(((await get('/api/attention', own)).json() as AttentionResponse).items.map((i) => [i.sessionId, i.kind]));
    expect(await kinds()).toEqual({ run: 'stuck', 'cur-aborted': 'error', 'cur-failed': 'finished' });

    saveNotificationSettings(store, { ...DEFAULT_NOTIFICATION_SETTINGS, enabled: false, stuckMinutes: 30 });
    expect(await kinds()).toEqual({ 'cur-aborted': 'error', 'cur-failed': 'finished' });
    expect((await get('/api/attention', own)).json().runningCount).toBe(1);

    expect(close).not.toHaveBeenCalled();
    await own.close();
    extraApps.splice(0);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('start 接线（待处理）', () => {
  let tmp: string;
  const running: Running[] = [];
  beforeEach(async () => {
    vi.stubEnv('AGENT_CANVAS_CODEX_DIR', '');
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-attention-start-'));
  });
  afterEach(async () => {
    for (const r of running.splice(0)) await r.close().catch(() => undefined);
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
    vi.unstubAllEnvs();
  });

  test('启动后的扫描进入待处理列表；写接口可用；关闭干净', async () => {
    const projectsDir = path.join(tmp, 'projects');
    const file = path.join(projectsDir, 'proj', 's1.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const t = Date.now() - MIN;
    await fs.writeFile(
      file,
      linesOf([
        userPrompt('u1', null, '修一下', { timestamp: iso(t) }),
        assistantBlock('a1', 'u1', { type: 'text', text: '改好了' }, { timestamp: iso(t + 1000), stopReason: 'end_turn' }),
      ]),
    );
    const notifier = new FakeNotifier();
    const app = await start({ projectsDir, dataDir: path.join(tmp, 'data'), port: 0 }, { notifier });
    running.push(app);
    const read = async (): Promise<AttentionResponse> => (await fetch(`${app.url}/api/attention`)).json() as Promise<AttentionResponse>;
    await vi.waitFor(async () => expect((await read()).items).toHaveLength(1));
    const [item] = (await read()).items;
    expect(item).toMatchObject({ sessionId: 's1', kind: 'finished', explanation: '改好了' });
    const dismissed = await fetch(`${app.url}/api/attention/dismiss`, {
      method: 'POST',
      headers: { origin: app.url, 'content-type': 'application/json' },
      body: JSON.stringify({ key: item!.key }),
    });
    expect(dismissed.status).toBe(200);
    expect(((await dismissed.json()) as AttentionResponse).hiddenCount).toBe(1);
    running.splice(0);
    await app.close();
    expect(notifier.sent).toEqual([]);
  });
});
