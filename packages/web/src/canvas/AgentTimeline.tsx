/**
 * The 时间线 view (spec docs/superpowers/specs/2026-11-24-agent-timeline-design.md, section 4): the main thread and every
 * subagent on one time axis, one row per thread (nested agents indented under the thread that dispatched them), ranked
 * by how long the main thread waited for each, with each one's own time alongside. It takes the place of the canvas;
 * the execution (waterfall) panel below follows what is clicked here. The numbers come from computeAgentTimeline
 * (agentTime.ts), run through a TimelineClient (timelineClient.ts). Nothing here loads a worker by URL: the exported
 * viewer renders this too.
 */
import {
  memo, useEffect, useId, useMemo, useState, type CSSProperties, type KeyboardEvent, type MouseEvent,
} from 'react';
import type { Graph, GraphNode, Origin } from '@agent-canvas/shared';
import type { SessionSource } from '../sessionSource';
import { graphTurns } from '../anomalies';
import { formatSpan } from '../stats';
import { MAIN_THREAD_ID, sortThreads, type AgentTimeline, type AgentTimelineResult, type ThreadTime, type TimeSpan } from './agentTime';
import { isNoise } from './compact';
import { usageLabel } from './replay';
import { startAgentTimeline } from './timelineClient';
import { byTimeThenId, groupByTurn, type Entry } from './view';
import { scopeKey, type WaterfallScope } from './waterfall';

export type TimelineSort = 'wait' | 'start';

export const TIMELINE_NO_TIMES_DOUBAO = '这个来源没有记录每一步的时间，无法生成时间线';
export const TIMELINE_NO_TIMES = '这个会话的步骤没有可读的时间，无法生成时间线';
export const TIMELINE_NO_AGENTS = '这个会话没有派出子代理';
const UNMATCHED_PREFIX = 'unmatched:';

// ---- rows ----

export interface TimelineRow { thread: ThreadTime; depth: number }

/** The rows top to bottom: main first, then each thread followed by its own agents (one level deeper), siblings sorted. */
export function timelineRows(root: ThreadTime, sort: TimelineSort): TimelineRow[] {
  const out: TimelineRow[] = [];
  const stack: TimelineRow[] = [{ thread: sortThreads(root, sort), depth: 0 }];
  while (stack.length > 0) {
    const row = stack.pop()!;
    out.push(row);
    const kids = row.thread.children;
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ thread: kids[i]!, depth: row.depth + 1 });
  }
  return out;
}

