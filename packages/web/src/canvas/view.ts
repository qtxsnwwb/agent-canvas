import type { EdgeKind, Graph, GraphNode } from '@claude-canvas/shared';

export const EXPANDED_RECENT_TURNS = 3;
export const PRELUDE_TURN = '__prelude__';
/** An expanded turn with more main-thread nodes than TURN_FOLD_THRESHOLD shows only its prompt and last TURN_TAIL_NODES. */
export const TURN_TAIL_NODES = 40;
export const TURN_FOLD_THRESHOLD = 60;

export interface TurnSummary {
  turnKey: string;
  promptSummary: string;
  nodeCount: number;
  toolCount: number;
  failedCount: number;
  running: boolean;
  startedAt: string;
  durationMs: number;
}
export type ViewNode =
  | { type: 'node'; id: string; turnKey: string; node: GraphNode; innerCount: number }
  | { type: 'turn_summary'; id: string; turnKey: string; summary: TurnSummary }
  /** Stands for the folded middle of a long expanded turn; id is `earlier:${turnKey}`. */
  | { type: 'earlier'; id: string; turnKey: string; count: number; toolCount: number; failedCount: number };
export interface ViewEdge { id: string; from: string; to: string; kind: EdgeKind }
/** `foldedEarlier`: how many nodes the turn's `earlier` node stands for (0 when the turn is not folded that way). */
export interface TurnView { key: string; collapsed: boolean; summary: TurnSummary; nodeIds: string[]; foldedEarlier: number }
export interface CanvasView {
  turns: TurnView[];
  nodes: Map<string, ViewNode>;
  edges: ViewEdge[];
  latestNodeId: string | null;
}

/** View nodes with two or more outgoing view edges: their outgoing edges are drawn as a fork. */
export function forkSources(edges: readonly Pick<ViewEdge, 'from'>[]): Set<string> {
  const out = new Map<string, number>();
  const forks = new Set<string>();
  for (const e of edges) {
    const n = (out.get(e.from) ?? 0) + 1;
    out.set(e.from, n);
    if (n >= 2) forks.add(e.from);
  }
  return forks;
}

interface Entry { node: GraphNode; ms: number }

function parseMs(ts: string): number {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? 0 : ms;
}
function byTimeThenId(a: Entry, b: Entry): number {
  return a.ms - b.ms || (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0);
}

function isActiveStatus(node: GraphNode): boolean {
  return node.status === 'running' || node.status === 'awaiting_permission';
}

function summarize(key: string, entries: Entry[]): TurnSummary {
  const first = entries[0]!;
  const last = entries[entries.length - 1]!;
  let toolCount = 0;
  let failedCount = 0;
  let running = false;
  for (const { node } of entries) {
    if (node.kind === 'tool' || node.kind === 'subagent') toolCount++;
    if (node.status === 'failed' || node.status === 'denied') failedCount++;
    if (isActiveStatus(node)) running = true;
  }
  return {
    turnKey: key,
    promptSummary: entries.find((x) => x.node.kind === 'prompt')?.node.summary ?? '',
    nodeCount: entries.length,
    toolCount,
    failedCount,
    running,
    startedAt: first.node.timestamp,
    durationMs: last.ms - first.ms,
  };
}

const NO_FULL_TURNS: ReadonlySet<string> = new Set();

/**
 * `overrides`: turn key -> expanded. `fullTurns`: expanded turns shown in full even when they are long (otherwise
 * the middle of a long turn is folded into one `earlier` node).
 */
