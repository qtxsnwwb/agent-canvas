import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  defaultExportOptions,
  EXPORT_TEMPLATE_PLACEHOLDER,
  usageTotal,
  type AnomalyListResponse,
  type ContentSearchResponse,
  type ExportBundle,
  type GraphSnapshot,
  type Origin,
  type Project,
  type ProjectFilesResponse,
  type SearchHit,
  type Session,
  type SessionAnomaliesResponse,
  type SessionFilesResponse,
  type StatsResponse,
} from '@agent-canvas/shared';
import { AnomaliesService } from '../src/anomalies/service.js';
import { buildServer } from '../src/api/server.js';
import { fileSources } from '../src/cli.js';
import { loadConfig, type Config } from '../src/config.js';
import { ExportService } from '../src/export/service.js';
import { Pipeline } from '../src/pipeline.js';
import { CursorSource, type PollTimers } from '../src/sources/cursor/source.js';
import { StatsService, storeStatsSource } from '../src/stats/service.js';
import { openStore, type RawEvent, type Store } from '../src/store/store.js';
import * as buddy from './buddy-fixtures.js';
import { CodexThread } from './codex-fixtures.js';
import { rolloutRel } from './codex-rollout.js';
import * as copilot from './copilot-fixtures.js';
import { CursorDbFixture, T0 as CURSOR_T0, textBubble, thinkingBubble, toolBubble, userBubble } from './cursor-fixtures.js';
import * as dsh from './deepseek-fixtures.js';
import * as doubao from './doubao-fixtures.js';
import { FAKE_KEY } from './export-fixtures.js';
import { assistantBlock, toolResult, userPrompt } from './fixtures.js';
import * as gemini from './gemini-fixtures.js';
import * as grok from './grok-fixtures.js';
import * as qwen from './qwen-fixtures.js';

// Qwen Code (plan qwen-code) through the real file source, pipeline and HTTP API in every feature: projects, title and
// content search, stats, the by-file view (spec 9), anomalies (loop and cost), Markdown and HTML export, masking. Then:
// the ten older origins give identical API output with and without the Qwen directory present, and one directory shared
// by a Claude Code and a Qwen Code session is one project. Modelled on more-sources-cn-features.test.ts. Temp
// directories and invented data only (fake secrets assembled at run time); every config names every tool directory.
// DeepSeek needs node:zlib zstd (Node >= 22.15): without it the parts that need DeepSeek data leave it out.

if (!dsh.HAS_ZSTD) console.warn(dsh.NO_ZSTD_REASON);

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const HOST = '127.0.0.1:4999';
const NO_TIMERS: PollTimers = { set: () => null, clear: () => undefined };
const TEMPLATE = `<!doctype html><html><head><meta charset="utf-8"><script id="agent-canvas-export" type="application/json">${EXPORT_TEMPLATE_PLACEHOLDER}</script></head><body></body></html>`;
const MIN = 60_000;

let tmp: string;
let templateFile: string;
const stores: Store[] = [];
const apps: FastifyInstance[] = [];
const pipelines: Pipeline[] = [];

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-qwen-features-'));
  templateFile = path.join(tmp, 'viewer-template.html');
  await fs.writeFile(templateFile, TEMPLATE);
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

