import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Change, FileTouch, GraphNode, ProjectFilesResponse, Session, SessionFilesResponse } from '@agent-canvas/shared';
import { buildServer } from '../src/api/server.js';
import { loadConfig, type Config } from '../src/config.js';
import { FilesService } from '../src/files/service.js';
import { Pipeline } from '../src/pipeline.js';
import { storeStatsSource } from '../src/stats/service.js';
import { openStore, type RawEvent, type Store } from '../src/store/store.js';
import { assistantBlock, toolResult, userPrompt } from './fixtures.js';

const NOW = Date.parse('2026-01-02T12:00:00.000Z');
/** The project id the store derives from the cwd (so it reports that cwd as the project's directory). */
const P = 'D--w-tea-shop';
const iso = (ms: number): string => new Date(ms).toISOString();
const linesOf = (events: RawEvent[]): string => events.map((e) => (e.source === 'transcript' ? e.line : '') + '\n').join('');

function session(id: string, o: Partial<Session> = {}): Session {
  return {
    id, projectId: P, origin: 'claude', cwd: 'D:\\w\\tea-shop', title: 'a title', gitBranch: null, status: 'idle',
    sourceDeleted: false, startedAt: iso(NOW - 3600_000), lastActivityAt: iso(NOW - 3000_000), ...o,
  };
}
function node(sessionId: string, id: string, ms: number, files: FileTouch[] | undefined, o: Partial<GraphNode> = {}): GraphNode {
  return {
    id, sessionId, turnId: 'T1', agentId: null, parentId: null, kind: 'tool', status: 'succeeded', timestamp: iso(ms),
    confirmed: true, title: 'Edit', summary: 'SECRET COMMAND', toolName: 'Edit', toolUseId: null, messageId: null,
    durationMs: 2000, usage: null, systemSubtype: null, childAgentId: null, endedAt: null,
    ...(files !== undefined ? { files } : {}), ...o,
  };
}

