import { describe, expect, test } from 'vitest';
import type { Session } from '@claude-canvas/shared';
import { CursorNormalizer } from '../src/normalize/cursor.js';
import { parseCursorHook, sanitizeCursorHookPayload } from '../src/normalize/cursor-hooks.js';
import type { RawEvent } from '../src/store/store.js';
import { interleave, run, type RunResult } from './codex-fixtures.js';
import { at, CursorConv, iso } from './cursor-records.js';

/*
 * Cursor hooks (spec 7.3) never create or change nodes and never create sessions. They leave session-level marks
 * (started / stopped / ended / resumed); the session status is a function of the records and the marks together:
 *   latest mark ended → ended; else the records show the last turn open → running; else the latest mark is `started`
 *   and newer than the session's latest bubble → running; else idle.
 * Synthetic payloads (fields as Cursor documents them, invented values).
 */

const ROOT = 'c-root';

function hook(eventName: string, sec: number, body: Record<string, unknown> = {}, opts: { session?: string | null; conversation?: string } = {}): RawEvent {
  const session = opts.session === undefined ? ROOT : opts.session;
  return {
    source: 'hook',
    origin: 'cursor',
    receivedAt: iso(at(sec)),
    eventName,
    sessionId: session,
    payload: JSON.stringify({
      conversation_id: opts.conversation ?? session,
      generation_id: 'g1',
      model: 'synthetic',
      hook_event_name: eventName,
      cursor_version: '9.9.9',
      workspace_roots: ['/work/app'],
      ...body,
    }),
    projectId: 'p1',
  };
}
const prompt = (sec: number, opts?: { session?: string | null; conversation?: string }) => hook('beforeSubmitPrompt', sec, { prompt: 'x', attachments: [] }, opts);
const stop = (sec: number, opts?: { session?: string | null; conversation?: string }) => hook('stop', sec, { status: 'completed', loop_count: 0 }, opts);
const end = (sec: number, opts?: { session?: string | null; conversation?: string }) => hook('sessionEnd', sec, { session_id: ROOT, reason: 'user_close', duration_ms: 1 }, opts);
const start = (sec: number, opts?: { session?: string | null; conversation?: string }) => hook('sessionStart', sec, { session_id: ROOT, is_background_agent: false, composer_mode: 'agent' }, opts);

const statusOf = (r: RunResult, id = ROOT): Session['status'] | undefined => r.sessions.get(id)?.status;
const go = (events: RawEvent[]): RunResult => run(new CursorNormalizer(), events);

/** A finished turn: prompt at 0, answer at 1, turn end at 2 (composer completed). */
function finishedTurn(c: CursorConv): RawEvent[] {
  return [c.composer({ status: 'completed' }), c.user('u1', 'go', 0), c.text('a1', 'done', 1), c.turnEnd('end', 2)];
}

describe('parseCursorHook', () => {
  test('known events; the conversation id (conversation_id, else session_id); unknown names and broken payloads reported', () => {
    expect(parseCursorHook('stop', JSON.stringify({ conversation_id: 'c1', hook_event_name: 'stop' }))).toEqual({ ok: true, hook: { eventName: 'stop', conversationId: 'c1', workspaceRoot: null } });
    expect(parseCursorHook('sessionStart', JSON.stringify({ session_id: 's1', workspace_roots: ['/w', '/x'] }))).toEqual({
      ok: true,
      hook: { eventName: 'sessionStart', conversationId: 's1', workspaceRoot: '/w' },
    });
    for (const e of ['sessionStart', 'sessionEnd', 'beforeSubmitPrompt', 'stop', 'subagentStop']) expect(parseCursorHook(e, '{"conversation_id":"c"}').ok).toBe(true);
    expect(parseCursorHook('afterFileEdit', '{"conversation_id":"c"}')).toEqual({ ok: false, unknownRecordType: 'hook:afterFileEdit' });
    expect(parseCursorHook('stop', 'nope')).toEqual({ ok: false, unknownRecordType: 'hook:invalid' });
    expect(parseCursorHook('stop', '[]')).toEqual({ ok: false, unknownRecordType: 'hook:invalid' });
    // Well-formed but naming no conversation: nothing to attribute it to, not counted.
    expect(parseCursorHook('stop', '{}')).toEqual({ ok: false, unknownRecordType: null });
    expect(parseCursorHook('afterFileEdit', '{}')).toEqual({ ok: false, unknownRecordType: 'hook:afterFileEdit' });
  });

  test('sanitizeCursorHookPayload: user_email removed (re-serialised); otherwise the text is kept byte for byte', () => {
    const plain = '{ "conversation_id": "c1",  "prompt": "hi" }';
    expect(sanitizeCursorHookPayload(plain)).toBe(plain);
    expect(sanitizeCursorHookPayload('not json')).toBe('not json');
    expect(JSON.parse(sanitizeCursorHookPayload('{"conversation_id":"c1","user_email":"a@b.c","prompt":"hi"}'))).toEqual({ conversation_id: 'c1', prompt: 'hi' });
  });
});

