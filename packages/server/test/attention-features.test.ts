import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_NOTIFICATION_SETTINGS, type AttentionItem, type AttentionKind, type AttentionResponse, type NotificationKind, type Origin } from '@agent-canvas/shared';
import { buildServer, createAttentionService } from '../src/api/server.js';
import type { AttentionService } from '../src/attention/service.js';
import { fileSources } from '../src/cli.js';
import { loadConfig, type Config } from '../src/config.js';
import type { DeliveryStatus, NotificationMessage } from '../src/notify/desktop.js';
import { GRACE_MS } from '../src/notify/engine.js';
import { NotificationService, type ServiceNotifier, type Timers } from '../src/notify/service.js';
import { saveNotificationSettings } from '../src/notify/settings.js';
import { Pipeline } from '../src/pipeline.js';
import { cursorKey } from '../src/sources/cursor/source.js';
import type { PollSink, PollSource } from '../src/sources/poll.js';
import { openStore, type RawEvent, type Store } from '../src/store/store.js';
import * as buddy from './buddy-fixtures.js';
import { CodexThread } from './codex-fixtures.js';
import { rolloutRel } from './codex-rollout.js';
import * as copilot from './copilot-fixtures.js';
import { at as cursorAt, CursorConv } from './cursor-records.js';
import * as dsh from './deepseek-fixtures.js';
import * as doubao from './doubao-fixtures.js';
import { assistantBlock, toolResult, userPrompt } from './fixtures.js';
import * as gemini from './gemini-fixtures.js';
import * as grok from './grok-fixtures.js';
import * as qwen from './qwen-fixtures.js';

/*
 * The attention page against the desktop notifications (attention spec 1.3, 6 "出错的判定与通知一致"): for every origin,
 * one session per scenario goes through the real file sources (Cursor: its poll sink), the Pipeline, the HTTP API
 * (`/hooks`, `GET /api/attention`) and a real NotificationService (fake notifier, fake timers, every kind on,
 * finishedMinSeconds 0, the usual 3 s grace for "跑完了"), all on the same clock. At each checkpoint the notifications
 * sent for the session since the previous one must be exactly the page's kind (`finished` ↔ 跑完了, `error` ↔ 出错中断,
 * `permission` ↔ 等你确认权限), and a fresh service over the same store (a restart) must say the same.
 *
 * Known, accepted differences (spec 3, 3.1 and the Task 2 review rulings; the manual's "待处理" section lists them). The
 * tests marked "known difference" pin what each side says there instead of asserting agreement:
 * - The engine ties an error marker to the run (it is cleared only when the session enters running), the page to the
 *   latest prompt: an interruption followed by a new prompt within the same run is notified "出错中断" when the run ends,
 *   the page says "跑完了" (the new prompt's turn ended normally; spec 3).
 * - Only subagent activity after an error: the page stays "出错中断" (spec 3 looks at the main thread only), the engine
 *   sees a new run and may notify "跑完了" when it ends.
 * - Sessions with no main-thread prompt have no page item (Global Constraints), the engine notifies their runs.
 * - grok, copilot and doubao cannot tell finished from running: only counted as undeterminable (spec 3.1); their
 *   notifications (卡住了, Copilot's 出错中断 on exit) are not compared.
 * - Cursor (checked here with the fixtures, not with real Cursor data): an aborted call marks the turn's error at the
 *   call's end, which is where the next bubble starts when one follows it. When two or more bubbles of the same turn
 *   follow a call still running at the abort, a main-thread node is later than the marker and the page says "跑完了"
 *   while the engine says "出错中断". Nothing is derived on the main thread from a `stop` hook itself; records of the
 *   turn read after it carry Cursor's own (earlier) times and keep the page at "出错中断".
 *
 * Temp directories and invented data only; port 4999 is only a Host header (nothing listens); nothing is displayed.
 */

const HOST = '127.0.0.1:4999';
const BASE_URL = `http://${HOST}`;
/** The notification title's kind label (engine KIND_LABEL) -> kind. */
const LABEL_KIND: Readonly<Record<string, NotificationKind>> = { 等你确认权限: 'permission', 跑完了: 'finished', 出错中断: 'error', 卡住了: 'stuck' };
const MIN = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

class FakeNotifier implements ServiceNotifier {
  readonly sent: { kind: NotificationKind; sessionId: string }[] = [];
  async notify(m: NotificationMessage): Promise<void> {
    const kind = LABEL_KIND[m.title.split(' · ')[0] ?? ''];
    if (kind === undefined) throw new Error(`unexpected notification ${m.title}`);
    this.sent.push({ kind, sessionId: decodeURIComponent(m.url.split('#/s/')[1] ?? '') });
  }
  status(): DeliveryStatus {
    return { available: true, lastError: null, lastErrorAt: null };
  }
  async close(): Promise<void> {}
}

