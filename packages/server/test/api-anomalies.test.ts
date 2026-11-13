import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  AnomalyCountsResponse,
  AnomalyListResponse,
  Change,
  GraphNode,
  Session,
  SessionAnomaliesResponse,
} from '@agent-canvas/shared';
import { AnomaliesService } from '../src/anomalies/service.js';
import { buildServer } from '../src/api/server.js';
import { loadConfig, type Config } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { storeStatsSource } from '../src/stats/service.js';
import { openStore, type RawEvent, type Store } from '../src/store/store.js';
import { assistantBlock, toolResult, userPrompt } from './fixtures.js';

const NOW = Date.parse('2026-01-02T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const linesOf = (events: RawEvent[]): string => events.map((e) => (e.source === 'transcript' ? e.line : '') + '\n').join('');

function session(id: string, o: Partial<Session> = {}): Session {
  return {
    id, projectId: 'p1', origin: 'claude', cwd: 'D:\\w\\tea-shop', title: 'the title', gitBranch: null, status: 'idle',
    sourceDeleted: false, startedAt: iso(NOW - 3600_000), lastActivityAt: iso(NOW - 3000_000), ...o,
  };
}
function node(sessionId: string, id: string, ms: number, o: Partial<GraphNode> = {}): GraphNode {
  return {
    id, sessionId, turnId: 'T1', agentId: null, parentId: null, kind: 'tool', status: 'failed', timestamp: iso(ms),
    confirmed: true, title: 'Bash', summary: 'SECRET COMMAND', toolName: 'Bash', toolUseId: null, messageId: null,
    durationMs: 2000, usage: null, systemSubtype: null, childAgentId: null, endedAt: iso(ms + 2000), inputKey: '0123456789abcdef', ...o,
  };
}
/** A session with one turn of `failed` failures of the same call. */
function seed(id: string, failed: number, o: Partial<Session> = {}): Change[] {
  const t = NOW - 3600_000;
  const out: Change[] = [
    { type: 'session_upserted', session: session(id, o) },
    { type: 'node_added', node: node(id, `${id}-p`, t, { kind: 'prompt', status: null, toolName: null, summary: 'SECRET PROMPT', inputKey: undefined }), detail: {} },
  ];
  for (let i = 0; i < failed; i++) out.push({ type: 'node_added', node: node(id, `${id}/t${i}`, t + 1000 * (i + 1)), detail: { text: 'SECRET OUTPUT' } });
  return out;
}

describe('anomaly routes', () => {
  let tmp: string;
  let store: Store;
  let config: Config;
  let pipeline: Pipeline;
  let app: FastifyInstance;
  const get = (url: string) => app.inject({ method: 'GET', url });

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-api-anomalies-'));
    config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), cursorDbPath: null });
    await fs.mkdir(config.projectsDir, { recursive: true });
    store = openStore(':memory:');
    pipeline = new Pipeline(store, config);
    const anomalies = new AnomaliesService(storeStatsSource(store), { now: () => NOW, importing: () => pipeline.importing() });
    app = buildServer({ store, pipeline, config, anomalies });
  });
  afterEach(async () => {
    await app.close();
    store.close();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  });

  test('no data: empty answers', async () => {
    const list = await get('/api/anomalies');
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ items: [], totals: { loop: 0, failures: 0, churn: 0, cost: 0 }, truncated: false, computing: false, failedSessions: 0 });
    expect((await get('/api/anomalies/counts')).json()).toEqual({ counts: {}, computing: false });
  });

  test('session, list and counts', async () => {
    store.applyChanges([...seed('a', 3), ...seed('b', 5, { origin: 'codex', projectId: 'p2' }), ...seed('c', 2)]);
    const a = (await get('/api/sessions/a/anomalies')).json() as SessionAnomaliesResponse;
    expect(a.computing).toBe(false);
    expect(a.anomalies.map((x) => [x.kind, x.basis, x.count, x.lastNodeId])).toEqual([['loop', 'failed', 3, 'a/t2']]);
    expect(((await get('/api/sessions/c/anomalies')).json() as SessionAnomaliesResponse).anomalies).toEqual([]);
    const list = (await get('/api/anomalies?range=all')).json() as AnomalyListResponse;
    expect(list.items.map((i) => [i.sessionId, i.kind, i.origin, i.projectId, i.sessionTitle])).toEqual([
      // Newest first; the two loops reached their threshold at the same time: by session id.
      ['b', 'failures', 'codex', 'p2', 'the title'], ['a', 'loop', 'claude', 'p1', 'the title'], ['b', 'loop', 'codex', 'p2', 'the title'],
    ]);
    expect(list.totals).toEqual({ loop: 2, failures: 1, churn: 0, cost: 0 });
    const loops = (await get('/api/anomalies?range=all&kind=loop&origin=codex&projectId=p2')).json() as AnomalyListResponse;
    expect(loops.items.map((i) => i.sessionId)).toEqual(['b']);
    expect(loops.totals).toEqual({ loop: 1, failures: 1, churn: 0, cost: 0 });
    const counts = (await get('/api/anomalies/counts')).json() as AnomalyCountsResponse;
    expect(counts).toEqual({ counts: { a: { total: 1, byKind: { loop: 1 } }, b: { total: 2, byKind: { loop: 1, failures: 1 } } }, computing: false });
  });

  test('the default range is 30 days', async () => {
    // The fixtures are an hour before NOW; the service's clock is NOW.
    store.applyChanges(seed('a', 3));
    expect(((await get('/api/anomalies')).json() as AnomalyListResponse).items).toHaveLength(1);
  });

  test('404 for an unknown session; 400 for a bad parameter', async () => {
    expect((await get('/api/sessions/nope/anomalies')).statusCode).toBe(404);
    for (const q of ['range=1y', 'origin=gpt', 'kind=slow', 'range=7d&range=30d', 'kind=loop&kind=cost', 'projectId=a&projectId=b']) {
      const res = await get(`/api/anomalies?${q}`);
      expect(res.statusCode, q).toBe(400);
      expect(res.json()).toHaveProperty('error');
    }
    expect((await get('/api/anomalies?range=7d&origin=&projectId=&kind=')).statusCode).toBe(200);
    expect((await get('/api/anomalies?projectId=unknown')).statusCode).toBe(200);
  });

  test('no conversation content, tool input or output in any answer', async () => {
    store.applyChanges([...seed('a', 5)]);
    for (const url of ['/api/sessions/a/anomalies', '/api/anomalies?range=all', '/api/anomalies/counts']) {
      const text = (await get(url)).body;
      expect(text).not.toContain('SECRET');
    }
  });

  test('while the pipeline imports, answers say computing', async () => {
    store.applyChanges(seed('a', 3));
    vi.spyOn(pipeline, 'importing').mockReturnValue(true);
    expect(((await get('/api/anomalies/counts')).json() as AnomalyCountsResponse).computing).toBe(true);
    expect(((await get('/api/sessions/a/anomalies')).json() as SessionAnomaliesResponse).computing).toBe(true);
  });

  test('a session changed through the pipeline is reflected on the next request (real normalizer: inputKey)', async () => {
    const abs = (rel: string): string => path.join(config.projectsDir, ...rel.split('/'));
    await fs.mkdir(path.dirname(abs('proj/s1.jsonl')), { recursive: true });
    const call = (n: number, parent: string): RawEvent[] => [
      assistantBlock(`a${n}`, parent, { type: 'tool_use', id: `tu${n}`, name: 'Bash', input: { command: 'npm test' } }),
      toolResult(`r${n}`, `a${n}`, `tu${n}`, 'failed', true),
    ];
    await fs.writeFile(abs('proj/s1.jsonl'), linesOf([userPrompt('u1', null, 'hello'), ...call(1, 'u1'), ...call(2, 'r1')]));
    await pipeline.ingestFile(abs('proj/s1.jsonl'));
    const kinds = async () => ((await get('/api/anomalies?range=all')).json() as AnomalyListResponse).items.map((i) => i.kind);
    expect(await kinds()).toEqual([]);
    await fs.appendFile(abs('proj/s1.jsonl'), linesOf(call(3, 'r2')));
    await pipeline.ingestFile(abs('proj/s1.jsonl'));
    expect(await kinds()).toEqual(['loop']);
    const s = (await get('/api/sessions/s1/anomalies')).json() as SessionAnomaliesResponse;
    expect(s.anomalies[0]).toMatchObject({ kind: 'loop', basis: 'failed', count: 3, toolName: 'Bash' });
  });
});
