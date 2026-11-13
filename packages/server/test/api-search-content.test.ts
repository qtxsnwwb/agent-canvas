import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ContentSearchResponse, Diagnostics, SearchHit } from '@agent-canvas/shared';
import { buildServer } from '../src/api/server.js';
import { start, type Running } from '../src/cli.js';
import { loadConfig, type Config } from '../src/config.js';
import { NORMALIZER_VERSION_KEY, Pipeline } from '../src/pipeline.js';
import { openStore, type RawEvent, type Store } from '../src/store/store.js';
import { assistantBlock, toolResult, userPrompt } from './fixtures.js';

const linesOf = (events: RawEvent[]): string => events.map((e) => (e.source === 'transcript' ? e.line : '') + '\n').join('');

/** A Claude Code session with a prompt, a reply, a tool call with output, and a long output past the 8 KB cut. */
function sessionEvents(): RawEvent[] {
  return [
    userPrompt('u1', null, 'please find the parser bug'),
    assistantBlock('a1', 'u1', { type: 'text', text: 'Looking for the PARSER bug in src/parse.ts now' }),
    assistantBlock('a2', 'a1', { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'rg -n "parseLine(" src/' } }),
    toolResult('r1', 'a2', 'tu1', `src/parse.ts:42: function parseLine(text) {\n${'x'.repeat(9000)}\nlate-output-marker`),
  ];
}

describe('GET /api/search/content', () => {
  let tmp: string;
  let store: Store;
  let config: Config;
  let pipeline: Pipeline;
  let app: FastifyInstance;
  const get = (url: string) => app.inject({ method: 'GET', url });
  const content = async (q: string, extra = ''): Promise<ContentSearchResponse> =>
    (await get(`/api/search/content?q=${encodeURIComponent(q)}${extra}`)).json() as ContentSearchResponse;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-api-search-'));
    config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), cursorDbPath: null });
    await fs.mkdir(path.join(config.projectsDir, 'proj'), { recursive: true });
    store = openStore(':memory:');
    pipeline = new Pipeline(store, config);
    app = buildServer({ store, pipeline, config });
    const file = path.join(config.projectsDir, 'proj', 's1.jsonl');
    await fs.writeFile(file, linesOf(sessionEvents()));
    await pipeline.ingestFile(file);
  });
  afterEach(async () => {
    await app.close();
    store.close();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
  });

  test('hits with session, node and plain-text snippet; the response flags', async () => {
    const r = await content('parser bug');
    expect(r.truncated).toBe(false);
    expect(r.shortQuery).toBe(false);
    expect(r.indexing).toBe(false);
    expect(r.hits.map((h) => [h.nodeId, h.kind])).toEqual([
      ['a1', 'text'],
      ['u1', 'prompt'],
    ]);
    expect(r.hits[0]).toEqual({
      sessionId: 's1',
      projectId: 'proj',
      origin: 'claude',
      sessionTitle: 'please find the parser bug',
      nodeId: 'a1',
      kind: 'text',
      toolName: null,
      at: expect.any(String),
      agentId: null,
      snippet: { before: 'Looking for the ', match: 'PARSER bug', after: ' in src/parse.ts now', clippedStart: false, clippedEnd: false },
    });
    // tool input with quotes and parentheses, tool output (first 8 KB only)
    expect((await content('"parseLine("')).hits.map((h) => h.nodeId)).toEqual(['tool:tu1']);
    expect((await content('src/parse.ts:42')).hits).toMatchObject([{ nodeId: 'tool:tu1', kind: 'tool', toolName: 'Bash' }]);
    expect((await content('late-output-marker')).hits).toEqual([]);
  });

  test('short and missing queries; filters; 400 for an unknown origin', async () => {
    expect((await content('pa')).shortQuery).toBe(true);
    expect(await content('p')).toEqual({ hits: [], truncated: false, shortQuery: false, indexing: false });
    expect((await get('/api/search/content')).json()).toEqual({ hits: [], truncated: false, shortQuery: false, indexing: false });
    expect((await get('/api/search/content?q=parser&q=bug')).json()).toEqual({ hits: [], truncated: false, shortQuery: false, indexing: false });
    expect((await content('parser bug', '&origin=claude')).hits).toHaveLength(2);
    expect((await content('parser bug', '&origin=codex')).hits).toHaveLength(0);
    expect((await content('parser bug', '&projectId=proj')).hits).toHaveLength(2);
    expect((await content('parser bug', '&projectId=other')).hits).toHaveLength(0);
    expect((await content('parser bug', '&projectId=')).hits).toHaveLength(2);
    const bad = await get('/api/search/content?q=parser&origin=gpt');
    expect(bad.statusCode).toBe(400);
    expect((await get('/api/search/content?q=parser&origin=claude&origin=codex')).statusCode).toBe(400);
  });

  test('the old GET /api/search still answers the session-hit array', async () => {
    const hits = (await get('/api/search?q=PARSER')).json() as SearchHit[];
    expect(Array.isArray(hits)).toBe(true);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.session.id).toBe('s1');
    expect(hits[0]!.matches).toEqual([
      { field: 'title', nodeId: null, snippet: 'please find the parser bug' },
      { field: 'prompt', nodeId: 'u1', snippet: 'please find the parser bug' },
    ]);
  });

  test('diagnostics carry the index status', async () => {
    const d = (await get('/api/diagnostics')).json() as Diagnostics;
    expect(d.search).toEqual({ indexing: false, indexed: 0, total: 0, skipped: 0, lastError: null });
  });

  test("diagnostics carry a failed build's error (from the running service's build)", async () => {
    const failed = { indexing: true, indexed: 100, total: 900, skipped: 0, lastError: 'SQLITE_CORRUPT' };
    const other = buildServer({ store, pipeline, config, search: { status: () => failed } });
    try {
      const d = (await other.inject({ method: 'GET', url: '/api/diagnostics' })).json() as Diagnostics;
      expect(d.search).toEqual(failed);
    } finally {
      await other.close();
    }
  });

  test('a full rebuild gives the same results as live ingest', async () => {
    const queries = ['parser bug', 'parseLine(', 'src/parse.ts', 'please', 'Bash', 'rg -n', 'late-output-marker', 'pa'];
    const before = await Promise.all(queries.map((q) => content(q)));
    pipeline.rebuild();
    const after = await Promise.all(queries.map((q) => content(q)));
    expect(after).toEqual(before);
    expect(before[0]!.hits.length).toBeGreaterThan(0);
  });
});