/** Cursor's poll source as the pipeline sees it after its first round (so nothing is suppressed); records pushed by hand. */
class CursorPoll implements PollSource {
  readonly origin: Origin = 'cursor';
  sink: PollSink | null = null;
  start(sink: PollSink): void {
    this.sink = sink;
  }
  async stop(): Promise<void> {}
  poke(): void {}
  status(): { lastPollAt: string | null; lastError: string | null } {
    return { lastPollAt: '2026-01-01T00:00:00.000Z', lastError: null };
  }
}

/** The latest record time of JSON lines (`timestamp` ISO or ms, `time` ms, `createdAt` ms or ISO); -Infinity when none. */
function latestTime(lines: readonly string[]): number {
  let t = Number.NEGATIVE_INFINITY;
  for (const l of lines) {
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(l) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const v of [r.timestamp, r.time, r.createdAt]) {
      const ms = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : Number.NaN;
      if (Number.isFinite(ms) && ms > t) t = ms;
    }
  }
  return t;
}
const linesOf = (events: readonly RawEvent[]): string[] => events.map((e) => (e.source === 'transcript' ? e.line : ''));

interface Dirs {
  tmp: string;
  config: Config;
}

/** Every tool directory of the config inside `tmp`, created (the file sources are built only for existing ones). */
async function makeDirs(tmp: string): Promise<Dirs> {
  const config = loadConfig({}, {
    projectsDir: path.join(tmp, 'projects'),
    dataDir: path.join(tmp, 'data'),
    codexSessionsDir: path.join(tmp, 'codex', 'sessions'),
    cursorDbPath: null,
    geminiDir: path.join(tmp, '.gemini'),
    grokDir: path.join(tmp, '.grok'),
    copilotDir: path.join(tmp, '.copilot'),
    deepseekDir: path.join(tmp, '.dsh'),
    workbuddyDirs: [path.join(tmp, '.workbuddy')],
    codebuddyDir: path.join(tmp, '.codebuddy'),
    doubaoDirs: [path.join(tmp, 'DoubaoWork', 'User Data')],
    qwenDir: path.join(tmp, '.qwen'),
  });
  for (const dir of [
    config.projectsDir,
    config.codexSessionsDir!,
    path.join(config.geminiDir!, 'tmp'),
    path.join(config.grokDir!, 'sessions'),
    path.join(config.copilotDir!, 'session-state'),
    path.join(config.deepseekDir!, 'sessions'),
    path.join(config.workbuddyDirs[0]!, 'projects'),
    path.join(config.codebuddyDir!, 'projects'),
    doubao.sessionsDir(config.doubaoDirs[0]!),
    path.join(config.qwenDir!, 'projects'),
  ]) {
    await fs.mkdir(dir, { recursive: true });
  }
  return { tmp, config };
}

/** One server: pipeline, attention service, notification service, all on the faked Date. */
class Harness {
  readonly notifier = new FakeNotifier();
  readonly cursor = new CursorPoll();
  private readonly pending = new Set<{ fn: () => void }>();
  private seen = 0;
  store!: Store;
  pipeline!: Pipeline;
  attention!: AttentionService;
  notifications!: NotificationService;
  app!: FastifyInstance;
  private clock: number;

  constructor(
    readonly dirs: Dirs,
    clock: number,
  ) {
    this.clock = clock;
    vi.setSystemTime(clock);
  }

  get config(): Config {
    return this.dirs.config;
  }

  async open(): Promise<void> {
    this.store = openStore(':memory:');
    saveNotificationSettings(this.store, { ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true, finishedMinSeconds: 0, loop: false, failures: false });
    this.pipeline = new Pipeline(this.store, this.config, { sources: fileSources(this.config, this.store), pollSources: [this.cursor] });
    await this.pipeline.scanAll();
    await this.pipeline.idle();
    this.attention = createAttentionService(this.store, { coalesceMs: 0, now: () => Date.now() });
    const timers: Timers = {
      setInterval: () => null, // the 30 s stuck check: "卡住了" is not compared here
      clearInterval: () => undefined,
      setTimeout: (fn) => {
        const h = { fn };
        this.pending.add(h);
        return h;
      },
      clearTimeout: (h) => {
        this.pending.delete(h as { fn: () => void });
      },
    };
    this.notifications = new NotificationService({ store: this.store, pipeline: this.pipeline, notifier: this.notifier, now: () => Date.now(), timers });
    this.app = buildServer({ store: this.store, pipeline: this.pipeline, config: this.config, notifications: this.notifications, attention: this.attention });
    this.notifications.start(BASE_URL);
  }