async function write(file: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}
const body = (lines: readonly string[]): string => lines.map((l) => `${l}\n`).join('');
const dirs = () => ({
  geminiDir: path.join(tmp, '.gemini'),
  grokDir: path.join(tmp, '.grok'),
  copilotDir: path.join(tmp, '.copilot'),
  deepseekDir: path.join(tmp, '.dsh'),
  workbuddyDirs: [path.join(tmp, '.workbuddy'), path.join(tmp, '.workbuddy-ai')],
  codebuddyDir: path.join(tmp, '.codebuddy'),
  doubaoDirs: [path.join(tmp, 'DoubaoWork', 'User Data'), path.join(tmp, 'Doubao', 'User Data')],
  qwenDir: path.join(tmp, '.qwen'),
});
type Dirs = ReturnType<typeof dirs>;

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
  const exports = new ExportService({ store, dataDir: config.dataDir, findTemplate: () => templateFile, version: '0.0.0-test', now: () => new Date(NOW), machineUser: () => 'machineuser' });
  const app = buildServer({ store, pipeline, config, stats, anomalies, exports });
  apps.push(app);
  return { app, store, pipeline };
}
const getJson = async <T>(app: FastifyInstance, url: string): Promise<T> => {
  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode, url).toBe(200);
  return res.json() as T;
};
/** POST /api/sessions/:id/export with the default options (credentials and assignments masked) in `format`. */
async function exportSession(app: FastifyInstance, sessionId: string, format: 'md' | 'html'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/sessions/${encodeURIComponent(sessionId)}/export`,
    headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ ...defaultExportOptions(false), format }),
  });
  expect(res.statusCode, `${format} ${sessionId}`).toBe(200);
  return res.body;
}
/** The data embedded in an exported HTML file. */
function embedded(html: string): ExportBundle {
  const open = 'type="application/json">';
  const start = html.indexOf(open) + open.length;
  return JSON.parse(html.slice(start, html.indexOf('</script>', start))) as ExportBundle;
}

// ---- Qwen Code sessions on disk ----

const Q_SID = qwen.SID;
const Q_LOOP = '3b1e0c9a-5d2f-4e61-8a70-00000000100f';
const Q_AGENT = 'Explore-call_b7';
/** The fixtures' working directory and the project id it gives. */
const Q_PROJECT = '-home-u-app';
/** Qwen Code's own project directory name (lossy, opaque: the project comes from the records' cwd). */
const Q_DIR = 'home-u-app';

/** The lines with every record's `cwd` replaced. */
const withCwd = (lines: readonly string[], cwd: string): string[] => lines.map((l) => JSON.stringify({ ...(JSON.parse(l) as object), cwd }));

/**
 * The example session: a prompt, a reply with thinking, text and a read_file call, its result, a reply delegating to an
 * `agent` call (with its subagent thread and sidecar), the agent's result, a final reply, turn_result.
 */
function qwenExample(): { main: string[]; agent: string[]; meta: string } {
  const log = new qwen.Log();
  log.add((env) => qwen.sessionModel('qwen-oauth', env));
  log.prompt('fix the flaky upload test');
  log.reply([qwen.thought('The test races the cleanup.'), qwen.text("I'll look at the test first."), qwen.fcall('read_file', { absolute_path: '/home/u/app/test/upload.test.ts' }, 'call_a1')], { usage: qwen.usageMeta(18_230, 212, 17_408, 96) });
  log.result('read_file', "import { test } from 'vitest'", { id: 'call_a1', resultDisplay: 'Read 84 lines' });
  log.reply([qwen.text('Asking an agent for the callers.'), qwen.fcall('agent', qwen.agentArgs('Explore'), 'call_b7')], { usage: qwen.usageMeta(18_400, 30, 18_000) });
  log.result('agent', 'One caller: src/a.ts:12.', { id: 'call_b7', resultDisplay: qwen.agentResultDisplay('Explore') });
  log.reply([qwen.text('Fixed: the cleanup now waits.')], { usage: qwen.usageMeta(18_600, 40, 18_000) });
  log.add((env) => qwen.turnResult('completed', env));
  return { main: log.lines, agent: qwen.agentThread(Q_AGENT).log.lines, meta: qwen.agentMeta({ agentId: Q_AGENT, agentType: 'Explore', toolUseId: 'call_b7' }) };
}

/** One turn: a prompt carrying the fake key, the same `npm test` call five times (a `loop`), an edit, a reply. */
function qwenLoop(sessionId: string, prompt = 'run the suite'): string[] {
  const log = new qwen.Log({ sessionId, prefix: 'l' });
  log.prompt(`${prompt} with token ${FAKE_KEY}`);
  for (let i = 1; i <= 5; i++) {
    log.reply([qwen.fcall('run_shell_command', { command: 'npm test' }, `call_${i}`)], { usage: qwen.usageMeta(1000, 5) });
    log.result('run_shell_command', 'ok', { id: `call_${i}` });
  }
  log.reply([qwen.fcall('replace', { file_path: '/home/u/app/src/parser.ts', old_string: 'a', new_string: 'b' }, 'call_e')], { usage: qwen.usageMeta(1000, 5) });
  log.result('replace', 'edited', { id: 'call_e' });
  log.reply([qwen.text('the suite passes')], { usage: qwen.usageMeta(1000, 5) });
  log.add((env) => qwen.turnResult('completed', env));
  return log.lines;
}

/** The example session (with its subagent), its title sidecar, and a loop session, under `<qwenDir>/projects/<dir>`. */
async function writeQwen(d: Dirs, dir = Q_DIR): Promise<void> {
  const projects = path.join(d.qwenDir, 'projects', dir);
  const ex = qwenExample();
  await write(path.join(projects, 'chats', `${Q_SID}.jsonl`), body(ex.main));
  await write(path.join(projects, 'chats', `${Q_SID}.title.json`), qwen.titleSidecar('Fix the flaky upload test', 'auto'));
  await write(path.join(projects, 'subagents', Q_SID, `agent-${Q_AGENT}.jsonl`), body(ex.agent));
  await write(path.join(projects, 'subagents', Q_SID, `agent-${Q_AGENT}.meta.json`), ex.meta);
  await write(path.join(projects, 'chats', `${Q_LOOP}.jsonl`), body(qwenLoop(Q_LOOP)));
}

const qwenConfig = (d: Dirs, o: Partial<Config> = {}): Config =>
  loadConfig({}, {
    projectsDir: path.join(tmp, 'projects'),
    dataDir: path.join(tmp, 'data'),
    codexSessionsDir: null,
    cursorDbPath: null,
    geminiDir: null,
    grokDir: null,
    copilotDir: null,
    deepseekDir: null,
    workbuddyDirs: [],
    codebuddyDir: null,
    doubaoDirs: [],
    qwenDir: d.qwenDir,
    ...o,
  });

describe('Qwen Code in every feature', () => {
  test('projects, title and content search, stats, by-file view, anomalies, Markdown and HTML export, masking, diagnostics', { timeout: 30_000 }, async () => {
    const d = dirs();
    await writeQwen(d);
    const { app, pipeline, store } = await serve(qwenConfig(d));
    expect(pipeline.ingestFailures()).toEqual([]);
    expect(store.diagnostics().unknownRecords).toEqual([]);

    // Projects: from the records' cwd, not from Qwen Code's lossy directory name.
    const projects = await getJson<Project[]>(app, '/api/projects');
    expect(projects.map((p) => [p.id, p.cwd, p.origins, p.sessionCount])).toEqual([[Q_PROJECT, '/home/u/app', ['qwen'], 2]]);
    const sessions = await getJson<Session[]>(app, `/api/projects/${encodeURIComponent(Q_PROJECT)}/sessions`);
    expect(sessions.map((s) => s.id).sort()).toEqual([Q_SID, Q_LOOP].sort());
    expect(sessions.every((s) => s.origin === 'qwen')).toBe(true);
    // The title sidecar (source auto) is used; the loop session falls back to its first prompt.
    expect(sessions.find((s) => s.id === Q_SID)?.title).toBe('Fix the flaky upload test');
    expect(sessions.find((s) => s.id === Q_LOOP)?.title).toContain('run the suite');
    // The subagent thread is part of the session graph, linked to its dispatch node.
    const graph = await getJson<GraphSnapshot>(app, `/api/sessions/${Q_SID}/graph`);
    expect(graph.nodes.find((n) => n.kind === 'subagent')).toMatchObject({ childAgentId: Q_AGENT, title: 'Explore' });
    expect(graph.nodes.some((n) => n.agentId === Q_AGENT)).toBe(true);

    // Title search.
    const titled = await getJson<SearchHit[]>(app, `/api/search?q=${encodeURIComponent('flaky upload')}`);
    expect(titled.map((h) => h.session.id)).toContain(Q_SID);

    // Content search, all origins and Qwen Code only; the subagent's text is found too.
    const all = await getJson<ContentSearchResponse>(app, `/api/search/content?q=${encodeURIComponent('cleanup now waits')}`);
    expect(all.hits.map((h) => [h.sessionId, h.origin])).toContainEqual([Q_SID, 'qwen']);
    const only = await getJson<ContentSearchResponse>(app, `/api/search/content?q=${encodeURIComponent('src/a.ts:12')}&origin=qwen`);
    expect(only.hits.length).toBeGreaterThan(0);
    expect(only.hits.every((h) => h.origin === 'qwen' && h.sessionId === Q_SID)).toBe(true);
    const none = await getJson<ContentSearchResponse>(app, `/api/search/content?q=${encodeURIComponent('cleanup now waits')}&origin=claude`);
    expect(none.hits).toEqual([]);

    // Anomalies: the five identical calls of the loop session; the example session has none of that kind.
    const found = await getJson<SessionAnomaliesResponse>(app, `/api/sessions/${encodeURIComponent(Q_LOOP)}/anomalies`);
    expect(found.anomalies.map((a) => a.kind)).toContain('loop');
    const list = await getJson<AnomalyListResponse>(app, '/api/anomalies?range=all&origin=qwen');
    expect(list.items.some((a) => a.kind === 'loop' && a.sessionId === Q_LOOP)).toBe(true);
    expect(list.items.some((a) => a.kind === 'loop' && a.sessionId === Q_SID)).toBe(false);
    expect(list.failedSessions).toBe(0);

    // Markdown export names the origin; the fake key of the loop session is masked in both formats.
    expect(await exportSession(app, Q_SID, 'md')).toContain('来源：Qwen Code');
    const md = await exportSession(app, Q_LOOP, 'md');
    expect(md).toContain('npm test');
    expect(md).not.toContain(FAKE_KEY);
    expect(md).toContain('‹已遮蔽·');
    const html = await exportSession(app, Q_LOOP, 'html');
    expect(html).not.toContain(FAKE_KEY);
    const bundle = embedded(html);
    expect(bundle.session).toMatchObject({ id: Q_LOOP, origin: 'qwen' });
    expect(bundle.nodes.length).toBeGreaterThan(5);
    const exBundle = embedded(await exportSession(app, Q_SID, 'html'));
    expect(exBundle.session.origin).toBe('qwen');
    // The subagent's nodes travel with the session.
    expect(exBundle.nodes.some((n) => n.agentId === Q_AGENT)).toBe(true);

    // Stats: Qwen Code's tokens are the sum of its sessions' node usage (main thread and subagent); it has token data.
    const stats = await getJson<StatsResponse>(app, '/api/stats?range=all');
    const t = usageTotal([Q_SID, Q_LOOP].flatMap((id) => store.getGraph(id)!.nodes));
    const byOrigin = Object.fromEntries(stats.byOrigin.map((o) => [o.origin, o.tokens]));
    expect(byOrigin.qwen).toEqual({ input: t.inputTokens, cachedInput: t.cachedInputTokens, output: t.outputTokens });
    // Spec 4.5: cache reads apart, input = prompt − cached. Main: (18230−17408) + (18400−18000) + (18600−18000), the
    // loop 7 × 1000; agent thread 5120 + 5300 (no cache).
    expect(byOrigin.qwen!.cachedInput).toBe(17_408 + 18_000 + 18_000);
    expect(byOrigin.qwen!.input).toBe(822 + 400 + 600 + 7 * 1000 + 5120 + 5300);
    expect(byOrigin.qwen!.output).toBeGreaterThan(0);
    expect(stats.coverage.noTokenData).toEqual([]);
    expect(stats.totals.sessions).toBe(2);
    const onlyQwen = await getJson<StatsResponse>(app, '/api/stats?range=all&origin=qwen');
    expect(onlyQwen.totals.sessions).toBe(2);

    // By-file view (spec 9; tool and argument names from the unverified table): read_file {absolute_path} is a read,
    // replace {file_path} an edit; run_shell_command and agent name no file.
    const filesOf = async (sid: string) => (await getJson<SessionFilesResponse>(app, `/api/sessions/${encodeURIComponent(sid)}/files`)).files.map((f) => [f.path, f.counts]);
    expect(await filesOf(Q_SID)).toEqual([['/home/u/app/test/upload.test.ts', { read: 1, edit: 0, write: 0, delete: 0 }]]);
    expect(await filesOf(Q_LOOP)).toEqual([['/home/u/app/src/parser.ts', { read: 0, edit: 1, write: 0, delete: 0 }]]);
    const pf = await getJson<ProjectFilesResponse>(app, `/api/files?projectId=${encodeURIComponent(Q_PROJECT)}&origin=qwen&range=all&changedOnly=0`);
    expect(pf.files.map((f) => f.path).sort()).toEqual(['/home/u/app/src/parser.ts', '/home/u/app/test/upload.test.ts']);

    // Diagnostics: the source reads, with its session count; no managed session.
    const diag = await getJson<{ sources: Record<string, Record<string, unknown>> }>(app, '/api/diagnostics');
    expect(diag.sources.qwen).toMatchObject({ dir: path.join(d.qwenDir, 'projects'), present: true, reading: true, sessionCount: 2, unsupportedSessions: 0 });
  });

  // 50 sessions written, ingested and summarised; nothing in it is a timing bound.
  test('cost anomaly: 25 one-turn Qwen Code sessions with one 50× outlier in tokens give a cost anomaly for it only', { timeout: 30_000 }, async () => {
    const d = dirs();
    const projects = path.join(d.qwenDir, 'projects', Q_DIR, 'chats');
    for (let i = 0; i < 25; i++) {
      const big = i === 24;
      const sid = `9a000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const log = new qwen.Log({ sessionId: sid, t0: Date.parse('2026-11-12T12:00:00.000Z') + i * 20 * MIN });
      log.prompt('run the tests');
      log.reply([qwen.fcall('run_shell_command', { command: 'npm test' }, 'c')], { usage: qwen.usageMeta(big ? 5_000_000 : 100_000, 1000) });
      log.result('run_shell_command', 'ok', { id: 'c' });
      log.reply([qwen.text('done')], { usage: qwen.usageMeta(1000, 10) });
      log.add((env) => qwen.turnResult('completed', env));
      await write(path.join(projects, `${sid}.jsonl`), body(log.lines));
    }
    const { app, pipeline, store } = await serve(qwenConfig(d));
    expect(pipeline.ingestFailures()).toEqual([]);
    expect(store.listProjects(NOW).map((p) => [p.id, p.sessionCount, p.origins])).toEqual([[Q_PROJECT, 25, ['qwen']]]);
    const kinds = async (id: string): Promise<string[]> =>
      (await getJson<SessionAnomaliesResponse>(app, `/api/sessions/${encodeURIComponent(id)}/anomalies`)).anomalies.map((a) => a.kind);
    expect(await kinds('9a000000-0000-4000-8000-000000000024')).toContain('cost');
    expect(await kinds('9a000000-0000-4000-8000-000000000003')).not.toContain('cost');
    const list = await getJson<AnomalyListResponse>(app, '/api/anomalies?range=all&origin=qwen');
    expect(list.items.filter((a) => a.kind === 'cost').map((a) => [a.sessionId, a.basis])).toEqual([['9a000000-0000-4000-8000-000000000024', 'tokens']]);
    expect(list.failedSessions).toBe(0);
  });
});

