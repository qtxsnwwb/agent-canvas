import { describe, expect, test } from 'vitest';
import { detectAnomalies, type GraphNode, type SeqChange, type Session, type SessionAnomaliesResponse } from '@agent-canvas/shared';
import {
  AnomaliesService,
  parseAnomalyListQuery,
  type AnomaliesServiceOptions,
  type AnomaliesSource,
  type AnomalySummaryEvent,
  type LiveTimers,
} from '../src/anomalies/service.js';
import { summarizeAnomalies } from '../src/anomalies/summary.js';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const MIN = 60_000;
const DAY = 24 * 3600_000;
const iso = (ms: number): string => new Date(ms).toISOString();

function mkSession(id: string, o: Partial<Session> = {}): Session {
  return {
    id, projectId: 'p1', origin: 'claude', cwd: null, title: `title ${id}`, gitBranch: null, status: 'idle',
    sourceDeleted: false, startedAt: iso(NOW - DAY), lastActivityAt: iso(NOW), ...o,
  };
}
function mkNode(sessionId: string, id: string, ms: number, o: Partial<GraphNode> = {}): GraphNode {
  return {
    id, sessionId, turnId: 'T', agentId: null, parentId: null, kind: 'tool', status: 'succeeded', timestamp: iso(ms),
    confirmed: true, title: 'Bash', summary: '', toolName: 'Bash', toolUseId: null, messageId: null,
    durationMs: 1000, usage: null, systemSubtype: null, childAgentId: null, endedAt: iso(ms + 1000), ...o,
  };
}
const prompt = (sessionId: string, turnId: string, ms: number): GraphNode =>
  mkNode(sessionId, `${sessionId}-${turnId}-p`, ms, { kind: 'prompt', status: null, toolName: null, turnId, durationMs: null, endedAt: null });

/** A turn with `failed` failures of one call (a loop at 3), starting at `ms`. */
function loopTurn(sessionId: string, turnId: string, ms: number, failed: number): GraphNode[] {
  const out = [prompt(sessionId, turnId, ms)];
  for (let i = 0; i < failed; i++) {
    out.push(mkNode(sessionId, `${sessionId}-${turnId}-f${i}`, ms + (i + 1) * 2000, { turnId, status: 'failed', inputKey: 'aaaaaaaaaaaaaaaa' }));
  }
  return out;
}

/** A turn of one call lasting `activeMs`. */
function costTurn(sessionId: string, turnId: string, ms: number, activeMs: number): GraphNode[] {
  return [
    prompt(sessionId, turnId, ms),
    mkNode(sessionId, `${sessionId}-${turnId}-c`, ms + 1000, { turnId, durationMs: activeMs, endedAt: iso(ms + 1000 + activeMs), inputKey: `k-${turnId}` }),
  ];
}

class FakeSource implements AnomaliesSource {
  seq = 1;
  reads: string[] = [];
  failing = new Set<string>();
  delayMs = 0;
  readonly data = new Map<string, { session: Session; nodes: GraphNode[] }>();
  set(id: string, nodes: GraphNode[], o: Partial<Session> = {}): void {
    this.data.set(id, { session: mkSession(id, o), nodes });
    this.seq++;
  }
  /** Adds nodes to a session; returns the changes the pipeline would report. */
  add(id: string, nodes: GraphNode[]): SeqChange[] {
    const d = this.data.get(id)!;
    d.nodes.push(...nodes);
    return nodes.map((node) => ({ type: 'node_added', node, detail: {}, seq: ++this.seq }));
  }
  /** Changes a session record; returns the session_upserted change. */
  upsert(id: string, o: Partial<Session>): SeqChange {
    const d = this.data.get(id)!;
    d.session = { ...d.session, ...o };
    return { type: 'session_upserted', session: d.session, seq: ++this.seq };
  }
  sessions(): Session[] {
    return [...this.data.values()].map((d) => d.session);
  }
  async readSession(sessionId: string) {
    this.reads.push(sessionId);
    if (this.failing.has(sessionId)) throw new Error('broken');
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const d = this.data.get(sessionId);
    return d ? { session: d.session, nodes: [...d.nodes], seq: this.seq } : null;
  }
}

