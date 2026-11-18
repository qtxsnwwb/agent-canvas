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

// The four origins of plan more-sources-cn (DeepSeek Harness, WorkBuddy, CodeBuddy Code, 豆包工作) through the real
// file sources, pipeline and HTTP API in every feature: projects, title and content search, stats, the by-file view,
// anomalies, Markdown and HTML export, masking. Then: the six older origins give identical API output with and without
// the four new directories present, and one directory shared by Claude Code, DeepSeek, WorkBuddy and CodeBuddy is one
// project. Modelled on more-sources-features.test.ts. Temp directories and invented data only (fake secrets assembled
// at run time); every config names every tool directory. DeepSeek needs node:zlib zstd (Node >= 22.15): without it
// the parts that need DeepSeek data are skipped or leave it out.

if (!dsh.HAS_ZSTD) console.warn(dsh.NO_ZSTD_REASON);

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const HOST = '127.0.0.1:4999';
const NO_TIMERS: PollTimers = { set: () => null, clear: () => undefined };
const TEMPLATE = `<!doctype html><html><head><meta charset="utf-8"><script id="agent-canvas-export" type="application/json">${EXPORT_TEMPLATE_PLACEHOLDER}</script></head><body></body></html>`;

let tmp: string;
let templateFile: string;
const stores: Store[] = [];
const apps: FastifyInstance[] = [];
const pipelines: Pipeline[] = [];

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-more-sources-cn-features-'));
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

// ---- the four new origins' sessions on disk ----

const DS_LOOP = 'd5000000-0000-4000-8000-00000000100f';
const WB_SID = buddy.SID;
const WB_LOOP = 'b0000000-0000-4000-8000-00000000100f';
const CB_SID = 'c0000000-0000-4000-8000-000000000001';
const CB_LOOP = 'c0000000-0000-4000-8000-00000000100f';
const DB_LOOP = '7391000000000000999';
/** The Buddy project directory name (lossy; not used for the project, which comes from the records' cwd). */
const BUDDY_DIR = 'home-dev-repo';
const BUDDY_PROJECT = '-home-dev-repo';

/** A DeepSeek session file (header + rows in one batch), its sessions directory under `<dsh>/sessions`. */
async function writeDsh(d: Dirs, id: string, cwd: string, lines: readonly string[]): Promise<void> {
  await dsh.writeSession(path.join(d.deepseekDir, 'sessions', ...dsh.sessionRel(id, cwd).split('/')), dsh.headerLine({ id, cwd }), [lines]);
}

/** One turn: a prompt carrying the fake key, the same `npm test` call five times (a `loop`), an edit, a reply. */
function dshLoop(): string[] {
  const l = new dsh.DshLog();
  l.turnStart(1);
  l.user(`run the suite with token ${FAKE_KEY}`);
  for (let i = 1; i <= 5; i++) {
    l.stepStart(1, i);
    l.assistant(1, i, [dsh.callBlock(`call_0${i}`, 'bash', { command: 'npm test' })], { id: `lm-${i}` });
    l.toolCall(1, i, `call_0${i}`, 'bash', { command: 'npm test' });
    l.toolResult(1, i, `call_0${i}`, 'ok');
    l.stepEnd(1, i);
  }
  l.stepStart(1, 6);
  l.assistant(1, 6, [dsh.callBlock('call_e', 'edit_file', { path: 'src/parser.ts', old: 'a', new: 'b' })], { id: 'lm-6' });
  l.toolCall(1, 6, 'call_e', 'edit_file', { path: 'src/parser.ts', old: 'a', new: 'b' });
  l.toolResult(1, 6, 'call_e', 'edited');
  l.stepEnd(1, 6);
  l.stepStart(1, 7);
  l.assistant(1, 7, [dsh.textBlock('the suite passes')], { id: 'lm-7' });
  l.stepEnd(1, 7);
  l.turnEnd(1);
  return l.lines;
}
function buddyLoop(sessionId: string, cwd = buddy.CWD): string[] {
  const c = new buddy.Chain({ sessionId, cwd, prefix: 'l' });
  c.prompt(`run the suite with token ${FAKE_KEY}`);
  for (let i = 1; i <= 5; i++) {
    c.call('Bash', `call_${i}`, { command: 'npm test' }, `lresp-${i}`, { usage: buddy.openaiUsage(100, 5) });
    c.result('Bash', `call_${i}`, 'ok', `lresp-${i}`);
  }
  c.reply('the suite passes', 'lresp-6', { usage: buddy.openaiUsage(100, 5) });
  return c.lines;
}
function doubaoLoop(): { lines: string[]; assignment: string } {
  const lines = [doubao.user(`run the suite with token ${FAKE_KEY}`)];
  for (let i = 1; i <= 5; i++) {
    lines.push(doubao.assistant(undefined, [doubao.call(`c${i}`, 'Bash', { command: 'npm test' })]));
    lines.push(doubao.tool(`c${i}`, 'ok'));
  }
  lines.push(doubao.assistant('the suite passes'));
  return { lines, assignment: doubao.assignment([{ at: doubao.T1, text: 'run the suite' }]) };
}