// ---- the ten older origins ----

const DS_LOOP = 'd5000000-0000-4000-8000-00000000100f';
const WB_SID = buddy.SID;
const WB_LOOP = 'b0000000-0000-4000-8000-00000000100f';
const CB_SID = 'c0000000-0000-4000-8000-000000000001';
const CB_LOOP = 'c0000000-0000-4000-8000-00000000100f';
const DB_LOOP = '7391000000000000999';
const BUDDY_DIR = 'home-dev-repo';
const CODEX_ROOT = '019a0000-0000-7000-8000-0000000000c1';

/** A DeepSeek session file (header + rows in one batch), its sessions directory under `<dsh>/sessions`. */
async function writeDsh(d: Dirs, id: string, cwd: string, lines: readonly string[]): Promise<void> {
  await dsh.writeSession(path.join(d.deepseekDir, 'sessions', ...dsh.sessionRel(id, cwd).split('/')), dsh.headerLine({ id, cwd }), [lines]);
}
/** One DeepSeek turn: a prompt, the same `npm test` call five times, a reply (as more-sources-cn-features writes it). */
function dshLoop(): string[] {
  const l = new dsh.DshLog();
  l.turnStart(1);
  l.user('run the suite about the parser');
  for (let i = 1; i <= 5; i++) {
    l.stepStart(1, i);
    l.assistant(1, i, [dsh.callBlock(`call_0${i}`, 'bash', { command: 'npm test' })], { id: `lm-${i}` });
    l.toolCall(1, i, `call_0${i}`, 'bash', { command: 'npm test' });
    l.toolResult(1, i, `call_0${i}`, 'ok');
    l.stepEnd(1, i);
  }
  l.stepStart(1, 6);
  l.assistant(1, 6, [dsh.textBlock('the suite passes')], { id: 'lm-6' });
  l.stepEnd(1, 6);
  l.turnEnd(1);
  return l.lines;
}
function buddyLoop(sessionId: string, cwd = buddy.CWD): string[] {
  const c = new buddy.Chain({ sessionId, cwd, prefix: 'l' });
  c.prompt('run the parser suite');
  for (let i = 1; i <= 5; i++) {
    c.call('Bash', `call_${i}`, { command: 'npm test' }, `lresp-${i}`, { usage: buddy.openaiUsage(100, 5) });
    c.result('Bash', `call_${i}`, 'ok', `lresp-${i}`);
  }
  c.reply('the suite passes', 'lresp-6', { usage: buddy.openaiUsage(100, 5) });
  return c.lines;
}