describe('marks', () => {
  test('a hook alone creates no session and no node; an unknown event is counted', () => {
    const r = go([prompt(5), stop(6), end(7), start(8), hook('subagentStop', 9, { subagent_type: 'explorer', status: 'completed' })]);
    expect(r.changes).toEqual([]);
    expect(r.unknown).toEqual([]);
    expect(go([hook('afterFileEdit', 1)]).unknown).toEqual(['hook:afterFileEdit']);
  });

  test('beforeSubmitPrompt newer than every bubble → running until a newer bubble is read; the turn read to its end → idle', () => {
    const c = new CursorConv({ id: ROOT });
    const n = new CursorNormalizer();
    expect(statusOf(run(n, finishedTurn(c)))).toBe('idle');
    expect(statusOf(run(n, [prompt(10)]))).toBe('running'); // nothing read from the database yet
    expect(statusOf(run(n, [c.user('u2', 'more', 11)]))).toBe('running'); // the records now show the open turn
    expect(statusOf(run(n, [c.text('a2', 'ok', 12), c.turnEnd('end2', 13)]))).toBe('idle');
  });

  test('a started mark older than the latest bubble does not keep the session running', () => {
    const c = new CursorConv({ id: ROOT });
    expect(statusOf(go([prompt(-1), ...finishedTurn(c)]))).toBe('idle');
  });

  test('stop replaces a started mark; the records still decide (an open turn stays running)', () => {
    const c = new CursorConv({ id: ROOT });
    expect(statusOf(go([...finishedTurn(c), prompt(10), stop(11)]))).toBe('idle');
    const d = new CursorConv({ id: ROOT });
    expect(statusOf(go([d.composer({ status: 'none' }), d.user('u1', 'go', 0), d.tool('t1', 'read_file', 'loading', 1), stop(2)]))).toBe('running');
  });

  test('sessionEnd → ended whatever the records; a later sessionStart / beforeSubmitPrompt resumes', () => {
    const c = new CursorConv({ id: ROOT });
    const n = new CursorNormalizer();
    run(n, [c.composer({ status: 'none' }), c.user('u1', 'go', 0)]);
    expect(statusOf(run(n, [end(1)]))).toBe('ended');
    expect(statusOf(run(n, [start(2)]))).toBe('running'); // resumed: the records decide (the prompt is the last bubble)
    expect(statusOf(run(n, [end(3)]))).toBe('ended');
    expect(statusOf(run(n, [prompt(4)]))).toBe('running'); // started, newer than every bubble
  });

  test('sessionStart is a resume, not a start: a known idle conversation stays idle', () => {
    const c = new CursorConv({ id: ROOT });
    expect(statusOf(go([...finishedTurn(c), start(20)]))).toBe('idle');
  });

  test('marks of a session not seen yet count once its records arrive', () => {
    const c = new CursorConv({ id: ROOT });
    expect(statusOf(go([end(5), ...finishedTurn(c)]))).toBe('ended');
    const d = new CursorConv({ id: ROOT });
    expect(statusOf(go([prompt(10), ...finishedTurn(d)]))).toBe('running');
  });

  test('"latest" is by time, not by arrival: an older mark applied later does not replace a newer one', () => {
    const c = new CursorConv({ id: ROOT });
    expect(statusOf(go([...finishedTurn(c), end(20), prompt(10)]))).toBe('ended');
    expect(statusOf(go([...finishedTurn(new CursorConv({ id: ROOT })), prompt(20), end(10)]))).toBe('running');
  });

  test('a subagent conversation hook stored under the root session leaves no mark on it', () => {
    const c = new CursorConv({ id: ROOT });
    const r = go([...finishedTurn(c), end(10, { conversation: 'c-sub' }), prompt(11, { conversation: 'c-sub' })]);
    expect(statusOf(r)).toBe('idle');
    expect(r.changes.filter((ch) => ch.type === 'session_upserted' && ch.session.status === 'ended')).toEqual([]);
  });

  test('subagentStop leaves no mark', () => {
    const c = new CursorConv({ id: ROOT });
    expect(statusOf(go([...finishedTurn(c), prompt(10), hook('subagentStop', 11, { status: 'completed' })]))).toBe('running');
  });

  test('hooks never touch nodes, edges, times or the title', () => {
    const c = new CursorConv({ id: ROOT });
    const base = go(finishedTurn(c));
    const withHooks = go([prompt(-5), ...finishedTurn(new CursorConv({ id: ROOT })), stop(30), end(40)]);
    expect(withHooks.graph.nodes).toEqual(base.graph.nodes);
    expect(withHooks.graph.edges).toEqual(base.graph.edges);
    expect({ ...withHooks.sessions.get(ROOT), status: 'idle' }).toEqual(base.sessions.get(ROOT));
  });
});

