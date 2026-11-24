import { describe, expect, test } from 'vitest';
import type { Graph, GraphNode, NodeKind, Origin, Session } from '@agent-canvas/shared';
import { computeAgentTimeline, sortThreads, type AgentTimeline, type ThreadTime } from '../src/canvas/agentTime';
import { snapshotClock, waterfallClock, type WaterfallClock } from '../src/canvas/waterfall';

// Invented sessions only. Times are milliseconds after EPOCH; expected values are stated by hand next to each case.

const EPOCH = Date.parse('2026-01-01T00:00:00Z');
const iso = (t: number): string => new Date(EPOCH + t).toISOString();

function node(id: string, kind: NodeKind, turnId: string | null, agentId: string | null, t: number, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id, sessionId: 's1', turnId, agentId, childAgentId: null, endedAt: null, parentId: null, kind, status: null,
    timestamp: iso(t), confirmed: true, title: kind, summary: '', toolName: null,
    toolUseId: null, messageId: null, durationMs: null, usage: null, systemSubtype: null, ...extra,
  };
}
const prompt = (id: string, turn: string | null, t: number, agent: string | null = null): GraphNode => node(id, 'prompt', turn, agent, t);
const text = (id: string, turn: string | null, t: number, extra: Partial<GraphNode> = {}): GraphNode => node(id, 'text', turn, null, t, extra);
/** A tool step from `from` to `to` (null: still running). */
function tool(id: string, turn: string | null, agent: string | null, from: number, to: number | null, extra: Partial<GraphNode> = {}): GraphNode {
  return node(id, 'tool', turn, agent, from, {
    title: 'Bash', toolName: 'Bash', status: to === null ? 'running' : 'succeeded', endedAt: to === null ? null : iso(to),
    durationMs: to === null ? null : to - from, ...extra,
  });
}
/** A subagent dispatch from `from` to `to` (null: still running) of agent `child` (null: not known yet). */
function dispatch(
  id: string, turn: string | null, agent: string | null, child: string | null, from: number, to: number | null, extra: Partial<GraphNode> = {},
): GraphNode {
  return node(id, 'subagent', turn, agent, from, {
    title: 'Agent', toolName: 'Task', childAgentId: child, status: to === null ? 'running' : 'succeeded',
    endedAt: to === null ? null : iso(to), durationMs: to === null ? null : to - from, ...extra,
  });
}
function graph(nodes: GraphNode[]): Graph {
  return { nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), edges: {} };
}
const ended = (t: number): WaterfallClock => ({ nowMs: EPOCH + t, ticking: false, backgroundNowMs: EPOCH + t, backgroundTicking: false });
const session = (origin: Origin = 'claude'): Pick<Session, 'origin' | 'status' | 'lastActivityAt'> => ({ origin, status: 'idle', lastActivityAt: iso(0) });

function timeline(g: Graph, origin: Origin = 'claude', clock: WaterfallClock = ended(10_000_000)): AgentTimeline {
  const r = computeAgentTimeline(g, session(origin), clock);
  if (!r.available) throw new Error('expected a timeline');
  return r;
}
function flatten(t: ThreadTime): ThreadTime[] {
  return [t, ...t.children.flatMap(flatten)];
}
function thread(tl: AgentTimeline, id: string): ThreadTime {
  const found = flatten(tl.root).find((t) => t.id === id);
  if (!found) throw new Error(`no thread ${id}`);
  return found;
}
/** Spans as [start, end] relative to EPOCH. */
const rel = (spans: { startMs: number; endMs: number }[]): [number, number][] => spans.map((s) => [s.startMs - EPOCH, s.endMs - EPOCH]);
function expectInvariant(tl: AgentTimeline): void {
  const agents = flatten(tl.root).filter((t) => t.id !== 'main');
  expect(agents.reduce((s, t) => s + t.waitMs, 0) + tl.mainOwnMs).toBe(tl.totalMs);
  expect(tl.mainOwnMs + tl.mainWaitMs).toBe(tl.totalMs);
  expect(tl.root.waitingSpans.reduce((s, x) => s + x.endMs - x.startMs, 0)).toBe(tl.mainWaitMs);
}

describe('attribution (spec 3.3)', () => {
  test('the main thread working in parallel with a dispatch is not waiting', () => {
    // d1 waits for A from 1000 to 9000; a tool of the same message runs 1000-4000, so the main thread is busy until 4000.
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('d1', 't1', null, 'A', 1000, 9000, { messageId: 'm1' }),
      tool('par', 't1', null, 1000, 4000, { messageId: 'm1' }),
      tool('a1', null, 'A', 1100, 8900),
      text('x', 't1', 9500, { messageId: 'm2' }),
    ]));
    expect(tl.totalMs).toBe(9500);
    expect(thread(tl, 'A').waitMs).toBe(5000); // 4000-9000
    expect(tl.mainOwnMs).toBe(4500); // 0-4000, 9000-9500
    expectInvariant(tl);
  });

  test('parallel agents: the moment goes to the one ending last; each keeps its own time, together more than the total', () => {
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('d1', 't1', null, 'A', 1000, 5000, { messageId: 'm1' }),
      dispatch('d2', 't1', null, 'B', 1000, 8000, { messageId: 'm1' }),
      tool('a1', null, 'A', 1100, 4900),
      tool('b1', null, 'B', 1100, 7900),
      text('x', 't1', 8500, { messageId: 'm2' }),
    ]));
    expect(tl.totalMs).toBe(8500);
    expect(thread(tl, 'B').waitMs).toBe(7000);
    expect(thread(tl, 'A').waitMs).toBe(0);
    expect(thread(tl, 'A').ownMs).toBe(4000);
    expect(thread(tl, 'B').ownMs).toBe(7000);
    expect(thread(tl, 'A').ownMs + thread(tl, 'B').ownMs).toBeGreaterThan(tl.totalMs);
    expect(tl.longestWaitId).toBe('B');
    expectInvariant(tl);
  });

  test('parallel agents ending together: the smaller id takes the moment', () => {
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('d1', 't1', null, 'b-agent', 1000, 5000, { messageId: 'm1' }),
      dispatch('d2', 't1', null, 'a-agent', 1000, 5000, { messageId: 'm1' }),
      text('x', 't1', 6000, { messageId: 'm2' }),
    ]));
    expect(thread(tl, 'a-agent').waitMs).toBe(4000);
    expect(thread(tl, 'b-agent').waitMs).toBe(0);
    expectInvariant(tl);
  });

  test('nested agents: the moment goes to the deepest one', () => {
    // main waits on A 1000-9000; A waits on B 2000-7000.
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('d1', 't1', null, 'A', 1000, 9000, { messageId: 'm1' }),
      prompt('ap', null, 1100, 'A'),
      dispatch('dA', null, 'A', 'B', 2000, 7000, { messageId: 'am1' }),
      tool('b1', null, 'B', 2100, 6900),
      text('at', null, 7500, { agentId: 'A', messageId: 'am2' }),
      text('x', 't1', 9500, { messageId: 'm2' }),
    ]));
    expect(thread(tl, 'B').waitMs).toBe(5000);
    expect(thread(tl, 'A').waitMs).toBe(3000); // 1000-2000, 7000-9000
    expect(tl.mainOwnMs).toBe(1500);
    expect(thread(tl, 'B').parentId).toBe('A');
    expect(thread(tl, 'A').children.map((c) => c.id)).toEqual(['B']);
    expect(rel(thread(tl, 'A').waitingSpans)).toEqual([[2000, 7000]]);
    expect(rel(tl.root.waitingSpans)).toEqual([[1000, 9000]]);
    expectInvariant(tl);
  });
});

