import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { GraphEdge, GraphNode, GraphSnapshot, NodeDetail, Project, Session } from '@agent-canvas/shared';
import { AnomaliesService } from '../src/anomalies/service.js';
import { buildServer } from '../src/api/server.js';
import { fileSources } from '../src/cli.js';
import { loadConfig, type Config } from '../src/config.js';
import { buddyNodeId } from '../src/normalize/buddy.js';
import { Pipeline } from '../src/pipeline.js';
import { StatsService, storeStatsSource } from '../src/stats/service.js';
import { openStore, type Store } from '../src/store/store.js';
import { CHILD, CWD, exampleChild, exampleMain, SID } from './buddy-fixtures.js';

// WorkBuddy and CodeBuddy Code end to end: files under temp tool directories, the real fileSources + Pipeline, then
// the HTTP API (projects, sessions, graph, node detail, diagnostics). Every config names every tool directory.

const PROJ = 'home-dev-repo';
const PROJECT_ID = '-home-dev-repo';
const SID_CB = 'b2c3d4e5-0000-4000-8000-000000000009';

let tmp: string;
let wb: string;
let wbAi: string;
let cb: string;
const stores: Store[] = [];
const pipelines: Pipeline[] = [];
const apps: FastifyInstance[] = [];

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-buddy-e2e-'));
  wb = path.join(tmp, '.workbuddy');
  wbAi = path.join(tmp, '.workbuddy-ai');
  cb = path.join(tmp, '.codebuddy');
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

const body = (lines: readonly string[]): string => lines.map((l) => `${l}\n`).join('');
async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}
const mainAt = (root: string, sid: string): string => path.join(root, 'projects', PROJ, `${sid}.jsonl`);
const childAt = (root: string, sid: string): string => path.join(root, 'projects', PROJ, sid, 'subagents', `${CHILD}.jsonl`);
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
    workbuddyDirs: [wb, wbAi],
    codebuddyDir: cb,
    doubaoDirs: [],
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
const getJson = async <T>(app: FastifyInstance, url: string): Promise<T> => {
  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode, url).toBe(200);
  return res.json() as T;
};
const offsetOf = (lines: readonly string[], i: number): number => lines.slice(0, i).reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
const indexOfId = (lines: readonly string[], id: string): number => lines.findIndex((l) => (JSON.parse(l) as { id?: string }).id === id);

async function writeAll(): Promise<void> {
  await write(mainAt(wbAi, SID), body(exampleMain().lines));
  await write(childAt(wbAi, SID), body(exampleChild().lines));
  await write(mainAt(cb, SID_CB), body(exampleMain().lines));
}

