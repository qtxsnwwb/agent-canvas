import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Diagnostics } from '@agent-canvas/shared';
import { buildServer } from '../src/api/server.js';
import { fileSources } from '../src/cli.js';
import { loadConfig, type Config } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { openStore, type Store } from '../src/store/store.js';

// Temp dirs only; every other origin disabled. Payloads are invented.
let tmp: string;
let store: Store;
let config: Config;
let pipeline: Pipeline;
let app: FastifyInstance;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-api-hook-guard-'));
  await fs.mkdir(path.join(tmp, 'projects'), { recursive: true });
  config = loadConfig({}, {
    projectsDir: path.join(tmp, 'projects'),
    dataDir: path.join(tmp, 'data'),
    codexSessionsDir: null,
    cursorDbPath: null,
    deepseekDir: null, workbuddyDirs: [], codebuddyDir: null, doubaoDirs: [], qwenDir: null, geminiDir: null,
    grokDir: null,
    copilotDir: null,
  });
  store = openStore(':memory:');
  pipeline = new Pipeline(store, config, { sources: fileSources(config, store) });
  app = buildServer({ store, pipeline, config });
});
afterEach(async () => {
  await app.close();
  await pipeline.idle();
  store.close();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

const post = (url: string, body: unknown) => app.inject({ method: 'POST', url, payload: body as object });
const settle = async (): Promise<void> => {
  await new Promise((r) => setImmediate(r));
  await pipeline.idle();
};
const diagnostics = async (): Promise<Diagnostics> => (await app.inject({ method: 'GET', url: '/api/diagnostics' })).json() as Diagnostics;

test('a Grok-shaped body to /hooks?origin=claude is answered, stored nowhere and counted', async () => {
  expect((await diagnostics()).foreignHooksDropped).toBe(0);
  const grok = { hookEventName: 'PreToolUse', sessionId: 'grok-s1', cwd: '/home/dev/demo', workspaceRoot: '/home/dev/demo' };
  const res = await post('/hooks?origin=claude', grok);
  expect(res.statusCode).toBe(200);
  expect(res.body).toBe('');
  await settle();
  expect(store.rawForSession('grok-s1')).toEqual([]);
  expect(store.getSession('grok-s1')).toBeNull();
  expect(store.allHookEventStats()).toEqual([]);
  const d = await diagnostics();
  expect(d.foreignHooksDropped).toBe(1);
  expect(d.unknownRecords).toEqual([]);
});

test('a Copilot-shaped body to /hooks (no origin) and /hooks?origin=cursor is dropped too', async () => {
  const copilot = { sessionId: 'cp-s1', timestamp: 1767225600000, cwd: '/home/dev/demo', toolName: 'bash' };
  await post('/hooks', copilot);
  await post('/hooks?origin=cursor', copilot);
  await settle();
  expect(store.rawForSession('cp-s1')).toEqual([]);
  expect((await diagnostics()).foreignHooksDropped).toBe(2);
});

test('a Claude Code body still creates its session', async () => {
  const claude = { hook_event_name: 'UserPromptSubmit', session_id: 'claude-s1', cwd: '/home/dev/demo', prompt: 'hi' };
  expect((await post('/hooks?origin=claude', claude)).statusCode).toBe(200);
  await settle();
  expect(store.rawForSession('claude-s1').map((e) => e.origin)).toEqual(['claude']);
  expect(store.getSession('claude-s1')).not.toBeNull();
  expect((await diagnostics()).foreignHooksDropped).toBe(0);
});

test('codex payloads are never guarded', async () => {
  await post('/hooks?origin=codex', { hook_event_name: 'Stop', hookEventName: 'Stop', session_id: 'cx1', cwd: '/home/dev/demo' });
  await settle();
  expect(store.rawForSession('cx1').map((e) => e.origin)).toEqual(['codex']);
  expect((await diagnostics()).foreignHooksDropped).toBe(0);
});
