import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Origin } from '@claude-canvas/shared';
import { buildServer } from '../src/api/server.js';
import { loadConfig, type Config } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { ClaudeFileSource } from '../src/sources/claude.js';
import type { PollSink, PollSource } from '../src/sources/poll.js';
import { cursorKey } from '../src/sources/cursor/source.js';
import { openStore, type RawEvent, type Store } from '../src/store/store.js';
import { at, CursorConv, iso } from './cursor-records.js';

/*
 * Cursor hooks end to end (spec 7.3): POST /hooks?origin=cursor → stored raw event (session id = conversation_id, the
 * root session for a known subagent conversation; project; no user_email) → poke of the Cursor poll source → the
 * session-level mark combined with the records into the session status, live and after a rebuild. Temp dirs only; a
 * fake poll source pushes synthetic records (no Cursor database).
 */

class FakePollSource implements PollSource {
  readonly origin: Origin = 'cursor';
  sink: PollSink | null = null;
  readonly pokes: string[] = [];
  start(sink: PollSink): void {
    this.sink = sink;
  }
  async stop(): Promise<void> {}
  poke(sessionId: string): void {
    this.pokes.push(sessionId);
  }
  status(): { lastPollAt: string | null; lastError: string | null } {
    return { lastPollAt: null, lastError: null };
  }
}

let tmp: string;
let store: Store;
let config: Config;
let fake: FakePollSource;
let pipeline: Pipeline;
let app: FastifyInstance;

function open(): void {
  store = openStore(path.join(tmp, 'data.db'));
  fake = new FakePollSource();
  pipeline = new Pipeline(store, config, { sources: [new ClaudeFileSource(config.projectsDir)], pollSources: [fake] });
  app = buildServer({ store, pipeline, config });
}

async function close(): Promise<void> {
  await app.close();
  await pipeline.close();
  await pipeline.idle();
  store.close();
}

