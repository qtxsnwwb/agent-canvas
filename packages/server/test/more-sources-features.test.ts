import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  defaultExportOptions,
  type AnomalyListResponse,
  type ContentSearchResponse,
  type GraphSnapshot,
  type Origin,
  type Project,
  type SessionAnomaliesResponse,
  type StatsResponse,
} from '@agent-canvas/shared';
import { AnomaliesService } from '../src/anomalies/service.js';
import { buildServer } from '../src/api/server.js';
import { fileSources } from '../src/cli.js';
import { loadConfig, type Config } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { CursorSource, type PollTimers } from '../src/sources/cursor/source.js';
import { StatsService, storeStatsSource } from '../src/stats/service.js';
import { openStore, type RawEvent, type Store } from '../src/store/store.js';
import { CodexThread } from './codex-fixtures.js';
import { rolloutRel } from './codex-rollout.js';
import * as copilot from './copilot-fixtures.js';
import { CursorDbFixture, T0 as CURSOR_T0, textBubble, thinkingBubble, toolBubble, userBubble } from './cursor-fixtures.js';
import { assistantBlock, userPrompt } from './fixtures.js';
import * as gemini from './gemini-fixtures.js';
import * as grok from './grok-fixtures.js';

// The features around the three new origins (spec section 6) through the real pipeline and API: projects, content
// search, stats, cost anomalies, Markdown export; and that adding them changes nothing for Claude Code, Codex and
// Cursor. Temp directories and invented data only; every config names geminiDir, grokDir and copilotDir.

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const MIN = 60_000;
const DAY = 24 * 3600_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const HOST = '127.0.0.1:4999';
const NO_TIMERS: PollTimers = { set: () => null, clear: () => undefined };

let tmp: string;
const stores: Store[] = [];
const apps: FastifyInstance[] = [];
const pipelines: Pipeline[] = [];

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-more-sources-features-'));
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

async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}
const body = (lines: string[]): string => lines.map((l) => `${l}\n`).join('');
const dirs = () => ({ geminiDir: path.join(tmp, '.gemini'), grokDir: path.join(tmp, '.grok'), copilotDir: path.join(tmp, '.copilot') });

interface Served { app: FastifyInstance; store: Store; pipeline: Pipeline }
async function serve(config: Config, pollSources: CursorSource[] = []): Promise<Served> {
  await fs.mkdir(config.projectsDir, { recursive: true });
  const store = openStore(':memory:');
  stores.push(store);
  const pipeline = new Pipeline(store, config, { sources: fileSources(config, store), pollSources });
  pipelines.push(pipeline);
  await pipeline.scanAll();
  for (const s of pollSources) await s.pollOnce();
  await pipeline.idle();
  const stats = new StatsService(storeStatsSource(store), { now: () => NOW });
  const anomalies = new AnomaliesService(storeStatsSource(store), { now: () => NOW, answerWaitMs: 10_000, liveDelayMs: 0, liveCostFactor: 0 });
  const app = buildServer({ store, pipeline, config, stats, anomalies });
  apps.push(app);
  return { app, store, pipeline };
}
const getJson = async <T>(app: FastifyInstance, url: string): Promise<T> => {
  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode, url).toBe(200);
  return res.json() as T;
};

/** One example session per new origin, as the fixtures of Tasks 2–4 write them. */
async function writeNewSources(d: ReturnType<typeof dirs>, cwds: { gemini: string; grok: string; copilot: string } = { gemini: '/home/dev/demo-app', grok: grok.CWD, copilot: copilot.CWD }): Promise<void> {
  const gTmp = path.join(d.geminiDir, 'tmp');
  await write(path.join(gTmp, 'demo-app', '.project_root'), cwds.gemini);
  await write(path.join(gTmp, ...gemini.MAIN_REL.split('/')), body(gemini.exampleLines()));
  const grokSessions = path.join(d.grokDir, 'sessions');
  await write(path.join(grokSessions, grok.DIR, grok.SID, 'summary.json'), grok.summaryJson({ cwd: cwds.grok }));
  await write(path.join(grokSessions, grok.DIR, grok.SID, 'updates.jsonl'), body(grok.exampleLines()));
  const state = path.join(d.copilotDir, 'session-state');
  const lines = copilot.exampleRecords().map((r) =>
    r.type === 'session.start' ? JSON.stringify({ ...r, data: { ...(r.data as object), context: { cwd: cwds.copilot, branch: 'main' } } }) : JSON.stringify(r));
  await write(path.join(state, copilot.SID, 'events.jsonl'), body(lines));
  await write(path.join(state, copilot.SID, 'workspace.yaml'), copilot.WORKSPACE_YAML.replace(`cwd: ${copilot.CWD}`, `cwd: ${cwds.copilot}`));
}

