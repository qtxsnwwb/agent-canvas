import { SUMMARY_MAX, type EdgeKind, type Graph, type GraphEdge, type GraphNode } from '@claude-canvas/shared';

/** A run node stands for at least this many calls. */
export const RUN_MIN = 3;
const RUN_PREFIX = 'run:';

/** The id of the run node whose first member (by time, then id) is `firstMemberId`. Stable while the run grows. */
export function runIdOf(firstMemberId: string): string {
  return RUN_PREFIX + firstMemberId;
}
export function isRunId(id: string): boolean {
  return id.startsWith(RUN_PREFIX);
}

export interface CompactOptions {
  /** A node (the selection) that is neither removed nor merged into a run. */
  keep?: string | null;
  /** Return false to leave the run with this id unmerged (a run that would form under a reader). */
  allowRun?: (runId: string) => boolean;
  /** Node ids that are never merged into a run (the calls of a run the user expanded). */
  exclude?: ReadonlySet<string>;
}
export interface CompactResult {
  /** `graph` itself when nothing was removed or merged. */
  graph: Graph;
  /** Run node id -> its member node ids, by time then id. */
  runs: Map<string, string[]>;
  /** Node id (in the compacted graph) -> the summed duration of the empty thinking nodes removed right in front of it. */
  thinkingMs: Map<string, number>;
}
export type Compactor = (graph: Graph, options?: CompactOptions) => CompactResult;

const KEPT_SYSTEM = new Set(['compact', 'interrupt']);

/** A node with nothing to read in it: a thinking node without text, or a system node other than compaction / interrupt. */
export function isNoise(node: GraphNode): boolean {
  return node.kind === 'thinking' ? node.summary === '' : node.kind === 'system' && !KEPT_SYSTEM.has(node.systemSubtype ?? '');
}

function parseMs(ts: string): number {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? 0 : ms;
}
/** Nodes by time, then id. Timestamps are parsed once per node, not once per comparison. */
function sortByTime(nodes: GraphNode[]): GraphNode[] {
  return nodes.map((node) => ({ node, ms: parseMs(node.timestamp) }))
    .sort((a, b) => a.ms - b.ms || (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0))
    .map((x) => x.node);
}

function runNode(members: GraphNode[]): GraphNode {
  const first = members[0]!;
  let durationMs: number | null = null;
  let endedAt: string | null = null;
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const m of members) {
    if (m.durationMs !== null) durationMs = (durationMs ?? 0) + m.durationMs;
    if (m.endedAt !== null && (endedAt === null || parseMs(m.endedAt) > parseMs(endedAt))) endedAt = m.endedAt;
    if (m.summary !== '' && !seen.has(m.summary)) {
      seen.add(m.summary);
      parts.push(m.summary);
    }
  }
  const joined = parts.join('、');
  const chars = [...joined];
  return {
    ...first,
    id: runIdOf(first.id),
    title: `${first.toolName ?? first.title} ×${members.length}`,
    summary: chars.length > SUMMARY_MAX ? `${chars.slice(0, SUMMARY_MAX - 1).join('')}…` : joined,
    durationMs,
    endedAt,
    toolUseId: null,
    messageId: null,
    usage: null,
  };
}

/**
 * The reduced graph the canvas draws by default:
 *  - thinking nodes with no text are removed when something follows them (a trailing one stays: it is what is
 *    happening now); their duration is reported for the node(s) right after them (`thinkingMs`);
 *  - system nodes are removed, except context compaction and interrupts;
 *  - RUN_MIN or more successful, confirmed calls of one tool in a row — one after another, or issued in parallel from
 *    the same parent — in one turn and one thread become a single run node (kind 'tool', title `Read ×5`). Its id
 *    is runIdOf(the earliest call of the group, counting parallel calls of the same tool that are not merged — still
 *    running, failed), so it does not change when a slow first call finishes last and joins the run.
 * Edges through removed nodes are contracted (they take the kind of the edge into the removed node). Untouched nodes
 * and edges keep their objects. The compactor keeps a run's node object while its members are the same objects.
 */
