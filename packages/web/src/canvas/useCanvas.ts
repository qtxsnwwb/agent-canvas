import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Graph, Usage } from '@claude-canvas/shared';
import type { LiveSession } from '../client';
import { createThrottle } from '../throttle';
import { groupInput, placeAgentGroups, wrapTurns, turnInput, type Box, type TurnLayout } from './layout';
import { createBrowserLayoutWorker, createLayoutClient, type LayoutClient } from './layoutClient';
import { clampToRange, graphAt, replayRange, turnMarks, usageTotal, type ReplayRange } from './replay';
import { createCompactor, type CompactResult } from './compact';
import { containerSize } from './sizes';
import { agentGroupKey, buildView, type AgentGroup, type CanvasView, type ViewMode } from './view';

/**
 * The replay view's timeline state. `range` and `marks` (main-thread prompts) come from the whole live graph; `totals`
 * count every node of the replayed graph (agents' inner nodes included), usage deduplicated by messageId.
 */
export interface ReplayInfo {
  range: ReplayRange | null;
  timeMs: number;
  marks: { turnId: string; ms: number }[];
  totals: { nodeCount: number; usage: Usage };
}

export interface CanvasSnapshot {
  view: CanvasView;
  /** Only view nodes whose position has been computed; the canvas does not draw the others yet. */
  positions: Record<string, { x: number; y: number }>;
  turnBoxes: Record<string, Box>;
  /**
   * Expanded container node id -> its box (position and expanded size). Only containers still expanded in `view` whose
   * inner layout has landed; inner nodes are positioned inside it.
   */
  containerBoxes: Record<string, Box>;
  /**
   * The view mode `positions` were laid out for. After a mode switch it keeps the old mode until the new mode's round
   * lands: node sizes (see sizeOf) must follow the positions, not `view.mode`.
   */
  layoutMode: ViewMode;
  layoutError: string | null;
  /** The replay timeline (see CanvasModel.getReplay); null outside the replay view. */
  replay: ReplayInfo | null;
  /** Whether the view is built from the compacted graph (see CanvasModel.setCompact). */
  compact: boolean;
}
export interface CanvasModel {
  getSnapshot(): CanvasSnapshot;
  subscribe(fn: () => void): () => void;
  /** Flips the turn's current expanded/collapsed state and records it as an override. */
  toggleTurn(turnKey: string): void;
  /** Expands the turn if it is collapsed (recorded as an override); no-op when it is expanded or unknown. */
  expandTurn(turnKey: string): void;
  /**
   * Shows every node of a long expanded turn (instead of folding its middle into an `earlier` node); also takes an agent
   * group key (agentGroupKey) for a long expanded agent.
   */
  showFullTurn(turnKey: string): void;
  /**
   * Default true. While false nothing visible is folded away under a reader: turns expanded by the default "last 3"
   * rule stay expanded when newer turns arrive, and each expanded turn's and agent group's `earlier` fold is frozen (the
   * nodes hidden when the freeze started stay hidden, everything else stays visible however long it grows). Turning it
   * back on drops both and applies the default rules again.
   */
  setAutoFold(enabled: boolean): void;
  /** A node (the selection) that is never folded into `earlier` and whose turn is not auto-collapsed; null for none. */
  setKeepVisible(id: string | null): void;
  /**
   * Expands the agent (a dispatch node's childAgentId) into a container of its inner nodes, or collapses it again
   * (which forgets its "show all" and frozen fold); rebuilds at once. The set of expanded agents is kept across setMode
   * (topology mode ignores it).
   */
  toggleAgent(agentId: string): void;
  /**
   * Switches between the live, topology, causal and replay views; rebuilds at once. Default 'live'. Entering replay
   * puts the replay time at the end of the range.
   */
  setMode(mode: ViewMode): void;
  getMode(): ViewMode;
  /**
   * Default true: the view is built from compactGraph(graph) — empty thinking nodes and most system nodes are left out,
   * calls of one tool in a row are merged into run nodes. False draws every node. Rebuilds at once. While auto-fold is
   * off no new run is formed (nothing visible is merged away under a reader); existing runs still grow.
   */
  setCompact(enabled: boolean): void;
  /** Shows the members of a run node (its id, see runIdOf) as separate nodes from now on; rebuilds at once. */
  expandRun(runId: string): void;
  /**
   * Replay view only (ignored otherwise): moves the replay time (clamped to the range; NaN ignored). The new time is
   * published at once; the view follows through the throttled rebuild, like a live update.
   */
  setReplayTime(ms: number): void;
  /** The replay timeline as of the last rebuild (in any view: range null and no marks when the view is not replay). */
  getReplay(): ReplayInfo;
  dispose(): void;
}

