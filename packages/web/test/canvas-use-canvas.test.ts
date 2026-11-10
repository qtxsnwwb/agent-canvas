import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Graph, GraphEdge, GraphNode } from '@claude-canvas/shared';
import { createCanvasModel } from '../src/canvas/useCanvas';
import type { LayoutClient } from '../src/canvas/layoutClient';
import type { TurnLayout, TurnLayoutInput } from '../src/canvas/layout';

const EPOCH = Date.parse('2026-01-01T00:00:00Z');

function node(id: string, turnId: string, tMs: number): GraphNode {
  return {
    id, sessionId: 's1', turnId, agentId: null, childAgentId: null, parentId: null, kind: 'text', status: null,
    timestamp: new Date(EPOCH + tMs).toISOString(), confirmed: true, title: 'text', summary: '', toolName: null,
    toolUseId: null, messageId: null, durationMs: null, usage: null, systemSubtype: null,
  };
}
function graph(nodes: GraphNode[]): Graph {
  const edges: GraphEdge[] = [];
  for (let i = 1; i < nodes.length; i++) {
    const from = nodes[i - 1]!.id;
    const to = nodes[i]!.id;
    edges.push({ id: `${from}->${to}`, sessionId: 's1', from, to, kind: 'sequence' });
  }
  return { nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), edges: Object.fromEntries(edges.map((e) => [e.id, e])) };
}

/** A live session whose graph the test replaces, notifying subscribers. */
function fakeLive(initial: Graph) {
  let g = initial;
  const listeners = new Set<() => void>();
  return {
    getGraph: () => g,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    set(next: Graph) {
      g = next;
      for (const fn of [...listeners]) fn();
    },
    listenerCount: () => listeners.size,
  };
}

interface Req { n: number; input: TurnLayoutInput; resolve(l: TurnLayout): void; reject(e: Error): void; settled: boolean }

/** A layout client whose requests the test settles. Request n stacks its nodes in column x = n * 1000. */
function fakeLayout() {
  const reqs: Req[] = [];
  const client: LayoutClient = {
    layout(input) {
      return new Promise<TurnLayout>((resolve, reject) => {
        reqs.push({ n: reqs.length, input, resolve, reject, settled: false });
      });
    },
    dispose() {},
  };
  const layoutOf = (r: Req): TurnLayout => {
    const positions: Record<string, { x: number; y: number }> = {};
    r.input.nodes.forEach((n, i) => { positions[n.id] = { x: r.n * 1000, y: i * 100 }; });
    return { key: r.input.key, width: 300, height: r.input.nodes.length * 100, anchorX: 150, positions };
  };
  const settle = (r: Req, fn: () => void): void => {
    if (r.settled) throw new Error(`request ${r.n} already settled`);
    r.settled = true;
    fn();
  };
  return {
    client,
    reqs,
    pending: () => reqs.filter((r) => !r.settled),
    resolve(r: Req) { settle(r, () => r.resolve(layoutOf(r))); },
    reject(r: Req, msg: string) { settle(r, () => r.reject(new Error(msg))); },
    resolveAll() { for (const r of reqs.filter((x) => !x.settled)) this.resolve(r); },
  };
}

/** Lets promise callbacks run (fake timers do not touch microtasks). */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

test('首次布局完成后才有位置；所有视图节点都有位置', async () => {
  const live = fakeLive(graph([node('a', 't1', 0), node('b', 't1', 1), node('c', 't2', 10), node('d', 't2', 11)]));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  const before = model.getSnapshot();
  expect([...before.view.nodes.keys()].sort()).toEqual(['a', 'b', 'c', 'd']);
  expect(before.positions).toEqual({});
  expect(layout.reqs.map((r) => r.input.key)).toEqual(['t1', 't2']);

  layout.resolve(layout.reqs[0]!); // one turn alone is not enough: positions swap in all at once
  await flush();
  expect(model.getSnapshot().positions).toEqual({});

  layout.resolveAll();
  await flush();
  const s = model.getSnapshot();
  expect(Object.keys(s.positions).sort()).toEqual(['a', 'b', 'c', 'd']);
  expect(Object.keys(s.turnBoxes).sort()).toEqual(['t1', 't2']);
  expect(s.layoutError).toBeNull();
  model.dispose();
});