export function buildView(graph: Graph, overrides: ReadonlyMap<string, boolean>, fullTurns: ReadonlySet<string> = NO_FULL_TURNS): CanvasView {
  // Pass over nodes: main-thread entries, inner-node counts per agent.
  const main: Entry[] = [];
  const innerByAgent = new Map<string, number>();
  for (const node of Object.values(graph.nodes)) {
    if (node.agentId === null) main.push({ node, ms: parseMs(node.timestamp) });
    else innerByAgent.set(node.agentId, (innerByAgent.get(node.agentId) ?? 0) + 1);
  }
  main.sort(byTimeThenId);

  // Turns with a turnId define the turn start times.
  const turnStart = new Map<string, number>();
  for (const x of main) {
    const key = x.node.turnId;
    if (key !== null && !turnStart.has(key)) turnStart.set(key, x.ms); // sorted, so first seen = earliest
  }
  const anchors = [...turnStart].map(([key, ms]) => ({ key, ms })).sort((a, b) => a.ms - b.ms || (a.key < b.key ? -1 : 1));

  const groups = new Map<string, Entry[]>();
  const turnOf = new Map<string, string>();
  for (const x of main) {
    let key = x.node.turnId;
    if (key === null) {
      key = PRELUDE_TURN;
      for (const a of anchors) {
        if (a.ms <= x.ms) key = a.key; else break;
      }
    }
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(x);
    turnOf.set(x.node.id, key);
  }

  const ordered = [...groups].map(([key, entries]) => ({ key, entries, start: turnStart.get(key) ?? entries[0]!.ms }))
    .sort((a, b) => a.start - b.start || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const nodes = new Map<string, ViewNode>();
  const turns: TurnView[] = [];
  const collapsedKeys = new Set<string>();
  /** Hidden node id -> the id of the `earlier` node that stands for it. */
  const foldedInto = new Map<string, string>();
  const addNode = (key: string, node: GraphNode): void => {
    const innerCount = node.childAgentId ? (innerByAgent.get(node.childAgentId) ?? 0) : 0;
    nodes.set(node.id, { type: 'node', id: node.id, turnKey: key, node, innerCount });
  };
  ordered.forEach(({ key, entries }, i) => {
    const expandedOverride = overrides.get(key);
    const collapsed = expandedOverride === undefined ? i < ordered.length - EXPANDED_RECENT_TURNS : !expandedOverride;
    const summary = summarize(key, entries);
    let nodeIds: string[];
    let foldedEarlier = 0;
    if (collapsed) {
      collapsedKeys.add(key);
      nodeIds = [`turn:${key}`];
      nodes.set(nodeIds[0]!, { type: 'turn_summary', id: nodeIds[0]!, turnKey: key, summary });
    } else if (entries.length > TURN_FOLD_THRESHOLD && !fullTurns.has(key)) {
      const head = entries[0]!.node.kind === 'prompt' ? 1 : 0;
      const tailStart = entries.length - TURN_TAIL_NODES;
      const earlierId = `earlier:${key}`;
      const kept: string[] = [];
      let toolCount = 0;
      let failedCount = 0;
      for (const { node } of entries.slice(head, tailStart)) {
        if (isActiveStatus(node)) { // still running: stays visible, in time order after the earlier node
          kept.push(node.id);
          addNode(key, node);
          continue;
        }
        foldedInto.set(node.id, earlierId);
        foldedEarlier++;
        if (node.kind === 'tool' || node.kind === 'subagent') toolCount++;
        if (node.status === 'failed' || node.status === 'denied') failedCount++;
      }
      const headIds = entries.slice(0, head).map((x) => x.node.id);
      const tail = entries.slice(tailStart);
      for (const { node } of [...entries.slice(0, head), ...tail]) addNode(key, node);
      if (foldedEarlier > 0) {
        nodes.set(earlierId, { type: 'earlier', id: earlierId, turnKey: key, count: foldedEarlier, toolCount, failedCount });
        nodeIds = [...headIds, earlierId, ...kept, ...tail.map((x) => x.node.id)];
      } else {
        nodeIds = [...headIds, ...kept, ...tail.map((x) => x.node.id)];
      }
    } else {
      nodeIds = entries.map((x) => x.node.id);
      for (const { node } of entries) addNode(key, node);
    }
    turns.push({ key, collapsed, summary, nodeIds, foldedEarlier });
  });

  const viewId = (nodeId: string): string => {
    const key = turnOf.get(nodeId)!;
    return collapsedKeys.has(key) ? `turn:${key}` : foldedInto.get(nodeId) ?? nodeId;
  };

  const edges = new Map<string, ViewEdge>();
  const connectedPairs = new Set<string>();
  const turnIndex = new Map(ordered.map((t, i) => [t.key, i]));
  for (const edge of Object.values(graph.edges)) {
    const fromTurn = turnOf.get(edge.from);
    const toTurn = turnOf.get(edge.to);
    if (fromTurn === undefined || toTurn === undefined) continue;
    const from = viewId(edge.from);
    const to = viewId(edge.to);
    if (from === to) continue;
    if (fromTurn !== toTurn) {
      const a = turnIndex.get(fromTurn)!;
      const b = turnIndex.get(toTurn)!;
      connectedPairs.add(`${Math.min(a, b)}:${Math.max(a, b)}`);
    }
    const id = `${from}->${to}`;
    if (!edges.has(id)) edges.set(id, { id, from, to, kind: fromTurn === toTurn ? edge.kind : 'sequence' });
  }
  for (let i = 0; i + 1 < turns.length; i++) {
    if (connectedPairs.has(`${i}:${i + 1}`)) continue;
    const from = turns[i]!.nodeIds[turns[i]!.nodeIds.length - 1]!;
    const to = turns[i + 1]!.nodeIds[0]!;
    const id = `${from}->${to}`;
    if (!edges.has(id)) edges.set(id, { id, from, to, kind: 'sequence' });
  }

  const latest = main[main.length - 1];
  return { turns, nodes, edges: [...edges.values()], latestNodeId: latest ? viewId(latest.node.id) : null };
}
