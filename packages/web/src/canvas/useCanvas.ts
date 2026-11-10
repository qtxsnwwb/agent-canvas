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

/**
 * Not React-bound. After each live notification (throttled to 50 ms) the view is rebuilt and every turn is laid out;
 * the new positions are swapped in at once when all turns have returned. Until then nodes keep their old positions,
 * and nodes that have none are left out of `positions`.
 */
export function createCanvasModel(live: Pick<LiveSession, 'getGraph' | 'subscribe'>, layout: LayoutClient): CanvasModel {
  const overrides = new Map<string, boolean>();
  const fullTurns = new Set<string>();
  const listeners = new Set<() => void>();
  let snapshot: CanvasSnapshot = EMPTY_SNAPSHOT;
  let disposed = false;
  let generation = 0;
  /** Newest generation whose layout was applied; older results arriving later are dropped. */
  let appliedGeneration = 0;
  /** Newest generation whose layout failed; a success only clears the error when it is newer. */
  let failedGeneration = 0;

  const publish = (next: CanvasSnapshot): void => {
    snapshot = next;
    for (const fn of [...listeners]) fn();
  };

  const rebuild = (): void => {
    if (disposed) return;
    const gen = ++generation;
    const view = buildView(live.getGraph(), overrides, fullTurns);
    const inView = (id: string): boolean => view.nodes.has(id);
    const turnKeys = new Set(view.turns.map((t) => t.key));
    publish({
      ...snapshot,
      view,
      positions: pick(snapshot.positions, inView),
      turnBoxes: pick(snapshot.turnBoxes, (k) => turnKeys.has(k)),
    });

    Promise.all(view.turns.map((t) => layout.layout(turnInput(view, t)))).then(
      (layouts) => {
        if (disposed || gen < appliedGeneration) return;
        appliedGeneration = gen;
        const stacked = stackTurns(layouts);
        // The view may have moved on since this request: keep only what is still shown.
        const current = snapshot.view;
        const positions: Positions = {};
        for (const [id, p] of Object.entries(stacked.positions)) if (current.nodes.has(id)) positions[id] = p;
        for (const [id, p] of Object.entries(snapshot.positions)) if (!(id in positions)) positions[id] = p;
        const currentTurns = new Set(current.turns.map((t) => t.key));
        publish({
          view: current,
          positions,
          turnBoxes: pick(stacked.turnBoxes, (k) => currentTurns.has(k)),
          layoutError: gen > failedGeneration ? null : snapshot.layoutError,
        });
      },
      (err: unknown) => {
        if (disposed || gen < appliedGeneration) return;
        failedGeneration = Math.max(failedGeneration, gen);
        publish({ ...snapshot, layoutError: err instanceof Error ? err.message : String(err) });
      },
    );
  };

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
      if (!turn.collapsed) fullTurns.delete(turnKey); // folding resets "show all": re-expanding folds the middle again
      throttle.cancel(); // this rebuild also picks up any pending graph change
      rebuild();
    },
    showFullTurn(turnKey) {
      if (disposed || fullTurns.has(turnKey)) return;
      fullTurns.add(turnKey);
      throttle.cancel();
      rebuild();
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
export function useCanvas(live: LiveSession): CanvasSnapshot & Pick<CanvasModel, 'toggleTurn' | 'showFullTurn'> {
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
  // Same object until the snapshot changes, so consumers can memoize on it.
  return useMemo(() => ({ ...snapshot, toggleTurn, showFullTurn }), [snapshot, toggleTurn, showFullTurn]);
}
