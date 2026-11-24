import { afterEach, describe, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ExportBundle, Graph, GraphNode, NodeKind, Origin, Session } from '@agent-canvas/shared';
import { computeAgentTimeline, type AgentTimeline, type AgentTimelineResult, type ThreadTime } from '../src/canvas/agentTime';
import {
  AgentTimelineView, TIMELINE_NO_AGENTS, TIMELINE_NO_TIMES, TIMELINE_NO_TIMES_DOUBAO, axisScale, compactStepCounts, panelTitle,
  scopeOfNode, stepTurn, threadScope, threadTooltip, timelineRowModel, timelineRows, turnAnnouncement, turnAt, turnGroupings,
  type AgentTimelineViewProps,
} from '../src/canvas/AgentTimeline';
import {
  createInThreadTimelineClient, createTimelineClient, createTimelineWorkerState, startAgentTimeline, watchAgentTimeline,
  type TimelineClient, type TimelineRequest,
} from '../src/canvas/timelineClient';
import {
  CLOSED_PANEL, FOLLOW_LATEST, panelForDispatch, panelForStep, panelScopeOf, pickedPanel, pinForStep, unpinOnDrawerClose,
} from '../src/canvas/timelinePanel';
import type { WorkerLike } from '../src/canvas/layoutClient';
import { snapshotClock, waterfallClock, type WaterfallClock } from '../src/canvas/waterfall';
import { formatSpan } from '../src/stats';
import { ViewSwitch } from '../src/pages/SessionCanvas';
import { createDisplaySource, createPageMasker, IDENTITY_MASKER } from '../src/masking';
import { embeddedSource } from '../src/viewer/data';
import type { SessionSource } from '../src/sessionSource';
import { usageLabel } from '../src/canvas/replay';
import { turnKeyOf } from '../src/canvas/view';

// Invented sessions only. Times are milliseconds after EPOCH.

const EPOCH = Date.parse('2026-01-01T00:00:00Z');
const iso = (t: number): string => new Date(EPOCH + t).toISOString();

function node(id: string, kind: NodeKind, turnId: string | null, agentId: string | null, t: number, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id, sessionId: 's1', turnId, agentId, childAgentId: null, endedAt: null, parentId: null, kind, status: null,
    timestamp: iso(t), confirmed: true, title: kind, summary: '', toolName: null,
    toolUseId: null, messageId: null, durationMs: null, usage: null, systemSubtype: null, ...extra,
  };
}
const prompt = (id: string, turn: string, t: number, summary = ''): GraphNode => node(id, 'prompt', turn, null, t, { summary });
const text = (id: string, turn: string | null, agent: string | null, t: number, extra: Partial<GraphNode> = {}): GraphNode =>
  node(id, 'text', turn, agent, t, extra);
function tool(id: string, turn: string | null, agent: string | null, from: number, to: number | null, extra: Partial<GraphNode> = {}): GraphNode {
  return node(id, 'tool', turn, agent, from, {
    title: 'Bash', toolName: 'Bash', status: to === null ? 'running' : 'succeeded', endedAt: to === null ? null : iso(to),
    durationMs: to === null ? null : to - from, ...extra,
  });
}
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
const sessionOf = (origin: Origin = 'claude', o: Partial<Session> = {}): Session => ({
  id: 's1', projectId: 'p1', origin, cwd: null, title: null, gitBranch: null, status: 'idle', sourceDeleted: false,
  startedAt: iso(0), lastActivityAt: iso(10_000), ...o,
});
function timeline(g: Graph, origin: Origin = 'claude', clock: WaterfallClock = ended(10_000_000)): AgentTimeline {
  const r = computeAgentTimeline(g, sessionOf(origin), clock);
  if (!r.available) throw new Error('expected a timeline');
  return r;
}

/**
 * A Claude session: turn t1 dispatches Explore (A, which dispatches Check C inside it) and Review (B) in parallel, a
 * third agent D in turn t2 twice (two segments).
 */
function claudeGraph(): Graph {
  return graph([
    prompt('p1', 't1', 0, 'refactor the export'),
    dispatch('d1', 't1', null, 'A', 1000, 9000, { title: 'Explore', summary: 'find the files', messageId: 'm1',
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 1 } }),
    dispatch('d2', 't1', null, 'B', 1000, 5000, { title: 'Review', summary: 'read the diff', messageId: 'm1' }),
    tool('a1', null, 'A', 1100, 1900, { usage: { inputTokens: 1200, cachedInputTokens: 45_000, outputTokens: 340 } }),
    node('a-noise', 'thinking', null, 'A', 1950, { summary: '' }),
    dispatch('dc', null, 'A', 'C', 2000, 6000, { title: 'Check', summary: 'run the tests' }),
    tool('c1', null, 'C', 2100, 5900),
    tool('a2', null, 'A', 6100, 8900),
    tool('b1', null, 'B', 1100, 4900),
    text('x', 't1', null, 9500, { messageId: 'm2' }),
    prompt('p2', 't2', 20_000, 'and the tests'),
    dispatch('d3', 't2', null, 'D', 21_000, 23_000, { title: 'Fix', summary: 'first try', messageId: 'm3' }),
    tool('dd1', null, 'D', 21_100, 22_900),
    text('y', 't2', null, 23_500, { messageId: 'm4' }),
    dispatch('d4', 't2', null, 'D', 24_000, 26_000, { title: 'Fix', summary: 'second try', messageId: 'm5' }),
    tool('dd2', null, 'D', 24_100, 25_900),
    text('z', 't2', null, 26_500, { messageId: 'm6' }),
  ]);
}