describe('blocking by origin (spec 3.1, Background detection)', () => {
  test('Claude foreground dispatch: blocks for its whole interval', () => {
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('d1', 't1', null, 'A', 1000, 9000, { messageId: 'm1', title: 'Explore' }),
      prompt('ap', null, 1100, 'A'),
      tool('a1', null, 'A', 1200, 8000),
      text('x', 't1', 9500, { messageId: 'm2' }),
    ]));
    expect(tl.totalMs).toBe(9500);
    expect(thread(tl, 'A').waitMs).toBe(8000);
    expect(tl.mainOwnMs).toBe(1500);
    expect(tl.mainWaitMs).toBe(8000);
    expect(rel(thread(tl, 'A').segments)).toEqual([[1000, 9000]]); // to the dispatch's end (its result)
    expect(thread(tl, 'A').ownMs).toBe(8000);
    expect(thread(tl, 'A').label).toBe('Explore');
    expect(thread(tl, 'A').dispatchIds).toEqual(['d1']);
    expect(thread(tl, 'A').steps).toBe(2);
    expectInvariant(tl);
  });

  test('Claude background agent running past the final reply: zero wait, bar to its end, own time counted, total unchanged (Review Focus 1)', () => {
    // The launch answer comes back at once; the next message's thinking began right then (its duration reaches back to
    // 1000), so the main thread carried on at 1000. The agent runs until 60000, long after the final reply at 6000.
    const base = [
      prompt('p1', 't1', 0),
      node('th', 'thinking', 't1', null, 3000, { durationMs: 2000, messageId: 'm2' }),
      tool('t', 't1', null, 3000, 5000, { messageId: 'm2' }),
      text('reply', 't1', 6000, { messageId: 'm3' }),
    ];
    const withAgent = [
      ...base,
      dispatch('d1', 't1', null, 'bg', 1000, 60_000, { messageId: 'm1', title: 'Watcher' }),
      prompt('bp', null, 1100, 'bg'),
      tool('b1', null, 'bg', 1200, 50_000),
      node('b2', 'text', null, 'bg', 60_000),
    ];
    const tl = timeline(graph(withAgent));
    const bg = thread(tl, 'bg');
    expect(bg.waitMs).toBe(0);
    expect(rel(bg.segments)).toEqual([[1000, 60_000]]);
    expect(bg.ownMs).toBe(59_000);
    expect(tl.totalMs).toBe(6000);
    expect(timeline(graph(base)).totalMs).toBe(6000);
    expect(tl.axis.endMs - EPOCH).toBe(60_000);
    expect(tl.longestWaitId).toBeNull();
    expectInvariant(tl);
  });

  test('a dispatch blocks only until its parent carries on with another message (the gap before that counts as waiting)', () => {
    // Background launch at 1000; the main thread's next message starts at 2500 (no thinking duration to reach back).
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('d1', 't1', null, 'bg', 1000, 60_000, { messageId: 'm1' }),
      tool('b1', null, 'bg', 1200, 59_000),
      text('reply', 't1', 2500, { messageId: 'm2' }),
    ]));
    expect(thread(tl, 'bg').waitMs).toBe(1500);
    expect(tl.totalMs).toBe(2500);
    expectInvariant(tl);
  });

  test('the background flag is not read from the input: a dispatch its parent does not move past blocks to its end', () => {
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('d1', 't1', null, 'A', 1000, 9000, { messageId: 'm1', summary: '{"description":"long task","prompt":"a very long prompt…' }),
      text('x', 't1', 9500, { messageId: 'm2' }),
    ]));
    expect(thread(tl, 'A').waitMs).toBe(8000);
    expectInvariant(tl);
  });

  test('a background launch stops blocking at a foreground dispatch of the next message, which then holds the main thread (review round 1)', () => {
    // The shape the Claude normaliser gives: message m1 launches agB in the background (its dispatch stays open until
    // agB ends at 60000); message m2 is only a foreground dispatch of agA (no text or thinking before it).
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('dB', 't1', null, 'agB', 1000, 60_000, { messageId: 'm1', title: 'Watcher' }),
      tool('b1', null, 'agB', 1100, 60_000),
      dispatch('dA', 't1', null, 'agA', 2000, 9500, { messageId: 'm2', title: 'Explore' }),
      tool('a1', null, 'agA', 4000, 9000),
      text('reply', 't1', 10_000, { messageId: 'm3' }),
    ]));
    expect(tl.totalMs).toBe(10_000);
    expect(thread(tl, 'agB').waitMs).toBe(1000); // only 1000-2000, the gap before the next message
    expect(thread(tl, 'agA').waitMs).toBe(7500); // 2000-9500
    expect(tl.mainOwnMs).toBe(1500);
    expect(tl.longestWaitId).toBe('agA');
    expectInvariant(tl);
  });

  test('parallel dispatches of one message still wait together (the later one does not cut the earlier)', () => {
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('d1', 't1', null, 'A', 1000, 8000, { messageId: 'm1' }),
      dispatch('d2', 't1', null, 'B', 1002, 5000, { messageId: 'm1' }),
      text('x', 't1', 8500, { messageId: 'm2' }),
    ]));
    expect(thread(tl, 'A').waitMs).toBe(7000);
    expect(thread(tl, 'B').waitMs).toBe(0);
    expectInvariant(tl);
  });

  test('Cursor (no message ids): calls of one batch share their parent; a step with another parent carries on, and the idle time after it still waits', () => {
    // Cursor batches parallel calls under one parent (cursor.ts), at slightly different times.
    const batch = timeline(graph([
      prompt('p1', 't1', 0),
      node('th', 'thinking', 't1', null, 900, { parentId: 'p1' }),
      dispatch('d1', 't1', null, 'A', 1000, 6000, { parentId: 'th' }),
      tool('par', 't1', null, 1005, 3000, { parentId: 'th' }),
      text('x', 't1', 6500, { parentId: 'par' }),
    ]), 'cursor');
    expect(thread(batch, 'A').waitMs).toBe(3005); // 1000-1005 and 3000-6000: the parallel call kept the main thread busy between
    expect(batch.mainOwnMs).toBe(3495);
    expectInvariant(batch);
    const later = timeline(graph([
      prompt('p1', 't1', 0),
      node('th', 'thinking', 't1', null, 900, { parentId: 'p1' }),
      dispatch('d1', 't1', null, 'A', 1000, 6000, { parentId: 'th' }),
      tool('next', 't1', null, 1001, 3000, { parentId: 'd1' }),
      text('x', 't1', 6500, { parentId: 'next' }),
    ]), 'cursor');
    // 1000-1001 before the next step; then the main thread works to 3000 and sits idle until A ends at 6000 (resume block).
    expect(thread(later, 'A').waitMs).toBe(3001);
    expect(later.mainOwnMs).toBe(3499); // 0-1000, 1001-3000, 6000-6500
    expectInvariant(later);
  });

  test('Grok (no message ids, every node chained to the one before): a call right after a dispatch carries on; once it ends, the wait resumes', () => {
    // Grok gives no batch marker (grok.ts parentOf: always the previous node), so a call issued with the dispatch cannot
    // be told from the next message: it cuts the block at 1200. When the call ends at 3000 the main thread sits idle
    // until A ends at 6000, which waits on A again (the resume block).
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('d1', 't1', null, 'A', 1000, 6000, { parentId: 'p1' }),
      tool('c2', 't1', null, 1200, 3000, { parentId: 'd1' }),
      text('x', 't1', 6500, { parentId: 'c2' }),
    ]), 'grok');
    expect(thread(tl, 'A').waitMs).toBe(3200); // 1000-1200, 3000-6000
    expect(tl.mainOwnMs).toBe(3300); // 0-1000, 1200-3000, 6000-6500
    expectInvariant(tl);
  });

  test('Grok parallel dispatches (each chained to the one before): the one ending last takes the wait', () => {
    // d2 is recorded 1 ms after d1 and chained to it, so it cuts d1's first block at 1001; d1 then blocks again from
    // 1001 (the main thread did nothing else) to A's end, and that block ends last.
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('d1', 't1', null, 'A', 1000, 9000, { parentId: 'p1' }),
      dispatch('d2', 't1', null, 'B', 1001, 5000, { parentId: 'd1' }),
      tool('a1', null, 'A', 1100, 8900),
      tool('b1', null, 'B', 1100, 4900),
      text('x', 't1', 9500, { parentId: 'd2' }),
    ]), 'grok');
    expect(tl.totalMs).toBe(9500);
    expect(thread(tl, 'A').waitMs).toBe(8000); // 1000-9000
    expect(thread(tl, 'B').waitMs).toBe(0); // B ends at 5000, inside A's wait
    expect(tl.mainOwnMs).toBe(1500); // 0-1000, 9000-9500
    expect(tl.longestWaitId).toBe('A');
    expectInvariant(tl);
  });

  test('a main-thread system notice during a foreground wait no longer ends it (Qwen / Cursor completion notices)', () => {
    // Qwen / Cursor record another agent's completion as a main-thread system node; one at 3000 cuts A's block (a later
    // step of another message), but the main thread did nothing after it, so 3000-9000 waits on A again.
    for (const origin of ['qwen', 'cursor'] as const) {
      const tl = timeline(graph([
        prompt('p1', 't1', 0),
        dispatch('d1', 't1', null, 'A', 1000, 9000, { messageId: origin === 'qwen' ? 'm1' : null, parentId: 'p1' }),
        tool('a1', null, 'A', 1100, 8900),
        node('notice', 'system', 't1', null, 3000, { parentId: 'd1', title: 'notice' }),
        text('x', 't1', 9500, { messageId: origin === 'qwen' ? 'm2' : null, parentId: 'notice' }),
      ]), origin);
      expect(thread(tl, 'A').waitMs).toBe(8000); // 1000-9000
      expect(tl.mainOwnMs).toBe(1500); // 0-1000, 9000-9500
      expectInvariant(tl);
    }
  });

  test('Claude background agents woken back by their notices: the idle main thread waits on each until it ends (final review, Important 1)', () => {
    // Prompt at 0; one message launches three background agents at 2000; the main thread replies "launched, will
    // report" at 4000 and stops. The agents end at 200000 (fast), 400000 (mid), 600000 (slow); each notice wakes the main
    // thread (205000, 405000, 620000), all in the same turn.
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('dF', 't1', null, 'fast', 2000, 200_000, { messageId: 'm1', title: 'Fast audit' }),
      dispatch('dM', 't1', null, 'mid', 2000, 400_000, { messageId: 'm1', title: 'Mid audit' }),
      dispatch('dS', 't1', null, 'slow', 2000, 600_000, { messageId: 'm1', title: 'Slow audit' }),
      prompt('fp', null, 2100, 'fast'), tool('f1', null, 'fast', 2200, 200_000),
      prompt('mp', null, 2100, 'mid'), tool('m1t', null, 'mid', 2200, 400_000),
      prompt('sp', null, 2100, 'slow'), tool('s1', null, 'slow', 2200, 600_000),
      text('launched', 't1', 4000, { messageId: 'm2' }),
      text('woke1', 't1', 205_000, { messageId: 'm3' }),
      text('woke2', 't1', 405_000, { messageId: 'm4' }),
      text('woke3', 't1', 620_000, { messageId: 'm5' }),
    ]));
    expect(tl.turns).toBe(1);
    expect(tl.totalMs).toBe(620_000);
    // 2000-4000: all three launches block until the reply; the one ending last, slow, holds it. Then the main thread
    // is idle: 4000-200000 waits on fast; 205000-400000 on mid; 405000-600000 on slow. The 5 s / 5 s / 20 s after each
    // notice are the main thread's own.
    expect(thread(tl, 'fast').waitMs).toBe(196_000); // 4000-200000
    expect(thread(tl, 'mid').waitMs).toBe(195_000); // 205000-400000
    expect(thread(tl, 'slow').waitMs).toBe(197_000); // 2000-4000, 405000-600000
    expect(tl.mainOwnMs).toBe(32_000); // 0-2000, 200000-205000, 400000-405000, 600000-620000
    expect(tl.mainWaitMs).toBe(588_000);
    expect(rel(tl.root.waitingSpans)).toEqual([[2000, 200_000], [205_000, 400_000], [405_000, 600_000]]);
    expect(tl.longestWaitId).toBe('slow');
    expect(thread(tl, 'slow').ownMs).toBe(598_000);
    expectInvariant(tl);
  });

  test('an agent that launched a background agent of its own: its row shows the idle wait inside its bar; numbers unchanged', () => {
    // X (foreground, 1000-5000) launches Y in the background at 1500, carries on at 2000, last works at 4900 and is done
    // at 5000; Y runs to 9000. X's bar runs to Y's end (its dispatch is its last step); from 4900 X sits idle waiting on
    // Y (drawn light). Main is waited on by X only until 5000, so only 4900-5000 of that reaches Y.
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('dX', 't1', null, 'X', 1000, 5000, { messageId: 'm1' }),
      dispatch('dY', null, 'X', 'Y', 1500, 9000, { messageId: 'xm1' }),
      text('x1', null, 2000, { agentId: 'X', messageId: 'xm2' }),
      text('x2', null, 4900, { agentId: 'X', messageId: 'xm3' }),
      tool('y1', null, 'Y', 1600, 9000),
      text('reply', 't1', 5500, { messageId: 'm2' }),
    ]));
    expect(rel(thread(tl, 'X').waitingSpans)).toEqual([[1500, 2000], [4900, 9000]]);
    expect(thread(tl, 'Y').waitMs).toBe(600); // 1500-2000, 4900-5000
    expect(thread(tl, 'X').waitMs).toBe(3400); // the rest of 1000-5000
    expect(tl.mainOwnMs).toBe(1500); // 0-1000, 5000-5500
    expectInvariant(tl);
  });

  test('a background agent outliving turn 1 leaves turn 2 alone; one ending while the main thread works waits on nothing', () => {
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('d1', 't1', null, 'bg', 1000, 50_000, { messageId: 'm1' }),
      tool('b1', null, 'bg', 1100, 50_000),
      text('reply', 't1', 2000, { messageId: 'm2' }),
      prompt('p2', 't2', 100_000),
      dispatch('d2', 't2', null, 'bg2', 100_200, 150_000, { messageId: 'm3' }),
      tool('c1', null, 'bg2', 100_300, 150_000),
      tool('work', 't2', null, 100_500, 160_000, { messageId: 'm4' }),
      text('x2', 't2', 161_000, { messageId: 'm5' }),
    ]));
    // Turn 1 [0, 2000]: the idle 2000-50000 lies after its end, so nobody's wait. Turn 2 [100000, 161000]: bg2 blocks
    // 100200-100500 (until the main thread's next message), and the main thread is at work when bg2 ends.
    expect(tl.totalMs).toBe(63_000);
    expect(thread(tl, 'bg').waitMs).toBe(1000); // 1000-2000
    expect(thread(tl, 'bg2').waitMs).toBe(300); // 100200-100500
    expect(tl.mainOwnMs).toBe(61_700);
    expectInvariant(tl);
  });

  test('Gemini / Qwen / WorkBuddy / CodeBuddy foreground dispatch behaves like Claude foreground', () => {
    for (const origin of ['gemini', 'qwen', 'workbuddy', 'codebuddy'] as const) {
      const tl = timeline(graph([
        prompt('p1', 't1', 0),
        dispatch('d1', 't1', null, 'A', 1000, 9000, { messageId: 'm1' }),
        text('x', 't1', 9500, { messageId: 'm2' }),
      ]), origin);
      expect(thread(tl, 'A').waitMs).toBe(8000);
    }
  });

  test('Codex spawn_agent never blocks', () => {
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('d1', 't1', null, 'thr-a', 1000, 20_000, { title: 'helper', summary: 'helper', toolName: 'collaboration.spawn_agent' }),
      tool('a1', null, 'thr-a', 1500, 19_000),
      tool('m1', 't1', null, 2000, 3000, { toolName: 'exec', title: 'exec' }),
      text('x', 't1', 4000),
    ]), 'codex');
    expect(tl.totalMs).toBe(4000);
    expect(thread(tl, 'thr-a').waitMs).toBe(0);
    expect(tl.mainOwnMs).toBe(4000);
    expect(thread(tl, 'thr-a').ownMs).toBe(19_000);
    expectInvariant(tl);
  });

  test('Codex wait_agent on one agent, named by thread id: the wait goes to it', () => {
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('d1', 't1', null, 'thr-a', 1000, 8500, { title: 'helper', summary: 'helper', toolName: 'collaboration.spawn_agent' }),
      tool('a1', null, 'thr-a', 1500, 8500),
      tool('w', 't1', null, 2000, 9000, { toolName: 'collaboration.wait_agent', title: 'collaboration.wait_agent', summary: '{"ids":["thr-a"],"timeout_ms":30000}' }),
      text('x', 't1', 9500),
    ]), 'codex');
    expect(tl.totalMs).toBe(9500);
    expect(thread(tl, 'thr-a').waitMs).toBe(7000);
    expect(tl.mainOwnMs).toBe(2500);
    expectInvariant(tl);
  });

  test('Codex wait_agent whose input names no known agent: it waits on the parent\'s children active then', () => {
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('d1', 't1', null, 'thr-a', 1000, 6000, { title: 'alpha', summary: 'alpha', toolName: 'spawn_agent' }),
      dispatch('d2', 't1', null, 'thr-b', 1000, 1500, { title: 'beta', summary: 'beta', toolName: 'spawn_agent' }),
      tool('a1', null, 'thr-a', 1100, 6000),
      tool('b1', null, 'thr-b', 1100, 1500),
      tool('w', 't1', null, 2000, 7000, { toolName: 'wait_agent', title: 'wait_agent', summary: '{"timeout_ms":60000}' }),
      text('x', 't1', 7500),
    ]), 'codex');
    expect(thread(tl, 'thr-a').waitMs).toBe(5000);
    expect(thread(tl, 'thr-b').waitMs).toBe(0);
    expectInvariant(tl);
  });

  test('Codex: spawn two, main works, wait on both, follow up one later (Review Focus 3)', () => {
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('da', 't1', null, 'thr-a', 1000, 25_500, { title: 'alpha', summary: 'alpha', toolName: 'collaboration.spawn_agent' }),
      dispatch('db', 't1', null, 'thr-b', 1100, 11_800, { title: 'beta', summary: 'beta', toolName: 'collaboration.spawn_agent' }),
      tool('work', 't1', null, 1200, 5000, { toolName: 'exec', title: 'exec' }),
      tool('w1', 't1', null, 5000, 12_000, { toolName: 'collaboration.wait_agent', title: 'collaboration.wait_agent', summary: '{"targets":["/root/alpha","/root/beta"]}' }),
      tool('a1', null, 'thr-a', 1050, 8000),
      tool('b1', null, 'thr-b', 1150, 11_800),
      text('x1', 't1', 12_500),
      prompt('p2', 't2', 20_000),
      tool('fu', 't2', null, 20_100, 20_100, { toolName: 'collaboration.followup_task', title: 'collaboration.followup_task', summary: '{"target":"alpha","message":"one more"}' }),
      tool('w2', 't2', null, 20_200, 26_000, { toolName: 'collaboration.wait_agent', title: 'collaboration.wait_agent', summary: '{"targets":["alpha"]}' }),
      tool('a2', null, 'thr-a', 20_300, 25_500),
      text('x2', 't2', 26_500),
    ]), 'codex');
    // Turns [0, 12500] and [20000, 26500].
    expect(tl.totalMs).toBe(19_000);
    expect(tl.turns).toBe(2);
    expect(tl.turnSpans.map((t) => [t.turnKey, t.startMs - EPOCH, t.endMs - EPOCH])).toEqual([['t1', 0, 12_500], ['t2', 20_000, 26_500]]);
    expect(thread(tl, 'thr-b').waitMs).toBe(7000); // all of w1: beta ends last (11800 > 8000)
    expect(thread(tl, 'thr-a').waitMs).toBe(5800); // w2
    expect(tl.mainOwnMs).toBe(6200); // nothing during the main thread's own work 1200-5000
    const a = thread(tl, 'thr-a');
    expect(rel(a.segments)).toEqual([[1000, 8000], [20_100, 25_500]]);
    expect(a.ownMs).toBe(12_400); // the idle 8000-20100 is not counted
    expect(a.dispatchIds).toEqual(['da', 'fu']);
    expect(thread(tl, 'thr-b').ownMs).toBe(10_700);
    expectInvariant(tl);
  });
});

