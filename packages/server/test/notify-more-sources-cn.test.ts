/**
 * Notifications for DeepSeek Harness and WorkBuddy / CodeBuddy Code (Task 8 review I1): their sessions leave `running`
 * when a turn ends (DeepSeek `turn/end`; Buddy `turn-metrics` / `acp-terminal-state` when the host writes them), so
 * "跑完了" and "出错中断" work through the engine's usual paths. Each raw event is one batch of the change stream; the
 * clock follows the records' times unless a test says otherwise. Invented data only.
 */
import { describe, expect, test } from 'vitest';
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationKind, type Origin } from '@agent-canvas/shared';
import { BuddyNormalizer } from '../src/normalize/buddy.js';
import { DeepSeekNormalizer } from '../src/normalize/deepseek.js';
import { NotificationEngine } from '../src/notify/engine.js';
import type { RawEvent } from '../src/store/store.js';
import { buddyEvents, Chain, CHILD as BUDDY_CHILD, record, T0 as BUDDY_T0, type Envelope } from './buddy-fixtures.js';
import { CHILD, DshLog, dshEvents, headerLine, PROJECT, T0, textBlock } from './deepseek-fixtures.js';

const DAY = 24 * 3600_000;

/** The time of a raw event's record: DeepSeek `time` / header `createdAt` (ms), Buddy `timestamp` (ms). */
function timeOf(ev: RawEvent): number {
  if (ev.source !== 'transcript') throw new Error('transcript only');
  const r = JSON.parse(ev.line) as { time?: number; createdAt?: number; timestamp?: number };
  return r.time ?? r.createdAt ?? r.timestamp ?? 0;
}

/**
 * Feeds `events` one by one through `n` and an engine; `clock(ev)` is the engine time when the event arrives (default:
 * half a second after its record). `batch`: all events in one batch instead (a first import).
 */
function feed(
  n: DeepSeekNormalizer | BuddyNormalizer,
  events: RawEvent[],
  o: { clock?: (ev: RawEvent) => number; suppressed?: boolean; batch?: boolean } = {},
): NotificationKind[] {
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
    const r = n.applyBatch(events.map((event) => ({ event, projectId: PROJECT })));
    kinds.push(...engine.handleChanges(r.changes).map((x) => x.kind));
  } else {
    for (const ev of events) {
      now = clock(ev);
      kinds.push(...engine.handleChanges(n.apply(ev, PROJECT).changes).map((x) => x.kind));
    }
  }
  // The grace period of a held "finished" runs out; then the periodic check just past the stuck threshold (counted
  // from the last record) finds a session still running.
  const last = now;
  now += 10_000;
  kinds.push(...engine.flushDue().map((x) => x.kind));
  now = last + DEFAULT_NOTIFICATION_SETTINGS.stuckMinutes * 60_000 + 30_000;
  kinds.push(...engine.tick().map((x) => x.kind));
  return kinds;
}

