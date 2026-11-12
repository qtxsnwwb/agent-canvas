import { describe, expect, test } from 'vitest';
import { STALE_AFTER_MS, usageTotal, type GraphNode, type Session } from '@agent-canvas/shared';
import { summarizeSession, turnDurationMs } from '../src/stats/summary.js';

const T0 = Date.parse('2026-11-10T10:00:00.000Z');
const at = (sec: number): string => new Date(T0 + sec * 1000).toISOString();

function session(o: Partial<Session> = {}): Session {
  return {
    id: 's1', projectId: 'p1', origin: 'claude', cwd: null, title: null, gitBranch: null, status: 'idle',
    sourceDeleted: false, startedAt: at(0), lastActivityAt: at(0), ...o,
  };
}
function node(id: string, sec: number, o: Partial<GraphNode> = {}): GraphNode {
  return {
    id, sessionId: 's1', turnId: null, agentId: null, parentId: null, kind: 'text', status: null, timestamp: at(sec),
    confirmed: true, title: 't', summary: 'secret prompt text', toolName: null, toolUseId: null, messageId: null,
    durationMs: null, usage: null, systemSubtype: null, childAgentId: null, endedAt: null, ...o,
  };
}
const prompt = (id: string, sec: number, turnId: string): GraphNode => node(id, sec, { kind: 'prompt', turnId });
const tool = (id: string, sec: number, turnId: string | null, o: Partial<GraphNode> = {}): GraphNode =>
  node(id, sec, { kind: 'tool', turnId, toolName: 'Bash', title: 'Bash', status: 'succeeded', ...o });

describe('turns', () => {
  test('one turn per main-thread turnId; subagent-internal nodes never form turns', () => {
    const s = summarizeSession(session(), [
      prompt('p1', 0, 'T1'),
      prompt('p2', 100, 'T2'),
      node('in1', 10, { agentId: 'ag', turnId: 'INNER' }),
      node('in2', 11, { agentId: 'ag', turnId: null }),
    ]);
    expect(s.turns.map((t) => t.key)).toEqual(['T1', 'T2']);
  });

  test('a prelude (nodes before the first prompt) is a turn starting at its first node, as on the canvas', () => {
    const s = summarizeSession(session(), [node('sys', 0), prompt('p1', 5, 'T1')]);
    expect(s.turns.map((t) => [t.key, t.startMs])).toEqual([['__prelude__', T0], ['T1', T0 + 5000]]);
  });

  test('closed turn: duration = latest end (endedAt, else timestamp) of its nodes − its start', () => {
    const s = summarizeSession(session(), [
      prompt('p1', 0, 'T1'),
      tool('t1', 10, 'T1', { endedAt: at(40), durationMs: 30_000 }),
      node('x', 30, { turnId: 'T1' }),
    ]);
    const [t] = s.turns;
    expect(t!.open).toBe(false);
    expect(turnDurationMs(t!, T0 + 10 * 3600_000)).toBe(40_000);
  });

  test('a turn whose last node has no end time ends at that node\'s timestamp', () => {
    const s = summarizeSession(session(), [prompt('p1', 0, 'T1'), node('x', 25, { turnId: 'T1' })]);
    expect(turnDurationMs(s.turns[0]!, T0 + 3600_000)).toBe(25_000);
  });

  test('in-progress turn (active node) counts up to now while there was activity in the last 15 minutes', () => {
    const s = summarizeSession(session({ status: 'running', lastActivityAt: at(20) }), [
      prompt('p1', 0, 'T1'),
      tool('t1', 20, 'T1', { status: 'running' }),
    ]);
    const t = s.turns[0]!;
    expect(t.open).toBe(true);
    expect(turnDurationMs(t, T0 + 60_000)).toBe(60_000);
    // Exactly 15 minutes after the last activity it still grows; after that it is cut at the last activity.
    expect(turnDurationMs(t, T0 + 20_000 + STALE_AFTER_MS)).toBe(20_000 + STALE_AFTER_MS);
    expect(turnDurationMs(t, T0 + 20_000 + STALE_AFTER_MS + 1)).toBe(20_000);
  });

  test('a stale running session: its last turn is cut at the last activity', () => {
    const s = summarizeSession(session({ status: 'running', lastActivityAt: at(50) }), [
      prompt('p1', 0, 'T1'),
      node('x', 50, { turnId: 'T1' }),
    ]);
    const t = s.turns[0]!;
    expect(t.open).toBe(true);
    expect(turnDurationMs(t, T0 + 50_000 + 2 * STALE_AFTER_MS)).toBe(50_000);
  });

  test('the last turn of a running session is in progress even with no active node; earlier turns are not', () => {
    const s = summarizeSession(session({ status: 'running', lastActivityAt: at(130) }), [
      prompt('p1', 0, 'T1'),
      node('a', 10, { turnId: 'T1' }),
      prompt('p2', 100, 'T2'),
      node('b', 110, { turnId: 'T2' }),
    ]);
    expect(s.turns.map((t) => t.open)).toEqual([false, true]);
    // The session's lastActivityAt counts as the last turn's last activity.
    expect(turnDurationMs(s.turns[1]!, T0 + 130_000 + STALE_AFTER_MS + 5)).toBe(30_000);
  });

  test('an idle / awaiting-input session\'s last turn is closed', () => {
    for (const status of ['idle', 'awaiting_input', 'ended'] as const) {
      const s = summarizeSession(session({ status }), [prompt('p1', 0, 'T1'), node('a', 10, { turnId: 'T1' })]);
      expect(s.turns[0]!.open).toBe(false);
      expect(turnDurationMs(s.turns[0]!, T0 + 999_999)).toBe(10_000);
    }
  });

  test('an older turn with a node left running is in progress but stops growing 15 minutes after its activity', () => {
    const s = summarizeSession(session({ status: 'idle' }), [
      prompt('p1', 0, 'T1'),
      tool('t1', 10, 'T1', { status: 'running' }),
      prompt('p2', 100, 'T2'),
    ]);
    expect(s.turns[0]!.open).toBe(true);
    expect(turnDurationMs(s.turns[0]!, T0 + 100 * 3600_000)).toBe(10_000);
  });
});

