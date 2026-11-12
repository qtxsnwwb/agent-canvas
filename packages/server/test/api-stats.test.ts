import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Change, GraphNode, Session, StatsResponse } from '@agent-canvas/shared';
import { buildServer } from '../src/api/server.js';
import { loadConfig, type Config } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { StatsService, storeStatsSource } from '../src/stats/service.js';
import { openStore, type RawEvent, type Store } from '../src/store/store.js';
import { assistantBlock, toolResult, userPrompt } from './fixtures.js';

const NOW = Date.parse('2026-01-02T12:00:00.000Z');
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const iso = (ms: number): string => new Date(ms).toISOString();
const linesOf = (events: RawEvent[]): string => events.map((e) => (e.source === 'transcript' ? e.line : '') + '\n').join('');

function session(id: string, o: Partial<Session> = {}): Session {
  return {
    id, projectId: 'p1', origin: 'claude', cwd: 'D:\\w\\tea-shop', title: 'SECRET TITLE', gitBranch: null, status: 'idle',
    sourceDeleted: false, startedAt: iso(NOW - 3600_000), lastActivityAt: iso(NOW - 3000_000), ...o,
  };
}
function node(sessionId: string, id: string, ms: number, o: Partial<GraphNode> = {}): GraphNode {
  return {
    id, sessionId, turnId: 'T1', agentId: null, parentId: null, kind: 'tool', status: 'succeeded', timestamp: iso(ms),
    confirmed: true, title: 'Bash', summary: 'SECRET COMMAND', toolName: 'Bash', toolUseId: null, messageId: null,
    durationMs: 2000, usage: null, systemSubtype: null, childAgentId: null, endedAt: null, ...o,
  };
}
function seedChanges(id: string, o: Partial<Session> = {}, calls = 1): Change[] {
  const t = NOW - 3600_000;
  const out: Change[] = [
    { type: 'session_upserted', session: session(id, o) },
    { type: 'node_added', node: node(id, `${id}-p`, t, { kind: 'prompt', status: null, toolName: null, summary: 'SECRET PROMPT' }), detail: {} },
  ];
  for (let i = 0; i < calls; i++) out.push({ type: 'node_added', node: node(id, `${id}-t${i}`, t + 1000 + i), detail: {} });
  return out;
}