const make = (source: AnomaliesSource, o: AnomaliesServiceOptions = {}): AnomaliesService =>
  new AnomaliesService(source, { now: () => NOW, answerWaitMs: 5000, liveDelayMs: 0, liveCostFactor: 0, ...o }); // unpaced unless a test says otherwise
const ALL = { range: 'all' as const, origin: null, projectId: null, kind: null };

describe('parseAnomalyListQuery', () => {
  test('defaults: 30d, no filters; empty strings mean no filter', () => {
    expect(parseAnomalyListQuery({})).toEqual({ range: '30d', origin: null, projectId: null, kind: null });
    expect(parseAnomalyListQuery({ range: '7d', origin: '', projectId: '', kind: '' })).toEqual({ range: '7d', origin: null, projectId: null, kind: null });
    // An empty range is like the other empty filters: the default.
    expect(parseAnomalyListQuery({ range: '' })).toEqual({ range: '30d', origin: null, projectId: null, kind: null });
    expect(parseAnomalyListQuery({ range: 'all', origin: 'codex', projectId: 'p', kind: 'churn' })).toEqual({ range: 'all', origin: 'codex', projectId: 'p', kind: 'churn' });
  });
  test.each([
    ['range', { range: '1y' }],
    ['origin', { origin: 'gpt' }],
    ['kind', { kind: 'slow' }],
    ['repeated range', { range: ['7d', '30d'] }],
    ['repeated projectId', { projectId: ['a', 'b'] }],
    ['repeated kind', { kind: ['loop', 'cost'] }],
  ])('400: %s', (_name, q) => {
    expect(parseAnomalyListQuery(q)).toHaveProperty('error');
  });
});

