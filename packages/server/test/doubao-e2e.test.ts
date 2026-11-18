import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { GraphEdge, GraphNode, GraphSnapshot, NodeDetail, Project, Session, SessionAnomaliesResponse } from '@agent-canvas/shared';
import { AnomaliesService } from '../src/anomalies/service.js';
import { buildServer } from '../src/api/server.js';
import { fileSources } from '../src/cli.js';
import { loadConfig, type Config } from '../src/config.js';
import { doubaoNodeId } from '../src/normalize/doubao.js';
import { Pipeline } from '../src/pipeline.js';
import { StatsService, storeStatsSource } from '../src/stats/service.js';
import { openStore, type Store } from '../src/store/store.js';
import { agentFile, CONV, DOUBAO_PROJECT_ID, exampleChild, exampleMain, MAIN, MTIME, ORG, sessionsDir, write, writeExample } from './doubao-fixtures.js';

// Doubao Work end to end: files under temp "User Data" roots, the real fileSources + Pipeline, then the HTTP API
// (projects, sessions, graph, node detail, diagnostics, anomalies). Every config names every tool directory.

let tmp: string;
let work: string;
let app: string;
const stores: Store[] = [];
const pipelines: Pipeline[] = [];
const apps: FastifyInstance[] = [];

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-doubao-e2e-'));
  work = path.join(tmp, 'DoubaoWork', 'User Data');
  app = path.join(tmp, 'Doubao', 'User Data');
});
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const p of pipelines.splice(0)) {
    await p.close();
    await p.idle();
  }
  for (const s of stores.splice(0)) s.close();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

const cfg = (): Config =>
  loadConfig({}, {
    projectsDir: path.join(tmp, 'claude-projects'),
    dataDir: path.join(tmp, 'data'),
    codexSessionsDir: null,
    cursorDbPath: null,
    geminiDir: null,
    grokDir: null,
    copilotDir: null,
    deepseekDir: null,
    workbuddyDirs: [],
    codebuddyDir: null,
    doubaoDirs: [work, app],
    qwenDir: null,
  });
const open = (): Store => {
  const s = openStore(':memory:');
  stores.push(s);
  return s;
};
const newPipeline = (store: Store, c: Config = cfg()): Pipeline => {
  const p = new Pipeline(store, c, { sources: fileSources(c, store) });
  pipelines.push(p);
  return p;
};
function full(store: Store, sid: string) {
  const g = store.getGraph(sid);
  if (g === null) return null;
  const nodes: Record<string, GraphNode> = Object.fromEntries([...g.nodes].sort((a, b) => a.id.localeCompare(b.id)).map((n) => [n.id, n]));
  const edges: Record<string, GraphEdge> = Object.fromEntries([...g.edges].sort((a, b) => a.id.localeCompare(b.id)).map((e) => [e.id, e]));
  const details = Object.fromEntries(Object.keys(nodes).map((id) => [id, store.getNodeDetail(sid, id)]));
  return { session: g.session, nodes, edges, details };
}
const getJson = async <T>(server: FastifyInstance, url: string): Promise<T> => {
  const res = await server.inject({ method: 'GET', url });
  expect(res.statusCode, url).toBe(200);
  return res.json() as T;
};

