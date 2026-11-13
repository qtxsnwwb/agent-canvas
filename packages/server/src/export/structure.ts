import { groupTurns, type GraphNode } from '@agent-canvas/shared';

/**
 * The reading order of an export: main-thread turns (groupTurns), each turn's nodes by time then id, and after each
 * dispatch node the internals of the subagent it dispatched (depth first, nested subagents under their own dispatch
 * nodes). A subagent is placed under the first dispatch node naming it in that order (as the canvas claims it); one
 * that no dispatch node in the set names comes at the end (orphanAgents, by its first node). Masking runs in this order
 * (numbers appear in reading order) and the Markdown renders it.
 */

export interface DocAgent {
  agentId: string;
  steps: DocStep[];
}
export interface DocStep {
  node: GraphNode;
  /** The internals of the subagent this dispatch node dispatched, when any of them is in the set. */
  agent: DocAgent | null;
}
export interface DocTurn {
  key: string;
  /** 1-based position among the turns of the set. */
  number: number;
  steps: DocStep[];
}
export interface DocStructure {
  turns: DocTurn[];
  orphanAgents: DocAgent[];
}

function parseMs(ts: string): number {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? 0 : ms;
}

export const byTimeThenId = (a: GraphNode, b: GraphNode): number =>
  parseMs(a.timestamp) - parseMs(b.timestamp) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function buildStructure(nodes: readonly GraphNode[]): DocStructure {
  const byAgent = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    if (n.agentId === null) continue;
    let list = byAgent.get(n.agentId);
    if (!list) byAgent.set(n.agentId, (list = []));
    list.push(n);
  }
  for (const list of byAgent.values()) list.sort(byTimeThenId);
  const claimed = new Set<string>();
  // Iterative depth-first construction (no recursion limit on deeply nested agents).
  const stepsOf = (list: GraphNode[]): DocStep[] => {
    const root: DocStep[] = [];
    const stack: { list: GraphNode[]; i: number; out: DocStep[] }[] = [{ list, i: 0, out: root }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      if (top.i >= top.list.length) {
        stack.pop();
        continue;
      }
      const node = top.list[top.i++]!;
      const step: DocStep = { node, agent: null };
      top.out.push(step);
      const child = node.kind === 'subagent' ? node.childAgentId : null;
      if (child !== null && !claimed.has(child)) {
        const inner = byAgent.get(child);
        if (inner !== undefined && inner.length > 0) {
          claimed.add(child);
          step.agent = { agentId: child, steps: [] };
          stack.push({ list: inner, i: 0, out: step.agent.steps });
        }
      }
    }
    return root;
  };
  const turns = groupTurns(nodes).map((t, i) => ({ key: t.key, number: i + 1, steps: stepsOf(t.nodes) }));
  const orphanAgents: DocAgent[] = [];
  const rest = [...byAgent.entries()].filter(([id]) => !claimed.has(id)).sort((a, b) => byTimeThenId(a[1][0]!, b[1][0]!));
  for (const [agentId] of rest) {
    if (claimed.has(agentId)) continue; // claimed meanwhile by an earlier orphan's dispatch node
    claimed.add(agentId);
    orphanAgents.push({ agentId, steps: stepsOf(byAgent.get(agentId)!) });
  }
  return { turns, orphanAgents };
}

/** Every node of a structure in reading order. */
export function* readingOrder(structure: DocStructure): Generator<GraphNode> {
  const stack: { steps: DocStep[]; i: number }[] = [];
  const all: DocStep[][] = [...structure.turns.map((t) => t.steps), ...structure.orphanAgents.map((a) => a.steps)];
  for (const steps of all) {
    stack.push({ steps, i: 0 });
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      if (top.i >= top.steps.length) {
        stack.pop();
        continue;
      }
      const step = top.steps[top.i++]!;
      yield step.node;
      if (step.agent !== null) stack.push({ steps: step.agent.steps, i: 0 });
    }
  }
}
