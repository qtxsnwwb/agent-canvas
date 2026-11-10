import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { LiveSession } from '../client';
import { createThrottle } from '../throttle';
import { stackTurns, turnInput, type Box } from './layout';
import { createBrowserLayoutWorker, createLayoutClient, type LayoutClient } from './layoutClient';
import { buildView, type CanvasView } from './view';

export interface CanvasSnapshot {
  view: CanvasView;
  /** Only view nodes whose position has been computed; the canvas does not draw the others yet. */
  positions: Record<string, { x: number; y: number }>;
  turnBoxes: Record<string, Box>;
  layoutError: string | null;
}
export interface CanvasModel {
  getSnapshot(): CanvasSnapshot;
  subscribe(fn: () => void): () => void;
  /** Flips the turn's current expanded/collapsed state and records it as an override. */
  toggleTurn(turnKey: string): void;
  /** Shows every node of a long expanded turn (instead of folding its middle into an `earlier` node). */
  showFullTurn(turnKey: string): void;
  /**
   * Default true. While false nothing visible is folded away under a reader: turns expanded by the default "last 3"
   * rule stay expanded when newer turns arrive, and each expanded turn's `earlier` fold is frozen (the nodes hidden
   * when the freeze started stay hidden, everything else stays visible however long the turn grows). Turning it back
   * on drops both and applies the default rules again.
   */
  setAutoFold(enabled: boolean): void;
  /** A node (the selection) that is never folded into `earlier` and whose turn is not auto-collapsed; null for none. */
  setKeepVisible(id: string | null): void;
  dispose(): void;
}

/** Minimum interval between two rebuilds triggered by live updates. */
const REBUILD_MS = 50;

type Positions = CanvasSnapshot['positions'];

const EMPTY_SNAPSHOT: CanvasSnapshot = {
  view: { turns: [], nodes: new Map(), edges: [], latestNodeId: null },
  positions: {},
  turnBoxes: {},
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
 * then-current graph) when the running one settles.
 */
export function createCanvasModel(live: Pick<LiveSession, 'getGraph' | 'subscribe'>, layout: LayoutClient): CanvasModel {
  /** Turn key -> expanded, set by the user. */
  const overrides = new Map<string, boolean>();
  /** Turn key -> expanded, recorded while auto-fold is off for turns the default rule had expanded. */
  const implicit = new Map<string, boolean>();
  const fullTurns = new Set<string>();
  /** Turn key -> ids hidden in its `earlier` node, recorded while auto-fold is off. */
  const frozen = new Map<string, ReadonlySet<string>>();
  let keepVisible: string | null = null;
  const listeners = new Set<() => void>();
  let snapshot: CanvasSnapshot = EMPTY_SNAPSHOT;
  let disposed = false;
  let autoFold = true;
  let roundRunning = false;
  let dirty = false;

  const publish = (next: CanvasSnapshot): void => {
    snapshot = next;
    for (const fn of [...listeners]) fn();
  };

  /**
   * While auto-fold is off: every turn `view` shows expanded stays expanded (unless the user overrides it), and its
   * current `earlier` fold is frozen the first time it is seen.
   */
  const freeze = (view: CanvasView): void => {
    for (const t of view.turns) {
      if (t.collapsed) continue;
      if (!overrides.has(t.key)) implicit.set(t.key, true);
      if (!frozen.has(t.key)) frozen.set(t.key, new Set(t.foldedIds));
    }
  };

  const effectiveOverrides = (): ReadonlyMap<string, boolean> => {
    if (implicit.size === 0) return overrides;
    const merged = new Map(implicit);
    for (const [k, v] of overrides) merged.set(k, v);
    return merged;
  };

  const startRound = (view: CanvasView): void => {
    roundRunning = true;
    const settle = (): void => {
      roundRunning = false;
      if (dirty && !disposed) {
        dirty = false;
        rebuild();
      }
    };
    Promise.all(view.turns.map((t) => layout.layout(turnInput(view, t)))).then(
      (layouts) => {
        if (disposed) return;
        const stacked = stackTurns(layouts);
        // The view may have moved on since this request: keep only what is still shown.
        const current = snapshot.view;
        let positions: Positions = {};
        for (const [id, p] of Object.entries(stacked.positions)) if (current.nodes.has(id)) positions[id] = p;
        for (const [id, p] of Object.entries(snapshot.positions)) if (!(id in positions)) positions[id] = p;
        const currentTurns = new Set(current.turns.map((t) => t.key));
        let turnBoxes = pick(stacked.turnBoxes, (k) => currentTurns.has(k));
        if (sameRecord(positions, snapshot.positions, samePoint)) positions = snapshot.positions;
        if (sameRecord(turnBoxes, snapshot.turnBoxes, sameBox)) turnBoxes = snapshot.turnBoxes;
        const unchanged = positions === snapshot.positions && turnBoxes === snapshot.turnBoxes && snapshot.layoutError === null;
        if (!unchanged) publish({ view: current, positions, turnBoxes, layoutError: null });
        settle();
      },
      (err: unknown) => {
        if (disposed) return;
        const layoutError = err instanceof Error ? err.message : String(err);
        if (layoutError !== snapshot.layoutError) publish({ ...snapshot, layoutError });
        settle();
      },
    );
  };

  function rebuild(): void {
    if (disposed) return;
    const view = buildView(live.getGraph(), effectiveOverrides(), fullTurns, { frozenHidden: frozen, keepVisible });
    if (!autoFold) freeze(view); // turns that appeared (or were expanded) since the last rebuild
    const inView = (id: string): boolean => view.nodes.has(id);
    const turnKeys = new Set(view.turns.map((t) => t.key));
    publish({
      ...snapshot,
      view,
      positions: pick(snapshot.positions, inView),
      turnBoxes: pick(snapshot.turnBoxes, (k) => turnKeys.has(k)),
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
    dispose() {
      disposed = true;
      throttle.cancel();
      unsubscribe();
      listeners.clear();
    },
  };
}

/** One model and one layout worker per live session; both are disposed when the page unmounts. */
export function useCanvas(live: LiveSession): CanvasSnapshot & Pick<CanvasModel, 'toggleTurn' | 'showFullTurn' | 'setAutoFold' | 'setKeepVisible'> {
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
  // Same object until the snapshot changes, so consumers can memoize on it.
  return useMemo(
    () => ({ ...snapshot, toggleTurn, showFullTurn, setAutoFold, setKeepVisible }),
    [snapshot, toggleTurn, showFullTurn, setAutoFold, setKeepVisible],
  );
}
