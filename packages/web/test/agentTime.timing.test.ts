import { expect, test } from 'vitest';
import type { Graph, GraphNode } from '@agent-canvas/shared';
import { computeAgentTimeline } from '../src/canvas/agentTime';
import type { WaterfallClock } from '../src/canvas/waterfall';

// Wall-clock bounds: runs in the serial `timing` project with retries (see vitest.config.ts). Invented data only.

const TIMING_SCALE = Math.max(1, Number(process.env.AGENT_CANVAS_TIMING_SCALE) || 1);
const bound = (ms: number): number => ms * TIMING_SCALE;

const EPOCH = Date.parse('2026-01-01T00:00:00Z');
const iso = (t: number): string => new Date(EPOCH + t).toISOString();

function base(id: string, turnId: string | null, agentId: string | null, t: number): GraphNode {
  return {
    id, sessionId: 's1', turnId, agentId, childAgentId: null, endedAt: null, parentId: null, kind: 'tool', status: null,
    timestamp: iso(t), confirmed: true, title: 'Bash', summary: '', toolName: 'Bash', toolUseId: null, messageId: null,
    durationMs: null, usage: null, systemSubtype: null,
  };
}

/**
 * `turns` turns, each with `agentsPerTurn` agents (dispatched in parallel pairs from the main thread, the third in the
 * background, the last one nested inside the first agent) and enough main-thread and agent steps for about `total`
 * nodes.
 */
function bigSession(total: number, turns = 40, agentsPerTurn = 5): Graph {
  const nodes: GraphNode[] = [];
  const agents = turns * agentsPerTurn;
  const perAgent = Math.floor((total * 0.8) / agents);
  const perTurnMain = Math.floor((total - agents * perAgent) / turns) - agentsPerTurn - 1;
  let t = 0;
  let n = 0;
  for (let k = 0; k < turns; k++) {
    const turn = `t${k}`;
    nodes.push({ ...base(`p${k}`, turn, null, t), kind: 'prompt', title: 'Prompt', toolName: null });
    t += 100;
    for (let a = 0; a < agentsPerTurn; a++) {
      const agent = `ag${k}-${a}`;
      const nested = a === agentsPerTurn - 1;
      const start = nested ? t - 5000 : t;
      let at = start + 10;
      for (let s = 0; s < perAgent; s++) {
        nodes.push({
          ...base(`n${n++}`, null, agent, at), status: 'succeeded', endedAt: iso(at + 50), durationMs: 50,
          messageId: `am${k}-${a}-${s >> 1}`, usage: s % 2 === 0 ? { inputTokens: 10, outputTokens: 5, cachedInputTokens: 50 } : null,
        });
        at += 60;
      }
      nodes.push({
        ...base(`d${k}-${a}`, nested ? null : turn, nested ? `ag${k}-0` : null, start), kind: 'subagent', title: `Agent${a % 3}`,
        childAgentId: agent, status: 'succeeded', endedAt: iso(at), durationMs: at - start, messageId: nested ? `am-d${k}` : `m${k}-${a >> 1}`,
      });
      if (nested) continue;
      const background = a === 2;
      t = background ? start + 20 : at + 10;
    }
    for (let s = 0; s < perTurnMain; s++) {
      nodes.push({ ...base(`x${n++}`, turn, null, t), status: 'succeeded', endedAt: iso(t + 30), durationMs: 30, messageId: `mm${k}-${s}` });
      t += 40;
    }
    t += 10 * 60_000;
  }
  return { nodes: Object.fromEntries(nodes.map((x) => [x.id, x])), edges: {} };
}

const session = { origin: 'claude' as const, status: 'idle' as const, lastActivityAt: iso(0) };

function measure(g: Graph, clock: WaterfallClock): number {
  computeAgentTimeline(g, session, clock); // warm up
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    computeAgentTimeline(g, session, clock);
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

test('100,000 nodes, 200 agents, 40 turns: computeAgentTimeline within 300 ms, and linear in the size', () => {
  const big = bigSession(100_000);
  const small = bigSession(25_000);
  expect(Object.keys(big.nodes).length).toBeGreaterThanOrEqual(99_000);
  const last = Math.max(...Object.values(big.nodes).map((x) => Date.parse(x.timestamp)));
  const clock: WaterfallClock = { nowMs: last, ticking: false, backgroundNowMs: last, backgroundTicking: false };
  const r = computeAgentTimeline(big, session, clock);
  expect(r.available && r.root.children.length).toBeGreaterThanOrEqual(150);
  const bigMs = measure(big, clock);
  const smallMs = measure(small, clock);
  console.log(`computeAgentTimeline: 100k nodes ${bigMs.toFixed(1)} ms, 25k nodes ${smallMs.toFixed(1)} ms`);
  expect(bigMs).toBeLessThan(bound(300));
  // Four times the nodes: about four times the time when linear (n log n a little more); quadratic would be ~16.
  expect(bigMs / Math.max(smallMs, 1)).toBeLessThan(8);
});