describe('AnomaliesService', () => {
  test('session: its anomalies by time; unknown session: null', async () => {
    const src = new FakeSource();
    src.set('a', [...loopTurn('a', 'T1', NOW - 10 * MIN, 3), ...loopTurn('a', 'T2', NOW - 20 * MIN, 4)]);
    const svc = make(src);
    const r = (await svc.session('a')) as SessionAnomaliesResponse;
    expect(r).not.toBeNull();
    expect(r.computing).toBe(false);
    expect(r.anomalies.map((a) => [a.kind, a.turnKey, a.count])).toEqual([['loop', 'T2', 4], ['loop', 'T1', 3]]);
    expect(r.anomalies).toEqual(detectAnomalies(src.data.get('a')!.nodes));
    expect(await svc.session('nope')).toBeNull();
  });

  test('a changed session recomputes only its own summary', async () => {
    const src = new FakeSource();
    src.set('a', loopTurn('a', 'T1', NOW - 10 * MIN, 2));
    src.set('b', loopTurn('b', 'T1', NOW - 10 * MIN, 3));
    const svc = make(src);
    expect((await svc.counts()).counts).toEqual({ b: { total: 1, byKind: { loop: 1 } } });
    src.reads = [];
    expect(Object.keys((await svc.counts()).counts)).toEqual(['b']);
    expect(src.reads).toEqual([]);
    svc.noteChanges(src.add('a', [mkNode('a', 'a-x', NOW - 9 * MIN, { turnId: 'T1', status: 'failed', inputKey: 'aaaaaaaaaaaaaaaa' })]));
    expect((await svc.counts()).counts).toEqual({ a: { total: 1, byKind: { loop: 1 } }, b: { total: 1, byKind: { loop: 1 } } });
    expect(src.reads).toEqual(['a']);
  });

  test('a status change alone invalidates the session: its last turn becomes finished and is judged for cost', async () => {
    const src = new FakeSource();
    // 25 finished turns of 1 minute, then one of 30 minutes still running.
    const nodes: GraphNode[] = [];
    for (let i = 0; i < 25; i++) nodes.push(...costTurn('a', `T${String(i).padStart(2, '0')}`, NOW - DAY + i * 10 * MIN, MIN));
    nodes.push(...costTurn('a', 'T99', NOW - 40 * MIN, 30 * MIN));
    src.set('a', nodes, { status: 'running' });
    let summaries = 0;
    const svc = make(src, { summarize: (s, n) => { summaries++; return summarizeAnomalies(s, n); } });
    expect(((await svc.session('a')) as SessionAnomaliesResponse).anomalies).toEqual([]);
    expect(summaries).toBe(1);
    svc.noteChanges([src.upsert('a', { status: 'idle' })]);
    const after = ((await svc.session('a')) as SessionAnomaliesResponse).anomalies;
    expect(summaries).toBe(2);
    expect(after.map((a) => [a.kind, a.basis, a.turnKey])).toEqual([['cost', 'time', 'T99']]);
  });

  test('list: newest first, range / origin / project / kind filters; totals ignore the kind filter', async () => {
    const src = new FakeSource();
    src.set('a', [...loopTurn('a', 'T1', NOW - 2 * DAY, 3), ...loopTurn('a', 'T2', NOW - 20 * DAY, 3)]);
    src.set('b', loopTurn('b', 'T1', NOW - 1 * DAY, 5), { origin: 'codex', projectId: 'p2', title: null });
    src.set('c', loopTurn('c', 'T1', NOW - 60 * DAY, 3));
    const svc = make(src);
    const all = await svc.list(ALL);
    expect(all.items.map((i) => `${i.sessionId}/${i.turnKey}/${i.kind}`)).toEqual(['b/T1/failures', 'b/T1/loop', 'a/T1/loop', 'a/T2/loop', 'c/T1/loop']);
    expect(all.totals).toEqual({ loop: 4, failures: 1, churn: 0, cost: 0 });
    expect(all).toMatchObject({ truncated: false, computing: false, failedSessions: 0 });
    expect(all.items[0]).toMatchObject({ projectId: 'p2', origin: 'codex', sessionTitle: null });
    expect(all.items[2]).toMatchObject({ projectId: 'p1', origin: 'claude', sessionTitle: 'title a' });
    // Only kinds, counts, numbers, times, ids, paths and the session title.
    expect(Object.keys(all.items[2]!).sort()).toEqual(
      ['agentId', 'at', 'basis', 'count', 'firstNodeId', 'id', 'kind', 'lastNodeId', 'origin', 'projectId', 'sessionId', 'sessionTitle', 'toolName', 'turnKey'],
    );
    const d30 = await svc.list({ ...ALL, range: '30d' });
    expect(d30.items.map((i) => i.sessionId)).toEqual(['b', 'b', 'a', 'a']);
    const d7 = await svc.list({ ...ALL, range: '7d' });
    expect(d7.items.map((i) => `${i.sessionId}/${i.turnKey}`)).toEqual(['b/T1', 'b/T1', 'a/T1']);
    expect((await svc.list({ ...ALL, origin: 'codex' })).items.map((i) => i.sessionId)).toEqual(['b', 'b']);
    expect((await svc.list({ ...ALL, projectId: 'p1' })).items.map((i) => i.sessionId)).toEqual(['a', 'a', 'c']);
    expect((await svc.list({ ...ALL, projectId: 'unknown' })).items).toEqual([]);
    const loops = await svc.list({ ...ALL, kind: 'failures' });
    expect(loops.items.map((i) => i.kind)).toEqual(['failures']);
    expect(loops.totals).toEqual({ loop: 4, failures: 1, churn: 0, cost: 0 });
  });

  test('list: at most 200, truncated when more matched; totals count all of them', async () => {
    const src = new FakeSource();
    for (let s = 0; s < 3; s++) {
      const nodes: GraphNode[] = [];
      for (let t = 0; t < 70; t++) nodes.push(...loopTurn(`s${s}`, `T${String(t).padStart(2, '0')}`, NOW - DAY + (s * 70 + t) * MIN, 3));
      src.set(`s${s}`, nodes);
    }
    const svc = make(src);
    const r = await svc.list(ALL);
    expect(r.items).toHaveLength(200);
    expect(r.truncated).toBe(true);
    expect(r.totals.loop).toBe(210);
    // newest first: the last session's last turn.
    expect(r.items[0]).toMatchObject({ sessionId: 's2', turnKey: 'T69' });
    expect((await svc.list({ ...ALL, projectId: 'p1', origin: 'claude' })).truncated).toBe(true);
  });

  test('counts: only sessions with anomalies, per kind, all time', async () => {
    const src = new FakeSource();
    src.set('a', [...loopTurn('a', 'T1', NOW - 400 * DAY, 3), ...loopTurn('a', 'T2', NOW - DAY, 5)]);
    src.set('b', loopTurn('b', 'T1', NOW - DAY, 1));
    const svc = make(src);
    expect(await svc.counts()).toEqual({ counts: { a: { total: 3, byKind: { loop: 2, failures: 1 } } }, computing: false });
  });

  test('cost: the baseline is per (project, origin) over all sessions, whatever the filters; cached while nothing changes', async () => {
    const src = new FakeSource();
    // p1/claude: 30 old 1-minute turns spread over two sessions, then a 30-minute turn yesterday.
    const old = (id: string, from: number): GraphNode[] => {
      const out: GraphNode[] = [];
      for (let i = 0; i < 15; i++) out.push(...costTurn(id, `T${String(i).padStart(2, '0')}`, NOW - 90 * DAY + (from + i) * 10 * MIN, MIN));
      return out;
    };
    src.set('a', old('a', 0));
    src.set('b', [...old('b', 15), ...costTurn('b', 'T99', NOW - DAY, 30 * MIN)]);
    // p1/codex: the same long turn, but its group has too few turns: not judged.
    src.set('c', [...costTurn('c', 'T1', NOW - DAY, MIN), ...costTurn('c', 'T2', NOW - DAY + 10 * MIN, 30 * MIN)], { origin: 'codex' });
    const svc = make(src);
    const r = await svc.list({ ...ALL, range: '7d' });
    expect(r.items.map((i) => [i.sessionId, i.kind, i.basis, i.turnKey])).toEqual([['b', 'cost', 'time', 'T99']]);
    expect(r.items[0]!.baselineValue).toBe(MIN);
    // Filtering on the session's own project / origin gives the same judgement.
    expect((await svc.list({ ...ALL, range: '7d', origin: 'claude', projectId: 'p1' })).items).toHaveLength(1);
    expect(((await svc.session('b')) as SessionAnomaliesResponse).anomalies.map((a) => a.kind)).toEqual(['cost']);
    expect((await svc.counts()).counts).toEqual({ b: { total: 1, byKind: { cost: 1 } } });
    const derivations = svc.derivationCount();
    await svc.list({ ...ALL, kind: 'cost' });
    await svc.counts();
    expect(svc.derivationCount()).toBe(derivations);
    // A change anywhere re-derives once.
    svc.noteChanges(src.add('c', costTurn('c', 'T3', NOW - DAY + 50 * MIN, MIN)));
    await svc.counts();
    await svc.counts();
    expect(svc.derivationCount()).toBe(derivations + 1);
  });

  test('a session whose summary throws is counted and skipped, and retried only when it changes', async () => {
    const src = new FakeSource();
    src.set('a', loopTurn('a', 'T1', NOW - DAY, 3));
    src.set('bad', loopTurn('bad', 'T1', NOW - DAY, 3));
    let broken = true;
    let attempts = 0;
    const svc = make(src, {
      summarize: (s, n) => {
        if (s.id === 'bad') {
          attempts++;
          if (broken) throw new Error('boom');
        }
        return summarizeAnomalies(s, n);
      },
    });
    const r = await svc.list(ALL);
    expect(r.failedSessions).toBe(1);
    expect(r.items.map((i) => i.sessionId)).toEqual(['a']);
    await svc.list(ALL);
    expect(attempts).toBe(1);
    expect(await svc.session('bad')).toBe('failed');
    broken = false;
    svc.noteChanges(src.add('bad', [mkNode('bad', 'bad-x', NOW - DAY + 60_000, { turnId: 'T1' })]));
    const after = await svc.list(ALL);
    expect(attempts).toBe(2);
    expect(after.failedSessions).toBe(0);
    expect(after.items.map((i) => i.sessionId).sort()).toEqual(['a', 'bad']);
    // A failing read counts too (and is retried by the next request, as the stats service does).
    src.failing.add('a');
    svc.noteChanges(src.add('a', [mkNode('a', 'a-x', NOW - DAY + 60_000, { turnId: 'T1' })]));
    expect((await svc.list(ALL)).failedSessions).toBe(1);
  });

  test('still computing: an answer within answerWaitMs from what is ready (as computed so far), flagged; complete afterwards', async () => {
    const src = new FakeSource();
    src.set('a', loopTurn('a', 'T1', NOW - DAY, 3));
    src.set('b', loopTurn('b', 'T1', NOW - DAY, 3));
    const svc = make(src, { answerWaitMs: 20 });
    expect((await svc.counts()).computing).toBe(false);
    src.set('c', loopTurn('c', 'T1', NOW - DAY, 3));
    src.delayMs = 200;
    const more = (['f3', 'f4'] as const).map((id, i) => mkNode('b', `b-${id}`, NOW - DAY + (i + 10) * 2000, { turnId: 'T1', status: 'failed', inputKey: 'aaaaaaaaaaaaaaaa' }));
    svc.noteChanges(src.add('b', more));
    const early = await svc.counts();
    expect(early).toEqual({ counts: { a: { total: 1, byKind: { loop: 1 } }, b: { total: 1, byKind: { loop: 1 } } }, computing: true });
    expect((await svc.list(ALL)).computing).toBe(true);
    await svc.warm();
    const later = await svc.counts();
    expect(later.computing).toBe(false);
    expect(later.counts).toEqual({
      a: { total: 1, byKind: { loop: 1 } }, b: { total: 2, byKind: { loop: 1, failures: 1 } }, c: { total: 1, byKind: { loop: 1 } },
    });
  });

  test('until the start-up work is over (startupDone), answers say computing', async () => {
    const src = new FakeSource();
    src.set('a', loopTurn('a', 'T1', NOW - DAY, 3));
    let done = false;
    const svc = make(src, { startupDone: () => done });
    expect((await svc.counts()).computing).toBe(true);
    expect(((await svc.session('a')) as SessionAnomaliesResponse).computing).toBe(true);
    done = true;
    expect((await svc.list(ALL)).computing).toBe(false);
  });

  test('every summary computed is shown to the listeners, with whether the session runs', async () => {
    const src = new FakeSource();
    src.set('a', loopTurn('a', 'T1', NOW - DAY, 3), { status: 'running' });
    src.set('b', loopTurn('b', 'T1', NOW - DAY, 3));
    const svc = make(src);
    const events: AnomalySummaryEvent[] = [];
    svc.onSummary((e) => events.push(e));
    await svc.warm();
    expect(events.map((e) => [e.session.id, e.runningUntil, e.anomalies.length])).toEqual([['a', Infinity, 1], ['b', null, 1]]);
    await svc.warm();
    expect(events).toHaveLength(2);
  });
});