  async close(): Promise<void> {
    await this.app.close();
    await this.notifications.close();
    this.attention.close();
    await this.pipeline.close();
    await this.pipeline.idle();
    this.store.close();
  }

  /** Moves the clock forward to `ms` (never back). */
  setClock(ms: number): void {
    if (Number.isFinite(ms) && ms > this.clock) this.clock = ms;
    vi.setSystemTime(this.clock);
  }

  later(ms = 1000): void {
    this.setClock(this.clock + ms);
  }

  /** Appends JSON lines to a file and reads it, the clock half a second after its latest record. */
  async append(file: string, lines: readonly string[]): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, lines.map((l) => `${l}\n`).join(''));
    await this.ingest(file, lines);
  }

  /** Reads a file whose new content (`lines`) is already written. */
  async ingest(file: string, lines: readonly string[]): Promise<void> {
    this.setClock(latestTime(lines) + 500);
    await this.pipeline.ingestFile(file);
    await this.pipeline.idle();
  }

  /** Cursor records as its poll source pushes them, the clock at `clockMs`. */
  async cursorRecords(conv: CursorConv, events: RawEvent[], clockMs: number): Promise<void> {
    this.setClock(clockMs);
    const records = events.map((e) => {
      if (e.source !== 'transcript') throw new Error('records only');
      return { recordType: e.recordType, line: e.line };
    });
    await this.cursor.sink!.ingestRecords({ key: cursorKey(conv.sessionId, conv.agentId), projectId: conv.projectId, sessionId: conv.sessionId, agentId: conv.agentId, records });
    await this.pipeline.idle();
  }

  /** A hook as the tool posts it (Claude Code without `origin`), a second after the clock. */
  async hook(body: Record<string, unknown>, origin?: 'codex' | 'cursor'): Promise<void> {
    this.later();
    const res = await this.app.inject({ method: 'POST', url: origin === undefined ? '/hooks' : `/hooks?origin=${origin}`, payload: body });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setImmediate(r));
    await this.pipeline.idle();
  }

  /** The grace period of a held "跑完了" runs out (the service's flush timer fires). */
  settle(): void {
    this.later(GRACE_MS + 1000);
    for (const h of [...this.pending]) {
      this.pending.delete(h);
      h.fn();
    }
  }

  async page(): Promise<AttentionResponse> {
    const res = await this.app.inject({ method: 'GET', url: '/api/attention', headers: { host: HOST } });
    expect(res.statusCode).toBe(200);
    return res.json() as AttentionResponse;
  }

  async item(sessionId: string): Promise<AttentionItem | null> {
    return (await this.page()).items.find((i) => i.sessionId === sessionId) ?? null;
  }

  /** The page's item of the session as a service built now over the same store (a restart) decides it. */
  afterRestart(sessionId: string): AttentionItem | null {
    const fresh = createAttentionService(this.store, { coalesceMs: 0, now: () => Date.now() });
    try {
      return fresh.snapshot().items.find((i) => i.sessionId === sessionId) ?? null;
    } finally {
      fresh.close();
    }
  }

  /** Notifications (finished / error / permission) sent for the session since the previous call. */
  newlyNotified(sessionId: string): NotificationKind[] {
    const out = this.notifier.sent.slice(this.seen).filter((n) => n.sessionId === sessionId && n.kind !== 'stuck').map((n) => n.kind);
    this.seen = this.notifier.sent.length;
    return out;
  }

  /** The checkpoint: the grace period over, the notification sent and the page (live and after a restart) say `kind`. */
  async agree(sessionId: string, kind: AttentionKind & NotificationKind): Promise<AttentionItem> {
    this.settle();
    expect(this.newlyNotified(sessionId), 'notified').toEqual([kind]);
    const item = await this.item(sessionId);
    expect(item?.kind ?? null, 'page').toBe(kind);
    expect(this.afterRestart(sessionId), 'page after a restart').toEqual(item);
    return item!;
  }
}

let open: Harness | null = null;
let tmpDir: string | null = null;

/** A fresh harness at `clock`; `files` writes what must exist before the pipeline's first scan. */
async function harness(clock: number, files?: (config: Config) => Promise<void>): Promise<Harness> {
  vi.useFakeTimers({ toFake: ['Date'] });
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-attention-features-'));
  const h = new Harness(await makeDirs(tmpDir), clock);
  if (files !== undefined) await files(h.config);
  await h.open();
  open = h;
  return h;
}