test('追加节点：新位置到达前旧节点位置不变，新节点暂不在 positions 里；到达后出现', async () => {
  const live = fakeLive(graph([node('a', 't1', 0), node('b', 't1', 1)]));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  layout.resolveAll();
  await flush();
  const old = model.getSnapshot().positions;
  expect(old.a).toBeDefined();

  live.set(graph([node('a', 't1', 0), node('b', 't1', 1), node('c', 't1', 2)]));
  await flush();
  expect(layout.pending()).toHaveLength(1);
  const mid = model.getSnapshot();
  expect(mid.view.nodes.has('c')).toBe(true);
  expect(mid.positions.a).toEqual(old.a);
  expect(mid.positions.b).toEqual(old.b);
  expect(mid.positions.c).toBeUndefined();

  layout.resolveAll();
  await flush();
  const after = model.getSnapshot();
  expect(Object.keys(after.positions).sort()).toEqual(['a', 'b', 'c']);
  expect(after.positions.a).not.toEqual(old.a); // the new layout replaced the old positions
  model.dispose();
});

test('旧的布局结果晚于新的到达时被丢弃', async () => {
  const live = fakeLive(graph([node('a', 't1', 0)]));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  const first = layout.reqs[0]!;
  live.set(graph([node('a', 't1', 0), node('b', 't1', 1)]));
  await vi.advanceTimersByTimeAsync(50);
  const second = layout.reqs[1]!;
  expect(second).toBeDefined();

  layout.resolve(second);
  await flush();
  const fromSecond = model.getSnapshot();
  expect(Object.keys(fromSecond.positions).sort()).toEqual(['a', 'b']);
  expect(fromSecond.positions.a!.x).toBe(1000 - 150); // request #1's column, centred (turn width 300)

  const fn = vi.fn();
  model.subscribe(fn);
  layout.resolve(first);
  await flush();
  expect(model.getSnapshot()).toBe(fromSecond);
  expect(model.getSnapshot().positions.a!.x).toBe(1000 - 150);
  expect(fn).not.toHaveBeenCalled();
  model.dispose();
});

test('布局失败：保留旧位置并记录 layoutError；下一次重建成功后 layoutError 清空', async () => {
  const live = fakeLive(graph([node('a', 't1', 0)]));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  layout.resolveAll();
  await flush();
  const old = model.getSnapshot().positions;

  live.set(graph([node('a', 't1', 0), node('b', 't1', 1)]));
  await vi.advanceTimersByTimeAsync(50);
  layout.reject(layout.pending()[0]!, 'elk exploded');
  await flush();
  const failed = model.getSnapshot();
  expect(failed.layoutError).toContain('elk exploded');
  expect(failed.positions).toEqual(old);
  expect(failed.view.nodes.has('b')).toBe(true);

  live.set(graph([node('a', 't1', 0), node('b', 't1', 1), node('c', 't1', 2)]));
  await vi.advanceTimersByTimeAsync(50);
  expect(layout.pending()).toHaveLength(1); // retried on the next rebuild
  layout.resolveAll();
  await flush();
  const ok = model.getSnapshot();
  expect(ok.layoutError).toBeNull();
  expect(Object.keys(ok.positions).sort()).toEqual(['a', 'b', 'c']);
  model.dispose();
});

