import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { fileSources } from '../src/cli.js';
import { loadConfig, type Config } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { openStore, type Store } from '../src/store/store.js';
import { CodexThread } from './codex-fixtures.js';
import { rolloutRel } from './codex-rollout.js';

// Temp dirs only: the Codex sessions directory is a temp path (never ~/.codex).
let tmp: string;
let store: Store;
let config: Config;
let pipeline: Pipeline;
let app: FastifyInstance;
let cwd: string;
let project: string;

async function setup(codexSessionsDir: string | null): Promise<void> {
  config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir, cursorDbPath: null });
  store = openStore(':memory:');
  pipeline = new Pipeline(store, config, { sources: fileSources(config, store) });
  app = buildServer({ store, pipeline, config });
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-api-codex-'));
  await fs.mkdir(path.join(tmp, 'projects'), { recursive: true });
  await fs.mkdir(path.join(tmp, 'codex', 'sessions'), { recursive: true });
  cwd = path.join(tmp, 'work', 'app');
  project = cwd.replace(/[^A-Za-z0-9]/g, '-');
  await setup(path.join(tmp, 'codex', 'sessions'));
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

test('POST /hooks?origin=codex：原样入库、来源为 codex、按来源计数；没有参数或其他值仍是 claude', async () => {
  const body = { hook_event_name: 'Stop', session_id: 'cx1', cwd };
  expect((await post('/hooks?origin=codex', body)).statusCode).toBe(200);
  await post('/hooks', { hook_event_name: 'Stop', session_id: 'cl1' });
  await post('/hooks?origin=evil', { hook_event_name: 'Stop', session_id: 'cl2' });
  await post('/hooks?origin=codex&origin=claude', { hook_event_name: 'Stop', session_id: 'cl3' });
  await settle();
  expect(store.rawForSession('cx1').map((e) => [e.origin, e.source === 'hook' ? e.payload : ''])).toEqual([['codex', JSON.stringify(body)]]);
  for (const id of ['cl1', 'cl2', 'cl3']) expect(store.rawForSession(id).map((e) => e.origin)).toEqual(['claude']);
  expect(store.allHookEventStats().map((e) => [e.origin, e.eventName, e.count])).toEqual([
    ['claude', 'Stop', 3],
    ['codex', 'Stop', 1],
  ]);
  expect(store.hookEventStats('codex').map((e) => e.eventName)).toEqual(['Stop']);
});

test('Codex hook 先于会话文件：会话立即出现（codex、项目由 cwd 得出）；之后文件到达合入同一会话；重建结果相同', async () => {
  await post('/hooks?origin=codex', { hook_event_name: 'SessionStart', session_id: 'root1', cwd, source: 'startup', model: 'gpt-x' });
  await post('/hooks?origin=codex', { hook_event_name: 'UserPromptSubmit', session_id: 'root1', cwd, turn_id: 't1', prompt: 'go' });
  await post('/hooks?origin=codex', { hook_event_name: 'PreToolUse', session_id: 'root1', cwd, turn_id: 't1', tool_name: 'exec', tool_use_id: 'c1', tool_input: { cmd: 'ls' } });
  await settle();
  const early = store.getGraph('root1')!;
  expect(early.session).toMatchObject({ origin: 'codex', projectId: project, cwd, status: 'running' });
  expect(early.nodes).toEqual([]); // hooks never make nodes: the transcript does
  expect((store.listProjects(Date.now()) as { id: string; origins: string[] }[]).find((p) => p.id === project)?.origins).toEqual(['codex']);

  const root = new CodexThread({ id: 'root1', cwd });
  for (const ev of [root.meta(), root.started('t1'), root.user('u1', 'go'), root.exec('c1', 'ls'), root.output('c1'), root.complete()]) void ev;
  const file = path.join(config.codexSessionsDir!, ...rolloutRel('root1').split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, root.lines.map((l) => `${l}\n`).join(''));
  await pipeline.scanAll();
  await settle();
  // The fixture's records are dated before these hooks were received: the transcript's turn end still decides.
  expect(store.getGraph('root1')!.session.status).toBe('idle');
  await post('/hooks?origin=codex', { hook_event_name: 'Stop', session_id: 'root1', cwd, turn_id: 't1', last_assistant_message: 'done' });
  await settle();
  const g = store.getGraph('root1')!;
  expect(g.session).toMatchObject({ origin: 'codex', projectId: project, status: 'idle', cwd });
  expect(g.nodes.map((x) => [x.id, x.confirmed, x.status]).sort()).toEqual([['prompt:u1', true, null], ['tool:c1', true, 'succeeded']]);
  expect(g.edges.map((e) => e.id)).toEqual(['prompt:u1->tool:c1']);
  expect(pipeline.ingestFailures()).toEqual([]);

  const strip = (x: typeof g) => ({ session: x.session, nodes: x.nodes, edges: x.edges });
  const before = strip(g);
  pipeline.rebuild();
  expect(strip(store.getGraph('root1')!)).toEqual(before);
});