describe('start: the index at start-up', () => {
  let tmp: string;
  let projectsDir: string;
  let dataDir: string;
  const apps: Running[] = [];
  const dbPath = (): string => path.join(dataDir, 'data.db');

  beforeEach(async () => {
    vi.stubEnv('AGENT_CANVAS_CODEX_DIR', '');
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-start-search-'));
    projectsDir = path.join(tmp, 'projects');
    dataDir = path.join(tmp, 'data');
    await fs.mkdir(path.join(projectsDir, 'proj'), { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(projectsDir, 'proj', 's1.jsonl'), linesOf(sessionEvents()));
  });
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    vi.unstubAllEnvs();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
  });

  /** A first start that ingests the session; then the index is removed as if the database predated it. */
  async function databaseWithoutIndex(normalizerVersion?: string): Promise<void> {
    const first = await start({ projectsDir, dataDir, port: 0 }, { storage: false });
    for (let i = 0; i < 200; i++) {
      const r = (await (await fetch(`${first.url}/api/search/content?q=parser`)).json()) as ContentSearchResponse;
      if (r.hits.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await first.close();
    const db = new Database(dbPath());
    db.exec(`DROP TABLE search_fts; DELETE FROM meta WHERE key LIKE 'search_index%'`);
    if (normalizerVersion !== undefined) db.prepare(`UPDATE meta SET value = ? WHERE key = ?`).run(normalizerVersion, NORMALIZER_VERSION_KEY);
    db.close();
  }

  test('a database without the index: built in the background, reported in diagnostics and the search response', async () => {
    await databaseWithoutIndex();
    const lines: string[] = [];
    const app = await start({ projectsDir, dataDir, port: 0 }, { storage: false, searchIndex: { pollMs: 5, batchRows: 1, log: (l) => lines.push(l) } });
    apps.push(app);
    let d: Diagnostics | null = null;
    for (let i = 0; i < 400; i++) {
      d = (await (await fetch(`${app.url}/api/diagnostics`)).json()) as Diagnostics;
      if (d.search?.indexing === false) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(d!.search).toEqual({ indexing: false, indexed: 0, total: 0, skipped: 0, lastError: null });
    expect(lines).toContain('agent-canvas: search index built');
    const r = (await (await fetch(`${app.url}/api/search/content?q=parser%20bug`)).json()) as ContentSearchResponse;
    expect(r).toMatchObject({ indexing: false, hits: [{ nodeId: 'a1' }, { nodeId: 'u1' }] });
  }, 30_000);

  test('the first start after the upgrade rebuilds (normalizer version) and so needs no separate build', async () => {
    await databaseWithoutIndex('1');
    const lines: string[] = [];
    const log: string[] = [];
    const app = await start(
      { projectsDir, dataDir, port: 0 },
      { storage: false, log: (l) => log.push(l), searchIndex: { pollMs: 5, log: (l) => lines.push(l) } },
    );
    apps.push(app);
    expect(log.join('\n')).toMatch(/rebuilding derived data/);
    const d = (await (await fetch(`${app.url}/api/diagnostics`)).json()) as Diagnostics;
    expect(d.search).toEqual({ indexing: false, indexed: 0, total: 0, skipped: 0, lastError: null });
    expect(lines).toEqual([]);
    const r = (await (await fetch(`${app.url}/api/search/content?q=parser%20bug`)).json()) as ContentSearchResponse;
    expect(r.hits.map((h) => h.nodeId)).toEqual(['a1', 'u1']);
  }, 30_000);
});
