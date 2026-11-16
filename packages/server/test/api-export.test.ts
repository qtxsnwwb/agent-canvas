import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  defaultExportOptions,
  EXPORT_TEMPLATE_PLACEHOLDER,
  type Change,
  type ExportBundle,
  type ExportOptions,
  type ExportPreview,
  type GraphNode,
} from '@agent-canvas/shared';
import { buildServer } from '../src/api/server.js';
import { loadConfig, type Config } from '../src/config.js';
import type { ExportSource } from '../src/export/assemble.js';
import { EXPORT_SETTINGS_FILE } from '../src/export/settings.js';
import { ExportService, type ExportServiceOptions } from '../src/export/service.js';
import { Pipeline } from '../src/pipeline.js';
import { openStore, type Store } from '../src/store/store.js';
import { summarize } from '../src/normalize/summary.js';
import { FAKE_KEY, makeNode, makeSession, threeTurns } from './export-fixtures.js';

const LEARNED_PW = 'Hunter2' + 'Hunter2xyz';

const HOST = '127.0.0.1:4999';
const ORIGIN = `http://${HOST}`;
const TEMPLATE = `<!doctype html><html><head><meta charset="utf-8"><script id="agent-canvas-export" type="application/json">${EXPORT_TEMPLATE_PLACEHOLDER}</script></head><body></body></html>`;

const options = (o: Partial<ExportOptions> = {}): ExportOptions => ({ ...defaultExportOptions(false), ...o });
const ALL_ON: ExportOptions['mask'] = { credential: true, assignment: true, personal: true, custom: true };

/** The embedded bundle of an exported HTML file. */
function embedded(html: string): ExportBundle {
  const open = 'type="application/json">';
  const start = html.indexOf(open) + open.length;
  return JSON.parse(html.slice(start, html.indexOf('</script>', start))) as ExportBundle;
}