describe('total (spec 3.2)', () => {
  test('the gap between turns is not counted, and a long quiet gap becomes a break on the axis', () => {
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      tool('a', 't1', null, 1000, 5000),
      prompt('p2', 't2', 1_000_000),
      text('x', 't2', 1_003_000),
    ]));
    expect(tl.totalMs).toBe(8000);
    expect(tl.turns).toBe(2);
    expect(rel(tl.axis.breaks)).toEqual([[5000, 1_000_000]]);
    expect(rel([tl.axis])).toEqual([[0, 1_003_000]]);
    expect(rel(tl.root.segments)).toEqual([[0, 5000], [1_000_000, 1_003_000]]);
  });

  test('a gap of five minutes or less, or one with an agent at work, is not a break', () => {
    const short = timeline(graph([prompt('p1', 't1', 0), text('x', 't1', 1000), prompt('p2', 't2', 301_000)]));
    expect(short.axis.breaks).toEqual([]);
    const busy = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('d1', 't1', null, 'bg', 1000, 2_000_000, { messageId: 'm1' }),
      tool('b1', null, 'bg', 1100, 500_000),
      tool('b2', null, 'bg', 1_500_000, 2_000_000),
      text('x', 't1', 1000, { messageId: 'm2' }),
      prompt('p2', 't2', 3_000_000),
      text('y', 't2', 3_001_000, { messageId: 'm3' }),
    ]));
    // Turn 1 ends at 1000; the agent's segment [1000, 2000000] covers the gap until 2000000; the rest is a break.
    expect(rel(busy.axis.breaks)).toEqual([[2_000_000, 3_000_000]]);
  });

  test('a turn that is only a prompt: in turnSpans, but no zero-length piece in the total, and no break ends at it', () => {
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      text('x', 't1', 1000),
      prompt('p2', 't2', 2_000_000),
      prompt('p3', 't3', 3_000_000),
      text('y', 't3', 3_001_000),
    ]));
    expect(tl.turns).toBe(3);
    expect(tl.turnSpans.map((t) => [t.turnKey, t.startMs - EPOCH, t.endMs - EPOCH])).toEqual([
      ['t1', 0, 1000], ['t2', 2_000_000, 2_000_000], ['t3', 3_000_000, 3_001_000],
    ]);
    expect(tl.totalMs).toBe(2000);
    expect(rel(tl.root.segments)).toEqual([[0, 1000], [3_000_000, 3_001_000]]);
    expect(rel(tl.axis.breaks)).toEqual([[1000, 3_000_000]]);
  });

  test('a session that is one prompt so far: total 0, the axis at the prompt', () => {
    const tl = timeline(graph([prompt('p1', 't1', 5000)]));
    expect(tl.totalMs).toBe(0);
    expect(tl.root.segments).toEqual([]);
    expect(rel([tl.axis])).toEqual([[5000, 5001]]);
  });

  test('a turn in progress runs to now', () => {
    const clock: WaterfallClock = { nowMs: EPOCH + 20_000, ticking: true, backgroundNowMs: EPOCH + 20_000, backgroundTicking: true };
    const tl = timeline(graph([prompt('p1', 't1', 10_000), tool('a', 't1', null, 11_000, 12_000)]), 'claude', clock);
    expect(tl.totalMs).toBe(10_000);
    expect(tl.root.open).toBe(true);
  });

  test('turns overlapping because of background work are counted once (Review Focus 2)', () => {
    // A background shell started in turn 1 runs until 15000, into turn 2 (prompt at 10000); turn 2 waits on A 16000-20000.
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      tool('bash', 't1', null, 1000, 15_000, { messageId: 'm1' }),
      text('x1', 't1', 2000, { messageId: 'm2' }),
      prompt('p2', 't2', 10_000),
      dispatch('d2', 't2', null, 'A', 16_000, 20_000, { messageId: 'm3' }),
      tool('a1', null, 'A', 16_100, 19_900),
      text('x2', 't2', 21_000, { messageId: 'm4' }),
    ]));
    // [0, 15000] ∪ [10000, 21000] = [0, 21000] (the turns added up would be 26000).
    expect(tl.totalMs).toBe(21_000);
    expect(thread(tl, 'A').waitMs).toBe(4000);
    expect(tl.mainOwnMs).toBe(17_000);
    expectInvariant(tl);
  });
});

