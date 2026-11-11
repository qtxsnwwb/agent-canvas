import type { EdgeKind, Graph, GraphNode } from '@claude-canvas/shared';

export const EXPANDED_RECENT_TURNS = 3;
export const PRELUDE_TURN = '__prelude__';
/** An expanded turn with more main-thread nodes than TURN_FOLD_THRESHOLD shows only its prompt and last TURN_TAIL_NODES. */
export const TURN_TAIL_NODES = 40;
export const TURN_FOLD_THRESHOLD = 60;

/**
 * 'live': everything, subagents expandable. 'topology': no thinking / text nodes, every subagent collapsed.
 * 'causal': the same nodes, groups and edges as 'live'; only the node sizes differ (see sizeOf).
 * 'replay': the node set rules of 'live', applied to the graph as it was at the replay time (the model feeds buildView
 * graphAt(live graph, time)); tool, subagent and text nodes get an overlay row (see sizeOf).
 */
export type ViewMode = 'live' | 'topology' | 'causal' | 'replay';

/** Layout group of the inner nodes of an expanded agent. */
export function agentGroupKey(agentId: string): string {
  return `agent:${agentId}`;
}

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
/**
 * `groupKey`: the layout group — the turn key for main-thread nodes, summaries and `earlier` nodes;
 * agentGroupKey(agentId) for the inner nodes of an expanded agent.
 * `expandable`: a subagent node whose childAgentId is known and has inner nodes. `expanded`: it is shown as a container.
 */
export type ViewNode =
  | {
    type: 'node'; id: string; turnKey: string; groupKey: string; node: GraphNode; innerCount: number;
    expanded: boolean; expandable: boolean;
    /** Compact view: how many calls a run node stands for (0 / absent for any other node). */
    runCount?: number;
    /** Compact view: the duration of the empty thinking nodes removed right in front of this node (0 / absent: none). */
    thinkingMs?: number;
  }
  | { type: 'turn_summary'; id: string; turnKey: string; groupKey: string; summary: TurnSummary }
  /**
   * Stands for the folded middle of a long expanded turn (id `earlier:${turnKey}`, groupKey = the turn key) or of a long
   * expanded agent (id `earlier:${groupKey}`, groupKey = the agent group key, turnKey = the container's turn).
   */
  | { type: 'earlier'; id: string; turnKey: string; groupKey: string; count: number; toolCount: number; failedCount: number };
export interface ViewEdge { id: string; from: string; to: string; kind: EdgeKind }
/**
 * `foldedEarlier`: how many nodes the turn's `earlier` node stands for (0 when the turn is not folded that way);
 * `foldedIds`: those nodes' ids, in time order. In topology mode `nodeIds` is empty for an expanded turn with no
 * visible node.
 */
export interface TurnView {
  key: string;
  collapsed: boolean;
  summary: TurnSummary;
  nodeIds: string[];
  foldedEarlier: number;
  foldedIds: string[];
}
/** The inner nodes of an expanded agent, drawn inside its dispatch (container) node. */
export interface AgentGroup {
  key: string;
  agentId: string;
  containerId: string;
  parentGroupKey: string;
  /** 1 for an agent dispatched from the main thread, 2 for one dispatched inside it, … */
  depth: number;
  /**
   * View node ids in order: ascending by timestamp, then id; when the group is folded, its first node, its `earlier`
   * node (`earlier:${key}`), then the other visible nodes.
   */
  nodeIds: string[];
  /** The inner node ids folded into the group's `earlier` node, in time order (empty when it is not folded). */
  foldedIds: string[];
}
export interface BuildViewOptions {
  /**
   * Turn key or agent group key -> node ids hidden in that turn's / group's `earlier` node. For a key in this map the
   * set replaces the length rule: exactly these ids (those that still exist) are hidden, every other node is shown.
   */
  frozenHidden?: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * A node that must stay visible (the selection): never folded into `earlier`, and its turn is not auto-collapsed.
   * When it is an inner node of an expanded agent, the same holds for its container, every container above that, and
   * the turn holding the outermost container.
   */
  keepVisible?: string | null;
  /**
   * Agent ids (a dispatch node's childAgentId) to show expanded. A dispatch node is expanded only outside topology mode,
   * when it is itself in the view, is expandable, and its agent is not on its own ancestor chain; each agent id yields
   * at most one group (the first such dispatch node in view order). A group with more than TURN_FOLD_THRESHOLD inner
   * nodes is folded like a long turn: its first node, an `earlier` node, its last TURN_TAIL_NODES (unless its group key
   * is in `fullTurns` or `frozenHidden`).
   */
  expandedAgents?: ReadonlySet<string>;
  /** Default 'live'. In topology mode the in-turn fold counts only nodes visible in that mode. */
  mode?: ViewMode;
  /** Compact view (see compactGraph): run node id -> member ids. A run counts as that many tool calls. */
  runs?: ReadonlyMap<string, readonly string[]>;
  /** Compact view (see compactGraph): node id -> thinking time removed in front of it. */
  thinkingMs?: ReadonlyMap<string, number>;
}
export interface CanvasView {
  turns: TurnView[];
  nodes: Map<string, ViewNode>;
  edges: ViewEdge[];
  latestNodeId: string | null;
  /** Deepest first, then by key. */
  agentGroups: AgentGroup[];
  mode: ViewMode;
}