describe('导出接口', () => {
  let tmp: string;
  let store: Store;
  let config: Config;
  let pipeline: Pipeline;
  let app: FastifyInstance;
  let service: ExportService;
  let templateFile: string | null;

  const build = (o: Partial<ExportServiceOptions> = {}, source: ExportSource = store): void => {
    service = new ExportService({
      store: source,
      dataDir: config.dataDir,
      findTemplate: () => templateFile,
      version: '1.2.3',
      now: () => new Date(2026, 10, 13, 9, 30),
      machineUser: () => 'machineuser',
      ...o,
    });
    app = buildServer({ store, pipeline, config, exports: service });
  };
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json', ...headers },
      payload: typeof body === 'string' ? body : JSON.stringify(body),
    });

  beforeEach(async () => {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cc-api-export-'));
    config = loadConfig({}, { geminiDir: null, grokDir: null, copilotDir: null, projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), cursorDbPath: null, codexSessionsDir: null });
    await fs.promises.mkdir(config.projectsDir, { recursive: true });
    store = openStore(':memory:');
    pipeline = new Pipeline(store, config);
    templateFile = null;
    store.applyChanges(threeTurns());
    build();
  });
  afterEach(async () => {
    await app.close();
    store.close();
    await fs.promises.rm(tmp, { recursive: true, force: true });
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
  ])('拒绝：%s → 403', async (_name, headers) => {
    const h: Record<string, string> = { ...headers };
    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) if (v !== '') extra[k] = v;
    const req = (url: string) =>
      app.inject({
        method: 'POST',
        url,
        headers: { host: HOST, ...(h.origin === '' ? {} : { origin: ORIGIN }), 'content-type': 'application/json', ...extra },
        payload: JSON.stringify(options()),
      });
    for (const url of ['/api/sessions/s1/export', '/api/sessions/s1/export/preview']) {
      const res = await req(url);
      expect(res.statusCode, url).toBe(403);
      expect(res.body).not.toContain('Shop');
    }
    const put = await app.inject({
      method: 'PUT',
      url: '/api/export/settings',
      headers: { host: HOST, ...(h.origin === '' ? {} : { origin: ORIGIN }), 'content-type': 'application/json', ...extra },
      payload: JSON.stringify({ customTerms: ['acme'] }),
    });
    expect(put.statusCode).toBe(403);
    expect(fs.existsSync(path.join(config.dataDir, EXPORT_SETTINGS_FILE))).toBe(false);
  });

  test('GET 不能导出', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/s1/export', headers: { host: HOST } });
    expect(res.statusCode).not.toBe(200);
  });

  test('选项不合法 → 400；不存在的会话 → 404；不认识的轮次 → 400', async () => {
    expect((await post('/api/sessions/s1/export/preview', { ...options(), extra: 1 })).statusCode).toBe(400);
    expect((await post('/api/sessions/s1/export', { format: 'md' })).statusCode).toBe(400);
    expect((await post('/api/sessions/s1/export', '{bad json')).statusCode).toBe(400);
    expect((await post('/api/sessions/nope/export/preview', options())).statusCode).toBe(404);
    expect((await post('/api/sessions/nope/export', options({ format: 'md' }))).statusCode).toBe(404);
    const turn = await post('/api/sessions/s1/export', options({ format: 'md', scope: { kind: 'turn', turnKey: 'nope' } }));
    expect(turn.statusCode).toBe(400);
    expect(turn.json()).toEqual({ error: expect.any(String) });
  });

  test('预览：报告、估计大小、节点数、是否过大', async () => {
    const res = await post('/api/sessions/s1/export/preview', options({ format: 'md' }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const p = res.json() as ExportPreview;
    expect(p).toEqual({ report: { total: 0, byType: {} }, estimatedBytes: expect.any(Number), nodeCount: 12, tooLarge: false });
  });

  test('预览 HTML 时估计大小包含模板', async () => {
    const md = (await post('/api/sessions/s1/export/preview', options({ format: 'html' }))).json() as ExportPreview;
    templateFile = path.join(tmp, 'tpl.html');
    fs.writeFileSync(templateFile, TEMPLATE + ' '.repeat(10_000));
    const html = (await post('/api/sessions/s1/export/preview', options({ format: 'html' }))).json() as ExportPreview;
    expect(html.estimatedBytes - md.estimatedBytes).toBeGreaterThanOrEqual(10_000);
  });

  test('导出 Markdown：文件头', async () => {
    const res = await post('/api/sessions/s1/export', options({ format: 'md' }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="agent-canvas-Shop-work-20261113.md"; filename*=UTF-8''agent-canvas-Shop-work-20261113.md`,
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.startsWith('# `Shop work`')).toBe(true);
  });

  test('导出 HTML：没有模板时 501', async () => {
    const res = await post('/api/sessions/s1/export', options({ format: 'html' }));
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({ error: expect.stringContaining('viewer-template.html') });
  });

  test('导出 HTML：模板的占位符换成转义后的数据', async () => {
    templateFile = path.join(tmp, 'tpl.html');
    fs.writeFileSync(templateFile, TEMPLATE);
    const res = await post('/api/sessions/s1/export', options({ format: 'html' }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    const b = embedded(res.body);
    expect(b.session.id).toBe('s1');
    expect(b.nodes).toHaveLength(12);
    expect(b.tool).toEqual({ name: 'Agent Canvas', version: '1.2.3' });
  });

  test('超过大小上限 → 413；预览 tooLarge', async () => {
    await app.close();
    build({ maxBytes: 5000 });
    const res = await post('/api/sessions/s1/export', options({ format: 'md' }));
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: expect.any(String) });
    const p = (await post('/api/sessions/s1/export/preview', options({ format: 'md' }))).json() as ExportPreview;
    expect(p.tooLarge).toBe(true);
  });

  test('设置：读、写、校验、损坏的文件', async () => {
    const get = () => app.inject({ method: 'GET', url: '/api/export/settings', headers: { host: HOST } });
    expect((await get()).json()).toEqual({ customTerms: [], settingsError: null });
    const put = (body: unknown) =>
      app.inject({ method: 'PUT', url: '/api/export/settings', headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
    const ok = await put({ customTerms: [' Acme ', 'acme', '项目代号'] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ customTerms: ['Acme', '项目代号'], settingsError: null });
    expect((await get()).json()).toEqual({ customTerms: ['Acme', '项目代号'], settingsError: null });
    expect((await put({ customTerms: ['ab'] })).statusCode).toBe(400);
    expect((await put({ customTerms: ['acme'], more: true })).statusCode).toBe(400);
    expect((await put(['acme'])).statusCode).toBe(400);
    expect((await get()).json()).toEqual({ customTerms: ['Acme', '项目代号'], settingsError: null });
    fs.writeFileSync(path.join(config.dataDir, EXPORT_SETTINGS_FILE), '{broken');
    const broken = (await get()).json() as { customTerms: string[]; settingsError: string };
    expect(broken.customTerms).toEqual([]);
    expect(broken.settingsError).toEqual(expect.any(String));
  });

  test('设置文件损坏而要求按自定义词遮蔽：预览和导出都拒绝（409），不带原文', async () => {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(path.join(config.dataDir, EXPORT_SETTINGS_FILE), '{broken');
    for (const url of ['/api/sessions/s1/export', '/api/sessions/s1/export/preview']) {
      const res = await post(url, options({ format: 'md', mask: { ...ALL_ON } }));
      expect(res.statusCode, url).toBe(409);
      expect(res.json()).toEqual({ error: expect.stringContaining('自定义词') });
      expect(res.body).not.toContain('Shop');
    }
    // Without custom masking the export still works.
    expect((await post('/api/sessions/s1/export', options({ format: 'md' }))).statusCode).toBe(200);
  });

  test('模板里占位符不止一处时当作没有模板（501）', async () => {
    templateFile = path.join(tmp, 'tpl.html');
    fs.writeFileSync(templateFile, `<!-- ${EXPORT_TEMPLATE_PLACEHOLDER} -->${TEMPLATE}`);
    expect((await post('/api/sessions/s1/export', options({ format: 'html' }))).statusCode).toBe(501);
  });

  test('自定义词用于导出（custom 开）', async () => {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(path.join(config.dataDir, EXPORT_SETTINGS_FILE), JSON.stringify({ customTerms: ['shop'] }));
    const on = (await post('/api/sessions/s1/export', options({ format: 'md', mask: { ...ALL_ON } }))).body;
    expect(on).not.toMatch(/shop/i);
    const off = (await post('/api/sessions/s1/export', options({ format: 'md' }))).body;
    expect(off).toContain('Shop work');
  });
});

describe('泄漏：同一个假密钥出现在各处，两种格式都看不到', () => {
  let tmp: string;
  let store: Store;
  let app: FastifyInstance;

  beforeEach(async () => {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cc-api-export-leak-'));
    const config = loadConfig({}, { geminiDir: null, grokDir: null, copilotDir: null, projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), cursorDbPath: null, codexSessionsDir: null });
    await fs.promises.mkdir(config.projectsDir, { recursive: true });
    store = openStore(':memory:');
    const pipeline = new Pipeline(store, config);
    const templateFile = path.join(tmp, 'tpl.html');
    fs.writeFileSync(templateFile, TEMPLATE);
    const cwd = `C:\\Users\\alice\\${FAKE_KEY}`;
    const s = 's-leak';
    const changes: Change[] = [
      {
        type: 'session_upserted',
        session: makeSession(s, {
          title: `fix ${FAKE_KEY} now`,
          cwd,
          projectId: cwd.replace(/[^A-Za-z0-9]/g, '-'),
          gitBranch: `feature/${FAKE_KEY}`,
        }),
      },
      {
        type: 'node_added',
        node: makeNode(s, 'n1', 0, {
          turnId: 'T1',
          summary: `run ${FAKE_KEY}`,
          files: [{ path: `D:/w/${FAKE_KEY}/x.ts`, action: 'edit' }],
        } as Partial<GraphNode>),
        detail: {
          input: { token: FAKE_KEY, nested: { list: [`curl ${FAKE_KEY}`] } },
          output: { content: [{ type: 'text', text: `the key is ${FAKE_KEY}.` }] },
          text: `note ${FAKE_KEY}`,
          raw: { secret: FAKE_KEY },
        },
      },
      {
        type: 'node_added',
        node: makeNode(s, 'n2', 1, { turnId: 'T1', kind: 'text', status: null, toolName: null, summary: FAKE_KEY }),
        detail: { text: `${FAKE_KEY}\n# heading ${FAKE_KEY}` },
      },
      // fix round 1: glued and escaped starts, tool names, ids, inputKey, numbers under secret keys, cut summaries,
      // a value masked in one place appearing literally elsewhere.
      {
        type: 'node_added',
        node: makeNode(s, `tool:${FAKE_KEY}`, 2, {
          turnId: 'T1',
          toolName: `mcp__${FAKE_KEY}`,
          title: `mcp__${FAKE_KEY}`,
          toolUseId: `x${FAKE_KEY}`,
          inputKey: 'feedfacecafebeef',
          summary: JSON.stringify({ content: `A=1\n${FAKE_KEY}` }),
        }),
        detail: {
          input: { content: `A=1\n${FAKE_KEY}`, password: 98765432, api_key: [`Zq${FAKE_KEY}`], text: `x\\n${FAKE_KEY}` },
          output: `log: a%0A${FAKE_KEY} and x-${FAKE_KEY}`,
        },
      },
      {
        type: 'node_added',
        node: makeNode(s, 'n4', 3, { turnId: 'T1', summary: `${'y'.repeat(190)} ${FAKE_KEY.slice(0, 9)}…` }),
        detail: {},
      },
      {
        type: 'node_added',
        node: makeNode(s, 'n5', 4, { turnId: 'T1', summary: summarize({ command: `${'y'.repeat(185)} ${FAKE_KEY}` }) }),
        detail: { input: { command: `${'y'.repeat(185)} ${FAKE_KEY}` } },
      },
      { type: 'node_added', node: makeNode(s, 'n6', 5, { turnId: 'T1' }), detail: { input: { command: `export DB_PASSWORD=${LEARNED_PW}` } } },
      { type: 'node_added', node: makeNode(s, 'n7', 6, { turnId: 'T1' }), detail: { output: `login with ${LEARNED_PW} ok` } },
      { type: 'edge_added', edge: { id: `n1->tool:${FAKE_KEY}`, sessionId: s, from: 'n1', to: `tool:${FAKE_KEY}`, kind: 'sequence' } },
    ];
    store.applyChanges(changes);
    const service = new ExportService({
      store,
      dataDir: config.dataDir,
      findTemplate: () => templateFile,
      version: '1.2.3',
      machineUser: () => 'alice',
    });
    app = buildServer({ store, pipeline, config, exports: service });
  });
  afterEach(async () => {
    await app.close();
    store.close();
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  test.each(['md', 'html'] as const)('%s', async (format) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/s-leak/export',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify(options({ format, output: 'full', mask: { ...ALL_ON } })),
    });
    expect(res.statusCode).toBe(200);
    const everything = res.body + JSON.stringify(res.headers);
    expect(everything).not.toContain(FAKE_KEY);
    // Not even the part after the prefix (e.g. a half-masked or re-encoded copy).
    expect(everything).not.toContain(FAKE_KEY.slice(8));
    expect(everything).not.toContain('alice');
    expect(everything).not.toContain(FAKE_KEY.slice(0, 9));
    expect(everything).not.toContain('98765432');
    expect(everything).not.toContain('feedfacecafebeef');
    expect(everything).not.toContain(LEARNED_PW);
    if (format === 'html') {
      const b = embedded(res.body);
      expect(b.report.byType['openai-key']!.occurrences).toBeGreaterThanOrEqual(10);
      expect(b.report.byType['openai-key']!.distinct).toBe(2); // the key and the cut prefix in a summary
      expect(b.details.n1!.raw).toBeNull();
    }
    const preview = await app.inject({
      method: 'POST',
      url: '/api/sessions/s-leak/export/preview',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify(options({ format, mask: { ...ALL_ON } })),
    });
    expect(preview.body).not.toContain(FAKE_KEY);
  });
});