/** A hand-made thread for row-order tests. */
function th(id: string, waitMs: number, startMs: number, children: ThreadTime[] = [], o: Partial<ThreadTime> = {}): ThreadTime {
  return {
    id, parentId: null, label: id, dispatchIds: [], segments: [{ startMs, endMs: startMs + 10 }], waitingSpans: [], ownMs: 10,
    waitMs, open: false, steps: 1, usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, children, ...o,
  };
}

function props(o: Partial<AgentTimelineViewProps> & { result: AgentTimelineResult | null; graph: Graph }): AgentTimelineViewProps {
  return {
    error: null, origin: 'claude', compact: false, sort: 'wait', onSortChange: () => {}, panelKey: null, pickedRow: null, onPickScope: () => {}, ...o,
  };
}
const render = (p: AgentTimelineViewProps): string => renderToStaticMarkup(createElement(AgentTimelineView, p));
/** The text of the elements with class `cls`, in order. */
function texts(html: string, cls: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"[^>]*>(.*?)</`, 'g');
  for (const m of html.matchAll(re)) out.push(m[1]!.replace(/<[^>]*>/g, ''));
  return out;
}
const decode = (s: string): string => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

describe('the view switch', () => {
  test('时间线 comes after 复盘; while it shows, it is the pressed entry and no view mode is', () => {
    const off = renderToStaticMarkup(createElement(ViewSwitch, { mode: 'outline', timeline: false, disabled: false, onChange: () => {}, onTimeline: () => {} }));
    const labels = [...off.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
    expect(labels).toEqual(['概览', '逐步', '拓扑', '因果', '复盘', '时间线']);
    const pressed = (html: string): string[] => [...html.matchAll(/<button[^>]*aria-pressed="true"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]!);
    expect(pressed(off)).toEqual(['概览']);
    const on = renderToStaticMarkup(createElement(ViewSwitch, { mode: 'outline', timeline: true, disabled: false, onChange: () => {}, onTimeline: () => {} }));
    expect(pressed(on)).toEqual(['时间线']);
  });

  test('before the canvas model exists the view modes are disabled, 时间线 is not (it needs no canvas)', () => {
    const html = renderToStaticMarkup(createElement(ViewSwitch, { mode: 'live', timeline: false, disabled: true, onChange: () => {}, onTimeline: () => {} }));
    const buttons = [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map((m) => ({ label: m[2], disabled: m[1]!.includes('disabled') }));
    expect(buttons.filter((b) => b.disabled).map((b) => b.label)).toEqual(['概览', '逐步', '拓扑', '因果', '复盘']);
  });
});

describe('rows', () => {
  const root = th('main', 0, 0, [
    th('A', 100, 50, [th('A2', 5, 70), th('A1', 40, 60)]),
    th('B', 300, 80),
    th('C', 100, 10),
  ]);

  test('by wait time (default): longest first among siblings, ties by id, nested rows under their parent', () => {
    expect(timelineRows(root, 'wait').map((r) => [r.thread.id, r.depth])).toEqual([
      ['main', 0], ['B', 1], ['A', 1], ['A1', 2], ['A2', 2], ['C', 1],
    ]);
  });

  test('by start time: earliest first among siblings', () => {
    expect(timelineRows(root, 'start').map((r) => [r.thread.id, r.depth])).toEqual([
      ['main', 0], ['C', 1], ['A', 1], ['A1', 2], ['A2', 2], ['B', 1],
    ]);
  });

  test('rows are indented by depth in the rendered view', () => {
    const tl = timeline(claudeGraph());
    const html = render(props({ result: tl, graph: claudeGraph() }));
    // C is dispatched inside A: one level deeper.
    const indent = (id: string): number => Number(new RegExp(`data-id="${id}"[\\s\\S]*?--depth:(\\d+)`).exec(html)![1]);
    expect([indent('main'), indent('A'), indent('C'), indent('B'), indent('D')]).toEqual([0, 1, 2, 1, 1]);
  });
});

describe('the rendered view', () => {
  test('header, sort toggle, columns, the main row and the agents’ numbers', () => {
    const g = claudeGraph();
    const tl = timeline(g);
    const html = decode(render(props({ result: tl, graph: g })));
    expect(html).toContain(`总用时 ${formatSpan(tl.totalMs)} · 2 轮`);
    expect(texts(html, 'cc-tl-sort-label')).toEqual(['排序：']);
    expect(html).toMatch(/aria-pressed="true"[^>]*>等待时间<\/button>/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>开始时间<\/button>/);
    expect(texts(html, 'cc-tl-colname')).toEqual(['等待', '各自用时']);
    expect(texts(html, 'cc-tl-main-nums')).toEqual([`自己 ${formatSpan(tl.mainOwnMs)} · 等 ${formatSpan(tl.mainWaitMs)}`]);
    // Agent rows in wait order, each with its two numbers.
    const agents = timelineRows(tl.root, 'wait').slice(1).map((r) => r.thread);
    expect(texts(html, 'cc-tl-label')).toEqual(['主线', ...agents.map((a) => a.label)]);
    expect(texts(html, 'cc-tl-wait')).toEqual(agents.map((a) => formatSpan(a.waitMs)));
    expect(texts(html, 'cc-tl-own')).toEqual(agents.map((a) => formatSpan(a.ownMs)));
    expect(html).not.toContain(TIMELINE_NO_AGENTS);
  });

  test('the longest wait is marked, on that row only', () => {
    const g = claudeGraph();
    const tl = timeline(g);
    expect(tl.longestWaitId).not.toBeNull();
    const html = render(props({ result: tl, graph: g }));
    expect(texts(html, 'cc-tl-longest')).toEqual(['最长']);
    expect(new RegExp(`data-id="${tl.longestWaitId}"[^>]*>(?:(?!data-id=).)*cc-tl-longest`, 's').test(html)).toBe(true);
  });

  test('a reused agent is one row with one bar per dispatch segment; light parts where a thread waits on its own agents', () => {
    const g = claudeGraph();
    const tl = timeline(g);
    const html = render(props({ result: tl, graph: g }));
    const row = (id: string): string => new RegExp(`data-id="${id}"(?:(?!data-id=).)*`, 's').exec(html)![0];
    expect(row('D').match(/cc-tl-bar\b/g)).toHaveLength(2);
    expect(row('A').match(/cc-tl-waiting/g)?.length).toBe(1); // A waits on C
    expect(row('B')).not.toContain('cc-tl-waiting');
    expect(row('main').match(/cc-tl-waiting/g)!.length).toBeGreaterThan(0);
  });

  test('sorted by start time when the toggle says so', () => {
    const g = claudeGraph();
    const tl = timeline(g);
    const html = render(props({ result: tl, graph: g, sort: 'start' }));
    expect(html).toMatch(/aria-pressed="true"[^>]*>开始时间<\/button>/);
    expect(texts(html, 'cc-tl-label')).toEqual(['主线', ...timelineRows(tl.root, 'start').slice(1).map((r) => r.thread.label)]);
  });

  test('a running agent says 进行中', () => {
    const g = graph([
      prompt('p1', 't1', 0),
      dispatch('d1', 't1', null, 'A', 1000, null, { title: 'Explore', messageId: 'm1' }),
      tool('a1', null, 'A', 1100, null),
    ]);
    const tl = computeAgentTimeline(g, sessionOf('claude', { status: 'running' }), waterfallClock(sessionOf('claude', { status: 'running' }), EPOCH + 5000));
    const html = render(props({ result: tl, graph: g }));
    expect(texts(html, 'cc-tl-open')).toEqual(['进行中', '进行中']); // main and A
  });

  test('a session without subagents: only the main thread, and it says so', () => {
    const g = graph([prompt('p1', 't1', 0), tool('t', 't1', null, 100, 2000), text('x', 't1', null, 2500)]);
    const html = render(props({ result: timeline(g), graph: g }));
    expect(texts(html, 'cc-tl-label')).toEqual(['主线']);
    expect(html).toContain(TIMELINE_NO_AGENTS);
    expect(TIMELINE_NO_AGENTS).toBe('这个会话没有派出子代理');
  });

  test('Doubao: only the message that there are no times', () => {
    const g = graph([prompt('p1', 't1', 0), text('x', 't1', null, 0)]);
    const html = render(props({ result: computeAgentTimeline(g, sessionOf('doubao'), ended(0)), graph: g, origin: 'doubao' }));
    expect(TIMELINE_NO_TIMES_DOUBAO).toBe('这个来源没有记录每一步的时间，无法生成时间线');
    expect(html).toContain(TIMELINE_NO_TIMES_DOUBAO);
    expect(html).not.toContain('cc-tl-row');
  });

  test('another source with no readable time at all: its own message', () => {
    const g = graph([node('p1', 'prompt', 't1', null, 0, { timestamp: 'garbage' })]);
    const html = render(props({ result: computeAgentTimeline(g, sessionOf('claude'), ended(0)), graph: g }));
    expect(html).toContain(TIMELINE_NO_TIMES);
    expect(html).not.toContain(TIMELINE_NO_TIMES_DOUBAO);
  });

  test('before the first result: 计算中; a failure says so', () => {
    const g = claudeGraph();
    expect(render(props({ result: null, graph: g }))).toContain('计算中');
    expect(render(props({ result: null, graph: g, error: 'boom' }))).toContain('时间线算不出来：boom');
  });

  test('the row whose steps the execution panel lists is highlighted', () => {
    const g = claudeGraph();
    const html = render(props({ result: timeline(g), graph: g, panelKey: 'agent:B' }));
    expect(/data-id="B"[^>]*class="[^"]*cc-tl-selected|class="[^"]*cc-tl-selected[^"]*"[^>]*data-id="B"/.test(html)).toBe(true);
    expect(html.match(/cc-tl-selected/g)).toHaveLength(1);
  });

  test('the axis has a break mark where a quiet gap was compressed', () => {
    const g = graph([
      prompt('p1', 't1', 0), tool('a', 't1', null, 0, 60_000), text('x', 't1', null, 61_000),
      prompt('p2', 't2', 3_600_000), tool('b', 't2', null, 3_600_000, 3_660_000), text('y', 't2', null, 3_661_000),
    ]);
    const tl = timeline(g);
    expect(tl.axis.breaks).toHaveLength(1);
    const html = render(props({ result: tl, graph: g }));
    expect(html.match(/cc-tl-break/g)).toHaveLength(1);
    expect(html).toContain('//');
  });
});

describe('the axis', () => {
  test('without breaks: linear', () => {
    const s = axisScale({ startMs: 1000, endMs: 2000, breaks: [] });
    expect(s.toX(1000)).toBe(0);
    expect(s.toX(1500)).toBeCloseTo(0.5);
    expect(s.toX(2000)).toBe(1);
    expect(s.fromX(0.25)).toBeCloseTo(1250);
    expect(s.breaks).toEqual([]);
  });

  test('a break takes a small fixed share; times on either side keep their proportions; fromX inverts toX', () => {
    // 0-100 shown, 100-1_000_000 compressed, 1_000_000-1_000_300 shown.
    const s = axisScale({ startMs: 0, endMs: 1_000_300, breaks: [{ startMs: 100, endMs: 1_000_000 }] });
    expect(s.breaks).toHaveLength(1);
    const b = s.breaks[0]!;
    expect(b.width).toBeGreaterThan(0);
    expect(b.width).toBeLessThanOrEqual(0.05);
    const shown = 1 - b.width;
    expect(s.toX(100)).toBeCloseTo(shown * 100 / 400);
    expect(s.toX(1_000_000)).toBeCloseTo(shown * 100 / 400 + b.width);
    expect(s.toX(1_000_300)).toBeCloseTo(1);
    for (const ms of [0, 50, 100, 500_000, 1_000_000, 1_000_150, 1_000_300]) expect(s.fromX(s.toX(ms))).toBeCloseTo(ms, 3);
    // Clamped outside the axis.
    expect(s.toX(-5)).toBe(0);
    expect(s.toX(2_000_000)).toBe(1);
  });

  test('ticks: one at the start of each shown stretch, none inside a break, increasing', () => {
    const s = axisScale({ startMs: 0, endMs: 1_000_300, breaks: [{ startMs: 100, endMs: 1_000_000 }] });
    const xs = s.ticks.map((t) => t.x);
    expect(s.ticks[0]).toEqual({ x: 0, ms: 0, start: true });
    expect(s.ticks.find((t) => t.ms === 1_000_000)?.start).toBe(true);
    expect(s.ticks.filter((t) => t.start)).toHaveLength(2);
    expect(s.ticks.every((t) => !(t.ms > 100 && t.ms < 1_000_000))).toBe(true);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });
});

describe('the tooltip', () => {
  const g = claudeGraph();
  const tl = timeline(g);
  const find = (id: string): ThreadTime => timelineRows(tl.root, 'wait').find((r) => r.thread.id === id)!.thread;
  const clock = (ms: number): string => new Date(ms).toLocaleTimeString();

  test('an agent: the dispatching step, start, end, step count, tokens', () => {
    const a = find('A');
    const tip = threadTooltip(a, { graph: g, steps: null });
    expect(tip.split('\n')).toEqual([
      a.label,
      '派出它的一步：Explore · find the files',
      `开始 ${clock(EPOCH + 1000)} · 结束 ${clock(EPOCH + 9000)}`,
      '步骤 4',
      `token：${usageLabel(a.usage)}`,
    ]);
    expect(a.usage).toEqual({ inputTokens: 1200, cachedInputTokens: 45_000, outputTokens: 340 });
  });

  test('the step count follows 精简 / 完整: 精简 leaves out nodes with nothing to read', () => {
    const counts = compactStepCounts(g);
    expect(counts.get('A')).toBe(3); // a1, dc, a2: a-noise (empty thinking) left out
    expect(counts.get('main')).toBe(g.nodes ? Object.values(g.nodes).filter((n) => n.agentId === null).length : 0);
    expect(threadTooltip(find('A'), { graph: g, steps: counts })).toContain('\n步骤 3\n');
  });

  test('an agent dispatched more than once: the dispatch count', () => {
    const tip = threadTooltip(find('D'), { graph: g, steps: null });
    expect(tip).toContain('派出 2 次');
    expect(threadTooltip(find('B'), { graph: g, steps: null })).not.toContain('派出 ');
  });

  test('the main thread: no dispatching step; a running thread ends 进行中', () => {
    const tip = threadTooltip(tl.root, { graph: g, steps: null });
    expect(tip.split('\n')[0]).toBe('主线');
    expect(tip).not.toContain('派出它的一步');
    const open: ThreadTime = { ...find('B'), open: true };
    expect(threadTooltip(open, { graph: g, steps: null })).toContain(`开始 ${clock(EPOCH + 1000)} · 进行中`);
  });

  test('an unmatched dispatch and an orphan say so', () => {
    const g2 = graph([
      prompt('p1', 't1', 0),
      dispatch('du', 't1', null, null, 1000, 3000, { title: 'Helper', messageId: 'm1' }),
      tool('o1', null, 'O', 500, 700),
      text('x', 't1', null, 3500, { messageId: 'm2' }),
    ]);
    const tl2 = timeline(g2);
    const rows = timelineRows(tl2.root, 'wait').map((r) => r.thread);
    const unmatched = rows.find((t) => t.id === 'unmatched:du')!;
    const orphan = rows.find((t) => t.id === 'O')!;
    expect(threadTooltip(unmatched, { graph: g2, steps: null })).toContain('未配上的子代理');
    expect(threadTooltip(orphan, { graph: g2, steps: null })).toContain('找不到派出它的一步');
  });
});

describe('clicks set the execution panel', () => {
  const g = claudeGraph();
  const tl = timeline(g);
  test('an agent row: that agent', () => {
    expect(threadScope(g, tl.root.children.find((t) => t.id === 'A')!)).toEqual({ type: 'agent', agentId: 'A' });
  });
  test('an unmatched row: the turn (or agent) of its dispatch', () => {
    const g2 = graph([
      prompt('p1', 't1', 0),
      dispatch('du', 't1', null, null, 1000, 3000, { messageId: 'm1' }),
      dispatch('dA', 't1', null, 'A', 1000, 3000, { messageId: 'm1' }),
      dispatch('dn', null, 'A', null, 1500, 2000),
      text('x', 't1', null, 3500, { messageId: 'm2' }),
    ]);
    const tl2 = timeline(g2);
    const rows = timelineRows(tl2.root, 'wait').map((r) => r.thread);
    expect(threadScope(g2, rows.find((t) => t.id === 'unmatched:du')!)).toEqual({ type: 'turn', turnKey: turnKeyOf(g2, 'du') });
    expect(turnKeyOf(g2, 'du')).toBe('t1');
    expect(threadScope(g2, rows.find((t) => t.id === 'unmatched:dn')!)).toEqual({ type: 'agent', agentId: 'A' });
  });
  test('a point on the main bar: the latest-starting turn containing that time; none outside every turn', () => {
    const spans = [
      { turnKey: 't1', startMs: 0, endMs: 100 },
      { turnKey: 't2', startMs: 50, endMs: 300 },
      { turnKey: 't3', startMs: 400, endMs: 400 },
    ];
    expect(turnAt(spans, 10)).toBe('t1');
    expect(turnAt(spans, 60)).toBe('t2');
    expect(turnAt(spans, 200)).toBe('t2');
    expect(turnAt(spans, 350)).toBeNull();
    expect(turnAt(spans, 400)).toBe('t3');
    expect(turnAt(tl.turnSpans, EPOCH + 22_000)).toBe('t2');
  });
});

describe('deep link, file panel and anomaly picks while the timeline shows', () => {
  const g = claudeGraph();
  test('a main-thread step: its turn; an agent step: its agent; a nested agent step: that agent; unknown: null', () => {
    expect(scopeOfNode(g, 'y')).toEqual({ type: 'turn', turnKey: 't2' });
    expect(scopeOfNode(g, 'a2')).toEqual({ type: 'agent', agentId: 'A' });
    expect(scopeOfNode(g, 'c1')).toEqual({ type: 'agent', agentId: 'C' });
    expect(scopeOfNode(g, 'nope')).toBeNull();
  });
  test('the panel title: the turn’s prompt (from the canvas’s turns when it has them), or the agent’s dispatching step', () => {
    const tl = timeline(g);
    const none = (): undefined => undefined;
    expect(panelTitle(g, { type: 'turn', turnKey: 't2' }, tl, none)).toBe('and the tests');
    expect(panelTitle(g, { type: 'turn', turnKey: 't2' }, tl, (k) => (k === 't2' ? 'from the canvas' : undefined))).toBe('from the canvas');
    expect(panelTitle(g, { type: 'agent', agentId: 'A' }, tl, none)).toBe('Explore · find the files');
    expect(panelTitle(g, { type: 'agent', agentId: 'A' }, null, none)).toBe('Explore · find the files');
    expect(panelTitle(g, { type: 'turn', turnKey: 'unknown' }, tl, none)).toBe('（无提示）');
  });

  test('the turn of a step: its turnId directly; one without a turnId by one grouping per graph, as turnKeyOf groups', () => {
    const g2 = graph([
      prompt('p1', 't1', 0), text('x1', null, null, 500),
      prompt('p2', 't2', 1000), text('x2', null, null, 1500), dispatch('du', null, null, null, 1600, 1700),
    ]);
    const before = turnGroupings();
    expect(scopeOfNode(g2, 'p2')).toEqual({ type: 'turn', turnKey: 't2' });
    expect(turnGroupings()).toBe(before); // a turnId needs no grouping
    for (const id of ['x1', 'x2', 'du']) expect(scopeOfNode(g2, id)).toEqual({ type: 'turn', turnKey: turnKeyOf(g2, id) });
    expect(scopeOfNode(g2, 'x1')).toEqual({ type: 'turn', turnKey: 't1' });
    expect(turnGroupings()).toBe(before + 1); // once for this graph object, however many lookups
    const changed = { ...g2, nodes: { ...g2.nodes } };
    scopeOfNode(changed, 'x2');
    expect(turnGroupings()).toBe(before + 2); // a new graph: grouped again
  });
});

describe('the panel while the timeline shows (the page’s rules)', () => {
  const g = claudeGraph();
  test('following the latest turn until a pick or a close', () => {
    expect(panelScopeOf(FOLLOW_LATEST, 't2')).toEqual({ type: 'turn', turnKey: 't2' });
    expect(panelScopeOf(FOLLOW_LATEST, null)).toBeNull();
    expect(panelScopeOf(CLOSED_PANEL, 't2')).toBeNull();
    const picked = pickedPanel({ type: 'agent', agentId: 'A' }, 'A');
    expect(panelScopeOf(picked, 't2')).toEqual({ type: 'agent', agentId: 'A' });
    expect(picked.row).toBe('A');
  });
  test('opening a step while following pins the shown turn; closing the drawer undoes only that pin', () => {
    const pinned = pinForStep(FOLLOW_LATEST, { type: 'turn', turnKey: 't2' });
    expect(pinned).toEqual({ scope: { type: 'turn', turnKey: 't2' }, closed: false, pinned: true, row: null });
    expect(unpinOnDrawerClose(pinned)).toEqual(FOLLOW_LATEST);
    const picked = pickedPanel({ type: 'agent', agentId: 'A' }, 'A');
    expect(pinForStep(picked, { type: 'agent', agentId: 'A' })).toBe(picked); // the reader's own pick: unchanged
    expect(unpinOnDrawerClose(picked)).toBe(picked);
  });
  test('a deep link, a file-panel or anomaly pick, a chain row: the step’s agent or turn, the drawer on the step', () => {
    expect(panelForStep(g, 'c1')).toEqual({ panel: pickedPanel({ type: 'agent', agentId: 'C' }), detail: { id: 'c1', scope: 'agent:C' } });
    expect(panelForStep(g, 'y')).toEqual({ panel: pickedPanel({ type: 'turn', turnKey: 't2' }), detail: { id: 'y', scope: 'turn:t2' } });
    expect(panelForStep(g, 'nope')).toBeNull();
  });
  test('the execution panel’s 内部步骤 on a dispatch: that agent; a dispatch without an agent: nothing', () => {
    expect(panelForDispatch(g, 'd1')).toEqual(pickedPanel({ type: 'agent', agentId: 'A' }));
    const g2 = graph([prompt('p1', 't1', 0), dispatch('du', 't1', null, null, 10, 20)]);
    expect(panelForDispatch(g2, 'du')).toBeNull();
  });
});

describe('highlight, running style, keyboard and names', () => {
  const g = graph([
    prompt('p1', 't1', 0),
    dispatch('du', 't1', null, null, 1000, 3000, { title: 'Helper', messageId: 'm1' }),
    dispatch('dA', 't1', null, 'A', 1000, 3000, { title: 'Explore', messageId: 'm1' }),
    tool('a1', null, 'A', 1100, 2900),
    text('x', 't1', null, 3500, { messageId: 'm2' }),
  ]);
  const tl = timeline(g);
  const selected = (panelKey: string | null, pickedRow: string | null): string[] =>
    timelineRowModel(tl, { graph: g, sort: 'wait', steps: null, panelKey, pickedRow }).filter((r) => r.selected).map((r) => r.thread.id);

  test('following the latest turn highlights nothing; an unmatched row or the main bar only when the reader picked it', () => {
    expect(selected('turn:t1', null)).toEqual([]);
    expect(selected('turn:t1', 'unmatched:du')).toEqual(['unmatched:du']);
    expect(selected('turn:t1', 'main')).toEqual(['main']);
    expect(selected(null, 'main')).toEqual([]);
    expect(selected('agent:A', null)).toEqual(['A']); // an agent's own steps: its row, however they got there
  });

  test('only the open segment of an open thread is drawn running', () => {
    const g2 = graph([
      prompt('p1', 't1', 0), tool('t', 't1', null, 0, 1000), text('x', 't1', null, 1500),
      prompt('p2', 't2', 10_000), tool('u', 't2', null, 10_000, null),
    ]);
    const running = sessionOf('claude', { status: 'running', lastActivityAt: iso(12_000) });
    const r = computeAgentTimeline(g2, running, waterfallClock(running, EPOCH + 12_000));
    const html = render(props({ result: r, graph: g2 }));
    const row = new RegExp('data-id="main"(?:(?!data-id=).)*', 's').exec(html)![0];
    expect(row.match(/class="cc-tl-bar[^"]*"/g)).toEqual(['class="cc-tl-bar"', 'class="cc-tl-bar cc-tl-running"']);
  });

  test('numbers carry their column names; each row’s details are its description; the main bar is focusable', () => {
    const html = decode(render(props({ result: tl, graph: g })));
    const a = tl.root.children.find((t) => t.id === 'A')!;
    expect(html).toContain(`aria-label="等待 ${formatSpan(a.waitMs)}"`);
    expect(html).toContain(`aria-label="各自用时 ${formatSpan(a.ownMs)}"`);
    const id = /<button[^>]*class="cc-tl-pick"[^>]*aria-describedby="([^"]+)"/.exec(html)?.[1]
      ?? /aria-describedby="([^"]+)"[^>]*class="cc-tl-pick"/.exec(html)![1]!;
    const described = new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(html)![1]!;
    expect(described.length).toBeGreaterThan(0);
    expect(described).toContain('步骤');
    // Read once, as the description: the hidden text itself is out of the reading order (every row's, the main one's too).
    const hidden = [...html.matchAll(/<span id="[^"]+" class="visually-hidden"([^>]*)>/g)];
    expect(hidden.length).toBe(tl.root.children.length + 1);
    for (const m of hidden) expect(m[1]).toContain('aria-hidden="true"');
    expect(html).toMatch(/class="cc-tl-track cc-tl-main-track"[^>]*tabindex="0"|tabindex="0"[^>]*class="cc-tl-track cc-tl-main-track"/);
  });

  test("the main bar's live region names the turn and its start only, so a running session is not re-announced every tick", () => {
    const g2 = graph([
      prompt('p1', 't1', 0), text('x', 't1', null, 1500),
      prompt('p2', 't2', 10_000), tool('u', 't2', null, 10_000, null),
    ]);
    const at = (now: number): AgentTimeline => {
      const running = sessionOf('claude', { status: 'running', lastActivityAt: iso(now) });
      const r = computeAgentTimeline(g2, running, waterfallClock(running, EPOCH + now));
      if (!r.available) throw new Error('expected a timeline');
      return r;
    };
    const before = at(12_000);
    const after = at(13_000);
    expect(after.turnSpans[1]!.endMs).toBeGreaterThan(before.turnSpans[1]!.endMs); // the turn grows with the clock
    const said = turnAnnouncement(1, before.turnSpans[1]!);
    expect(turnAnnouncement(1, after.turnSpans[1]!)).toBe(said); // but what is announced does not
    expect(said).toMatch(/^第 2 轮，.+ 开始$/);
    expect(said).not.toContain('到');
    // Nothing is announced until the reader moves to a turn.
    const html = render(props({ result: before, graph: g2 }));
    expect(html).toMatch(/<span class="visually-hidden" aria-live="polite"><\/span>/);
  });

  test('arrow keys move between turns on the main bar (from none: the first or the last), Home / End', () => {
    expect(stepTurn(null, 'ArrowRight', 3)).toBe(0);
    expect(stepTurn(null, 'ArrowLeft', 3)).toBe(2);
    expect(stepTurn(0, 'ArrowRight', 3)).toBe(1);
    expect(stepTurn(2, 'ArrowRight', 3)).toBe(2);
    expect(stepTurn(0, 'ArrowLeft', 3)).toBe(0);
    expect(stepTurn(1, 'Home', 3)).toBe(0);
    expect(stepTurn(1, 'End', 3)).toBe(2);
    expect(stepTurn(1, 'a', 3)).toBeNull();
    expect(stepTurn(null, 'ArrowRight', 0)).toBeNull();
  });

  test('a break mark comes right before the tick of the stretch after it (so the label can be moved clear of it)', () => {
    const g2 = graph([
      prompt('p1', 't1', 0), tool('a', 't1', null, 0, 60_000), text('x', 't1', null, 61_000),
      prompt('p2', 't2', 3_600_000), tool('b', 't2', null, 3_600_000, 3_660_000), text('y', 't2', null, 3_661_000),
    ]);
    const html = render(props({ result: timeline(g2), graph: g2 }));
    expect(html).toMatch(/class="cc-tl-break"[^>]*>\/\/<\/span><span class="cc-tl-tick cc-tl-tick-start"/);
  });
});

