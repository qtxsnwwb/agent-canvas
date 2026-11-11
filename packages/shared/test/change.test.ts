import { expect, test } from 'vitest';
import { applyChange, applyChanges, emptyGraph, type Change, type Graph, type GraphNode } from '../src/index.js';

const node = (over: Partial<GraphNode> = {}): GraphNode => ({
  id: 'n1', sessionId: 's1', turnId: null, agentId: null, parentId: null, kind: 'tool',
  status: 'running', timestamp: '2026-01-01T00:00:00.000Z', confirmed: false, title: 'Bash',
  summary: '', toolName: 'Bash', toolUseId: 'tu1', messageId: null, durationMs: null,
  usage: null, systemSubtype: null, childAgentId: null, endedAt: null, ...over,
});

test('node_added 加入节点', () => {
  const g = applyChange(emptyGraph(), { type: 'node_added', node: node(), detail: {} });
  expect(g.nodes.n1.title).toBe('Bash');
});
test('node_updated 合并 patch 且不改动原图', () => {
  const g1 = applyChange(emptyGraph(), { type: 'node_added', node: node(), detail: {} });
  const g2 = applyChange(g1, { type: 'node_updated', sessionId: 's1', id: 'n1', patch: { status: 'succeeded', confirmed: true } });
  expect(g2.nodes.n1.status).toBe('succeeded');
  expect(g2.nodes.n1.title).toBe('Bash');
  expect(g1.nodes.n1.status).toBe('running');
});
test('node_updated 指向不存在的节点时忽略', () => {
  const g = applyChange(emptyGraph(), { type: 'node_updated', sessionId: 's1', id: 'nope', patch: { status: 'failed' } });
  expect(g.nodes).toEqual({});
});
test('edge_added 加入边', () => {
  const g = applyChange(emptyGraph(), { type: 'edge_added', edge: { id: 'e1', sessionId: 's1', from: 'a', to: 'b', kind: 'sequence' } });
  expect(g.edges.e1.kind).toBe('sequence');
});

// ---- final fix wave, group 7: batched applyChanges ----

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomChanges(r: () => number, n: number): Change[] {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const pick = () => ids[Math.floor(r() * ids.length)]!;
  const out: Change[] = [];
  for (let i = 0; i < n; i++) {
    const k = r();
    if (k < 0.35) out.push({ type: 'node_added', node: node({ id: pick(), title: `t${i}` }), detail: {} });
    else if (k < 0.7) out.push({ type: 'node_updated', sessionId: 's1', id: pick(), patch: r() < 0.5 ? { status: 'failed' } : { summary: `s${i}` } });
    else if (k < 0.9) out.push({ type: 'edge_added', edge: { id: `${pick()}->${pick()}`, sessionId: 's1', from: pick(), to: pick(), kind: 'sequence' } });
    else out.push({ type: 'session_upserted', session: { id: 's1', projectId: 'p', origin: 'claude', cwd: null, title: null, gitBranch: null, status: 'idle', sourceDeleted: false, startedAt: '', lastActivityAt: '' } });
  }
  return out;
}

test('applyChanges 与逐个 applyChange 折叠的结果相同（随机变更序列）', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const r = rng(seed);
    const start: Graph = randomChanges(r, Math.floor(r() * 5)).reduce(applyChange, emptyGraph());
    const cs = randomChanges(r, Math.floor(r() * 30));
    const before = JSON.stringify(start);
    expect(applyChanges(start, cs)).toEqual(cs.reduce(applyChange, start));
    expect(JSON.stringify(start)).toBe(before); // input graph untouched
  }
});

test('applyChanges 没有变化时返回原图', () => {
  const g = emptyGraph();
  expect(applyChanges(g, [])).toBe(g);
  expect(applyChanges(g, [{ type: 'node_updated', sessionId: 's1', id: 'x', patch: {} }])).toBe(g);
});