/** Every agent group key starts with this (agentGroupKey); turn keys never do. */
const AGENT_KEY_PREFIX = agentGroupKey('');
/** Minimum interval between two rebuilds triggered by live updates. */
const REBUILD_MS = 50;
/** After a failed round with nothing queued, the model retries after this delay, doubling up to RETRY_MAX_MS. */
export const RETRY_FIRST_MS = 2_500;
export const RETRY_MAX_MS = 30_000;

type Positions = CanvasSnapshot['positions'];

const EMPTY_SNAPSHOT: CanvasSnapshot = {
  view: { turns: [], nodes: new Map(), edges: [], latestNodeId: null, agentGroups: [], mode: 'live' },
  positions: {},
  turnBoxes: {},
  containerBoxes: {},
  layoutMode: 'live',
  layoutError: null,
  replay: null,
  compact: true,
};
const NO_REPLAY: ReplayInfo = { range: null, timeMs: 0, marks: [], totals: { nodeCount: 0, usage: { inputTokens: 0, outputTokens: 0 } } };

/**
 * Whether two replayed graphs show the same thing: the same node ids, each the same object or both a "running" copy
 * made by graphAt of the same live node, and the same edge objects. `aSrc` / `bSrc` are the graphs they were made from.
 */
function sameReplayed(a: Graph, aSrc: Graph, b: Graph, bSrc: Graph): boolean {
  if (a === b) return true;
  let count = 0;
  for (const id in a.nodes) {
    count++;
    const x = a.nodes[id]!;
    const y = b.nodes[id];
    if (y === undefined) return false;
    if (x === y) continue;
    const src = aSrc.nodes[id];
    if (x === src || y === bSrc.nodes[id] || src !== bSrc.nodes[id]) return false;
  }
  if (count !== Object.keys(b.nodes).length) return false;
  if (a.edges === b.edges) return true;
  count = 0;
  for (const id in a.edges) {
    count++;
    if (a.edges[id] !== b.edges[id]) return false;
  }
  return count === Object.keys(b.edges).length;
}

const sameRange = (a: ReplayRange | null, b: ReplayRange | null): boolean =>
  a === b || (a !== null && b !== null && a.startMs === b.startMs && a.endMs === b.endMs);
const sameMarks = (a: ReplayInfo['marks'], b: ReplayInfo['marks']): boolean =>
  a.length === b.length && a.every((m, i) => m.turnId === b[i]!.turnId && m.ms === b[i]!.ms);
const sameTotals = (a: ReplayInfo['totals'], b: ReplayInfo['totals']): boolean =>
  a.nodeCount === b.nodeCount && a.usage.inputTokens === b.usage.inputTokens && a.usage.outputTokens === b.usage.outputTokens;

/** Keeps only the entries whose key passes `keep`; returns `obj` itself when nothing is dropped. */
function pick<T>(obj: Record<string, T>, keep: (key: string) => boolean): Record<string, T> {
  let dropped = false;
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (keep(k)) out[k] = v;
    else dropped = true;
  }
  return dropped ? out : obj;
}

const samePoint = (a: { x: number; y: number }, b: { x: number; y: number } | undefined): boolean =>
  b !== undefined && a.x === b.x && a.y === b.y;
const sameBox = (a: Box, b: Box | undefined): boolean =>
  b !== undefined && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const isExpandedContainer = (view: CanvasView, id: string): boolean => {
  const vn = view.nodes.get(id);
  return vn?.type === 'node' && vn.expanded;
};

/** Same keys, and every value equal by `same`. */
function sameRecord<T>(a: Record<string, T>, b: Record<string, T>, same: (x: T, y: T | undefined) => boolean): boolean {
  if (a === b) return true;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => same(a[k]!, b[k]));
}

