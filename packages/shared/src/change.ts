import type { GraphEdge, GraphNode, NodeDetail, Session } from './model.js';

export type Change =
  | { type: 'session_upserted'; session: Session }
  | { type: 'node_added'; node: GraphNode; detail: Partial<NodeDetail> }
  | { type: 'node_updated'; sessionId: string; id: string; patch: Partial<GraphNode>; detail?: Partial<NodeDetail> }
  | { type: 'edge_added'; edge: GraphEdge };
export type SeqChange = Change & { seq: number };

export interface Graph { nodes: Record<string, GraphNode>; edges: Record<string, GraphEdge> }

export function emptyGraph(): Graph {
  return { nodes: {}, edges: {} };
}

/** Immutable update. session_upserted is returned unchanged; updates to unknown nodes are ignored. */
export function applyChange(graph: Graph, change: Change): Graph {
  switch (change.type) {
    case 'node_added':
      return { ...graph, nodes: { ...graph.nodes, [change.node.id]: change.node } };
    case 'node_updated': {
      const existing = graph.nodes[change.id];
      if (!existing) return graph;
      return { ...graph, nodes: { ...graph.nodes, [change.id]: { ...existing, ...change.patch } } };
    }
    case 'edge_added':
      return { ...graph, edges: { ...graph.edges, [change.edge.id]: change.edge } };
    case 'session_upserted':
      return graph;
  }
}