describe('order independence and replay', () => {
  test('a stop before or after the records that end the turn: same status; any interleaving of hooks and records', () => {
    const records = (): RawEvent[] => {
      const c = new CursorConv({ id: ROOT });
      return [c.composer({ status: 'completed' }), c.user('u1', 'go', 0), c.text('a1', 'done', 1), c.turnEnd('end', 2)];
    };
    const hooks = [prompt(-1), stop(3)];
    const expected = statusOf(go([...records(), ...hooks]));
    expect(expected).toBe('idle');
    for (let seed = 1; seed <= 40; seed++) expect(statusOf(go(interleave([records(), hooks], seed)))).toBe(expected);
    const ended = [prompt(-1), stop(3), end(4)];
    for (let seed = 1; seed <= 40; seed++) expect(statusOf(go(interleave([records(), ended], seed)))).toBe('ended');
  });

  test('restorePreSession rebuilds the marks of a session not seen yet; dropSession forgets them', () => {
    const n = new CursorNormalizer();
    expect(n.needsPreSessionReplay(ROOT)).toBe(true);
    n.restorePreSession(ROOT, [end(5), hook('stop', 6, {}, { session: 'other' })]);
    expect(n.needsPreSessionReplay(ROOT)).toBe(false);
    const c = new CursorConv({ id: ROOT });
    expect(statusOf(run(n, finishedTurn(c)))).toBe('ended');
    expect(n.needsPreSessionReplay(ROOT)).toBe(false);
    n.dropSession(ROOT);
    expect(n.needsPreSessionReplay(ROOT)).toBe(true);
    expect(statusOf(run(n, finishedTurn(new CursorConv({ id: ROOT }))))).toBe('idle');
  });

  test('marks of sessions never seen are bounded: the oldest are dropped', () => {
    const n = new CursorNormalizer();
    run(n, [end(1, { session: 'c-0' })]);
    for (let i = 1; i <= 250; i++) run(n, [stop(2, { session: `c-${i}` })]);
    expect(statusOf(run(n, finishedTurn(new CursorConv({ id: 'c-0' }))), 'c-0')).toBe('idle'); // its end mark was dropped
    const m = new CursorNormalizer();
    run(m, [end(1, { session: 'c-0' })]);
    expect(statusOf(run(m, finishedTurn(new CursorConv({ id: 'c-0' }))), 'c-0')).toBe('ended');
  });
});