/**
 * Each new origin: its example session (with subagents) and a loop session. DeepSeek only when zstd is there. WorkBuddy
 * under its second default root (the first stays absent), Doubao under the standalone client's root.
 */
async function writeNewCn(d: Dirs): Promise<void> {
  if (dsh.HAS_ZSTD) {
    for (const [id, f] of [[dsh.SID, dsh.exampleMain()], [dsh.CHILD, dsh.exampleChild()], [dsh.GRANDCHILD, dsh.exampleGrandchild()]] as const) {
      await dsh.writeSession(path.join(d.deepseekDir, 'sessions', ...dsh.sessionRel(id).split('/')), f.header, [f.lines]);
    }
    await writeDsh(d, DS_LOOP, dsh.CWD, dshLoop());
  }
  const wbRoot = d.workbuddyDirs[1]!;
  for (const [root, sid, loop] of [[wbRoot, WB_SID, WB_LOOP], [d.codebuddyDir, CB_SID, CB_LOOP]] as const) {
    const projects = path.join(root, 'projects', BUDDY_DIR);
    await write(path.join(projects, `${sid}.jsonl`), body(buddy.exampleMain().lines));
    await write(path.join(projects, sid, 'subagents', `${buddy.CHILD}.jsonl`), body(buddy.exampleChild().lines));
    await write(path.join(projects, `${loop}.jsonl`), body(buddyLoop(loop)));
  }
  const dbRoot = d.doubaoDirs[0]!;
  await doubao.writeExample(dbRoot);
  const l = doubaoLoop();
  await doubao.write(doubao.agentFile(dbRoot, doubao.MAIN, 'trajectory.jsonl', { conv: DB_LOOP }), body(l.lines));
  await doubao.write(doubao.agentFile(dbRoot, doubao.MAIN, 'assignment.md', { conv: DB_LOOP }), l.assignment);
}

const cnConfig = (d: Dirs, o: Partial<Config> = {}): Config =>
  loadConfig({}, {
    projectsDir: path.join(tmp, 'projects'),
    dataDir: path.join(tmp, 'data'),
    codexSessionsDir: null,
    cursorDbPath: null,
    geminiDir: null,
    grokDir: null,
    copilotDir: null,
    deepseekDir: d.deepseekDir,
    workbuddyDirs: d.workbuddyDirs,
    codebuddyDir: d.codebuddyDir,
    doubaoDirs: d.doubaoDirs, qwenDir: null,
    ...o,
  });

const NEW_ORIGINS: readonly Origin[] = dsh.HAS_ZSTD ? ['deepseek', 'workbuddy', 'codebuddy', 'doubao'] : ['workbuddy', 'codebuddy', 'doubao'];
/** Per origin: the example session, its loop session, a title word, a content word, its export label. */
const CASES = [
  { origin: 'deepseek', sid: dsh.SID, loop: DS_LOOP, project: dsh.PROJECT, title: 'Fix the parser test', titleQ: 'parser test', word: 'fixed it', label: 'DeepSeek' },
  { origin: 'workbuddy', sid: WB_SID, loop: WB_LOOP, project: BUDDY_PROJECT, title: 'Fix failing fixture test', titleQ: 'fixture test', word: 'fixture path', label: 'WorkBuddy' },
  { origin: 'codebuddy', sid: CB_SID, loop: CB_LOOP, project: BUDDY_PROJECT, title: 'Fix failing fixture test', titleQ: 'fixture test', word: 'fixture path', label: 'CodeBuddy' },
  { origin: 'doubao', sid: doubao.CONV, loop: DB_LOOP, project: doubao.DOUBAO_PROJECT_ID, title: 'Summarise the three reports in this folder', titleQ: 'three reports', word: 'all three are fine', label: '豆包' },
].filter((c) => (NEW_ORIGINS as readonly string[]).includes(c.origin));