describe('DeepSeek Harness', () => {
  const header = headerLine();
  const events = (build: (l: DshLog) => void, base?: number): RawEvent[] => {
    const l = new DshLog(0, base);
    build(l);
    return dshEvents(header, l.lines);
  };
  const turn = (l: DshLog, n: number, end: Record<string, unknown> = { kind: 'completed' }): void => {
    l.turnStart(n);
    l.user(`prompt ${n}`);
    l.assistant(n, 1, [textBlock(`reply ${n}`)], { id: `m${n}` });
    l.turnEnd(n, end);
  };

  test('a completed turn → 跑完了, once', () => {
    expect(feed(new DeepSeekNormalizer(), events((l) => turn(l, 1)))).toEqual(['finished']);
  });

  test('a turn ended by an error → 出错中断, once; by an abort or an interruption → 出错中断', () => {
    expect(feed(new DeepSeekNormalizer(), events((l) => turn(l, 1, { kind: 'error', error: { message: 'boom' } })))).toEqual(['error']);
    expect(feed(new DeepSeekNormalizer(), events((l) => turn(l, 1, { kind: 'aborted', reason: { kind: 'user' } })))).toEqual(['error']);
    expect(feed(new DeepSeekNormalizer(), events((l) => turn(l, 1, { kind: 'interrupted' })))).toEqual(['error']);
  });

  test('two turns, one completed and one failed → 跑完了 then 出错中断; no 卡住了 after the session went idle', () => {
    expect(feed(new DeepSeekNormalizer(), events((l) => {
      turn(l, 1);
      turn(l, 2, { kind: 'error', error: { message: 'boom' } });
    }), { clock: (ev) => timeOf(ev) + 500 })).toEqual(['finished', 'error']);
  });

  test('a session still inside a turn: 卡住了 once the threshold passes (as before)', () => {
    expect(feed(new DeepSeekNormalizer(), events((l) => {
      l.turnStart(1);
      l.user('go');
    }))).toEqual(['stuck']);
  });

  test('an old file: in one batch (first import), row by row long after, or while suppressed (rebuild) → nothing', () => {
    const old = events((l) => {
      turn(l, 1);
      turn(l, 2, { kind: 'error', error: { message: 'boom' } });
    });
    expect(feed(new DeepSeekNormalizer(), old, { batch: true })).toEqual([]);
    expect(feed(new DeepSeekNormalizer(), old, { clock: (ev) => timeOf(ev) + DAY })).toEqual([]);
    expect(feed(new DeepSeekNormalizer(), old, { suppressed: true })).toEqual([]);
  });

  test('a fork: the copied prefix notifies nothing (idle until its cut, row by row and at once); the new turn after it does, once', () => {
    const NOW = T0 + 30 * DAY;
    const copied = new DshLog(0);
    turn(copied, 1);
    turn(copied, 2, { kind: 'error', error: { message: 'boom' } });
    copied.turnStart(3);
    copied.user('still running when forked');
    copied.endSeed(true);
    copied.turnEnd(3, { kind: 'forked' }); // the synthetic closer after the cut
    const fresh = new DshLog(copied.next, NOW - copied.next * 1000);
    turn(fresh, 4);
    const ev = dshEvents(headerLine({ seeded: true, extra: { createdAt: NOW - 60_000 } }), [...copied.lines, ...fresh.lines]);
    // Row by row, the copied rows arriving now with their old times.
    const at = (e: RawEvent) => Math.max(timeOf(e), NOW - 60_000) + 500;
    expect(feed(new DeepSeekNormalizer(), ev, { clock: at })).toEqual(['finished']);
    // The fork file as dsh writes it (header, prefix, cut, closer at once), then the new turn row by row.
    const n = new DeepSeekNormalizer();
    const split = 1 + copied.lines.length;
    let now = NOW;
    const engine = new NotificationEngine({
      now: () => now,
      settings: () => ({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true, finishedMinSeconds: 0 }),
      suppressed: () => false,
      projectName: () => 'p',
      sessionUrl: (id) => id,
    });
    const kinds = engine.handleChanges(n.applyBatch(ev.slice(0, split).map((event) => ({ event, projectId: PROJECT }))).changes).map((x) => x.kind);
    for (const e of ev.slice(split)) {
      now = timeOf(e) + 500;
      kinds.push(...engine.handleChanges(n.apply(e, PROJECT).changes).map((x) => x.kind));
    }
    now += 10_000;
    kinds.push(...engine.flushDue().map((x) => x.kind));
    expect(kinds).toEqual(['finished']);
  });

  test('a subagent thread\'s turns do not notify by themselves', () => {
    const m = new DshLog();
    m.turnStart(1);
    m.user('go');
    m.turnEnd(1);
    const c = new DshLog(0, T0 + 40_000);
    turn(c, 1);
    const kinds = feed(new DeepSeekNormalizer(), [...dshEvents(header, m.lines), ...dshEvents(headerLine({ id: CHILD, parent: undefined }), [], { agentId: CHILD }).slice(0, 0), ...dshEvents(header, c.lines, { agentId: CHILD }).slice(1)]);
    expect(kinds).toEqual(['finished']);
  });
});