afterEach(async () => {
  if (open !== null) await open.close();
  open = null;
  vi.useRealTimers();
  if (tmpDir !== null) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10 });
  tmpDir = null;
});

// ---------------------------------------------------------------- Claude Code

describe('Claude Code', () => {
  const T = Date.parse('2026-11-20T10:00:00.000Z');
  const t = (sec: number): string => iso(T + sec * 1000);
  const SID = 's1';
  const file = (h: Harness): string => path.join(h.config.projectsDir, 'D--w-app', `${SID}.jsonl`);
  const prompt = (uuid: string, parent: string | null, text: string, sec: number): string => linesOf([userPrompt(uuid, parent, text, { timestamp: t(sec) })])[0]!;
  const reply = (uuid: string, parent: string, text: string, sec: number): string =>
    linesOf([assistantBlock(uuid, parent, { type: 'text', text }, { timestamp: t(sec), stopReason: 'end_turn' })])[0]!;
  const toolUse = (uuid: string, parent: string, id: string, command: string, sec: number): string =>
    linesOf([assistantBlock(uuid, parent, { type: 'tool_use', id, name: 'Bash', input: { command } }, { timestamp: t(sec) })])[0]!;
  const interrupted = (uuid: string, parent: string, toolUseId: string, sec: number): string[] =>
    linesOf([
      toolResult(`${uuid}-r`, parent, toolUseId, "The user doesn't want to proceed with this tool use.", true, { timestamp: t(sec) }),
      userPrompt(uuid, `${uuid}-r`, '[Request interrupted by user for tool use]', { timestamp: t(sec) }),
    ]);
  const hookBody = (event: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ hook_event_name: event, session_id: SID, cwd: 'D:\\w\\app', ...extra });

  test('跑完了; ~1 minute later idle_prompt makes it awaiting_input: no new notification, the same item (same key)', async () => {
    const h = await harness(T);
    await h.append(file(h), [prompt('u1', null, 'fix the parser', 0)]);
    await h.append(file(h), [reply('a1', 'u1', 'Fixed; the tests pass.', 20)]);
    const finished = await h.agree(SID, 'finished');
    expect(finished.explanation).toBe('Fixed; the tests pass.');
    h.later(60_000);
    await h.hook(hookBody('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }));
    h.settle();
    expect(h.store.getSession(SID)!.status).toBe('awaiting_input');
    expect(h.newlyNotified(SID)).toEqual([]);
    expect(await h.item(SID)).toEqual(finished);
    expect(h.afterRestart(SID)).toEqual(finished);
  });

  test('出错中断: the user interrupts a tool call', async () => {
    const h = await harness(T);
    await h.append(file(h), [prompt('u1', null, 'publish it', 0), toolUse('a1', 'u1', 'tu1', 'npm publish', 2)]);
    await h.append(file(h), interrupted('u2', 'a1', 'tu1', 9));
    expect(await h.agree(SID, 'error')).toMatchObject({ explanation: '[Request interrupted by user for tool use]', nodeId: 'u2' });
  });

  test('出错中断: a StopFailure hook (no node of its own)', async () => {
    const h = await harness(T);
    await h.append(file(h), [prompt('u1', null, 'refactor the store', 0)]);
    await h.hook(hookBody('StopFailure', { error: 'rate_limit' }));
    expect(h.store.getSession(SID)!.status).toBe('idle');
    // No step of its own: the hook's reason; the click target is the turn's last main-thread node.
    expect(await h.agree(SID, 'error')).toMatchObject({ explanation: '接口报错（rate_limit）', nodeId: 'u1' });
  });

  test('等你批准: a PermissionRequest hook on the pending call', async () => {
    const h = await harness(T);
    await h.append(file(h), [prompt('u1', null, 'publish it', 0), toolUse('a1', 'u1', 'tu1', 'npm publish ./release', 2)]);
    await h.hook(hookBody('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm publish ./release' } }));
    // The command, not the call's input JSON.
    expect(await h.agree(SID, 'permission')).toMatchObject({ explanation: 'Bash · npm publish ./release', nodeId: 'tool:tu1' });
  });

  test('known difference: an interruption then a new prompt in the same run — engine 出错中断, page 跑完了 (the new turn ended normally)', async () => {
    const h = await harness(T);
    await h.append(file(h), [prompt('u1', null, 'publish it', 0), toolUse('a1', 'u1', 'tu1', 'npm publish', 2)]);
    // The interruption and the next prompt are read together: the session never leaves running.
    await h.append(file(h), [...interrupted('u2', 'a1', 'tu1', 9), prompt('u3', 'u2', 'only build it', 10)]);
    expect(h.store.getSession(SID)!.status).toBe('running');
    await h.append(file(h), [reply('a3', 'u3', 'Built.', 25)]);
    h.settle();
    expect(h.newlyNotified(SID)).toEqual(['error']);
    expect((await h.item(SID))?.kind).toBe('finished');
    expect(h.afterRestart(SID)?.kind).toBe('finished');
  });

  test('known difference: only subagent activity after an error — engine 跑完了 for the new run, page stays 出错中断 (main thread only)', async () => {
    const h = await harness(T);
    await h.append(file(h), [prompt('u1', null, 'look around', 0)]);
    await h.hook(hookBody('StopFailure', { error: 'server_error' }));
    const error = await h.agree(SID, 'error');
    expect(error.explanation).toBe('接口报错（server_error）');
    // A background subagent goes on (its hooks make the session running), then Claude Code waits for input.
    h.later(40_000);
    await h.hook(hookBody('PreToolUse', { agent_id: 'ag1', tool_use_id: 'stu1', tool_name: 'Grep', tool_input: { pattern: 'TODO' } }));
    await h.hook(hookBody('PostToolUse', { agent_id: 'ag1', tool_use_id: 'stu1', tool_name: 'Grep', tool_input: { pattern: 'TODO' }, tool_response: 'none' }));
    expect(h.store.getSession(SID)!.status).toBe('running');
    await h.hook(hookBody('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }));
    h.settle();
    expect(h.newlyNotified(SID)).toEqual(['finished']);
    expect(await h.item(SID)).toEqual(error);
    expect(h.afterRestart(SID)).toEqual(error);
  });
});

// ---------------------------------------------------------------- Codex

describe('Codex', () => {
  const T = Date.parse('2026-11-11T03:00:00.000Z');
  let n = 0;
  const thread = (): CodexThread => new CodexThread({ id: `019a7e00-0000-7000-8000-${String(++n).padStart(12, '0')}`, cwd: '/work/app' });
  const file = (h: Harness, c: CodexThread): string => path.join(h.config.codexSessionsDir!, ...rolloutRel(c.id).split('/'));
  const lines = (events: RawEvent[]): string[] => linesOf(events);
  /** A running turn: meta, task_started, the prompt. */
  async function started(h: Harness, c: CodexThread): Promise<void> {
    await h.append(file(h, c), lines([c.meta(), c.started('t1'), c.user('u1', 'fix the build')]));
    expect(h.store.getSession(c.sessionId)!.status).toBe('running');
  }
  const hookBody = (c: CodexThread, event: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    hook_event_name: event,
    session_id: c.sessionId,
    turn_id: 't1',
    cwd: '/work/app',
    model: 'gpt-x',
    ...extra,
  });

  test('跑完了: task_complete', async () => {
    const h = await harness(T);
    const c = thread();
    await started(h, c);
    await h.append(file(h, c), lines([...c.assistant('m1', 'The build is green.'), c.complete()]));
    expect(await h.agree(c.sessionId, 'finished')).toMatchObject({ explanation: 'The build is green.', nodeId: 'text:m1' });
  });

  test.each([
    ['task_complete with an error ("Turn failed")', (c: CodexThread) => [c.complete('upstream 500')], 'upstream 500'],
    ['turn_aborted ("Interrupted")', (c: CodexThread) => [c.aborted('interrupted')], 'interrupted'],
  ])('出错中断: %s', async (_name, end, explanation) => {
    const h = await harness(T);
    const c = thread();
    await started(h, c);
    await h.append(file(h, c), lines(end(c)));
    const item = await h.agree(c.sessionId, 'error');
    expect(item.explanation).toBe(explanation);
    expect(item.nodeId).toMatch(/^system:/);
  });

  test('出错中断: an Interrupt hook', async () => {
    const h = await harness(T);
    const c = thread();
    await started(h, c);
    await h.hook(hookBody(c, 'Interrupt'), 'codex');
    expect(h.store.getSession(c.sessionId)!.status).toBe('idle');
    expect(await h.agree(c.sessionId, 'error')).toMatchObject({ explanation: '被中断', nodeId: 'prompt:u1' });
  });

  test('等你批准: a PermissionRequest hook', async () => {
    const h = await harness(T);
    const c = thread();
    await started(h, c);
    await h.hook(hookBody(c, 'PermissionRequest', { tool_name: 'shell', tool_input: { command: 'rm -rf build' } }), 'codex');
    // No call node waits (the transcript has none yet): no line; the click target is the last main-thread node.
    expect(await h.agree(c.sessionId, 'permission')).toMatchObject({ explanation: null, nodeId: 'prompt:u1' });
  });

  test('known difference: a run without a prompt node — engine 跑完了, no page item', async () => {
    const h = await harness(T);
    const c = thread();
    await h.append(file(h, c), lines([c.meta(), c.started('t1'), ...c.assistant('m0', 'Checking the workspace.')]));
    expect(h.store.getSession(c.sessionId)!.status).toBe('running');
    await h.append(file(h, c), lines([c.complete()]));
    h.settle();
    expect(h.newlyNotified(c.sessionId)).toEqual(['finished']);
    expect(await h.item(c.sessionId)).toBeNull();
  });
});