/**
 * Not React-bound. After each live notification (throttled to 50 ms) the view is rebuilt and published at once; then
 * every turn is laid out and the new positions are swapped in at once when all turns have returned. Until then nodes
 * keep their old positions, and nodes that have none are left out of `positions`. At most one layout round runs at a
 * time: a rebuild during a round publishes its view and marks the model dirty, and one more round runs (against the
 * then-current graph) when the running one settles. A failed round with nothing queued schedules one retry
 * (2.5 s, doubling up to 30 s while rounds keep failing, reset by a success); any rebuild replaces that timer.
 *
 * A round is laid out bottom-up: the expanded agents' groups first, deepest level first (each level in parallel), each
 * result giving its container's size in the level above; then every turn with something to draw; then the turns are
 * stacked and the groups placed inside their containers. With no agent expanded a round is just the turns. A round
 * that finds the model dirty between two stages stops there and publishes nothing (unless the round before it stopped
 * that way too); the queued rebuild then starts the next round.
 *
 * A throttled rebuild whose graph is unchanged (and with nothing else the view depends on changed) keeps the view and
 * starts no round. In the replay view the graph fed to buildView is graphAt(live graph, replay time): a replay time
 * change goes through the same throttled path (the time itself is published at once), and a replayed graph equivalent
 * to the one the view was built from counts as unchanged; live updates still extend the range and marks, but do not
 * move the time.
 */