beforeEach(async () => {
  // Only Date is faked: hook receive times are later than the synthetic bubble times (T0 = 2026-11-12T08:00Z).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(at(60)));
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-pipeline-cursor-hooks-'));
  await fs.mkdir(path.join(tmp, 'projects'), { recursive: true });
  config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null, cursorDbPath: null });
  open();
  await pipeline.scanAll();
});
afterEach(async () => {
  await close();
  vi.useRealTimers();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

/** Pushes one conversation's records through the poll sink, as CursorSource does. */
async function ingest(conv: CursorConv, events: RawEvent[]): Promise<void> {
  const records = events.map((e) => {
    if (e.source !== 'transcript') throw new Error('records only');
    return { recordType: e.recordType, line: e.line };
  });
  // The keys CursorSource uses: `cursor:<session>` for a main conversation, `cursor:<session>/<subagent>` for a subagent.
  await fake.sink!.ingestRecords({ key: cursorKey(conv.sessionId, conv.agentId), projectId: conv.projectId, sessionId: conv.sessionId, agentId: conv.agentId, records });
}

async function post(body: Record<string, unknown>): Promise<void> {
  expect((await app.inject({ method: 'POST', url: '/hooks?origin=cursor', payload: body })).statusCode).toBe(200);
  await new Promise((r) => setImmediate(r));
  await pipeline.idle();
}

const payload = (event: string, conversation: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  conversation_id: conversation,
  generation_id: 'g1',
  model: 'synthetic',
  hook_event_name: event,
  cursor_version: '9.9.9',
  workspace_roots: ['d:\\work\\app'],
  user_email: 'someone@example.invalid',
  transcript_path: null,
  ...extra,
});

const hooksOf = (sessionId: string) => store.rawForSession(sessionId).filter((e) => e.source === 'hook');

function finishedTurn(c: CursorConv): RawEvent[] {
  return [c.composer({ status: 'completed' }), c.user('u1', 'go', 0), c.text('a1', 'done', 1), c.turnEnd('end', 2)];
}

test('stored under conversation_id without user_email, origin cursor; pokes the poll source with that id', async () => {
  await post(payload('stop', 'c1', { status: 'completed', loop_count: 0 }));
  const [ev] = hooksOf('c1');
  expect(ev).toMatchObject({ source: 'hook', origin: 'cursor', eventName: 'stop', sessionId: 'c1' });
  const stored = JSON.parse((ev as { payload: string }).payload);
  expect(stored).not.toHaveProperty('user_email');
  expect(stored).toMatchObject({ conversation_id: 'c1', status: 'completed', workspace_roots: ['d:\\work\\app'] });
  expect(fake.pokes).toEqual(['c1']);
  expect(store.getSession('c1')).toBeNull(); // hooks never create a session
});

test('session_id is the fallback when conversation_id is absent', async () => {
  await post({ hook_event_name: 'sessionStart', session_id: 's9' });
  expect(hooksOf('s9')).toHaveLength(1);
  expect(fake.pokes).toEqual(['s9']);
});

test('project: the known session keeps its own; otherwise workspace_roots[0] encoded as the Cursor source does; else null', async () => {
  await post(payload('stop', 'c-new'));
  expect(hooksOf('c-new')[0]).toMatchObject({ projectId: 'D--work-app' });
  await post(payload('stop', 'c-none', { workspace_roots: [] }));
  expect(hooksOf('c-none')[0]).toMatchObject({ projectId: null });
  const c = new CursorConv({ id: 'c-known', projectId: 'elsewhere' });
  await ingest(c, finishedTurn(c));
  await post(payload('stop', 'c-known'));
  expect(hooksOf('c-known')[0]).toMatchObject({ projectId: 'elsewhere' });
});

test('a hook of a known subagent conversation is filed under its root session and pokes the root; no mark on the root', async () => {
  const root = new CursorConv({ id: 'c-root', projectId: 'p-root' });
  const sub = new CursorConv({ id: 'c-sub', sessionId: 'c-root', projectId: 'p-root' });
  await ingest(root, finishedTurn(root));
  await ingest(sub, [sub.subagentComposer('tc1', 'c-root'), sub.user('su', 'task', 0)]);
  await post(payload('sessionEnd', 'c-sub', { reason: 'completed' }));
  expect(hooksOf('c-sub')).toEqual([]);
  expect(hooksOf('c-root')).toHaveLength(1);
  expect(hooksOf('c-root')[0]).toMatchObject({ projectId: 'p-root' });
  expect(fake.pokes).toEqual(['c-root']);
  expect(store.getSession('c-root')!.status).toBe('idle');
});

test('a subagent shared by two forks: filed under the lowest owning session, every owner poked; nested subagentStop too', async () => {
  const a = new CursorConv({ id: 'c-b-fork', projectId: 'p-root' });
  const b = new CursorConv({ id: 'c-a-fork', projectId: 'p-root' });
  await ingest(a, finishedTurn(a));
  await ingest(b, finishedTurn(b));
  for (const owner of ['c-b-fork', 'c-a-fork']) {
    const sub = new CursorConv({ id: 'c-sub', sessionId: owner, projectId: 'p-root' });
    await ingest(sub, [sub.subagentComposer('tc1', owner), sub.user('su', 'task', 0)]);
  }
  await post(payload('stop', 'c-sub', { status: 'completed' }));
  expect(hooksOf('c-sub')).toEqual([]);
  expect(hooksOf('c-a-fork')).toHaveLength(1);
  expect(hooksOf('c-b-fork')).toEqual([]);
  expect(fake.pokes).toEqual(['c-a-fork', 'c-b-fork']);
  // A nested subagent's subagentStop carries its parent subagent's id: the sessions owning that one are poked.
  fake.pokes.length = 0;
  await post(payload('subagentStop', 'c-sub', { subagent_type: 'explorer', status: 'completed' }));
  expect(fake.pokes).toEqual(['c-a-fork', 'c-b-fork']);
  expect(store.getSession('c-a-fork')!.status).toBe('idle');
});

test('subagentStop (parent conversation_id) pokes the parent and leaves the status alone', async () => {
  const c = new CursorConv({ id: 'c1' });
  await ingest(c, finishedTurn(c));
  await post(payload('subagentStop', 'c1', { subagent_type: 'explorer', status: 'completed', task: 't', summary: 's', duration_ms: 5 }));
  expect(fake.pokes).toEqual(['c1']);
  expect(store.getSession('c1')!.status).toBe('idle');
});

test('status: prompt submitted → running; turn read to its end → idle; sessionEnd → ended; a rebuild gives the same', async () => {
  const c = new CursorConv({ id: 'c1' });
  await ingest(c, finishedTurn(c));
  expect(store.getSession('c1')!.status).toBe('idle');
  await post(payload('beforeSubmitPrompt', 'c1', { prompt: 'more', attachments: [] }));
  expect(store.getSession('c1')!.status).toBe('running');
  vi.setSystemTime(new Date(at(120)));
  await ingest(c, [c.user('u2', 'more', 61), c.text('a2', 'ok', 62), c.turnEnd('end2', 63)]);
  expect(store.getSession('c1')!.status).toBe('idle');
  await post(payload('beforeSubmitPrompt', 'c1'));
  expect(store.getSession('c1')!.status).toBe('running');
  vi.setSystemTime(new Date(at(130)));
  await post(payload('stop', 'c1', { status: 'aborted' }));
  expect(store.getSession('c1')!.status).toBe('idle');
  vi.setSystemTime(new Date(at(140)));
  await post(payload('sessionEnd', 'c1', { reason: 'user_close' }));
  expect(store.getSession('c1')!.status).toBe('ended');
  pipeline.rebuild();
  expect(store.getSession('c1')!.status).toBe('ended');
});

test('a hook before the session exists still counts after 200 other unseen sessions got hooks; live = rebuild (M1)', async () => {
  // Two hooks: the second one is applied after a replay of the first (c1's marks are then "restored").
  await post(payload('stop', 'c1', { status: 'completed' }));
  vi.setSystemTime(new Date(at(61)));
  await post(payload('sessionEnd', 'c1', { reason: 'user_close' }));
  for (let i = 0; i < 210; i++) await post(payload('sessionStart', `c-empty-${i}`));
  const c = new CursorConv({ id: 'c1' });
  await ingest(c, finishedTurn(c));
  expect(store.getSession('c1')!.status).toBe('ended');
  pipeline.rebuild();
  expect(store.getSession('c1')!.status).toBe('ended');
}, 30_000);

test('a hook before the session exists counts once the records arrive, also after a restart', async () => {
  await post(payload('sessionEnd', 'c1', { reason: 'user_close' }));
  await close();
  open();
  await pipeline.scanAll();
  const c = new CursorConv({ id: 'c1' });
  await ingest(c, finishedTurn(c));
  expect(store.getSession('c1')!.status).toBe('ended');
  pipeline.rebuild();
  expect(store.getSession('c1')!.status).toBe('ended');
});