// ---------------------------------------------------------------- Cursor

describe('Cursor', () => {
  const T = cursorAt(0);
  const SID = 'c1';
  /** A running turn: the composer generating, the prompt. */
  async function started(h: Harness, c: CursorConv): Promise<void> {
    await h.cursorRecords(c, [c.composer({ status: 'none' }), c.user('u1', 'tidy the imports', 0)], cursorAt(0) + 500);
    expect(h.store.getSession(SID)!.status).toBe('running');
  }
  const stopHook = (status: string): Record<string, unknown> => ({
    conversation_id: SID,
    generation_id: 'g1',
    model: 'synthetic',
    hook_event_name: 'stop',
    cursor_version: '9.9.9',
    workspace_roots: ['/work/app'],
    status,
    loop_count: 0,
  });

  test('跑完了: the turn is read to its end', async () => {
    const h = await harness(T);
    const c = new CursorConv({ id: SID });
    await started(h, c);
    await h.cursorRecords(c, [c.text('a1', 'Imports tidied.', 1), c.turnEnd('e1', 2), c.composer({ status: 'completed' })], cursorAt(2) + 500);
    expect(await h.agree(SID, 'finished')).toMatchObject({ explanation: 'Done.', nodeId: c.node('e1') });
  });

  test('出错中断: the conversation is aborted while a call runs (the call is failed as aborted)', async () => {
    const h = await harness(T);
    const c = new CursorConv({ id: SID });
    await started(h, c);
    await h.cursorRecords(c, [c.tool('t1', 'run_terminal_cmd', 'loading', 1)], cursorAt(1) + 500);
    await h.cursorRecords(c, [c.composer({ status: 'aborted' })], cursorAt(3));
    expect(h.store.getSession(SID)!.status).toBe('idle');
    // The aborted call: its summary, and a click opens it.
    expect(await h.agree(SID, 'error')).toMatchObject({ explanation: 'src/t1.ts', nodeId: c.node('t1') });
  });

  test.each(['error', 'aborted'])('出错中断: a stop hook with status %s; the turn\'s records read after it keep it so', async (status) => {
    const h = await harness(T);
    const c = new CursorConv({ id: SID });
    await started(h, c);
    await h.hook(stopHook(status), 'cursor');
    expect(h.store.getSession(SID)!.status).toBe('idle');
    const error = await h.agree(SID, 'error');
    expect(error).toMatchObject({ explanation: status === 'aborted' ? '对话被中止' : '出错', nodeId: c.node('u1') });
    // The poll then reads what Cursor wrote of the turn: Cursor's own times, before the hook arrived. The same item
    // (same key); its click target, with no marker node, follows the turn's last main-thread node.
    await h.cursorRecords(c, [c.text('a1', 'Partial answer', 1), c.composer({ status: 'completed' })], cursorAt(1) + 6_000);
    h.settle();
    expect(h.newlyNotified(SID)).toEqual([]);
    const after = { ...error, nodeId: c.node('a1') };
    expect(await h.item(SID)).toEqual(after);
    expect(h.afterRestart(SID)).toEqual(after);
  });

  test('出错中断: an aborted call followed by two bubbles of its turn (written before the abort) — both sides 出错中断', async () => {
    const h = await harness(T);
    const c = new CursorConv({ id: SID });
    await started(h, c);
    // The call never finishes; two bubbles come after it before the abort. Its end (the marker's time) is where the
    // next bubble starts, so the turn's last main-thread node is later than the marker.
    await h.cursorRecords(c, [c.tool('t1', 'run_terminal_cmd', 'loading', 1), c.text('a1', 'While that runs…', 2), c.text('a2', 'Still waiting.', 3)], cursorAt(3) + 500);
    await h.cursorRecords(c, [c.composer({ status: 'aborted' })], cursorAt(4));
    const call = h.store.getGraph(SID)!.nodes.find((x) => x.id === c.node('t1'))!;
    expect(call).toMatchObject({ status: 'failed', endedAt: iso(cursorAt(2)) });
    // The marker's time stays the call's end, as the notification dates it: the item's key does not move.
    expect(await h.agree(SID, 'error')).toMatchObject({ since: iso(cursorAt(2)), nodeId: c.node('t1') });
  });
});