describe('the four new origins in every feature', () => {
  test('projects, title and content search, stats (豆包 without tokens), by-file view, anomalies, Markdown and HTML export, masking', { timeout: 30_000 }, async () => {
    const d = dirs();
    await writeNewCn(d);
    const { app, pipeline, store } = await serve(cnConfig(d));
    expect(pipeline.ingestFailures()).toEqual([]);
    expect(store.diagnostics().unknownRecords).toEqual([]);

    // Projects: DeepSeek's from its header cwd, WorkBuddy's and CodeBuddy's from the records' cwd (one project for
    // both), Doubao's the fixed project.
    const projects = await getJson<Project[]>(app, '/api/projects');
    const want: [string, Origin[]][] = [
      ...(dsh.HAS_ZSTD ? [[dsh.PROJECT, ['deepseek']] as [string, Origin[]]] : []),
      [BUDDY_PROJECT, ['workbuddy', 'codebuddy']],
      [doubao.DOUBAO_PROJECT_ID, ['doubao']],
    ];
    expect(projects.map((p) => [p.id, p.origins]).sort()).toEqual(want.sort());
    expect(projects.find((p) => p.id === doubao.DOUBAO_PROJECT_ID)).toMatchObject({ cwd: null, sessionCount: 2 });

    for (const c of CASES) {
      const sessions = await getJson<Session[]>(app, `/api/projects/${encodeURIComponent(c.project)}/sessions`);
      const mine = sessions.filter((s) => s.origin === c.origin);
      expect(mine.map((s) => s.id).sort(), c.origin).toEqual([c.sid, c.loop].sort());
      expect(mine.find((s) => s.id === c.sid)?.title, c.origin).toBe(c.title);

      // Title search.
      const titled = await getJson<SearchHit[]>(app, `/api/search?q=${encodeURIComponent(c.titleQ)}`);
      expect(titled.map((h) => h.session.id), c.origin).toContain(c.sid);

      // Content search, all origins and this origin only.
      const all = await getJson<ContentSearchResponse>(app, `/api/search/content?q=${encodeURIComponent(c.word)}`);
      expect(all.hits.map((h) => [h.sessionId, h.origin]), c.origin).toContainEqual([c.sid, c.origin]);
      const only = await getJson<ContentSearchResponse>(app, `/api/search/content?q=${encodeURIComponent(c.word)}&origin=${c.origin}`);
      expect(only.hits.length, c.origin).toBeGreaterThan(0);
      expect(only.hits.every((h) => h.origin === c.origin)).toBe(true);

      // Anomalies: the five identical calls of the loop session.
      const found = await getJson<SessionAnomaliesResponse>(app, `/api/sessions/${encodeURIComponent(c.loop)}/anomalies`);
      expect(found.anomalies.map((a) => a.kind), c.origin).toContain('loop');
      const list = await getJson<AnomalyListResponse>(app, `/api/anomalies?range=all&origin=${c.origin}`);
      expect(list.items.some((a) => a.kind === 'loop' && a.sessionId === c.loop), c.origin).toBe(true);
      expect(list.failedSessions).toBe(0);

      // Markdown export names the origin; the fake key of the loop session is masked in both formats.
      expect(await exportSession(app, c.sid, 'md'), c.origin).toContain(`来源：${c.label}`);
      const md = await exportSession(app, c.loop, 'md');
      expect(md, c.origin).toContain('npm test');
      expect(md, c.origin).not.toContain(FAKE_KEY);
      expect(md, c.origin).toContain('‹已遮蔽·');
      const html = await exportSession(app, c.loop, 'html');
      expect(html, c.origin).not.toContain(FAKE_KEY);
      const bundle = embedded(html);
      expect(bundle.session, c.origin).toMatchObject({ id: c.loop, origin: c.origin });
      expect(bundle.nodes.length, c.origin).toBeGreaterThan(5);
      expect(embedded(await exportSession(app, c.sid, 'html')).session.origin, c.origin).toBe(c.origin);
    }

    // Stats: each origin's tokens are the sum of its sessions' node usage (every thread); 豆包 has none, so it is the
    // one origin listed without token data.
    const stats = await getJson<StatsResponse>(app, '/api/stats?range=all');
    const tokensOf = (ids: string[]) => {
      const t = usageTotal(ids.flatMap((id) => store.getGraph(id)!.nodes));
      return { input: t.inputTokens, cachedInput: t.cachedInputTokens, output: t.outputTokens };
    };
    const byOrigin = Object.fromEntries(stats.byOrigin.map((o) => [o.origin, o.tokens]));
    for (const c of CASES.filter((x) => x.origin !== 'doubao')) {
      expect(byOrigin[c.origin], c.origin).toEqual(tokensOf([c.sid, c.loop]));
      expect(byOrigin[c.origin]!.output, c.origin).toBeGreaterThan(0);
    }
    expect(tokensOf([doubao.CONV, DB_LOOP])).toEqual({ input: 0, cachedInput: 0, output: 0 });
    expect(byOrigin.doubao).toBeNull();
    expect(stats.coverage.noTokenData).toEqual(['doubao']);
    expect(stats.totals.sessions).toBe(CASES.length * 2);

    // By-file view (tool and argument names from the unverified tables): per session and per project.
    const filesOf = async (sid: string) => (await getJson<SessionFilesResponse>(app, `/api/sessions/${encodeURIComponent(sid)}/files`)).files.map((f) => [f.path, f.counts]);
    if (dsh.HAS_ZSTD) {
      // read_file {path} (it failed: listed, counted as failed only), resolved against the session's cwd at the call.
      const ds = await getJson<SessionFilesResponse>(app, `/api/sessions/${encodeURIComponent(dsh.SID)}/files`);
      // The session's cwd later moved to packages\api, so the file is outside it: relativePath is the full path.
      expect(ds.files.map((f) => [f.path, f.relativePath, f.failed, f.reads])).toEqual([['D:/Projects/Demo/src/parser.ts', 'D:/Projects/Demo/src/parser.ts', 1, 0]]);
    }
    for (const sid of [WB_SID, CB_SID]) expect(await filesOf(sid), sid).toEqual([['/home/dev/repo/src/a.ts', { read: 1, edit: 0, write: 0, delete: 0 }]]);
    const dbFiles = await getJson<SessionFilesResponse>(app, `/api/sessions/${doubao.CONV}/files`);
    expect(dbFiles.files.map((f) => f.path).sort()).toEqual(['figures.csv', 'report-1.md', 'report-2.md']);
    expect(dbFiles.files.find((f) => f.path === 'figures.csv')).toMatchObject({ created: true, changed: true });
    for (const c of CASES) {
      const pf = await getJson<ProjectFilesResponse>(app, `/api/files?projectId=${encodeURIComponent(c.project)}&origin=${c.origin}&range=all&changedOnly=0`);
      expect(pf.files.length, c.origin).toBeGreaterThan(0);
    }

    // Diagnostics: every new source reads, with its session count.
    const diag = await getJson<{ sources: Record<string, { reading: boolean; sessionCount: number }> }>(app, '/api/diagnostics');
    for (const c of CASES) expect(diag.sources[c.origin], c.origin).toMatchObject({ reading: true, sessionCount: 2 });
  });
});

