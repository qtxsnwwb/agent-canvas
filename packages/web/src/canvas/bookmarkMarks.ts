/**
 * Which cards of the canvas get a bookmark star (bookmarks spec 5). Pure; the session page feeds it its bookmarks, the
 * canvas view and the graph, and hands the result to the canvas (Canvas `bookmarkMarks`).
 *
 * A bookmarked step marks its own card when the view draws one. Otherwise it is rolled up the way the anomaly markers
 * are (anomalies.ts cardMarks): the turn card it belongs to (a collapsed turn, every turn in 概览) and every subagent card
 * on its dispatch chain that the view draws. A step (or a dispatch on its chain) folded into a turn's or an expanded
 * agent's “更早的 N 个节点” marks that card instead: the view lists what each fold holds (TurnView / AgentGroup
 * `foldedIds`). The members of a 精简 run are not listed by the view (the runs stay inside the canvas model), so a step
 * merged into a run marks only the cards above it that are drawn (none while its turn is expanded). A session bookmark
 * marks no card. The 时间线 view and the waterfall draw no stars.
 */
import type { Bookmark, Graph } from '@agent-canvas/shared';
import { dispatchingTurn, type AnomalyResolver } from '../anomalies';
import type { CanvasView } from './view';

/** A card's star: how many bookmarks it stands for, and the text appended to the card's accessible name. */
export interface StarMark {
  count: number;
  label: string;
}
/** Stars by view node id. */
export type StarMarks = ReadonlyMap<string, StarMark>;
export const NO_STARS: StarMarks = new Map();

export const starLabel = (count: number): string => `${count} 个书签`;

const own = (graph: Graph, id: string) => (Object.prototype.hasOwnProperty.call(graph.nodes, id) ? graph.nodes[id] : undefined);

/**
 * The stars of `bookmarks` on the cards `view` draws. `graph`: the session's graph (the steps, their agents);
 * `r`: a resolver over it (anomalies.ts graphResolver), asked only for steps the view does not draw.
 */
export function bookmarkMarks(
  bookmarks: readonly Pick<Bookmark, 'nodeId'>[], view: Pick<CanvasView, 'nodes' | 'turns' | 'agentGroups'>, graph: Graph,
  r: AnomalyResolver,
): StarMarks {
  let folds: Map<string, string> | null = null;
  /** The `earlier` card a node is folded into, if the view draws it. */
  const foldOf = (id: string): string | undefined => {
    if (folds === null) {
      folds = new Map();
      const add = (key: string, ids: readonly string[]): void => {
        const earlier = `earlier:${key}`;
        if (ids.length === 0 || view.nodes.get(earlier)?.type !== 'earlier') return;
        for (const x of ids) folds!.set(x, earlier);
      };
      for (const t of view.turns) add(t.key, t.foldedIds);
      for (const g of view.agentGroups) add(g.key, g.foldedIds);
    }
    return folds.get(id);
  };
  /** The card that shows node `id`: its own, or the fold holding it; null when the view draws neither. */
  const cardOf = (id: string): string | null => (view.nodes.get(id)?.type === 'node' ? id : foldOf(id) ?? null);
  const counts = new Map<string, number>();
  for (const b of bookmarks) {
    if (b.nodeId === null) continue;
    const node = own(graph, b.nodeId);
    if (node === undefined) continue;
    const cards = new Set<string>();
    const self = cardOf(node.id);
    if (self !== null) {
      cards.add(self);
    } else {
      let turn: string | null;
      if (node.agentId === null) {
        turn = r.mainTurnOf(node.id);
      } else {
        // Every agent it sits in, innermost first: the card of the node that dispatched it.
        const seen = new Set<string>();
        for (let agent: string | null = node.agentId; agent !== null && !seen.has(agent);) {
          seen.add(agent);
          const d = r.dispatchOf(agent);
          if (d === undefined) break;
          const card = cardOf(d.id);
          if (card !== null) cards.add(card);
          agent = d.agentId;
        }
        turn = dispatchingTurn(node.agentId, r);
      }
      if (turn !== null && view.nodes.get(`turn:${turn}`)?.type === 'turn_summary') cards.add(`turn:${turn}`);
    }
    for (const c of cards) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  if (counts.size === 0) return NO_STARS;
  return new Map([...counts].map(([id, count]) => [id, { count, label: starLabel(count) }]));
}

/** The replay view: the bookmarks whose step the replay time has reached (an unreadable time counts as 0). null: all. */
export function bookmarksUntil<T extends Pick<Bookmark, 'nodeId'>>(bookmarks: readonly T[], graph: Graph, timeMs: number | null): readonly T[] {
  if (timeMs === null) return bookmarks;
  return bookmarks.filter((b) => {
    if (b.nodeId === null) return false;
    const n = own(graph, b.nodeId);
    if (n === undefined) return false;
    const t = Date.parse(n.timestamp);
    return (Number.isNaN(t) ? 0 : t) <= timeMs;
  });
}

/**
 * `next`, with `prev` itself when every card has the same star (so the canvas does not rebuild its cards when the list
 * is fetched again unchanged), NO_STARS when there are none.
 */
export function stableStars(prev: StarMarks, next: StarMarks): StarMarks {
  if (next.size === 0) return NO_STARS;
  if (prev.size !== next.size) return next;
  for (const [id, m] of next) {
    const old = prev.get(id);
    if (old === undefined || old.count !== m.count || old.label !== m.label) return next;
  }
  return prev;
}