// ---------------------------------------------------------------- Gemini CLI

describe('Gemini CLI', () => {
  const T = Date.parse('2026-11-16T09:41:00.000Z');
  const file = (h: Harness): string => path.join(h.config.geminiDir!, 'tmp', ...gemini.MAIN_REL.split('/'));
  const files = async (config: Config): Promise<void> => {
    await fs.mkdir(path.join(config.geminiDir!, 'tmp', gemini.SLUG), { recursive: true });
    await fs.writeFile(path.join(config.geminiDir!, 'tmp', gemini.SLUG, '.project_root'), '/home/dev/demo-app');
  };
  async function started(h: Harness): Promise<void> {
    await h.append(file(h), [gemini.metaLine(), JSON.stringify(gemini.userMsg(gemini.M1, 'Add a --verbose flag to cli.ts'))]);
    expect(h.store.getSession(gemini.SID)!.status).toBe('running');
  }

  test('跑完了: a reply ends the turn', async () => {
    const h = await harness(T, files);
    await started(h);
    await h.append(file(h), [JSON.stringify(gemini.m2(0))]);
    expect((await h.agree(gemini.SID, 'finished')).explanation).toBe("I'll read the file first.");
  });

  test('出错中断 ❌ (no marker in the file): a turn ending in a failed call is 跑完了 on both sides', async () => {
    const h = await harness(T, files);
    await started(h);
    await h.append(file(h), [JSON.stringify(gemini.m4('error'))]);
    // No reply in the turn: no line; the click target is the failed call (the last main-thread node).
    expect(await h.agree(gemini.SID, 'finished')).toMatchObject({ explanation: null, nodeId: expect.stringMatching(/:call:/) });
  });
});