export function createCanvasModel(
  live: Pick<LiveSession, 'getGraph' | 'subscribe'>, layout: LayoutClient, initial: { compact?: boolean; mode?: ViewMode } = {},
): CanvasModel {
  let compact = initial.compact ?? true;
  const compactor = createCompactor();
  /** The calls of the runs the user expanded: never merged again (by call, since a run's id depends on its first member). */
  const expandedCalls = new Set<string>();
  /** The runs of the last compaction (id -> member ids); empty when the last view was not compacted. */
  let currentRuns: ReadonlyMap<string, readonly string[]> = new Map();
  /** Whether the last view was built from a compacted graph. */
  let reducedShown = false;
  /**
   * While auto-fold is off: the only runs that may exist (those on screen when it went off, or when a compacted view
   * was first shown after that). Null: no restriction. Not applied in the replay view, where the reader moves in time.
   */
  let frozenRuns: ReadonlySet<string> | null = null;
  const allowRun = (id: string): boolean => mode === 'replay' || frozenRuns === null || frozenRuns.has(id);
  /** The last compaction and what it was computed from; reused while those are the same (a fold, a mode switch). */
  let lastCompaction: {
    graph: Graph; keep: string | null; frozen: ReadonlySet<string> | null; expanded: number; replay: boolean; result: CompactResult;
  } | null = null;
  const reduce = (graph: Graph): CompactResult => {
    const c = lastCompaction;
    const replay = mode === 'replay';
    // `expandedCalls` only grows, so its size identifies its content.
    if (c && c.graph === graph && c.keep === keepVisible && c.frozen === frozenRuns && c.expanded === expandedCalls.size
      && c.replay === replay) return c.result;
    const result = compactor(graph, { keep: keepVisible, allowRun, exclude: expandedCalls });
    lastCompaction = { graph, keep: keepVisible, frozen: frozenRuns, expanded: expandedCalls.size, replay, result };
    return result;
  };
  /** Turn key -> expanded, set by the user. */
  const overrides = new Map<string, boolean>();
  /** Turn key -> expanded, recorded while auto-fold is off for turns the default rule had expanded. */
  const implicit = new Map<string, boolean>();
  const fullTurns = new Set<string>();
  /** Turn key or agent group key -> ids hidden in its `earlier` node, recorded while auto-fold is off. */
  const frozen = new Map<string, ReadonlySet<string>>();
  let keepVisible: string | null = null;
  /** Agent ids the user expanded (kept across mode switches). */
  const expandedAgents = new Set<string>();
  let mode: ViewMode = initial.mode ?? 'live';
  const listeners = new Set<() => void>();
  let snapshot: CanvasSnapshot = { ...EMPTY_SNAPSHOT, compact };
  let disposed = false;
  let autoFold = true;
  let roundRunning = false;
  let dirty = false;
  /** The previous round stopped early because the model was dirty; the next one then runs to the end (no starvation). */
  let lastAbandoned = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = RETRY_FIRST_MS;
  /** Replay view: the replay time; null for "the end of the range" (set on entering replay, kept until there is one). */
  let replayTime: number | null = null;
  /** The last computed replay state (NO_REPLAY outside the replay view). */
  let replayInfo: ReplayInfo = NO_REPLAY;
  /**
   * The graph the current view was built from, and the live graph it was made from. A rebuild whose graph is the same
   * (or an equivalent replayed graph, see sameReplayed) keeps the view, unless `viewStale` says something else the view
   * depends on changed (a fold, an agent, the mode, the selection, a queued round or a retry).
   */
  let builtGraph: Graph | null = null;
  let builtSource: Graph | null = null;
  let viewStale = true;
  const cancelRetry = (): void => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };

  const publish = (next: CanvasSnapshot): void => {
    snapshot = next;
    for (const fn of [...listeners]) fn();
  };

  /**
   * While auto-fold is off: every turn `view` shows expanded stays expanded (unless the user overrides it), and its
   * current `earlier` fold is frozen the first time it is seen; so is every agent group's.
   */
  const freeze = (view: CanvasView): void => {
    for (const t of view.turns) {
      if (t.collapsed) continue;
      if (!overrides.has(t.key)) implicit.set(t.key, true);
      if (!frozen.has(t.key)) frozen.set(t.key, new Set(t.foldedIds));
    }
    for (const g of view.agentGroups) if (!frozen.has(g.key)) frozen.set(g.key, new Set(g.foldedIds));
  };

  const effectiveOverrides = (): ReadonlyMap<string, boolean> => {
    if (implicit.size === 0) return overrides;
    const merged = new Map(implicit);
    for (const [k, v] of overrides) merged.set(k, v);
    return merged;
  };

  /**
   * Lays out `view` bottom-up; null when the model was disposed meanwhile, 'stale' when it stopped between two stages
   * because the model became dirty (a newer view is queued). It stops that way only when the previous round did not, so
   * a steady stream of updates cannot starve the layout.
   */
  const layoutRound = async (view: CanvasView): Promise<{
    positions: Positions; turnBoxes: Record<string, Box>; containerBoxes: Record<string, Box>;
  } | null | 'stale'> => {
    const mayStop = !lastAbandoned;
    const sizes = new Map<string, { width: number; height: number }>();
    const placed: { group: AgentGroup; layout: TurnLayout }[] = [];
    const groups = view.agentGroups; // deepest first
    for (let i = 0; i < groups.length;) {
      let j = i;
      while (j < groups.length && groups[j]!.depth === groups[i]!.depth) j++;
      const level = groups.slice(i, j).map((group) => ({ group, input: groupInput(view, group.key, group.nodeIds, sizes) }))
        .filter((x) => x.input.nodes.length > 0);
      const layouts = await Promise.all(level.map((x) => layout.layout(x.input)));
      if (disposed) return null;
      if (dirty && mayStop) return 'stale'; // the next stage would lay out a view that is no longer shown
      level.forEach(({ group }, k) => {
        placed.push({ group, layout: layouts[k]! });
        sizes.set(group.containerId, containerSize(layouts[k]!));
      });
      i = j;
    }
    const inputs = view.turns.map((t) => turnInput(view, t, sizes)).filter((x) => x.nodes.length > 0);
    const layouts = await Promise.all(inputs.map((x) => layout.layout(x)));
    if (disposed) return null;
    const stacked = wrapTurns(layouts);
    const { positions, containerBoxes } = placeAgentGroups(stacked, placed.reverse()); // outer groups first
    return { positions, turnBoxes: stacked.turnBoxes, containerBoxes };
  };

  const startRound = (view: CanvasView): void => {
    roundRunning = true;
    const settle = (failed: boolean): void => {
      roundRunning = false;
      if (disposed) return;
      if (dirty) {
        dirty = false;
        viewStale = true; // the view published meanwhile still needs its round
        rebuild();
      } else if (failed) {
        retryTimer = setTimeout(() => { retryTimer = null; viewStale = true; rebuild(); }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
      }
    };
    layoutRound(view).then(
      (stacked) => {
        if (disposed || stacked === null) return;
        lastAbandoned = stacked === 'stale';
        if (stacked === 'stale') { // publishes nothing; the queued rebuild runs now
          settle(false);
          return;
        }
        // The view may have moved on since this request: keep only what is still shown.
        const current = snapshot.view;
        let positions: Positions = {};
        for (const [id, p] of Object.entries(stacked.positions)) if (current.nodes.has(id)) positions[id] = p;
        for (const [id, p] of Object.entries(snapshot.positions)) if (!(id in positions)) positions[id] = p;
        const currentTurns = new Set(current.turns.map((t) => t.key));
        let turnBoxes = pick(stacked.turnBoxes, (k) => currentTurns.has(k));
        let containerBoxes = pick(stacked.containerBoxes, (id) => isExpandedContainer(current, id));
        if (sameRecord(positions, snapshot.positions, samePoint)) positions = snapshot.positions;
        if (sameRecord(turnBoxes, snapshot.turnBoxes, sameBox)) turnBoxes = snapshot.turnBoxes;
        if (sameRecord(containerBoxes, snapshot.containerBoxes, sameBox)) containerBoxes = snapshot.containerBoxes;
        const layoutMode = view.mode;
        const unchanged = positions === snapshot.positions && turnBoxes === snapshot.turnBoxes
          && containerBoxes === snapshot.containerBoxes && snapshot.layoutMode === layoutMode && snapshot.layoutError === null;
        if (!unchanged) publish({ ...snapshot, view: current, positions, turnBoxes, containerBoxes, layoutMode, layoutError: null });
        retryDelay = RETRY_FIRST_MS;
        settle(false);
      },
      (err: unknown) => {
        if (disposed) return;
        lastAbandoned = false;
        const layoutError = err instanceof Error ? err.message : String(err);
        if (layoutError !== snapshot.layoutError) publish({ ...snapshot, layoutError });
        settle(true);
      },
    );
  };

  /**
   * Replay view: the replay state for `source` (the live graph) and `graph` (graphAt of it at `timeMs`). Reuses the
   * previous state, or its range / marks / totals objects, where the values are unchanged.
   */
  const nextReplay = (source: Graph, graph: Graph, range: ReplayRange | null, timeMs: number): ReplayInfo => {
    const prev = replayInfo;
    const r = sameRange(range, prev.range) ? prev.range : range;
    const m = turnMarks(source);
    const marks = sameMarks(m, prev.marks) ? prev.marks : m;
    const t = { nodeCount: Object.keys(graph.nodes).length, usage: usageTotal(Object.values(graph.nodes)) };
    const totals = sameTotals(t, prev.totals) ? prev.totals : t;
    return r === prev.range && marks === prev.marks && totals === prev.totals && timeMs === prev.timeMs
      ? prev
      : { range: r, timeMs, marks, totals };
  };

  function rebuild(): void {
    if (disposed) return;
    const source = live.getGraph();
    let graph = source;
    let replay: ReplayInfo | null = null;
    if (mode === 'replay') {
      const range = replayRange(source);
      const timeMs = replayTime === null ? range?.endMs ?? 0 : clampToRange(replayTime, range);
      if (range !== null) replayTime = timeMs; // the time does not move with later live updates
      graph = graphAt(source, timeMs);
      if (builtGraph !== null && builtSource !== null && sameReplayed(graph, source, builtGraph, builtSource)) graph = builtGraph;
      replay = replayInfo = nextReplay(source, graph, range, timeMs);
    } else {
      replayInfo = NO_REPLAY;
    }
    if (!viewStale && graph === builtGraph) {
      // Nothing the view depends on changed (an unrelated notification, a replay time with the same replayed graph).
      if (replay !== snapshot.replay) publish({ ...snapshot, replay });
      return;
    }
    viewStale = false;
    builtGraph = graph;
    builtSource = source;
    cancelRetry(); // this rebuild is the retry
    // The outline view counts every step in its turn cards, so it is built from the full graph.
    const willReduce = compact && mode !== 'outline';
    // Coming from a view that was not compacted there are no runs on screen to preserve: form them all, then freeze.
    if (willReduce && !reducedShown) frozenRuns = null;
    const reduced = willReduce ? reduce(graph) : null;
    currentRuns = reduced?.runs ?? new Map();
    // The replay view is not frozen (the reader moves in time), and what it showed is not what a later view preserves.
    const freezable = willReduce && mode !== 'replay';
    if (freezable && !autoFold && frozenRuns === null) frozenRuns = new Set(currentRuns.keys());
    if (!freezable) frozenRuns = null;
    reducedShown = freezable;
    const view = buildView(reduced?.graph ?? graph, effectiveOverrides(), fullTurns, {
      frozenHidden: frozen, keepVisible, expandedAgents, mode, runs: reduced?.runs, thinkingMs: reduced?.thinkingMs,
    });
    // A collapsed turn forgets "show all" and its frozen fold, however it got collapsed: re-expanding it folds the
    // middle by the length rule again. Not in the outline view, where every turn merely counts as collapsed: the
    // per-step views keep their folds for when the reader comes back.
    if (mode !== 'outline') {
      for (const t of view.turns) {
        if (!t.collapsed) continue;
        fullTurns.delete(t.key);
        frozen.delete(t.key);
      }
      // Likewise an agent group that left the view (its turn collapsed, its container folded into `earlier`, topology).
      const groupKeys = new Set(view.agentGroups.map((g) => g.key));
      const leftView = (key: string): boolean => key.startsWith(AGENT_KEY_PREFIX) && !groupKeys.has(key);
      for (const key of [...fullTurns]) if (leftView(key)) fullTurns.delete(key);
      for (const key of [...frozen.keys()]) if (leftView(key)) frozen.delete(key);
    }
    if (!autoFold) freeze(view); // turns that appeared (or were expanded) since the last rebuild
    const inView = (id: string): boolean => view.nodes.has(id);
    const turnKeys = new Set(view.turns.map((t) => t.key));
    publish({
      ...snapshot,
      view,
      positions: pick(snapshot.positions, inView),
      turnBoxes: pick(snapshot.turnBoxes, (k) => turnKeys.has(k)),
      containerBoxes: pick(snapshot.containerBoxes, (id) => isExpandedContainer(view, id)),
      replay,
      compact,
    });
    if (roundRunning) dirty = true;
    else startRound(view);
  }

  const throttle = createThrottle(rebuild, REBUILD_MS);
  /** A UI action changed what the view depends on: rebuild at once (also picks up any pending graph change). */
  const rebuildNow = (): void => {
    viewStale = true;
    throttle.cancel();
    rebuild();
  };
  const unsubscribe = live.subscribe(() => throttle.trigger());
  rebuild();

  return {
    getSnapshot: () => snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    toggleTurn(turnKey) {
      if (disposed) return;
      const turn = snapshot.view.turns.find((t) => t.key === turnKey);
      if (!turn) return;
      overrides.set(turnKey, turn.collapsed); // value = expanded: a collapsed turn becomes expanded and vice versa
      if (!turn.collapsed) {
        // Folding resets "show all" and the frozen fold: re-expanding folds the middle by the length rule again.
        fullTurns.delete(turnKey);
        frozen.delete(turnKey);
      }
      rebuildNow();
    },
    expandTurn(turnKey) {
      if (disposed) return;
      const turn = snapshot.view.turns.find((t) => t.key === turnKey);
      if (!turn || !turn.collapsed) return;
      overrides.set(turnKey, true);
      rebuildNow();
    },
    showFullTurn(turnKey) {
      if (disposed || fullTurns.has(turnKey)) return;
      fullTurns.add(turnKey);
      rebuildNow();
    },
    setAutoFold(enabled) {
      if (disposed || enabled === autoFold) return;
      autoFold = enabled;
      if (!enabled) {
        freeze(snapshot.view);
        frozenRuns = reducedShown ? new Set(currentRuns.keys()) : null;
        return; // nothing on screen changes
      }
      frozenRuns = null;
      implicit.clear();
      frozen.clear();
      rebuildNow();
    },
    setKeepVisible(id) {
      if (id === keepVisible) return;
      keepVisible = id; // takes effect with the next rebuild: a selected node is already visible
      viewStale = true; // ... even when that rebuild brings no graph change
    },
    toggleAgent(agentId) {
      if (disposed) return;
      if (expandedAgents.delete(agentId)) {
        // Collapsing forgets "show all" and the frozen fold: re-expanding folds a long agent by the length rule again.
        fullTurns.delete(agentGroupKey(agentId));
        frozen.delete(agentGroupKey(agentId));
      } else {
        expandedAgents.add(agentId);
      }
      rebuildNow();
    },
    setMode(next) {
      if (disposed || next === mode) return;
      mode = next;
      if (next === 'replay') replayTime = null; // start at the end of the range
      rebuildNow();
    },
    getMode: () => mode,
    setCompact(enabled) {
      if (disposed || enabled === compact) return;
      compact = enabled;
      frozen.clear(); // frozen folds name the nodes of the other density; the rebuild freezes the new view again
      rebuildNow();
    },
    expandRun(runId) {
      const members = currentRuns.get(runId);
      if (disposed || members === undefined) return;
      for (const id of members) expandedCalls.add(id);
      // Its id may come back for a run forming later next to these calls (an id anchored on a failed call): that one is
      // new, not one that was on screen when the freeze started.
      if (frozenRuns !== null && frozenRuns.has(runId)) {
        const rest = new Set(frozenRuns);
        rest.delete(runId);
        frozenRuns = rest;
      }
      rebuildNow();
    },
    setReplayTime(ms) {
      if (disposed || mode !== 'replay' || !Number.isFinite(ms) || replayInfo.range === null) return;
      const timeMs = clampToRange(ms, replayInfo.range);
      if (timeMs === replayInfo.timeMs) return;
      replayTime = timeMs;
      // The slider moves at once; the replayed view (and the totals) follow with the throttled rebuild.
      replayInfo = { ...replayInfo, timeMs };
      publish({ ...snapshot, replay: replayInfo });
      throttle.trigger();
    },
    getReplay: () => replayInfo,
    dispose() {
      disposed = true;
      cancelRetry();
      throttle.cancel();
      unsubscribe();
      listeners.clear();
    },
  };
}