describe('AnomaliesService: fix round 1', () => {
  /** 25 finished turns of 1 minute and 100,000 tokens, then one of 30 minutes and 900,000 tokens. */
  function heavy(id: string): GraphNode[] {
    const nodes: GraphNode[] = [];
    const withTokens = (list: GraphNode[], tokens: number): GraphNode[] =>
      list.map((n) => (n.kind === 'tool' ? n : { ...n, usage: { inputTokens: tokens - 1000, outputTokens: 1000 }, messageId: `${n.id}-m` }));
    for (let i = 0; i < 25; i++) nodes.push(...withTokens(costTurn(id, `T${String(i).padStart(2, '0')}`, NOW - 2 * DAY + i * 10 * MIN, MIN), 100_000));
    nodes.push(...withTokens(costTurn(id, 'T99', NOW - DAY, 30 * MIN), 900_000));
    return nodes;
  }

  test('Cursor groups are judged on time only: no token cost anomaly however many token-bearing turns', async () => {
    const src = new FakeSource();
    src.set('claude', heavy('claude'));
    src.set('cursor', heavy('cursor'), { origin: 'cursor' });
    const svc = make(src);
    const bases = (id: string) => async () => ((await svc.session(id)) as SessionAnomaliesResponse).anomalies.map((a) => a.basis);
    expect(await bases('claude')()).toEqual(['time', 'tokens']);
    expect(await bases('cursor')()).toEqual(['time']);
  });

  test('the baseline crosses sessions: the turns of another session finishing make this one judged', async () => {
    const src = new FakeSource();
    const nodes: GraphNode[] = [];
    for (let i = 0; i < 10; i++) nodes.push(...costTurn('a', `T${String(i).padStart(2, '0')}`, NOW - 3 * DAY + i * 10 * MIN, MIN));
    nodes.push(...costTurn('a', 'T99', NOW - DAY, 30 * MIN));
    src.set('a', nodes);
    const other: GraphNode[] = [];
    for (let i = 0; i < 9; i++) other.push(...costTurn('b', `T${String(i).padStart(2, '0')}`, NOW - 2 * DAY + i * 10 * MIN, MIN));
    src.set('b', other, { status: 'running' }); // its last turn is unfinished: 11 + 8 = 19 finished turns, one short
    const svc = make(src);
    expect((await svc.counts()).counts).toEqual({});
    svc.noteChanges([src.upsert('b', { status: 'idle' })]);
    expect((await svc.counts()).counts).toEqual({ a: { total: 1, byKind: { cost: 1 } } });
  });

  test('a refresh and a session request reading the same session at once share one read and one summary', async () => {
    const src = new FakeSource();
    src.set('a', loopTurn('a', 'T1', NOW - DAY, 3));
    src.delayMs = 30;
    const svc = make(src);
    const events: AnomalySummaryEvent[] = [];
    svc.onSummary((e) => events.push(e));
    await Promise.all([svc.warm(), svc.session('a'), svc.counts()]);
    expect(src.reads).toEqual(['a']);
    expect(events).toHaveLength(1);
  });

  test('partial answers count failed reads; a deleted session is forgotten', async () => {
    const src = new FakeSource();
    src.set('a', loopTurn('a', 'T1', NOW - DAY, 3));
    src.set('gone', loopTurn('gone', 'T1', NOW - DAY, 3), { status: 'running' });
    const svc = make(src, { answerWaitMs: 10 });
    await svc.warm();
    src.failing.add('a');
    svc.noteChanges(src.add('a', [mkNode('a', 'a-x', NOW - DAY + MIN, { turnId: 'T1' })]));
    await svc.warm(); // the read of a fails
    src.failing.clear();
    src.set('c', loopTurn('c', 'T1', NOW - DAY, 3));
    src.delayMs = 200;
    const partial = await svc.list(ALL);
    expect(partial.computing).toBe(true);
    expect(partial.failedSessions).toBe(1);
    await svc.warm();
    expect((await svc.list(ALL)).failedSessions).toBe(0);
    src.delayMs = 0;
    src.data.delete('gone');
    svc.noteChanges([{ type: 'session_upserted', session: mkSession('gone', { sourceDeleted: true }), seq: ++src.seq }]);
    const after = await svc.counts();
    expect(Object.keys(after.counts).sort()).toEqual(['a', 'c']);
    const sizes = svc.stateSizes();
    expect(sizes.latest).toBe(2);
    expect(sizes.runState).toBeLessThanOrEqual(2);
    expect(sizes.changedSeq).toBeLessThanOrEqual(2);
  });

  test('per-session state is bounded by the capacity', async () => {
    const src = new FakeSource();
    for (let i = 0; i < 6; i++) src.set(`s${i}`, loopTurn(`s${i}`, 'T1', NOW - DAY, 3));
    const svc = make(src, { capacity: 3 });
    for (let i = 0; i < 6; i++) await svc.session(`s${i}`);
    for (const v of Object.values(svc.stateSizes())) expect(v).toBeLessThanOrEqual(3);
  });
});

