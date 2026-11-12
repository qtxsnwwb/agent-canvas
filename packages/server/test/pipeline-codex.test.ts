import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { GraphSnapshot } from '@agent-canvas/shared';
import { fileSources } from '../src/cli.js';
import { loadConfig, type Config } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { openStore, type RawEvent, type Store } from '../src/store/store.js';
import { CodexThread } from './codex-fixtures.js';
import { indexLine, rolloutRel } from './codex-rollout.js';
import { assistantBlock, userPrompt } from './fixtures.js';

// Two origins in one temp setup: a Claude Code session and a Codex session (root thread, one subagent thread, a
// session-index title) in the same working directory.
const ROOT = '019a0000-0000-7000-8000-0000000000a1';
const SUB = '019a0000-0000-7000-8000-0000000000b2';

let tmp: string;
let store: Store;
let config: Config;
let cwd: string;
let project: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-pipeline-two-origins-'));
  config = loadConfig(
    {},
    { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: path.join(tmp, 'codex', 'sessions') },
  );
  cwd = path.join(tmp, 'work', 'app');
  project = cwd.replace(/[^A-Za-z0-9]/g, '-');
  store = openStore(':memory:');
});
afterEach(async () => {
  store.close();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

async function writeFile(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}
const body = (lines: string[]): string => lines.map((l) => `${l}\n`).join('');
const claudeBody = (events: RawEvent[]): string => body(events.map((e) => (e.source === 'transcript' ? e.line : '')));
const strip = (g: GraphSnapshot | null) => (g === null ? null : { session: g.session, nodes: g.nodes, edges: g.edges });

test('Claude 与 Codex 会话一起导入：来源正确、同一工作目录同一项目、子代理连上；重建后派生数据完全相同', async () => {
  await writeFile(
    path.join(config.projectsDir, project, 'c1.jsonl'),
    claudeBody([userPrompt('u1', null, 'claude prompt', { sessionId: 'c1' }), assistantBlock('a1', 'u1', { type: 'text', text: 'hi' })]),
  );

  const root = new CodexThread({ id: ROOT, cwd });
  const sub = new CodexThread({ id: SUB, sessionId: ROOT, parent: ROOT, cwd: path.join(cwd, '.worktrees', 'h'), nickname: 'Hubble', agentPath: '/root/helper' });
  // Each call appends one line to the thread's file body (`lines`).
  root.meta();
  root.started('t1');
  root.user('p1', 'codex prompt');
  root.spawn('call1', 'helper');
  root.activity('call1', SUB, '/root/helper');
  root.output('call1', '{"task_name":"/root/helper"}', 'function');
  root.assistant('m1', 'spawned it');
  root.complete();
  sub.meta();
  sub.started('s1');
  sub.context('user', 'the task', 'task1');
  sub.exec('x1', 'run');
  sub.command('e1', 'make');
  sub.output('x1');
  sub.assistant('sm1', 'sub done');
  sub.complete();
  const codexDir = config.codexSessionsDir!;
  // The subagent's file sorts (and is read) before its root thread's file.
  await writeFile(path.join(codexDir, ...rolloutRel(SUB, '2026/11/10').split('/')), body(sub.lines));
  await writeFile(path.join(codexDir, ...rolloutRel(ROOT).split('/')), body(root.lines));
  await writeFile(path.join(path.dirname(codexDir), 'session_index.jsonl'), `${indexLine(ROOT, 'Codex thread title')}\n`);

  const p = new Pipeline(store, config, { sources: fileSources(config, store) });
  await p.scanAll();
  await p.idle();

  const projects = store.listProjects(Date.now());
  expect(projects.map((x) => [x.id, x.sessionCount, x.origins])).toEqual([[project, 2, ['claude', 'codex']]]);
  const sessions = store.listSessions(project);
  expect(sessions.map((s) => [s.id, s.origin]).sort()).toEqual([
    [ROOT, 'codex'],
    ['c1', 'claude'],
  ]);
  expect(store.getSession(ROOT)).toMatchObject({ title: 'Codex thread title', cwd, status: 'idle', projectId: project });

  const g = store.getGraph(ROOT)!;
  const byId = new Map(g.nodes.map((x) => [x.id, x]));
  expect(byId.get('tool:call1')).toMatchObject({ kind: 'subagent', childAgentId: SUB, title: 'Hubble', status: 'succeeded' });
  expect(byId.get('tool:x1')).toMatchObject({ agentId: SUB, parentId: 'prompt:task1', summary: 'make', status: 'succeeded' });
  expect(g.edges.filter((e) => e.kind === 'spawn').map((e) => e.id)).toEqual(['tool:call1->prompt:task1']);
  expect(store.diagnostics().unknownRecords).toEqual([]);
  expect(p.ingestFailures()).toEqual([]);

  const before = { c1: strip(store.getGraph('c1')), root: strip(g), projects: store.listProjects(Date.now()) };
  p.rebuild();
  expect({ c1: strip(store.getGraph('c1')), root: strip(store.getGraph(ROOT)), projects: store.listProjects(Date.now()) }).toEqual(before);
  expect(store.diagnostics().unknownRecords).toEqual([]);

  // A fresh pipeline on the same database (restart) re-ingests nothing and changes nothing.
  const again = new Pipeline(store, config, { sources: fileSources(config, store) });
  await again.scanAll();
  await again.idle();
  expect(strip(store.getGraph(ROOT))).toEqual(before.root);
});