/** DeepSeek (when zstd is there), WorkBuddy, CodeBuddy and 豆包: the example sessions and a loop session each. */
async function writeCn(d: Dirs): Promise<string[]> {
  const ids: string[] = [];
  if (dsh.HAS_ZSTD) {
    for (const [id, f] of [[dsh.SID, dsh.exampleMain()], [dsh.CHILD, dsh.exampleChild()], [dsh.GRANDCHILD, dsh.exampleGrandchild()]] as const) {
      await dsh.writeSession(path.join(d.deepseekDir, 'sessions', ...dsh.sessionRel(id).split('/')), f.header, [f.lines]);
    }
    await writeDsh(d, DS_LOOP, dsh.CWD, dshLoop());
    ids.push(dsh.SID, DS_LOOP);
  }
  for (const [root, sid, loop] of [[d.workbuddyDirs[1]!, WB_SID, WB_LOOP], [d.codebuddyDir, CB_SID, CB_LOOP]] as const) {
    const projects = path.join(root, 'projects', BUDDY_DIR);
    await write(path.join(projects, `${sid}.jsonl`), body(buddy.exampleMain().lines));
    await write(path.join(projects, sid, 'subagents', `${buddy.CHILD}.jsonl`), body(buddy.exampleChild().lines));
    await write(path.join(projects, `${loop}.jsonl`), body(buddyLoop(loop)));
    ids.push(sid, loop);
  }
  const dbRoot = d.doubaoDirs[0]!;
  await doubao.writeExample(dbRoot);
  const lines = [doubao.user('run the parser suite')];
  for (let i = 1; i <= 5; i++) {
    lines.push(doubao.assistant(undefined, [doubao.call(`c${i}`, 'Bash', { command: 'npm test' })]));
    lines.push(doubao.tool(`c${i}`, 'ok'));
  }
  lines.push(doubao.assistant('the suite passes'));
  await doubao.write(doubao.agentFile(dbRoot, doubao.MAIN, 'trajectory.jsonl', { conv: DB_LOOP }), body(lines));
  await doubao.write(doubao.agentFile(dbRoot, doubao.MAIN, 'assignment.md', { conv: DB_LOOP }), doubao.assignment([{ at: doubao.T1, text: 'run the parser suite' }]));
  ids.push(doubao.CONV, DB_LOOP);
  return ids;
}