describe('file routes', () => {
  let tmp: string;
  let store: Store;
  let config: Config;
  let pipeline: Pipeline;
  let app: FastifyInstance;
  const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });
  const apply = (changes: Change[]) => store.applyChanges(changes);
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-api-files-'));
    config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), cursorDbPath: null });
    await fs.mkdir(config.projectsDir, { recursive: true });
    store = openStore(':memory:');
    pipeline = new Pipeline(store, config);
    app = buildServer({ store, pipeline, config, files: new FilesService(storeStatsSource(store), { now: () => NOW }) });
    apply([
      { type: 'session_upserted', session: session('s1', { title: 'SESSION ONE' }) },
      { type: 'node_added', node: node('s1', 'p', NOW - 9000, undefined, { kind: 'prompt', status: null, toolName: null, summary: 'SECRET PROMPT' }), detail: { text: 'SECRET PROMPT' } },
      { type: 'node_added', node: node('s1', 'n1', NOW - 5000, [{ path: 'D:/w/tea-shop/src/a.ts', action: 'read' }], { toolName: 'Read' }), detail: {} },
      { type: 'node_added', node: node('s1', 'n2', NOW - 4000, [{ path: 'D:/w/tea-shop/src/a.ts', action: 'edit' }]), detail: {} },
      { type: 'node_added', node: node('s1', 'n3', NOW - 3000, [{ path: 'D:/w/tea-shop/README.md', action: 'read' }], { toolName: 'Read', agentId: 'ag1', turnId: null }), detail: {} },
      { type: 'session_upserted', session: session('s2', { origin: 'codex', title: 'SESSION TWO' }) },
      { type: 'node_added', node: node('s2', 'm1', NOW - 1000, [{ path: 'd:/w/TEA-SHOP/src/A.ts', action: 'write' }], { toolName: 'apply_patch' }), detail: {} },
    ]);
  });
  afterEach(async () => {
    await app.close();
    store.close();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  });

  test('GET /api/sessions/:id/files: the session\'s files with their touches', async () => {
    const res = await get('/api/sessions/s1/files');
    expect(res.statusCode).toBe(200);
    const body = res.json() as SessionFilesResponse;
    expect(body).toMatchObject({ sessionId: 's1', origin: 'claude', cwd: 'D:\\w\\tea-shop', truncatedNodes: 0 });
    expect(body.totals).toEqual({ files: 2, changedFiles: 1, reads: 2, changes: 1 });
    expect(body.files.map((f) => f.relativePath)).toEqual(['src/a.ts', 'README.md']);
    expect(body.files[0]!.touches.map((t) => [t.nodeId, t.action, t.toolName])).toEqual([['n1', 'read', 'Read'], ['n2', 'edit', 'Edit']]);
    expect(body.files[1]!.touches[0]!.agentId).toBe('ag1');
    expect(res.body).not.toMatch(/SECRET/);
  });

  test('GET /api/sessions/:id/files: 404 for an unknown session', async () => {
    const res = await get('/api/sessions/nope/files');
    expect(res.statusCode).toBe(404);
  });

  test('GET /api/files: the project\'s files across sessions (case-insensitive on Windows paths)', async () => {
    const res = await get(`/api/files?projectId=${P}&changedOnly=0`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as ProjectFilesResponse;
    expect(body).toMatchObject({ projectId: P, projectName: 'tea-shop', projectDir: 'D:\\w\\tea-shop', totalFiles: 2, truncated: false, importing: false });
    const a = body.files.find((f) => f.relativePath === 'src/a.ts')!;
    expect(a).toMatchObject({ sessionCount: 2, reads: 1, changes: 2, created: true, lastOrigin: 'codex', lastAt: iso(NOW - 1000) });
    expect(a.sessions.map((s) => [s.sessionId, s.title])).toEqual([['s2', 'SESSION TWO'], ['s1', 'SESSION ONE']]);
    expect(res.body).not.toMatch(/SECRET/);
  });

  test('GET /api/files: defaults (changed only, recent), filters', async () => {
    const body = (await get(`/api/files?projectId=${P}`)).json() as ProjectFilesResponse;
    expect(body.files.map((f) => f.relativePath)).toEqual(['src/a.ts']);
    const codex = (await get(`/api/files?projectId=${P}&origin=codex&changedOnly=0`)).json() as ProjectFilesResponse;
    expect(codex.files.map((f) => [f.relativePath, f.sessionCount])).toEqual([['src/A.ts', 1]]); // that session's spelling
    const q = (await get(`/api/files?projectId=${P}&changedOnly=0&q=readme`)).json() as ProjectFilesResponse;
    expect(q.files.map((f) => f.relativePath)).toEqual(['README.md']);
    const lim = (await get(`/api/files?projectId=${P}&changedOnly=0&limit=1&sort=path`)).json() as ProjectFilesResponse;
    expect(lim).toMatchObject({ totalFiles: 2, truncated: true });
    expect(lim.files.map((f) => f.relativePath)).toEqual(['README.md']);
  });

  test('GET /api/files: unknown project is an empty result', async () => {
    const res = await get('/api/files?projectId=nope');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ projectId: 'nope', files: [], totalFiles: 0 });
  });

  test.each([
    '/api/files',
    '/api/files?projectId=',
    `/api/files?projectId=${P}&origin=gpt`,
    `/api/files?projectId=${P}&range=1y`,
    `/api/files?projectId=${P}&changedOnly=true`,
    `/api/files?projectId=${P}&sort=size`,
    `/api/files?projectId=${P}&limit=0`,
    `/api/files?projectId=${P}&q=${'x'.repeat(201)}`,
    `/api/files?projectId=${P}&projectId=p2`,
  ])('GET %s: 400', async (url) => {
    expect((await get(url)).statusCode).toBe(400);
  });

  test('a session ingested and then changed through the pipeline is reflected on the next request', async () => {
    const file = path.join(config.projectsDir, 'proj', 's9.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, linesOf([
      userPrompt('u1', null, 'hello'), // the first prompt becomes the session title, which is exposed
      assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/w/app/a.ts' } }),
      toolResult('r1', 'a1', 'tu1', 'SECRET BODY'),
    ]));
    await pipeline.ingestFile(file);
    const id = (store.listSessions('proj')[0] as Session).id;
    const files = async () => (await get(`/api/sessions/${id}/files`)).json() as SessionFilesResponse;
    expect((await files()).files.map((f) => [f.path, f.reads, f.changes])).toEqual([['/w/app/a.ts', 1, 0]]);
    await fs.appendFile(file, linesOf([
      assistantBlock('a2', 'r1', { type: 'tool_use', id: 'tu2', name: 'Edit', input: { file_path: '/w/app/a.ts', old_string: 'x', new_string: 'y' } }),
      toolResult('r2', 'a2', 'tu2', 'ok'),
    ]));
    await pipeline.ingestFile(file);
    const after = await files();
    expect(after.files.map((f) => [f.path, f.reads, f.changes])).toEqual([['/w/app/a.ts', 1, 1]]);
    const project = (await get('/api/files?projectId=proj')).json() as ProjectFilesResponse;
    expect(project.files.map((f) => [f.path, f.reads, f.changes, f.sessionCount])).toEqual([['/w/app/a.ts', 1, 1, 1]]);
    expect(JSON.stringify(after) + JSON.stringify(project)).not.toMatch(/SECRET/);
  });

  test('only local requests', async () => {
    expect((await get(`/api/files?projectId=${P}`, { host: 'evil.example' })).statusCode).toBe(403);
    expect((await get('/api/sessions/s1/files', { host: '127.0.0.1:1', origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await get('/api/sessions/s1/files', { host: '127.0.0.1:1' })).statusCode).toBe(200);
  });
});