describe('own time (spec 3.3)', () => {
  test('a Claude agent dispatched twice: one row, its segments added up, the idle time between them left out', () => {
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('d1', 't1', null, 'X', 1000, 5000, { messageId: 'm1', title: 'Helper' }),
      tool('x1', null, 'X', 1100, 4900),
      text('r1', 't1', 5500, { messageId: 'm2' }),
      prompt('p2', 't2', 20_000),
      dispatch('d2', 't2', null, 'X', 20_000, 26_000, { messageId: 'm3', title: 'Helper' }),
      tool('x2', null, 'X', 20_100, 25_900),
      text('r2', 't2', 26_500, { messageId: 'm4' }),
    ]));
    const x = thread(tl, 'X');
    expect(tl.root.children.map((c) => c.id)).toEqual(['X']);
    expect(rel(x.segments)).toEqual([[1000, 5000], [20_000, 26_000]]);
    expect(x.ownMs).toBe(10_000);
    expect(x.dispatchIds).toEqual(['d1', 'd2']);
    expect(x.waitMs).toBe(10_000);
    expect(x.label).toBe('Helper');
    expectInvariant(tl);
  });

  test('one agent dispatched twice at once: one segment, to the later of the two dispatches\' ends', () => {
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('d1', 't1', null, 'X', 1000, 6000, { messageId: 'm1' }),
      dispatch('d2', 't1', null, 'X', 1000, 4000, { messageId: 'm1' }),
      tool('x1', null, 'X', 1100, 5000),
      text('r', 't1', 7000, { messageId: 'm2' }),
    ]));
    const x = thread(tl, 'X');
    expect(rel(x.segments)).toEqual([[1000, 6000]]);
    expect(x.ownMs).toBe(5000);
    expect(x.waitMs).toBe(5000);
    expectInvariant(tl);
  });
});