// ---------------------------------------------------------------- DeepSeek Harness

describe.skipIf(!dsh.HAS_ZSTD)('DeepSeek Harness', () => {
  const file = (h: Harness): string => path.join(h.config.deepseekDir!, 'sessions', ...dsh.sessionRel(dsh.SID).split('/'));
  async function run(end: Record<string, unknown>): Promise<Harness> {
    const h = await harness(dsh.T0);
    const header = dsh.headerLine();
    const l = new dsh.DshLog();
    l.turnStart(1);
    l.user('fix the parser test');
    await dsh.writeSession(file(h), header, [l.lines]);
    await h.ingest(file(h), [header, ...l.lines]);
    expect(h.store.getSession(dsh.SID)!.status).toBe('running');
    const from = l.lines.length;
    l.assistant(1, 1, [dsh.textBlock('Fixed it.')], { id: 'm1' });
    l.turnEnd(1, end);
    await dsh.appendBatch(file(h), l.lines.slice(from));
    await h.ingest(file(h), l.lines.slice(from));
    return h;
  }

  test('跑完了: turn/end completed', async () => {
    const h = await run({ kind: 'completed' });
    expect((await h.agree(dsh.SID, 'finished')).explanation).toBe('Fixed it.');
  });

  test.each([
    ['an error', { kind: 'error', error: { message: 'boom' } }, 'boom'],
    ['an abort', { kind: 'aborted', reason: { kind: 'user' } }, 'user'],
    ['an interruption', { kind: 'interrupted' }, 'Interrupted'],
  ])('出错中断: turn/end with %s', async (_name, end, explanation) => {
    const h = await run(end);
    expect((await h.agree(dsh.SID, 'error')).explanation).toBe(explanation);
  });
});

// ---------------------------------------------------------------- WorkBuddy, CodeBuddy Code

