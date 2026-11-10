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

/**
 * Batched form of folding applyChange over `changes`: same result, but each map is copied at most once.
 * Returns `graph` itself when nothing changed.
 */
export function applyChanges(graph: Graph, changes: Change[]): Graph {
  let nodes: Graph['nodes'] | null = null;
  let edges: Graph['edges'] | null = null;
  for (const c of changes) {
    switch (c.type) {
      case 'node_added':
        (nodes ??= { ...graph.nodes })[c.node.id] = c.node;
        break;
      case 'node_updated': {
        const existing = (nodes ?? graph.nodes)[c.id];
        if (!existing) break;
        (nodes ??= { ...graph.nodes })[c.id] = { ...existing, ...c.patch };
        break;
      }
      case 'edge_added':
        (edges ??= { ...graph.edges })[c.edge.id] = c.edge;
        break;
      case 'session_upserted':
        break;
    }
  }
  if (nodes === null && edges === null) return graph;
  return { ...graph, nodes: nodes ?? graph.nodes, edges: edges ?? graph.edges };
}
