import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { LiveSession } from '../client';
import { createThrottle } from '../throttle';
import { groupInput, placeAgentGroups, stackTurns, turnInput, type Box, type TurnLayout } from './layout';
import { createBrowserLayoutWorker, createLayoutClient, type LayoutClient } from './layoutClient';
import { containerSize } from './sizes';
import { agentGroupKey, buildView, type AgentGroup, type CanvasView, type ViewMode } from './view';

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
}
export interface CanvasModel {
  getSnapshot(): CanvasSnapshot;
  subscribe(fn: () => void): () => void;
  /** Flips the turn's current expanded/collapsed state and records it as an override. */
  toggleTurn(turnKey: string): void;
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
  /** Switches between the live, topology and causal views; rebuilds at once. Default 'live'. */
  setMode(mode: ViewMode): void;
  getMode(): ViewMode;
  dispose(): void;
}

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
};

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
 */
export function createCanvasModel(live: Pick<LiveSession, 'getGraph' | 'subscribe'>, layout: LayoutClient): CanvasModel {
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
  let mode: ViewMode = 'live';
  const listeners = new Set<() => void>();
  let snapshot: CanvasSnapshot = EMPTY_SNAPSHOT;
  let disposed = false;
  let autoFold = true;
  let roundRunning = false;
  let dirty = false;
  /** The previous round stopped early because the model was dirty; the next one then runs to the end (no starvation). */
  let lastAbandoned = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = RETRY_FIRST_MS;
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
    const stacked = stackTurns(layouts);
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
        rebuild();
      } else if (failed) {
        retryTimer = setTimeout(() => { retryTimer = null; rebuild(); }, retryDelay);
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
        if (!unchanged) publish({ view: current, positions, turnBoxes, containerBoxes, layoutMode, layoutError: null });
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

  function rebuild(): void {
    if (disposed) return;
    cancelRetry(); // this rebuild is the retry
    const view = buildView(live.getGraph(), effectiveOverrides(), fullTurns, { frozenHidden: frozen, keepVisible, expandedAgents, mode });
    // A collapsed turn forgets "show all" and its frozen fold, however it got collapsed: re-expanding it folds the
    // middle by the length rule again.
    for (const t of view.turns) {
      if (!t.collapsed) continue;
      fullTurns.delete(t.key);
      frozen.delete(t.key);
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
    });
    if (roundRunning) dirty = true;
    else startRound(view);
  }

  const throttle = createThrottle(rebuild, REBUILD_MS);
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
      throttle.cancel(); // this rebuild also picks up any pending graph change
      rebuild();
    },
    showFullTurn(turnKey) {
      if (disposed || fullTurns.has(turnKey)) return;
      fullTurns.add(turnKey);
      throttle.cancel();
      rebuild();
    },
    setAutoFold(enabled) {
      if (disposed || enabled === autoFold) return;
      autoFold = enabled;
      if (!enabled) {
        freeze(snapshot.view);
        return; // nothing on screen changes
      }
      implicit.clear();
      frozen.clear();
      throttle.cancel();
      rebuild();
    },
    setKeepVisible(id) {
      keepVisible = id; // takes effect with the next rebuild: a selected node is already visible
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
      throttle.cancel();
      rebuild();
    },
    setMode(next) {
      if (disposed || next === mode) return;
      mode = next;
      throttle.cancel();
      rebuild();
    },
    getMode: () => mode,
    dispose() {
      disposed = true;
      cancelRetry();
      throttle.cancel();
      unsubscribe();
      listeners.clear();
    },
  };
}

/** One model and one layout worker per live session; both are disposed when the page unmounts. */
export type UseCanvasResult = CanvasSnapshot
  & Pick<CanvasModel, 'toggleTurn' | 'showFullTurn' | 'setAutoFold' | 'setKeepVisible' | 'toggleAgent' | 'setMode'>
  & { /** False until the model exists (the snapshot is then an empty placeholder). */ ready: boolean };

export function useCanvas(live: LiveSession): UseCanvasResult {
  const [model, setModel] = useState<CanvasModel | null>(null);
  useEffect(() => {
    const client = createLayoutClient(createBrowserLayoutWorker);
    const m = createCanvasModel(live, client);
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
  const showFullTurn = useCallback((turnKey: string) => model?.showFullTurn(turnKey), [model]);
  const setAutoFold = useCallback((enabled: boolean) => model?.setAutoFold(enabled), [model]);
  const setKeepVisible = useCallback((id: string | null) => model?.setKeepVisible(id), [model]);
  const toggleAgent = useCallback((agentId: string) => model?.toggleAgent(agentId), [model]);
  const setMode = useCallback((mode: ViewMode) => model?.setMode(mode), [model]);
  // Same object until the snapshot changes, so consumers can memoize on it.
  const ready = model !== null;
  return useMemo(
    () => ({ ...snapshot, toggleTurn, showFullTurn, setAutoFold, setKeepVisible, toggleAgent, setMode, ready }),
    [snapshot, toggleTurn, showFullTurn, setAutoFold, setKeepVisible, toggleAgent, setMode, ready],
  );
}