describe('AnomaliesService: background recompute of running sessions', () => {
  class FakeTimers implements LiveTimers {
    pending: { fn: () => void; ms: number }[] = [];
    setTimeout(fn: () => void, ms: number): unknown {
      const t = { fn, ms };
      this.pending.push(t);
      return t;
    }
    clearTimeout(h: unknown): void {
      this.pending = this.pending.filter((t) => t !== h);
    }
    async fire(): Promise<void> {
      const due = this.pending;
      this.pending = [];
      for (const t of due) t.fn();
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    }
  }

  const setup = (live: boolean) => {
    const src = new FakeSource();
    src.set('run', loopTurn('run', 'T1', NOW - MIN, 2), { status: 'running' });
    src.set('idle', loopTurn('idle', 'T1', NOW - MIN, 2));
    const timers = new FakeTimers();
    let clock = 0;
    const svc = make(src, { live: () => live, timers, clock: () => clock, liveDelayMs: 1000, liveCostFactor: 4 });
    const events: AnomalySummaryEvent[] = [];
    svc.onSummary((e) => events.push(e));
    return { src, timers, svc, events, tick: (ms: number) => { clock += ms; } };
  };

  test('a running session\'s change is recomputed after the delay, alone, without a request', async () => {
    const { src, timers, svc, events } = setup(true);
    await svc.warm();
    src.reads = [];
    events.length = 0;
    svc.noteChanges([src.upsert('run', { lastActivityAt: iso(NOW) })]);
    svc.noteChanges(src.add('run', [mkNode('run', 'run-x', NOW - 10_000, { turnId: 'T1', status: 'failed', inputKey: 'aaaaaaaaaaaaaaaa' })]));
    svc.noteChanges(src.add('idle', [mkNode('idle', 'idle-x', NOW - 10_000, { turnId: 'T1' })]));
    expect(timers.pending.map((t) => t.ms)).toEqual([1000]); // one timer: the running session's burst
    await timers.fire();
    expect(src.reads).toEqual(['run']);
    expect(events.map((e) => [e.session.id, e.anomalies.map((a) => a.kind)])).toEqual([['run', ['loop']]]);
    expect(svc.liveRecomputeCount()).toBe(1);
  });

  test('off (no notification switch): nothing is recomputed in the background', async () => {
    const { src, timers, svc } = setup(false);
    await svc.warm();
    svc.noteChanges(src.add('run', [mkNode('run', 'run-x', NOW - 10_000, { turnId: 'T1', status: 'failed', inputKey: 'aaaaaaaaaaaaaaaa' })]));
    expect(timers.pending).toEqual([]);
  });

  test('pacing: never sooner than liveCostFactor times the last recompute after it ended; one in flight at a time', async () => {
    const { src, timers, svc, tick } = setup(true);
    await svc.warm();
    // The source takes "500 ms" of clock per read.
    const read = src.readSession.bind(src);
    src.readSession = async (id) => { tick(500); return read(id); };
    svc.noteChanges(src.add('run', [mkNode('run', 'run-a', NOW - 10_000, { turnId: 'T1' })]));
    await timers.fire();
    svc.noteChanges(src.add('run', [mkNode('run', 'run-b', NOW - 9_000, { turnId: 'T1' })]));
    expect(timers.pending.map((t) => t.ms)).toEqual([2000]); // 4 × 500 ms
    tick(1500);
    svc.noteChanges(src.add('run', [mkNode('run', 'run-c', NOW - 8_000, { turnId: 'T1' })]));
    expect(timers.pending).toHaveLength(1); // still armed: not pushed back
    await timers.fire();
    expect(svc.liveRecomputeCount()).toBe(2);
  });

  test('a session that just left running is still recomputed (its last changes may complete an anomaly)', async () => {
    const { src, timers, svc, events } = setup(true);
    await svc.warm();
    events.length = 0;
    svc.noteChanges([...src.add('run', [mkNode('run', 'run-x', NOW - 10_000, { turnId: 'T1', status: 'failed', inputKey: 'aaaaaaaaaaaaaaaa' })]), src.upsert('run', { status: 'idle' })]);
    await timers.fire();
    // Seen running until it left (NOW on the service's clock).
    expect(events.map((e) => [e.session.id, e.runningUntil, e.anomalies.length])).toEqual([['run', NOW, 1]]);
  });
});