describe('the client', () => {
  class FakeWorker implements WorkerLike {
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    sent: TimelineRequest[] = [];
    terminated = false;
    readonly state = createTimelineWorkerState();
    auto = true;
    postMessage(msg: unknown): void {
      this.sent.push(msg as TimelineRequest);
      if (this.auto) {
        const reply = this.state.handle(msg as TimelineRequest);
        queueMicrotask(() => this.onmessage?.({ data: reply }));
      }
    }
    terminate(): void { this.terminated = true; }
  }
  function big(n: number): Graph {
    const nodes: GraphNode[] = [prompt('p1', 't1', 0), dispatch('d1', 't1', null, 'A', 10, 9_000, { messageId: 'm1' })];
    for (let i = 0; i < n; i++) nodes.push(tool(`a${i}`, null, 'A', 20 + i, 21 + i));
    nodes.push(text('x', 't1', null, 9_500, { messageId: 'm2' }));
    return graph(nodes);
  }
  const s = sessionOf('claude');
  const clock = ended(10_000);

  test('a small session is computed on the page’s thread: no worker', async () => {
    const created: FakeWorker[] = [];
    const c = createTimelineClient(() => { const w = new FakeWorker(); created.push(w); return w; });
    const g = claudeGraph();
    expect(await c.compute(g, s, clock)).toEqual(computeAgentTimeline(g, s, clock));
    expect(created).toHaveLength(0);
    c.dispose();
  });

  test('a large one goes to the worker, which gets the whole graph once and then only what changed', async () => {
    const w = new FakeWorker();
    const c = createTimelineClient(() => w, { inThreadBelow: 100 });
    const g1 = big(200);
    expect(await c.compute(g1, s, clock)).toEqual(computeAgentTimeline(g1, s, clock));
    expect(w.sent[0]!.reset).toBe(true);
    expect(w.sent[0]!.upserts).toHaveLength(Object.keys(g1.nodes).length);
    // Same graph, new clock: nothing to send but the clock.
    await c.compute(g1, s, ended(20_000));
    expect(w.sent[1]!.upserts).toHaveLength(0);
    expect(w.sent[1]!.removals).toHaveLength(0);
    // One node changed, one added, one removed.
    const nodes = { ...g1.nodes };
    nodes.x = { ...nodes.x!, summary: 'changed' };
    nodes.extra = text('extra', 't1', null, 9_600);
    delete nodes.a5;
    const g2: Graph = { nodes, edges: {} };
    expect(await c.compute(g2, s, clock)).toEqual(computeAgentTimeline(g2, s, clock));
    expect(w.sent[2]!.reset).toBe(false);
    expect(w.sent[2]!.upserts.map((n) => n.id).sort()).toEqual(['extra', 'x']);
    expect(w.sent[2]!.removals).toEqual(['a5']);
    c.dispose();
    expect(w.terminated).toBe(true);
  });

  test('a worker that fails: pending requests are answered on the page’s thread, and so is everything after', async () => {
    const w = new FakeWorker();
    w.auto = false;
    const created: FakeWorker[] = [];
    const c = createTimelineClient(() => { created.push(w); return w; }, { inThreadBelow: 100 });
    const g = big(200);
    const p = c.compute(g, s, clock);
    w.onerror?.({ message: 'crashed' });
    expect(await p).toEqual(computeAgentTimeline(g, s, clock));
    expect(w.terminated).toBe(true);
    expect(await c.compute(g, s, clock)).toEqual(computeAgentTimeline(g, s, clock));
    expect(created).toHaveLength(1);
  });

  test('the threshold: one node below it no worker is created; at it, one is', async () => {
    const created: FakeWorker[] = [];
    const c = createTimelineClient(() => { const w = new FakeWorker(); created.push(w); return w; }, { inThreadBelow: 100 });
    const below = big(96);
    expect(Object.keys(below.nodes)).toHaveLength(99);
    expect(await c.compute(below, s, clock)).toEqual(computeAgentTimeline(below, s, clock));
    expect(created).toHaveLength(0);
    const at = big(97);
    expect(Object.keys(at.nodes)).toHaveLength(100);
    expect(await c.compute(at, s, clock)).toEqual(computeAgentTimeline(at, s, clock));
    expect(created).toHaveLength(1);
    expect(created[0]!.sent).toHaveLength(1);
    c.dispose();
  });

  test('the view’s client lives only while the view shows: created on start, disposed (worker released) on stop', () => {
    let made = 0;
    let disposed = 0;
    const source = {
      live: false, getGraph: () => claudeGraph(), getSession: () => sessionOf('claude'), subscribe: () => () => {},
      createTimelineClient(): TimelineClient {
        made++;
        const inner = createInThreadTimelineClient();
        return { compute: inner.compute, dispose: () => { disposed++; inner.dispose(); } };
      },
    };
    const stop = startAgentTimeline(source, { onResult: () => {} });
    expect([made, disposed]).toEqual([1, 0]);
    stop();
    expect([made, disposed]).toEqual([1, 1]);
    const again = startAgentTimeline(source, { onResult: () => {} });
    expect([made, disposed]).toEqual([2, 1]);
    again();
    expect([made, disposed]).toEqual([2, 2]);
  });
});

