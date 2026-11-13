import { expect, test } from 'vitest';
import {
  ANOMALY_KINDS,
  ANOMALY_LABELS,
  anomalyBasisText,
  CHURN_MIN,
  COST_FACTOR,
  COST_MIN_ACTIVE_MS,
  COST_MIN_TOKENS,
  COST_MIN_TURNS,
  costAnomalies,
  costBaseline,
  detectAnomalies,
  detectionTurns,
  FAILURE_STREAK_MIN,
  groupTurns,
  LOOP_FAILED_MIN,
  LOOP_REPEAT_MIN,
  turnCosts,
  type Anomaly,
  type GraphNode,
  type NodeStatus,
  type TurnCost,
} from '../src/index.js';

const BASE = Date.parse('2026-11-13T00:00:00.000Z');
const iso = (sec: number): string => new Date(BASE + sec * 1000).toISOString();

function mk(id: string, sec: number, o: Partial<GraphNode> = {}): GraphNode {
  return {
    id, sessionId: 's1', turnId: null, agentId: null, parentId: null, kind: 'text', status: null, timestamp: iso(sec),
    confirmed: true, title: 't', summary: '', toolName: null, toolUseId: null, messageId: null,
    durationMs: null, usage: null, systemSubtype: null, childAgentId: null, endedAt: null, ...o,
  };
}

/** A tool call of `call` (`Bash#<key>`) started at `sec`, finished `dur` seconds later unless running. */
function call(id: string, sec: number, key: string, status: NodeStatus, o: Partial<GraphNode> & { dur?: number } = {}): GraphNode {
  const { dur = 1, ...rest } = o;
  const running = status === 'running' || status === 'awaiting_permission';
  return mk(id, sec, {
    kind: 'tool', toolName: 'Bash', inputKey: key, status, turnId: 'T1',
    endedAt: running ? null : iso(sec + dur), durationMs: running ? null : dur * 1000, ...rest,
  });
}

const prompt = (id: string, sec: number, o: Partial<GraphNode> = {}): GraphNode => mk(id, sec, { kind: 'prompt', turnId: id, ...o });
const ofKind = (list: Anomaly[], kind: Anomaly['kind']): Anomaly[] => list.filter((a) => a.kind === kind);