/** Gemini CLI, Grok and Copilot CLI example sessions on `cwd` (as more-sources-features.test.ts writes them). */
async function writeOldFileSources(d: Dirs, cwd: string): Promise<void> {
  const gTmp = path.join(d.geminiDir, 'tmp');
  await write(path.join(gTmp, 'demo-app', '.project_root'), cwd);
  await write(path.join(gTmp, ...gemini.MAIN_REL.split('/')), body(gemini.exampleLines()));
  const grokSessions = path.join(d.grokDir, 'sessions');
  await write(path.join(grokSessions, grok.DIR, grok.SID, 'summary.json'), grok.summaryJson({ cwd }));
  await write(path.join(grokSessions, grok.DIR, grok.SID, 'updates.jsonl'), body(grok.exampleLines()));
  const state = path.join(d.copilotDir, 'session-state');
  const lines = copilot.exampleRecords().map((r) =>
    r.type === 'session.start' ? JSON.stringify({ ...r, data: { ...(r.data as object), context: { cwd, branch: 'main' } } }) : JSON.stringify(r));
  await write(path.join(state, copilot.SID, 'events.jsonl'), body(lines));
  await write(path.join(state, copilot.SID, 'workspace.yaml'), copilot.WORKSPACE_YAML.replace(`cwd: ${copilot.CWD}`, `cwd: ${cwd}`));
}