test('toggleTurn 立即重建并翻转该轮次的折叠状态；再调一次翻回来', async () => {
  // Four turns: by default only the last three are expanded, so t1 starts collapsed.
  const live = fakeLive(graph([node('a', 't1', 0), node('b', 't2', 10), node('c', 't3', 20), node('d', 't4', 30)]));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  layout.resolveAll();
  await flush();
  const collapsedOf = (key: string) => model.getSnapshot().view.turns.find((t) => t.key === key)!.collapsed;
  expect(collapsedOf('t1')).toBe(true);
  expect(model.getSnapshot().view.nodes.has('turn:t1')).toBe(true);

  const fn = vi.fn();
  model.subscribe(fn);
  const before = layout.reqs.length;
  model.toggleTurn('t1');
  expect(collapsedOf('t1')).toBe(false); // no timer advanced: the rebuild was immediate
  expect(model.getSnapshot().view.nodes.has('a')).toBe(true);
  expect(layout.reqs.length).toBeGreaterThan(before);
  expect(fn).toHaveBeenCalled();
  layout.resolveAll();
  await flush();
  expect(model.getSnapshot().positions.a).toBeDefined();
  expect(model.getSnapshot().positions['turn:t1']).toBeUndefined();

  model.toggleTurn('t1');
  expect(collapsedOf('t1')).toBe(true);
  model.toggleTurn('t3');
  expect(collapsedOf('t3')).toBe(true);
  model.dispose();
});

test('图被整体替换（resync）后，已不存在的节点从 positions 中删除', async () => {
  const live = fakeLive(graph([node('a', 't1', 0), node('b', 't1', 1)]));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  layout.resolveAll();
  await flush();
  expect(Object.keys(model.getSnapshot().positions).sort()).toEqual(['a', 'b']);

  live.set(graph([node('b', 't1', 1), node('x', 't9', 50)]));
  await vi.advanceTimersByTimeAsync(50);
  const mid = model.getSnapshot();
  expect(mid.positions.a).toBeUndefined();
  expect(Object.keys(mid.positions)).toEqual(['b']);

  layout.resolveAll();
  await flush();
  const s = model.getSnapshot();
  expect(Object.keys(s.positions).sort()).toEqual(['b', 'x']);
  expect(Object.keys(s.turnBoxes).sort()).toEqual(['t1', 't9']);
  model.dispose();
});

test('dispose 后不再通知订阅者，也不再请求布局', async () => {
  const live = fakeLive(graph([node('a', 't1', 0)]));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  const fn = vi.fn();
  model.subscribe(fn);
  const pendingFirst = layout.reqs[0]!;
  model.dispose();
  expect(live.listenerCount()).toBe(0);

  layout.resolve(pendingFirst);
  live.set(graph([node('a', 't1', 0), node('b', 't1', 1)]));
  await vi.advanceTimersByTimeAsync(200);
  model.toggleTurn('t1');
  await flush();
  expect(fn).not.toHaveBeenCalled();
  expect(layout.reqs).toHaveLength(1);
  expect(model.getSnapshot().positions).toEqual({});
});

test('showFullTurn 立即重建并显示长轮次的全部节点；把轮次折叠再展开后恢复为折叠更早节点', async () => {
  const nodes = Array.from({ length: 61 }, (_, i) => node(`n${i}`, 't1', i));
  const live = fakeLive(graph(nodes));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  layout.resolveAll();
  await flush();
  const turn = () => model.getSnapshot().view.turns[0]!;
  expect(turn().foldedEarlier).toBe(21); // first node is not a prompt
  expect(model.getSnapshot().view.nodes.has('earlier:t1')).toBe(true);

  const before = layout.reqs.length;
  model.showFullTurn('t1');
  expect(turn().foldedEarlier).toBe(0); // no timer advanced
  expect(turn().nodeIds).toHaveLength(61);
  expect(model.getSnapshot().view.nodes.has('earlier:t1')).toBe(false);
  await flush();
  expect(layout.reqs.length).toBeGreaterThan(before);
  layout.resolveAll();
  await flush();

  model.toggleTurn('t1'); // fold the whole turn
  expect(turn().collapsed).toBe(true);
  layout.resolveAll();
  await flush();
  model.toggleTurn('t1'); // and expand it again: back to the folded-earlier default
  expect(turn().collapsed).toBe(false);
  expect(turn().foldedEarlier).toBe(21);
  model.dispose();
});