test('不建会话的 hook（Stop）先于会话文件：会话出现后它照样生效；重建结果相同', async () => {
  await post('/hooks?origin=codex', { hook_event_name: 'Stop', session_id: 'root4', cwd, turn_id: 't1' });
  await settle();
  expect(store.getSession('root4')).toBeNull();
  const root = new CodexThread({ id: 'root4', cwd });
  for (const ev of [root.meta(), root.started('t1'), root.user('u1', 'go')]) void ev;
  const file = path.join(config.codexSessionsDir!, ...rolloutRel('root4').split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, root.lines.map((l) => `${l}\n`).join(''));
  await pipeline.scanAll();
  await settle();
  // The transcript's turn is open, but the Stop hook received before the file was read stopped it.
  expect(store.getSession('root4')).toMatchObject({ origin: 'codex', status: 'idle' });
  const before = store.getGraph('root4')!;
  pipeline.rebuild();
  expect(store.getGraph('root4')!.session).toEqual(before.session);
});

test('hook 不改由会话文件定下的项目和 cwd', async () => {
  const root = new CodexThread({ id: 'root5', cwd });
  for (const ev of [root.meta(), root.started('t1')]) void ev;
  const file = path.join(config.codexSessionsDir!, ...rolloutRel('root5').split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, root.lines.map((l) => `${l}\n`).join(''));
  await pipeline.scanAll();
  await settle();
  const other = path.join(tmp, 'elsewhere');
  await post('/hooks?origin=codex', { hook_event_name: 'UserPromptSubmit', session_id: 'root5', cwd: other, turn_id: 't1', prompt: 'x' });
  await settle();
  expect(store.getSession('root5')).toMatchObject({ projectId: project, cwd });
  // The stored hook carries the session's known project too (replay gives the same).
  expect(store.rawForSession('root5').flatMap((e) => (e.source === 'hook' ? [e.projectId] : []))).toEqual([project]);
});

test('子代理的 hook：项目沿用会话已知的项目（不按子代理的工作目录另起项目）', async () => {
  await post('/hooks?origin=codex', { hook_event_name: 'SessionStart', session_id: 'root2', cwd });
  await post('/hooks?origin=codex', {
    hook_event_name: 'PreToolUse', session_id: 'root2', cwd: path.join(cwd, '.worktrees', 'w'), agent_id: 'sub1', tool_name: 'exec', tool_use_id: 'k1', tool_input: {},
  });
  await settle();
  const raws = store.rawForSession('root2');
  expect(raws.map((e) => (e.source === 'hook' ? e.projectId : null))).toEqual([project, project]);
});

test('Codex 没配置时：hook 的项目仍由 cwd 得出', async () => {
  await app.close();
  store.close();
  await setup(null);
  await post('/hooks?origin=codex', { hook_event_name: 'SessionStart', session_id: 'root3', cwd });
  await settle();
  expect(store.getSession('root3')).toMatchObject({ origin: 'codex', projectId: project });
});

test('GET /api/diagnostics 带 codex：会话目录及是否存在', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/diagnostics' })).json().codex).toEqual({
    sessionsDir: config.codexSessionsDir,
    sessionsDirExists: true,
  });
  await app.close();
  store.close();
  await setup(path.join(tmp, 'no-such-dir'));
  expect((await app.inject({ method: 'GET', url: '/api/diagnostics' })).json().codex).toEqual({
    sessionsDir: path.join(tmp, 'no-such-dir'),
    sessionsDirExists: false,
  });
  await app.close();
  store.close();
  await setup(null);
  expect((await app.inject({ method: 'GET', url: '/api/diagnostics' })).json().codex).toEqual({ sessionsDir: null, sessionsDirExists: false });
});