describe('客户端中途离开', () => {
  let tmp: string;
  let store: Store;
  let app: FastifyInstance;
  let service: ExportService;
  let reads = 0;
  let port = 0;

  beforeEach(async () => {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cc-api-export-abort-'));
    const config = loadConfig({}, { geminiDir: null, grokDir: null, copilotDir: null, projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), cursorDbPath: null, codexSessionsDir: null });
    await fs.promises.mkdir(config.projectsDir, { recursive: true });
    store = openStore(':memory:');
    const pipeline = new Pipeline(store, config);
    const s = 'big';
    const changes: Change[] = [{ type: 'session_upserted', session: makeSession(s) }];
    for (let i = 0; i < 3000; i++) {
      changes.push({ type: 'node_added', node: makeNode(s, `n${String(i).padStart(5, '0')}`, i, { turnId: 'T1' }), detail: { output: 'o'.repeat(4000) } });
    }
    store.applyChanges(changes);
    reads = 0;
    const source: ExportSource = {
      getSession: (id) => store.getSession(id),
      nodePage: (...a) => store.nodePage(...a),
      sessionEdges: (id) => store.sessionEdges(id),
      getNodeDetail: (sid, nid) => {
        reads++;
        return store.getNodeDetail(sid, nid);
      },
    };
    service = new ExportService({ store: source, dataDir: config.dataDir, version: '1', yieldAfterMs: 0, findTemplate: () => null });
    app = buildServer({ store, pipeline, config, exports: service });
    await app.listen({ host: '127.0.0.1', port: 0 });
    port = (app.server.address() as { port: number }).port;
  });
  afterEach(async () => {
    await app.close();
    store.close();
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  const request = (onResponse: (req: http.ClientRequest, res: http.IncomingMessage) => void): http.ClientRequest => {
    const body = JSON.stringify(options({ format: 'md', output: 'full' }));
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/sessions/big/export',
      headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    });
    req.on('response', (res) => onResponse(req, res));
    req.on('error', () => undefined);
    req.end(body);
    return req;
  };
  const waitIdle = async (): Promise<void> => {
    for (let i = 0; i < 500 && service.activeJobs() > 0; i++) await new Promise((r) => setTimeout(r, 10));
  };
  const alive = async (): Promise<number> => (await fetch(`http://127.0.0.1:${port}/api/export/settings`)).status;

  test('生成期间离开：任务停下，不再读详情，服务照常', async () => {
    const req = request(() => undefined);
    for (let i = 0; i < 500 && reads < 50; i++) await new Promise((r) => setTimeout(r, 2));
    req.destroy();
    await waitIdle();
    expect(service.activeJobs()).toBe(0);
    const after = reads;
    expect(after).toBeLessThan(3000);
    await new Promise((r) => setTimeout(r, 50));
    expect(reads).toBe(after);
    expect(await alive()).toBe(200);
  });

  test('下载期间离开：不崩溃，没有留下的任务', async () => {
    await new Promise<void>((resolve) => {
      request((req, res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
    });
    await waitIdle();
    expect(service.activeJobs()).toBe(0);
    expect(await alive()).toBe(200);
  });
});