describe('Doubao', () => {
  test('no per-step times: no timeline', () => {
    const g = graph([prompt('p1', 't1', 0), text('x', 't1', 0)]);
    expect(computeAgentTimeline(g, session('doubao'), ended(0))).toEqual({ available: false, reason: 'no-times' });
  });
});

describe('clock (Review Focus 4)', () => {
  const g = graph([
    prompt('p1', 't1', 0),
    dispatch('d1', 't1', null, 'A', 1000, null, { messageId: 'm1' }),
    tool('a1', null, 'A', 1100, null),
  ]);
  const at = (status: Session['status'], last: number, now: number): AgentTimeline => {
    const s = { origin: 'claude' as const, status, lastActivityAt: iso(last) };
    const r = computeAgentTimeline(g, s, waterfallClock(s, EPOCH + now));
    if (!r.available) throw new Error('expected a timeline');
    return r;
  };

  test('a running session grows with the clock', () => {
    const t10 = at('running', 5000, 10_000);
    expect(t10.totalMs).toBe(10_000);
    expect(thread(t10, 'A').waitMs).toBe(9000);
    expect(rel(thread(t10, 'A').segments)).toEqual([[1000, 10_000]]);
    expect(thread(t10, 'A').open).toBe(true);
    expect(t10.root.open).toBe(true);
    const t20 = at('running', 5000, 20_000);
    expect(t20.totalMs).toBe(20_000);
    expect(thread(t20, 'A').waitMs).toBe(19_000);
    expectInvariant(t20);
  });

  test('an idle session stops: the totals stay at its last activity, while its background agent is still drawn going on for a while', () => {
    const early = at('idle', 12_000, 100_000);
    const later = at('idle', 12_000, 200_000);
    expect(early.totalMs).toBe(12_000);
    expect(later.totalMs).toBe(12_000);
    expect(thread(later, 'A').waitMs).toBe(11_000);
    expect(early.root.open).toBe(false);
    // Background work keeps ticking for QUIET_AFTER_MS after the last activity (waterfallClock).
    expect(rel(thread(early, 'A').segments)).toEqual([[1000, 100_000]]);
    expect(thread(early, 'A').open).toBe(true);
    const quiet = at('idle', 12_000, 12_000 + 400_000);
    expect(rel(thread(quiet, 'A').segments)).toEqual([[1000, 12_000]]);
    expect(thread(quiet, 'A').open).toBe(false);
    expect(quiet.totalMs).toBe(12_000);
  });

  test('a snapshot never grows', () => {
    const s = { origin: 'claude' as const, status: 'running' as const, lastActivityAt: iso(7000) };
    const r = computeAgentTimeline(g, s, snapshotClock(s));
    if (!r.available) throw new Error('expected a timeline');
    expect(r.totalMs).toBe(7000);
    expect(thread(r, 'A').waitMs).toBe(6000);
    expect(rel(thread(r, 'A').segments)).toEqual([[1000, 7000]]);
    expect(thread(r, 'A').open).toBe(false);
    expect(r.root.open).toBe(false);
  });
});