describe('when it is computed', () => {
  afterEach(() => { vi.useRealTimers(); });

  /** A client whose answers the test releases by hand. */
  function manualClient(): TimelineClient & { calls: { graph: Graph; clock: WaterfallClock; resolve(): void }[] } {
    const calls: { graph: Graph; clock: WaterfallClock; resolve(): void }[] = [];
    return {
      calls,
      compute(graph, session, clock) {
        return new Promise((resolve) => {
          calls.push({ graph, clock, resolve: () => resolve(computeAgentTimeline(graph, session, clock)) });
        });
      },
      dispose() {},
    };
  }
  function liveSource(g: Graph, session: Session): Pick<SessionSource, 'getGraph' | 'getSession' | 'subscribe' | 'live'> & { set(g: Graph, s?: Session): void } {
    const listeners = new Set<() => void>();
    let cur = g;
    let ses = session;
    return {
      live: true,
      getGraph: () => cur,
      getSession: () => ses,
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      set(next, s) { cur = next; if (s) ses = s; for (const fn of listeners) fn(); },
    };
  }

  test('again when the graph changes (throttled), one at a time, the newest graph last', async () => {
    vi.useFakeTimers();
    const g1 = claudeGraph();
    const src = liveSource(g1, sessionOf('claude', { status: 'idle', lastActivityAt: iso(0) }));
    const client = manualClient();
    const got: Graph[] = [];
    const stop = watchAgentTimeline({ source: src, client, onResult: (_r, g) => got.push(g) });
    expect(client.calls).toHaveLength(1);
    const g2 = { ...g1, nodes: { ...g1.nodes } };
    const g3 = { ...g1, nodes: { ...g1.nodes } };
    src.set(g2);
    src.set(g3);
    await vi.advanceTimersByTimeAsync(100);
    // Still one in flight: nothing new starts until it answers.
    expect(client.calls).toHaveLength(1);
    client.calls[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]!.graph).toBe(g3);
    client.calls[1]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual([g1, g3]);
    stop();
  });

  test('every second while the clock ticks, once more when it stops, then not again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH + 10_000);
    const running = sessionOf('claude', { status: 'running', lastActivityAt: iso(10_000) });
    const src = liveSource(claudeGraph(), running);
    const client = createInThreadTimelineClient();
    const totals: number[] = [];
    const g = graph([prompt('p1', 't1', 0), tool('t', 't1', null, 100, null)]);
    src.set(g);
    const stop = watchAgentTimeline({ source: src, client, onResult: (r) => { if (r.available) totals.push(r.totalMs); } });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(totals).toEqual([10_000, 11_000, 12_000, 13_000]);
    // The session ends: computed once more with the stopped clock (its last activity), then no more ticks.
    src.set(g, { ...running, status: 'ended' });
    await vi.advanceTimersByTimeAsync(100);
    const after = totals.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(totals.length).toBe(after);
    expect(totals[totals.length - 1]).toBe(10_000);
    stop();
  });

  test('a snapshot (the exported viewer) is computed with the snapshot clock and never re-ticks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH + 999_000);
    const g = graph([prompt('p1', 't1', 0), tool('t', 't1', null, 100, null), dispatch('d1', 't1', null, 'A', 200, null, { messageId: 'm1' })]);
    const session = sessionOf('claude', { status: 'running', lastActivityAt: iso(5000) });
    const bundle = {
      version: 1, exportedAt: iso(6000), session, nodes: Object.values(g.nodes), edges: [], details: {}, truncations: {}, unreadable: [],
      options: { scope: { kind: 'session' }, mask: {}, output: 'full' }, report: { byType: {} },
    } as unknown as ExportBundle;
    const src = createDisplaySource(embeddedSource(bundle, () => { throw new Error('unused'); }), IDENTITY_MASKER);
    expect(src.createTimelineClient).toBeUndefined(); // the viewer computes on its own thread
    const results: AgentTimelineResult[] = [];
    const stop = watchAgentTimeline({ source: src, client: createInThreadTimelineClient(), onResult: (r) => results.push(r) });
    await vi.advanceTimersByTimeAsync(5000);
    expect(results).toEqual([computeAgentTimeline(src.getGraph(), session, snapshotClock(session))]);
    const r = results[0]!;
    expect(r.available && r.totalMs).toBe(5000);
    expect(r.available && r.root.open).toBe(false);
    stop();
  });

  test('stopped: a late answer is dropped', async () => {
    const client = manualClient();
    const src = liveSource(claudeGraph(), sessionOf('claude'));
    const got: unknown[] = [];
    const stop = watchAgentTimeline({ source: src, client, onResult: (r) => got.push(r) });
    stop();
    client.calls[0]!.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(got).toEqual([]);
  });
});

