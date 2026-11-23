import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  attentionKey,
  type AttentionResponse,
  type Change,
  type GraphNode,
  type Origin,
  type SeqChange,
  type Session,
  type SessionStatus,
} from '@agent-canvas/shared';
import { ATTENTION_META_KEY, AttentionService, type AttentionServiceDeps } from '../src/attention/service.js';
import { compact, rebuild } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { ATTENTION_INDEX_NOTICE, ATTENTION_QUERIES, openStore, type RawEvent, type Store } from '../src/store/store.js';
import { userPrompt, assistantBlock } from './fixtures.js';

// In-memory stores (temp dirs where a file is needed); changes go through store.applyChanges and then noteChanges.

const T0 = Date.parse('2026-11-20T10:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** snapshot() with the hidden list (the live push and the default leave it out). */
const ALL = { includeHidden: true } as const;

let now: number;
let stuckMinutes: number;
let aborted: Set<string>;
let store: Store;
let logs: string[];
const services: AttentionService[] = [];

function makeService(over: Partial<AttentionServiceDeps> = {}): AttentionService {
  const svc = new AttentionService({
    store,
    now: () => now,
    stuckMinutes: () => stuckMinutes,
    isAbortedCall: (sessionId, nodeId) => aborted.has(`${sessionId}/${nodeId}`),
    coalesceMs: 0,
    log: (line) => logs.push(line),
    ...over,
  });
  services.push(svc);
  return svc;
}

beforeEach(() => {
  now = T0;
  stuckMinutes = 15;
  aborted = new Set();
  logs = [];
  store = openStore(':memory:');
});
afterEach(() => {
  for (const s of services.splice(0)) s.close();
  store.close();
});

function session(id: string, status: SessionStatus, over: Partial<Session> = {}): Session {
  return {
    id,
    projectId: 'D--w-tea-shop',
    origin: 'claude',
    cwd: 'D:\\w\\tea-shop',
    title: `会话 ${id}`,
    gitBranch: null,
    status,
    sourceDeleted: false,
    startedAt: iso(T0 - DAY),
    lastActivityAt: iso(now),
    ...over,
  };
}
const up = (id: string, status: SessionStatus, over: Partial<Session> = {}): Change => ({ type: 'session_upserted', session: session(id, status, over) });
function node(sessionId: string, id: string, at: number, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    sessionId,
    turnId: null,
    agentId: null,
    childAgentId: null,
    parentId: null,
    kind: 'text',
    status: null,
    timestamp: iso(at),
    confirmed: true,
    title: 'Text',
    summary: '',
    toolName: null,
    toolUseId: null,
    messageId: null,
    durationMs: null,
    endedAt: null,
    usage: null,
    systemSubtype: null,
    ...over,
  };
}
const add = (n: GraphNode): Change => ({ type: 'node_added', node: n, detail: {} });
const prompt = (sid: string, id: string, at: number): Change => add(node(sid, id, at, { kind: 'prompt', title: 'Prompt', summary: '帮我修一下' }));
const reply = (sid: string, id: string, at: number, text = '已经改好'): Change => add(node(sid, id, at, { kind: 'text', summary: text }));
const tool = (sid: string, id: string, at: number, over: Partial<GraphNode> = {}): Change =>
  add(node(sid, id, at, { kind: 'tool', status: 'running', title: 'Bash', toolName: 'Bash', summary: 'npm test', ...over }));
const patch = (sid: string, id: string, p: Partial<GraphNode>): Change => ({ type: 'node_updated', sessionId: sid, id, patch: p });

/** Applies through the store and feeds the result to every given service (default: the first one). */
function apply(changes: Change[], ...svcs: AttentionService[]): SeqChange[] {
  const applied = store.applyChanges(changes);
  for (const s of svcs.length > 0 ? svcs : services.slice(0, 1)) s.noteChanges(applied);
  return applied;
}
function hookRow(sessionId: string, eventName: string, receivedAt: number, body: Record<string, unknown> = {}, origin: Origin = 'claude'): void {
  store.insertRaw({ source: 'hook', origin, receivedAt: iso(receivedAt), eventName, sessionId, payload: JSON.stringify({ session_id: sessionId, hook_event_name: eventName, ...body }) });
}

/**
 * A real Pipeline over a temp dir and this test's store (Claude Code transcript `proj/s1.jsonl`). The service clock is
 * set to the real time: hooks are stamped with it.
 */
async function withPipeline(fn: (p: { pipeline: Pipeline; real: number; write: (events: RawEvent[]) => Promise<void> }) => Promise<void>): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-attention-'));
  const config = loadConfig({}, { deepseekDir: null, workbuddyDirs: [], codebuddyDir: null, doubaoDirs: [], qwenDir: null, geminiDir: null, grokDir: null, copilotDir: null, projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), rescanMs: 200, cursorDbPath: null });
  const file = path.join(config.projectsDir, 'proj', 's1.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const pipeline = new Pipeline(store, config);
  const real = Date.now();
  now = real;
  const write = async (events: RawEvent[]): Promise<void> => {
    await fs.appendFile(file, events.map((e) => (e.source === 'transcript' ? e.line : '') + '\n').join(''));
    await pipeline.ingestFile(file);
  };
  try {
    await fn({ pipeline, real, write });
  } finally {
    await pipeline.close();
    await pipeline.idle();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  }
}
async function claudeHook(pipeline: Pipeline, eventName: string, body: Record<string, unknown> = {}): Promise<void> {
  pipeline.ingestHook(eventName, 's1', JSON.stringify({ session_id: 's1', hook_event_name: eventName, ...body }));
  await pipeline.idle();
}

/** A finished turn: prompt at T0 - 10 min, a reply at T0 - 1 min, idle. */
function finishedTurn(sid = 's1', origin: Origin = 'claude'): void {
  apply([up(sid, 'running', { origin }), prompt(sid, `${sid}-p1`, T0 - 10 * MIN), reply(sid, `${sid}-r1`, T0 - MIN), up(sid, 'idle', { origin })]);
}
const kindsOf = (r: AttentionResponse): string[] => r.items.map((i) => `${i.sessionId}:${i.kind}`);

