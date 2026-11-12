import { expect, test } from 'vitest';
import { groupTurns, type Graph, type GraphNode, type NodeKind, type NodeStatus } from '@agent-canvas/shared';
import { buildView, turnNodes } from '../src/canvas/view';
import { mkNode } from './helpers';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS: NodeKind[] = ['prompt', 'thinking', 'text', 'tool', 'subagent', 'system'];
const STATUSES: NodeStatus[] = ['running', 'awaiting_permission', 'succeeded', 'failed', 'denied'];

function randomGraph(seed: number): Graph {
  const r = rng(seed);
  const nodes: Record<string, GraphNode> = {};
  const n = 20 + Math.floor(r() * 80);
  for (let i = 0; i < n; i++) {
    const kind = KINDS[Math.floor(r() * KINDS.length)]!;
    const ts = new Date(Date.parse('2026-01-01T00:00:00Z') + Math.floor(r() * 600) * 1000).toISOString();
    const node: GraphNode = {
      ...mkNode(`n${i}`, ts),
      kind,
      turnId: r() < 0.25 ? null : `T${Math.floor(r() * 6)}`,
      agentId: r() < 0.2 ? `ag${Math.floor(r() * 2)}` : null,
      status: kind === 'tool' || kind === 'subagent' ? STATUSES[Math.floor(r() * STATUSES.length)]! : null,
    };
    nodes[node.id] = node;
  }
  return { nodes, edges: {} };
}

// The stats page counts turns, tool calls and failures per turn with groupTurns (shared); the session page with
// buildView. They must agree on which main-thread nodes form which turn, in which order.
test.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])('groupTurns matches the canvas turns (seed %i)', (seed) => {
  const graph = randomGraph(seed);
  const view = buildView(graph, new Map());
  const turns = groupTurns(Object.values(graph.nodes));
  expect(turns.map((t) => t.key)).toEqual(view.turns.map((t) => t.key));
  for (const t of turns) {
    expect(t.nodes.map((x) => x.id)).toEqual(turnNodes(graph, t.key).map((x) => x.id));
    const summary = view.turns.find((v) => v.key === t.key)!.summary;
    expect(t.nodes.length).toBe(summary.nodeCount);
    expect(t.nodes.filter((x) => x.kind === 'tool' || x.kind === 'subagent').length).toBe(summary.toolCount);
    expect(t.nodes.filter((x) => x.status === 'failed' || x.status === 'denied').length).toBe(summary.failedCount);
    expect(new Date(t.startMs).toISOString()).toBe(summary.startedAt);
  }
});