/** Per thread ('main' for the main thread), its nodes with something to read (the 精简 rule, compact.ts isNoise). */
export function compactStepCounts(graph: Graph): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of Object.values(graph.nodes)) {
    if (isNoise(n)) continue;
    const id = n.agentId ?? MAIN_THREAD_ID;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

const clockText = (ms: number): string => new Date(ms).toLocaleTimeString();

/**
 * A row's tooltip: its name, the step that dispatched it, start and end (or 进行中), the step count (`steps`: the 精简
 * counts, null for 完整), the tokens, and how often it was dispatched when more than once.
 */
export function threadTooltip(t: ThreadTime, { graph, steps }: { graph: Graph; steps: ReadonlyMap<string, number> | null }): string {
  const lines = [t.label];
  if (t.id !== MAIN_THREAD_ID) {
    if (t.id.startsWith(UNMATCHED_PREFIX)) lines.push('未配上的子代理：派出的那一步没有记下是哪个子代理');
    const d = t.dispatchIds.length > 0 ? graph.nodes[t.dispatchIds[0]!] : undefined;
    lines.push(d !== undefined ? `派出它的一步：${[d.title, d.summary].filter(Boolean).join(' · ')}` : '找不到派出它的一步');
  }
  if (t.segments.length > 0) {
    const start = t.segments[0]!.startMs;
    const end = t.segments[t.segments.length - 1]!.endMs;
    lines.push(`开始 ${clockText(start)} · ${t.open ? '进行中' : `结束 ${clockText(end)}`}`);
  }
  lines.push(`步骤 ${steps === null ? t.steps : steps.get(t.id) ?? 0}`);
  lines.push(`token：${usageLabel(t.usage)}`);
  if (t.dispatchIds.length > 1) lines.push(`派出 ${t.dispatchIds.length} 次`);
  return lines.join('\n');
}

// ---- what a click opens in the execution panel ----
//
// The view re-renders every second while the clock ticks: nothing on that path may be linear in the graph. Lookups that
// need the whole graph are made at most once per graph object (kept in WeakMaps, so a new graph is looked at again).

/** Main-thread node id -> turn key (view.ts groupByTurn), per graph object; only for nodes without a turnId. */
const turnsByGraph = new WeakMap<Graph, Map<string, string>>();
let groupings = 0;
/** How often the graph had to be grouped into turns (tests: once per graph object at most). */
export function turnGroupings(): number {
  return groupings;
}

/**
 * The turn of a main-thread node, as turnKeyOf finds it: a node with a turnId belongs to that turn (groupByTurn's rule,
 * no lookup needed); one without is looked up in one grouping of the graph, made once per graph object.
 */
function mainTurnOf(graph: Graph, n: GraphNode): string | null {
  if (n.turnId !== null) return n.turnId;
  let turnOf = turnsByGraph.get(graph);
  if (turnOf === undefined) {
    groupings++;
    const main: Entry[] = [];
    for (const node of Object.values(graph.nodes)) {
      if (node.agentId !== null) continue;
      const ms = Date.parse(node.timestamp);
      main.push({ node, ms: Number.isNaN(ms) ? 0 : ms });
    }
    main.sort(byTimeThenId);
    turnOf = groupByTurn(main).turnOf;
    turnsByGraph.set(graph, turnOf);
  }
  return turnOf.get(n.id) ?? null;
}

/** The panel scope of a node: its agent's steps, or its turn's (main thread); null when the node is not known. */
export function scopeOfNode(graph: Graph, nodeId: string): WaterfallScope | null {
  const n = graph.nodes[nodeId];
  if (n === undefined) return null;
  if (n.agentId !== null) return { type: 'agent', agentId: n.agentId };
  const turnKey = mainTurnOf(graph, n);
  return turnKey === null ? null : { type: 'turn', turnKey };
}

/** A row's panel scope: the agent's steps; an unmatched dispatch's: the turn (or agent) it was dispatched in. */
export function threadScope(graph: Graph, t: ThreadTime): WaterfallScope | null {
  if (t.id === MAIN_THREAD_ID) return null;
  if (!t.id.startsWith(UNMATCHED_PREFIX)) return { type: 'agent', agentId: t.id };
  return t.dispatchIds.length > 0 ? scopeOfNode(graph, t.dispatchIds[0]!) : null;
}

/** The turn at a moment of the main bar: the latest-starting turn whose interval contains it; null outside every turn. */
export function turnAt(turnSpans: readonly { turnKey: string; startMs: number; endMs: number }[], ms: number): string | null {
  let best: { turnKey: string; startMs: number } | null = null;
  for (const s of turnSpans) {
    if (s.startMs <= ms && ms <= s.endMs && (best === null || s.startMs >= best.startMs)) best = s;
  }
  return best?.turnKey ?? null;
}

const promptsByGraph = new WeakMap<Graph, Map<string, string>>();
const dispatchesByGraph = new WeakMap<Graph, Map<string, GraphNode>>();

/**
 * The panel's title while the timeline shows: the turn's prompt, or the dispatching step of the agent. `turnPrompt`:
 * the prompt summary of a turn as the canvas already knows it (its view's turns; undefined when it does not have that
 * turn, e.g. a replay before it); otherwise the graph is grouped into turns once per graph object.
 */
export function panelTitle(
  graph: Graph, scope: WaterfallScope, timeline: AgentTimeline | null, turnPrompt: (turnKey: string) => string | undefined,
): string {
  if (scope.type === 'turn') {
    let prompt = turnPrompt(scope.turnKey);
    if (prompt === undefined) {
      let prompts = promptsByGraph.get(graph);
      if (prompts === undefined) {
        prompts = new Map(graphTurns(graph).map((t) => [t.key, t.promptSummary]));
        promptsByGraph.set(graph, prompts);
      }
      prompt = prompts.get(scope.turnKey);
    }
    return prompt || '（无提示）';
  }
  let dispatchId: string | undefined;
  if (timeline !== null) {
    const stack = [timeline.root];
    while (dispatchId === undefined && stack.length > 0) {
      const t = stack.pop()!;
      if (t.id === scope.agentId) dispatchId = t.dispatchIds[0];
      else stack.push(...t.children);
    }
  }
  let d = dispatchId !== undefined ? graph.nodes[dispatchId] : undefined;
  if (d === undefined) {
    let byAgent = dispatchesByGraph.get(graph);
    if (byAgent === undefined) {
      byAgent = new Map();
      for (const n of Object.values(graph.nodes)) {
        if (n.kind === 'subagent' && n.childAgentId !== null && !byAgent.has(n.childAgentId)) byAgent.set(n.childAgentId, n);
      }
      dispatchesByGraph.set(graph, byAgent);
    }
    d = byAgent.get(scope.agentId);
  }
  return d === undefined ? '' : [d.title, d.summary].filter(Boolean).join(' · ');
}

/** One row as the view draws it (computed on every render: nothing linear in the graph). */
export interface TimelineRowModel {
  thread: ThreadTime;
  depth: number;
  /** What a click on it lists in the execution panel (null: the main row, which picks a turn by where it is clicked). */
  scope: WaterfallScope | null;
  /** Highlighted: an agent whose steps the panel lists; the main row or an unmatched row only when the reader picked it. */
  selected: boolean;
  longest: boolean;
  /** The tooltip (also the row's accessible description). */
  details: string;
}

/**
 * The rows of a timeline with what each needs: main first with its own numbers (own time, and the rest as its wait),
 * then the agents in `sort` order. `panelKey`: scopeKey of what the panel lists; `pickedRow`: the row the reader picked
 * (a turn listed because the panel follows the latest turn, or because of a link, highlights no row).
 */
export function timelineRowModel(timeline: AgentTimeline, o: {
  graph: Graph; sort: TimelineSort; steps: ReadonlyMap<string, number> | null; panelKey: string | null; pickedRow: string | null;
}): TimelineRowModel[] {
  return timelineRows(timeline.root, o.sort).map(({ thread, depth }) => {
    const main = thread.id === MAIN_THREAD_ID;
    const t = main ? { ...thread, ownMs: timeline.mainOwnMs, waitMs: timeline.mainWaitMs } : thread;
    const scope = threadScope(o.graph, t);
    const shown = o.panelKey !== null;
    const selected = main
      ? shown && o.pickedRow === MAIN_THREAD_ID
      : scope !== null && shown && scopeKey(scope) === o.panelKey && (!t.id.startsWith(UNMATCHED_PREFIX) || o.pickedRow === t.id);
    return { thread: t, depth, scope, selected, longest: t.id === timeline.longestWaitId, details: threadTooltip(t, o) };
  });
}

/**
 * The main bar's keyboard: the turn to show after `key` (arrows step between turns; from none, → is the first and ←
 * the last; Home / End), or null for a key that does not move.
 */
export function stepTurn(current: number | null, key: string, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowRight': case 'ArrowDown': return current === null ? 0 : Math.min(count - 1, current + 1);
    case 'ArrowLeft': case 'ArrowUp': return current === null ? count - 1 : Math.max(0, current - 1);
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

// ---- the axis ----

export interface AxisScale {
  /** A time -> its place on the axis, 0..1 (clamped). */
  toX(ms: number): number;
  /** A place on the axis -> the time there (inside a break: interpolated across it). */
  fromX(x: number): number;
  /** The compressed gaps: where they are drawn and how wide. */
  breaks: { x: number; width: number }[];
  /**
   * Labelled times: the start of each shown stretch (`start`), and evenly spaced ones inside wide stretches; never in
   * a break.
   */
  ticks: { x: number; ms: number; start: boolean }[];
}

/** Each break takes this share of the axis (all of them together at most MAX_BREAKS_SHARE). */
const BREAK_SHARE = 0.03;
const MAX_BREAKS_SHARE = 0.3;
/** Labels closer than this (a share of the axis) would overlap. */
const MIN_TICK_GAP = 0.12;
const TICK_EVERY = 0.2;

interface Piece { fromMs: number; toMs: number; fromX: number; toX: number; gap: boolean }

/** The axis with its quiet gaps compressed to a fixed width; the stretches between them keep their proportions. */
export function axisScale(axis: { startMs: number; endMs: number; breaks: readonly TimeSpan[] }): AxisScale {
  const { startMs } = axis;
  const endMs = Math.max(axis.endMs, startMs + 1);
  const breaks = axis.breaks
    .filter((b) => b.endMs > b.startMs && b.startMs >= startMs && b.endMs <= endMs)
    .slice().sort((a, b) => a.startMs - b.startMs);
  const gap = breaks.length === 0 ? 0 : Math.min(BREAK_SHARE, MAX_BREAKS_SHARE / breaks.length);
  let hidden = 0;
  for (const b of breaks) hidden += b.endMs - b.startMs;
  const perMs = (1 - breaks.length * gap) / Math.max(1, endMs - startMs - hidden);
  const pieces: Piece[] = [];
  let ms = startMs;
  let x = 0;
  for (const b of breaks) {
    const shownTo = x + Math.max(0, b.startMs - ms) * perMs;
    pieces.push({ fromMs: ms, toMs: b.startMs, fromX: x, toX: shownTo, gap: false });
    pieces.push({ fromMs: b.startMs, toMs: b.endMs, fromX: shownTo, toX: shownTo + gap, gap: true });
    x = shownTo + gap;
    ms = b.endMs;
  }
  pieces.push({ fromMs: ms, toMs: endMs, fromX: x, toX: 1, gap: false });

  const lerp = (v: number, a0: number, a1: number, b0: number, b1: number): number => (a1 === a0 ? b0 : b0 + ((v - a0) / (a1 - a0)) * (b1 - b0));
  /** The last piece whose start (by `key`) is at or before `v`. */
  const pieceAt = (v: number, key: 'fromMs' | 'fromX'): Piece => {
    let lo = 0;
    let hi = pieces.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pieces[mid]![key] <= v) lo = mid;
      else hi = mid - 1;
    }
    return pieces[lo]!;
  };
  const toX = (t: number): number => {
    if (!(t > startMs)) return 0;
    if (t >= endMs) return 1;
    const p = pieceAt(t, 'fromMs');
    return lerp(t, p.fromMs, p.toMs, p.fromX, p.toX);
  };
  const fromX = (v: number): number => {
    if (!(v > 0)) return startMs;
    if (v >= 1) return endMs;
    const p = pieceAt(v, 'fromX');
    return lerp(v, p.fromX, p.toX, p.fromMs, p.toMs);
  };

  const ticks: { x: number; ms: number; start: boolean }[] = [];
  for (const p of pieces) {
    if (p.gap) continue;
    const prev = ticks[ticks.length - 1];
    if (prev === undefined || p.fromX - prev.x >= MIN_TICK_GAP) {
      ticks.push({ x: p.fromX, ms: p.fromMs, start: true });
    } else if (!prev.start) {
      ticks[ticks.length - 1] = { x: p.fromX, ms: p.fromMs, start: true }; // a stretch's start matters more than a tick inside
    }
    const n = Math.floor((p.toX - p.fromX) / TICK_EVERY);
    for (let i = 1; i < n; i++) {
      const tx = p.fromX + (i * (p.toX - p.fromX)) / n;
      if (tx - ticks[ticks.length - 1]!.x >= MIN_TICK_GAP && 1 - tx >= MIN_TICK_GAP / 2) {
        ticks.push({ x: tx, ms: lerp(tx, p.fromX, p.toX, p.fromMs, p.toMs), start: false });
      }
    }
  }
  return { toX, fromX, breaks: pieces.filter((p) => p.gap).map((p) => ({ x: p.fromX, width: p.toX - p.fromX })), ticks };
}