describe('items', () => {
  test('a finished turn: since = the last main-thread node, explanation = the reply, node = the reply', () => {
    const svc = makeService();
    finishedTurn();
    const r = svc.snapshot(ALL);
    expect(r.items).toEqual([
      {
        key: attentionKey('s1', 'finished', iso(T0 - MIN)),
        sessionId: 's1',
        kind: 'finished',
        since: iso(T0 - MIN),
        title: '会话 s1',
        origin: 'claude',
        projectId: 'D--w-tea-shop',
        cwd: 'D:\\w\\tea-shop',
        explanation: '已经改好',
        nodeId: 's1-r1',
      },
    ]);
    expect(r).toMatchObject({ hidden: [], undeterminable: [], runningCount: 0, autoHideHours: 24 });
  });

  test('running sessions are counted, not listed; a session with no prompt has no item', () => {
    const svc = makeService();
    apply([up('s1', 'running'), prompt('s1', 'p1', T0 - MIN), up('s2', 'idle')]);
    const r = svc.snapshot(ALL);
    expect(r.items).toEqual([]);
    expect(r.runningCount).toBe(1);
  });

  test('sorted by kind then newest first', () => {
    const svc = makeService();
    finishedTurn('a');
    finishedTurn('b');
    apply([prompt('b', 'b-p2', T0 - 30 * SEC), reply('b', 'b-r2', T0 - 20 * SEC), up('b', 'idle')]);
    apply([up('c', 'running'), prompt('c', 'c-p1', T0 - 5 * MIN), tool('c', 'c-t1', T0 - 4 * MIN), up('c', 'awaiting_permission')]);
    expect(kindsOf(svc.snapshot(ALL))).toEqual(['c:permission', 'b:finished', 'a:finished']);
  });

  test('a Cursor call failed because the conversation was aborted is an error marker (isAbortedCall)', () => {
    const svc = makeService();
    apply([up('c1', 'running', { origin: 'cursor' }), prompt('c1', 'p1', T0 - 5 * MIN), tool('c1', 'call1', T0 - 4 * MIN)]);
    aborted.add('c1/call1');
    apply([patch('c1', 'call1', { status: 'failed', endedAt: iso(T0 - 3 * MIN) }), up('c1', 'idle', { origin: 'cursor' })]);
    expect(svc.snapshot(ALL).items[0]).toMatchObject({ kind: 'error', since: iso(T0 - 3 * MIN), nodeId: 'call1' });
    // A failed call that was not aborted is no marker.
    const other = makeService();
    apply([prompt('c1', 'p2', T0 - 2 * MIN), tool('c1', 'call2', T0 - MIN), patch('c1', 'call2', { status: 'failed', endedAt: iso(T0 - 30 * SEC) }), up('c1', 'idle', { origin: 'cursor' })], other);
    expect(other.snapshot(ALL).items[0]).toMatchObject({ kind: 'finished', since: iso(T0 - MIN) });
  });

  test('an interrupt node of the main thread makes the turn an error; a new prompt starts a fresh turn', () => {
    const svc = makeService();
    apply([up('s1', 'running'), prompt('s1', 'p1', T0 - 5 * MIN), add(node('s1', 'x1', T0 - 4 * MIN, { kind: 'system', systemSubtype: 'interrupt', title: 'Interrupted', summary: '请求超时' })), up('s1', 'idle')]);
    expect(svc.snapshot(ALL).items[0]).toMatchObject({ kind: 'error', since: iso(T0 - 4 * MIN), explanation: '请求超时', nodeId: 'x1' });
    apply([up('s1', 'running'), prompt('s1', 'p2', T0 - 3 * MIN), reply('s1', 'r2', T0 - 2 * MIN), up('s1', 'idle')]);
    expect(svc.snapshot(ALL).items[0]).toMatchObject({ kind: 'finished', since: iso(T0 - 2 * MIN), explanation: '已经改好' });
  });

  test('a subagent waiting for permission gives permission with the subagent node', () => {
    const svc = makeService();
    apply([up('s1', 'running'), prompt('s1', 'p1', T0 - 5 * MIN), tool('s1', 'dispatch', T0 - 4 * MIN, { kind: 'subagent', title: 'Explore', toolName: 'Task' })]);
    apply([tool('s1', 'sub-t1', T0 - 3 * MIN, { agentId: 'ag1', summary: 'rm -rf build' }), tool('s1', 'main-t2', T0 - 2 * MIN)]);
    apply([patch('s1', 'sub-t1', { status: 'awaiting_permission' }), up('s1', 'awaiting_permission')]);
    const item = svc.snapshot(ALL).items[0]!;
    expect(item).toMatchObject({ kind: 'permission', since: iso(T0 - 3 * MIN), nodeId: 'sub-t1', explanation: 'Bash · rm -rf build' });
    // Restart: the same item from the store.
    expect(makeService().snapshot(ALL).items).toEqual([item]);
    // Approved: back to running, no item.
    apply([patch('s1', 'sub-t1', { status: 'succeeded' }), up('s1', 'running')]);
    expect(svc.snapshot(ALL).items).toEqual([]);
  });

  test('the origins that cannot tell finished from running are only counted as undeterminable', () => {
    const svc = makeService();
    for (const origin of ['grok', 'copilot', 'doubao'] as const) finishedTurn(`u-${origin}`, origin);
    apply([up('u-run', 'running', { origin: 'doubao' }), prompt('u-run', 'p', T0 - 99 * MIN)]);
    finishedTurn('c1', 'codex');
    const r = svc.snapshot(ALL);
    expect(kindsOf(r)).toEqual(['c1:finished']);
    expect(r.hidden).toEqual([]);
    expect(r.runningCount).toBe(0);
    expect(r.undeterminable.map((u) => u.sessionId).sort()).toEqual(['u-copilot', 'u-doubao', 'u-grok', 'u-run']);
    expect(r.undeterminable.find((u) => u.sessionId === 'u-grok')).toEqual({ sessionId: 'u-grok', title: '会话 u-grok', origin: 'grok' });
  });

  test('ended and sourceDeleted sessions have no item', () => {
    const svc = makeService();
    finishedTurn('a');
    finishedTurn('b');
    apply([up('a', 'ended'), up('b', 'idle', { sourceDeleted: true })]);
    expect(svc.snapshot(ALL)).toMatchObject({ items: [], hidden: [], undeterminable: [], runningCount: 0 });
  });

  test('a session whose last main-thread node is older than 30 days is not a candidate', () => {
    const svc = makeService();
    finishedTurn();
    now = T0 - MIN + 30 * DAY;
    expect(svc.snapshot(ALL).hidden).toHaveLength(1);
    now += 1;
    expect(svc.snapshot(ALL)).toMatchObject({ items: [], hidden: [] });
  });

  test('node_removed of the last main-thread node re-reads the tail', () => {
    const svc = makeService();
    finishedTurn();
    apply([reply('s1', 'r2', T0 - 30 * SEC, '第二段回复')]);
    expect(svc.snapshot(ALL).items[0]).toMatchObject({ since: iso(T0 - 30 * SEC), explanation: '第二段回复' });
    apply([{ type: 'node_removed', sessionId: 's1', id: 'r2' }]);
    expect(svc.snapshot(ALL).items[0]).toMatchObject({ since: iso(T0 - MIN), explanation: '已经改好', nodeId: 's1-r1' });
  });
});

