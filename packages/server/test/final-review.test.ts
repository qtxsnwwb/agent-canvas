import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { defaultExportOptions, type ContentSearchResponse, type ExportBundle, type ExportOptions, type SearchHit } from '@agent-canvas/shared';
import { buildServer } from '../src/api/server.js';
import { loadConfig, type Config } from '../src/config.js';
import { assembleExport } from '../src/export/assemble.js';
import { EXPORT_SETTINGS_FILE } from '../src/export/settings.js';
import { ExportService } from '../src/export/service.js';
import { Pipeline } from '../src/pipeline.js';
import { openStore, type Store } from '../src/store/store.js';
import { makeNode, makeSession } from './export-fixtures.js';

// Final review fixes on the server. Fake secrets are assembled at run time.
const GH = 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const OPENAI = 'sk-' + 'proj-' + 'Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90Uv12';
const PW = 'Hunter2' + 'Hunter2xx';
const JWT = 'ey' + 'JhbGciOiJIUzI1NiJ9' + '.' + 'ey' + 'JzdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'Sfl4KxwRJSMeKKF2QT4fwpMe';
const HOST = '127.0.0.1:4999';
const ORIGIN = `http://${HOST}`;

let tmp: string;
let store: Store;
let config: Config;
let app: FastifyInstance;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cc-final-review-'));
  config = loadConfig({}, { geminiDir: null, grokDir: null, copilotDir: null, projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), cursorDbPath: null, codexSessionsDir: null });
  await fs.promises.mkdir(config.projectsDir, { recursive: true });
  store = openStore(':memory:');
  const pipeline = new Pipeline(store, config);
  app = buildServer({ store, pipeline, config, exports: new ExportService({ store, dataDir: config.dataDir, version: '1', findTemplate: () => null }) });
});
afterEach(async () => {
  await app.close();
  store.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

const firstPrompt = `Here is the GitHub token for CI ok: ${GH} please use it`;
const cutTitle = Array.from(firstPrompt).slice(0, 60).join('');

function seedTitleSession(): void {
  store.applyChanges([
    { type: 'session_upserted', session: makeSession('s1', { title: cutTitle }) },
    { type: 'node_added', node: makeNode('s1', 'p1', 0, { kind: 'prompt', status: null, toolName: null, turnId: 'T', summary: firstPrompt }), detail: { text: firstPrompt } },
  ]);
}

describe('C1：截断的会话标题', () => {
  test('导出：标题按完整的首个提示遮蔽后再截断；Markdown 开头和文件名里没有密钥的任何部分', async () => {
    seedTitleSession();
    const r = await assembleExport(store, 's1', { ...defaultExportOptions(false), format: 'md' }, { customTerms: [], homeUsers: [], version: '1', now: new Date(), mode: 'bundle', extraBytes: 0 });
    if (r.kind !== 'done' || r.bundle === null) throw new Error('no bundle');
    const title = (r.bundle as ExportBundle).session.title!;
    expect(title.startsWith('Here is the GitHub token for CI ok: ‹已遮蔽·GitHub token#1›')).toBe(true);
    expect([...title].length).toBeLessThanOrEqual(60);
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/s1/export',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ ...defaultExportOptions(false), format: 'md' } satisfies ExportOptions),
    });
    const all = res.body + JSON.stringify(res.headers);
    for (let n = 8; n <= GH.length; n++) expect(all).not.toContain(GH.slice(0, n).slice(-8));
  });

  test('导出：标题不是首个提示的开头（自定义标题）时按截断判断遮蔽', async () => {
    store.applyChanges([
      { type: 'session_upserted', session: makeSession('s1', { title: `${'z'.repeat(40)} ${GH.slice(0, 19)}` }) },
      { type: 'node_added', node: makeNode('s1', 'p1', 0, { kind: 'prompt', status: null, toolName: null, turnId: 'T' }), detail: { text: 'hello' } },
    ]);
    const r = await assembleExport(store, 's1', defaultExportOptions(false), { customTerms: [], homeUsers: [], version: '1', now: new Date(), mode: 'bundle', extraBytes: 0 });
    if (r.kind !== 'done' || r.bundle === null) throw new Error('no bundle');
    expect(r.bundle.session.title).toBe(`${'z'.repeat(40)} ‹已遮蔽·GitHub token#1›`);
  });
});