describe('missing data (spec 3.1, 3.6)', () => {
  test('a dispatch without an end time that is not running ends with its agent\'s last step', () => {
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('d1', 't1', null, 'A', 1000, null, { messageId: 'm1', status: 'succeeded' }),
      tool('a1', null, 'A', 1100, 6000),
      text('x', 't1', 7000, { messageId: 'm2' }),
    ]));
    expect(thread(tl, 'A').waitMs).toBe(5000);
    expect(tl.totalMs).toBe(7000);
    expectInvariant(tl);
  });

  test('… and is a moment when its agent is not known either', () => {
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('d1', 't1', null, null, 1000, null, { messageId: 'm1', status: 'failed' }),
      text('x', 't1', 7000, { messageId: 'm2' }),
    ]));
    expect(thread(tl, 'unmatched:d1').waitMs).toBe(0);
    expect(rel(thread(tl, 'unmatched:d1').segments)).toEqual([[1000, 1000]]);
    expect(tl.totalMs).toBe(7000);
    expectInvariant(tl);
  });

  test('an agent with no steps yet: its row runs with its dispatch', () => {
    const clock: WaterfallClock = { nowMs: EPOCH + 9000, ticking: true, backgroundNowMs: EPOCH + 9000, backgroundTicking: true };
    const tl = timeline(graph([prompt('p1', 't1', 0), dispatch('d1', 't1', null, 'A', 1000, null, { messageId: 'm1' })]), 'claude', clock);
    const a = thread(tl, 'A');
    expect(a.steps).toBe(0);
    expect(rel(a.segments)).toEqual([[1000, 9000]]);
    expect(a.waitMs).toBe(8000);
    expect(a.open).toBe(true);
    expectInvariant(tl);
  });

  test('a step whose time cannot be read sits at the earliest time of its turn / agent and does not stretch the axis', () => {
    const tl = timeline(graph([
      prompt('p1', 't1', 1000),
      node('bad', 'text', 't1', null, 0, { timestamp: 'not a time' }),
      dispatch('d1', 't1', null, 'A', 2000, 5000, { messageId: 'm1' }),
      tool('a1', null, 'A', 2100, 4000),
      node('badA', 'tool', null, 'A', 0, { timestamp: 'garbage', status: 'succeeded', durationMs: 100 }),
      text('x', 't1', 6000, { messageId: 'm2' }),
    ]));
    expect(tl.axis.startMs - EPOCH).toBe(1000);
    expect(tl.totalMs).toBe(5000);
    expect(thread(tl, 'A').waitMs).toBe(3000);
    expect(thread(tl, 'A').steps).toBe(2);
    expectInvariant(tl);
  });

  test("a dispatch whose time cannot be read is placed (and ordered) at its turn's start, as the waterfall does (review round 1)", () => {
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      text('x1', 't1', 1000, { messageId: 'm1' }),
      prompt('p2', 't2', 10_000),
      dispatch('d', 't2', null, 'A', 0, 19_000, { timestamp: 'garbage', durationMs: null, messageId: 'm2' }),
      tool('a1', null, 'A', 10_100, 18_000),
      text('x2', 't2', 19_500, { messageId: 'm3' }),
    ]));
    expect(thread(tl, 'A').waitMs).toBe(9000); // d placed at 10000, waits to 19000
    expect(tl.totalMs).toBe(10_500);
    expect(tl.mainOwnMs).toBe(1500);
    expect(rel(thread(tl, 'A').segments)).toEqual([[10_000, 19_000]]);
    expectInvariant(tl);
  });

  test('an agent whose first step cannot be read is still hung under the thread that dispatched it (review round 1)', () => {
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      text('x', 't1', 10_000),
      tool('o1', null, 'P', 5000, 5500),
      dispatch('dP', null, 'P', 'C', 6000, 7000, { messageId: 'pm1' }),
      node('c0', 'prompt', null, 'C', 0, { timestamp: 'garbage' }),
      tool('c1', null, 'C', 6100, 6900),
    ]));
    expect(tl.orphans.map((o) => o.id)).toEqual(['P']);
    expect(thread(tl, 'C').parentId).toBe('P');
    expect(thread(tl, 'P').children.map((c) => c.id)).toEqual(['C']);
    expect(thread(tl, 'C').steps).toBe(2);
    expectInvariant(tl);
  });

  test('a session whose times cannot be read at all has no timeline', () => {
    const g = graph([node('p1', 'prompt', 't1', null, 0, { timestamp: 'x' })]);
    expect(computeAgentTimeline(g, session(), ended(0))).toEqual({ available: false, reason: 'no-times' });
  });

  test('a dispatch without childAgentId gets an unmatched row that takes its wait; its own time is the dispatch\'s interval', () => {
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('d1', 't1', null, null, 1000, 4000, { messageId: 'm1', title: 'Explore' }),
      text('x', 't1', 5000, { messageId: 'm2' }),
    ]));
    const u = thread(tl, 'unmatched:d1');
    expect(u.parentId).toBe('main');
    expect(u.waitMs).toBe(3000);
    expect(u.ownMs).toBe(3000);
    expect(u.label).toBe('Explore');
    expect(u.dispatchIds).toEqual(['d1']);
    expectInvariant(tl);
  });

  test('a thread without a dispatch is an orphan at the top level with no wait', () => {
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      text('x', 't1', 5000),
      tool('o1', null, 'orph', 1000, 3000),
    ]));
    expect(tl.orphans.map((o) => o.id)).toEqual(['orph']);
    const o = thread(tl, 'orph');
    expect(o.parentId).toBeNull();
    expect(o.waitMs).toBe(0);
    expect(o.ownMs).toBe(2000);
    expect(o.label).toBe('orph');
    expect(tl.root.children.map((c) => c.id)).toEqual(['orph']);
    expectInvariant(tl);
  });

  test("Codex: an orphan thread gets no wait, whether a wait names it or a follow-up made it the main thread's agent (spec 3.6)", () => {
    // The spawn could not be paired with its thread (childAgentId null): the thread is an orphan.
    const g = (waitSummary: string): Graph => graph([
      prompt('p1', 't1', 0),
      dispatch('d1', 't1', null, null, 1000, 1000, { title: 'collaboration.spawn_agent', summary: 'helper', toolName: 'collaboration.spawn_agent', status: 'failed' }),
      tool('o1', null, 'thr-o', 1100, 9000),
      tool('fu', 't1', null, 2000, 2000, { toolName: 'collaboration.followup_task', summary: '{"target":"thr-o","message":"more"}' }),
      tool('w', 't1', null, 3000, 9500, { toolName: 'collaboration.wait_agent', summary: waitSummary }),
      text('x', 't1', 10_000),
    ]);
    for (const summary of ['{"targets":["thr-o"]}', '{"timeout_ms":1000}']) {
      const tl = timeline(g(summary), 'codex');
      expect(tl.orphans.map((o) => o.id)).toEqual(['thr-o']);
      expect(thread(tl, 'thr-o').waitMs).toBe(0);
      expect(thread(tl, 'thr-o').parentId).toBeNull();
      expect(tl.mainOwnMs).toBe(10_000);
      expectInvariant(tl);
    }
  });

  test('dispatch cycles and an agent dispatched from two threads: hung under the first claim only, no loop', () => {
    // main dispatches A and later X; A dispatches X earlier (X's first claim in the breadth-first walk from main is
    // main's own dispatch); X dispatches A (a cycle).
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('d1', 't1', null, 'A', 1000, 9000, { messageId: 'm1' }),
      dispatch('dAX', null, 'A', 'X', 2000, 8000, { messageId: 'am1' }),
      dispatch('dXA', null, 'X', 'A', 3000, 7000, { messageId: 'xm1' }),
      dispatch('d2', 't1', null, 'X', 10_000, 12_000, { messageId: 'm2' }),
      text('x', 't1', 13_000, { messageId: 'm3' }),
    ]));
    expect(tl.root.children.map((c) => c.id)).toEqual(['A', 'X']);
    expect(thread(tl, 'A').children).toEqual([]);
    expect(thread(tl, 'X').dispatchIds).toEqual(['dAX', 'd2']);
    expect(thread(tl, 'A').dispatchIds).toEqual(['d1', 'dXA']);
    expect(tl.orphans).toEqual([]);
    expectInvariant(tl);
  });
});