describe('review round 1', () => {
  test('I-3: subagent work keeps a session out of stuck as for the notifications; then silence makes it stuck, since = the main node', () => {
    const svc = makeService();
    apply([up('s1', 'running', { lastActivityAt: iso(T0 - 21 * MIN) }), prompt('s1', 'p1', T0 - 21 * MIN), tool('s1', 'dispatch', T0 - 20 * MIN, { kind: 'subagent', title: 'Explore', toolName: 'Task' })]);
    for (let m = 20; m >= 0; m--) {
      now = T0 - m * MIN;
      apply([up('s1', 'running', { lastActivityAt: iso(now) }), tool('s1', `sub-${m}`, now, { agentId: 'ag1' })]);
      svc.tick();
      expect(svc.snapshot(ALL)).toMatchObject({ items: [], runningCount: 1 });
    }
    now = T0 + 15 * MIN;
    svc.tick();
    expect(svc.snapshot(ALL).items).toEqual([]);
    now += 1;
    svc.tick();
    expect(svc.snapshot(ALL).items[0]).toMatchObject({ kind: 'stuck', since: iso(T0 - 20 * MIN), nodeId: 'dispatch', explanation: 'Explore' });
  });

  test('M-1: more than TAIL_LIMIT main-thread nodes after the last reply: the reply survives a restart', () => {
    const svc = makeService();
    apply([up('s1', 'running'), prompt('s1', 'p1', T0 - 2 * HOUR), reply('s1', 'plan', T0 - 2 * HOUR + SEC, '先说明一下计划')]);
    for (let b = 0; b < 6; b++) {
      const batch: Change[] = [];
      for (let i = 0; i < 100; i++) batch.push(tool('s1', `t${b}-${i}`, T0 - HOUR + (b * 100 + i) * SEC, { status: 'succeeded' }));
      apply(batch);
    }
    apply([up('s1', 'idle')]);
    const item = svc.snapshot(ALL).items[0]!;
    expect(item).toMatchObject({ kind: 'finished', explanation: '先说明一下计划', nodeId: 'plan' });
    expect(makeService().snapshot(ALL).items).toEqual([item]);
  });

  test('M-2: a Cursor call started before a new prompt and aborted after it: the same live and after a restart (node time decides the turn)', () => {
    const svc = makeService();
    apply([up('c1', 'running', { origin: 'cursor' }), prompt('c1', 'p1', T0 - 10 * MIN), tool('c1', 'call1', T0 - 6 * MIN)]);
    aborted.add('c1/call1');
    apply([patch('c1', 'call1', { status: 'failed', endedAt: iso(T0 - 4 * MIN) })]);
    // The next prompt is dated between the call's start and its end.
    apply([prompt('c1', 'p2', T0 - 5 * MIN), reply('c1', 'r2', T0 - 3 * MIN), up('c1', 'idle', { origin: 'cursor' })]);
    const live = svc.snapshot(ALL);
    expect(live.items[0]).toMatchObject({ kind: 'finished', since: iso(T0 - 3 * MIN) });
    expect(makeService().snapshot(ALL)).toEqual(live);
  });

  test('M-4: a session that cannot be read is logged (session id and error, no content) and retried on its next change', () => {
    let fail = true;
    const flaky: Store = {
      ...store,
      mainTailNodes(sessionId, sinceIso, limit) {
        if (fail) throw new Error('disk I/O error');
        return store.mainTailNodes(sessionId, sinceIso, limit);
      },
    };
    const svc = makeService({ store: flaky });
    finishedTurn();
    expect(svc.snapshot(ALL).items).toEqual([]);
    expect(logs).toEqual(['agent-canvas: attention: session s1 could not be read: disk I/O error']);
    fail = false;
    apply([up('s1', 'idle')]);
    expect(svc.snapshot(ALL).items[0]!.kind).toBe('finished');
  });

  test('M-6: the default snapshot and the live push carry no hidden list, only its count', async () => {
    const svc = makeService();
    const got: AttentionResponse[] = [];
    svc.onUpdate((r) => got.push(r));
    finishedTurn('a');
    finishedTurn('b');
    svc.dismiss(svc.snapshot().items.find((i) => i.sessionId === 'a')!.key);
    await new Promise((r) => setTimeout(r, 10));
    expect(svc.snapshot()).toMatchObject({ hidden: [], hiddenCount: 1 });
    expect(svc.snapshot(ALL)).toMatchObject({ hiddenCount: 1, hidden: [{ reason: 'dismissed' }] });
    expect(got.at(-1)).toMatchObject({ hidden: [], hiddenCount: 1 });
    expect(got.at(-1)!.items.map((i) => i.sessionId)).toEqual(['b']);
  });
});

