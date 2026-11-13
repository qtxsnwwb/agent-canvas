import type { Graph, GraphNode } from '@agent-canvas/shared';
import { turnKeyOf } from './view';

/**
 * What has to be opened for a node to be shown: `agents` — the subagents it sits in, outermost first (each must be
 * expanded); `turnKey` — the turn of the outermost dispatch on the main thread (or of the node itself), null when the
 * chain does not reach the main thread; `dispatchId` — the dispatch node of the node's own agent (null on the main
 * thread or when unknown). Null for an unknown node.
 */
export interface RevealPlan {
  turnKey: string | null;
  agents: string[];
  dispatchId: string | null;
}

/** The earliest subagent node dispatching `agentId`. */
function dispatchOf(graph: Graph, agentId: string): GraphNode | null {
  let best: GraphNode | null = null;
  for (const n of Object.values(graph.nodes)) {
    if (n.kind !== 'subagent' || n.childAgentId !== agentId) continue;
    if (best === null || n.timestamp < best.timestamp || (n.timestamp === best.timestamp && n.id < best.id)) best = n;
  }
  return best;
}

export function revealPlan(graph: Graph, nodeId: string): RevealPlan | null {
  const node = graph.nodes[nodeId];
  if (node === undefined) return null;
  const agents: string[] = [];
  let dispatchId: string | null = null;
  let cur: GraphNode = node;
  while (cur.agentId !== null) {
    if (agents.includes(cur.agentId)) return { turnKey: null, agents, dispatchId }; // a loop: no main thread
    agents.unshift(cur.agentId);
    const d = dispatchOf(graph, cur.agentId);
    if (dispatchId === null && cur === node) dispatchId = d?.id ?? null;
    if (d === null) return { turnKey: null, agents, dispatchId };
    cur = d;
  }
  return { turnKey: turnKeyOf(graph, cur.id), agents, dispatchId };
}