describe('the three new origins in projects, search, stats and export', () => {
  test('one session each: projects with their origin, content search, stats totals, Markdown export', async () => {
    const d = dirs();
    await writeNewSources(d);
    const config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null, cursorDbPath: null, geminiDir: d.geminiDir, grokDir: d.grokDir, copilotDir: d.copilotDir });
    const { app, pipeline, store } = await serve(config);
    expect(pipeline.ingestFailures()).toEqual([]);
    expect(store.diagnostics().unknownRecords).toEqual([]);

    // Projects: each session in a project that names its origin.
    const projects = await getJson<Project[]>(app, '/api/projects');
    const originsOf = (id: string): Origin[] | undefined => projects.find((p) => p.id === id)?.origins;
    expect(originsOf('-home-dev-demo-app')).toEqual(['gemini']);
    expect(originsOf(copilot.PROJECT)).toEqual(['grok', 'copilot']);
    expect(store.getSession(gemini.SID)).toMatchObject({ origin: 'gemini', title: gemini.TITLE });
    expect(store.getSession(grok.SID)).toMatchObject({ origin: 'grok', title: 'Fix failing unit test in parser' });
    expect(store.getSession(copilot.SID)).toMatchObject({ origin: 'copilot', title: 'Fix README typo' });

    // Content search finds a word of each.
    for (const [word, origin, sessionId] of [['verbose', 'gemini', gemini.SID], ['off-by-one', 'grok', grok.SID], ['typo', 'copilot', copilot.SID]] as const) {
      const r = await getJson<ContentSearchResponse>(app, `/api/search/content?q=${encodeURIComponent(word)}`);
      expect(r.hits.map((h) => [h.sessionId, h.origin]), word).toContainEqual([sessionId, origin]);
      const only = await getJson<ContentSearchResponse>(app, `/api/search/content?q=${encodeURIComponent(word)}&origin=${origin}`);
      expect(only.hits.length, word).toBeGreaterThan(0);
      expect(only.hits.every((h) => h.origin === origin)).toBe(true);
    }

    // Stats: Gemini's per-response usage (input − cached, cached, output + thoughts), Grok's turn usage (input +
    // cache creation, cache reads, output + reasoning) and Copilot's shutdown total, all in the totals.
    const gTok = { input: (5210 - 4096) + (6011 - 5120), cachedInput: 4096 + 5120, output: 42 + 118 + 210 };
    const kTok = { input: 6200 + 0, cachedInput: 4000, output: 700 + 120 };
    const cTok = { input: 5000, cachedInput: 0, output: 300 };
    const all = await getJson<StatsResponse>(app, '/api/stats?range=all');
    expect(Object.fromEntries(all.byOrigin.map((o) => [o.origin, o.tokens]))).toEqual({ gemini: gTok, grok: kTok, copilot: cTok });
    expect(all.totals.tokens).toEqual({
      input: gTok.input + kTok.input + cTok.input,
      cachedInput: gTok.cachedInput + kTok.cachedInput + cTok.cachedInput,
      output: gTok.output + kTok.output + cTok.output,
    });
    expect(all.totals.sessions).toBe(3);
    expect(all.coverage.noTokenData).toEqual([]);

    // Markdown export of each names its origin.
    for (const [sessionId, label] of [[gemini.SID, 'Gemini CLI'], [grok.SID, 'Grok'], [copilot.SID, 'Copilot CLI']] as const) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/sessions/${encodeURIComponent(sessionId)}/export`,
        headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/json' },
        payload: JSON.stringify({ ...defaultExportOptions(false), format: 'md' }),
      });
      expect(res.statusCode, label).toBe(200);
      expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
      expect(res.body, label).toContain(`来源：${label}`);
    }
  });

  test('cost anomaly: 25 Copilot sessions with one 50× outlier give none (and do not fail); the same shape in Gemini CLI does', async () => {
    const d = dirs();
    const gTmp = path.join(d.geminiDir, 'tmp');
    await write(path.join(gTmp, 'demo-app', '.project_root'), '/home/dev/demo-app');
    const state = path.join(d.copilotDir, 'session-state');
    for (let i = 0; i < 25; i++) {
      const big = i === 24;
      const at = Date.parse('2026-11-12T12:00:00.000Z') + i * 20 * MIN;
      const activeMs = big ? 30 * MIN : MIN;
      const tokens = big ? 5_000_000 : 100_000;
      // Copilot: a prompt, a bash call taking activeMs, a shutdown carrying the usage.
      await write(path.join(state, `cop-${i}`, 'events.jsonl'), body([
        copilot.startLine(),
        copilot.ev('user.message', { content: 'run the tests' }, { at: iso(at) }),
        copilot.ev('tool.execution_start', { toolCallId: 'b1', toolName: 'bash', arguments: { command: 'npm test' } }, { at: iso(at + 1000) }),
        copilot.ev('tool.execution_complete', { toolCallId: 'b1', success: true, result: { content: 'ok' } }, { at: iso(at + 1000 + activeMs) }),
        copilot.ev('session.shutdown', { shutdownType: 'routine', modelMetrics: { m: { usage: { inputTokens: tokens, outputTokens: 1000 } } } }, { at: iso(at + 2000 + activeMs) }),
      ]));
      // Gemini CLI: the same turn, the usage on the reply.
      const sid = `9e000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      await write(path.join(gTmp, 'demo-app', 'chats', `session-2026-11-12T00-00-${sid.slice(0, 8)}${i}.jsonl`), body([
        gemini.metaLine(sid, { startTime: iso(at) }),
        JSON.stringify(gemini.userMsg('u', 'run the tests', iso(at))),
        JSON.stringify({
          id: 'g', timestamp: iso(at + 1000), type: 'gemini', content: 'done', model: 'gemini-2.5-pro',
          tokens: { input: tokens, output: 1000, cached: 0, thoughts: 0, tool: 0, total: tokens + 1000 },
          toolCalls: [{ id: 'c', name: 'run_shell_command', args: { command: 'npm test' }, status: 'success', timestamp: iso(at + 1000 + activeMs), result: [{ functionResponse: { id: 'c', name: 'run_shell_command', response: { output: 'ok' } } }] }],
        }),
      ]));
    }
    const config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null, cursorDbPath: null, geminiDir: d.geminiDir, grokDir: null, copilotDir: d.copilotDir });
    const { app, pipeline, store } = await serve(config);
    expect(pipeline.ingestFailures()).toEqual([]);
    expect(store.listProjects(NOW).map((p) => [p.id, p.sessionCount, p.origins]).sort()).toEqual([
      ['-home-dev-demo', 25, ['copilot']],
      ['-home-dev-demo-app', 25, ['gemini']],
    ]);

    const kinds = async (id: string): Promise<string[]> =>
      (await getJson<SessionAnomaliesResponse>(app, `/api/sessions/${encodeURIComponent(id)}/anomalies`)).anomalies.map((a) => a.kind);
    for (let i = 0; i < 25; i++) expect(await kinds(`cop-${i}`), `cop-${i}`).not.toContain('cost');
    // The control: the Gemini outlier is found, so the setup can produce a cost anomaly.
    expect(await kinds('9e000000-0000-4000-8000-000000000024')).toContain('cost');
    const list = await getJson<AnomalyListResponse>(app, '/api/anomalies?range=all&origin=copilot');
    expect(list.totals.cost).toBe(0);
    expect(list.computing).toBe(false);
    expect(list.failedSessions).toBe(0);
  });
});