// ---- computing ----

/**
 * The timeline of `source`, kept current while `active` (see watchAgentTimeline): through the source's client (the
 * app's moves a large session into a worker), else on the page's own thread. The last result stays while inactive.
 */
export function useAgentTimeline(source: SessionSource, active: boolean): { result: AgentTimelineResult | null; error: string | null } {
  const [state, setState] = useState<{ result: AgentTimelineResult | null; error: string | null }>({ result: null, error: null });
  // A new client (and worker) each time the view is shown; leaving the view disposes it (startAgentTimeline).
  useEffect(() => (active
    ? startAgentTimeline(source, {
      onResult: (result) => setState({ result, error: null }),
      onError: (err) => setState((s) => ({ result: s.result, error: err.message })),
    })
    : undefined), [active, source]);
  return state;
}

// ---- the view ----

export interface AgentTimelineViewProps {
  /** null until the first result. */
  result: AgentTimelineResult | null;
  /** The last computation failed (the previous result, if any, stays). */
  error: string | null;
  origin: Origin;
  /** The page's (masked) graph: the dispatching steps and the 精简 step counts in the tooltips; unmatched rows' turns. */
  graph: Graph;
  /** 精简: tooltips count only steps with something to read. */
  compact: boolean;
  sort: TimelineSort;
  onSortChange(sort: TimelineSort): void;
  /** scopeKey of what the execution panel lists; null when it is closed. */
  panelKey: string | null;
  /** The row the reader picked ('main' for the main bar; see timelineRowModel); null: none. */
  pickedRow: string | null;
  /** A row (an agent) or a point of the main bar (a turn) was picked; `row` is the picked row's id. */
  onPickScope(scope: WaterfallScope, row: string): void;
}