/** Claude Code, Codex and Cursor sessions on `cwd`, each running the same call five times (a `loop` anomaly). */
async function writeOldHookSources(projectsDir: string, codexSessionsDir: string, fx: CursorDbFixture, cwd: string): Promise<void> {
  const s = (sec: number): number => CURSOR_T0 + sec * 1000;
  const project = cwd.replace(/[^A-Za-z0-9]/g, '-');
  const claudeBody = (events: RawEvent[]): string => body(events.map((e) => (e.source === 'transcript' ? e.line : '')));
  const claudeLoop: RawEvent[] = [];
  let prev = 'u1';
  for (let i = 0; i < 5; i++) {
    claudeLoop.push(assistantBlock(`t${i}`, prev, { type: 'tool_use', id: `tu${i}`, name: 'Bash', input: { command: 'npm test' } }));
    claudeLoop.push(toolResult(`r${i}`, `t${i}`, `tu${i}`, 'ok'));
    prev = `r${i}`;
  }
  claudeLoop.push(assistantBlock('e1', prev, { type: 'tool_use', id: 'tuE', name: 'Edit', input: { file_path: path.join(cwd, 'src', 'parser.ts'), old_string: 'a', new_string: 'b' } }));
  claudeLoop.push(toolResult('rE', 'e1', 'tuE', 'edited'));
  await write(path.join(projectsDir, project, 'c1.jsonl'), claudeBody([
    userPrompt('u1', null, 'claude prompt about the parser', { sessionId: 'c1' }),
    ...claudeLoop,
    assistantBlock('a1', 'rE', { type: 'text', text: 'looked at the parser' }),
  ]));
  const codex = new CodexThread({ id: CODEX_ROOT, cwd });
  codex.meta();
  codex.started('t1');
  codex.user('p1', 'codex prompt about the parser');
  for (let i = 0; i < 5; i++) {
    codex.exec(`call_${i}`, 'npm test');
    codex.output(`call_${i}`);
  }
  codex.assistant('m1', 'done');
  codex.complete();
  await write(path.join(codexSessionsDir, ...rolloutRel(CODEX_ROOT).split('/')), body(codex.lines));
  fx.put({
    id: 'cur-root', name: 'Cursor conversation about the parser', status: 'completed', dataFsPath: cwd, createdAt: s(0), lastUpdatedAt: s(30),
    bubbles: [
      userBubble('u1', 'find the parser', s(1)),
      thinkingBubble('th1', 'where would it be', s(2)),
      toolBubble('t1', 'grep', 'completed', s(3), { params: { pattern: 'parse' } }),
      ...[0, 1, 2, 3, 4].map((i) => toolBubble(`loop${i}`, 'run_terminal_command_v2', 'completed', s(4 + i), { params: { command: 'npm test' } })),
      textBubble('a1', 'it is in src/parser.ts', s(20), { turnDurationMs: 19_000 }),
    ],
  });
}