describe('WorkBuddy / CodeBuddy Code', () => {
  const metrics = (env: Envelope): string => record('turn-metrics', env, { durationMs: 4200, tokenDelta: 3000 });
  const terminal = (error?: { code: string; message: string }) => (env: Envelope): string =>
    record('acp-terminal-state', env, { requestId: 'req-x', rootRequestId: 'req-x', stopReason: error === undefined ? 'end_turn' : 'error', ...(error !== undefined ? { error } : {}) });

  for (const origin of ['workbuddy', 'codebuddy'] as const satisfies readonly Origin[]) {
    test(`${origin}: a turn-metrics record → 跑完了; an acp-terminal-state with an error → 出错中断`, () => {
      const c = new Chain();
      c.prompt('one');
      c.reply('done', 'r1');
      c.fact(metrics);
      c.prompt('two');
      c.reply('failed', 'r2');
      c.fact(terminal({ code: 'E_API', message: 'upstream 500' }));
      expect(feed(new BuddyNormalizer(origin), buddyEvents(c.lines, { origin }))).toEqual(['finished', 'error']);
    });
  }

  test('an acp-terminal-state without an error → 跑完了', () => {
    const c = new Chain();
    c.prompt('one');
    c.reply('done', 'r1');
    c.fact(terminal());
    expect(feed(new BuddyNormalizer('codebuddy'), buddyEvents(c.lines))).toEqual(['finished']);
  });

  test('no turn-end record (a host that writes none): running, 卡住了 after the threshold, as before', () => {
    const c = new Chain();
    c.prompt('one');
    c.reply('done', 'r1');
    expect(feed(new BuddyNormalizer('codebuddy'), buddyEvents(c.lines))).toEqual(['stuck']);
  });

  test('an old file: in one batch, row by row long after, or while suppressed → nothing', () => {
    const c = new Chain();
    c.prompt('one');
    c.reply('done', 'r1');
    c.fact(metrics);
    c.prompt('two');
    c.reply('failed', 'r2');
    c.fact(terminal({ code: 'E', message: 'boom' }));
    const ev = buddyEvents(c.lines);
    expect(feed(new BuddyNormalizer('codebuddy'), ev, { batch: true })).toEqual([]);
    expect(feed(new BuddyNormalizer('codebuddy'), ev, { clock: (e) => timeOf(e) + DAY })).toEqual([]);
    expect(feed(new BuddyNormalizer('codebuddy'), ev, { suppressed: true })).toEqual([]);
  });

  test('an end record on an abandoned branch (after a rewind) does not end the turn', () => {
    const c = new Chain();
    c.prompt('one');
    c.reply('a1', 'r1');
    c.fact(metrics);
    const p2 = c.peekId();
    c.prompt('two');
    const head = c.lines.length;
    c.reply('a2', 'r2');
    c.fact(terminal({ code: 'E', message: 'boom' }));
    c.rewind(p2);
    // The rewind arrives in the same batch as the abandoned lines: only the first turn's end is seen.
    const ev = buddyEvents(c.lines);
    const n = new BuddyNormalizer('codebuddy');
    let now = 0;
    const engine = new NotificationEngine({
      now: () => now,
      settings: () => ({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true, finishedMinSeconds: 0 }),
      suppressed: () => false,
      projectName: () => 'p',
      sessionUrl: (id) => id,
    });
    const kinds: NotificationKind[] = [];
    for (const e of ev.slice(0, head)) {
      now = timeOf(e) + 500;
      kinds.push(...engine.handleChanges(n.apply(e, PROJECT).changes).map((x) => x.kind));
    }
    now = timeOf(ev[ev.length - 1]!) + 500;
    kinds.push(...engine.handleChanges(n.applyBatch(ev.slice(head).map((event) => ({ event, projectId: PROJECT }))).changes).map((x) => x.kind));
    now += 10_000;
    kinds.push(...engine.flushDue().map((x) => x.kind));
    expect(kinds).toEqual(['finished']);
  });

  test('a subagent thread\'s turn-end record does not notify', () => {
    const c = new Chain();
    c.prompt('go');
    const k = new Chain({ prefix: 'c', sessionId: 'runtime', t0: BUDDY_T0 + 30_000 });
    k.reply('child done', 'cr1');
    k.fact(metrics);
    const kinds = feed(new BuddyNormalizer('codebuddy'), [...buddyEvents(c.lines), ...buddyEvents(k.lines, { agentId: BUDDY_CHILD })]);
    expect(kinds).toEqual(['stuck']);
  });
});
