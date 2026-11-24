import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import type { Bookmark, GraphNode, ServerMessage } from '@agent-canvas/shared';
import { buildServer } from '../src/api/server.js';
import { BookmarksService } from '../src/bookmarks/service.js';
import { loadConfig, type Config } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { openStore, type RawEvent, type Store } from '../src/store/store.js';
import { assistantBlock, toolResult, userPrompt } from './fixtures.js';

// In-memory store, session files in a temp dir; the server listens on an ephemeral port only for the WebSocket test.

const HOST = '127.0.0.1:4999';
const ORIGIN = `http://${HOST}`;
const WRITE_HEADERS = { host: HOST, origin: ORIGIN, 'content-type': 'application/json' };
const T0 = Date.parse('2026-11-20T10:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const linesOf = (events: RawEvent[]): string => events.map((e) => (e.source === 'transcript' ? e.line : '') + '\n').join('');

function configFor(tmp: string): Config {
  return loadConfig({}, { deepseekDir: null, workbuddyDirs: [], codebuddyDir: null, doubaoDirs: [], qwenDir: null, geminiDir: null, grokDir: null, copilotDir: null, projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null, cursorDbPath: null });
}

describe('书签接口', () => {
  let tmp: string;
  let config: Config;
  let store: Store;
  let pipeline: Pipeline;
  let nowMs: number;
  let app: FastifyInstance;
  let tool: GraphNode;
  const sockets: WebSocket[] = [];

  type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
  const send = (method: Method, url: string, body?: unknown, headers: Record<string, string> = WRITE_HEADERS) =>
    app.inject({ method, url, headers, ...(body !== undefined ? { payload: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: HOST } });
  async function make(body: unknown): Promise<Bookmark> {
    const res = await send('POST', '/api/bookmarks', body);
    expect(res.statusCode).toBe(201);
    return res.json() as Bookmark;
  }
  const listed = async (query = ''): Promise<Bookmark[]> => ((await get(`/api/bookmarks${query}`)).json() as { bookmarks: Bookmark[] }).bookmarks;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-api-bookmarks-'));
    config = configFor(tmp);
    const file = path.join(config.projectsDir, '-work-demo', 's1.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      linesOf([
        userPrompt('u1', null, '跑一下测试'),
        assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }),
        toolResult('u2', 'a1', 'tu1', 'ok'),
      ]),
    );
    store = openStore(':memory:');
    pipeline = new Pipeline(store, config);
    await pipeline.ingestFile(file);
    tool = store.getGraph('s1')!.nodes.find((n) => n.kind === 'tool')!;
    nowMs = T0;
    app = buildServer({ store, pipeline, config, bookmarks: new BookmarksService({ store, now: () => nowMs }) });
  });
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    await app.close();
    store.close();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  });

  test('GET：没有书签时是空列表', async () => {
    const res = await get('/api/bookmarks');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ bookmarks: [] });
  });

  test('POST 新建：201；GET 列出；?sessionId= 只列这个会话的', async () => {
    const s = await make({ sessionId: 's1', nodeId: null, note: '会话' });
    nowMs += 1000;
    const t = await make({ sessionId: 's1', nodeId: tool.id });
    expect(t).toMatchObject({ sessionId: 's1', nodeId: tool.id, note: '', createdAt: iso(T0 + 1000), snapshot: { stepLabel: 'Bash · npm test', toolName: 'Bash' } });
    expect(await listed()).toEqual([t, s]);
    expect(await listed('?sessionId=s1')).toEqual([t, s]);
    expect(await listed('?sessionId=other')).toEqual([]);
  });

  test('POST：同一处再收藏 409 带着已有的；找不到会话或步骤 404；请求不合法 400', async () => {
    const s = await make({ sessionId: 's1', nodeId: null });
    const dup = await send('POST', '/api/bookmarks', { sessionId: 's1', nodeId: null, note: '再来' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toEqual({ error: expect.stringMatching(/[一-鿿]/), bookmark: s });
    expect((await send('POST', '/api/bookmarks', { sessionId: 'nope', nodeId: null })).statusCode).toBe(404);
    expect((await send('POST', '/api/bookmarks', { sessionId: 's1', nodeId: 'nope' })).statusCode).toBe(404);
    expect((await send('POST', '/api/bookmarks', { nodeId: null })).statusCode).toBe(400);
    expect((await send('POST', '/api/bookmarks', { sessionId: 's1', nodeId: tool.id, note: '字'.repeat(201) })).statusCode).toBe(400);
    expect((await send('POST', '/api/bookmarks', '{oops')).statusCode).toBe(400);
    expect(await listed()).toEqual([s]);
  });

  test('PATCH 改备注：200 新的书签；找不到 404；太长 400', async () => {
    const s = await make({ sessionId: 's1', nodeId: null });
    nowMs += 5000;
    const res = await send('PATCH', `/api/bookmarks/${s.id}`, { note: '第一行\n第二行' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...s, note: '第一行 第二行', noteUpdatedAt: iso(T0 + 5000) });
    expect((await send('PATCH', `/api/bookmarks/${s.id}`, { note: '字'.repeat(201) })).statusCode).toBe(400);
    expect((await send('PATCH', '/api/bookmarks/9999', { note: 'x' })).statusCode).toBe(404);
    expect((await send('PATCH', '/api/bookmarks/abc', { note: 'x' })).statusCode).toBe(404);
    expect((await listed())[0]!.note).toBe('第一行 第二行');
  });

  test('DELETE 软删除，restore 撤销；找不到 404', async () => {
    const s = await make({ sessionId: 's1', nodeId: null });
    const del = await send('DELETE', `/api/bookmarks/${s.id}`, {});
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });
    expect(await listed()).toEqual([]);
    expect((await send('DELETE', `/api/bookmarks/${s.id}`, {})).statusCode).toBe(404);
    expect((await send('DELETE', '/api/bookmarks/9999', {})).statusCode).toBe(404);
    const restored = await send('POST', `/api/bookmarks/${s.id}/restore`, {});
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toEqual(s);
    expect(await listed()).toEqual([s]);
    expect((await send('POST', '/api/bookmarks/9999/restore', {})).statusCode).toBe(404);
  });

  test('restore：那一处已经又收藏了（旧行被清掉）时 404，中文说明', async () => {
    const old = await make({ sessionId: 's1', nodeId: null });
    await send('DELETE', `/api/bookmarks/${old.id}`, {});
    const fresh = await make({ sessionId: 's1', nodeId: null });
    const res = await send('POST', `/api/bookmarks/${old.id}/restore`, {});
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/[一-鿿]/);
    expect(await listed()).toEqual([fresh]);
  });

  test.each([
    ['跨站', { 'sec-fetch-site': 'cross-site' }],
    ['别的网站的 Origin', { origin: 'https://evil.example' }],
    ['回环地址但端口不同', { origin: 'http://127.0.0.1:5000' }],
    ['没有 Origin', { origin: '' }],
    ['表单提交', { 'content-type': 'application/x-www-form-urlencoded' }],
  ])('写接口只接受本页面的 JSON 请求（%s）：403，不改', async (_name, headers) => {
    const s = await make({ sessionId: 's1', nodeId: null });
    const h: Record<string, string> = { ...WRITE_HEADERS };
    for (const [k, v] of Object.entries(headers)) {
      if (v === '') delete h[k];
      else h[k] = v;
    }
    const writes: [Method, string, unknown][] = [
      ['POST', '/api/bookmarks', { sessionId: 's1', nodeId: tool.id }],
      ['PATCH', `/api/bookmarks/${s.id}`, { note: '改了' }],
      ['DELETE', `/api/bookmarks/${s.id}`, {}],
      ['POST', `/api/bookmarks/${s.id}/restore`, {}],
    ];
    for (const [method, url, body] of writes) {
      const res = await send(method, url, body, h);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(await listed()).toEqual([s]);
  });

  test('数据库整理（写入被挡住）期间：写接口 503，GET 照常', async () => {
    const s = await make({ sessionId: 's1', nodeId: null });
    const release = pipeline.holdWrites();
    try {
      expect((await send('POST', '/api/bookmarks', { sessionId: 's1', nodeId: tool.id })).statusCode).toBe(503);
      expect((await send('PATCH', `/api/bookmarks/${s.id}`, { note: 'x' })).statusCode).toBe(503);
      expect((await send('DELETE', `/api/bookmarks/${s.id}`, {})).statusCode).toBe(503);
      expect((await send('POST', `/api/bookmarks/${s.id}/restore`, {})).statusCode).toBe(503);
      expect(await listed()).toEqual([s]);
    } finally {
      release();
    }
  });

  test('WebSocket：sessions 订阅在新建、改备注、删除、撤销后各收到一次 bookmarks；会话订阅收不到', async () => {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const connect = async (): Promise<{ ws: WebSocket; got: ServerMessage[] }> => {
      const ws = new WebSocket(address.replace('http', 'ws') + '/ws');
      sockets.push(ws);
      const got: ServerMessage[] = [];
      ws.on('message', (d) => got.push(JSON.parse(d.toString()) as ServerMessage));
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      return { ws, got };
    };
    const all = await connect();
    const one = await connect();
    all.ws.send(JSON.stringify({ type: 'subscribe', scope: 'sessions' }));
    one.ws.send(JSON.stringify({ type: 'subscribe', scope: 'session', sessionId: 's1', sinceSeq: 1e9 }));
    await sleep(50);
    const s = await make({ sessionId: 's1', nodeId: null });
    await send('POST', '/api/bookmarks', { sessionId: 's1', nodeId: null }); // 409: no push
    await send('PATCH', `/api/bookmarks/${s.id}`, { note: '备注' });
    await send('DELETE', `/api/bookmarks/${s.id}`, {});
    await send('POST', `/api/bookmarks/${s.id}/restore`, {});
    await sleep(100);
    const bookmarkMessages = (got: ServerMessage[]) => got.filter((m) => m.type === 'bookmarks');
    expect(bookmarkMessages(all.got)).toEqual(Array(4).fill({ type: 'bookmarks', sessionIds: ['s1'] }));
    expect(bookmarkMessages(one.got)).toEqual([]);
  });
});