/** View nodes with two or more outgoing view edges (except those `ignore` accepts): their outgoing edges are drawn as a fork. */
export function forkSources(edges: readonly Pick<ViewEdge, 'from'>[], ignore?: (id: string) => boolean): Set<string> {
  const out = new Map<string, number>();
  const forks = new Set<string>();
  for (const e of edges) {
    if (ignore?.(e.from)) continue;
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
function hiddenInTopology(node: GraphNode): boolean {
  return node.kind === 'thinking' || node.kind === 'text';
}

function summarize(key: string, entries: Entry[], toolWeight: (node: GraphNode) => number): TurnSummary {
  const first = entries[0]!;
  const last = entries[entries.length - 1]!;
  let toolCount = 0;
  let failedCount = 0;
  let running = false;
  for (const { node } of entries) {
    toolCount += toolWeight(node);
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
const NO_FROZEN: ReadonlyMap<string, ReadonlySet<string>> = new Map();
const NO_AGENTS: ReadonlySet<string> = new Set();

interface PendingGroup { agentId: string; containerId: string; parentGroupKey: string; turnKey: string; depth: number; ancestors: ReadonlySet<string> }

/**
 * `overrides`: turn key -> expanded. `fullTurns`: expanded turns shown in full even when they are long (otherwise
 * the middle of a long turn is folded into one `earlier` node). See BuildViewOptions for the rest.
 */
export function buildView(
  graph: Graph,
  overrides: ReadonlyMap<string, boolean>,
  fullTurns: ReadonlySet<string> = NO_FULL_TURNS,
  options: BuildViewOptions = {},
): CanvasView {
  const frozenHidden = options.frozenHidden ?? NO_FROZEN;
  const keepVisible = options.keepVisible ?? null;
  const mode: ViewMode = options.mode ?? 'live';
  const topology = mode === 'topology';
  const expandedAgents = topology ? NO_AGENTS : options.expandedAgents ?? NO_AGENTS;
  /** Main-thread nodes not drawn in this mode (they still count in turn summaries and edges are contracted through them). */
  const isHidden = (node: GraphNode): boolean => topology && hiddenInTopology(node);
  const runs = options.runs;
  const thinkingMs = options.thinkingMs;
  /** How many tool calls the node counts as (a run node: its members). */
  const toolWeight = (node: GraphNode): number =>
    node.kind === 'tool' || node.kind === 'subagent' ? runs?.get(node.id)?.length ?? 1 : 0;
  // Pass over nodes: main-thread entries, inner-node counts per agent, inner entries of the agents asked to expand.
  const main: Entry[] = [];
  const innerByAgent = new Map<string, number>();
  const innerEntries = new Map<string, Entry[]>();
  /** Agent id -> its earliest dispatch node (only needed to protect the containers above keepVisible). */
  const dispatchOf = new Map<string, Entry>();
  for (const node of Object.values(graph.nodes)) {
    if (node.kind === 'subagent' && node.childAgentId !== null && keepVisible !== null) {
      const entry = { node, ms: parseMs(node.timestamp) };
      const known = dispatchOf.get(node.childAgentId);
      if (!known || byTimeThenId(entry, known) < 0) dispatchOf.set(node.childAgentId, entry);
    }
    if (node.agentId === null) {
      main.push({ node, ms: parseMs(node.timestamp) });
      continue;
    }
    innerByAgent.set(node.agentId, (innerByAgent.get(node.agentId) ?? 0) + 1);
    if (expandedAgents.has(node.agentId)) {
      let list = innerEntries.get(node.agentId);
      if (!list) innerEntries.set(node.agentId, (list = []));
      list.push({ node, ms: parseMs(node.timestamp) });
    }
  }
  main.sort(byTimeThenId);

  /** keepVisible and, when it is an inner node of an expanded agent, the dispatch nodes above it up to the main thread. */
  const protectedIds = new Set<string>();
  for (let id = keepVisible; id !== null && !protectedIds.has(id);) {
    protectedIds.add(id);
    const agentId = graph.nodes[id]?.agentId ?? null;
    id = agentId !== null && expandedAgents.has(agentId) ? dispatchOf.get(agentId)?.node.id ?? null : null;
  }
  /** Never folded into `earlier`: still running, or the selection (and its containers). */
  const mustShow = (node: GraphNode): boolean => isActiveStatus(node) || protectedIds.has(node.id);

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
  /**
   * Visible nodes of a folded turn / agent group shown after its `earlier` node -> the next visible node of the same
   * turn / group in time order.
   */
  const nextAfterEarlier = new Map<string, string | null>();
  /** Agent groups to fill, in discovery order (breadth first). */
  const pending: PendingGroup[] = [];
  const claimedAgents = new Set<string>();
  const NO_ANCESTORS: ReadonlySet<string> = new Set();
  const addNode = (turnKey: string, groupKey: string, node: GraphNode, depth: number, ancestors: ReadonlySet<string>): void => {
    const child = node.childAgentId;
    const innerCount = child ? (innerByAgent.get(child) ?? 0) : 0;
    const expandable = node.kind === 'subagent' && child !== null && innerCount > 0;
    const expanded = expandable && child !== null && expandedAgents.has(child) && !ancestors.has(child) && !claimedAgents.has(child);
    if (expanded && child !== null) {
      claimedAgents.add(child);
      pending.push({ agentId: child, containerId: node.id, parentGroupKey: groupKey, turnKey, depth: depth + 1, ancestors });
    }
    nodes.set(node.id, {
      type: 'node', id: node.id, turnKey, groupKey, node, innerCount, expanded, expandable,
      runCount: runs?.get(node.id)?.length ?? 0, thinkingMs: thinkingMs?.get(node.id) ?? 0,
    });
  };
  /**
   * The ids of an expanded turn / agent group to fold into `earlier` (empty: show everything). `head`: how many leading
   * nodes the length rule always shows.
   */
  const hiddenOf = (key: string, entries: Entry[], head: number): Set<string> => {
    const hidden = new Set<string>();
    if (fullTurns.has(key)) return hidden;
    const frozen = frozenHidden.get(key);
    if (frozen) {
      for (const { node } of entries) if (frozen.has(node.id) && !mustShow(node)) hidden.add(node.id);
    } else if (entries.length > TURN_FOLD_THRESHOLD) {
      for (const { node } of entries.slice(head, entries.length - TURN_TAIL_NODES)) if (!mustShow(node)) hidden.add(node.id);
    }
    return hidden;
  };
  /**
   * Adds the visible nodes of a turn / agent group (through `add`, in time order) and, when `hidden` is not empty, its
   * `earlier` node; returns the view ids in order ([head], earlier, then every other visible node) and the folded ids.
   */
  const assemble = (
    turnKey: string, groupKey: string, entries: Entry[], hidden: ReadonlySet<string>, headId: string | null,
    add: (node: GraphNode) => void,
  ): { nodeIds: string[]; foldedIds: string[] } => {
    const foldedIds: string[] = [];
    if (hidden.size === 0) {
      for (const { node } of entries) add(node);
      return { nodeIds: entries.map((x) => x.node.id), foldedIds };
    }
    const earlierId = `earlier:${groupKey}`;
    const after: string[] = [];
    let toolCount = 0;
    let failedCount = 0;
    for (const { node } of entries) {
      if (hidden.has(node.id)) {
        foldedInto.set(node.id, earlierId);
        foldedIds.push(node.id);
        toolCount += toolWeight(node);
        if (node.status === 'failed' || node.status === 'denied') failedCount++;
        continue;
      }
      add(node);
      if (node.id !== headId) after.push(node.id);
    }
    after.forEach((id, k) => nextAfterEarlier.set(id, after[k + 1] ?? null));
    nodes.set(earlierId, { type: 'earlier', id: earlierId, turnKey, groupKey, count: foldedIds.length, toolCount, failedCount });
    return { nodeIds: [...(headId !== null ? [headId] : []), earlierId, ...after], foldedIds };
  };
  ordered.forEach(({ key, entries: all }, i) => {
    const entries = topology ? all.filter((x) => !isHidden(x.node)) : all;
    const expandedOverride = overrides.get(key);
    const holdsKept = protectedIds.size > 0 && entries.some((x) => protectedIds.has(x.node.id));
    const collapsed = expandedOverride === undefined
      ? i < ordered.length - EXPANDED_RECENT_TURNS && !holdsKept
      : !expandedOverride;
    const summary = summarize(key, all, toolWeight);
    let nodeIds: string[];
    let foldedIds: string[] = [];
    if (collapsed) {
      collapsedKeys.add(key);
      nodeIds = [`turn:${key}`];
      nodes.set(nodeIds[0]!, { type: 'turn_summary', id: nodeIds[0]!, turnKey: key, groupKey: key, summary });
    } else {
      // The length rule always shows a leading prompt.
      const first = entries[0]?.node;
      const hidden = hiddenOf(key, entries, first?.kind === 'prompt' ? 1 : 0);
      const headId = first !== undefined && first.kind === 'prompt' && !hidden.has(first.id) ? first.id : null;
      ({ nodeIds, foldedIds } = assemble(key, key, entries, hidden, headId, (node) => addNode(key, key, node, 0, NO_ANCESTORS)));
    }
    turns.push({ key, collapsed, summary, nodeIds, foldedEarlier: foldedIds.length, foldedIds });
  });

  // Fill the agent groups; a nested container found while filling appends its own group (unless it is folded into its
  // group's `earlier` node).
  const agentGroups: AgentGroup[] = [];
  /** Inner node id -> its agent group key (inner nodes of every group in the view, including folded ones). */
  const groupOfInner = new Map<string, string>();
  for (let k = 0; k < pending.length; k++) {
    const g = pending[k]!;
    const key = agentGroupKey(g.agentId);
    const ancestors = new Set(g.ancestors).add(g.agentId);
    const list = (innerEntries.get(g.agentId) ?? []).sort(byTimeThenId);
    // The length rule always shows the group's first node.
    const hidden = hiddenOf(key, list, 1);
    const first = list[0]?.node;
    const headId = first !== undefined && !hidden.has(first.id) ? first.id : null;
    const { nodeIds, foldedIds } = assemble(g.turnKey, key, list, hidden, headId, (node) => addNode(g.turnKey, key, node, g.depth, ancestors));
    for (const { node } of list) groupOfInner.set(node.id, key);
    agentGroups.push({
      key, agentId: g.agentId, containerId: g.containerId, parentGroupKey: g.parentGroupKey, depth: g.depth, nodeIds, foldedIds,
    });
  }
  agentGroups.sort((a, b) => b.depth - a.depth || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const viewId = (nodeId: string): string => {
    const key = turnOf.get(nodeId)!;
    return collapsedKeys.has(key) ? `turn:${key}` : foldedInto.get(nodeId) ?? nodeId;
  };

  const edges = new Map<string, ViewEdge>();
  const connectedPairs = new Set<string>();
  const turnIndex = new Map(ordered.map((t, i) => [t.key, i]));
  /** Adds the view edge for a graph edge between two drawn (not mode-hidden) nodes. */
  const emit = (gFrom: string, gTo: string, kind: EdgeKind): void => {
    const innerFrom = groupOfInner.get(gFrom);
    const innerTo = groupOfInner.get(gTo);
    if (innerFrom !== undefined || innerTo !== undefined) {
      if (innerFrom !== innerTo) return; // across groups
      // Folded inner nodes map to their group's `earlier` node, as in a folded turn (see below).
      const from = foldedInto.get(gFrom) ?? gFrom;
      let to = foldedInto.get(gTo) ?? gTo;
      if (to !== gTo) {
        const next = nextAfterEarlier.get(from);
        if (next === null) return;
        if (next !== undefined) to = next;
      }
      if (from === to) return;
      const id = `${from}->${to}`;
      if (!edges.has(id)) edges.set(id, { id, from, to, kind });
      return;
    }
    const fromTurn = turnOf.get(gFrom);
    const toTurn = turnOf.get(gTo);
    if (fromTurn === undefined || toTurn === undefined) return;
    const from = viewId(gFrom);
    let to = viewId(gTo);
    // From a node shown after `earlier` (a kept running / selected node) into the folded range: continue to the next
    // visible node in time order instead of looping back into `earlier`.
    if (fromTurn === toTurn && to !== gTo && foldedInto.has(gTo)) {
      const next = nextAfterEarlier.get(from);
      if (next === null) return;
      if (next !== undefined) to = next;
    }
    if (from === to) return;
    if (fromTurn !== toTurn) {
      const a = turnIndex.get(fromTurn)!;
      const b = turnIndex.get(toTurn)!;
      connectedPairs.add(`${Math.min(a, b)}:${Math.max(a, b)}`);
    }
    const id = `${from}->${to}`;
    if (!edges.has(id)) edges.set(id, { id, from, to, kind: fromTurn === toTurn ? kind : 'sequence' });
  };
  const allEdges = Object.values(graph.edges);
  /** Topology mode: a hidden main-thread node is a member of turnOf whose kind is hidden. */
  const isHiddenId = (id: string): boolean => {
    if (!topology || !turnOf.has(id)) return false;
    return isHidden(graph.nodes[id]!);
  };
  // Topology mode: incoming main-thread edges of hidden nodes, for contraction.
  const incomingHidden = new Map<string, string[]>();
  if (topology) {
    for (const edge of allEdges) {
      if (edge.kind === 'spawn' || !turnOf.has(edge.from) || !isHiddenId(edge.to)) continue;
      let list = incomingHidden.get(edge.to);
      if (!list) incomingHidden.set(edge.to, (list = []));
      list.push(edge.from);
    }
  }
  /**
   * The first visible nodes met walking edges backwards from hidden node `id` through hidden nodes. Iterative (a long
   * run of hidden nodes must not overflow the stack); each start's result is memoized and reused by later walks that
   * reach that node.
   */
  const upstreamMemo = new Map<string, readonly string[]>();
  const upstream = (id: string): readonly string[] => {
    const known = upstreamMemo.get(id);
    if (known) return known;
    const found = new Set<string>();
    const seen = new Set<string>([id]);
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      const memo = cur === id ? undefined : upstreamMemo.get(cur);
      if (memo) {
        for (const x of memo) found.add(x);
        continue;
      }
      for (const src of incomingHidden.get(cur) ?? []) {
        if (!isHiddenId(src)) found.add(src);
        else if (!seen.has(src)) {
          seen.add(src);
          stack.push(src);
        }
      }
    }
    const result = [...found];
    upstreamMemo.set(id, result);
    return result;
  };
  for (const edge of allEdges) {
    if (edge.kind === 'spawn') continue; // the container already shows it
    if (topology) {
      if (isHiddenId(edge.to)) continue; // reached through the visible node downstream
      if (isHiddenId(edge.from)) {
        for (const a of upstream(edge.from)) emit(a, edge.to, edge.kind);
        continue;
      }
    }
    emit(edge.from, edge.to, edge.kind);
  }
  // Consecutive non-empty turns with no edge between them get a sequence edge.
  let prev = -1;
  for (let i = 0; i < turns.length; i++) {
    if (turns[i]!.nodeIds.length === 0) continue;
    if (prev >= 0 && !connectedPairs.has(`${prev}:${i}`)) {
      const from = turns[prev]!.nodeIds[turns[prev]!.nodeIds.length - 1]!;
      const to = turns[i]!.nodeIds[0]!;
      const id = `${from}->${to}`;
      if (!edges.has(id)) edges.set(id, { id, from, to, kind: 'sequence' });
    }
    prev = i;
  }

  // The latest main-thread node; in topology mode the latest visible one not later than it.
  let latest: Entry | undefined;
  for (let k = main.length - 1; k >= 0; k--) {
    if (!isHidden(main[k]!.node)) { latest = main[k]; break; }
  }
  return {
    turns, nodes, edges: [...edges.values()], latestNodeId: latest ? viewId(latest.node.id) : null, agentGroups, mode,
  };
}