describe('AnomaliesService: one pacing rule for every recompute (requests included)', () => {
  class Timers implements LiveTimers {
    pending: { fn: () => void; ms: number }[] = [];
    setTimeout(fn: () => void, ms: number): unknown {
      const t = { fn, ms };
      this.pending.push(t);
      return t;
    }
    clearTimeout(h: unknown): void {
      this.pending = this.pending.filter((t) => t !== h);
    }
    async fire(): Promise<void> {
      const due = this.pending;
      this.pending = [];
      for (const t of due) t.fn();
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    }
  }

  /** A "big" session whose read + summarize takes 500 ms of the fake clock: window max(1 s, 6 × 0.5 s) = 3 s. */
  const setup = (live = false, readMs = 500) => {
    const src = new FakeSource();
    src.set('big', loopTurn('big', 'T1', NOW - MIN, 2), { status: 'running' });
    src.set('small', loopTurn('small', 'T1', NOW - MIN, 2));
    const timers = new Timers();
    let clock = 0;
    const read = src.readSession.bind(src);
    src.readSession = async (id) => {
      if (id === 'big') clock += readMs;
      return read(id);
    };
    const svc = make(src, { live: () => live, timers, clock: () => clock, liveDelayMs: 1000, liveCostFactor: 6 });
    const events: AnomalySummaryEvent[] = [];
    svc.onSummary((e) => events.push(e));
    return { src, timers, svc, events, tick: (ms: number) => { clock += ms; } };
  };
  const failure = (id: string, n: number): GraphNode =>
    mkNode(id, `${id}-x${n}`, NOW - 10_000 + n, { turnId: 'T1', status: 'failed', inputKey: 'aaaaaaaaaaaaaaaa' });

  test('5 change + request pairs in quick succession: answered from the previous summary, recomputed once afterwards', async () => {
    const { src, timers, svc, tick } = setup();
    await svc.counts(); // first summaries: at once
    const base = svc.summaryCount();
    expect(base).toBe(2);
    for (let i = 0; i < 5; i++) {
      tick(300);
      svc.noteChanges(src.add('big', [failure('big', i)]));
      const counts = await svc.counts();
      expect(counts.computing).toBe(false); // bounded staleness is not "computing"
      expect(counts.counts.big).toBeUndefined(); // still the previous summary (2 failures)
      await svc.session('big');
    }
    expect(svc.summaryCount() - base).toBe(0);
    // One recompute, armed by the first stale answer for the end of the window (3 s after the first summary ended).
    expect(timers.pending.map((t) => t.ms)).toEqual([2700]);
    // Without any further request, the dirty session is recomputed when the window ends.
    tick(1500);
    await timers.fire();
    expect(svc.summaryCount() - base).toBe(1);
    expect((await svc.counts()).counts.big).toEqual({ total: 2, byKind: { loop: 1, failures: 1 } });
  });

  test('a small session stays live: a change is visible within about 1 s', async () => {
    const { src, timers, svc, tick } = setup();
    await svc.counts();
    tick(200);
    svc.noteChanges(src.add('small', [failure('small', 0)]));
    expect((await svc.counts()).counts.small).toBeUndefined();
    expect(timers.pending.map((t) => t.ms)).toEqual([800]); // 1 s after its last recompute
    tick(800);
    await timers.fire();
    expect((await svc.counts()).counts.small).toEqual({ total: 1, byKind: { loop: 1 } });
    // Outside the window a request recomputes at once.
    tick(1500);
    svc.noteChanges(src.add('small', [mkNode('small', 'small-ok', NOW - 9_000, { turnId: 'T1' })]));
    const before = svc.summaryCount();
    await svc.counts();
    expect(svc.summaryCount()).toBe(before + 1);
  });

  test('a new session gets its first summary at once', async () => {
    const { src, svc } = setup();
    await svc.counts();
    src.set('new', loopTurn('new', 'T1', NOW - MIN, 3));
    expect((await svc.counts()).counts.new).toEqual({ total: 1, byKind: { loop: 1 } });
  });

  test('notifications: a request inside the window does not delay or duplicate the background recompute', async () => {
    const { src, timers, svc, events, tick } = setup(true);
    await svc.warm();
    events.length = 0;
    tick(100);
    svc.noteChanges(src.add('big', [failure('big', 0)]));
    expect(timers.pending.map((t) => t.ms)).toEqual([2900]); // the window's end (3 s after the warm-up's summary)
    await svc.counts(); // a page asks meanwhile: previous summary, same timer
    expect(timers.pending).toHaveLength(1);
    tick(2900);
    await timers.fire();
    expect(events.map((e) => [e.session.id, e.anomalies.map((a) => a.kind)])).toEqual([['big', ['loop']]]);
  });
});