const pct = (x: number): string => `${(x * 100).toFixed(3)}%`;

/**
 * Bars (and light overlays) for spans; nothing for a span of zero width. `runningLast`: the thread is still at work, so
 * its last span (the one still growing) is drawn running.
 */
function spansOn(spans: readonly TimeSpan[], scale: AxisScale, className: string, runningLast = false): JSX.Element[] {
  const out: JSX.Element[] = [];
  spans.forEach((s, i) => {
    const a = scale.toX(s.startMs);
    const b = scale.toX(s.endMs);
    if (!(b > a)) return;
    const running = runningLast && i === spans.length - 1;
    out.push(<span key={`${className}${s.startMs}`} className={running ? `${className} cc-tl-running` : className} style={{ left: pct(a), width: pct(b - a) }} />);
  });
  return out;
}

/**
 * The main bar: a click picks the turn at that moment. It is focusable: arrow keys (Home / End) move between turns,
 * Enter or Space opens the one shown, which a live region names.
 */
function MainTrack({ thread: t, scale, turnSpans, describedBy, onPickScope }: {
  thread: ThreadTime; scale: AxisScale; turnSpans: AgentTimeline['turnSpans']; describedBy: string;
  onPickScope(scope: WaterfallScope, row: string): void;
}) {
  const [turn, setTurn] = useState<number | null>(null);
  const span = turn !== null ? turnSpans[turn] : undefined;
  const pickHere = (e: MouseEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const key = turnAt(turnSpans, scale.fromX((e.clientX - rect.left) / rect.width));
    if (key !== null) onPickScope({ type: 'turn', turnKey: key }, MAIN_THREAD_ID);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if ((e.key === 'Enter' || e.key === ' ') && span !== undefined) {
      e.preventDefault();
      onPickScope({ type: 'turn', turnKey: span.turnKey }, MAIN_THREAD_ID);
      return;
    }
    const next = stepTurn(turn, e.key, turnSpans.length);
    if (next === null) return;
    e.preventDefault();
    setTurn(next);
  };
  const a = span !== undefined ? scale.toX(span.startMs) : 0;
  const b = span !== undefined ? scale.toX(span.endMs) : 0;
  return (
    <div className="cc-tl-track cc-tl-main-track" tabIndex={0} role="group"
      aria-label="主线：左右方向键选一轮，回车在执行过程里打开" aria-describedby={describedBy}
      onClick={pickHere} onKeyDown={onKeyDown} onBlur={() => setTurn(null)}>
      {spansOn(t.segments, scale, 'cc-tl-bar', t.open)}
      {spansOn(t.waitingSpans, scale, 'cc-tl-waiting')}
      {span !== undefined && <span className="cc-tl-turnfocus" style={{ left: pct(a), width: pct(Math.max(0, b - a)) }} />}
      <span className="visually-hidden" aria-live="polite">
        {span !== undefined ? `第 ${turn! + 1} 轮（共 ${turnSpans.length} 轮）：${clockText(span.startMs)} 到 ${clockText(span.endMs)}` : ''}
      </span>
    </div>
  );
}