describe('WorkBuddy and CodeBuddy Code end to end', () => {
  test('one-shot ingest = line-by-line appended ingest (child first) = rebuild = restart', { timeout: 60_000 }, async () => {
    await writeAll();
    const s1 = open();
    const p1 = newPipeline(s1);
    await p1.scanAll();
    await p1.idle();
    expect(p1.ingestFailures()).toEqual([]);
    expect(s1.diagnostics().unknownRecords).toEqual([]);
    const oneShot = full(s1, SID)!;
    expect(oneShot.session).toMatchObject({ origin: 'workbuddy', projectId: PROJECT_ID, cwd: CWD, title: 'Fix failing fixture test' });
    expect(Object.values(oneShot.nodes).some((n) => n.kind === 'subagent' && n.childAgentId === CHILD)).toBe(true);

    // Line by line, the child's lines first; the main file starts with its session-meta line (no cwd).
    const main = exampleMain().lines;
    const child = exampleChild().lines;
    await fs.rm(path.join(wbAi, 'projects'), { recursive: true });
    await write(mainAt(wbAi, SID), body([main[0]!]));
    await write(childAt(wbAi, SID), '');
    const s2 = open();
    const p2 = newPipeline(s2);
    await p2.scanAll();
    for (const line of child) {
      await fs.appendFile(childAt(wbAi, SID), `${line}\n`);
      await p2.ingestFile(childAt(wbAi, SID));
    }
    for (const line of main.slice(1)) {
      await fs.appendFile(mainAt(wbAi, SID), `${line}\n`);
      await p2.ingestFile(mainAt(wbAi, SID));
    }
    // The child was not placeable before the main file had a cwd: the next scan reads it.
    await p2.scanAll();
    await p2.idle();
    expect(p2.ingestFailures()).toEqual([]);
    expect(full(s2, SID)).toEqual(oneShot);

    p1.rebuild();
    expect(full(s1, SID)).toEqual(oneShot);
    p2.rebuild();
    expect(full(s2, SID)).toEqual(oneShot);
    const again = newPipeline(s2);
    await again.scanAll();
    await again.idle();
    expect(full(s2, SID)).toEqual(oneShot);
  });

  test('through the API: projects, sessions, graph, node detail, diagnostics', async () => {
    await writeAll();
    const store = open();
    const config = cfg();
    const pipeline = newPipeline(store, config);
    await pipeline.scanAll();
    await pipeline.idle();
    const stats = new StatsService(storeStatsSource(store));
    const anomalies = new AnomaliesService(storeStatsSource(store), { answerWaitMs: 10_000, liveDelayMs: 0, liveCostFactor: 0 });
    const app = buildServer({ store, pipeline, config, stats, anomalies });
    apps.push(app);

    const projects = await getJson<Project[]>(app, '/api/projects');
    expect(projects.map((p) => [p.id, p.origins])).toEqual([[PROJECT_ID, ['workbuddy', 'codebuddy']]]);
    const sessions = await getJson<Session[]>(app, `/api/projects/${encodeURIComponent(PROJECT_ID)}/sessions`);
    expect(sessions.map((s) => [s.id, s.origin]).sort()).toEqual([[SID, 'workbuddy'], [SID_CB, 'codebuddy']].sort());

    const graph = await getJson<GraphSnapshot>(app, `/api/sessions/${SID}/graph`);
    const main = exampleMain();
    const prompt = buddyNodeId(SID, null, `@${offsetOf(main.lines, indexOfId(main.lines, main.ids.p1!))}`);
    const call = buddyNodeId(SID, null, `@${offsetOf(main.lines, indexOfId(main.lines, main.ids.c1!))}`);
    expect(graph.nodes.find((n) => n.id === prompt)).toMatchObject({ kind: 'prompt' });
    expect(graph.nodes.find((n) => n.id === call)).toMatchObject({ toolName: 'Bash' });
    expect(graph.nodes.some((n) => n.agentId === CHILD)).toBe(true);

    const detail = await getJson<NodeDetail>(app, `/api/sessions/${SID}/nodes/${encodeURIComponent(prompt)}`);
    expect(JSON.stringify(detail)).toContain('fix the failing test');
    expect(JSON.stringify(detail)).not.toContain('<user_query>');
    const callDetail = await getJson<NodeDetail>(app, `/api/sessions/${SID}/nodes/${encodeURIComponent(call)}`);
    expect(JSON.stringify(callDetail)).toContain('npm test');

    const diag = await getJson<{ sources: Record<string, Record<string, unknown>> }>(app, '/api/diagnostics');
    expect(diag.sources.workbuddy).toMatchObject({
      dir: path.join(wb, 'projects'),
      present: true,
      reading: true,
      sessionCount: 1,
      duplicateSessions: 0,
      dirs: [{ dir: path.join(wb, 'projects'), present: false }, { dir: path.join(wbAi, 'projects'), present: true }],
    });
    expect(diag.sources.codebuddy).toMatchObject({ dir: path.join(cb, 'projects'), present: true, reading: true, sessionCount: 1, duplicateSessions: 0 });
    // Nothing was created in the tool directories.
    await expect(fs.stat(wb)).rejects.toThrow();
  });
});
