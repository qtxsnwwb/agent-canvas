import type { CanvasView, ViewEdge } from './view';

export interface UpstreamChain {
  /** Includes the start node. */
  nodeIds: ReadonlySet<string>;
  /** The edges walked. */
  edgeIds: ReadonlySet<string>;
  /** Ids of chain nodes of kind thinking or text, ascending by timestamp, then id. */
  reasoning: readonly string[];
}

export const EMPTY_CHAIN: UpstreamChain = { nodeIds: new Set(), edgeIds: new Set(), reasoning: Object.freeze([] as string[]) };

interface Index { incoming: Map<string, ViewEdge[]>; containerOf: Map<string, string> }
const indexes = new WeakMap<CanvasView, Index>();

/** Incoming edges per node (only edges whose source is in the view) and group key -> container id; built once per view. */
function indexOf(view: CanvasView): Index {
  const known = indexes.get(view);
  if (known) return known;
  const incoming = new Map<string, ViewEdge[]>();
  for (const e of view.edges) {
    if (!view.nodes.has(e.from)) continue;
    let list = incoming.get(e.to);
    if (!list) incoming.set(e.to, (list = []));
    list.push(e);
  }
  const containerOf = new Map<string, string>();
  for (const g of view.agentGroups) containerOf.set(g.key, g.containerId);
  const index = { incoming, containerOf };
  indexes.set(view, index);
  return index;
}

/**
 * Walks the view's edges backwards (breadth first, each node once) from `nodeId`. A prompt, a turn summary and an
 * `earlier` node end the walk. A node that starts an agent group (no incoming edge from its own group) continues
 * from the group's container node. Returns EMPTY_CHAIN for null or an id not in the view.
 */
export function upstreamChain(view: CanvasView, nodeId: string | null): UpstreamChain {
  if (nodeId === null || !view.nodes.has(nodeId)) return EMPTY_CHAIN;
  const { incoming, containerOf } = indexOf(view);

  const nodeIds = new Set<string>([nodeId]);
  const edgeIds = new Set<string>();
  const queue: string[] = [nodeId];
  const visit = (id: string): void => {
    if (!nodeIds.has(id)) {
      nodeIds.add(id);
      queue.push(id);
    }
  };
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]!;
    const vn = view.nodes.get(id);
    if (!vn || vn.type !== 'node') continue; // turn summary / earlier: the walk ends here
    if (vn.node.kind === 'prompt') continue;
    const ins = incoming.get(id) ?? [];
    let fromOwnGroup = false;
    for (const e of ins) {
      if (view.nodes.get(e.from)?.groupKey === vn.groupKey) fromOwnGroup = true;
      edgeIds.add(e.id);
      visit(e.from);
    }
    if (!fromOwnGroup) {
      const container = containerOf.get(vn.groupKey);
      if (container !== undefined) visit(container);
    }
  }

  const reasoning: { id: string; ts: number }[] = [];
  for (const id of nodeIds) {
    const vn = view.nodes.get(id);
    if (vn?.type === 'node' && (vn.node.kind === 'thinking' || vn.node.kind === 'text')) {
      const ts = Date.parse(vn.node.timestamp);
      reasoning.push({ id, ts: Number.isNaN(ts) ? 0 : ts });
    }
  }
  reasoning.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { nodeIds, edgeIds, reasoning: reasoning.map((r) => r.id) };
}
