import type { Graph } from '@agent-canvas/shared';
import { scopeOfNode } from './AgentTimeline';
import { scopeKey, type WaterfallScope } from './waterfall';

/**
 * What the execution (waterfall) panel lists while the 时间线 view shows: the page's own state, separate from the
 * canvas selection (pages/SessionCanvas.tsx keeps it and applies these rules).
 * - `scope` null: the latest turn, until the panel is closed (`closed`).
 * - `pinned`: the scope was fixed only because a step was opened while following; closing the drawer undoes it.
 * - `row`: the row the reader picked (a timeline row id, 'main' for the main bar); only that row is highlighted when the
 *   scope is a turn (see timelineRowModel).
 */
export interface TimelinePanel { scope: WaterfallScope | null; closed: boolean; pinned: boolean; row: string | null }

export const FOLLOW_LATEST: TimelinePanel = { scope: null, closed: false, pinned: false, row: null };
export const CLOSED_PANEL: TimelinePanel = { scope: null, closed: true, pinned: false, row: null };

/** The scope the panel lists: its own, else the latest turn; null when closed or before there is a turn. */
export function panelScopeOf(p: TimelinePanel, latestTurnKey: string | null): WaterfallScope | null {
  if (p.closed) return null;
  return p.scope ?? (latestTurnKey !== null ? { type: 'turn', turnKey: latestTurnKey } : null);
}

/** A scope the reader chose (a row, the main bar, a link): listed until the next choice; `row` is the picked row. */
export function pickedPanel(scope: WaterfallScope, row: string | null = null): TimelinePanel {
  return { scope, closed: false, pinned: false, row };
}

/** A step opened while following the latest turn: the shown turn is kept (a new turn must not take the list away). */
export function pinForStep(p: TimelinePanel, shown: WaterfallScope | null): TimelinePanel {
  return p.scope === null && shown !== null ? { scope: shown, closed: false, pinned: true, row: null } : p;
}

/** The drawer was closed: back to following when the scope was pinned only for it. */
export function unpinOnDrawerClose(p: TimelinePanel): TimelinePanel {
  return p.pinned ? FOLLOW_LATEST : p;
}

/**
 * A step to show (a deep link, a file-panel or anomaly pick, a row of the drawer's chain): the panel lists its agent or
 * turn and the drawer opens on it. Null when the step is not known.
 */
export function panelForStep(graph: Graph, nodeId: string): { panel: TimelinePanel; detail: { id: string; scope: string } } | null {
  const scope = scopeOfNode(graph, nodeId);
  return scope === null ? null : { panel: pickedPanel(scope), detail: { id: nodeId, scope: scopeKey(scope) } };
}

/** The execution panel's 内部步骤 on a dispatch: that agent's steps; null for a dispatch whose agent is not known. */
export function panelForDispatch(graph: Graph, dispatchNodeId: string): TimelinePanel | null {
  const agentId = graph.nodes[dispatchNodeId]?.childAgentId ?? null;
  return agentId === null ? null : pickedPanel({ type: 'agent', agentId });
}
