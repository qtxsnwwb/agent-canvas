import { beforeEach, describe, expect, test } from 'vitest';
import { applyChanges, type Usage } from '@agent-canvas/shared';
import { CodexNormalizer } from '../src/normalize/codex.js';
import { CodexThread, interleave, run, type RunResult } from './codex-fixtures.js';

/*
 * Codex token usage (spec section 3): each `token_usage_record` puts its response's usage on the first node that
 * response produced in its thread; without one, on the nearest earlier node of the same turn in that thread; with no
 * node of that turn at all it is dropped and counted.
 */

let n: CodexNormalizer;
beforeEach(() => {
  n = new CodexNormalizer();
});

const usageOf = (r: RunResult): Record<string, Usage | null> => Object.fromEntries(Object.values(r.graph.nodes).map((x) => [x.id, x.usage]));
const withUsage = (r: RunResult): Record<string, Usage> =>
  Object.fromEntries(Object.values(r.graph.nodes).flatMap((x) => (x.usage === null ? [] : [[x.id, x.usage] as [string, Usage]])));

describe('Codex token usage', () => {
  test('one response: its usage goes on the first node it produced, once', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = run(n, [
      root.meta(), root.started('t1'), root.user('u1', 'hi'),
      ...root.reasoning('rs1', ['think']), ...root.assistant('m1', 'hello'),
      root.usage({ input: 120, output: 30 }),
      root.complete(),
    ]);
    expect(withUsage(r)).toEqual({ 'thinking:rs1': { inputTokens: 120, cachedInputTokens: 0, outputTokens: 30 } });
    expect(r.unknown).toEqual([]);
    expect(n.droppedUsageCount('root1')).toBe(0);
  });

  test('parallel calls: the first call of the response gets it; the next response its own first node', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = run(n, [
      root.meta(), root.started('t1'), root.user('u1', 'go'),
      root.exec('c1', 'ls'), root.exec('c2', 'pwd'), root.usage({ input: 50, output: 5 }),
      root.output('c1'), root.output('c2'),
      ...root.assistant('m1', 'done'), root.usage({ input: 70, output: 9 }),
      root.complete(),
    ]);
    expect(withUsage(r)).toEqual({ 'tool:c1': { inputTokens: 50, cachedInputTokens: 0, outputTokens: 5 }, 'text:m1': { inputTokens: 70, cachedInputTokens: 0, outputTokens: 9 } });
  });

  test('a response that produced no node: nearest earlier node of the same turn; usages add up', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = run(n, [
      root.meta(), root.started('t1'), root.user('u1', 'go'),
      ...root.assistant('m1', 'first'), root.usage({ input: 100, output: 5 }),
      root.usage({ input: 7, output: 3 }),
      root.complete(),
    ]);
    expect(withUsage(r)).toEqual({ 'text:m1': { inputTokens: 107, cachedInputTokens: 0, outputTokens: 8 } });
  });

  test('fallback stays inside the turn: the prompt of the same turn, not a node of an earlier turn', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = run(n, [
      root.meta(), root.started('t1'), root.user('u1', 'one'), ...root.assistant('m1', 'a'), root.usage({ input: 1, output: 1 }), root.complete(),
      root.started('t2'), root.user('u2', 'two'), root.usage({ input: 4, output: 2 }), root.complete(),
    ]);
    expect(withUsage(r)).toEqual({ 'text:m1': { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, 'prompt:u2': { inputTokens: 4, cachedInputTokens: 0, outputTokens: 2 } });
  });

  test('the response nodes of another turn are not this record\'s: it falls back within its own turn', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = run(n, [
      root.meta(), root.started('t1'), root.user('u1', 'one'), ...root.assistant('m1', 'a'),
      root.usage({ input: 3, output: 1 }, { turnId: 'tX' }),
      root.complete(),
    ]);
    expect(withUsage(r)).toEqual({});
    expect(n.droppedUsageCount('root1')).toBe(1);
  });

  test('no node in the turn at all: dropped and counted, not an unknown record', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = run(n, [root.meta(), root.started('t1'), root.usage({ input: 5, output: 5 }), root.usage({ input: 6, output: 6 }), root.complete()]);
    expect(withUsage(r)).toEqual({});
    expect(r.unknown).toEqual([]);
    expect(n.droppedUsageCount('root1')).toBe(2);
    expect(n.droppedUsageCount('nope')).toBe(0);
  });

  test('non-numeric, negative or missing counts: the record is ignored (not dropped, not unknown)', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = run(n, [
      root.meta(), root.started('t1'), root.user('u1', 'go'),
      ...root.assistant('m1', 'a'), root.usage({ input: -1, output: 5 }),
      ...root.assistant('m2', 'b'), root.usage({ input: '10', output: 5 }),
      ...root.assistant('m3', 'c'), root.usage({ input: 10, output: null }),
      ...root.assistant('m4', 'd'), root.usage(),
      root.record('token_usage_record', { response_id: 'r_x', turn_id: 't1' }),
      ...root.assistant('m5', 'e'), root.usage({ input: 2, output: 3 }),
      root.complete(),
    ]);
    // Each ignored record still ends its response: m5 is the next response's first node.
    expect(withUsage(r)).toEqual({ 'text:m5': { inputTokens: 2, cachedInputTokens: 0, outputTokens: 3 } });
    expect(r.unknown).toEqual([]);
    expect(n.droppedUsageCount('root1')).toBe(0);
  });

  test('the same response id twice in a thread counts once', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = run(n, [
      root.meta(), root.started('t1'), root.user('u1', 'go'),
      ...root.assistant('m1', 'a'), root.usage({ input: 10, output: 1 }, { responseId: 'resp_A' }),
      root.usage({ input: 10, output: 1 }, { responseId: 'resp_A' }),
      root.complete(),
    ]);
    expect(withUsage(r)).toEqual({ 'text:m1': { inputTokens: 10, cachedInputTokens: 0, outputTokens: 1 } });
  });

  test('records without a response id are each counted', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = run(n, [
      root.meta(), root.started('t1'), root.user('u1', 'go'),
      ...root.assistant('m1', 'a'), root.usage({ input: 10, output: 1 }, { responseId: null }),
      root.usage({ input: 5, output: 1 }, { responseId: null }),
      root.complete(),
    ]);
    expect(withUsage(r)).toEqual({ 'text:m1': { inputTokens: 15, cachedInputTokens: 0, outputTokens: 2 } });
  });

  test('the turn running total and event_msg/token_count are not used', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = run(n, [
      root.meta(), root.started('t1'), root.user('u1', 'go'), ...root.assistant('m1', 'a'),
      root.record('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 5000, output_tokens: 5000 }, last_token_usage: { input_tokens: 9, output_tokens: 9 } } }),
      root.complete(),
    ]);
    expect(withUsage(r)).toEqual({});
    // The record's turn_token_usage (999,999 in the fixture) is never what lands on a node.
    const r2 = run(n, [root.started('t2'), root.user('u2', 'go'), ...root.assistant('m2', 'b'), root.usage({ input: 1, output: 2 }), root.complete()]);
    expect(withUsage(r2)).toEqual({ 'text:m2': { inputTokens: 1, cachedInputTokens: 0, outputTokens: 2 } });
  });

  function subagentSession() {
    const root = new CodexThread({ id: 'root1' });
    const sub = new CodexThread({ id: 'sub1', sessionId: 'root1', parent: 'root1', nickname: 'Helper', agentPath: '/root/helper' });
    const rootEvents = [
      root.meta(), root.started('t1'), root.user('u1', 'delegate'),
      root.spawn('sp1', 'helper'), root.usage({ input: 40, output: 4 }),
      root.activity('sp1', 'sub1', '/root/helper'), root.output('sp1', 'started', 'function'),
      ...root.assistant('m1', 'waiting'), root.usage({ input: 60, output: 6 }),
      root.complete(),
    ];
    const subEvents = [
      sub.meta(), sub.started('s1'), sub.context('user', 'do the sub task'),
      ...sub.reasoning('srs1'), sub.exec('k1', 'pwd'), sub.usage({ input: 11, output: 2 }),
      sub.output('k1'), ...sub.assistant('sm1', 'sub done'), sub.usage({ input: 13, output: 3 }),
      sub.usage({ input: 1, output: 1 }),
      sub.complete(),
    ];
    return { rootEvents, subEvents };
  }

  test('a subagent thread keeps its usage on its own nodes; arrival order across threads does not matter', () => {
    const { rootEvents, subEvents } = subagentSession();
    const expected = {
      'tool:sp1': { inputTokens: 40, cachedInputTokens: 0, outputTokens: 4 },
      'text:m1': { inputTokens: 60, cachedInputTokens: 0, outputTokens: 6 },
      'thinking:srs1': { inputTokens: 11, cachedInputTokens: 0, outputTokens: 2 },
      'text:sm1': { inputTokens: 14, cachedInputTokens: 0, outputTokens: 4 },
    };
    expect(withUsage(run(new CodexNormalizer(), [...rootEvents, ...subEvents]))).toEqual(expected);
    expect(withUsage(run(new CodexNormalizer(), [...subEvents, ...rootEvents]))).toEqual(expected);
    for (const seed of [1, 7, 42, 1234, 99999]) {
      expect(withUsage(run(new CodexNormalizer(), interleave([rootEvents, subEvents], seed)))).toEqual(expected);
    }
  });

  test('re-hydration (drop and replay the raw log) gives exactly the live graph, never double counted', () => {
    const { rootEvents, subEvents } = subagentSession();
    const all = interleave([rootEvents, subEvents], 5);
    const live = run(n, all);
    n.dropSession('root1');
    expect(n.droppedUsageCount('root1')).toBe(0);
    const replay = run(n, all);
    // The stored graph after the replay's changes are written over the live ones.
    expect(applyChanges(live.graph, replay.changes)).toEqual(live.graph);
    expect(usageOf(replay)).toEqual(usageOf(live));
    // A fresh normalizer (a rebuild) agrees too.
    expect(run(new CodexNormalizer(), all).graph).toEqual(live.graph);
  });

  test('a node gets usage via node_updated with the absolute total (re-applying the changes is idempotent)', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = run(n, [
      root.meta(), root.started('t1'), root.user('u1', 'go'),
      ...root.assistant('m1', 'a'), root.usage({ input: 100, output: 5 }), root.usage({ input: 7, output: 3 }),
    ]);
    const twice = applyChanges(r.graph, r.changes);
    expect(twice.nodes['text:m1']?.usage).toEqual({ inputTokens: 107, cachedInputTokens: 0, outputTokens: 8 });
  });
});