describe('GET /api/stats', () => {
  let tmp: string;
  let store: Store;
  let config: Config;
  let pipeline: Pipeline;
  let app: FastifyInstance;
  const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-api-stats-'));
    config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), cursorDbPath: null });
    await fs.mkdir(config.projectsDir, { recursive: true });
    store = openStore(':memory:');
    pipeline = new Pipeline(store, config);
    const stats = new StatsService(storeStatsSource(store), { now: () => NOW, dayKey: utcDay });
    app = buildServer({ store, pipeline, config, stats });
  });
  afterEach(async () => {
    await app.close();
    store.close();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  });

  test('no data: 200 with zeros and the 7 days of the default range', async () => {
    const res = await get('/api/stats');
    expect(res.statusCode).toBe(200);
    const body = res.json() as StatsResponse;
    expect(body.range).toEqual({ range: '7d', from: '2025-12-27', to: '2026-01-02' });
    expect(body.totals.sessions).toBe(0);
    expect(body.byDay).toHaveLength(7);
    expect(body.byOrigin).toEqual([]);
  });

  test('totals, origins, projects (named from the cwd) and tools', async () => {
    store.applyChanges([...seedChanges('a', { projectId: 'D--w-tea-shop' }, 2), ...seedChanges('b', { origin: 'cursor', projectId: 'p2', cwd: null }, 3)]);
    const body = (await get('/api/stats')).json() as StatsResponse;
    expect(body.totals).toMatchObject({ sessions: 2, turns: 2, toolCalls: 5, finished: 5, failed: 0, toolMs: 10_000 });
    expect(body.byOrigin.map((o) => o.origin)).toEqual(['claude', 'cursor']);
    expect(body.coverage.noTokenData).toEqual(['claude', 'cursor']);
    expect(body.byProject.map((p) => p.name).sort()).toEqual(['p2', 'tea-shop']);
    expect(body.byTool.map((t) => [t.origin, t.toolName, t.calls])).toEqual([['cursor', 'Bash', 3], ['claude', 'Bash', 2]]);
    expect(body.slowest[0]).toMatchObject({ durationMs: 2000 });
  });

  test('filter combinations; an unknown project gives an empty result, not an error', async () => {
    store.applyChanges([...seedChanges('a'), ...seedChanges('b', { origin: 'codex', projectId: 'p2' }, 4)]);
    const total = async (q: string) => ((await get(`/api/stats?${q}`)).json() as StatsResponse).totals.toolCalls;
    expect(await total('range=30d')).toBe(5);
    expect(await total('origin=codex')).toBe(4);
    expect(await total('projectId=p1')).toBe(1);
    expect(await total('origin=codex&projectId=p1')).toBe(0);
    expect(await total('range=all&origin=claude&projectId=p1')).toBe(1);
    const res = await get('/api/stats?projectId=does-not-exist');
    expect(res.statusCode).toBe(200);
    expect((res.json() as StatsResponse).totals.sessions).toBe(0);
  });

  test('an unknown range or origin is a 400 with a short message', async () => {
    for (const q of ['range=1y', 'origin=gemini', 'range=7d&range=30d']) {
      const res = await get(`/api/stats?${q}`);
      expect(res.statusCode).toBe(400);
      expect(typeof res.json().error).toBe('string');
    }
  });

  test('behind the local-only guard', async () => {
    expect((await get('/api/stats', { host: 'evil.example' })).statusCode).toBe(403);
    expect((await get('/api/stats', { host: '127.0.0.1:1', origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await get('/api/stats', { host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    expect((await get('/api/stats', { host: '127.0.0.1:1' })).statusCode).toBe(200);
  });

  test('coverage.importing follows the pipeline (start-up import, rebuild, first poll round)', async () => {
    expect(((await get('/api/stats')).json() as StatsResponse).coverage.importing).toBe(false);
    vi.spyOn(pipeline, 'importing').mockReturnValue(true);
    expect(((await get('/api/stats')).json() as StatsResponse).coverage.importing).toBe(true);
  });

  test('the response carries no conversation content', async () => {
    store.applyChanges(seedChanges('a', {}, 3));
    const text = (await get('/api/stats?range=all')).body;
    expect(text).not.toContain('SECRET');
  });

  test('a session changed through the pipeline is reflected on the next request', async () => {
    const abs = (rel: string): string => path.join(config.projectsDir, ...rel.split('/'));
    await fs.mkdir(path.dirname(abs('proj/s1.jsonl')), { recursive: true });
    await fs.writeFile(abs('proj/s1.jsonl'), linesOf([
      userPrompt('u1', null, 'hello'),
      assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/w/f' } }),
      toolResult('r1', 'a1', 'tu1', 'body'),
    ]));
    await pipeline.ingestFile(abs('proj/s1.jsonl'));
    const calls = async () => ((await get('/api/stats?range=all')).json() as StatsResponse).totals.toolCalls;
    expect(await calls()).toBe(1);
    await fs.appendFile(abs('proj/s1.jsonl'), linesOf([
      assistantBlock('a2', 'r1', { type: 'tool_use', id: 'tu2', name: 'Grep', input: { pattern: 'x' } }),
    ]));
    await pipeline.ingestFile(abs('proj/s1.jsonl'));
    expect(await calls()).toBe(2);
    const body = (await get('/api/stats?range=all')).json() as StatsResponse;
    // Claude Code nodes carry usage: tokens are reported, the origin is not in noTokenData.
    expect(body.coverage.noTokenData).toEqual([]);
    expect(body.totals.tokens).not.toBeNull();
  });
});