describe('Claude Code, Codex and Cursor are unchanged by the new origins', () => {
  const CODEX_ROOT = '019a0000-0000-7000-8000-0000000000c1';
  const s = (sec: number): number => CURSOR_T0 + sec * 1000;

  test('graphs, sessions, stats and anomalies of the existing three are identical with and without the new sources', async () => {
    const cwd = path.join(tmp, 'work', 'app');
    const projectsDir = path.join(tmp, 'projects');
    const codexSessionsDir = path.join(tmp, 'codex', 'sessions');
    const fx = new CursorDbFixture(path.join(tmp, 'Cursor'));
    try {
      const project = cwd.replace(/[^A-Za-z0-9]/g, '-');
      const claudeBody = (events: RawEvent[]): string => body(events.map((e) => (e.source === 'transcript' ? e.line : '')));
      await write(path.join(projectsDir, project, 'c1.jsonl'), claudeBody([
        userPrompt('u1', null, 'claude prompt about the parser', { sessionId: 'c1' }),
        assistantBlock('a1', 'u1', { type: 'text', text: 'looked at the parser' }),
      ]));
      const codex = new CodexThread({ id: CODEX_ROOT, cwd });
      codex.meta();
      codex.started('t1');
      codex.user('p1', 'codex prompt about the parser');
      codex.assistant('m1', 'done');
      codex.complete();
      await write(path.join(codexSessionsDir, ...rolloutRel(CODEX_ROOT).split('/')), body(codex.lines));
      fx.put({
        id: 'cur-root', name: 'Cursor conversation', status: 'completed', dataFsPath: cwd, createdAt: s(0), lastUpdatedAt: s(30),
        bubbles: [
          userBubble('u1', 'find the parser', s(1)),
          thinkingBubble('th1', 'where would it be', s(2)),
          toolBubble('t1', 'grep', 'completed', s(3), { params: { pattern: 'parse' } }),
          textBubble('a1', 'it is in src/parser.ts', s(20), { turnDurationMs: 19_000 }),
        ],
      });
      // The new sources' sessions share the working directory (and so the project) of the existing three.
      const d = dirs();
      await writeNewSources(d, { gemini: cwd, grok: cwd, copilot: cwd });

      const base = { projectsDir, dataDir: path.join(tmp, 'data'), codexSessionsDir, cursorDbPath: fx.dbPath };
      const without = await serve(loadConfig({}, { ...base, geminiDir: null, grokDir: null, copilotDir: null }), [new CursorSource({ dbPath: fx.dbPath, now: () => NOW, timers: NO_TIMERS })]);
      const withNew = await serve(loadConfig({}, { ...base, geminiDir: d.geminiDir, grokDir: d.grokDir, copilotDir: d.copilotDir }), [new CursorSource({ dbPath: fx.dbPath, now: () => NOW, timers: NO_TIMERS })]);
      // The new sources are really there.
      expect(withNew.store.listProjects(NOW).find((p) => p.id === project)?.origins).toEqual(['claude', 'codex', 'cursor', 'gemini', 'grok', 'copilot']);
      expect(without.store.listProjects(NOW).find((p) => p.id === project)?.origins).toEqual(['claude', 'codex', 'cursor']);
      expect(withNew.pipeline.ingestFailures()).toEqual([]);

      const byId = <T extends { id: string }>(xs: T[]): T[] => [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const strip = (g: GraphSnapshot | null) => (g === null ? null : { session: g.session, nodes: byId(g.nodes), edges: byId(g.edges) });
      const view = async (sv: Served) => {
        const out: Record<string, unknown> = {};
        for (const id of ['c1', CODEX_ROOT, 'cur-root']) {
          out[`graph:${id}`] = strip(sv.store.getGraph(id));
          out[`anomalies:${id}`] = await getJson<SessionAnomaliesResponse>(sv.app, `/api/sessions/${encodeURIComponent(id)}/anomalies`);
        }
        for (const origin of ['claude', 'codex', 'cursor'] as const) {
          const { generatedAt: _g, ...stats } = await getJson<StatsResponse>(sv.app, `/api/stats?range=all&origin=${origin}`);
          out[`stats:${origin}`] = stats;
          out[`anomalyList:${origin}`] = await getJson<AnomalyListResponse>(sv.app, `/api/anomalies?range=all&origin=${origin}`);
          out[`search:${origin}`] = await getJson<ContentSearchResponse>(sv.app, `/api/search/content?q=parser&origin=${origin}`);
        }
        return out;
      };
      const a = await view(without);
      expect(a['graph:c1']).not.toBeNull();
      expect(a['graph:cur-root']).not.toBeNull();
      expect(a[`graph:${CODEX_ROOT}`]).not.toBeNull();
      expect(await view(withNew)).toEqual(a);
    } finally {
      fx.close();
    }
  });
});