describe('masking', () => {
  test('labels and the dispatching step come from the page’s (masked) graph', () => {
    const TERM = 'Falcon' + 'Project';
    const raw = graph([
      prompt('p1', 't1', 0),
      dispatch('d1', 't1', null, 'A', 1000, 3000, { title: `Explore ${TERM}`, summary: `look at ${TERM}`, messageId: 'm1' }),
      tool('a1', null, 'A', 1100, 2900),
      text('x', 't1', null, 3500, { messageId: 'm2' }),
    ]);
    const source: SessionSource = {
      getSession: () => sessionOf('claude'), getGraph: () => raw, subscribe: () => () => {}, live: true,
      nodeDetail: async () => ({ detail: null, outputOriginalBytes: null }), files: null, anomalies: null,
      createLayoutClient: () => { throw new Error('unused'); },
      createTimelineClient: () => createInThreadTimelineClient(),
    };
    const shown = createDisplaySource(source, createPageMasker({ customTerms: [TERM], numbered: true }));
    expect(shown.createTimelineClient).toBeDefined(); // forwarded
    const g = shown.getGraph();
    const tl = timeline(g);
    const html = render(props({ result: tl, graph: g }));
    expect(html).not.toContain(TERM);
    const a = tl.root.children[0]!;
    expect(threadTooltip(a, { graph: g, steps: null })).not.toContain(TERM);
  });
});