const Row = memo(function Row({ row, scale, turnSpans, onPickScope }: {
  row: TimelineRowModel; scale: AxisScale; turnSpans: AgentTimeline['turnSpans']; onPickScope(scope: WaterfallScope, row: string): void;
}) {
  const { thread: t, depth, scope, selected, longest, details } = row;
  const main = t.id === MAIN_THREAD_ID;
  const detailsId = useId();
  const pick = scope === null ? undefined : () => onPickScope(scope, t.id);
  return (
    <div className={`cc-tl-row${main ? ' cc-tl-main' : ''}${selected ? ' cc-tl-selected' : ''}`} data-id={t.id}
      style={{ ['--depth' as string]: depth } as CSSProperties} title={details} onClick={main ? undefined : pick}>
      <div className="cc-tl-name">
        {main
          ? <span className="cc-tl-label">{t.label}</span>
          : (
            <button type="button" className="cc-tl-pick" aria-current={selected ? 'true' : undefined} aria-describedby={detailsId}>
              <span className="cc-tl-label">{t.label}</span>
            </button>
          )}
        {t.id.startsWith(UNMATCHED_PREFIX) && <span className="cc-tl-tag">未配上</span>}
        {t.open && <span className="cc-tl-open">进行中</span>}
        <span id={detailsId} className="visually-hidden">{details}</span>
      </div>
      {main
        ? <MainTrack thread={t} scale={scale} turnSpans={turnSpans} describedBy={detailsId} onPickScope={onPickScope} />
        : (
          <div className="cc-tl-track">
            {spansOn(t.segments, scale, 'cc-tl-bar', t.open)}
            {spansOn(t.waitingSpans, scale, 'cc-tl-waiting')}
          </div>
        )}
      {main
        ? <span className="cc-tl-main-nums">{`自己 ${formatSpan(t.ownMs)} · 等 ${formatSpan(t.waitMs)}`}</span>
        : (
          <>
            <span className="cc-tl-wait" aria-label={`等待 ${formatSpan(t.waitMs)}`}>{formatSpan(t.waitMs)}</span>
            <span className="cc-tl-own" aria-label={`各自用时 ${formatSpan(t.ownMs)}`}>{formatSpan(t.ownMs)}</span>
          </>
        )}
      <span className="cc-tl-mark">{longest && <span className="cc-tl-longest">最长</span>}</span>
    </div>
  );
});