describe('labels, usage, sorting', () => {
  test('equal names get #1, #2 in order of appearance', () => {
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('d1', 't1', null, 'A', 1000, 2000, { messageId: 'm1', title: 'Explore' }),
      dispatch('d2', 't1', null, 'B', 3000, 4000, { messageId: 'm2', title: 'Plan' }),
      dispatch('d3', 't1', null, 'C', 5000, 6000, { messageId: 'm3', title: 'Explore' }),
      text('x', 't1', 7000, { messageId: 'm4' }),
    ]));
    expect(tl.root.children.map((c) => [c.id, c.label])).toEqual([['A', 'Explore #1'], ['B', 'Plan'], ['C', 'Explore #2']]);
    expect(tl.root.label).toBe('主线');
  });

  test('tokens: a thread\'s own nodes, a message split over several nodes counted once', () => {
    const usage = { inputTokens: 10, outputTokens: 5, cachedInputTokens: 100 };
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('d1', 't1', null, 'A', 1000, 2000, { messageId: 'm1' }),
      node('a1', 'thinking', null, 'A', 1100, { messageId: 'am1', usage }),
      tool('a2', null, 'A', 1100, 1200, { messageId: 'am1', usage }),
      node('a3', 'text', null, 'A', 1500, { messageId: 'am2', usage: { inputTokens: 1, outputTokens: 2 } }),
      text('x', 't1', 3000, { messageId: 'm2', usage: { inputTokens: 7, outputTokens: 7 } }),
    ]));
    expect(thread(tl, 'A').usage).toEqual({ inputTokens: 11, cachedInputTokens: 100, outputTokens: 7 });
    expect(tl.root.usage).toEqual({ inputTokens: 7, cachedInputTokens: 0, outputTokens: 7 });
    expect(tl.root.steps).toBe(3);
  });

  test('sortThreads: siblings by wait (desc) or start, recursively, ties by id; the input is not changed', () => {
    const tl = timeline(graph([
      prompt('p1', 't1', 0),
      dispatch('d1', 't1', null, 'B', 1000, 2000, { messageId: 'm1' }),
      dispatch('d2', 't1', null, 'A', 3000, 8000, { messageId: 'm2' }),
      dispatch('dA1', null, 'A', 'A2', 3100, 3200, { messageId: 'am1' }),
      dispatch('dA2', null, 'A', 'A1', 3300, 3400, { messageId: 'am2' }),
      dispatch('d3', 't1', null, 'C', 9000, 10_000, { messageId: 'm3' }),
      text('x', 't1', 11_000, { messageId: 'm4' }),
    ]));
    expect(tl.root.children.map((c) => c.id)).toEqual(['B', 'A', 'C']);
    const byWait = sortThreads(tl.root, 'wait');
    expect(byWait.children.map((c) => c.id)).toEqual(['A', 'B', 'C']); // 4800, 1000, 1000 (B < C)
    expect(byWait.children[0]!.children.map((c) => c.id)).toEqual(['A1', 'A2']); // 100 each: by id
    const byStart = sortThreads(byWait, 'start');
    expect(byStart.children.map((c) => c.id)).toEqual(['B', 'A', 'C']);
    expect(byStart.children[1]!.children.map((c) => c.id)).toEqual(['A2', 'A1']);
    expect(tl.root.children.map((c) => c.id)).toEqual(['B', 'A', 'C']);
  });

  test('a session without subagents: only the main thread', () => {
    const tl = timeline(graph([prompt('p1', 't1', 0), tool('a', 't1', null, 100, 900)]));
    expect(tl.root.children).toEqual([]);
    expect(tl.totalMs).toBe(900);
    expect(tl.mainOwnMs).toBe(900);
    expect(tl.longestWaitId).toBeNull();
  });
});

// ---- property test over random sessions ----

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Random { graph: Graph; origin: Origin; clock: WaterfallClock }

/**
 * Several turns with main-thread work, parallel / nested / background dispatches (Claude-like origins) or spawns, waits
 * and follow-ups (Codex), reused agents, open steps (only at the very end), dispatches without end times or without
 * childAgentId, orphan threads and unreadable timestamps.
 */
