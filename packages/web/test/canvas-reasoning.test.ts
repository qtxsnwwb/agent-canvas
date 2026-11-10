import { expect, test } from 'vitest';
import type { Graph, GraphEdge, GraphNode, NodeKind } from '@claude-canvas/shared';
import { buildView } from '../src/canvas/view';
import { EMPTY_CHAIN, upstreamChain } from '../src/canvas/chain';
import { NO_REASONING, reasoningRows, THINKING_NOT_RECORDED } from '../src/canvas/reasoning';

const EPOCH = Date.parse('2026-01-01T00:00:00Z');
function node(id: string, kind: NodeKind, tMs: number, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id, sessionId: 's1', turnId: 't1', agentId: null, childAgentId: null, parentId: null, kind, status: null,
    timestamp: new Date(EPOCH + tMs).toISOString(), confirmed: true, title: kind, summary: '', toolName: null,
    toolUseId: null, messageId: null, durationMs: null, endedAt: null, usage: null, systemSubtype: null, ...extra,
  };
}
const e = (from: string, to: string): GraphEdge => ({ id: `${from}->${to}`, sessionId: 's1', from, to, kind: 'sequence' });
function graph(nodes: GraphNode[], edges: GraphEdge[]): Graph {
  return { nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), edges: Object.fromEntries(edges.map((x) => [x.id, x])) };
}

/** p1 → th1（有文本）→ tx1 → th2（无文本，2.5s）→ a1 */
function g(): Graph {
  return graph(
    [
      node('p1', 'prompt', 0, { summary: '修一下' }),
      node('th1', 'thinking', 1, { summary: '先看代码', durationMs: 1200 }),
      node('tx1', 'text', 2, { summary: '我来看看' }),
      node('th2', 'thinking', 3, { durationMs: 2500 }),
      node('a1', 'tool', 4),
    ],
    [e('p1', 'th1'), e('th1', 'tx1'), e('tx1', 'th2'), e('th2', 'a1')],
  );
}

test('按推理链顺序列出，空文本的思考显示占位并带耗时', () => {
  const view = buildView(g(), new Map(), undefined, { mode: 'causal' });
  const rows = reasoningRows(view, upstreamChain(view, 'a1'), 'a1');
  expect(rows.map((r) => r.id)).toEqual(['th1', 'tx1', 'th2']);
  expect(rows[0]).toMatchObject({ kind: 'thinking', label: '思考', text: '先看代码', missing: false, durationMs: null, current: false });
  expect(rows[1]).toMatchObject({ kind: 'text', label: '回复', text: '我来看看', missing: false, durationMs: null });
  expect(rows[2]).toMatchObject({ label: '思考', text: THINKING_NOT_RECORDED, missing: true, durationMs: 2500 });
  expect(rows[0]!.time).toBe(new Date(EPOCH + 1).toISOString());
});

test('选中的推理节点自己那一行标为当前', () => {
  const view = buildView(g(), new Map(), undefined, { mode: 'causal' });
  const rows = reasoningRows(view, upstreamChain(view, 'tx1'), 'tx1');
  expect(rows.map((r) => [r.id, r.current])).toEqual([['th1', false], ['tx1', true]]);
});

test('视图里没有的 id 跳过；空链没有行', () => {
  const view = buildView(g(), new Map(), undefined, { mode: 'causal' });
  const chain = { ...upstreamChain(view, 'a1'), reasoning: ['gone', 'th1', 'a1', 'tx1'] };
  expect(reasoningRows(view, chain, 'a1').map((r) => r.id)).toEqual(['th1', 'tx1']);
  expect(reasoningRows(view, EMPTY_CHAIN, null)).toEqual([]);
  expect(NO_REASONING).toBe('这一步之前没有记录到思考或回复');
});