/** A deterministic shuffle. */
function shuffle<T>(list: T[], seed: number): T[] {
  const out = [...list];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

test('thresholds have the spec values', () => {
  expect([LOOP_FAILED_MIN, LOOP_REPEAT_MIN, FAILURE_STREAK_MIN, CHURN_MIN]).toEqual([3, 5, 5, 15]);
  expect([COST_FACTOR, COST_MIN_TURNS, COST_MIN_ACTIVE_MS, COST_MIN_TOKENS]).toEqual([3, 20, 600_000, 200_000]);
});

// ---- loop ----

test('loop (failed): the same call failing 3 times in a turn, not adjacent; 2 times is not enough', () => {
  const nodes = [
    prompt('T1', 0),
    call('a', 1, 'k1', 'failed'),
    call('x', 3, 'k2', 'succeeded'),
    call('b', 5, 'k1', 'failed'),
    call('y', 7, 'k3', 'succeeded'),
    call('c', 9, 'k1', 'failed'),
  ];
  const loops = ofKind(detectAnomalies(nodes), 'loop');
  expect(loops).toEqual([
    {
      id: 'loop:T1', kind: 'loop', sessionId: 's1', agentId: null, turnKey: 'T1', basis: 'failed', count: 3, toolName: 'Bash',
      firstNodeId: 'a', lastNodeId: 'c', at: iso(10),
    },
  ]);
  expect(ofKind(detectAnomalies(nodes.slice(0, 5)), 'loop')).toEqual([]);
});

test('loop (failed): the same input under another tool name, or a node without inputKey, is not the same call', () => {
  const nodes = [
    prompt('T1', 0),
    call('a', 1, 'k1', 'failed'),
    call('b', 3, 'k1', 'failed', { toolName: 'Shell' }),
    call('c', 5, 'k1', 'failed'),
    call('d', 7, 'k1', 'failed', { inputKey: undefined }),
    call('e', 9, 'k1', 'failed', { inputKey: undefined }),
  ];
  expect(ofKind(detectAnomalies(nodes), 'loop')).toEqual([]);
});

test('loop (repeat): the same call 5 times in a row (running counts); 4 is not enough; another call breaks the run', () => {
  const five = [prompt('T1', 0), ...[1, 3, 5, 7].map((s, i) => call(`r${i}`, s, 'k1', 'succeeded')), call('r4', 9, 'k1', 'running')];
  const loops = ofKind(detectAnomalies(five), 'loop');
  expect(loops).toHaveLength(1);
  expect(loops[0]).toMatchObject({ basis: 'repeat', count: 5, firstNodeId: 'r0', lastNodeId: 'r4', at: iso(9) });
  expect(ofKind(detectAnomalies(five.slice(0, 5)), 'loop')).toEqual([]);
  const broken = [...five.slice(0, 3), call('other', 4, 'k2', 'succeeded'), ...five.slice(3)];
  expect(ofKind(detectAnomalies(broken), 'loop')).toEqual([]);
  // Non-call nodes in between (text, thinking) do not break it.
  const withText = [...five, mk('txt', 4, { turnId: 'T1' }), mk('th', 6, { kind: 'thinking', turnId: 'T1' })];
  expect(ofKind(detectAnomalies(withText), 'loop')[0]).toMatchObject({ basis: 'repeat', count: 5 });
  // A node without inputKey is another call: it breaks the run.
  const keyless = [...five.slice(0, 3), call('nk', 4, 'k1', 'succeeded', { inputKey: undefined }), ...five.slice(3)];
  expect(ofKind(detectAnomalies(keyless), 'loop')).toEqual([]);
});

test('loop (repeat): the count grows with the run; first and last node of the run', () => {
  const nodes = [prompt('T1', 0), ...Array.from({ length: 8 }, (_, i) => call(`r${i}`, 1 + 2 * i, 'k1', 'succeeded'))];
  expect(ofKind(detectAnomalies(nodes), 'loop')[0]).toMatchObject({ basis: 'repeat', count: 8, firstNodeId: 'r0', lastNodeId: 'r7', at: iso(9) });
});

test('loop: both conditions in one turn: one anomaly, the one reached first', () => {
  // Five consecutive failures of the same call: the third failure (ends at 6) comes before the fifth start (at 9).
  const failing = [prompt('T1', 0), ...[1, 3, 5, 7, 9].map((s, i) => call(`f${i}`, s, 'k1', 'failed'))];
  const a = ofKind(detectAnomalies(failing), 'loop');
  expect(a).toHaveLength(1);
  expect(a[0]).toMatchObject({ basis: 'failed', count: 5, firstNodeId: 'f0', lastNodeId: 'f4', at: iso(6) });
  // Five succeeded repeats first, three failures of another call later.
  const repeatFirst = [
    prompt('T1', 0),
    ...[1, 3, 5, 7, 9].map((s, i) => call(`r${i}`, s, 'k1', 'succeeded')),
    ...[11, 13, 15].map((s, i) => call(`f${i}`, s, 'k2', 'failed')),
  ];
  const b = ofKind(detectAnomalies(repeatFirst), 'loop');
  expect(b).toHaveLength(1);
  expect(b[0]).toMatchObject({ basis: 'repeat', count: 5, lastNodeId: 'r4' });
});

test('loop: a running call that later fails, and a failure later corrected to success, follow the current status', () => {
  const base = [prompt('T1', 0), call('a', 1, 'k1', 'failed'), call('x', 2, 'k9', 'succeeded'), call('b', 3, 'k1', 'failed')];
  const running = [...base, call('c', 5, 'k1', 'running')];
  expect(ofKind(detectAnomalies(running), 'loop')).toEqual([]);
  const failed = [...base, call('c', 5, 'k1', 'failed')];
  expect(ofKind(detectAnomalies(failed), 'loop')).toHaveLength(1);
  const corrected = [...base, call('c', 5, 'k1', 'succeeded')];
  expect(ofKind(detectAnomalies(corrected), 'loop')).toEqual([]);
});

// ---- failures ----

test('failures: 5 calls in a row ending failed; 4 is not enough; a success breaks the streak', () => {
  const five = [prompt('T1', 0), ...[1, 3, 5, 7, 9].map((s, i) => call(`f${i}`, s, `k${i}`, 'failed'))];
  const f = ofKind(detectAnomalies(five), 'failures');
  expect(f).toEqual([
    { id: 'failures:T1', kind: 'failures', sessionId: 's1', agentId: null, turnKey: 'T1', basis: 'streak', count: 5, firstNodeId: 'f0', lastNodeId: 'f4', at: iso(10) },
  ]);
  expect(ofKind(detectAnomalies(five.slice(0, 5)), 'failures')).toEqual([]);
  const broken = [...five.slice(0, 3), call('ok', 4, 'kok', 'succeeded'), ...five.slice(3)];
  expect(ofKind(detectAnomalies(broken), 'failures')).toEqual([]);
});

test('failures: denied, running and awaiting-permission calls neither count nor break the streak', () => {
  const nodes = [
    prompt('T1', 0),
    call('f0', 1, 'a', 'failed'),
    call('d', 2, 'b', 'denied'),
    call('f1', 3, 'c', 'failed'),
    call('run', 4, 'd', 'running'),
    call('f2', 5, 'e', 'failed'),
    call('wait', 6, 'f', 'awaiting_permission'),
    call('f3', 7, 'g', 'failed'),
  ];
  expect(ofKind(detectAnomalies(nodes), 'failures')).toEqual([]);
  const f = ofKind(detectAnomalies([...nodes, call('f4', 9, 'h', 'failed')]), 'failures');
  expect(f[0]).toMatchObject({ count: 5, firstNodeId: 'f0', lastNodeId: 'f4' });
});

test('failures: the streak is in the order calls finished (parallel calls finishing out of start order)', () => {
  // Started f0..f4 and ok; ok started last but finished between f1 and f2: no streak of 5 in end order.
  const nodes = [
    prompt('T1', 0),
    call('f0', 1, 'a', 'failed', { dur: 1 }),
    call('f1', 2, 'b', 'failed', { dur: 1 }),
    call('f2', 3, 'c', 'failed', { dur: 10 }),
    call('f3', 4, 'd', 'failed', { dur: 10 }),
    call('f4', 5, 'e', 'failed', { dur: 10 }),
    call('ok', 6, 'f', 'succeeded', { dur: 1 }),
  ];
  expect(ofKind(detectAnomalies(nodes), 'failures')).toEqual([]);
  // The same calls, the success finishing last: a streak of 5, last = the one that finished last.
  const later = nodes.map((n) => (n.id === 'ok' ? call('ok', 6, 'f', 'succeeded', { dur: 20 }) : n));
  expect(ofKind(detectAnomalies(later), 'failures')[0]).toMatchObject({ count: 5, firstNodeId: 'f0', lastNodeId: 'f4', at: iso(15) });
});

test('failures and loop: one anomaly per kind per turn; the first streak is reported with its final length', () => {
  const nodes = [
    prompt('T1', 0),
    ...Array.from({ length: 6 }, (_, i) => call(`a${i}`, 1 + i * 2, `ka${i}`, 'failed')),
    call('ok', 14, 'kok', 'succeeded'),
    ...Array.from({ length: 7 }, (_, i) => call(`b${i}`, 20 + i * 2, `kb${i}`, 'failed')),
  ];
  const f = ofKind(detectAnomalies(nodes), 'failures');
  expect(f).toHaveLength(1);
  expect(f[0]).toMatchObject({ count: 6, firstNodeId: 'a0', lastNodeId: 'a5' });
  // Another turn has its own.
  const two = [...nodes, prompt('T2', 100), ...Array.from({ length: 5 }, (_, i) => call(`c${i}`, 101 + i * 2, `kc${i}`, 'failed', { turnId: 'T2' }))];
  expect(ofKind(detectAnomalies(two), 'failures').map((a) => a.turnKey)).toEqual(['T1', 'T2']);
});

// ---- churn ----

const edit = (id: string, sec: number, path: string, status: NodeStatus = 'succeeded', action: 'edit' | 'write' | 'read' = 'edit'): GraphNode =>
  call(id, sec, `e-${id}`, status, { toolName: 'Edit', files: [{ path, action }] });

test('churn: 15 edits / writes of one file in a turn; 14 is not enough; failed, denied and reads do not count', () => {
  const nodes = [prompt('T1', 0), ...Array.from({ length: 14 }, (_, i) => edit(`e${i}`, 1 + i, 'D:/w/a.ts', 'succeeded', i % 2 ? 'write' : 'edit'))];
  const noise = [edit('fail', 20, 'D:/w/a.ts', 'failed'), edit('deny', 21, 'D:/w/a.ts', 'denied'), edit('read', 22, 'D:/w/a.ts', 'succeeded', 'read')];
  expect(ofKind(detectAnomalies([...nodes, ...noise]), 'churn')).toEqual([]);
  // The 15th: a running edit counts (status not failed / denied); path compared by pathKey (Windows: case-insensitive).
  const c = ofKind(detectAnomalies([...nodes, ...noise, edit('e14', 30, 'd:/W/A.ts', 'running')]), 'churn');
  expect(c).toEqual([
    { id: 'churn:T1', kind: 'churn', sessionId: 's1', agentId: null, turnKey: 'T1', basis: 'edits', count: 15, path: 'D:/w/a.ts', firstNodeId: 'e0', lastNodeId: 'e14', at: iso(30) },
  ]);
});

test('churn: one per turn, the file with the most changes; ties go to the one that reached the threshold first', () => {
  const a = Array.from({ length: 16 }, (_, i) => edit(`a${i}`, 100 + i, '/w/a.ts'));
  const b = Array.from({ length: 18 }, (_, i) => edit(`b${i}`, 200 + i, '/w/b.ts'));
  expect(ofKind(detectAnomalies([prompt('T1', 0), ...a, ...b]), 'churn')).toMatchObject([{ path: '/w/b.ts', count: 18 }]);
  const tie = Array.from({ length: 16 }, (_, i) => edit(`c${i}`, 50 + i, '/w/c.ts'));
  expect(ofKind(detectAnomalies([prompt('T1', 0), ...a, ...tie]), 'churn')).toMatchObject([{ path: '/w/c.ts', count: 16 }]);
});

// ---- turns ----

test('detection turns: the main thread is exactly groupTurns', () => {
  const nodes = [
    mk('pre', 0),
    prompt('T1', 1),
    mk('t1a', 2, { turnId: 'T1' }),
    mk('loose', 3),
    prompt('T2', 5),
    mk('same', 5, { turnId: 'T2' }),
    mk('loose2', 6),
    mk('sub', 4, { agentId: 'ag' }),
  ];
  const mine = detectionTurns(nodes).filter((t) => t.agentId === null);
  expect(mine.map((t) => [t.key, t.nodes.map((n) => n.id)])).toEqual(groupTurns(nodes).map((t) => [t.key, t.nodes.map((n) => n.id)]));
});

test('detection turns: the main thread equals groupTurns on random sessions (ties, loose nodes, prelude)', () => {
  for (let seed = 1; seed <= 30; seed++) {
    let s = seed;
    const rnd = (n: number): number => (s = (s * 1103515245 + 12345) & 0x7fffffff) % n;
    const nodes: GraphNode[] = [];
    for (let i = 0; i < 60; i++) {
      const turn = rnd(4);
      nodes.push(mk(`n${i}`, rnd(20), { turnId: turn === 0 ? null : `T${turn}`, agentId: rnd(5) === 0 ? 'ag' : null, kind: rnd(3) === 0 ? 'prompt' : 'tool' }));
    }
    const mine = detectionTurns(nodes).filter((t) => t.agentId === null);
    expect(mine.map((t) => [t.key, t.startMs, t.nodes.map((n) => n.id)])).toEqual(groupTurns(nodes).map((t) => [t.key, t.startMs, t.nodes.map((n) => n.id)]));
  }
});

test('subagent threads: turns per prompt of the thread, keyed agentId:key; a thread without prompts is one turn', () => {
  const nodes = [
    prompt('T1', 0),
    mk('dispatch', 1, { kind: 'subagent', status: 'running', turnId: 'T1', childAgentId: 'ag1', toolName: 'Agent' }),
    mk('sp1', 2, { kind: 'prompt', agentId: 'ag1' }),
    ...[3, 4, 5, 6, 7].map((s, i) => call(`s${i}`, s, `k${i}`, 'failed', { agentId: 'ag1', turnId: null })),
    mk('sp2', 10, { kind: 'prompt', agentId: 'ag1' }),
    ...[11, 12, 13, 14, 15].map((s, i) => call(`t${i}`, s, `kk${i}`, 'failed', { agentId: 'ag1', turnId: null })),
    ...[20, 21, 22, 23, 24].map((s, i) => call(`u${i}`, s, `ku${i}`, 'failed', { agentId: 'ag2', turnId: null })),
  ];
  const turns = detectionTurns(nodes);
  expect(turns.map((t) => [t.agentId, t.key])).toEqual([
    [null, 'T1'],
    ['ag1', 'ag1:sp1'],
    ['ag1', 'ag1:sp2'],
    ['ag2', 'ag2:__prelude__'],
  ]);
  const f = ofKind(detectAnomalies(nodes), 'failures');
  expect(f.map((a) => [a.agentId, a.turnKey, a.firstNodeId])).toEqual([
    ['ag1', 'ag1:sp1', 's0'],
    ['ag1', 'ag1:sp2', 't0'],
    ['ag2', 'ag2:__prelude__', 'u0'],
  ]);
  expect(f.map((a) => a.id)).toEqual(['failures:ag1:sp1', 'failures:ag1:sp2', 'failures:ag2:__prelude__']);
});

test('subagent threads with turnIds (Codex): a node with a turnId belongs to it', () => {
  const nodes = [
    mk('a', 1, { agentId: 'cx', turnId: 'u1', kind: 'prompt' }),
    mk('b', 2, { agentId: 'cx', turnId: 'u1' }),
    mk('c', 3, { agentId: 'cx', turnId: 'u2' }),
    mk('d', 4, { agentId: 'cx' }),
  ];
  expect(detectionTurns(nodes).map((t) => [t.key, t.nodes.map((n) => n.id)])).toEqual([
    ['cx:u1', ['a', 'b']],
    ['cx:u2', ['c', 'd']],
  ]);
});

test('a dispatch node counts as a call of the thread that dispatched it', () => {
  const nodes = [
    prompt('T1', 0),
    ...[1, 3, 5, 7, 9].map((s, i) =>
      mk(`d${i}`, s, { kind: 'subagent', toolName: 'Agent', inputKey: 'same', status: 'succeeded', turnId: 'T1', childAgentId: `ag${i}`, endedAt: iso(s + 1) }),
    ),
  ];
  expect(ofKind(detectAnomalies(nodes), 'loop')).toMatchObject([{ agentId: null, turnKey: 'T1', basis: 'repeat', count: 5, toolName: 'Agent' }]);
});

test('node input order and equal timestamps do not change the result', () => {
  const nodes = [
    prompt('T1', 0),
    ...Array.from({ length: 6 }, (_, i) => call(`s${i}`, 5, 'k1', 'failed')),
    ...Array.from({ length: 16 }, (_, i) => edit(`e${i}`, 6, '/w/a.ts')),
    prompt('T2', 50),
    ...Array.from({ length: 5 }, (_, i) => call(`q${i}`, 51 + i, 'kq', 'succeeded', { turnId: 'T2' })),
  ];
  const expected = detectAnomalies(nodes);
  expect(expected.map((a) => a.kind).sort()).toEqual(['churn', 'failures', 'loop', 'loop']);
  for (const seed of [1, 7, 42, 99]) expect(detectAnomalies(shuffle(nodes, seed))).toEqual(expected);
  expect(ofKind(expected, 'loop')[0]).toMatchObject({ firstNodeId: 's0', count: 6 });
});

test('nodes missing fields (no inputKey, no times, unparseable timestamps) do not crash', () => {
  const nodes = [
    prompt('T1', 0),
    mk('x', 0, { kind: 'tool', status: 'failed', turnId: 'T1', timestamp: 'garbage' }),
    mk('y', 0, { kind: 'tool', status: 'failed', turnId: 'T1', endedAt: 'nope' }),
  ];
  expect(() => detectAnomalies(nodes)).not.toThrow();
  expect(detectAnomalies([])).toEqual([]);
});

test('large: 150,000 nodes in one turn (Cursor-like) and many turns finish fast', () => {
  const nodes: GraphNode[] = [prompt('T1', 0)];
  for (let i = 0; i < 150_000; i++) {
    const status: NodeStatus = i % 7 === 0 ? 'failed' : 'succeeded';
    nodes.push(call(`n${i}`, 1 + i / 10, `k${i % 50}`, status, { files: i % 3 === 0 ? [{ path: `/w/f${i % 40}.ts`, action: 'edit' }] : undefined }));
  }
  const t0 = performance.now();
  const one = detectAnomalies(nodes);
  const ms1 = performance.now() - t0;
  const turns: GraphNode[] = [];
  for (let t = 0; t < 5000; t++) {
    turns.push(prompt(`P${t}`, t * 100));
    for (let i = 0; i < 30; i++) turns.push(call(`m${t}-${i}`, t * 100 + 1 + i, `k${i % 4}`, i % 5 === 0 ? 'failed' : 'succeeded', { turnId: `P${t}` }));
  }
  const t1 = performance.now();
  detectAnomalies(turns);
  turnCosts(turns, false);
  const ms2 = performance.now() - t1;
  console.log(`detectAnomalies: 150,000 nodes in one turn ${ms1.toFixed(0)} ms; 5,000 turns × 31 nodes (+ turnCosts) ${ms2.toFixed(0)} ms`);
  expect(one.map((a) => a.kind).sort()).toEqual(['churn', 'loop']);
  expect(ms1).toBeLessThan(5000);
  expect(ms2).toBeLessThan(5000);
}, 60_000);

// ---- cost ----

const usage = (inputTokens: number, outputTokens: number, cachedInputTokens = 0) => ({ inputTokens, outputTokens, cachedInputTokens });

test('turnCosts: active time of main-thread tool, dispatch and thinking nodes; tokens = new input + output, deduplicated', () => {
  const nodes = [
    prompt('T1', 0),
    mk('th', 1, { kind: 'thinking', turnId: 'T1', durationMs: 1000, usage: usage(100, 10, 5000), messageId: 'm1' }),
    call('a', 2, 'k', 'succeeded', { dur: 2, usage: usage(100, 10, 5000), messageId: 'm1' }),
    mk('d', 4, { kind: 'subagent', toolName: 'Agent', status: 'succeeded', turnId: 'T1', childAgentId: 'ag', durationMs: 30_000, usage: usage(7, 3), messageId: 'm2' }),
    mk('txt', 5, { turnId: 'T1', durationMs: 99_999, usage: usage(1, 1) }),
    // Subagent-internal: its time is in the dispatch node already; its tokens count for the dispatching turn.
    call('in', 6, 'k', 'succeeded', { agentId: 'ag', turnId: null, dur: 50, usage: usage(1000, 100) }),
    prompt('T2', 100),
    call('b', 101, 'k', 'running', { turnId: 'T2', usage: usage(5, 5) }),
  ];
  const costs = turnCosts(nodes, true);
  expect(costs).toEqual([
    { sessionId: 's1', turnKey: 'T1', startMs: BASE, activeMs: 1000 + 2000 + 30_000, tokens: 110 + 10 + 2 + 1100, finished: true, firstNodeId: 'T1', lastNodeId: 'txt', at: iso(5) },
    { sessionId: 's1', turnKey: 'T2', startMs: BASE + 100_000, activeMs: 0, tokens: 10, finished: false, firstNodeId: 'T2', lastNodeId: 'b', at: iso(101) },
  ]);
  expect(turnCosts(nodes, false).map((c) => c.finished)).toEqual([true, true]);
  expect(turnCosts(shuffle(nodes, 3), true)).toEqual(costs);
  expect(turnCosts([], false)).toEqual([]);
});

const cost = (turnKey: string, activeMs: number, tokens: number, finished = true): TurnCost => ({
  sessionId: 's1', turnKey, startMs: 0, activeMs, tokens, finished, firstNodeId: `${turnKey}-first`, lastNodeId: `${turnKey}-last`, at: iso(0),
});

test('costBaseline: nearest-rank 95th percentiles; tokens over turns with tokens only; null under 20 turns; unfinished left out', () => {
  const twenty = Array.from({ length: 20 }, (_, i) => cost(`t${i}`, (i + 1) * 60_000, (i + 1) * 1000));
  // ceil(0.95 × 20) = 19th value.
  expect(costBaseline(twenty)).toEqual({ activeP95: 19 * 60_000, tokensP95: 19_000 });
  expect(costBaseline(twenty.slice(1))).toEqual({ activeP95: null, tokensP95: null });
  expect(costBaseline([...twenty.slice(1), cost('open', 1, 1, false)])).toEqual({ activeP95: null, tokensP95: null });
  // Cursor: no token data at all.
  const cursor = Array.from({ length: 30 }, (_, i) => cost(`c${i}`, (i + 1) * 1000, 0));
  expect(costBaseline(cursor)).toEqual({ activeP95: 29_000, tokensP95: null });
  // 21 turns, one with tokens 0: 20 qualifying for tokens.
  const mixed = [...twenty, cost('zero', 1, 0)];
  expect(costBaseline(mixed).tokensP95).toBe(19_000);
});

test('costAnomalies: at least COST_FACTOR × p95 and at least the floor; unfinished turns and missing baselines not judged', () => {
  const baseline = { activeP95: 400_000, tokensP95: 150_000 };
  const out = costAnomalies(
    [
      cost('exact', 1_200_000, 450_000),
      cost('below', 1_199_999, 449_999),
      cost('open', 9_000_000, 9_000_000, false),
    ],
    baseline,
  );
  expect(out).toEqual([
    { id: 'cost:exact:time', kind: 'cost', sessionId: 's1', agentId: null, turnKey: 'exact', basis: 'time', value: 1_200_000, baselineValue: 400_000, firstNodeId: 'exact-first', lastNodeId: 'exact-last', at: iso(0) },
    { id: 'cost:exact:tokens', kind: 'cost', sessionId: 's1', agentId: null, turnKey: 'exact', basis: 'tokens', value: 450_000, baselineValue: 150_000, firstNodeId: 'exact-first', lastNodeId: 'exact-last', at: iso(0) },
  ]);
  // The floor: three times a small p95 is not enough under 10 minutes / 200,000 tokens.
  const small = { activeP95: 60_000, tokensP95: 10_000 };
  expect(costAnomalies([cost('a', 599_999, 199_999)], small)).toEqual([]);
  expect(costAnomalies([cost('a', 600_000, 200_000)], small).map((a) => a.basis)).toEqual(['time', 'tokens']);
  // No baseline (too few turns, or Cursor's tokens): not judged.
  expect(costAnomalies([cost('a', 9e9, 9e9)], { activeP95: null, tokensP95: null })).toEqual([]);
  expect(costAnomalies([cost('a', 9e9, 0)], { activeP95: 60_000, tokensP95: null }).map((a) => a.basis)).toEqual(['time']);
});

// ---- labels ----

test('ANOMALY_LABELS: a Chinese name and a one-line explanation per kind', () => {
  expect(ANOMALY_KINDS).toEqual(['loop', 'failures', 'churn', 'cost']);
  expect(ANOMALY_KINDS.map((k) => ANOMALY_LABELS[k].name)).toEqual(['原地打转', '失败扎堆', '反复改同一个文件', '消耗异常高']);
  for (const k of ANOMALY_KINDS) expect(ANOMALY_LABELS[k].description.length).toBeGreaterThan(5);
});

test('anomalyBasisText: one line per basis', () => {
  const a = (o: Partial<Anomaly>): Anomaly => ({ id: 'x', kind: 'loop', sessionId: 's', agentId: null, turnKey: 'T', basis: 'failed', firstNodeId: 'a', lastNodeId: 'b', at: iso(0), ...o });
  expect(anomalyBasisText(a({ basis: 'failed', count: 3 }))).toBe('同一个调用失败了 3 次');
  expect(anomalyBasisText(a({ basis: 'repeat', count: 5 }))).toBe('同一个调用连续执行了 5 次');
  expect(anomalyBasisText(a({ kind: 'failures', basis: 'streak', count: 5 }))).toBe('连续 5 次调用失败');
  expect(anomalyBasisText(a({ kind: 'churn', basis: 'edits', count: 15, path: '/w/a.ts' }))).toBe('改了 15 次');
  expect(anomalyBasisText(a({ kind: 'cost', basis: 'time', value: 42 * 60_000, baselineValue: 42 * 60_000 / 2.3 }))).toBe('工作时间 42 分钟，是平时高位的 2.3 倍');
  expect(anomalyBasisText(a({ kind: 'cost', basis: 'time', value: 125 * 60_000, baselineValue: 62.5 * 60_000 }))).toBe('工作时间 2 小时 5 分钟，是平时高位的 2 倍');
  expect(anomalyBasisText(a({ kind: 'cost', basis: 'tokens', value: 453_000, baselineValue: 150_000 }))).toBe('用了 45.3 万 token，是平时高位的 3 倍');
  expect(anomalyBasisText(a({ kind: 'cost', basis: 'tokens', value: 250_000, baselineValue: 0 }))).toBe('用了 25 万 token，远高于平时');
});

// ---- fix round 1 ----

test('unparseable timestamps: such a node takes no part in detection (no call, failure, edit, nor run break)', () => {
  // Five failures, all unparseable: nothing.
  const garbage = [prompt('T1', 0), ...[1, 2, 3, 4, 5].map((s, i) => call(`g${i}`, s, `k${i}`, 'failed', { timestamp: 'garbage', endedAt: null }))];
  expect(detectAnomalies(garbage)).toEqual([]);
  // Same call failing 3 times, one of them unparseable: not a loop.
  const loop = [prompt('T1', 0), call('a', 1, 'k', 'failed'), call('b', 3, 'k', 'failed'), call('c', 5, 'k', 'failed', { timestamp: 'nope' })];
  expect(detectAnomalies(loop)).toEqual([]);
  // An unparseable different call between repeats does not break the run, nor a success between failures the streak.
  const run = [prompt('T1', 0), ...[1, 3, 5, 7, 9].map((s, i) => call(`r${i}`, s, 'k', 'succeeded')), call('x', 4, 'other', 'succeeded', { timestamp: 'bad' })];
  expect(ofKind(detectAnomalies(run), 'loop')).toMatchObject([{ basis: 'repeat', count: 5 }]);
  const streak = [prompt('T1', 0), ...[1, 3, 5, 7, 9].map((s, i) => call(`f${i}`, s, `k${i}`, 'failed')), call('ok', 4, 'z', 'succeeded', { timestamp: 'bad' })];
  expect(ofKind(detectAnomalies(streak), 'failures')).toMatchObject([{ count: 5 }]);
  // Edits on unparseable nodes do not count.
  const edits = [prompt('T1', 0), ...Array.from({ length: 14 }, (_, i) => edit(`e${i}`, 1 + i, '/w/a.ts')), { ...edit('bad', 20, '/w/a.ts'), timestamp: 'x' }];
  expect(detectAnomalies(edits)).toEqual([]);
});

test('unparseable endedAt: a failure falls back to its start; at is always a valid ISO time', () => {
  const nodes = [prompt('T1', 0), ...[1, 3, 5, 7, 9].map((s, i) => call(`f${i}`, s, `k${i}`, 'failed', { endedAt: 'nope' }))];
  expect(ofKind(detectAnomalies(nodes), 'failures')).toMatchObject([{ count: 5, at: iso(9) }]);
  // A parseable non-canonical time is reported in canonical ISO form.
  const odd = [prompt('T1', 0), ...[1, 3, 5, 7, 9].map((s, i) => call(`f${i}`, s, `k${i}`, 'failed', { endedAt: new Date(BASE + (s + 1) * 1000).toUTCString() }))];
  expect(ofKind(detectAnomalies(odd), 'failures')[0]!.at).toBe(iso(10));
  for (const a of [...detectAnomalies(nodes), ...detectAnomalies(odd)]) expect(new Date(a.at).toISOString()).toBe(a.at);
});

test('turnCosts: a node with an unparseable timestamp adds no time or tokens and never starts a turn or gives its end', () => {
  const nodes = [
    prompt('T1', 0),
    call('a', 2, 'k', 'succeeded', { dur: 2, usage: usage(10, 1) }),
    call('bad', 0, 'k', 'succeeded', { timestamp: 'garbage', endedAt: iso(500), durationMs: 99_000, usage: usage(1000, 1000) }),
    mk('badprompt', 0, { kind: 'prompt', turnId: 'T9', timestamp: 'garbage' }),
  ];
  expect(turnCosts(nodes, false)).toEqual([
    { sessionId: 's1', turnKey: 'T1', startMs: BASE, activeMs: 2000, tokens: 11, finished: true, firstNodeId: 'T1', lastNodeId: 'a', at: iso(4) },
  ]);
  // A messageId also on an unparseable node counts once, on the node that takes part.
  const dup = [prompt('T1', 0), call('a', 2, 'k', 'succeeded', { usage: usage(10, 1), messageId: 'm' }), call('bad', 1, 'k', 'succeeded', { timestamp: 'x', usage: usage(10, 1), messageId: 'm' })];
  expect(turnCosts(dup, false)[0]!.tokens).toBe(11);
  // The turn's end time is a canonical ISO time.
  const odd = [prompt('T1', 0), call('a', 2, 'k', 'succeeded', { endedAt: new Date(BASE + 4000).toUTCString() })];
  expect(turnCosts(odd, false)[0]!.at).toBe(iso(4));
});

test('churn: a node that both edits and writes one file is one change', () => {
  const both = (id: string, sec: number): GraphNode =>
    call(id, sec, `e-${id}`, 'succeeded', { toolName: 'apply_patch', files: [{ path: '/w/a.ts', action: 'write' }, { path: '/w/a.ts', action: 'edit' }] });
  const nodes = [prompt('T1', 0), ...Array.from({ length: 14 }, (_, i) => both(`b${i}`, 1 + i))];
  expect(detectAnomalies(nodes)).toEqual([]);
  expect(ofKind(detectAnomalies([...nodes, both('b14', 20)]), 'churn')).toMatchObject([{ count: 15, lastNodeId: 'b14' }]);
});

test('loop (repeat): a denied different call breaks the run; a run of identical denied calls is a repeat', () => {
  const base = [1, 3, 5, 7, 9].map((s, i) => call(`r${i}`, s, 'k', 'succeeded'));
  expect(ofKind(detectAnomalies([prompt('T1', 0), ...base, call('d', 4, 'other', 'denied')]), 'loop')).toEqual([]);
  const denied = [prompt('T1', 0), ...[1, 3, 5, 7, 9].map((s, i) => call(`d${i}`, s, 'k', 'denied'))];
  expect(ofKind(detectAnomalies(denied), 'loop')).toMatchObject([{ basis: 'repeat', count: 5 }]);
  expect(ofKind(detectAnomalies(denied), 'failures')).toEqual([]);
});

test('loop: a tie between the two conditions goes to failed', () => {
  // The third failure ends exactly when the fifth repeat starts (9 s).
  const nodes = [
    prompt('T1', 0),
    call('c0', 1, 'k', 'failed'),
    call('c1', 3, 'k', 'failed'),
    call('c2', 5, 'k', 'failed', { dur: 4 }),
    call('c3', 7, 'k', 'succeeded'),
    call('c4', 9, 'k', 'running'),
  ];
  expect(ofKind(detectAnomalies(nodes), 'loop')).toMatchObject([{ basis: 'failed', count: 3, at: iso(9) }]);
});

test('loop: the basis stays as calls finish, while its condition still holds; it follows the data when it stops', () => {
  // Five identical calls started in parallel (1..5 s, each running 10 s).
  const step = (statuses: NodeStatus[], o: Partial<GraphNode>[] = []): Anomaly[] =>
    ofKind(detectAnomalies([prompt('T1', 0), ...statuses.map((st, i) => call(`c${i}`, i + 1, 'k', st, { dur: 10, ...o[i] }))]), 'loop');
  expect(step(['running', 'running', 'running', 'running', 'running'])).toMatchObject([{ basis: 'repeat', count: 5, at: iso(5) }]);
  // They fail one after another (ends 11..15): three, then all five failures — still repeat.
  expect(step(['failed', 'failed', 'failed', 'running', 'running'])).toMatchObject([{ basis: 'repeat', count: 5 }]);
  expect(step(['failed', 'failed', 'failed', 'failed', 'failed'])).toMatchObject([{ basis: 'repeat', count: 5 }]);
  // A failure known without an end time is not taken as having ended at its start.
  const noEnd = { endedAt: null };
  expect(step(['failed', 'failed', 'failed', 'running', 'running'], [noEnd, noEnd, noEnd])).toMatchObject([{ basis: 'repeat' }]);
  // Failed first stays failed while the same call goes on repeating.
  const seq = (n: number): GraphNode[] => [prompt('T1', 0), ...Array.from({ length: n }, (_, i) => call(`s${i}`, 1 + 2 * i, 'k', i < 3 ? 'failed' : 'running'))];
  expect(ofKind(detectAnomalies(seq(3)), 'loop')).toMatchObject([{ basis: 'failed', count: 3 }]);
  expect(ofKind(detectAnomalies(seq(7)), 'loop')).toMatchObject([{ basis: 'failed', count: 3, at: iso(6) }]);
  // A failure corrected to success: the failed condition no longer holds, the anomaly follows the data (repeat).
  const corrected = seq(7).map((n) => (n.id === 's2' ? { ...n, status: 'succeeded' as const } : n));
  expect(ofKind(detectAnomalies(corrected), 'loop')).toMatchObject([{ basis: 'repeat', count: 7 }]);
});

test('costBaseline: an origin without token cost (Cursor) never gets a tokens percentile', () => {
  const turns = Array.from({ length: 30 }, (_, i) => cost(`c${i}`, (i + 1) * 60_000, (i + 1) * 100_000));
  expect(costBaseline(turns, { origin: 'cursor' })).toEqual({ activeP95: 29 * 60_000, tokensP95: null });
  expect(costBaseline(turns, { origin: 'claude' }).tokensP95).toBe(2_900_000);
  expect(costBaseline(turns).tokensP95).toBe(2_900_000);
  expect(costAnomalies([cost('h', 9e9, 9e9)], costBaseline(turns, { origin: 'cursor' })).map((a) => a.basis)).toEqual(['time']);
});

// ---- final review ----

test('unparseable timestamps: turns still match the canvas (groupTurns), the node only leaves detection and costs', () => {
  // The turn's only turnId node is unparseable: the canvas anchors T1 at 0, so every later node joins T1.
  const nodes = [
    mk('pre', 1),
    mk('p', 0, { kind: 'prompt', turnId: 'T1', timestamp: 'garbage' }),
    ...[2, 3, 4, 5, 6].map((s, i) => call(`f${i}`, s, `k${i}`, 'failed', { turnId: null })),
  ];
  const main = detectionTurns(nodes).filter((t) => t.agentId === null);
  expect(main.map((t) => [t.key, t.nodes.map((n) => n.id)])).toEqual(groupTurns(nodes).map((t) => [t.key, t.nodes.map((n) => n.id)]));
  expect(ofKind(detectAnomalies(nodes), 'failures')).toMatchObject([{ turnKey: 'T1', count: 5, firstNodeId: 'f0' }]);
  const costs = turnCosts(nodes, false);
  expect(costs.map((c) => [c.turnKey, c.firstNodeId, c.startMs])).toEqual([['T1', 'pre', BASE + 1000]]);
  for (const c of costs) expect(groupTurns(nodes).map((t) => t.key)).toContain(c.turnKey);
});