describe('Doubao Work end to end', () => {
  test('one-shot ingest = row-by-row appended ingest (child and assignments last) = rebuild = restart', { timeout: 60_000 }, async () => {
    await writeExample(app);
    const s1 = open();
    const p1 = newPipeline(s1);
    await p1.scanAll();
    await p1.idle();
    expect(p1.ingestFailures()).toEqual([]);
    expect(s1.diagnostics().unknownRecords).toEqual([]);
    const oneShot = full(s1, CONV)!;
    expect(oneShot.session).toMatchObject({ origin: 'doubao', projectId: DOUBAO_PROJECT_ID, cwd: null, title: 'Summarise the three reports in this folder' });
    expect(Object.values(oneShot.nodes).some((n) => n.kind === 'subagent' && n.childAgentId === ORG)).toBe(true);

    // Row by row, the child's rows first, the assignments at the very end; the modification time is the same as above.
    await fs.rm(sessionsDir(app), { recursive: true });
    const m = exampleMain();
    const c = exampleChild();
    const t = new Date(MTIME);
    const s2 = open();
    const p2 = newPipeline(s2);
    // Both agent directories exist (empty files) so the conversation has its main agent from the start.
    await write(agentFile(app, MAIN, 'trajectory.jsonl'), '');
    await write(agentFile(app, ORG, 'trajectory.jsonl'), '');
    for (const [agent, lines] of [[ORG, c.lines], [MAIN, m.lines]] as const) {
      for (const line of lines) {
        await fs.appendFile(agentFile(app, agent, 'trajectory.jsonl'), `${line}\n`);
        await fs.utimes(agentFile(app, agent, 'trajectory.jsonl'), t, t);
        // The first change of a new conversation reaches the pipeline before any listing of it.
        await p2.ingestFile(agentFile(app, agent, 'trajectory.jsonl'));
      }
    }
    await write(agentFile(app, ORG, 'assignment.md'), c.assignment);
    await p2.ingestFile(agentFile(app, ORG, 'assignment.md'));
    await write(agentFile(app, MAIN, 'assignment.md'), m.assignment);
    await p2.ingestFile(agentFile(app, MAIN, 'assignment.md'));
    await p2.scanAll();
    await p2.idle();
    expect(p2.ingestFailures()).toEqual([]);
    expect(full(s2, CONV)).toEqual(oneShot);

    p1.rebuild();
    expect(full(s1, CONV)).toEqual(oneShot);
    p2.rebuild();
    expect(full(s2, CONV)).toEqual(oneShot);
    const again = newPipeline(s2);
    await again.scanAll();
    await again.idle();
    expect(full(s2, CONV)).toEqual(oneShot);
  });

  test('through the API: project doubao-work, sessions, graph, node detail, diagnostics; no cost anomaly', async () => {
    await writeExample(work);
    const store = open();
    const config = cfg();
    const pipeline = newPipeline(store, config);
    await pipeline.scanAll();
    await pipeline.idle();
    const stats = new StatsService(storeStatsSource(store));
    const anomalies = new AnomaliesService(storeStatsSource(store), { answerWaitMs: 10_000, liveDelayMs: 0, liveCostFactor: 0 });
    const server = buildServer({ store, pipeline, config, stats, anomalies });
    apps.push(server);

    const projects = await getJson<Project[]>(server, '/api/projects');
    expect(projects.map((p) => [p.id, p.origins])).toEqual([[DOUBAO_PROJECT_ID, ['doubao']]]);
    const sessions = await getJson<Session[]>(server, `/api/projects/${encodeURIComponent(DOUBAO_PROJECT_ID)}/sessions`);
    expect(sessions.map((s) => [s.id, s.origin])).toEqual([[CONV, 'doubao']]);

    const graph = await getJson<GraphSnapshot>(server, `/api/sessions/${CONV}/graph`);
    const prompt = doubaoNodeId(CONV, null, '@0');
    const read = doubaoNodeId(CONV, null, 'call:call_a1');
    expect(graph.nodes.find((n) => n.id === prompt)).toMatchObject({ kind: 'prompt', timestamp: '2026-11-17T02:00:00.000Z' });
    expect(graph.nodes.find((n) => n.id === read)).toMatchObject({ toolName: 'Read' });
    expect(graph.nodes.some((n) => n.agentId === ORG)).toBe(true);
    for (const n of graph.nodes) expect(n.usage).toBeNull();

    const detail = await getJson<NodeDetail>(server, `/api/sessions/${CONV}/nodes/${encodeURIComponent(prompt)}`);
    expect(JSON.stringify(detail)).toContain('Summarise the three reports');
    const callDetail = await getJson<NodeDetail>(server, `/api/sessions/${CONV}/nodes/${encodeURIComponent(read)}`);
    expect(JSON.stringify(callDetail)).toContain('report-1.md');

    const diag = await getJson<{ sources: Record<string, Record<string, unknown>> }>(server, '/api/diagnostics');
    expect(diag.sources.doubao).toMatchObject({
      dir: work,
      present: true,
      reading: true,
      sessionCount: 1,
      duplicateSessions: 0,
      unknownSessions: 0,
      mtimeFallbacks: 0,
      dirs: [{ dir: work, present: true }, { dir: app, present: false }],
    });

    const found = (await anomalies.session(CONV)) as SessionAnomaliesResponse;
    expect(found.anomalies.filter((a) => a.kind === 'cost')).toEqual([]);
    // Nothing was created in the tool directories.
    await expect(fs.stat(app)).rejects.toThrow();
    expect((await fs.readdir(work)).sort()).toEqual(['Default']);
  });
});