describe('C2：遮蔽后的检索片段（mask=1）', () => {
  function seedSearch(): void {
    store.applyChanges([
      { type: 'session_upserted', session: makeSession('s1', { title: 'search test' }) },
      {
        type: 'node_added',
        node: makeNode('s1', 'p1', 0, { kind: 'prompt', status: null, toolName: null, turnId: 'T', summary: `please use the key ${OPENAI} to call the staging API now` }),
        detail: { text: `please use the key ${OPENAI} to call the staging API now` },
      },
      {
        type: 'node_added',
        node: makeNode('s1', 'x1', 1, { kind: 'text', status: null, toolName: null, turnId: 'T' }),
        detail: { text: `config: {"password": "${PW}", "host": "db.internal.example"} and token ${JWT} for the jwtcheck endpoint` },
      },
      {
        type: 'node_added',
        node: makeNode('s1', 'b1', 2, { turnId: 'T' }),
        detail: { input: { password: PW, host: 'replica.internal.example' } },
      },
    ]);
  }
  const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: HOST } });
  const noSecret = (body: string): void => {
    for (const secret of [OPENAI, PW, JWT]) {
      for (let i = 0; i + 8 <= secret.length; i += 4) expect(body, secret.slice(i, i + 8)).not.toContain(secret.slice(i, i + 8));
    }
  };

  test('会话检索：提示片段里的密钥尾巴不露出；不带参数时与以前逐字节相同', async () => {
    seedSearch();
    const plain = await get('/api/search?q=staging');
    expect(plain.body).toBe(JSON.stringify(store.searchSessions('staging', 30)));
    const res = await get('/api/search?q=staging&mask=1');
    const hits = res.json() as SearchHit[];
    expect(hits[0]!.matches[0]!.masked).toBe(true);
    expect(hits[0]!.matches[0]!.snippet).toContain('staging');
    noSecret(res.body);
  });

  test('内容检索：上下文里的密码值、JWT 签名不露出；命中在密钥里时 match 是占位符', async () => {
    seedSearch();
    const plain = await get('/api/search/content?q=db.internal');
    expect((plain.json() as ContentSearchResponse).hits[0]!.masked).toBeUndefined();
    for (const q of ['db.internal', 'jwtcheck', 'replica.internal', 'staging']) {
      const res = await get(`/api/search/content?q=${q}&mask=1`);
      const body = res.json() as ContentSearchResponse;
      expect(body.hits.length, q).toBeGreaterThan(0);
      for (const h of body.hits) expect(h.masked).toBe(true);
      noSecret(res.body);
    }
    const inside = (await get(`/api/search/content?q=${PW.slice(0, 9)}&mask=1`)).json() as ContentSearchResponse;
    expect(inside.hits.length).toBe(2);
    for (const h of inside.hits) expect(h.snippet.match).toBe('‹已遮蔽·密钥/密码›');
  });

  test('自定义词设置损坏时：片段整体换成占位符', async () => {
    seedSearch();
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(path.join(config.dataDir, EXPORT_SETTINGS_FILE), '{broken');
    const content = (await get('/api/search/content?q=staging&mask=1')).json() as ContentSearchResponse;
    expect(content.hits[0]!.snippet).toEqual({ before: '', match: '‹已遮蔽›', after: '', clippedStart: true, clippedEnd: true });
    const sessions = (await get('/api/search?q=staging&mask=1')).json() as SearchHit[];
    expect(sessions[0]!.matches[0]!.snippet).toBe('‹已遮蔽›');
  });

  test('诊断里的未知记录样本：mask=1 时遮蔽', async () => {
    store.bumpUnknown('weird', `{"type":"weird","token":"${PW}","note":"${'n'.repeat(600)}"}`);
    const plain = await get('/api/diagnostics');
    expect(plain.body).toContain(PW);
    const masked = await get('/api/diagnostics?mask=1');
    expect(masked.body).not.toContain(PW);
  });
});

describe('I2：会话的已学值（POST /api/sessions/:id/mask/learned）', () => {
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json', ...headers }, payload: JSON.stringify(body) });

  test('返回整个会话第一遍学到的值；同源、JSON、no-store；参数校验；404', async () => {
    store.applyChanges([
      { type: 'session_upserted', session: makeSession('s1') },
      { type: 'node_added', node: makeNode('s1', 'b1', 0, { turnId: 'T' }), detail: { output: `{"password": "${PW}"}` } },
      { type: 'node_added', node: makeNode('s1', 't1', 1, { kind: 'thinking', status: null, toolName: null, turnId: 'T' }), detail: { text: `use ${GH}` } },
    ]);
    const res = await post('/api/sessions/s1/mask/learned', { categories: ['credential', 'assignment', 'custom'] });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json() as { values: { type: string; value: string }[]; capped: boolean };
    expect(body.capped).toBe(false);
    expect(body.values.map((v) => `${v.type}:${v.value}`).sort()).toEqual([`assignment:${PW}`, `github-token:${GH}`]);
    // Cached until the session changes.
    expect((await post('/api/sessions/s1/mask/learned', { categories: ['credential', 'assignment'] })).statusCode).toBe(200);
    expect((await post('/api/sessions/s1/mask/learned', { categories: ['credential', 'assignment'] }, { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/mask/learned', headers: { host: HOST, 'content-type': 'application/json' }, payload: '{"categories":[]}' })).statusCode).toBe(403);
    expect((await post('/api/sessions/s1/mask/learned', { categories: ['personal'] })).statusCode).toBe(400);
    expect((await post('/api/sessions/s1/mask/learned', { categories: ['credential'], extra: 1 })).statusCode).toBe(400);
    expect((await post('/api/sessions/nope/mask/learned', { categories: ['credential'] })).statusCode).toBe(404);
  });
});