function randomSession(seed: number): Random {
  const rnd = mulberry32(seed);
  const int = (n: number): number => Math.floor(rnd() * n);
  const origins: Origin[] = ['claude', 'codex', 'gemini', 'cursor'];
  const origin = origins[int(origins.length)]!;
  const codex = origin === 'codex';
  const nodes: GraphNode[] = [];
  let ids = 0;
  const id = (p: string): string => `${p}${ids++}`;
  /** Agents that may be dispatched again, with the end of their last run (only after it). */
  const reusable: { agent: string; end: number }[] = [];
  const pickReusable = (at: number, chance: number): string | null => {
    const done = reusable.filter((r) => r.end < at);
    return done.length > 0 && rnd() < chance ? done[int(done.length)]!.agent : null;
  };
  let agentNo = 0;
  /** Cursor has no message ids: the calls of one batch share their parent instead. */
  const msg = (): string | null => (origin === 'cursor' ? null : id('m'));
  const unreadable = (): Partial<GraphNode> => (rnd() < 0.05 ? { timestamp: 'not a time' } : {});

  /** An agent's steps from `t`; may dispatch a nested agent. Returns when its last step ends. */
  const agentWork = (agent: string, t: number, depth: number, open: boolean): number => {
    nodes.push({ ...prompt(id('ap'), null, t, agent), ...unreadable() });
    let at = t + 10 + int(50);
    const n = 1 + int(4);
    for (let i = 0; i < n; i++) {
      if (depth < 2 && rnd() < 0.2) {
        const child = `ag${agentNo++}`;
        const s = at;
        const end = agentWork(child, s + 5, depth + 1, false);
        if (codex) {
          nodes.push(dispatch(id('d'), null, agent, child, s, end, { title: `N${int(3)}`, summary: child, toolName: 'spawn_agent' }));
          const w0 = s + 1 + int(Math.max(1, end - s));
          const w1 = w0 + int(3000);
          nodes.push(tool(id('w'), null, agent, w0, w1, { toolName: 'wait_agent', summary: rnd() < 0.7 ? `{"targets":["${child}"]}` : '{}' }));
          at = Math.max(at, w1) + 1;
        } else {
          nodes.push(dispatch(id('d'), null, agent, child, s, end + int(20), { messageId: msg(), title: `N${int(3)}` }));
          at = end + 30;
        }
      }
      const d = int(2000);
      const last = open && i === n - 1;
      nodes.push(tool(id('t'), null, agent, at, last ? null : at + d));
      at += d + int(100);
    }
    return at;
  };

  const turns = 1 + int(4);
  let t = 0;
  for (let k = 0; k < turns; k++) {
    const turn = `t${k}`;
    const lastTurn = k === turns - 1;
    t += 1000 + (rnd() < 0.3 ? 600_000 : int(20_000));
    nodes.push(prompt(id('p'), turn, t));
    t += 10 + int(200);
    const steps = 2 + int(6);
    for (let s = 0; s < steps; s++) {
      const r = rnd();
      const openHere = lastTurn && s === steps - 1 && rnd() < 0.4;
      if (r < 0.35) {
        const d = int(3000);
        nodes.push(tool(id('t'), turn, null, t, openHere ? null : t + d, { messageId: msg() }));
        t += d + int(200);
      } else if (r < 0.45) {
        const d = int(3000);
        t += d;
        nodes.push(node(id('th'), 'thinking', turn, null, t, { durationMs: d, messageId: msg() }));
      } else if (r < 0.55) {
        nodes.push(text(id('x'), turn, t, { messageId: msg() }));
        t += int(500);
      } else if (codex) {
        // spawn, main work, maybe a wait, maybe a follow-up of an earlier agent
        const reuse = pickReusable(t, 0.3);
        if (reuse !== null) {
          nodes.push(tool(id('fu'), turn, null, t, t, { toolName: 'collaboration.followup_task', summary: `{"target":"${reuse}","message":"more"}` }));
          const end = agentWork(reuse, t + 20, 1, openHere);
          reusable.find((x) => x.agent === reuse)!.end = openHere ? Infinity : end;
          const w0 = t + 50;
          nodes.push(tool(id('w'), turn, null, w0, openHere ? null : Math.max(w0, end + int(500)), { toolName: 'collaboration.wait_agent', summary: `{"targets":["${reuse}"]}` }));
          t = Math.max(t, end) + 600;
          continue;
        }
        const child = rnd() < 0.1 ? null : `ag${agentNo++}`;
        const start = t;
        const end = child === null ? start : agentWork(child, start + 20, 1, openHere);
        nodes.push(dispatch(id('d'), turn, null, child, start, openHere ? null : end, { title: `N${int(3)}`, summary: child ?? 'x', toolName: 'collaboration.spawn_agent' }));
        if (child !== null && !openHere) reusable.push({ agent: child, end });
        t += 30;
        const work = int(4000);
        nodes.push(tool(id('t'), turn, null, t, t + work));
        t += work;
        if (rnd() < 0.7) {
          const w1 = Math.max(t, end) + int(500);
          const names = rnd() < 0.8 ? `{"targets":["/root/${child ?? 'nobody'}"]}` : '{"timeout_ms":1000}';
          nodes.push(tool(id('w'), turn, null, t, w1, { toolName: 'wait_agent', summary: names }));
          t = w1;
        }
        if (openHere) t = Math.max(t, end);
      } else {
        // one or more parallel dispatches of one message, foreground or background, maybe reused or unmatched
        const m = msg();
        const batch = m === null ? { parentId: id('bp') } : {};
        const parallel = 1 + int(3);
        const background = rnd() < 0.3;
        const start = t;
        let latest = t;
        const ran: { agent: string; end: number }[] = [];
        for (let p = 0; p < parallel; p++) {
          const reuse = pickReusable(start, 0.2);
          const child = reuse ?? (rnd() < 0.1 ? null : `ag${agentNo++}`);
          const open = openHere && p === 0;
          const end = child === null ? start + int(3000) : agentWork(child, start + 10, 1, open);
          const missingEnd = reuse === null && child !== null && !open && rnd() < 0.15;
          nodes.push(dispatch(id('d'), turn, null, child, start, open ? null : end, missingEnd
            ? { messageId: m, status: 'succeeded', endedAt: null, durationMs: null, title: `N${int(3)}`, ...batch, ...unreadable() }
            : { messageId: m, title: `N${int(3)}`, ...batch, ...unreadable() }));
          if (child !== null && !open && !missingEnd && !ran.some((r) => r.agent === child)) ran.push({ agent: child, end });
          latest = Math.max(latest, end);
        }
        for (const r of ran) {
          const known = reusable.find((x) => x.agent === r.agent);
          if (known) known.end = Math.max(known.end, r.end);
          else reusable.push(r);
        }
        if (rnd() < 0.3) nodes.push(tool(id('par'), turn, null, start + int(5), start + int(2000), { messageId: m, ...batch }));
        t = background ? start + 1 + int(1000) : latest + 1 + int(200);
        if (openHere) t = Math.max(t, latest);
      }
    }
    if (!(lastTurn && rnd() < 0.3)) nodes.push(text(id('x'), turn, t, { messageId: msg() }));
  }
  if (rnd() < 0.3) {
    const o = `orphan${seed}`;
    agentWork(o, 500 + int(t), 1, false);
  }
  if (rnd() < 0.2) nodes.push(node(id('bad'), 'text', 't0', null, 0, { timestamp: 'not a time' }));
  const last = t + int(5000);
  const running = rnd() < 0.4;
  const clock: WaterfallClock = running
    ? { nowMs: EPOCH + last + 1000, ticking: true, backgroundNowMs: EPOCH + last + 1000, backgroundTicking: true }
    : { nowMs: EPOCH + last, ticking: false, backgroundNowMs: EPOCH + last + int(2) * 500, backgroundTicking: false };
  return { graph: graph(nodes), origin, clock };
}

describe('property: random sessions', () => {
  const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

  test('every moment of the total belongs to exactly one thread (to the millisecond)', () => {
    let withAgents = 0;
    for (const seed of SEEDS) {
      const { graph: g, origin, clock } = randomSession(seed);
      const tl = timeline(g, origin, clock);
      expect(tl.totalMs).toBeGreaterThan(0);
      for (const th of flatten(tl.root)) {
        expect(th.waitMs).toBeGreaterThanOrEqual(0);
        expect(th.ownMs).toBeGreaterThanOrEqual(0);
      }
      expectInvariant(tl);
      if (tl.root.children.length > 0) withAgents++;
    }
    expect(withAgents).toBeGreaterThan(SEEDS.length / 2);
  });

  test('own time is at least the attributed wait where the agent\'s segments cover its dispatches (Claude-like origins)', () => {
    let checked = 0;
    for (const seed of SEEDS) {
      const { graph: g, origin, clock } = randomSession(seed);
      if (origin === 'codex') continue; // a wait_agent may outlast its agents' work; segments do not cover it
      const tl = timeline(g, origin, clock);
      for (const th of flatten(tl.root)) {
        if (th.id === 'main') continue;
        expect(th.ownMs).toBeGreaterThanOrEqual(th.waitMs);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  test('sorting changes no number and keeps every thread', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const { graph: g, origin, clock } = randomSession(seed);
      const tl = timeline(g, origin, clock);
      const sum = (t: ThreadTime): [number, number, number] => flatten(t).reduce<[number, number, number]>(
        (acc, x) => [acc[0] + x.waitMs, acc[1] + x.ownMs, acc[2] + 1], [0, 0, 0]);
      const ids = (t: ThreadTime): string[] => flatten(t).map((x) => `${x.parentId}>${x.id}`).sort();
      for (const by of ['wait', 'start'] as const) {
        const sorted = sortThreads(tl.root, by);
        expect(sum(sorted)).toEqual(sum(tl.root));
        expect(ids(sorted)).toEqual(ids(tl.root));
      }
    }
  });
});
