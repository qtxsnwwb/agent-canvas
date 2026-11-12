import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Diagnostics } from '@claude-canvas/shared';
import { buildServer } from '../src/api/server.js';
import { loadConfig, type Config } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { ClaudeFileSource } from '../src/sources/claude.js';
import type { PollSink, PollSource } from '../src/sources/poll.js';
import { openStore, type Store } from '../src/store/store.js';

// Temp dirs only: the Cursor database path is a temp path (never the real %APPDATA%\Cursor); nothing opens it.
let tmp: string;
let store: Store;
let config: Config;
let pipeline: Pipeline;
let app: FastifyInstance;

class FakePollSource implements PollSource {
  readonly origin = 'cursor' as const;
  readonly pokes: string[] = [];
  state: { lastPollAt: string | null; lastError: string | null } = { lastPollAt: null, lastError: null };
  start(_sink: PollSink): void {}
  async stop(): Promise<void> {}
  poke(sessionId: string): void {
    this.pokes.push(sessionId);
  }
  status(): { lastPollAt: string | null; lastError: string | null } {
    return this.state;
  }
}

function setup(cursorDbPath: string | null, pollSources: PollSource[] = []): void {
  config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null, cursorDbPath });
  store = openStore(':memory:');
  pipeline = new Pipeline(store, config, { sources: [new ClaudeFileSource(config.projectsDir)], pollSources });
  app = buildServer({ store, pipeline, config });
}

async function teardown(): Promise<void> {
  await app.close();
  await pipeline.close();
  await pipeline.idle();
  store.close();
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-api-cursor-'));
  await fs.mkdir(path.join(tmp, 'projects'), { recursive: true });
});
afterEach(async () => {
  await teardown();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

const diagnostics = async (): Promise<Diagnostics> => (await app.inject({ method: 'GET', url: '/api/diagnostics' })).json() as Diagnostics;

test('/api/diagnostics cursor：配置的路径、文件是否存在；没有轮询来源时无轮询状态', async () => {
  const db = path.join(tmp, 'cursor', 'state.vscdb');
  setup(db);
  expect((await diagnostics()).cursor).toEqual({ dbPath: db, dbExists: false, lastPollAt: null, lastError: null, hasData: false });
  await fs.mkdir(path.dirname(db), { recursive: true });
  await fs.writeFile(db, '');
  expect((await diagnostics()).cursor).toEqual({ dbPath: db, dbExists: true, lastPollAt: null, lastError: null, hasData: false });
});

test('/api/diagnostics cursor：hasData 在存有 Cursor 记录后为 true（M7）', async () => {
  setup(null);
  expect((await diagnostics()).cursor.hasData).toBe(false);
  store.insertRaw({ source: 'transcript', origin: 'cursor', file: 'cursor:c1/s1', offset: 0, line: '{}', recordType: 'composer', sessionId: 'c1', agentId: 's1', projectId: 'p' });
  expect((await diagnostics()).cursor.hasData).toBe(true);
});

test('/api/diagnostics cursor：Cursor 关闭时 dbPath 为 null', async () => {
  setup(null);
  expect((await diagnostics()).cursor).toEqual({ dbPath: null, dbExists: false, lastPollAt: null, lastError: null, hasData: false });
});

test('/api/diagnostics cursor：轮询状态来自 cursor 轮询来源', async () => {
  const fake = new FakePollSource();
  fake.state = { lastPollAt: '2026-11-12T03:00:00.000Z', lastError: 'database is locked' };
  setup(path.join(tmp, 'state.vscdb'), [fake]);
  expect((await diagnostics()).cursor).toMatchObject({ lastPollAt: '2026-11-12T03:00:00.000Z', lastError: 'database is locked' });
});

test('POST /hooks?origin=cursor：原样入库、来源为 cursor、按来源计数，并催 cursor 轮询来源', async () => {
  const fake = new FakePollSource();
  setup(null, [fake]);
  const body = { hook_event_name: 'beforeSubmitPrompt', session_id: 'cu1', prompt: 'x' };
  expect((await app.inject({ method: 'POST', url: '/hooks?origin=cursor', payload: body })).statusCode).toBe(200);
  await new Promise((r) => setImmediate(r));
  await pipeline.idle();
  expect(store.rawForSession('cu1').map((e) => [e.source, e.origin, e.source === 'hook' ? e.payload : ''])).toEqual([['hook', 'cursor', JSON.stringify(body)]]);
  expect(store.allHookEventStats().map((e) => [e.origin, e.eventName, e.count])).toEqual([['cursor', 'beforeSubmitPrompt', 1]]);
  expect(fake.pokes).toEqual(['cu1']);
});

test('/api/diagnostics cursor：轮询来源的 status() 抛错时仍返回 200，lastError 为错误信息', async () => {
  const fake = new FakePollSource();
  fake.status = () => {
    throw new Error('status broke');
  };
  setup(null, [fake]);
  const res = await app.inject({ method: 'GET', url: '/api/diagnostics' });
  expect(res.statusCode).toBe(200);
  expect((res.json() as Diagnostics).cursor).toEqual({ dbPath: null, dbExists: false, lastPollAt: null, lastError: 'status broke', hasData: false });
});