/** The viewer's "精简 / 完整" choice, remembered in this browser. */
const COMPACT_KEY = 'claude-canvas.compact';
function readCompactPreference(): boolean {
  try { return window.localStorage.getItem(COMPACT_KEY) !== '0'; } catch { return true; }
}

/** One model and one layout worker per live session; both are disposed when the page unmounts. */
export type UseCanvasResult = CanvasSnapshot
  & Pick<CanvasModel, 'toggleTurn' | 'expandTurn' | 'showFullTurn' | 'setAutoFold' | 'setKeepVisible' | 'toggleAgent' | 'setMode' | 'setReplayTime' | 'setCompact' | 'expandRun'>
  & { /** False until the model exists (the snapshot is then an empty placeholder). */ ready: boolean };

export function useCanvas(live: LiveSession): UseCanvasResult {
  const [model, setModel] = useState<CanvasModel | null>(null);
  useEffect(() => {
    const client = createLayoutClient(createBrowserLayoutWorker);
    const m = createCanvasModel(live, client, { compact: readCompactPreference(), mode: 'outline' });
    setModel(m);
    return () => {
      m.dispose();
      client.dispose();
      setModel((cur) => (cur === m ? null : cur));
    };
  }, [live]);

  const subscribe = useCallback((fn: () => void) => (model ? model.subscribe(fn) : () => {}), [model]);
  const getSnapshot = useCallback(() => (model ? model.getSnapshot() : EMPTY_SNAPSHOT), [model]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const toggleTurn = useCallback((turnKey: string) => model?.toggleTurn(turnKey), [model]);
  const expandTurn = useCallback((turnKey: string) => model?.expandTurn(turnKey), [model]);
  const showFullTurn = useCallback((turnKey: string) => model?.showFullTurn(turnKey), [model]);
  const setAutoFold = useCallback((enabled: boolean) => model?.setAutoFold(enabled), [model]);
  const setKeepVisible = useCallback((id: string | null) => model?.setKeepVisible(id), [model]);
  const toggleAgent = useCallback((agentId: string) => model?.toggleAgent(agentId), [model]);
  const setMode = useCallback((mode: ViewMode) => model?.setMode(mode), [model]);
  const setReplayTime = useCallback((ms: number) => model?.setReplayTime(ms), [model]);
  const setCompact = useCallback((enabled: boolean) => {
    try { window.localStorage.setItem(COMPACT_KEY, enabled ? '1' : '0'); } catch { /* storage unavailable: not remembered */ }
    model?.setCompact(enabled);
  }, [model]);
  const expandRun = useCallback((runId: string) => model?.expandRun(runId), [model]);
  // Same object until the snapshot changes, so consumers can memoize on it.
  const ready = model !== null;
  return useMemo(
    () => ({
      ...snapshot, toggleTurn, expandTurn, showFullTurn, setAutoFold, setKeepVisible, toggleAgent, setMode, setReplayTime,
      setCompact, expandRun, ready,
    }),
    [snapshot, toggleTurn, expandTurn, showFullTurn, setAutoFold, setKeepVisible, toggleAgent, setMode, setReplayTime,
      setCompact, expandRun, ready],
  );
}
