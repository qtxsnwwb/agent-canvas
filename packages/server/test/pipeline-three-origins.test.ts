import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { GraphSnapshot } from '@agent-canvas/shared';
import { fileSources } from '../src/cli.js';
import { loadConfig, type Config } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { CursorSource, type PollTimers } from '../src/sources/cursor/source.js';
import { openStore, type RawEvent, type Store } from '../src/store/store.js';
import { CodexThread } from './codex-fixtures.js';
import { rolloutRel } from './codex-rollout.js';
import { CursorDbFixture, T0, textBubble, thinkingBubble, toolBubble, userBubble } from './cursor-fixtures.js';
import { assistantBlock, userPrompt } from './fixtures.js';

// Three origins in one temp setup: a Claude Code session, a Codex session and a Cursor conversation with a subagent,
// all in the same working directory. The Cursor data comes from a synthetic temp database through the real
// CursorSource (polled by hand, no timers); nothing outside the temp dir is read.

const CODEX_ROOT = '019a0000-0000-7000-8000-0000000000c1';
const NO_TIMERS: PollTimers = { set: () => null, clear: () => undefined };
const s = (sec: number): number => T0 + sec * 1000;

let tmp: string;
let store: Store;
let config: Config;
let cwd: string;
let project: string;
let fx: CursorDbFixture;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-pipeline-three-origins-'));
  fx = new CursorDbFixture(path.join(tmp, 'Cursor'));
  config = loadConfig(
    {},
    {
      projectsDir: path.join(tmp, 'projects'),
      dataDir: path.join(tmp, 'data'),
      codexSessionsDir: path.join(tmp, 'codex', 'sessions'),
      cursorDbPath: fx.dbPath,
    },
  );
  await fs.mkdir(config.projectsDir, { recursive: true });
  cwd = path.join(tmp, 'work', 'app');
  project = cwd.replace(/[^A-Za-z0-9]/g, '-');
  store = openStore(path.join(tmp, 'data.db'));
});
afterEach(async () => {
  store.close();
  fx.close();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

async function writeFile(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}
const body = (lines: string[]): string => lines.map((l) => `${l}\n`).join('');
const claudeBody = (events: RawEvent[]): string => body(events.map((e) => (e.source === 'transcript' ? e.line : '')));
/**
 * A graph's content, nodes and edges by id: the row order of a snapshot follows the order changes were written in,
 * which for Cursor depends on how records were batched (live: per poll batch; rebuild: per page of raw events).
 */
const byId = <T extends { id: string }>(xs: T[]): T[] => [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const strip = (g: GraphSnapshot | null) => (g === null ? null : { session: g.session, nodes: byId(g.nodes), edges: byId(g.edges) });

function putCursor(taskStatus: 'loading' | 'completed', lastUpdatedAt: number): void {
  fx.put({
    id: 'cur-root',
    name: 'Cursor conversation',
    status: taskStatus === 'loading' ? 'none' : 'completed',
    dataFsPath: cwd,
    createdAt: s(0),
    lastUpdatedAt,
    bubbles: [
      userBubble('u1', 'find the config loader', s(1)),
      thinkingBubble('th1', 'where would it be', s(2)),
      toolBubble('t1', 'task_v2', taskStatus, s(3), { toolCallId: 'tc1', params: { description: 'locate the loader', prompt: 'search the repo' } }),
      ...(taskStatus === 'completed' ? [textBubble('a1', 'it is in src/config.ts', s(20), { turnDurationMs: 19_000 })] : []),
    ],
  });
}

function putSubagent(): void {
  fx.put({
    id: 'cur-sub',
    isSubagent: true,
    status: 'completed',
    createdAt: s(3),
    subagentInfo: { parentComposerId: 'cur-root', rootParentConversationId: 'cur-root', toolCallId: 'tc1', subagentTypeName: 'explorer' },
    bubbles: [
      userBubble('su', 'search the repo', s(4)),
      toolBubble('st1', 'grep', 'completed', s(5), { params: { pattern: 'loadConfig' } }),
      textBubble('sa', 'src/config.ts', s(8), { turnDurationMs: 4000 }),
    ],
  });
}

test('Claude, Codex and Cursor sessions together: one project, origins right, Cursor subagent linked, updates in place; rebuild and restart change nothing', async () => {
  await writeFile(
    path.join(config.projectsDir, project, 'c1.jsonl'),
    claudeBody([userPrompt('u1', null, 'claude prompt', { sessionId: 'c1' }), assistantBlock('a1', 'u1', { type: 'text', text: 'hi' })]),
  );
  const codex = new CodexThread({ id: CODEX_ROOT, cwd });
  codex.meta();
  codex.started('t1');
  codex.user('p1', 'codex prompt');
  codex.assistant('m1', 'done');
  codex.complete();
  await writeFile(path.join(config.codexSessionsDir!, ...rolloutRel(CODEX_ROOT).split('/')), body(codex.lines));
  putCursor('loading', s(10));
  putSubagent();

  const source = new CursorSource({ dbPath: fx.dbPath, now: () => T0 + 3_600_000, timers: NO_TIMERS });
  const p = new Pipeline(store, config, { sources: fileSources(config, store), pollSources: [source] });
  await p.scanAll();
  await source.pollOnce();
  await p.idle();

  const projects = store.listProjects(Date.now());
  expect(projects.map((x) => [x.id, x.sessionCount, x.origins])).toEqual([[project, 3, ['claude', 'codex', 'cursor']]]);
  expect(store.listSessions(project).map((x) => [x.id, x.origin]).sort()).toEqual([
    [CODEX_ROOT, 'codex'],
    ['c1', 'claude'],
    ['cur-root', 'cursor'],
  ]);
  expect(store.getSession('cur-root')).toMatchObject({ title: 'Cursor conversation', cwd, status: 'running', startedAt: new Date(s(0)).toISOString() });

  let g = store.getGraph('cur-root')!;
  let byId = new Map(g.nodes.map((x) => [x.id, x]));
  const dispatch = 'bubble:cur-root:t1';
  expect(byId.get(dispatch)).toMatchObject({ kind: 'subagent', childAgentId: 'cur-sub', title: 'explorer', summary: 'locate the loader', status: 'succeeded' });
  expect(byId.get('bubble:cur-sub:st1')).toMatchObject({ agentId: 'cur-sub', summary: 'loadConfig', status: 'succeeded', parentId: 'bubble:cur-sub:su' });
  expect(g.edges.filter((e) => e.kind === 'spawn').map((e) => e.id)).toEqual([`${dispatch}->bubble:cur-sub:su`]);
  expect(store.diagnostics().unknownRecords).toEqual([]);
  expect(p.ingestFailures()).toEqual([]);

  // Cursor rewrites the conversation: the task_v2 bubble completes, a reply ends the turn. Updated in place.
  putCursor('completed', s(30));
  await source.pollOnce();
  await p.idle();
  g = store.getGraph('cur-root')!;
  byId = new Map(g.nodes.map((x) => [x.id, x]));
  expect(g.nodes.filter((x) => x.id === dispatch)).toHaveLength(1);
  expect(byId.get(dispatch)).toMatchObject({ status: 'succeeded', endedAt: new Date(s(3) + 300).toISOString() });
  expect(byId.get('bubble:cur-root:a1')).toMatchObject({ kind: 'text', parentId: dispatch });
  expect(store.getSession('cur-root')).toMatchObject({ status: 'idle' });
  expect(g.nodes).toHaveLength(7);

  const ids = ['c1', CODEX_ROOT, 'cur-root'];
  const snapshot = () => ({ graphs: ids.map((id) => strip(store.getGraph(id))), projects: store.listProjects(Date.now()) });
  const before = snapshot();
  p.rebuild();
  expect(snapshot()).toEqual(before);
  expect(store.diagnostics().unknownRecords).toEqual([]);
  await p.close();
  await p.idle();

  // Restart: a fresh pipeline and source over the same database store nothing new and change nothing.
  const rawCount = store.rawForSession('cur-root').length;
  const source2 = new CursorSource({ dbPath: fx.dbPath, now: () => T0 + 3_600_000, timers: NO_TIMERS });
  const again = new Pipeline(store, config, { sources: fileSources(config, store), pollSources: [source2] });
  await again.scanAll();
  await source2.pollOnce();
  await again.idle();
  expect(store.rawForSession('cur-root')).toHaveLength(rawCount);
  expect(snapshot()).toEqual(before);
  await again.close();
  await again.idle();
});
