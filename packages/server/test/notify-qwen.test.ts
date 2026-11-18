/**
 * Notifications for Qwen Code (spec 8): the session leaves `running` when a `turn_result` settles the main thread's
 * turn, so "跑完了" and "出错中断" work through the engine's usual paths; a subagent thread's activity notifies nothing.
 * Only the decision engine is driven (it is pure: it returns what it would send), so nothing is ever displayed. Each
 * raw event is one batch of the change stream; the clock follows the records' times unless a test says otherwise.
 * Invented data only.
 */
import { describe, expect, test } from 'vitest';
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationKind } from '@agent-canvas/shared';
import { QwenNormalizer } from '../src/normalize/qwen.js';
import { NotificationEngine } from '../src/notify/engine.js';
import type { RawEvent } from '../src/store/store.js';
import { agentEvents, fcall, isoOf, Log, PROJECT, qwenEvents, sessionModel, T0, text, turnResult } from './qwen-fixtures.js';

const DAY = 24 * 3600_000;
const AGENT = 'Explore-call_b7';

/** The time of a raw event's record (ms). */
function timeOf(ev: RawEvent): number {
  if (ev.source !== 'transcript') throw new Error('transcript only');
  return Date.parse((JSON.parse(ev.line) as { timestamp: string }).timestamp);
}

/** Feeds `events` one by one (or in one batch) through a Qwen normalizer and an engine; returns the kinds decided. */
function feed(events: RawEvent[], o: { clock?: (ev: RawEvent) => number; suppressed?: boolean; batch?: boolean } = {}): NotificationKind[] {
  const n = new QwenNormalizer();
  let now = 0;
  const engine = new NotificationEngine({
    now: () => now,
    settings: () => ({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true, finishedMinSeconds: 0 }),
    suppressed: () => o.suppressed === true,
    projectName: () => 'p',
    sessionUrl: (id) => id,
  });
  const kinds: NotificationKind[] = [];
  const clock = o.clock ?? ((ev: RawEvent) => timeOf(ev) + 500);
  if (o.batch === true) {
    now = clock(events[events.length - 1]!);
    kinds.push(...engine.handleChanges(n.applyBatch(events.map((event) => ({ event, projectId: PROJECT }))).changes).map((x) => x.kind));
  } else {
    for (const ev of events) {
      now = clock(ev);
      kinds.push(...engine.handleChanges(n.apply(ev, PROJECT).changes).map((x) => x.kind));
      kinds.push(...engine.flushDue().map((x) => x.kind));
    }
  }
  const last = now;
  now += 10_000;
  kinds.push(...engine.flushDue().map((x) => x.kind));
  now = last + DEFAULT_NOTIFICATION_SETTINGS.stuckMinutes * 60_000 + 30_000;
  kinds.push(...engine.tick().map((x) => x.kind));
  return kinds;
}

/** A turn: prompt, a reply with a call, its result, a final reply, a turn_result. Records 2 s apart from `log`'s clock. */
function turn(log: Log, k: number, state: 'completed' | 'error' | 'cancelled' = 'completed'): Record<string, string> {
  const ids: Record<string, string> = {};
  ids.p = log.prompt(`prompt ${k}`);
  ids.a = log.reply([text(`working ${k}`), fcall('read_file', { file_path: `f${k}.ts` }, `call_${k}`)]);
  ids.r = log.result('read_file', 'x', { id: `call_${k}` });
  ids.a2 = log.reply([text(`reply ${k}`)]);
  ids.t = log.add((env) => turnResult(state, env, state === 'error' ? 'boom' : undefined));
  return ids;
}

describe('Qwen Code', () => {
  test('a completed turn → 跑完了, once', () => {
    const log = new Log();
    turn(log, 1);
    expect(feed(qwenEvents(log.lines))).toEqual(['finished']);
  });

  test('a turn ended by an error → 出错中断, once; cancelled → 出错中断, once', () => {
    for (const state of ['error', 'cancelled'] as const) {
      const log = new Log();
      turn(log, 1, state);
      expect(feed(qwenEvents(log.lines)), state).toEqual(['error']);
    }
  });

  test('two turns, one completed and one failed → 跑完了 then 出错中断', () => {
    const log = new Log({ t0: T0 });
    turn(log, 1);
    turn(log, 2, 'error');
    expect(feed(qwenEvents(log.lines))).toEqual(['finished', 'error']);
  });

  test('a turn still running: 卡住了 once the threshold passes; a session file that never writes turn_result stays running', () => {
    const log = new Log();
    log.prompt('go');
    log.reply([text('thinking about it')]);
    expect(feed(qwenEvents(log.lines))).toEqual(['stuck']);
  });

  test('an old file: in one batch, line by line long after, or while suppressed → nothing', () => {
    const log = new Log();
    turn(log, 1);
    turn(log, 2, 'error');
    const old = qwenEvents(log.lines);
    expect(feed(old, { batch: true })).toEqual([]);
    expect(feed(old, { clock: (ev) => timeOf(ev) + DAY })).toEqual([]);
    expect(feed(old, { suppressed: true })).toEqual([]);
  });

  test('a subagent thread’s activity notifies nothing: its prompts, its turn ends, its errors', () => {
    const log = new Log();
    turn(log, 1);
    const a = new Log({ prefix: 'c', t0: T0 + 60_000, agent: { agentId: AGENT } });
    a.prompt('go', { payload: null, parts: [text('go')] });
    a.reply([text('working')]);
    a.add((env) => turnResult('error', env, 'agent boom'));
    a.prompt('again', { payload: null, parts: [text('again')] });
    a.add((env) => turnResult('cancelled', env));
    expect(feed([...qwenEvents(log.lines), ...agentEvents(AGENT, a.lines)])).toEqual(['finished']);
  });

  /** The lines with their records 40 s apart: past the rate limit (30 s), inside the recency window (2 min). */
  const spaced = (log: Log): RawEvent[] =>
    qwenEvents(log.lines.map((l, i) => JSON.stringify({ ...(JSON.parse(l) as object), timestamp: isoOf(T0 + (i + 1) * 40_000) })));

  test('a "Turn failed" that leaves with an abandoned branch and returns with it: 出错中断 once for that turn result', () => {
    const log = new Log();
    const ids = turn(log, 1, 'error');
    log.rewindTo(ids.a!); // back into the turn (as a restore of a tool answer does): running again, the failed node goes
    log.add((env) => sessionModel('openai', env), { parent: ids.t! }); // a record hanging off the abandoned branch
    expect(feed(spaced(log))).toEqual(['error']);
  });

  test('a completed turn whose turn_result leaves and returns: 跑完了 once for that turn result', () => {
    const log = new Log();
    const ids = turn(log, 1);
    log.rewindTo(ids.a!);
    log.add((env) => sessionModel('openai', env), { parent: ids.t! });
    expect(feed(spaced(log))).toEqual(['finished']);
  });

  test('a turn re-run after a rewind into it (new work, a new turn_result) notifies again', () => {
    const log = new Log();
    const ids = turn(log, 1);
    log.rewindTo(ids.a!);
    log.result('read_file', 'restored', { id: 'call_1' });
    log.reply([text('a new answer')]);
    log.add((env) => turnResult('error', env, 'second try failed'));
    expect(feed(spaced(log))).toEqual(['finished', 'error']);
  });
});