describe('tool calls', () => {
  test('tool and subagent nodes are calls, subagent-internal ones included; other kinds are not', () => {
    const s = summarizeSession(session(), [
      prompt('p1', 0, 'T1'),
      tool('t1', 1, 'T1'),
      node('d1', 2, { kind: 'subagent', turnId: 'T1', toolName: 'Task', title: 'general', status: 'succeeded', childAgentId: 'ag1' }),
      tool('i1', 3, null, { agentId: 'ag1' }),
      node('th', 4, { kind: 'thinking', turnId: 'T1' }),
    ]);
    expect(s.calls.map((c) => c.nodeId)).toEqual(['t1', 'd1', 'i1']);
    expect(s.turns[0]!.toolCalls).toBe(3);
  });

  test('failed = failed or denied; finished excludes running and awaiting_permission', () => {
    const s = summarizeSession(session(), [
      prompt('p1', 0, 'T1'),
      tool('a', 1, 'T1', { status: 'succeeded' }),
      tool('b', 2, 'T1', { status: 'failed' }),
      tool('c', 3, 'T1', { status: 'denied' }),
      tool('d', 4, 'T1', { status: 'running' }),
      tool('e', 5, 'T1', { status: 'awaiting_permission' }),
    ]);
    const t = s.turns[0]!;
    expect([t.toolCalls, t.finished, t.failed]).toEqual([5, 3, 2]);
    expect(s.calls.map((c) => [c.nodeId, c.finished, c.failed])).toEqual([
      ['a', true, false], ['b', true, true], ['c', true, true], ['d', false, false], ['e', false, false],
    ]);
  });

  test('duration: durationMs, else endedAt − timestamp, else unknown; never for an unfinished call', () => {
    const s = summarizeSession(session(), [
      prompt('p1', 0, 'T1'),
      tool('a', 1, 'T1', { durationMs: 500, endedAt: at(9) }),
      tool('b', 2, 'T1', { endedAt: at(5) }),
      tool('c', 3, 'T1'),
      tool('d', 4, 'T1', { status: 'running', durationMs: 700 }),
      tool('e', 5, 'T1', { endedAt: at(4) }), // negative: unknown
    ]);
    expect(s.calls.map((c) => c.durationMs)).toEqual([500, 3000, null, null, null]);
    expect(s.turns[0]!.toolMs).toBe(3500);
  });

  test('parallel calls each count their full duration', () => {
    const s = summarizeSession(session(), [
      prompt('p1', 0, 'T1'),
      tool('a', 1, 'T1', { durationMs: 10_000, endedAt: at(11) }),
      tool('b', 1, 'T1', { durationMs: 10_000, endedAt: at(11) }),
    ]);
    expect(s.turns[0]!.toolMs).toBe(20_000);
    expect(turnDurationMs(s.turns[0]!, T0 + 999_999)).toBe(11_000);
  });

  test('tool name as stored, else a fixed label (never the node title)', () => {
    const s = summarizeSession(session(), [
      prompt('p1', 0, 'T1'),
      tool('a', 1, 'T1', { toolName: 'exec' }),
      tool('b', 2, 'T1', { toolName: null, title: 'web_search' }),
    ]);
    expect(s.calls.map((c) => c.toolName)).toEqual(['exec', '(unknown)']);
  });

  test('a subagent-internal call counts in the turn that dispatched its agent, nested agents included', () => {
    const s = summarizeSession(session(), [
      prompt('p1', 0, 'T1'),
      node('d1', 5, { kind: 'subagent', turnId: 'T1', status: 'succeeded', childAgentId: 'ag1', endedAt: at(500) }),
      prompt('p2', 100, 'T2'),
      // Runs after T2 started, still T1's.
      tool('i1', 200, null, { agentId: 'ag1', status: 'failed' }),
      node('d2', 210, { kind: 'subagent', agentId: 'ag1', status: 'succeeded', childAgentId: 'ag2' }),
      tool('i2', 220, 'X', { agentId: 'ag2', durationMs: 1000 }),
    ]);
    expect(s.calls.map((c) => [c.nodeId, c.turn])).toEqual([['d1', 0], ['i1', 0], ['d2', 0], ['i2', 0]]);
    // d1: 495 s (endedAt − timestamp); i2: 1 s.
    expect([s.turns[0]!.toolCalls, s.turns[0]!.failed, s.turns[0]!.toolMs]).toEqual([4, 1, 496_000]);
    expect(s.turns[1]!.toolCalls).toBe(0);
    // Internal activity keeps the dispatching turn's last activity, not its duration.
    expect(s.turns[0]!.lastActivityMs).toBe(T0 + 500_000);
  });

  test('internal text / thinking nodes extend the dispatching turn last activity', () => {
    const s = summarizeSession(session({ status: 'idle' }), [
      prompt('p1', 0, 'T1'),
      node('d1', 5, { kind: 'subagent', turnId: 'T1', status: 'running', childAgentId: 'ag1' }),
      tool('i1', 10, null, { agentId: 'ag1' }),
      node('txt', 900, { agentId: 'ag1', kind: 'text' }),
      node('th', 950, { agentId: 'ag1', kind: 'thinking' }),
      prompt('p2', 1000, 'T2'),
    ]);
    expect(s.turns[0]!.lastActivityMs).toBe(T0 + 950_000);
    expect(turnDurationMs(s.turns[0]!, T0 + 100 * 3600_000)).toBe(950_000);
  });

  test('an internal call whose dispatch is unknown falls back to the latest turn started at or before it', () => {
    const s = summarizeSession(session(), [
      prompt('p1', 0, 'T1'),
      prompt('p2', 100, 'T2'),
      tool('i1', 150, null, { agentId: 'agX' }),
      tool('i0', -50, null, { agentId: 'agX' }), // before every turn: the first turn
    ]);
    expect(s.calls.map((c) => [c.nodeId, c.turn])).toEqual([['i0', 0], ['i1', 1]]);
  });

  test('without any main-thread turn, internal calls are kept as dated extras (not turns)', () => {
    const s = summarizeSession(session(), [tool('i1', 10, null, { agentId: 'ag', usage: { inputTokens: 5, cachedInputTokens: 50, outputTokens: 1 } })]);
    expect(s.turns).toEqual([]);
    expect(s.calls.map((c) => c.turn)).toEqual([-1]);
    expect(s.extras).toEqual([
      { atMs: T0 + 10_000, dated: true, toolCalls: 1, finished: 1, failed: 0, toolMs: 0, inputTokens: 5, cachedInputTokens: 50, outputTokens: 1 },
    ]);
  });
});