describe.each(['workbuddy', 'codebuddy'] as const)('%s', (origin) => {
  const file = (h: Harness): string =>
    path.join(origin === 'workbuddy' ? h.config.workbuddyDirs[0]! : h.config.codebuddyDir!, 'projects', 'home-dev-repo', `${buddy.SID}.jsonl`);
  const terminal = (error?: { code: string; message: string }) => (env: buddy.Envelope): string =>
    buddy.record('acp-terminal-state', env, { requestId: 'req-x', rootRequestId: 'req-x', stopReason: error === undefined ? 'end_turn' : 'error', ...(error !== undefined ? { error } : {}) });
  async function run(end: (env: buddy.Envelope) => string): Promise<Harness> {
    const h = await harness(buddy.T0);
    const c = new buddy.Chain();
    c.prompt('fix the fixture test');
    await h.append(file(h), c.lines);
    expect(h.store.getSession(buddy.SID)!.status).toBe('running');
    const from = c.lines.length;
    c.reply('The fixture path was wrong; fixed.', 'r1');
    c.fact(end);
    await h.append(file(h), c.lines.slice(from));
    return h;
  }

  test('跑完了: a turn-metrics record', async () => {
    expect((await (await run(buddy.turnMetrics)).agree(buddy.SID, 'finished')).explanation).toBe('The fixture path was wrong; fixed.');
  });

  test('跑完了: an acp-terminal-state without an error', async () => {
    expect((await (await run(terminal())).agree(buddy.SID, 'finished')).explanation).toBe('The fixture path was wrong; fixed.');
  });

  test('出错中断: an acp-terminal-state with an error', async () => {
    expect((await (await run(terminal({ code: 'E_API', message: 'upstream 500' }))).agree(buddy.SID, 'error')).explanation).toBe('upstream 500');
  });
});

// ---------------------------------------------------------------- Qwen Code

describe('Qwen Code', () => {
  const file = (h: Harness): string => path.join(h.config.qwenDir!, 'projects', 'home-u-app', 'chats', `${qwen.SID}.jsonl`);
  async function run(state: 'completed' | 'error' | 'cancelled'): Promise<Harness> {
    const h = await harness(qwen.T0);
    const log = new qwen.Log();
    log.prompt('fix the flaky upload test');
    await h.append(file(h), log.lines);
    expect(h.store.getSession(qwen.SID)!.status).toBe('running');
    const from = log.lines.length;
    log.reply([qwen.text('Reading it.'), qwen.fcall('read_file', { file_path: 'src/upload.ts' }, 'call_1')]);
    log.result('read_file', 'x', { id: 'call_1' });
    log.reply([qwen.text('Fixed the race.')]);
    log.add((env) => qwen.turnResult(state, env, state === 'error' ? 'boom' : undefined));
    await h.append(file(h), log.lines.slice(from));
    return h;
  }

  test('跑完了: turn_result completed', async () => {
    expect((await (await run('completed')).agree(qwen.SID, 'finished')).explanation).toBe('Fixed the race.');
  });

  test.each(['error', 'cancelled'] as const)('出错中断: turn_result %s', async (state) => {
    expect((await (await run(state)).agree(qwen.SID, 'error')).explanation).toBe(state === 'error' ? 'boom' : 'Interrupted');
  });
});

// ---------------------------------------------------------------- Grok, Copilot CLI, 豆包

describe('grok, copilot, doubao: only counted as undeterminable', () => {
  const NOW = Date.parse('2026-11-20T12:00:00.000Z');

  test('each example session is in `undeterminable`, never an item — also after the stuck threshold', async () => {
    const h = await harness(NOW, async (config) => {
      const g = path.join(config.grokDir!, 'sessions', grok.DIR, grok.SID);
      await fs.mkdir(g, { recursive: true });
      await fs.writeFile(path.join(g, 'summary.json'), grok.summaryJson());
      await fs.writeFile(path.join(g, 'updates.jsonl'), grok.exampleLines().map((l) => `${l}\n`).join(''));
      const s = path.join(config.copilotDir!, 'session-state', copilot.SID);
      await fs.mkdir(s, { recursive: true });
      // Up to the first turn's end: not shut down (a shut-down session is ended and has no entry at all).
      await fs.writeFile(path.join(s, 'events.jsonl'), copilot.exampleLines().slice(0, 11).map((l) => `${l}\n`).join(''));
      await fs.writeFile(path.join(s, 'workspace.yaml'), copilot.WORKSPACE_YAML);
      await doubao.writeExample(config.doubaoDirs[0]!);
    });
    const ids = { grok: grok.SID, copilot: copilot.SID, doubao: doubao.CONV } as const;
    const check = async (): Promise<void> => {
      const r = await h.page();
      expect(r.undeterminable.map((u) => [u.origin, u.sessionId]).sort()).toEqual(Object.entries(ids).sort());
      expect(r.items.filter((i) => (Object.values(ids) as string[]).includes(i.sessionId))).toEqual([]);
      expect(r.runningCount).toBe(0);
    };
    await check();
    h.later(DEFAULT_NOTIFICATION_SETTINGS.stuckMinutes * MIN + MIN);
    h.attention.tick();
    await check();
  });
});