export function createCompactor(): Compactor {
  let cache = new Map<string, { members: GraphNode[]; node: GraphNode }>();
  return (graph, options = {}) => {
    const keep = options.keep ?? null;
    /** from -> to -> the graph's own edge, or just a kind for an edge made by contraction. */
    const succs = new Map<string, Map<string, GraphEdge | EdgeKind>>();
    const preds = new Map<string, Set<string>>();
    const link = (from: string, to: string, edge: GraphEdge | EdgeKind): void => {
      let out = succs.get(from);
      if (!out) succs.set(from, (out = new Map()));
      if (!out.has(to)) out.set(to, edge);
      let inc = preds.get(to);
      if (!inc) preds.set(to, (inc = new Set()));
      inc.add(from);
    };
    for (const edge of Object.values(graph.edges)) {
      if (!graph.nodes[edge.from] || !graph.nodes[edge.to] || edge.from === edge.to) continue;
      link(edge.from, edge.to, edge);
    }

    // 1. Which nodes go. Latest first, so "something follows" is known for the nodes behind a removed node.
    const all = sortByTime(Object.values(graph.nodes));
    const removed = new Set<string>();
    /** A node that is drawn, or a removed one with a drawn node somewhere after it. */
    const live = new Map<string, boolean>();
    for (let i = all.length - 1; i >= 0; i--) {
      const n = all[i]!;
      const system = n.kind === 'system' && !KEPT_SYSTEM.has(n.systemSubtype ?? '');
      const emptyThinking = n.kind === 'thinking' && n.summary === '';
      if (n.id === keep || (!system && !emptyThinking)) {
        live.set(n.id, true);
        continue;
      }
      let followed = false;
      for (const s of succs.get(n.id)?.keys() ?? []) if (live.get(s) ?? true) { followed = true; break; }
      if (system || followed) removed.add(n.id);
      live.set(n.id, emptyThinking && !followed ? true : followed);
    }

    // 2. Contract the edges through removed nodes, earliest first, carrying the thinking time forward.
    /** Node -> removed node right in front of it -> the thinking time carried through that node. */
    const carry = new Map<string, Map<string, number>>();
    if (removed.size > 0) {
      for (const n of all) {
        if (!removed.has(n.id)) continue;
        const own = n.kind === 'thinking' ? n.durationMs ?? 0 : 0;
        const incomingTime = carry.get(n.id);
        let carried = own;
        for (const ms of incomingTime?.values() ?? []) carried += ms;
        // A node that adds nothing passes a single source on under that source's own id, so two such nodes side by side
        // behind one thought do not make it count twice further down.
        const [passed] = own === 0 && incomingTime?.size === 1 ? incomingTime.keys() : [];
        const sourceId = passed ?? n.id;
        const out = succs.get(n.id);
        const inc = preds.get(n.id);
        if (out) {
          for (const s of out.keys()) {
            preds.get(s)?.delete(n.id);
            if (carried > 0) {
              let from = carry.get(s);
              if (!from) carry.set(s, (from = new Map()));
              from.set(sourceId, carried);
            }
          }
        }
        if (inc) {
          for (const p of inc) {
            const pOut = succs.get(p)!;
            const into = pOut.get(n.id)!;
            const kind = typeof into === 'string' ? into : into.kind;
            pOut.delete(n.id);
            if (out) for (const s of out.keys()) if (s !== p) link(p, s, kind);
          }
        }
        succs.delete(n.id);
        preds.delete(n.id);
        carry.delete(n.id);
      }
    }

    // 3. Runs: union-find over mergeable tool calls.
    const kept = removed.size > 0 ? all.filter((n) => !removed.has(n.id)) : all;
    const exclude = options.exclude;
    const mergeable = (n: GraphNode | undefined): n is GraphNode =>
      n !== undefined && n.kind === 'tool' && n.status === 'succeeded' && n.confirmed && n.toolName !== null && n.id !== keep
      && !(exclude !== undefined && exclude.has(n.id));
    const parent = new Map<string, string>();
    const membersOf = new Map<string, string[]>();
    /** Classes that can never merge forward: they lead to something that is not a mergeable call, to another lane, or nowhere. */
    const dead = new Set<string>();
    const find = (id: string): string => {
      let root = id;
      while (parent.get(root) !== root) root = parent.get(root)!;
      for (let cur = id; cur !== root;) {
        const next = parent.get(cur)!;
        parent.set(cur, root);
        cur = next;
      }
      return root;
    };
    const union = (a: string, b: string): boolean => {
      let ra = find(a);
      let rb = find(b);
      if (ra === rb) return false;
      if (membersOf.get(ra)!.length < membersOf.get(rb)!.length) [ra, rb] = [rb, ra];
      parent.set(rb, ra);
      const list = membersOf.get(ra)!;
      for (const m of membersOf.get(rb)!) list.push(m);
      membersOf.delete(rb);
      if (dead.has(rb)) dead.add(ra);
      return true;
    };
    const sameLane = (a: GraphNode, b: GraphNode): boolean =>
      a.toolName === b.toolName && a.agentId === b.agentId && a.turnId === b.turnId;
    const candidates = kept.filter(mergeable);
    /** Position in time order. */
    const order = new Map<string, number>();
    kept.forEach((n, k) => order.set(n.id, k));
    /** Call -> an earlier parallel call of the same tool that is not mergeable (see runIdOf's stability, function comment). */
    const anchorOf = new Map<string, GraphNode>();
    if (candidates.length >= RUN_MIN) {
      for (const n of candidates) {
        parent.set(n.id, n.id);
        membersOf.set(n.id, [n.id]);
      }
      /**
       * Parallel calls: the calls of one message share `parentId` (the server gives every member of a batch the same
       * one, however the batch is wired to the batch before it). Without a parentId the parents in the graph are
       * compared, as classes: after a batch has become one class, the calls of the next batch hang off it — the first
       * off every member, the others only off its last member. Null: no parent outside the node's own class, or an
       * only child.
       */
      const siblingKey = (n: GraphNode, own: string | null): string | null => {
        if (n.parentId !== null) return `P\n${n.toolName}\n${n.agentId}\n${n.turnId}\n${n.parentId}`;
        const inc = preds.get(n.id);
        if (!inc || inc.size === 0) return null;
        if (inc.size === 1) {
          const [only] = inc;
          if (succs.get(only!)!.size === 1) return null; // an only child has no siblings
        }
        const roots = new Set<string>();
        for (const from of inc) {
          const root = parent.has(from) ? find(from) : from;
          if (root !== own) roots.add(root);
        }
        if (roots.size === 0) return null;
        return JSON.stringify([n.toolName, n.agentId, n.turnId, [...roots].sort()]);
      };
      /** Calls of a tool that cannot be merged (in flight, failed, the selection, ...): they still anchor their group's id. */
      const others = kept.filter((n) => n.kind === 'tool' && n.toolName !== null && !parent.has(n.id));
      const mergeSiblings = (): boolean => {
        let changed = false;
        // `kept` is in time order, so the first node seen with a key is the group's earliest.
        const earliest = new Map<string, GraphNode>();
        for (const n of others) {
          const key = siblingKey(n, null);
          if (key !== null && !earliest.has(key)) earliest.set(key, n);
        }
        const firstOf = new Map<string, string>();
        for (const n of candidates) {
          const key = siblingKey(n, find(n.id));
          if (key === null) continue;
          const anchor = earliest.get(key);
          if (anchor !== undefined && order.get(anchor.id)! < order.get(n.id)!) anchorOf.set(n.id, anchor);
          const other = firstOf.get(key);
          if (other === undefined) firstOf.set(key, n.id);
          else if (union(other, n.id)) changed = true;
        }
        return changed;
      };
      /** Calls in a row: everything leaving class C enters class D, and everything entering D comes from C. */
      const mergeChains = (): boolean => {
        let any = false;
        for (let active = [...membersOf.keys()].filter((root) => !dead.has(root)); active.length > 0;) {
          const next = new Set<string>();
          let changed = false;
          for (const root of active) {
            const members = membersOf.get(root);
            if (!members || dead.has(root)) continue; // merged away, or merged with a dead class, during this pass
            let target: string | undefined;
            let stop = false;
            let split = false;
            for (const m of members) {
              for (const succ of succs.get(m)?.keys() ?? []) {
                if (!parent.has(succ)) { stop = true; break; }
                const r = find(succ);
                if (r === root) continue;
                if (target === undefined) target = r;
                else if (target !== r) split = true;
              }
              if (stop) break;
            }
            if (stop || target === undefined || !sameLane(graph.nodes[root]!, graph.nodes[target]!)) {
              dead.add(root);
              continue;
            }
            let closed = !split;
            if (closed) {
              for (const m of membersOf.get(target)!) {
                for (const pred of preds.get(m) ?? []) {
                  const r = parent.has(pred) ? find(pred) : null;
                  if (r !== root && r !== target) { closed = false; break; }
                }
                if (!closed) break;
              }
            }
            if (closed && union(root, target)) {
              changed = true;
              any = true;
              next.add(find(root));
            } else {
              next.add(root);
            }
          }
          active = changed ? [...next] : [];
        }
        return any;
      };
      // A chain merge can make two calls siblings (their parents became one class), and the other way round.
      for (let changed = true; changed;) {
        changed = mergeSiblings();
        if (mergeChains()) changed = true;
      }
    }
    const runs = new Map<string, string[]>();
    const runOf = new Map<string, string>();
    const runNodes: GraphNode[] = [];
    const nextCache = new Map<string, { members: GraphNode[]; node: GraphNode }>();
    for (const ids of membersOf.values()) {
      if (ids.length < RUN_MIN) continue;
      const members = sortByTime(ids.map((id) => graph.nodes[id]!));
      let first = members[0]!;
      for (const m of members) {
        const anchor = anchorOf.get(m.id);
        if (anchor !== undefined && order.get(anchor.id)! < order.get(first.id)!) first = anchor;
      }
      const id = runIdOf(first.id);
      if (options.allowRun && !options.allowRun(id)) continue;
      const old = cache.get(id);
      const entry = old && old.members.length === members.length && old.members.every((m, i) => m === members[i])
        ? old
        : { members, node: runNode(members) };
      nextCache.set(id, entry);
      runNodes.push(entry.node);
      runs.set(id, members.map((m) => m.id));
      for (const m of members) runOf.set(m.id, id);
    }
    cache = nextCache;

    // A removed node in front of several members of one run (parallel calls behind one thought) counts once.
    const thinkingMs = new Map<string, number>();
    const counted = new Set<string>();
    for (const [id, sources] of carry) {
      const to = runOf.get(id) ?? id;
      for (const [source, ms] of sources) {
        const key = `${to}\n${source}`;
        if (counted.has(key)) continue;
        counted.add(key);
        thinkingMs.set(to, (thinkingMs.get(to) ?? 0) + ms);
      }
    }
    if (removed.size === 0 && runs.size === 0) return { graph, runs, thinkingMs };

    const nodes: Graph['nodes'] = {};
    for (const n of kept) if (!runOf.has(n.id)) nodes[n.id] = n;
    for (const n of runNodes) nodes[n.id] = n;
    const edges: Graph['edges'] = {};
    /** Edges with an end in a run: several graph edges can map to one. */
    const done = new Set<string>();
    const sessionId = all[0]?.sessionId ?? '';
    for (const [gFrom, out] of succs) {
      const from = runOf.get(gFrom) ?? gFrom;
      for (const [gTo, value] of out) {
        const to = runOf.get(gTo) ?? gTo;
        if (from === to) continue;
        const moved = from !== gFrom || to !== gTo;
        if (moved) {
          const key = `${from}\n${to}`;
          if (done.has(key)) continue;
          done.add(key);
        }
        const edge: GraphEdge = typeof value !== 'string' && !moved
          ? value
          : { id: `c:${from}->${to}`, sessionId, from, to, kind: typeof value === 'string' ? value : value.kind };
        edges[edge.id] = edge;
      }
    }
    return { graph: { nodes, edges }, runs, thinkingMs };
  };
}

/** One-off compaction (no run node reuse across calls). */
export function compactGraph(graph: Graph, options?: CompactOptions): CompactResult {
  return createCompactor()(graph, options);
}