/** The 时间线 view (in the canvas's place). */
export const AgentTimelineView = memo(function AgentTimelineView({
  result, error, origin, graph, compact, sort, onSortChange, panelKey, pickedRow, onPickScope,
}: AgentTimelineViewProps) {
  const timeline = result !== null && result.available ? result : null;
  const scale = useMemo(() => (timeline === null ? null : axisScale(timeline.axis)), [timeline]);
  // Once per graph change (not per tick).
  const steps = useMemo(() => (compact ? compactStepCounts(graph) : null), [graph, compact]);
  const rows = useMemo(
    () => (timeline === null ? [] : timelineRowModel(timeline, { graph, sort, steps, panelKey, pickedRow })),
    [timeline, graph, sort, steps, panelKey, pickedRow],
  );
  if (timeline === null || scale === null) {
    const note = result === null
      ? (error !== null ? `时间线算不出来：${error}` : '计算中…')
      : origin === 'doubao' ? TIMELINE_NO_TIMES_DOUBAO : TIMELINE_NO_TIMES;
    return (
      <section className="cc-tl" aria-label="时间线">
        <p className="cc-tl-note" role="status">{note}</p>
      </section>
    );
  }
  const main = timeline.root;
  const ticks = scale.ticks;
  const shortAxis = timeline.axis.endMs - timeline.axis.startMs - timeline.axis.breaks.reduce((s, b) => s + b.endMs - b.startMs, 0) < 10 * 60_000;
  const tickText = (ms: number): string => (shortAxis
    ? new Date(ms).toLocaleTimeString()
    : new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  // Breaks and ticks in the order of their place: a break comes right before the tick of the stretch after it, whose
  // label is then moved clear of the drawn mark (canvas.css, `.cc-tl-break + .cc-tl-tick`).
  const axisMarks = [
    ...scale.breaks.map((b) => ({ x: b.x, order: 0, el: <span key={`b${b.x}`} className="cc-tl-break" style={{ left: pct(b.x), width: pct(b.width) }}>//</span> })),
    ...ticks.map((tk) => ({
      x: tk.x, order: 1,
      el: <span key={`t${tk.x}`} className={`cc-tl-tick${tk.start ? ' cc-tl-tick-start' : ''}`} style={{ left: pct(tk.x) }}>{tickText(tk.ms)}</span>,
    })),
  ].sort((a, b) => a.x - b.x || a.order - b.order);
  const lastTick = ticks[ticks.length - 1];
  return (
    <section className="cc-tl" aria-label="时间线">
      <div className="cc-tl-head">
        <span className="cc-tl-total">{`总用时 ${formatSpan(timeline.totalMs)} · ${timeline.turns} 轮`}</span>
        <div className="cc-tl-sort" role="group" aria-label="排序">
          <span className="cc-tl-sort-label">排序：</span>
          <div className="view-switch">
            <button type="button" aria-pressed={sort === 'wait'} onClick={() => onSortChange('wait')}
              title="同一层里，主线等它最久的排在前面">等待时间</button>
            <button type="button" aria-pressed={sort === 'start'} onClick={() => onSortChange('start')}
              title="同一层里，先开始的排在前面">开始时间</button>
          </div>
        </div>
        {error !== null && <span className="cc-tl-error" role="status">{`更新失败：${error}`}</span>}
      </div>
      {/* The column names are on each number too (aria-label), so this row is for the eye only. */}
      <div className="cc-tl-cols" aria-hidden="true">
        <span />
        <span />
        <span className="cc-tl-colname" title="主线在等它的时间（同一刻只算给一个子代理）">等待</span>
        <span className="cc-tl-colname" title="它自己从被派出到干完的时间（并行的各算各的）">各自用时</span>
        <span />
      </div>
      <div className="cc-tl-body">
        {rows.map((row) => (
          <Row key={row.thread.id} row={row} scale={scale} turnSpans={timeline.turnSpans} onPickScope={onPickScope} />
        ))}
        {main.children.length === 0 && <p className="cc-tl-note">{TIMELINE_NO_AGENTS}</p>}
      </div>
      <div className="cc-tl-axisrow" aria-hidden="true">
        <span />
        <div className="cc-tl-axis">
          {axisMarks.map((m) => m.el)}
          {(lastTick === undefined || lastTick.x < 0.8) && <span className="cc-tl-tick cc-tl-tick-end">{tickText(timeline.axis.endMs)}</span>}
        </div>
      </div>
    </section>
  );
});
