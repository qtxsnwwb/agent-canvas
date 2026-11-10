import type { CanvasView, ViewEdge, ViewNode } from './view';

/**
 * Stacking order of the canvas (React Flow runs with zIndexMode="manual", so these values are used as they are).
 * Containers are ordinary flat nodes drawn underneath their inner nodes: every view node and every edge gets the depth
 * of its layout group (0 for a turn, AgentGroup.depth for the inner nodes of an expanded agent). A container belongs to
 * the group it sits in, so it is one below its inner nodes and one above the container it is nested in; an edge inside
 * a group is drawn above that group's container. Nodes paint above edges of the same zIndex (React Flow renders the
 * node layer after the edge layer).
 */
export type GroupDepths = ReadonlyMap<string, number>;

/** Agent group key -> its depth; groups not in the map (turns) are depth 0. */
export function groupDepths(view: Pick<CanvasView, 'agentGroups'>): GroupDepths {
  return new Map(view.agentGroups.map((g) => [g.key, g.depth]));
}

export function nodeZ(depths: GroupDepths, vn: Pick<ViewNode, 'groupKey'>): number {
  return depths.get(vn.groupKey) ?? 0;
}

/** The deeper of the two endpoints' layers (view edges never cross groups, so both are normally equal). */
export function edgeZ(view: Pick<CanvasView, 'nodes'>, depths: GroupDepths, edge: Pick<ViewEdge, 'from' | 'to'>): number {
  const from = view.nodes.get(edge.from);
  const to = view.nodes.get(edge.to);
  return Math.max(from ? nodeZ(depths, from) : 0, to ? nodeZ(depths, to) : 0);
}