describe('tokens', () => {
  test('usage summed per turn, internal usage in the dispatching turn, each messageId counted once', () => {
    const s = summarizeSession(session(), [
      prompt('p1', 0, 'T1'),
      node('a', 1, { turnId: 'T1', messageId: 'm1', usage: { inputTokens: 100, cachedInputTokens: 1000, outputTokens: 10 } }),
      tool('b', 2, 'T1', { messageId: 'm1', usage: { inputTokens: 100, cachedInputTokens: 1000, outputTokens: 10 } }), // same message
      node('c', 3, { turnId: 'T1', usage: { inputTokens: 1, outputTokens: 2 } }), // no messageId: counted
      node('d', 4, { turnId: 'T1', usage: { inputTokens: 1, outputTokens: 2 } }),
      node('d1', 5, { kind: 'subagent', turnId: 'T1', status: 'succeeded', childAgentId: 'ag' }),
      node('i', 6, { agentId: 'ag', messageId: 'm2', usage: { inputTokens: 7, cachedInputTokens: 70, outputTokens: 3 } }),
    ]);
    // Nodes c and d predate cachedInputTokens (absent): 0.
    expect([s.turns[0]!.inputTokens, s.turns[0]!.cachedInputTokens, s.turns[0]!.outputTokens]).toEqual([109, 1070, 17]);
    expect(s.usageNodes).toBe(5);
  });

  test('the counted node of a shared messageId is the first in the given (snapshot) order, not in time order', () => {
    // A hook-created tool node stored before the transcript's text block of the same message: snapshot order wins,
    // exactly as on the session page (shared usageTotal).
    const nodes = [
      prompt('p1', 0, 'T1'),
      tool('hook-tool', 5, 'T1', { messageId: 'm1', usage: { inputTokens: 50, outputTokens: 7 } }),
      node('text', 3, { turnId: 'T1', messageId: 'm1', usage: { inputTokens: 40, outputTokens: 2 } }),
    ];
    const s = summarizeSession(session(), nodes);
    expect([s.turns[0]!.inputTokens, s.turns[0]!.outputTokens]).toEqual([50, 7]);
    expect(usageTotal(nodes)).toEqual({ inputTokens: 50, cachedInputTokens: 0, outputTokens: 7 });
  });

  test('an empty messageId is no id: each node counts (as on the session page)', () => {
    const nodes = [
      prompt('p1', 0, 'T1'),
      node('a', 1, { turnId: 'T1', messageId: '', usage: { inputTokens: 3, outputTokens: 1 } }),
      node('b', 2, { turnId: 'T1', messageId: '', usage: { inputTokens: 3, outputTokens: 1 } }),
    ];
    const s = summarizeSession(session(), nodes);
    expect(s.turns[0]!.inputTokens).toBe(6);
    expect(usageTotal(nodes).inputTokens).toBe(6);
  });

  test('a session without usage has usageNodes 0', () => {
    expect(summarizeSession(session(), [prompt('p1', 0, 'T1')]).usageNodes).toBe(0);
  });
});

test('the summary carries no conversation content', () => {
  const s = summarizeSession(session(), [prompt('p1', 0, 'T1'), tool('a', 1, 'T1')]);
  expect(JSON.stringify(s)).not.toContain('secret prompt text');
});

describe('undated', () => {
  test('a turn starting at an unparseable time or at the epoch is undated; a normal one is dated', () => {
    const s = summarizeSession(session(), [
      node('bad', 0, { turnId: 'TB', kind: 'prompt', timestamp: 'garbage' }),
      node('epoch', 0, { turnId: 'TE', kind: 'prompt', timestamp: '1970-01-01T00:00:00.000Z' }),
      prompt('p1', 10, 'T1'),
    ]);
    expect(s.turns.map((t) => [t.key, t.dated])).toEqual([['TB', false], ['TE', false], ['T1', true]]);
  });
  test('an extra with an unparseable time is undated', () => {
    const s = summarizeSession(session(), [tool('i1', 0, null, { agentId: 'ag', timestamp: 'nope' })]);
    expect(s.extras[0]!.dated).toBe(false);
    expect(Number.isNaN(s.calls[0]!.atMs)).toBe(true);
  });
});
