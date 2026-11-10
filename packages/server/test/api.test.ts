import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import type { Change, GraphNode, SeqChange, ServerMessage } from '@claude-canvas/shared';
import { buildServer, CSP, isAllowedRequest } from '../src/api/server.js';
import { NORMALIZER_VERSION } from '../src/normalize/version.js';
import { loadConfig, type Config } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { openStore, type RawEvent, type Store } from '../src/store/store.js';
import { assistantBlock, toolResult, userPrompt } from './fixtures.js';

const linesOf = (events: RawEvent[]): string => events.map((e) => (e.source === 'transcript' ? e.line : '') + '\n').join('');

describe('http api', () => {
  let tmp: string;
  let store: Store;
  let config: Config;
  let pipeline: Pipeline;
  let app: FastifyInstance;
  const sockets: WebSocket[] = [];
  const received = new WeakMap<WebSocket, string[]>();

  const abs = (rel: string): string => path.join(config.projectsDir, ...rel.split('/'));
  const get = (url: string) => app.inject({ method: 'GET', url });
  const post = (url: string, body: unknown) => app.inject({ method: 'POST', url, payload: body as object });

  async function writeSession(rel: string, events: RawEvent[]): Promise<void> {
    await fs.mkdir(path.dirname(abs(rel)), { recursive: true });
    await fs.writeFile(abs(rel), linesOf(events));
  }
  async function seed(output: unknown = 'file body'): Promise<void> {
    await writeSession('proj/s1.jsonl', [
      userPrompt('u1', null, 'hello'),
      assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/w/f' } }),
      toolResult('r1', 'a1', 'tu1', output),
    ]);
    await pipeline.ingestFile(abs('proj/s1.jsonl'));
  }
  async function appendToSession(rel: string, events: RawEvent[]): Promise<void> {
    await fs.appendFile(abs(rel), linesOf(events));
    await pipeline.ingestFile(abs(rel));
  }
  async function connect(): Promise<WebSocket> {
    const address = app.server.listening ? `http://127.0.0.1:${(app.server.address() as { port: number }).port}` : await app.listen({ port: 0, host: '127.0.0.1' });
    const ws = new WebSocket(address.replace('http', 'ws') + '/ws');
    sockets.push(ws);
    // Record from the start: `hello` can arrive before the caller attaches its own listener.
    const raw: string[] = [];
    received.set(ws, raw);
    ws.on('message', (d) => raw.push(d.toString()));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return ws;
  }
  function collect(ws: WebSocket): { changes: () => SeqChange[]; raw: () => string[]; messages: () => ServerMessage[] } {
    const raw = received.get(ws)!;
    const messages = (): ServerMessage[] => raw.map((r) => JSON.parse(r) as ServerMessage);
    return {
      // hello / resync carry no changes
      changes: () => messages().flatMap((m) => (m.type === 'changes' ? m.changes : [])),
      raw: () => raw,
      messages,
    };
  }

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-api-'));
    config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data') });
    await fs.mkdir(config.projectsDir, { recursive: true });
    store = openStore(':memory:');
    pipeline = new Pipeline(store, config);
    app = buildServer({ store, pipeline, config });
  });
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    await app.close();
    store.close();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  });

  test('REST 返回项目、会话、图和节点详情', async () => {
    await seed();
    expect((await get('/api/projects')).json()).toEqual([expect.objectContaining({ id: 'proj' })]);
    expect((await get('/api/projects/proj/sessions')).json()[0].id).toBe('s1');
    const g = (await get('/api/sessions/s1/graph')).json();
    expect(g.nodes).toHaveLength(2);
    expect(g.seq).toBeGreaterThan(0);
    expect((await get('/api/sessions/s1/nodes/tool:tu1')).json().output).toBe('file body');
    expect((await get('/api/sessions/s1/nodes/tool%3Atu1')).json().output).toBe('file body');
  });

  test('图快照按存储的 JSON 原样发送', async () => {
    await seed();
    const spy = vi.spyOn(store, 'getGraph');
    const res = await get('/api/sessions/s1/graph');
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toBe(store.getGraphJson('s1'));
    expect(spy).not.toHaveBeenCalled();
  });

  test('不存在的会话和节点返回 404', async () => {
    await seed();
    expect((await get('/api/sessions/nope/graph')).statusCode).toBe(404);
    expect((await get('/api/sessions/s1/nodes/nope')).statusCode).toBe(404);
  });

  test('POST /hooks 立即返回空 200 并入库', async () => {
    const res = await post('/hooks', { hook_event_name: 'UserPromptSubmit', session_id: 's9', cwd: '/w', prompt: 'x' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    await vi.waitFor(() => expect(store.getSession('s9')!.status).toBe('running'));
    expect((await get('/api/diagnostics')).json().lastHookAt).not.toBeNull();
  });

  test('POST /hooks 把 transcript_path 交给管线以确定项目', async () => {
    await post('/hooks', { hook_event_name: 'SessionStart', session_id: 's8', transcript_path: abs('proj/s8.jsonl') });
    await vi.waitFor(() => expect(store.getSession('s8')?.projectId).toBe('proj'));
  });

  test.each([
    ['非 JSON', 'not json', 'text/plain'],
    ['空请求体', '', 'application/json'],
    ['损坏的 JSON', '{"a":', 'application/json'],
    ['缺 session_id', '{"hook_event_name":"Stop"}', 'application/json'],
    [
      '5 MB 的 tool_response',
      JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's1', tool_use_id: 't', tool_response: 'x'.repeat(5_000_000) }),
      'application/json',
    ],
  ])('POST /hooks 对异常载荷仍返回空 200：%s', async (_n, body, contentType) => {
    const res = await app.inject({ method: 'POST', url: '/hooks', payload: body, headers: { 'content-type': contentType } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });

  test('超过 64 MB 的 /hooks 请求体仍返回空 200', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/hooks',
      payload: Buffer.alloc(65 * 1024 * 1024, 'a'),
      headers: { 'content-type': 'text/plain' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });

  test('ingestHook 抛出的异常不会逃逸', async () => {
    const spy = vi.spyOn(pipeline, 'ingestHook').mockImplementation(() => {
      throw new Error('boom');
    });
    const res = await post('/hooks', { hook_event_name: 'Stop', session_id: 's1' });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
  });

  test('WebSocket 会话订阅先补齐再实时推送', async () => {
    await seed();
    const ws = await connect();
    const got = collect(ws);
    ws.send(JSON.stringify({ type: 'subscribe', scope: 'session', sessionId: 's1', sinceSeq: 0 }));
    await vi.waitFor(() => expect(got.changes().length).toBeGreaterThan(0));
    const backlog = got.changes().length;
    await appendToSession('proj/s1.jsonl', [assistantBlock('a9', 'u1', { type: 'text', text: 'more' })]);
    await vi.waitFor(() => expect(got.changes().some((c) => c.type === 'node_added' && c.node.id === 'a9')).toBe(true));
    const seqs = got.changes().map((c) => c.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(got.changes().length).toBeGreaterThan(backlog);
  });

  test('sinceSeq 等于最新 seq 时不补发', async () => {
    await seed();
    const latest = store.getGraph('s1')!.seq;
    const ws = await connect();
    const got = collect(ws);
    ws.send(JSON.stringify({ type: 'subscribe', scope: 'session', sessionId: 's1', sinceSeq: latest }));
    await new Promise((r) => setTimeout(r, 100));
    expect(got.changes()).toEqual([]);
  });

  test('sessions 订阅只收到会话变更', async () => {
    const ws = await connect();
    const got = collect(ws);
    ws.send(JSON.stringify({ type: 'subscribe', scope: 'sessions' }));
    await new Promise((r) => setTimeout(r, 50));
    await post('/hooks', { hook_event_name: 'PreToolUse', session_id: 's7', tool_name: 'Bash', tool_input: {}, tool_use_id: 't1' });
    await vi.waitFor(() => expect(got.changes().length).toBeGreaterThan(0));
    expect(got.changes().every((c) => c.type === 'session_upserted')).toBe(true);
  });

  test('会话订阅不收到其他会话的变更；垃圾消息被忽略', async () => {
    await seed();
    const ws = await connect();
    const got = collect(ws);
    ws.send('garbage');
    ws.send(JSON.stringify({ type: 'subscribe', scope: 'session', sessionId: 's1', sinceSeq: store.getGraph('s1')!.seq }));
    await new Promise((r) => setTimeout(r, 50));
    await post('/hooks', { hook_event_name: 'UserPromptSubmit', session_id: 'other' });
    await new Promise((r) => setTimeout(r, 150));
    expect(got.changes()).toEqual([]);
  });

  test('WebSocket 不携带节点详情，REST 仍返回完整输出', async () => {
    const big = 'y'.repeat(100_000);
    await seed(big);
    const ws = await connect();
    const got = collect(ws);
    ws.send(JSON.stringify({ type: 'subscribe', scope: 'session', sessionId: 's1', sinceSeq: 0 }));
    await vi.waitFor(() => expect(got.changes().length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    const total = got.raw().reduce((n, r) => n + Buffer.byteLength(r), 0);
    expect(total).toBeLessThan(20_000);
    expect(got.raw().some((r) => r.includes(big))).toBe(false);
    for (const c of got.changes()) {
      if (c.type === 'node_added') expect(c.detail).toEqual({});
      if (c.type === 'node_updated') expect('detail' in c).toBe(false);
    }
    expect((await get('/api/sessions/s1/nodes/tool:tu1')).json().output).toBe(big);
  });

  test('关闭服务时关闭 socket', async () => {
    const ws = await connect();
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    ws.send(JSON.stringify({ type: 'subscribe', scope: 'sessions' }));
    await new Promise((r) => setTimeout(r, 50));
    await app.close();
    await closed;
    expect(() => pipeline.ingestHook('Stop', 's1', '{}')).not.toThrow();
  });

  describe('origin and host validation', () => {
    const evil = { origin: 'https://evil.example' };

    test('isAllowedRequest 判定规则', () => {
      const ok: Record<string, string>[] = [
        {},
        { origin: 'http://localhost:5173' },
        { origin: 'http://127.0.0.1:4317' },
        { origin: 'https://[::1]:4317' },
        { origin: 'http://LOCALHOST' },
        { host: '127.0.0.1:4317' },
        { host: 'localhost:4317' },
        { host: '[::1]:4317' },
        { host: 'LocalHost' },
      ];
      const bad: Record<string, string>[] = [
        { origin: 'https://evil.example' },
        { origin: 'null' },
        { origin: 'http://localhost.evil.example' },
        { origin: 'ftp://localhost' },
        { origin: 'not a url' },
        { host: 'evil.example' },
        { host: 'evil.example:4317' },
        { host: '127.0.0.1.evil.example' },
        { host: 'localhost:4317', origin: 'http://evil.example' },
      ];
      for (const h of ok) expect(isAllowedRequest(h), JSON.stringify(h)).toBe(true);
      for (const h of bad) expect(isAllowedRequest(h), JSON.stringify(h)).toBe(false);
    });

    test('外来 Origin 的 REST 请求返回 403 且无 CORS 头', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/projects', headers: evil });
      expect(res.statusCode).toBe(403);
      expect(res.body).toBe('');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect((await app.inject({ method: 'GET', url: '/api/projects', headers: { origin: 'null' } })).statusCode).toBe(403);
    });

    test('外来 Host 的请求返回 403', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/projects', headers: { host: 'evil.example' } });
      expect(res.statusCode).toBe(403);
    });

    test('GET /api/search 受回环校验保护（非回环 Host 返回 403）', async () => {
      const url = '/api/search?q=hello';
      expect((await app.inject({ method: 'GET', url, headers: { host: 'evil.example' } })).statusCode).toBe(403);
      const foreign = await app.inject({ method: 'GET', url, headers: evil });
      expect(foreign.statusCode).toBe(403);
      expect(foreign.body).toBe('');
      expect((await app.inject({ method: 'GET', url, headers: { 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403);
    });

    test('GET /api/search：缺 q 返回 []；limit=0、limit=abc、limit=1000 都不报错', async () => {
      await seed();
      expect((await get('/api/search')).json()).toEqual([]);
      expect((await get('/api/search?q=')).json()).toEqual([]);
      expect((await get('/api/search?q=h')).json()).toEqual([]);
      expect((await get('/api/search?q=hello&q=world')).json()).toEqual([]);
      const hit = (await get('/api/search?q=HELLO')).json();
      expect(hit).toHaveLength(1);
      expect(hit[0].session.id).toBe('s1');
      expect(hit[0].matches).toEqual([{ field: 'prompt', nodeId: 'u1', snippet: 'hello' }]);
      for (const limit of ['0', 'abc', '1000', '-5', '1.5', '']) {
        const res = await get(`/api/search?q=hello&limit=${limit}`);
        expect(res.statusCode, limit).toBe(200);
        expect(res.json(), limit).toHaveLength(1);
      }
      // special characters and injection-looking text are plain data
      for (const q of ['%25%25', '__', "'%20OR%201=1--", '%5C%5C']) expect((await get(`/api/search?q=${q}`)).json(), q).toEqual([]);
      expect((await get(`/api/search?q=${encodeURIComponent('你好')}`)).json()).toEqual([]);
    });

    test('允许的 Origin 和 Host', async () => {
      for (const headers of [
        {},
        { origin: 'http://localhost:5173' },
        { origin: 'http://127.0.0.1:4317' },
        { host: '127.0.0.1:4317' },
        { host: 'localhost:4317' },
        { host: '[::1]:4317' },
      ]) {
        expect((await app.inject({ method: 'GET', url: '/api/projects', headers })).statusCode).toBe(200);
      }
    });

    test('外来 Origin 的 /hooks 返回空 200 且不入库', async () => {
      const spy = vi.spyOn(pipeline, 'ingestHook');
      const res = await app.inject({
        method: 'POST',
        url: '/hooks',
        payload: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'forged' }),
        headers: { 'content-type': 'text/plain', ...evil },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('');
      await new Promise((r) => setTimeout(r, 50));
      expect(spy).not.toHaveBeenCalled();
      expect(store.getSession('forged')).toBeNull();
    });

    test('外来 Origin 的 WebSocket 升级被拒绝', async () => {
      const address = await app.listen({ port: 0, host: '127.0.0.1' });
      for (const origin of ['https://evil.example', 'null']) {
        const ws = new WebSocket(address.replace('http', 'ws') + '/ws', { headers: { Origin: origin } });
        sockets.push(ws);
        const messages: string[] = [];
        ws.on('message', (d) => messages.push(d.toString()));
        const status = await new Promise<number>((resolve, reject) => {
          ws.once('unexpected-response', (req, res) => {
            res.resume();
            req.destroy();
            resolve(res.statusCode ?? 0);
          });
          ws.once('open', () => reject(new Error('connection was established')));
          ws.once('error', () => undefined);
        });
        expect(status).toBe(403);
        expect(messages).toEqual([]);
      }
    });
  });

  test('id 中含有 % 的节点按字面解析，不返回 500', async () => {
    await writeSession('proj/s1.jsonl', [
      userPrompt('u1', null, 'hello'),
      assistantBlock('a1', 'u1', { type: 'tool_use', id: 'a%41', name: 'Read', input: {} }),
      toolResult('r1', 'a1', 'a%41', 'pct body'),
    ]);
    await pipeline.ingestFile(abs('proj/s1.jsonl'));
    expect((await get('/api/sessions/s1/nodes/tool%3Aa%2541')).json().output).toBe('pct body');
    expect((await get('/api/sessions/s1/nodes/tool%3AaA')).statusCode).toBe(404);
    expect((await get('/api/sessions/s1/nodes/%25')).statusCode).toBe(404);
    expect((await get('/api/sessions/s1/nodes/%')).statusCode).toBeLessThan(500);
  });

  test('第二个会话订阅替换第一个', async () => {
    await seed();
    await writeSession('proj/s2.jsonl', [userPrompt('v1', null, 'other', { sessionId: 's2' })]);
    await pipeline.ingestFile(abs('proj/s2.jsonl'));
    const ws = await connect();
    const got = collect(ws);
    ws.send(JSON.stringify({ type: 'subscribe', scope: 'session', sessionId: 's1', sinceSeq: store.getGraph('s1')!.seq }));
    ws.send(JSON.stringify({ type: 'subscribe', scope: 'session', sessionId: 's2', sinceSeq: store.getGraph('s2')!.seq }));
    await new Promise((r) => setTimeout(r, 50));
    await post('/hooks', { hook_event_name: 'UserPromptSubmit', session_id: 's1' });
    await post('/hooks', { hook_event_name: 'UserPromptSubmit', session_id: 's2' });
    await vi.waitFor(() => expect(got.changes().length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 100));
    const ids = got.changes().map((c) => (c.type === 'session_upserted' ? c.session.id : null));
    expect(ids).toContain('s2');
    expect(ids).not.toContain('s1');
  });

  test('同时持有 sessions 和 session 订阅时每个变更只收到一次', async () => {
    await seed();
    const ws = await connect();
    const got = collect(ws);
    ws.send(JSON.stringify({ type: 'subscribe', scope: 'sessions' }));
    ws.send(JSON.stringify({ type: 'subscribe', scope: 'session', sessionId: 's1', sinceSeq: store.getGraph('s1')!.seq }));
    await new Promise((r) => setTimeout(r, 50));
    await post('/hooks', { hook_event_name: 'UserPromptSubmit', session_id: 's1' });
    await vi.waitFor(() => expect(got.changes().length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 100));
    const seqs = got.changes().map((c) => c.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test('一个连接发送失败不影响其他连接', async () => {
    const a = await connect();
    const b = await connect();
    const gotB = collect(b);
    a.send(JSON.stringify({ type: 'subscribe', scope: 'sessions' }));
    b.send(JSON.stringify({ type: 'subscribe', scope: 'sessions' }));
    await new Promise((r) => setTimeout(r, 50));
    const spy = vi.spyOn(WebSocket.prototype, 'send').mockImplementationOnce(() => {
      throw new Error('send failed');
    });
    try {
      pipeline.ingestHook('UserPromptSubmit', 's5', JSON.stringify({ session_id: 's5', hook_event_name: 'UserPromptSubmit' }));
      await vi.waitFor(() => expect(gotB.changes().length).toBeGreaterThan(0));
    } finally {
      spy.mockRestore();
    }
  });

  test('webDist 为目录时提供静态文件并回退到 index.html；为 null 时不注册', async () => {
    expect((await get('/')).statusCode).toBe(404);
    const dist = path.join(tmp, 'dist');
    await fs.mkdir(dist);
    await fs.writeFile(path.join(dist, 'index.html'), '<html>app</html>');
    await fs.writeFile(path.join(dist, 'a.js'), 'x=1');
    const app2 = buildServer({ store, pipeline, config: { ...config, webDist: dist } });
    try {
      expect((await app2.inject({ method: 'GET', url: '/a.js' })).body).toBe('x=1');
      expect((await app2.inject({ method: 'GET', url: '/' })).body).toBe('<html>app</html>');
      expect((await app2.inject({ method: 'GET', url: '/some/route' })).body).toBe('<html>app</html>');
      expect((await app2.inject({ method: 'GET', url: '/api/nope' })).statusCode).toBe(404);
    } finally {
      await app2.close();
    }
  });

  // ---- final fix wave, group 7: WebSocket protocol ----

  const mkTextNode = (id: string): GraphNode => ({
    id, sessionId: 's1', turnId: null, agentId: null, parentId: null, kind: 'text', status: null,
    timestamp: '2026-01-01T00:00:00.000Z', confirmed: true, title: 'Text', summary: '', toolName: null,
    toolUseId: null, messageId: null, durationMs: null, usage: null, systemSubtype: null, childAgentId: null, endedAt: null,
  });
  const manyNodes = (n: number, prefix = 'n'): Change[] =>
    Array.from({ length: n }, (_, i): Change => ({ type: 'node_added', node: mkTextNode(`${prefix}${i}`), detail: {} }));

  test('连接打开后先收到 hello，带数据库 epoch', async () => {
    const ws = await connect();
    const got = collect(ws);
    await vi.waitFor(() => expect(got.messages().length).toBeGreaterThan(0));
    expect(got.messages()[0]).toEqual({ type: 'hello', epoch: store.epoch() });
  });

  test('补发按每条消息最多 1000 个变更分块', async () => {
    await seed();
    store.applyChanges(manyNodes(2500));
    const ws = await connect();
    const got = collect(ws);
    ws.send(JSON.stringify({ type: 'subscribe', scope: 'session', sessionId: 's1', sinceSeq: 0 }));
    const total = store.changesSince(0, 's1').length;
    await vi.waitFor(() => expect(got.changes()).toHaveLength(total));
    const sizes = got.messages().flatMap((m) => (m.type === 'changes' ? [m.changes.length] : []));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1000);
    expect(sizes.length).toBeGreaterThanOrEqual(3);
  });

  test('需要补发的变更超过 5000 时发 resync，之后照常实时推送', async () => {
    await seed();
    store.applyChanges(manyNodes(5001));
    const ws = await connect();
    const got = collect(ws);
    ws.send(JSON.stringify({ type: 'subscribe', scope: 'session', sessionId: 's1', sinceSeq: 0 }));
    await vi.waitFor(() => expect(got.messages()).toContainEqual({ type: 'resync', sessionId: 's1' }));
    expect(got.changes()).toEqual([]);
    await appendToSession('proj/s1.jsonl', [assistantBlock('a9', 'u1', { type: 'text', text: 'more' })]);
    await vi.waitFor(() => expect(got.changes().some((c) => c.type === 'node_added' && c.node.id === 'a9')).toBe(true));
  });

  test('sinceSeq 早于保留的最小 seq 时发 resync', async () => {
    await seed();
    const old = store.getGraph('s1')!.seq;
    pipeline.rebuild(); // clears the change log; seqs keep increasing
    expect(store.minSeq()).toBeGreaterThan(old);
    const ws = await connect();
    const got = collect(ws);
    ws.send(JSON.stringify({ type: 'subscribe', scope: 'session', sessionId: 's1', sinceSeq: old - 1 }));
    await vi.waitFor(() => expect(got.messages()).toContainEqual({ type: 'resync', sessionId: 's1' }));
    expect(got.changes()).toEqual([]);
    // a client resubscribing with the snapshot's seq is not told to resync again
    const ws2 = await connect();
    const got2 = collect(ws2);
    ws2.send(JSON.stringify({ type: 'subscribe', scope: 'session', sessionId: 's1', sinceSeq: store.getGraph('s1')!.seq }));
    await new Promise((r) => setTimeout(r, 100));
    expect(got2.messages().filter((m) => m.type !== 'hello')).toEqual([]);
  });

  test('发送缓冲超过上限的 socket 被断开', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'subscribe', scope: 'sessions' }));
    await new Promise((r) => setTimeout(r, 50));
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    const spy = vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockReturnValue(16 * 1024 * 1024 + 1);
    try {
      pipeline.ingestHook('UserPromptSubmit', 's5', JSON.stringify({ session_id: 's5', hook_event_name: 'UserPromptSubmit' }));
      await closed;
    } finally {
      spy.mockRestore();
    }
  });

  // ---- final fix wave, group 10: diagnostics and API hardening ----

  test('diagnostics 带导入失败、导入状态、归一化版本和数据库 epoch', async () => {
    const d = (await get('/api/diagnostics')).json();
    expect(d).toMatchObject({ ingestFailures: [], importing: false, normalizerVersion: NORMALIZER_VERSION, dbEpoch: store.epoch() });
    expect(d).toHaveProperty('unknownRecords');
    expect(d).toHaveProperty('files');
  });

  test('所有响应带 nosniff', async () => {
    await seed();
    for (const res of [
      await get('/api/projects'),
      await get('/api/sessions/s1/graph'),
      await get('/api/sessions/nope/graph'),
      await app.inject({ method: 'GET', url: '/api/projects', headers: { origin: 'https://evil.example' } }),
      await post('/hooks', { hook_event_name: 'Stop', session_id: 's1' }),
    ]) {
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  test('index.html 带 CSP，静态资源不带', async () => {
    const dist = path.join(tmp, 'dist');
    await fs.mkdir(dist);
    await fs.writeFile(path.join(dist, 'index.html'), '<html>app</html>');
    await fs.writeFile(path.join(dist, 'a.js'), 'x=1');
    const app2 = buildServer({ store, pipeline, config: { ...config, webDist: dist } });
    try {
      for (const url of ['/', '/some/route']) {
        const res = await app2.inject({ method: 'GET', url });
        expect(res.headers['content-security-policy']).toBe(CSP);
        expect(res.headers['x-content-type-options']).toBe('nosniff');
      }
      const js = await app2.inject({ method: 'GET', url: '/a.js' });
      expect(js.headers['content-security-policy']).toBeUndefined();
      expect(js.headers['x-content-type-options']).toBe('nosniff');
    } finally {
      await app2.close();
    }
  });

  test('Sec-Fetch-Site: cross-site 的请求按外来 Origin 处理', async () => {
    expect(isAllowedRequest({ 'sec-fetch-site': 'cross-site' })).toBe(false);
    for (const v of ['same-origin', 'same-site', 'none']) expect(isAllowedRequest({ 'sec-fetch-site': v })).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/projects', headers: { 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403);
    const spy = vi.spyOn(pipeline, 'ingestHook');
    const res = await app.inject({
      method: 'POST',
      url: '/hooks',
      payload: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'forged' }),
      headers: { 'content-type': 'text/plain', 'sec-fetch-site': 'cross-site' },
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(spy).not.toHaveBeenCalled();
  });

  test('/hooks 处理中被吞掉的异常写日志', async () => {
    const report = vi.spyOn(pipeline, 'reportFailure');
    vi.spyOn(pipeline, 'ingestHook').mockImplementation(() => {
      throw new Error('kaboom');
    });
    await post('/hooks', { hook_event_name: 'Stop', session_id: 's1' });
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith('hook', expect.objectContaining({ message: 'kaboom' })));
  });
});
