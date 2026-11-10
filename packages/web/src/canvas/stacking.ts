import type { CanvasView, ViewEdge, ViewNode } from './view';

/**
 * Stacking order of the canvas (React Flow runs with zIndexMode="manual", so these values are used as they are; CSS
 * z-index takes integers only). Containers are ordinary flat nodes drawn underneath their inner nodes: every view node
 * and every edge belongs to the layer of its layout group (depth 0 for a turn, AgentGroup.depth for the inner nodes of
 * an expanded agent). Each layer spans Z_PER_DEPTH values, bottom to top: its edges, its edges on the causal chain
 * (drawn above the dimmed ones), its nodes. A container belongs to the group it sits in, so it is below its inner
 * edges and nodes and above the container it is nested in.
 */
export type GroupDepths = ReadonlyMap<string, number>;

export const Z_PER_DEPTH = 3;
const CHAIN_EDGE_OFFSET = 1;
const NODE_OFFSET = 2;

/** Agent group key -> its depth; groups not in the map (turns) are depth 0. */
export function groupDepths(view: Pick<CanvasView, 'agentGroups'>): GroupDepths {
  return new Map(view.agentGroups.map((g) => [g.key, g.depth]));
}

function depthOf(depths: GroupDepths, vn: Pick<ViewNode, 'groupKey'>): number {
  return depths.get(vn.groupKey) ?? 0;
}

export function nodeZ(depths: GroupDepths, vn: Pick<ViewNode, 'groupKey'>): number {
  return depthOf(depths, vn) * Z_PER_DEPTH + NODE_OFFSET;
}

/**
 * The layer of the deeper of the two endpoints (view edges never cross groups, so both are normally equal); an edge on
 * the causal chain (`onChain`) is raised above the other edges of its layer, still below the layer's nodes.
 */
export function edgeZ(
  view: Pick<CanvasView, 'nodes'>, depths: GroupDepths, edge: Pick<ViewEdge, 'from' | 'to'>, onChain = false,
): number {
  const from = view.nodes.get(edge.from);
  const to = view.nodes.get(edge.to);
  const depth = Math.max(from ? depthOf(depths, from) : 0, to ? depthOf(depths, to) : 0);
  return depth * Z_PER_DEPTH + (onChain ? CHAIN_EDGE_OFFSET : 0);
}