describe('the one-time index build notice', () => {
  let tmp: string;
  beforeEach(async () => {
    vi.stubEnv('AGENT_CANVAS_CODEX_DIR', ''); // never the real ~/.codex/sessions
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-attention-notice-'));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  });
  /** A database from before the attention indexes. */
  const oldDatabase = (dataDir: string): void => {
    openStore(path.join(dataDir, 'data.db')).close();
    const db = new Database(path.join(dataDir, 'data.db'));
    db.exec('DROP INDEX node_main_time; DROP INDEX node_awaiting_permission; DROP INDEX raw_event_session_hook');
    db.close();
  };

  test('rebuild and compact print it too (start already did)', async () => {
    const projectsDir = path.join(tmp, 'projects');
    const dataDir = path.join(tmp, 'data');
    await fs.mkdir(projectsDir, { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });
    oldDatabase(dataDir);
    const lines: string[] = [];
    rebuild({ projectsDir, dataDir }, { log: (l) => lines.push(l) });
    expect(lines).toEqual([ATTENTION_INDEX_NOTICE]);
    oldDatabase(dataDir);
    const compactLines: string[] = [];
    await compact({ projectsDir, dataDir }, { log: (l) => compactLines.push(l), freeBytes: () => 10 ** 12 });
    expect(compactLines).toEqual([ATTENTION_INDEX_NOTICE]);
    const again: string[] = [];
    rebuild({ projectsDir, dataDir }, { log: (l) => again.push(l) });
    expect(again).toEqual([]);
  });
});

describe('Review Focus', () => {
  test('1 (pipeline): idle, then the idle_prompt hook turns it awaiting_input: same episode, a dismissal survives', async () => {
    await withPipeline(async ({ pipeline, real, write }) => {
      const svc = makeService();
      pipeline.onChanges((c) => svc.noteChanges(c));
      await write([userPrompt('u1', null, '修一下', { timestamp: iso(real - 3 * MIN) }), assistantBlock('a1', 'u1', { type: 'text', text: '改好了' }, { timestamp: iso(real - 2 * MIN) })]);
      await claudeHook(pipeline, 'UserPromptSubmit');
      await claudeHook(pipeline, 'Stop');
      expect(store.getSession('s1')!.status).toBe('idle');
      const first = svc.snapshot(ALL).items[0]!;
      expect(first).toMatchObject({ kind: 'finished', since: iso(real - 2 * MIN), explanation: '改好了' });
      expect(svc.dismiss(first.key)).toEqual({ ok: true });
      const activityBefore = store.getSession('s1')!.lastActivityAt;
      await new Promise((r) => setTimeout(r, 5)); // the hook comes later (about 60 s in Claude Code)
      await claudeHook(pipeline, 'Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
      expect(store.getSession('s1')).toMatchObject({ status: 'awaiting_input' });
      expect(store.getSession('s1')!.lastActivityAt > activityBefore).toBe(true);
      const r = svc.snapshot(ALL);
      expect(r.items).toEqual([]);
      expect(r.hidden).toEqual([{ item: first, reason: 'dismissed' }]);
      expect(makeService().snapshot(ALL)).toEqual(r);
    });
  });

  test('2: a subagent keeps writing after the main turn ended: the main item and its since do not move', () => {
    const svc = makeService();
    finishedTurn();
    const first = svc.snapshot(ALL).items[0]!;
    for (let i = 0; i < 5; i++) {
      now += 10 * SEC;
      apply([
        up('s1', 'running', { lastActivityAt: iso(now) }),
        tool('s1', `sub-${i}`, now, { agentId: 'ag1' }),
        patch('s1', `sub-${i}`, { status: 'succeeded', endedAt: iso(now) }),
        add(node('s1', `sub-text-${i}`, now, { agentId: 'ag1', summary: '子代理的话' })),
        up('s1', 'idle', { lastActivityAt: iso(now) }),
      ]);
      expect(svc.snapshot(ALL).items).toEqual([first]);
    }
  });

  test('3: a StopFailure hook stored as a raw event, no node: error before and after a restart', () => {
    const svc = makeService();
    apply([up('s1', 'running'), prompt('s1', 'p1', T0 - 5 * MIN), reply('s1', 'r1', T0 - 4 * MIN)]);
    hookRow('s1', 'StopFailure', T0 - 3 * MIN, { error: 'rate_limit' });
    apply([up('s1', 'idle', { lastActivityAt: iso(T0 - 3 * MIN) })]);
    const item = svc.snapshot(ALL).items[0]!;
    expect(item).toMatchObject({ kind: 'error', since: iso(T0 - 3 * MIN), explanation: null });
    expect(store.getGraph('s1')!.nodes.map((n) => n.id)).toEqual(['p1', 'r1']);
    const restarted = makeService();
    expect(restarted.snapshot(ALL).items).toEqual([item]);
    // A subagent's StopFailure, a StopFailure of another origin's hook and one before the prompt are not markers.
    apply([up('s2', 'running'), prompt('s2', 'p1', T0 - 5 * MIN), reply('s2', 'r1', T0 - 4 * MIN)]);
    hookRow('s2', 'StopFailure', T0 - 6 * MIN);
    hookRow('s2', 'StopFailure', T0 - 3 * MIN, { agent_id: 'ag1' });
    hookRow('s2', 'Stop', T0 - 3 * MIN);
    apply([up('s2', 'idle')]);
    expect(svc.snapshot(ALL).items.find((i) => i.sessionId === 's2')).toMatchObject({ kind: 'finished' });
  });

  test('3 (pipeline): the hook row is committed before the changes it causes are emitted; a restart agrees', async () => {
    await withPipeline(async ({ pipeline, real, write }) => {
      const svc = makeService();
      const seenAtEmit: string[][] = [];
      pipeline.onChanges((changes) => {
        // What the store holds at the moment the changes reach a listener.
        seenAtEmit.push(store.hookEventsSince('s1', iso(real - 10 * MIN)).map((h) => h.eventName));
        svc.noteChanges(changes);
      });
      await write([userPrompt('u1', null, '修一下', { timestamp: iso(real - 2 * MIN) }), assistantBlock('a1', 'u1', { type: 'text', text: '好的' }, { timestamp: iso(real - MIN) })]);
      await claudeHook(pipeline, 'UserPromptSubmit');
      expect(store.getSession('s1')!.status).toBe('running');
      await claudeHook(pipeline, 'StopFailure', { error: 'rate_limit' });
      expect(store.getSession('s1')!.status).toBe('idle');
      expect(seenAtEmit.at(-1)).toEqual(['UserPromptSubmit', 'StopFailure']);
      const item = svc.snapshot(ALL).items[0]!;
      expect(item.kind).toBe('error');
      expect(Date.parse(item.since)).toBeGreaterThanOrEqual(real);
      expect(makeService().snapshot(ALL).items).toEqual([item]);
    });
  });

  test('I-1 (pipeline): the main thread goes on after a StopFailure without a prompt and ends normally: finished, a new key', async () => {
    await withPipeline(async ({ pipeline, real, write }) => {
      const svc = makeService();
      pipeline.onChanges((c) => svc.noteChanges(c));
      await write([userPrompt('u1', null, '跑一下测试', { timestamp: iso(real - 5 * MIN) }), assistantBlock('a1', 'u1', { type: 'text', text: '开始跑' }, { timestamp: iso(real - 4 * MIN) })]);
      await claudeHook(pipeline, 'UserPromptSubmit');
      await claudeHook(pipeline, 'StopFailure', { error: 'rate_limit' });
      const error = svc.snapshot(ALL).items[0]!;
      expect(error.kind).toBe('error');
      expect(svc.dismiss(error.key)).toEqual({ ok: true });
      // A background task's completion arrives as a <task-notification> user record (no prompt node); Claude Code goes on.
      await write([
        userPrompt('u2', 'a1', '<task-notification>后台任务完成</task-notification>', { timestamp: iso(real + MIN) }),
        assistantBlock('a2', 'u2', { type: 'text', text: '测试全部通过' }, { timestamp: iso(real + 2 * MIN) }),
      ]);
      expect(store.getGraph('s1')!.nodes.filter((n) => n.kind === 'prompt')).toHaveLength(1);
      await claudeHook(pipeline, 'Stop');
      now = real + 3 * MIN;
      const r = svc.snapshot(ALL);
      expect(r.items).toHaveLength(1);
      expect(r.items[0]).toMatchObject({ kind: 'finished', since: iso(real + 2 * MIN), explanation: '测试全部通过' });
      expect(r.items[0]!.key).not.toBe(error.key);
      expect(makeService().snapshot(ALL)).toEqual(r);
    });
  });

  test('I-2: an error hook that changes nothing in the session is seen live (noteHook), as after a restart', () => {
    const svc = makeService();
    apply([up('c1', 'running', { origin: 'cursor' }), prompt('c1', 'p1', T0 - 5 * MIN), reply('c1', 'r1', T0 - 4 * MIN), up('c1', 'idle', { origin: 'cursor' })]);
    expect(svc.snapshot(ALL).items[0]!.kind).toBe('finished');
    // A subagent conversation's stop filed under its owner is no marker; the session's own stop with status error is.
    const stop = (conversation: string, at: number): void =>
      void store.insertRaw({ source: 'hook', origin: 'cursor', receivedAt: iso(at), eventName: 'stop', sessionId: 'c1', payload: JSON.stringify({ conversation_id: conversation, status: 'error' }) });
    stop('sub-conv', T0 - 3 * MIN);
    svc.noteHook('c1');
    expect(svc.snapshot(ALL).items[0]!.kind).toBe('finished');
    stop('c1', T0 - 2 * MIN);
    svc.noteHook('c1');
    const item = svc.snapshot(ALL).items[0]!;
    expect(item).toMatchObject({ kind: 'error', since: iso(T0 - 2 * MIN) });
    expect(makeService().snapshot(ALL).items).toEqual([item]);
  });

  test('I-2 (pipeline): onHookStored is called once the hook row is committed, also when the hook changes nothing', async () => {
    await withPipeline(async ({ pipeline, real, write }) => {
      const stored: [string, string[]][] = [];
      let batches = 0;
      pipeline.onChanges(() => (batches += 1));
      pipeline.onHookStored((sessionId) => stored.push([sessionId, store.hookEventsSince(sessionId, iso(real - HOUR)).map((h) => h.eventName)]));
      // Records stamped later than the hooks: a hook moves no lastActivityAt.
      await write([userPrompt('u1', null, '修一下', { timestamp: iso(real + HOUR) }), assistantBlock('a1', 'u1', { type: 'text', text: '好' }, { timestamp: iso(real + HOUR + 1) })]);
      await claudeHook(pipeline, 'Stop');
      const before = batches;
      await claudeHook(pipeline, 'Stop');
      expect(batches).toBe(before); // nothing changed, no batch
      expect(stored).toEqual([
        ['s1', ['Stop']],
        ['s1', ['Stop', 'Stop']],
      ]);
    });
  });

  test('5: awaiting_permission for weeks: main list until the limit, hidden until 30 days, then the dismissal is pruned', () => {
    const svc = makeService();
    apply([up('s1', 'running'), prompt('s1', 'p1', T0 - 2 * MIN), tool('s1', 't1', T0 - MIN), patch('s1', 't1', { status: 'awaiting_permission' }), up('s1', 'awaiting_permission')]);
    const item = svc.snapshot(ALL).items[0]!;
    expect(item).toMatchObject({ kind: 'permission', since: iso(T0 - MIN) });
    now = T0 - MIN + 24 * HOUR;
    expect(svc.snapshot(ALL).items).toEqual([item]);
    now += 1;
    expect(svc.snapshot(ALL)).toMatchObject({ items: [], hidden: [{ item, reason: 'expired' }] });
    expect(svc.dismiss(item.key)).toEqual({ ok: true });
    expect(svc.snapshot(ALL).hidden).toEqual([{ item, reason: 'dismissed' }]);
    expect(JSON.parse(store.getMeta(ATTENTION_META_KEY)!).dismissed).toEqual([item.key]);
    now = T0 - MIN + 30 * DAY;
    expect(svc.snapshot(ALL).hidden).toHaveLength(1);
    now += 1;
    expect(svc.snapshot(ALL)).toMatchObject({ items: [], hidden: [] });
    expect(svc.setAutoHideHours(48)).toEqual({ ok: true, value: 48 });
    expect(JSON.parse(store.getMeta(ATTENTION_META_KEY)!)).toEqual({ autoHideHours: 48, dismissed: [] });
  });
});

describe('dismiss, restore, auto-hide', () => {
  test('dismiss hides only the current key; a new episode reappears', () => {
    const svc = makeService();
    finishedTurn('a');
    finishedTurn('b');
    const a = svc.snapshot(ALL).items.find((i) => i.sessionId === 'a')!;
    expect(svc.dismiss(a.key)).toEqual({ ok: true });
    expect(kindsOf(svc.snapshot(ALL))).toEqual(['b:finished']);
    // The user answers in the terminal; the next turn finishes: a new episode.
    apply([up('a', 'running'), prompt('a', 'a-p2', T0 + MIN), reply('a', 'a-r2', T0 + 2 * MIN), up('a', 'idle')]);
    const r = svc.snapshot(ALL);
    expect(r.items.map((i) => i.key)).toContain(attentionKey('a', 'finished', iso(T0 + 2 * MIN)));
    expect(r.hidden).toEqual([]);
  });

  test('the same episode coming back (running, then idle with no new main-thread node) stays dismissed', () => {
    const svc = makeService();
    finishedTurn();
    svc.dismiss(svc.snapshot(ALL).items[0]!.key);
    apply([up('s1', 'running')]);
    apply([up('s1', 'idle')]);
    expect(svc.snapshot(ALL).items).toEqual([]);
  });

  test('restore brings a dismissed item back; unknown keys are refused', () => {
    const svc = makeService();
    finishedTurn();
    const item = svc.snapshot(ALL).items[0]!;
    expect(svc.dismiss('s1|finished|2020-01-01T00:00:00.000Z')).toMatchObject({ ok: false });
    expect(svc.dismiss('nonsense')).toMatchObject({ ok: false });
    expect(svc.restore(item.key)).toMatchObject({ ok: false });
    svc.dismiss(item.key);
    expect(svc.dismiss(item.key)).toEqual({ ok: true }); // idempotent
    expect(svc.restore(item.key)).toEqual({ ok: true });
    expect(svc.snapshot(ALL)).toMatchObject({ items: [item], hidden: [] });
    // Kept across a restart.
    svc.dismiss(item.key);
    expect(makeService().snapshot(ALL).hidden).toEqual([{ item, reason: 'dismissed' }]);
  });

  test('auto-hide boundary: since exactly the limit ago stays, 1 ms more is hidden as expired', () => {
    const svc = makeService();
    finishedTurn();
    const item = svc.snapshot(ALL).items[0]!;
    now = T0 - MIN + 24 * HOUR;
    expect(svc.snapshot(ALL).items).toEqual([item]);
    now += 1;
    expect(svc.snapshot(ALL)).toMatchObject({ items: [], hidden: [{ item, reason: 'expired' }] });
  });

  test('changing the limit applies at once (and is kept); invalid values are refused', () => {
    const svc = makeService();
    finishedTurn();
    now = T0 + 2 * HOUR;
    expect(svc.snapshot(ALL).items).toHaveLength(1);
    expect(svc.setAutoHideHours(1)).toEqual({ ok: true, value: 1 });
    expect(svc.snapshot(ALL)).toMatchObject({ items: [], autoHideHours: 1 });
    expect(svc.snapshot(ALL).hidden[0]!.reason).toBe('expired');
    for (const bad of [0, 721, 1.5, '24', null]) expect(svc.setAutoHideHours(bad)).toMatchObject({ ok: false });
    expect(makeService().snapshot(ALL).autoHideHours).toBe(1);
  });

  test('the hidden list keeps 30 days, newest first; a dismissed and expired item is listed as dismissed', () => {
    const svc = makeService();
    finishedTurn('a');
    apply([up('b', 'running'), prompt('b', 'b-p', T0 - 10 * DAY), reply('b', 'b-r', T0 - 10 * DAY + MIN), up('b', 'idle')]);
    apply([up('c', 'running'), prompt('c', 'c-p', T0 - 40 * DAY), reply('c', 'c-r', T0 - 40 * DAY + MIN), up('c', 'idle')]);
    now = T0 + 2 * DAY;
    const r = svc.snapshot(ALL);
    expect(r.items).toEqual([]);
    expect(r.hidden.map((h) => `${h.item.sessionId}:${h.reason}`)).toEqual(['a:expired', 'b:expired']);
    svc.dismiss(r.hidden[1]!.item.key);
    expect(svc.snapshot(ALL).hidden.map((h) => `${h.item.sessionId}:${h.reason}`)).toEqual(['a:expired', 'b:dismissed']);
  });

  test('dismissal records stay bounded after 10,000 dismissals', () => {
    const svc = makeService();
    let at = T0;
    apply([up('s1', 'idle')]);
    let maxStored = 0;
    for (let i = 0; i < 10_000; i++) {
      at += 3 * HOUR;
      now = at + SEC;
      apply([prompt('s1', `p${i}`, at), reply('s1', `r${i}`, at + 1), up('s1', 'idle', { lastActivityAt: iso(at + 1) })]);
      const item = svc.snapshot(ALL).items[0]!;
      expect(svc.dismiss(item.key)).toEqual({ ok: true });
      maxStored = Math.max(maxStored, (JSON.parse(store.getMeta(ATTENTION_META_KEY)!) as { dismissed: string[] }).dismissed.length);
    }
    // One episode every 3 hours: at most 30 days of them (240) are kept.
    expect(maxStored).toBeLessThanOrEqual(241);
    // A session that is no longer a candidate drops all of its records with the next write.
    apply([up('s1', 'ended')]);
    svc.setAutoHideHours(24);
    expect(JSON.parse(store.getMeta(ATTENTION_META_KEY)!).dismissed).toEqual([]);
  }, 120_000);

  test('a damaged stored value is read as the defaults', () => {
    store.setMeta(ATTENTION_META_KEY, '{not json');
    expect(makeService().snapshot(ALL).autoHideHours).toBe(24);
    store.setMeta(ATTENTION_META_KEY, JSON.stringify({ autoHideHours: 9999, dismissed: 'x' }));
    expect(makeService().snapshot(ALL).autoHideHours).toBe(24);
  });
});

describe('updates', () => {
  const wait = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

  test('onUpdate fires once for a batch that changes one session several times, not for a batch that changes nothing', async () => {
    const svc = makeService();
    const got: AttentionResponse[] = [];
    svc.onUpdate((r) => got.push(r));
    apply([up('s1', 'running'), prompt('s1', 'p1', T0 - 5 * MIN), reply('s1', 'r1', T0 - 4 * MIN), up('s1', 'idle'), reply('s1', 'r2', T0 - 3 * MIN)]);
    await wait();
    expect(got).toHaveLength(1);
    expect(got[0]!.items[0]).toMatchObject({ kind: 'finished', since: iso(T0 - 3 * MIN) });
    // Subagent activity, edges, an unrelated status-less session: nothing changes in the response.
    apply([add(node('s1', 'sub1', T0 - 2 * MIN, { agentId: 'ag1' })), { type: 'edge_added', edge: { id: 'r2->sub1', sessionId: 's1', from: 'r2', to: 'sub1', kind: 'sequence' } }]);
    apply([up('s9', 'idle')]);
    await wait();
    expect(got).toHaveLength(1);
    // dismiss pushes too.
    svc.dismiss(got[0]!.items[0]!.key);
    await wait();
    expect(got).toHaveLength(2);
    expect(got[1]!.items).toEqual([]);
  });

  test('onUpdate: unsubscribe; close stops everything', async () => {
    const svc = makeService();
    const got: AttentionResponse[] = [];
    const off = svc.onUpdate((r) => got.push(r));
    off();
    finishedTurn();
    await wait();
    expect(got).toEqual([]);
    svc.onUpdate((r) => got.push(r));
    svc.close();
    apply([prompt('s1', 'p2', T0), reply('s1', 'r2', T0 + 1), up('s1', 'idle')]);
    await wait();
    expect(got).toEqual([]);
  });

  test('tick turns a quiet running session into stuck (and follows stuckMinutes)', () => {
    const svc = makeService();
    const got: AttentionResponse[] = [];
    svc.onUpdate((r) => got.push(r));
    apply([up('s1', 'running'), prompt('s1', 'p1', T0 - MIN), tool('s1', 't1', T0, { title: 'Bash' })]);
    now = T0 + 14 * MIN;
    svc.tick();
    expect(svc.snapshot(ALL).items).toEqual([]);
    now = T0 + 15 * MIN + 1;
    svc.tick();
    expect(got.at(-1)!.items[0]).toMatchObject({ kind: 'stuck', since: iso(T0), explanation: 'Bash', nodeId: 't1' });
    const n = got.length;
    svc.tick();
    expect(got).toHaveLength(n); // nothing new
    stuckMinutes = 30;
    svc.tick();
    expect(got.at(-1)!.items).toEqual([]);
    expect(got.at(-1)!.runningCount).toBe(1);
  });

  test('a rebuild (clearDerived, then the same changes again) gives the same response', () => {
    const svc = makeService();
    const batches: Change[][] = [
      [up('a', 'running'), prompt('a', 'a-p', T0 - 9 * MIN), reply('a', 'a-r', T0 - 8 * MIN), up('a', 'idle')],
      [up('b', 'running'), prompt('b', 'b-p', T0 - 7 * MIN), tool('b', 'b-t', T0 - 6 * MIN), patch('b', 'b-t', { status: 'awaiting_permission' }), up('b', 'awaiting_permission')],
      [up('c', 'running', { lastActivityAt: iso(T0 - 59 * MIN) }), prompt('c', 'c-p', T0 - 60 * MIN), tool('c', 'c-t', T0 - 59 * MIN)],
      [up('d', 'running'), prompt('d', 'd-p', T0 - 5 * MIN), add(node('d', 'd-x', T0 - 4 * MIN, { kind: 'system', systemSubtype: 'interrupt', title: 'Turn failed' })), up('d', 'idle')],
    ];
    for (const b of batches) apply(b);
    svc.dismiss(svc.snapshot(ALL).items.find((i) => i.sessionId === 'a')!.key);
    const before = svc.snapshot(ALL);
    expect(kindsOf(before)).toEqual(['b:permission', 'd:error', 'c:stuck']);
    store.clearDerived();
    for (const b of batches) apply(b);
    expect(svc.snapshot(ALL)).toEqual(before);
    expect(makeService().snapshot(ALL)).toEqual(before);
  });

  test('noteResync re-reads a session re-derived behind the change stream', () => {
    const svc = makeService();
    finishedTurn();
    // Re-derived: the store gets a new reply, only the session row is announced (pipeline.rederive).
    store.applyChanges([reply('s1', 'r9', T0 - 10 * SEC, '重新推导')]);
    apply([up('s1', 'idle', { lastActivityAt: iso(T0) })]);
    svc.noteResync('s1');
    expect(svc.snapshot(ALL).items[0]).toMatchObject({ since: iso(T0 - 10 * SEC), explanation: '重新推导' });
  });
});

describe('store queries', () => {
  test('sessionsActiveSince: by stored lastActivityAt (any ISO spelling)', () => {
    store.applyChanges([up('a', 'idle', { lastActivityAt: iso(T0) }), up('b', 'idle', { lastActivityAt: iso(T0 - 2 * DAY) }), up('c', 'idle', { lastActivityAt: '2026-11-20T18:00:00+08:00' })]);
    expect(store.sessionsActiveSince(iso(T0 - DAY)).map((s) => s.id).sort()).toEqual(['a', 'c']);
  });

  test('mainTailNodes: main-thread nodes at/after since, newest first, limited', () => {
    store.applyChanges([
      up('s1', 'idle'),
      prompt('s1', 'p0', T0 - 10 * MIN),
      prompt('s1', 'p1', T0 - 5 * MIN),
      reply('s1', 'r1', T0 - 4 * MIN),
      add(node('s1', 'sub', T0 - 3 * MIN, { agentId: 'ag' })),
      reply('s1', 'r2', T0 - 2 * MIN),
      reply('s2', 'other', T0 - MIN),
    ]);
    expect(store.mainTailNodes('s1', iso(T0 - 5 * MIN), 10).map((n) => n.id)).toEqual(['r2', 'r1', 'p1']);
    expect(store.mainTailNodes('s1', iso(T0 - 5 * MIN), 2).map((n) => n.id)).toEqual(['r2', 'r1']);
    expect(store.mainTailNodes('s1', null, 10).map((n) => n.id)).toEqual(['r2', 'r1', 'p1', 'p0']);
    expect(store.latestMainTextNode('s1', iso(T0 - 5 * MIN))!.id).toBe('r2');
    expect(store.latestMainTextNode('s1', iso(T0 - MIN))).toBeNull();
    expect(store.latestMainTextNode('s2', iso(T0 - 5 * MIN))!.id).toBe('other');
  });

  test('hookEventsSince: the session hooks received at/after since, with their parsed bodies', () => {
    hookRow('s1', 'Stop', T0 - MIN);
    hookRow('s1', 'StopFailure', T0, { error: 'x' });
    hookRow('s2', 'StopFailure', T0);
    store.insertRaw({ source: 'hook', origin: 'claude', receivedAt: iso(T0 + 1), eventName: 'Stop', sessionId: 's1', payload: 'not json' });
    expect(store.hookEventsSince('s1', iso(T0 - MIN))).toEqual([
      { eventName: 'Stop', receivedAt: iso(T0 - MIN), payload: { session_id: 's1', hook_event_name: 'Stop' } },
      { eventName: 'StopFailure', receivedAt: iso(T0), payload: { session_id: 's1', hook_event_name: 'StopFailure', error: 'x' } },
      { eventName: 'Stop', receivedAt: iso(T0 + 1), payload: null },
    ]);
    expect(store.hookEventsSince('s1', iso(T0)).map((h) => h.eventName)).toEqual(['StopFailure', 'Stop']);
  });

  test('awaitingPermissionNodes: the nodes (any thread) whose status is awaiting_permission', () => {
    store.applyChanges([up('s1', 'awaiting_permission'), tool('s1', 't1', T0), tool('s1', 't2', T0, { agentId: 'ag' }), patch('s1', 't2', { status: 'awaiting_permission' })]);
    expect(store.awaitingPermissionNodes('s1').map((n) => n.id)).toEqual(['t2']);
  });

  test('each query is served by its index (no table scan, no sort)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-attention-plan-'));
    try {
      const file = path.join(tmp, 'a.db');
      openStore(file).close();
      const db = new Database(file, { readonly: true });
      try {
        const plan = (sql: string, ...params: unknown[]): string => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail).join(' | ');
        expect(plan(ATTENTION_QUERIES.mainTailSince, 's', 't', 1)).toMatch(/USING INDEX node_main_time/);
        expect(plan(ATTENTION_QUERIES.mainTail, 's', 1)).toMatch(/USING INDEX node_main_time/);
        expect(plan(ATTENTION_QUERIES.lastMainText, 's', 't')).toMatch(/USING INDEX node_main_time/);
        expect(plan(ATTENTION_QUERIES.awaitingPermission, 's')).toMatch(/USING INDEX node_awaiting_permission/);
        expect(plan(ATTENTION_QUERIES.hooksSince, 's', 't')).toMatch(/USING INDEX raw_event_session_hook/);
        for (const sql of Object.values(ATTENTION_QUERIES)) expect(plan(sql, ...Array(sql.split('?').length - 1).fill('x'))).not.toMatch(/TEMP B-TREE|^SCAN|\| SCAN/);
        // The older main-thread statement (store.latestMainPromptAt, verbatim) keeps the small prompt index.
        const latestPrompt = `SELECT MAX(json_extract(body, '$.timestamp')) FROM node
       WHERE session_id = ? AND json_extract(body, '$.kind') = 'prompt' AND json_extract(body, '$.agentId') IS NULL`;
        expect(plan(latestPrompt, 's')).toMatch(/USING INDEX node_main_prompt/);
        expect(store.searchPlans().sessions.join(' | ')).not.toMatch(/node_main_time/);
      } finally {
        db.close();
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