// ---- the six older origins ----

const CODEX_ROOT = '019a0000-0000-7000-8000-0000000000c1';
const OLD_ORIGINS = ['claude', 'codex', 'cursor', 'gemini', 'grok', 'copilot'] as const;
const OLD_SESSIONS = ['c1', CODEX_ROOT, 'cur-root', gemini.SID, grok.SID, copilot.SID];

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

describe('the six older origins are unchanged by the four new directories', () => {
  test('every API answer about Claude Code, Codex, Cursor, Gemini CLI, Grok and Copilot CLI is identical with and without the new directories present', { timeout: 60_000 }, async () => {
    const cwd = path.join(tmp, 'work', 'app');
    const project = cwd.replace(/[^A-Za-z0-9]/g, '-');
    const projectsDir = path.join(tmp, 'projects');
    const codexSessionsDir = path.join(tmp, 'codex', 'sessions');
    const fx = new CursorDbFixture(path.join(tmp, 'Cursor'));
    try {
      await writeOldHookSources(projectsDir, codexSessionsDir, fx, cwd);
      const d = dirs();
      await writeOldFileSources(d, cwd);
      // The new origins' sessions: their usual examples, plus one session each on the same directory (the project of
      // the older ones) whose text matches the searches below.
      await writeNewCn(d);
      if (dsh.HAS_ZSTD) await writeDsh(d, DS_LOOP.replace(/f$/, 'e'), cwd, dshLoop());
      await write(path.join(d.codebuddyDir, 'projects', 'work-app', `${CB_LOOP.replace(/f$/, 'e')}.jsonl`), body(buddyLoop(CB_LOOP.replace(/f$/, 'e'), cwd).map((l) => l.replace('run the suite', 'parser suite'))));

      const base = { projectsDir, dataDir: path.join(tmp, 'data'), codexSessionsDir, cursorDbPath: fx.dbPath };
      const cursor = () => [new CursorSource({ dbPath: fx.dbPath, now: () => NOW, timers: NO_TIMERS })];
      const without = await serve(loadConfig({}, { ...base, geminiDir: d.geminiDir, grokDir: d.grokDir, copilotDir: d.copilotDir, deepseekDir: null, workbuddyDirs: [], codebuddyDir: null, doubaoDirs: [], qwenDir: null }), cursor());
      const withNew = await serve(loadConfig({}, { ...base, geminiDir: d.geminiDir, grokDir: d.grokDir, copilotDir: d.copilotDir, deepseekDir: d.deepseekDir, workbuddyDirs: d.workbuddyDirs, codebuddyDir: d.codebuddyDir, doubaoDirs: d.doubaoDirs, qwenDir: null }), cursor());
      expect(without.pipeline.ingestFailures()).toEqual([]);
      expect(withNew.pipeline.ingestFailures()).toEqual([]);
      // Not vacuous: the new sources are really read, and some share the older ones' project.
      const originsOf = (sv: Served) => sv.store.listProjects(NOW).find((p) => p.id === project)?.origins;
      expect(originsOf(without)).toEqual([...OLD_ORIGINS]);
      expect(originsOf(withNew)).toEqual([...OLD_ORIGINS, ...(dsh.HAS_ZSTD ? ['deepseek' as const] : []), 'codebuddy']);
      expect(withNew.store.listProjects(NOW).map((p) => p.id)).toEqual(expect.arrayContaining([BUDDY_PROJECT, doubao.DOUBAO_PROJECT_ID]));

      const byId = <T extends { id: string }>(xs: T[]): T[] => [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const view = async (sv: Served) => {
        const out: Record<string, unknown> = {};
        const oldSession = (s: { id: string }): boolean => OLD_SESSIONS.includes(s.id);
        out.projectSessions = (await getJson<Session[]>(sv.app, `/api/projects/${encodeURIComponent(project)}/sessions`)).filter(oldSession);
        out.titleSearch = (await getJson<SearchHit[]>(sv.app, '/api/search?q=parser')).filter((h) => oldSession(h.session));
        for (const id of OLD_SESSIONS) {
          const g = await getJson<GraphSnapshot>(sv.app, `/api/sessions/${encodeURIComponent(id)}/graph`);
          out[`graph:${id}`] = { session: g.session, nodes: byId(g.nodes), edges: byId(g.edges) };
          // Node details (from the store: some node ids are too long for a request line).
          for (const n of byId(g.nodes)) out[`node:${id}:${n.id}`] = sv.store.getNodeDetail(id, n.id);
          out[`anomalies:${id}`] = await getJson<SessionAnomaliesResponse>(sv.app, `/api/sessions/${encodeURIComponent(id)}/anomalies`);
          out[`files:${id}`] = await getJson<SessionFilesResponse>(sv.app, `/api/sessions/${encodeURIComponent(id)}/files`);
          out[`md:${id}`] = await exportSession(sv.app, id, 'md');
          out[`html:${id}`] = embedded(await exportSession(sv.app, id, 'html'));
        }
        for (const origin of OLD_ORIGINS) {
          const { generatedAt: _g, coverage: { noTokenData, ...coverage }, ...stats } = await getJson<StatsResponse>(sv.app, `/api/stats?range=all&origin=${origin}`);
          out[`stats:${origin}`] = { ...stats, coverage };
          // Documented as a property of the whole dataset, not of the filter (shared stats.ts StatsCoverage): it gains
          // 豆包 (sessions, no usage) when its directory is read; the older origins in it are the same.
          out[`noTokenData:${origin}`] = noTokenData.filter((o) => (OLD_ORIGINS as readonly string[]).includes(o));
          out[`noTokenDataAll:${origin}`] = noTokenData;
          out[`anomalyList:${origin}`] = await getJson<AnomalyListResponse>(sv.app, `/api/anomalies?range=all&origin=${origin}`);
          out[`search:${origin}`] = await getJson<ContentSearchResponse>(sv.app, `/api/search/content?q=parser&origin=${origin}`);
          out[`projectFiles:${origin}`] = await getJson<ProjectFilesResponse>(sv.app, `/api/files?projectId=${encodeURIComponent(project)}&origin=${origin}&range=all&changedOnly=0`);
        }
        return out;
      };
      const a = await view(without);
      // Not vacuous: every older session has a graph, the searches and lists have hits.
      for (const id of OLD_SESSIONS) expect((a[`graph:${id}`] as { nodes: unknown[] }).nodes.length, id).toBeGreaterThan(0);
      for (const origin of ['claude', 'codex', 'cursor']) expect((a[`anomalyList:${origin}`] as AnomalyListResponse).items.length, origin).toBeGreaterThan(0);
      for (const origin of ['claude', 'codex', 'cursor']) expect((a[`search:${origin}`] as ContentSearchResponse).hits.length, origin).toBeGreaterThan(0);
      expect((a.projectSessions as Session[]).map((s) => s.id).sort()).toEqual([...OLD_SESSIONS].sort());
      expect((a['files:c1'] as SessionFilesResponse).files.length).toBeGreaterThan(0);
      // With the new directories the same searches also find new sessions (so the filters above matter).
      expect((await getJson<ContentSearchResponse>(withNew.app, '/api/search/content?q=parser')).hits.some((h) => (NEW_ORIGINS as readonly string[]).includes(h.origin))).toBe(true);
      const b = await view(withNew);
      for (const origin of OLD_ORIGINS) {
        expect(a[`noTokenDataAll:${origin}`], origin).toEqual(['codex']);
        expect(b[`noTokenDataAll:${origin}`], origin).toEqual(['codex', 'doubao']);
        delete a[`noTokenDataAll:${origin}`];
        delete b[`noTokenDataAll:${origin}`];
      }
      expect(b).toEqual(a);
    } finally {
      fx.close();
    }
  });
});

describe('one directory, one project', () => {
  test('Claude Code, DeepSeek, WorkBuddy (also from a timestamp-named folder below it) and CodeBuddy on one directory: one project; another directory stays apart', async () => {
    const cwd = path.join(tmp, 'work', 'app');
    const other = path.join(tmp, 'work', 'app2');
    const project = cwd.replace(/[^A-Za-z0-9]/g, '-');
    const projectsDir = path.join(tmp, 'projects');
    await write(path.join(projectsDir, project, 'c1.jsonl'), body([userPrompt('u1', null, 'hello', { sessionId: 'c1' })].map((e) => (e.source === 'transcript' ? e.line : ''))));
    const d = dirs();
    if (dsh.HAS_ZSTD) {
      // With a trailing separator, and in another dsh project folder: the header's cwd decides.
      await writeDsh(d, 'd5000000-0000-4000-8000-000000000a01', `${cwd}${path.sep}`, dshLoop());
      await writeDsh(d, 'd5000000-0000-4000-8000-000000000a02', other, dshLoop());
    }
    const wb = (sid: string, dir: string) => write(path.join(d.workbuddyDirs[0]!, 'projects', 'some-folder', `${sid}.jsonl`), body(buddyLoop(sid, dir)));
    await wb('b0000000-0000-4000-8000-000000000a01', cwd);
    // WorkBuddy's per-session folder named by time: the project is its parent.
    await wb('b0000000-0000-4000-8000-000000000a02', path.join(cwd, '2026-10-27-13-46-52'));
    await write(path.join(d.codebuddyDir, 'projects', 'x', 'c0000000-0000-4000-8000-000000000a01.jsonl'), body(buddyLoop('c0000000-0000-4000-8000-000000000a01', cwd.replace(/\\/g, '/'))));
    const { store, pipeline } = await serve(cnConfig(d, { projectsDir }));
    expect(pipeline.ingestFailures()).toEqual([]);
    const projects = store.listProjects(NOW).map((p) => [p.id, p.sessionCount, p.origins]).sort();
    expect(projects).toEqual([
      [project, dsh.HAS_ZSTD ? 5 : 4, ['claude', ...(dsh.HAS_ZSTD ? ['deepseek'] : []), 'workbuddy', 'codebuddy']],
      ...(dsh.HAS_ZSTD ? [[other.replace(/[^A-Za-z0-9]/g, '-'), 1, ['deepseek']]] : []),
    ].sort());
    // The timestamp folder stays the session's own working directory.
    expect(store.getSession('b0000000-0000-4000-8000-000000000a02')?.cwd).toBe(path.join(cwd, '2026-10-27-13-46-52'));
  });

  test('one directory spelled in three letter cases by DeepSeek, WorkBuddy and CodeBuddy in the same first scan, no Claude Code project: one project, the first spelling met (final review I-3)', async () => {
    const d = dirs();
    const ids = { cb: 'c0000000-0000-4000-8000-000000000b01', dsh: 'd5000000-0000-4000-8000-000000000b01', wb: 'b0000000-0000-4000-8000-000000000b01' };
    // Files are classified in path order: .codebuddy, then .dsh, then .workbuddy.
    await write(path.join(d.codebuddyDir, 'projects', 'x', `${ids.cb}.jsonl`), body(buddyLoop(ids.cb, 'D:\\WORK\\APP')));
    if (dsh.HAS_ZSTD) await writeDsh(d, ids.dsh, 'D:\\Work\\App', dshLoop());
    await write(path.join(d.workbuddyDirs[0]!, 'projects', 'y', `${ids.wb}.jsonl`), body(buddyLoop(ids.wb, 'd:\\work\\app')));
    const store = openStore(':memory:');
    stores.push(store);
    const config = cnConfig(d);
    await fs.mkdir(config.projectsDir, { recursive: true });
    const first = new Pipeline(store, config, { sources: fileSources(config, store) });
    pipelines.push(first);
    await first.scanAll();
    await first.idle();
    expect(first.ingestFailures()).toEqual([]);
    expect(store.listProjects(NOW).map((p) => [p.id, p.sessionCount])).toEqual([['D--WORK-APP', dsh.HAS_ZSTD ? 3 : 2]]);
    // A later process: what is stored wins, for a new session of either tool in yet another spelling.
    await first.close();
    await first.idle();
    const later = { cb: 'c0000000-0000-4000-8000-000000000b02', wb: 'b0000000-0000-4000-8000-000000000b02' };
    await write(path.join(d.workbuddyDirs[0]!, 'projects', 'y', `${later.wb}.jsonl`), body(buddyLoop(later.wb, 'd:\\Work\\app')));
    await write(path.join(d.codebuddyDir, 'projects', 'x', `${later.cb}.jsonl`), body(buddyLoop(later.cb, 'd:\\wOrk\\APP')));
    const second = new Pipeline(store, config, { sources: fileSources(config, store) });
    pipelines.push(second);
    await second.scanAll();
    await second.idle();
    expect(store.listProjects(NOW).map((p) => [p.id, p.sessionCount])).toEqual([['D--WORK-APP', dsh.HAS_ZSTD ? 5 : 4]]);
  });
});
