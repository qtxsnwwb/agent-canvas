import { expect, test } from 'vitest';
import type { Graph, GraphNode } from '@agent-canvas/shared';
import { computeAgentTimeline, type AgentTimeline } from '../src/canvas/agentTime';
import { compactStepCounts, panelTitle, timelineRowModel } from '../src/canvas/AgentTimeline';

// Invented session. What runs on the page's main thread for every re-render of the 时间线 view (each second while the
// clock ticks): the row model (scopes, highlight, tooltips) and the panel's title. Nothing in it may be linear in the
// graph: a 90,000-node session with 20 unmatched dispatches must stay within a few milliseconds per tick.

const SCALE = Math.max(1, Number(process.env.AGENT_CANVAS_TIMING_SCALE) || 1);
const EPOCH = Date.parse('2026-01-01T00:00:00Z');
const iso = (t: number): string => new Date(EPOCH + t).toISOString();

function node(id: string, kind: GraphNode['kind'], turnId: string | null, agentId: string | null, t: number, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id, sessionId: 's1', turnId, agentId, childAgentId: null, endedAt: null, parentId: null, kind, status: null,
    timestamp: iso(t), confirmed: true, title: kind, summary: `step ${id}`, toolName: null,
    toolUseId: null, messageId: null, durationMs: null, usage: null, systemSubtype: null, ...extra,
  };
}

/** 90,000 nodes over 40 turns, mostly main-thread tools; 20 dispatches without an agent (half without a turnId). */
function bigGraph(): Graph {
  const nodes: Record<string, GraphNode> = {};
  const add = (n: GraphNode): void => { nodes[n.id] = n; };
  let t = 0;
  for (let turn = 0; turn < 40; turn++) {
    const key = `t${turn}`;
    add(node(`p${turn}`, 'prompt', key, null, t));
    t += 10;
    if (turn < 20) {
      add(node(`du${turn}`, 'subagent', turn % 2 === 0 ? key : null, null, t, {
        title: `Helper ${turn}`, status: 'succeeded', endedAt: iso(t + 500), messageId: `md${turn}`,
      }));
      t += 600;
    }
    for (let i = 0; i < 2250; i++) {
      add(node(`n${turn}-${i}`, 'tool', key, null, t, { status: 'succeeded', endedAt: iso(t + 5), messageId: `m${turn}-${i}` }));
      t += 10;
    }
  }
  return { nodes, edges: {} };
}

test('the row model and the panel title per tick: nothing linear in the graph (90k nodes, 20 unmatched rows)', () => {
  const g = bigGraph();
  expect(Object.keys(g.nodes).length).toBeGreaterThanOrEqual(90_000);
  const session = { origin: 'claude' as const, status: 'idle' as const, lastActivityAt: iso(0) };
  const r = computeAgentTimeline(g, session, { nowMs: EPOCH + 10_000_000, ticking: false, backgroundNowMs: EPOCH + 10_000_000, backgroundTicking: false });
  if (!r.available) throw new Error('expected a timeline');
  expect(r.root.children.filter((c) => c.id.startsWith('unmatched:'))).toHaveLength(20);
  const steps = compactStepCounts(g); // once per graph change, not per tick
  const turnPrompt = (): string | undefined => undefined; // the canvas's turns unavailable: the slowest path
  // The first render after a graph change may index the graph once.
  timelineRowModel(r, { graph: g, sort: 'wait', steps, panelKey: 'turn:t39', pickedRow: null });
  panelTitle(g, { type: 'turn', turnKey: 't39' }, r, turnPrompt);
  const ticks = 20;
  const start = performance.now();
  for (let i = 0; i < ticks; i++) {
    const tick: AgentTimeline = { ...r }; // a new result every second, same graph
    const rows = timelineRowModel(tick, { graph: g, sort: 'wait', steps, panelKey: 'turn:t39', pickedRow: null });
    expect(rows).toHaveLength(21);
    panelTitle(g, { type: 'turn', turnKey: 't39' }, tick, turnPrompt);
    panelTitle(g, { type: 'agent', agentId: 'nobody' }, tick, turnPrompt);
  }
  const perTick = (performance.now() - start) / ticks;
  console.log(`时间线 per tick (row model + panel titles), 90k nodes, 20 unmatched rows: ${perTick.toFixed(2)} ms`);
  expect(perTick).toBeLessThan(5 * SCALE);
});