const OLD_ORIGINS: readonly Origin[] = ['claude', 'codex', 'cursor', 'gemini', 'grok', 'copilot', ...(dsh.HAS_ZSTD ? ['deepseek' as const] : []), 'workbuddy', 'codebuddy', 'doubao'];

describe('the ten older origins are unchanged by the Qwen Code directory', () => {
  test('every API answer about the ten older origins is identical with and without the Qwen directory present', { timeout: 90_000 }, async () => {
    const cwd = path.join(tmp, 'work', 'app');
    const project = cwd.replace(/[^A-Za-z0-9]/g, '-');
    const projectsDir = path.join(tmp, 'projects');
    const codexSessionsDir = path.join(tmp, 'codex', 'sessions');
    const fx = new CursorDbFixture(path.join(tmp, 'Cursor'));
    try {
      await writeOldHookSources(projectsDir, codexSessionsDir, fx, cwd);
      const d = dirs();
      await writeOldFileSources(d, cwd);
      const cnIds = await writeCn(d);
      // Qwen Code: its usual sessions, plus a loop session on the older origins' directory whose text matches the
      // searches below.
      await writeQwen(d);
      const qOnCwd = '3b1e0c9a-5d2f-4e61-8a70-00000000100e';
      await write(path.join(d.qwenDir, 'projects', 'work-app', 'chats', `${qOnCwd}.jsonl`), body(withCwd(qwenLoop(qOnCwd, 'parser suite'), cwd)));
      const oldSessions = ['c1', CODEX_ROOT, 'cur-root', gemini.SID, grok.SID, copilot.SID, ...cnIds];

      const base = { projectsDir, dataDir: path.join(tmp, 'data'), codexSessionsDir, cursorDbPath: fx.dbPath };
      const cursor = () => [new CursorSource({ dbPath: fx.dbPath, now: () => NOW, timers: NO_TIMERS })];
      const without = await serve(loadConfig({}, {
        ...base, geminiDir: d.geminiDir, grokDir: d.grokDir, copilotDir: d.copilotDir, deepseekDir: d.deepseekDir, workbuddyDirs: d.workbuddyDirs, codebuddyDir: d.codebuddyDir, doubaoDirs: d.doubaoDirs,
        qwenDir: null,
      }), cursor());
      const withQwen = await serve(loadConfig({}, {
        ...base, geminiDir: d.geminiDir, grokDir: d.grokDir, copilotDir: d.copilotDir, deepseekDir: d.deepseekDir, workbuddyDirs: d.workbuddyDirs, codebuddyDir: d.codebuddyDir, doubaoDirs: d.doubaoDirs,
        qwenDir: d.qwenDir,
      }), cursor());
      expect(without.pipeline.ingestFailures()).toEqual([]);
      expect(withQwen.pipeline.ingestFailures()).toEqual([]);
      // Not vacuous: Qwen Code is really read, and one of its sessions shares the older ones' project.
      const originsOf = (sv: Served) => sv.store.listProjects(NOW).find((p) => p.id === project)?.origins;
      const before = originsOf(without)!;
      expect(before).toEqual(expect.arrayContaining(['claude', 'codex', 'cursor', 'gemini', 'grok', 'copilot']));
      expect(originsOf(withQwen)).toEqual([...before, 'qwen']);
      expect(withQwen.store.listProjects(NOW).map((p) => p.id)).toContain(Q_PROJECT);
      expect(without.store.listProjects(NOW).map((p) => p.id)).not.toContain(Q_PROJECT);

      const byId = <T extends { id: string }>(xs: T[]): T[] => [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const oldSession = (s: { id: string }): boolean => oldSessions.includes(s.id);
      const view = async (sv: Served) => {
        const out: Record<string, unknown> = {};
        out.projects = (await getJson<Project[]>(sv.app, '/api/projects')).filter((p) => p.id !== Q_PROJECT).map((p) => ({ ...p, origins: p.origins.filter((o) => o !== 'qwen'), ...(p.id === project ? { sessionCount: null, lastActivityAt: null } : {}) }));
        out.projectSessions = (await getJson<Session[]>(sv.app, `/api/projects/${encodeURIComponent(project)}/sessions`)).filter(oldSession);
        out.titleSearch = (await getJson<SearchHit[]>(sv.app, '/api/search?q=parser')).filter((h) => oldSession(h.session));
        for (const id of oldSessions) {
          const g = await getJson<GraphSnapshot>(sv.app, `/api/sessions/${encodeURIComponent(id)}/graph`);
          out[`graph:${id}`] = { session: g.session, nodes: byId(g.nodes), edges: byId(g.edges) };
          for (const n of byId(g.nodes)) out[`node:${id}:${n.id}`] = sv.store.getNodeDetail(id, n.id);
          out[`anomalies:${id}`] = await getJson<SessionAnomaliesResponse>(sv.app, `/api/sessions/${encodeURIComponent(id)}/anomalies`);
          out[`files:${id}`] = await getJson<SessionFilesResponse>(sv.app, `/api/sessions/${encodeURIComponent(id)}/files`);
          out[`md:${id}`] = await exportSession(sv.app, id, 'md');
          out[`html:${id}`] = embedded(await exportSession(sv.app, id, 'html'));
        }
        for (const origin of OLD_ORIGINS) {
          const { generatedAt: _g, ...stats } = await getJson<StatsResponse>(sv.app, `/api/stats?range=all&origin=${origin}`);
          out[`stats:${origin}`] = stats;
          out[`anomalyList:${origin}`] = await getJson<AnomalyListResponse>(sv.app, `/api/anomalies?range=all&origin=${origin}`);
          out[`search:${origin}`] = await getJson<ContentSearchResponse>(sv.app, `/api/search/content?q=parser&origin=${origin}`);
          out[`projectFiles:${origin}`] = await getJson<ProjectFilesResponse>(sv.app, `/api/files?projectId=${encodeURIComponent(project)}&origin=${origin}&range=all&changedOnly=0`);
        }
        return out;
      };
      const a = await view(without);
      // Not vacuous: every older session has a graph, the searches and lists have hits.
      for (const id of oldSessions) expect((a[`graph:${id}`] as { nodes: unknown[] }).nodes.length, id).toBeGreaterThan(0);
      for (const origin of ['claude', 'codex', 'cursor']) expect((a[`anomalyList:${origin}`] as AnomalyListResponse).items.length, origin).toBeGreaterThan(0);
      for (const origin of ['claude', 'codex', 'cursor', 'workbuddy', 'codebuddy']) expect((a[`search:${origin}`] as ContentSearchResponse).hits.length, origin).toBeGreaterThan(0);
      expect((a.projectSessions as Session[]).map((s) => s.id).sort()).toEqual(['c1', CODEX_ROOT, 'cur-root', gemini.SID, grok.SID, copilot.SID].sort());
      // With the Qwen directory the same searches also find Qwen Code sessions (so the filters above matter).
      expect((await getJson<ContentSearchResponse>(withQwen.app, '/api/search/content?q=parser')).hits.some((h) => h.origin === 'qwen')).toBe(true);
      const b = await view(withQwen);
      expect(b).toEqual(a);
    } finally {
      fx.close();
    }
  });
});

describe('one directory, one project', () => {
  test('Claude Code and Qwen Code on one directory (Qwen Code also from a worktree below it): one project; another directory stays apart', async () => {
    const cwd = path.join(tmp, 'work', 'app');
    const other = path.join(tmp, 'work', 'app2');
    const project = cwd.replace(/[^A-Za-z0-9]/g, '-');
    const projectsDir = path.join(tmp, 'projects');
    await write(path.join(projectsDir, project, 'c1.jsonl'), body([userPrompt('u1', null, 'hello', { sessionId: 'c1' })].map((e) => (e.source === 'transcript' ? e.line : ''))));
    const d = dirs();
    const q = (sid: string, dir: string, folder: string) => write(path.join(d.qwenDir, 'projects', folder, 'chats', `${sid}.jsonl`), body(withCwd(qwenLoop(sid), dir)));
    // With a trailing separator, and in a Qwen project folder of another name: the records' cwd decides.
    await q('3b1e0c9a-5d2f-4e61-8a70-000000000a01', `${cwd}${path.sep}`, 'some-folder');
    // A Qwen Code worktree of the repository: the project is the repository (spec 3.3).
    const worktree = path.join(cwd, '.qwen', 'worktrees', 'fix-1');
    await q('3b1e0c9a-5d2f-4e61-8a70-000000000a02', worktree, 'wt');
    await q('3b1e0c9a-5d2f-4e61-8a70-000000000a03', other, 'other');
    const { store, pipeline } = await serve(qwenConfig(d, { projectsDir }));
    expect(pipeline.ingestFailures()).toEqual([]);
    const projects = store.listProjects(NOW).map((p) => [p.id, p.sessionCount, p.origins]).sort();
    expect(projects).toEqual([
      [project, 3, ['claude', 'qwen']],
      [other.replace(/[^A-Za-z0-9]/g, '-'), 1, ['qwen']],
    ].sort());
    // The worktree stays the session's own working directory.
    expect(store.getSession('3b1e0c9a-5d2f-4e61-8a70-000000000a02')?.cwd).toBe(worktree);
  });
});
