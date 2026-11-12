import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Graph, GraphEdge, GraphNode } from '@agent-canvas/shared';
import { createCanvasModel } from '../src/canvas/useCanvas';
import type { LayoutClient } from '../src/canvas/layoutClient';
import type { TurnLayout, TurnLayoutInput } from '../src/canvas/layout';
import { containerSize } from '../src/canvas/sizes';

const EPOCH = Date.parse('2026-01-01T00:00:00Z');

function node(id: string, turnId: string, tMs: number): GraphNode {
  return {
    id, sessionId: 's1', turnId, agentId: null, childAgentId: null, endedAt: null, parentId: null, kind: 'text', status: null,
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

test('同一时刻最多一轮布局：进行中收到 10 次通知，结束后只再跑 1 轮，且用最新的图', async () => {
  const live = fakeLive(graph([node('a', 't1', 0)]));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  expect(layout.reqs).toHaveLength(1);
  const ids = ['a'];
  for (let i = 1; i <= 10; i++) {
    ids.push(`n${i}`);
    live.set(graph(ids.map((id, k) => node(id, 't1', k))));
    await vi.advanceTimersByTimeAsync(60);
    expect(model.getSnapshot().view.nodes.has(`n${i}`)).toBe(true); // the view still updates at once
  }
  expect(layout.reqs).toHaveLength(1);

  layout.resolve(layout.reqs[0]!);
  await flush();
  expect(layout.reqs).toHaveLength(2);
  expect(layout.reqs[1]!.input.nodes.map((n) => n.id)).toEqual(ids);
  layout.resolve(layout.reqs[1]!);
  await vi.advanceTimersByTimeAsync(200);
  expect(layout.reqs).toHaveLength(2);
  expect(Object.keys(model.getSnapshot().positions).sort()).toEqual([...ids].sort());
  model.dispose();
});

test('失败的一轮结束后同样触发排队的重建', async () => {
  const live = fakeLive(graph([node('a', 't1', 0)]));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  live.set(graph([node('a', 't1', 0), node('b', 't1', 1)]));
  await vi.advanceTimersByTimeAsync(60);
  expect(layout.reqs).toHaveLength(1);
  layout.reject(layout.reqs[0]!, 'boom');
  await flush();
  expect(layout.reqs).toHaveLength(2);
  expect(layout.reqs[1]!.input.nodes.map((n) => n.id)).toEqual(['a', 'b']);
  model.dispose();
});

test('布局进行中，已放置节点的状态变化立即出现在快照里', async () => {
  const live = fakeLive(graph([node('a', 't1', 0)]));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  layout.resolveAll();
  await flush();
  live.set(graph([node('a', 't1', 0), node('b', 't1', 1)]));
  await vi.advanceTimersByTimeAsync(60);
  expect(layout.pending()).toHaveLength(1);
  const placed = model.getSnapshot().positions.a;
  live.set(graph([{ ...node('a', 't1', 0), status: 'failed' }, node('b', 't1', 1)]));
  await vi.advanceTimersByTimeAsync(60);
  const s = model.getSnapshot();
  const a = s.view.nodes.get('a');
  expect(a?.type === 'node' && a.node.status).toBe('failed');
  expect(s.positions.a).toEqual(placed);
  expect(layout.pending()).toHaveLength(1); // still the same round
  model.dispose();
});

test('什么都没变的通知最多发布一次快照', async () => {
  const g = graph([node('a', 't1', 0), node('b', 't1', 1)]);
  const live = fakeLive(g);
  // Deterministic layout: same input, same positions.
  const client: LayoutClient = {
    layout: async (input) => ({
      key: input.key, width: 300, height: input.nodes.length * 100, anchorX: 150,
      positions: Object.fromEntries(input.nodes.map((n, i) => [n.id, { x: 0, y: i * 100 }])),
    }),
    dispose() {},
  };
  const model = createCanvasModel(live, client);
  await flush();
  expect(Object.keys(model.getSnapshot().positions)).toHaveLength(2);
  const fn = vi.fn();
  model.subscribe(fn);
  live.set(g);
  await vi.advanceTimersByTimeAsync(200);
  expect(fn.mock.calls.length).toBeLessThanOrEqual(1);
  model.dispose();
});

test('关闭自动折叠：新轮次到来时之前展开的轮次保持展开；重新打开后只展开最后 3 个，显式覆盖保留', async () => {
  const turns = (n: number) => graph(Array.from({ length: n }, (_, i) => node(`x${i + 1}`, `t${i + 1}`, i * 10)));
  const live = fakeLive(turns(4));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  const collapsed = () => model.getSnapshot().view.turns.map((t) => t.collapsed);
  expect(collapsed()).toEqual([true, false, false, false]);
  model.toggleTurn('t1'); // explicit: expanded
  expect(collapsed()).toEqual([false, false, false, false]);

  model.setAutoFold(false);
  live.set(turns(6));
  await vi.advanceTimersByTimeAsync(60);
  expect(collapsed()).toEqual([false, false, false, false, false, false]);

  model.setAutoFold(true);
  expect(collapsed()).toEqual([false, true, true, false, false, false]);
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

/** One turn 't1' of `count` nodes; node 0 is a prompt. */
function promptTurn(count: number, key = 't1', t0 = 0): Graph {
  return graph(Array.from({ length: count }, (_, i) => (i === 0 ? { ...node(`${key}n0`, key, t0), kind: 'prompt' as const } : node(`${key}n${i}`, key, t0 + i))));
}
const viewIds = (model: { getSnapshot(): { view: { nodes: Map<string, unknown> } } }) => new Set(model.getSnapshot().view.nodes.keys());

test('关闭自动折叠：轮次从 55 长到 65 个节点，之前可见的节点都不离开视图，也不出现 earlier', async () => {
  const live = fakeLive(promptTurn(55));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  model.setAutoFold(false);
  const before = viewIds(model);
  for (let n = 56; n <= 65; n++) {
    live.set(promptTurn(n));
    await vi.advanceTimersByTimeAsync(60);
    layout.resolveAll();
    await flush();
  }
  const after = viewIds(model);
  for (const id of before) expect(after.has(id)).toBe(true);
  expect(after.has('earlier:t1')).toBe(false);
  expect(after.size).toBe(65);
  model.dispose();
});

test('关闭自动折叠：已在 61 个节点折叠的轮次长到 70，隐藏集合不变，新节点全部可见；重新打开后回到正常规则', async () => {
  const live = fakeLive(promptTurn(61));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  const turn = () => model.getSnapshot().view.turns[0]!;
  const hiddenAt61 = [...turn().foldedIds];
  expect(hiddenAt61).toHaveLength(20);
  model.setAutoFold(false);
  live.set(promptTurn(70));
  await vi.advanceTimersByTimeAsync(60);
  expect(turn().foldedIds).toEqual(hiddenAt61);
  for (let i = 21; i < 70; i++) expect(model.getSnapshot().view.nodes.has(`t1n${i}`)).toBe(true);

  model.setAutoFold(true);
  expect(turn().nodeIds).toEqual(['t1n0', 'earlier:t1', ...Array.from({ length: 40 }, (_, k) => `t1n${30 + k}`)]);
  model.dispose();
});

test('关闭自动折叠后才出现的轮次，其折叠状态在出现时被冻结', async () => {
  const live = fakeLive(promptTurn(3, 't1'));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  model.setAutoFold(false);
  const both = (n: number) => graph([...Object.values(promptTurn(3, 't1').nodes), ...Object.values(promptTurn(n, 't2', 100).nodes)]);
  live.set(both(61));
  await vi.advanceTimersByTimeAsync(60);
  const t2 = () => model.getSnapshot().view.turns[1]!;
  const hidden = [...t2().foldedIds];
  expect(hidden).toHaveLength(20);
  live.set(both(75));
  await vi.advanceTimersByTimeAsync(60);
  expect(t2().foldedIds).toEqual(hidden);
  model.dispose();
});

test('setKeepVisible：被选中的节点在本该隐藏的范围里时仍留在视图中', async () => {
  const live = fakeLive(promptTurn(55));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  model.setKeepVisible('t1n5');
  live.set(promptTurn(70));
  await vi.advanceTimersByTimeAsync(60);
  const s = model.getSnapshot();
  expect(s.view.nodes.has('earlier:t1')).toBe(true);
  expect(s.view.nodes.has('t1n5')).toBe(true);
  expect(s.view.nodes.has('t1n6')).toBe(false);
  model.dispose();
});

test('setKeepVisible：新轮次到来时，选中节点所在的轮次不被默认规则折叠', async () => {
  const turns = (n: number) => graph(Array.from({ length: n }, (_, i) => node(`x${i + 1}`, `t${i + 1}`, i * 10)));
  const live = fakeLive(turns(3));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  model.setKeepVisible('x1');
  live.set(turns(5));
  await vi.advanceTimersByTimeAsync(60);
  expect(model.getSnapshot().view.turns.map((t) => t.collapsed)).toEqual([false, true, false, false, false]);
  model.setKeepVisible(null);
  live.set(turns(6));
  await vi.advanceTimersByTimeAsync(60);
  expect(model.getSnapshot().view.turns[0]!.collapsed).toBe(true);
  model.dispose();
});

test('失败且没有排队的重建时，2.5 秒后自动重试一轮', async () => {
  const live = fakeLive(graph([node('a', 't1', 0)]));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  layout.reject(layout.reqs[0]!, 'boom');
  await flush();
  expect(model.getSnapshot().layoutError).toContain('boom');
  await vi.advanceTimersByTimeAsync(2_499);
  expect(layout.reqs).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(layout.reqs).toHaveLength(2);
  layout.resolve(layout.reqs[1]!);
  await flush();
  expect(model.getSnapshot().layoutError).toBeNull();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(layout.reqs).toHaveLength(2);
  model.dispose();
});

test('连续失败时重试间隔翻倍（上限 30 秒），成功后重置', async () => {
  const live = fakeLive(graph([node('a', 't1', 0)]));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  const failAndWait = async (delay: number) => {
    const n = layout.reqs.length;
    layout.reject(layout.reqs[n - 1]!, 'boom');
    await flush();
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(layout.reqs).toHaveLength(n);
    await vi.advanceTimersByTimeAsync(1);
    expect(layout.reqs).toHaveLength(n + 1);
  };
  await failAndWait(2_500);
  await failAndWait(5_000);
  await failAndWait(10_000);
  await failAndWait(20_000);
  await failAndWait(30_000);
  await failAndWait(30_000);
  layout.resolve(layout.reqs[layout.reqs.length - 1]!);
  await flush();
  live.set(graph([node('a', 't1', 0), node('b', 't1', 1)]));
  await vi.advanceTimersByTimeAsync(60);
  await failAndWait(2_500);
  model.dispose();
});

test('重试计时期间的重建取代计时器；dispose 取消重试', async () => {
  const live = fakeLive(graph([node('a', 't1', 0)]));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  layout.reject(layout.reqs[0]!, 'boom');
  await flush();
  live.set(graph([node('a', 't1', 0), node('b', 't1', 1)]));
  await vi.advanceTimersByTimeAsync(60);
  expect(layout.reqs).toHaveLength(2);
  layout.resolve(layout.reqs[1]!);
  await flush();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(layout.reqs).toHaveLength(2); // the replaced timer did not fire

  live.set(graph([node('a', 't1', 0), node('b', 't1', 1), node('c', 't1', 2)]));
  await vi.advanceTimersByTimeAsync(60);
  layout.reject(layout.reqs[2]!, 'boom');
  await flush();
  model.dispose();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(layout.reqs).toHaveLength(3);
});

test('布局进行中 toggleTurn / showFullTurn：视图立即更新，结束前不发新请求，结束后恰好一轮', async () => {
  const live = fakeLive(graph([
    ...Array.from({ length: 61 }, (_, i) => node(`a${i}`, 't1', i)), node('b', 't2', 100), node('c', 't3', 200), node('d', 't4', 300),
  ]));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  const pendingBefore = layout.reqs.length;
  model.toggleTurn('t1');
  expect(model.getSnapshot().view.turns[0]!.collapsed).toBe(false);
  model.showFullTurn('t1');
  expect(model.getSnapshot().view.turns[0]!.foldedEarlier).toBe(0);
  await flush();
  expect(layout.reqs).toHaveLength(pendingBefore);
  layout.resolveAll();
  await flush();
  expect(layout.reqs.length).toBe(pendingBefore + 4); // exactly one more round: one request per turn
  expect(layout.reqs[pendingBefore]!.input.nodes).toHaveLength(61);
  layout.resolveAll();
  await vi.advanceTimersByTimeAsync(200);
  expect(layout.reqs.length).toBe(pendingBefore + 4);
  model.dispose();
});

test('dispose 之后才结束的一轮（且有排队重建）不再安排任何事情', async () => {
  const live = fakeLive(graph([node('a', 't1', 0)]));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  live.set(graph([node('a', 't1', 0), node('b', 't1', 1)]));
  await vi.advanceTimersByTimeAsync(60); // dirty
  model.dispose();
  layout.reject(layout.reqs[0]!, 'boom');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(layout.reqs).toHaveLength(1);
});

test('关闭自动折叠期间做的显式覆盖在恢复后保留', async () => {
  const turns = (n: number) => graph(Array.from({ length: n }, (_, i) => node(`x${i + 1}`, `t${i + 1}`, i * 10)));
  const live = fakeLive(turns(5));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  model.setAutoFold(false);
  model.toggleTurn('t1'); // expand
  model.toggleTurn('t5'); // fold
  model.setAutoFold(true);
  expect(model.getSnapshot().view.turns.map((t) => t.collapsed)).toEqual([false, true, false, false, true]);
  model.dispose();
});

test('被默认规则折叠的轮次忘掉“展开全部”：再展开时回到折叠更早节点', async () => {
  const long = Array.from({ length: 61 }, (_, i) => node(`a${i}`, 't1', i));
  const live = fakeLive(graph(long));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  model.showFullTurn('t1');
  expect(model.getSnapshot().view.turns[0]!.foldedEarlier).toBe(0);
  live.set(graph([...long, node('b', 't2', 100), node('c', 't3', 200), node('d', 't4', 300)]));
  await vi.advanceTimersByTimeAsync(60);
  expect(model.getSnapshot().view.turns[0]!.collapsed).toBe(true);
  model.toggleTurn('t1');
  expect(model.getSnapshot().view.turns[0]!.foldedEarlier).toBe(21);
  model.dispose();
});

const prompt = (id: string, turnId: string, t: number): GraphNode => ({ ...node(id, turnId, t), kind: 'prompt' });
const sub = (id: string, turnId: string | null, agentId: string | null, t: number, childAgentId: string): GraphNode =>
  ({ ...node(id, turnId ?? 'x', t), turnId, agentId, kind: 'subagent', childAgentId });
const inner = (id: string, agentId: string, t: number): GraphNode => ({ ...node(id, 'x', t), turnId: null, agentId, kind: 'tool' });
function withEdges(nodes: GraphNode[], pairs: [string, string, GraphEdge['kind']?][]): Graph {
  const edges = pairs.map(([from, to, kind]): GraphEdge => ({ id: `${from}->${to}`, sessionId: 's1', from, to, kind: kind ?? 'sequence' }));
  return { nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), edges: Object.fromEntries(edges.map((e) => [e.id, e])) };
}
/** t1: p1 → s1(a1)；a1: k1 → s2(a2)；a2: j1 */
function nestedAgents(): Graph {
  return withEdges(
    [prompt('p1', 't1', 0), sub('s1', 't1', null, 1, 'a1'), inner('k1', 'a1', 2), sub('s2', null, 'a1', 3, 'a2'), inner('j1', 'a2', 4)],
    [['p1', 's1'], ['s1', 'k1', 'spawn'], ['k1', 's2'], ['s2', 'j1', 'spawn']],
  );
}
/** t1: p1 → x1；t2: p2 → s1(a1)；a1: i1 → i2 */
function twoTurnsWithAgent(): Graph {
  return withEdges(
    [prompt('p1', 't1', 0), { ...node('x1', 't1', 1), kind: 'tool' }, prompt('p2', 't2', 10), sub('s1', 't2', null, 11, 'a1'),
      inner('i1', 'a1', 12), inner('i2', 'a1', 13)],
    [['p1', 'x1'], ['x1', 'p2'], ['p2', 's1'], ['s1', 'i1', 'spawn'], ['i1', 'i2']],
  );
}
/** Same input, same layout (like the real client's cache): nodes stacked at x = 0 with no gap, in input order. */
function deterministicLayout() {
  const inputs: TurnLayoutInput[] = [];
  const client: LayoutClient = {
    layout: async (input) => {
      inputs.push(input);
      const positions: Record<string, { x: number; y: number }> = {};
      let y = 0;
      for (const n of input.nodes) {
        positions[n.id] = { x: 0, y };
        y += n.height;
      }
      const width = Math.max(...input.nodes.map((n) => n.width));
      return { key: input.key, width, height: y, anchorX: input.nodes[0]!.width / 2, positions };
    },
    dispose() {},
  };
  return { client, inputs };
}

test('先布局最深的代理分组，再布局包含它的分组，最后布局轮次；容器尺寸传给上层', async () => {
  const live = fakeLive(nestedAgents());
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  model.toggleAgent('a1');
  model.toggleAgent('a2');
  layout.resolveAll(); // the first round (nothing expanded yet)
  await flush();
  const start = 1;
  const keys = () => layout.reqs.slice(start).map((r) => r.input.key);
  expect(keys()).toEqual(['agent:a2']); // the deeper group alone: its parent needs its size
  layout.resolveAll();
  await flush();
  expect(keys()).toEqual(['agent:a2', 'agent:a1']);
  const a1 = layout.reqs[start + 1]!.input;
  expect(a1.nodes).toEqual([{ id: 'k1', width: 240, height: 52 }, { id: 's2', ...containerSize({ width: 300, height: 100 }) }]);
  expect(a1.edges).toEqual([{ id: 'k1->s2', from: 'k1', to: 's2' }]);
  layout.resolveAll();
  await flush();
  expect(keys()).toEqual(['agent:a2', 'agent:a1', 't1']);
  const t1 = layout.reqs[start + 2]!.input;
  expect(t1.nodes).toEqual([{ id: 'p1', width: 280, height: 64 }, { id: 's1', ...containerSize({ width: 300, height: 200 }) }]);
  expect(model.getSnapshot().positions.j1).toBeUndefined(); // nothing lands before the turns return
  layout.resolveAll();
  await flush();
  const s = model.getSnapshot();
  for (const id of ['p1', 's1', 'k1', 's2', 'j1']) expect(s.positions[id]).toBeDefined();
  expect(Object.keys(s.containerBoxes).sort()).toEqual(['s1', 's2']);
  expect(s.containerBoxes.s1).toEqual({ ...s.positions.s1!, ...containerSize({ width: 300, height: 200 }) });
  await vi.advanceTimersByTimeAsync(200);
  expect(layout.reqs).toHaveLength(start + 3); // one round, nothing more
  model.dispose();
});

test('未展开的子代理不产生布局请求', async () => {
  const live = fakeLive(nestedAgents());
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  expect(layout.reqs.map((r) => r.input.key)).toEqual(['t1']);
  expect(layout.reqs[0]!.input.nodes).toEqual([{ id: 'p1', width: 280, height: 64 }, { id: 's1', width: 260, height: 68 }]);
  layout.resolveAll();
  await flush();
  expect(model.getSnapshot().containerBoxes).toEqual({});
  await vi.advanceTimersByTimeAsync(200);
  expect(layout.reqs).toHaveLength(1);
  model.dispose();
});

test('toggleAgent 展开后内部节点获得位置；再次调用折叠后内部节点从 positions 中消失', async () => {
  const live = fakeLive(twoTurnsWithAgent());
  const layout = deterministicLayout();
  const model = createCanvasModel(live, layout.client);
  await flush();
  model.toggleAgent('a1');
  const mid = model.getSnapshot(); // rebuilt at once; inner nodes not placed yet, no container box yet
  expect(mid.view.nodes.has('i1')).toBe(true);
  expect(mid.positions.i1).toBeUndefined();
  expect(mid.containerBoxes).toEqual({});
  await flush();
  const s = model.getSnapshot();
  const box = s.containerBoxes.s1!;
  expect(box).toEqual({ ...s.positions.s1!, ...containerSize({ width: 240, height: 104 }) }); // two 240 x 52 tools
  expect(s.positions.i1).toEqual({ x: box.x + 16, y: box.y + 68 + 16 });
  expect(s.positions.i2).toEqual({ x: box.x + 16, y: box.y + 68 + 16 + 52 });

  model.toggleAgent('a1');
  const folded = model.getSnapshot();
  expect(folded.view.nodes.has('i1')).toBe(false);
  expect(folded.positions.i1).toBeUndefined();
  expect(folded.positions.i2).toBeUndefined();
  expect(folded.containerBoxes).toEqual({});
  await flush();
  expect(model.getSnapshot().positions.i1).toBeUndefined();
  expect(model.getSnapshot().containerBoxes).toEqual({});
  model.dispose();
});

test('展开一个子代理不改变它之前各轮次的坐标', async () => {
  const live = fakeLive(twoTurnsWithAgent());
  const layout = deterministicLayout();
  const model = createCanvasModel(live, layout.client);
  await flush();
  const before = model.getSnapshot();
  model.toggleAgent('a1');
  await flush();
  const after = model.getSnapshot();
  expect(after.positions.i1).toBeDefined();
  expect(after.positions.p1).toEqual(before.positions.p1);
  expect(after.positions.x1).toEqual(before.positions.x1);
  expect(after.turnBoxes.t1).toEqual(before.turnBoxes.t1);
  expect(after.turnBoxes.t2!.height).toBeGreaterThan(before.turnBoxes.t2!.height); // the container is taller
  model.dispose();
});

test('setMode("topology") 立即重建；getMode 反映当前视角', async () => {
  const live = fakeLive(withEdges(
    [prompt('p1', 't1', 0), node('tx', 't1', 1), sub('s1', 't1', null, 2, 'a1'), inner('i1', 'a1', 3)],
    [['p1', 'tx'], ['tx', 's1'], ['s1', 'i1', 'spawn']],
  ));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  expect(model.getMode()).toBe('live');
  model.toggleAgent('a1');
  expect(model.getSnapshot().view.nodes.has('i1')).toBe(true);
  const fn = vi.fn();
  model.subscribe(fn);
  model.setMode('topology');
  expect(model.getMode()).toBe('topology');
  const s = model.getSnapshot(); // no timer advanced
  expect(fn).toHaveBeenCalled();
  expect(s.view.mode).toBe('topology');
  expect(s.view.nodes.has('tx')).toBe(false);
  expect(s.view.nodes.has('i1')).toBe(false); // topology mode shows every subagent collapsed
  expect(s.view.agentGroups).toEqual([]);
  model.setMode('live'); // the expanded agents were kept
  expect(model.getMode()).toBe('live');
  expect(model.getSnapshot().view.nodes.has('i1')).toBe(true);
  expect(model.getSnapshot().view.nodes.has('tx')).toBe(true);
  model.dispose();
});

test('拓扑视角下没有可见节点的轮次不请求布局，也不占纵向空间', async () => {
  // t1 holds only text nodes (hidden in topology mode); t2 starts with a prompt.
  const live = fakeLive(graph([node('a', 't1', 0), node('b', 't1', 1), prompt('c', 't2', 10)]));
  const layout = deterministicLayout();
  const model = createCanvasModel(live, layout.client);
  await flush();
  const start = layout.inputs.length;
  model.setMode('topology');
  expect(model.getSnapshot().view.turns[0]!.nodeIds).toEqual([]);
  await flush();
  expect(layout.inputs.slice(start).map((x) => x.key)).toEqual(['t2']);
  const s = model.getSnapshot();
  expect(Object.keys(s.turnBoxes)).toEqual(['t2']);
  expect(s.turnBoxes.t2!.y).toBe(0);
  expect(s.positions.c!.y).toBe(28); // TURN_HEADER: nothing above it
  model.dispose();
});

test('切换视角：新视角的布局到达前 layoutMode 仍是旧视角，到达后两者一起切换', async () => {
  const live = fakeLive(withEdges([prompt('p1', 't1', 0), { ...node('th', 't1', 1), kind: 'thinking' }], [['p1', 'th']]));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  expect(model.getSnapshot().layoutMode).toBe('live');
  layout.resolveAll();
  await flush();
  model.setMode('causal');
  const mid = model.getSnapshot();
  expect(mid.view.mode).toBe('causal');
  expect(mid.layoutMode).toBe('live');
  layout.resolveAll();
  await flush();
  const s = model.getSnapshot();
  expect(s.view.mode).toBe('causal');
  expect(s.layoutMode).toBe('causal');
  model.dispose();
});

test('相同的布局结果在切换视角后仍会发布新的 layoutMode', async () => {
  const live = fakeLive(withEdges([prompt('p1', 't1', 0), { ...node('x', 't1', 1), kind: 'tool' }], [['p1', 'x']]));
  const layout = deterministicLayout(); // no thinking node: the causal layout equals the live one
  const model = createCanvasModel(live, layout.client);
  await flush();
  const before = model.getSnapshot().positions;
  model.setMode('causal');
  await flush();
  expect(model.getSnapshot().positions).toBe(before);
  expect(model.getSnapshot().layoutMode).toBe('causal');
  model.dispose();
});

test('过期的一轮在分层之间停下：不再请求下一层，不发布，之后恰好再跑一轮', async () => {
  const live = fakeLive(nestedAgents());
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  model.toggleAgent('a1');
  model.toggleAgent('a2');
  layout.resolveAll(); // the first round (nothing expanded yet)
  await flush();
  const start = 1;
  const keys = () => layout.reqs.slice(start).map((r) => r.input.key);
  expect(keys()).toEqual(['agent:a2']);
  const fn = vi.fn();
  model.subscribe(fn);
  model.showFullTurn('t1'); // a rebuild while the round runs: the model is dirty
  fn.mockClear();
  layout.resolve(layout.reqs[start]!);
  await flush();
  // The stale round requested no further level; the queued rebuild started a new round from the deepest level.
  expect(keys()).toEqual(['agent:a2', 'agent:a2']);
  expect(model.getSnapshot().positions.j1).toBeUndefined();
  layout.resolveAll();
  await flush();
  expect(keys()).toEqual(['agent:a2', 'agent:a2', 'agent:a1']);
  layout.resolveAll();
  await flush();
  expect(keys()).toEqual(['agent:a2', 'agent:a2', 'agent:a1', 't1']);
  layout.resolveAll();
  await flush();
  expect(model.getSnapshot().positions.j1).toBeDefined();
  await vi.advanceTimersByTimeAsync(200);
  expect(keys()).toHaveLength(4);
  model.dispose();
});

test('连续过期时不会一直停下：上一轮已提前停下时，这一轮跑完', async () => {
  const live = fakeLive(nestedAgents());
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  model.toggleAgent('a1');
  model.toggleAgent('a2');
  layout.resolveAll();
  await flush();
  model.showFullTurn('t1');
  layout.resolveAll(); // abandoned after its first level
  await flush();
  model.toggleTurn('t1'); // dirty again during the new round
  model.toggleTurn('t1');
  const n = layout.reqs.length;
  layout.resolveAll(); // the new round's first level: this round goes on
  await flush();
  expect(layout.reqs.length).toBe(n + 1);
  expect(layout.reqs[n]!.input.key).toBe('agent:a1');
  model.dispose();
});

/**
 * No positioned inner node without its container's box, and no box (of a container expanded in the view) without a
 * positioned inner node.
 */
function consistent(s: ReturnType<ReturnType<typeof createCanvasModel>['getSnapshot']>): boolean {
  const byContainer = new Map(s.view.agentGroups.map((g) => [g.containerId, g]));
  for (const g of s.view.agentGroups) {
    const box = s.containerBoxes[g.containerId] !== undefined;
    if (!box && g.nodeIds.some((id) => s.positions[id] !== undefined)) return false;
  }
  return Object.keys(s.containerBoxes).every((id) => {
    const g = byContainer.get(id);
    return g !== undefined && g.nodeIds.some((x) => s.positions[x] !== undefined);
  });
}

test('代理分组布局失败：保留之前的位置和容器框，记录 layoutError，之后自动重试', async () => {
  const live = fakeLive(twoTurnsWithAgent());
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  model.toggleAgent('a1');
  for (let k = 0; k < 3; k++) { layout.resolveAll(); await flush(); }
  const before = model.getSnapshot();
  expect(before.containerBoxes.s1).toBeDefined();
  const g = twoTurnsWithAgent();
  g.nodes.i3 = inner('i3', 'a1', 14);
  g.edges['i2->i3'] = { id: 'i2->i3', sessionId: 's1', from: 'i2', to: 'i3', kind: 'sequence' };
  live.set(g);
  await vi.advanceTimersByTimeAsync(60);
  const req = layout.pending();
  expect(req.map((r) => r.input.key)).toEqual(['agent:a1']);
  layout.reject(req[0]!, 'inner boom');
  await flush();
  const s = model.getSnapshot();
  expect(s.layoutError).toContain('inner boom');
  expect(s.positions).toEqual(before.positions);
  expect(s.containerBoxes).toEqual(before.containerBoxes);
  expect(consistent(s)).toBe(true);
  const n = layout.reqs.length;
  await vi.advanceTimersByTimeAsync(2_500);
  expect(layout.reqs.length).toBe(n + 1);
  expect(layout.reqs[n]!.input.key).toBe('agent:a1');
  model.dispose();
});

test('分层之间 dispose：不再发出任何请求', async () => {
  const live = fakeLive(nestedAgents());
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  model.toggleAgent('a1');
  model.toggleAgent('a2');
  layout.resolveAll();
  await flush();
  const n = layout.reqs.length;
  layout.resolveAll(); // the deepest level
  model.dispose();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(layout.reqs.length).toBe(n);
});

test('toggleAgent 之后才到达的过期一轮：位置和容器框保持一致', async () => {
  const live = fakeLive(twoTurnsWithAgent());
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  layout.resolveAll();
  await flush();
  // Expanded round in its last stage, then collapse: the landing round must not leave a box or inner positions.
  model.toggleAgent('a1');
  layout.resolveAll(); // agent:a1
  await flush();
  expect(layout.pending().map((r) => r.input.key)).toEqual(['t1', 't2']);
  model.toggleAgent('a1');
  layout.resolveAll();
  await flush();
  expect(consistent(model.getSnapshot())).toBe(true);
  expect(model.getSnapshot().containerBoxes).toEqual({});
  // Collapsed round in flight, then expand: the landing round has no inner positions and no box.
  model.toggleAgent('a1');
  for (let k = 0; k < 3; k++) { layout.resolveAll(); await flush(); expect(consistent(model.getSnapshot())).toBe(true); }
  const s = model.getSnapshot();
  expect(s.containerBoxes.s1).toBeDefined();
  expect(s.positions.i1).toBeDefined();
  model.dispose();
});

/** t1: p1 → s1(a1)；a1 内部 m0..m{n-1} 串成一条链 */
function longAgent(n: number): Graph {
  const nodes: GraphNode[] = [prompt('p1', 't1', 0), sub('s1', 't1', null, 1, 'a1')];
  const pairs: [string, string, GraphEdge['kind']?][] = [['p1', 's1'], ['s1', 'm0', 'spawn']];
  for (let k = 0; k < n; k++) {
    nodes.push(inner(`m${k}`, 'a1', 1000 + k));
    if (k > 0) pairs.push([`m${k - 1}`, `m${k}`]);
  }
  return withEdges(nodes, pairs);
}

test('showFullTurn 对代理分组键同样生效；收起代理后忘掉“展开全部”', async () => {
  const live = fakeLive(longAgent(61));
  const layout = deterministicLayout();
  const model = createCanvasModel(live, layout.client);
  model.toggleAgent('a1');
  const group = () => model.getSnapshot().view.agentGroups[0]!;
  expect(group().foldedIds).toHaveLength(20);
  expect(model.getSnapshot().view.nodes.get('earlier:agent:a1')).toMatchObject({ type: 'earlier', groupKey: 'agent:a1' });
  model.showFullTurn('agent:a1');
  expect(group().foldedIds).toEqual([]);
  expect(group().nodeIds).toHaveLength(61);
  model.toggleAgent('a1'); // collapse
  model.toggleAgent('a1'); // expand again: folded by the length rule
  expect(group().foldedIds).toHaveLength(20);
  model.dispose();
});

test('关闭自动折叠：代理内部从 61 长到 70，隐藏集合不变，新节点全部可见；重新打开后回到正常规则', async () => {
  const live = fakeLive(longAgent(61));
  const layout = deterministicLayout();
  const model = createCanvasModel(live, layout.client);
  model.toggleAgent('a1');
  const group = () => model.getSnapshot().view.agentGroups[0]!;
  const hiddenAt61 = [...group().foldedIds];
  model.setAutoFold(false);
  live.set(longAgent(70));
  await vi.advanceTimersByTimeAsync(60);
  expect(group().foldedIds).toEqual(hiddenAt61);
  for (let k = 21; k < 70; k++) expect(model.getSnapshot().view.nodes.has(`m${k}`)).toBe(true);
  model.setAutoFold(true);
  expect(group().foldedIds).toHaveLength(70 - 1 - 40);
  model.dispose();
});

// ---- 复盘视角 ----

const at = (tMs: number) => new Date(EPOCH + tMs).toISOString();
/** t1: p1 (0) → a 工具 (1000 开始，5000 结束) → b 回复 (6000) */
function replaySample(): Graph {
  return withEdges(
    [
      prompt('p1', 't1', 0),
      { ...node('a', 't1', 1000), kind: 'tool', status: 'succeeded', durationMs: 4000, endedAt: at(5000) },
      node('b', 't1', 6000),
    ],
    [['p1', 'a'], ['a', 'b']],
  );
}
const nodeOf = (model: ReturnType<typeof createCanvasModel>, id: string) => {
  const vn = model.getSnapshot().view.nodes.get(id);
  return vn?.type === 'node' ? vn.node : undefined;
};

test('setMode("replay") 把时刻设为范围末尾；快照带 replay 信息，其他视角为 null', async () => {
  const live = fakeLive(replaySample());
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  expect(model.getSnapshot().replay).toBeNull();
  model.setMode('replay');
  expect(model.getMode()).toBe('replay');
  const s = model.getSnapshot(); // no timer advanced
  expect(s.view.mode).toBe('replay');
  expect(s.replay).toEqual({
    range: { startMs: EPOCH, endMs: EPOCH + 6000 },
    timeMs: EPOCH + 6000,
    marks: [{ turnId: 't1', ms: EPOCH }],
    totals: { nodeCount: 3, usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } },
  });
  expect([...s.view.nodes.keys()].sort()).toEqual(['a', 'b', 'p1']);
  expect(model.getReplay()).toEqual(s.replay);
  model.setMode('causal');
  expect(model.getSnapshot().replay).toBeNull();
  model.setMode('replay'); // re-entering starts at the end again
  model.setReplayTime(EPOCH + 3000);
  model.setMode('live');
  model.setMode('replay');
  expect(model.getSnapshot().replay!.timeMs).toBe(EPOCH + 6000);
  model.dispose();
});

test('setReplayTime 立即发布的快照只换 replay：画布节点 / 边的输入（view、positions、框、layoutMode）保持同一对象', async () => {
  const live = fakeLive(replaySample());
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  layout.resolveAll();
  await flush();
  model.setMode('replay');
  await vi.advanceTimersByTimeAsync(60);
  layout.resolveAll();
  await flush();
  const before = model.getSnapshot();
  model.setReplayTime(EPOCH + 3000);
  const tick = model.getSnapshot();
  expect(tick).not.toBe(before);
  expect(tick.replay!.timeMs).toBe(EPOCH + 3000);
  expect(tick.view).toBe(before.view);
  expect(tick.positions).toBe(before.positions);
  expect(tick.turnBoxes).toBe(before.turnBoxes);
  expect(tick.containerBoxes).toBe(before.containerBoxes);
  expect(tick.layoutMode).toBe(before.layoutMode);
  model.dispose();
});

test('setReplayTime 之后，视图只含该时刻之前的节点；中途的工具为 running', async () => {
  const live = fakeLive(replaySample());
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  layout.resolveAll();
  await flush();
  model.setMode('replay');
  model.setReplayTime(EPOCH + 3000);
  expect(model.getSnapshot().replay!.timeMs).toBe(EPOCH + 3000); // the time is published at once
  await vi.advanceTimersByTimeAsync(60); // the view follows through the throttled rebuild
  const s = model.getSnapshot();
  expect([...s.view.nodes.keys()].sort()).toEqual(['a', 'p1']);
  expect(nodeOf(model, 'a')).toMatchObject({ status: 'running', durationMs: null, endedAt: null });
  expect(s.view.latestNodeId).toBe('a');
  expect(s.replay!.totals.nodeCount).toBe(2);
  expect(live.getGraph().nodes.a!.status).toBe('succeeded'); // the live graph is untouched
  model.setReplayTime(EPOCH + 5000);
  await vi.advanceTimersByTimeAsync(60);
  expect(nodeOf(model, 'a')).toMatchObject({ status: 'succeeded', durationMs: 4000 });
  // Clamped to the range; NaN is ignored.
  model.setReplayTime(EPOCH - 1e9);
  expect(model.getSnapshot().replay!.timeMs).toBe(EPOCH);
  model.setReplayTime(Number.NaN);
  expect(model.getSnapshot().replay!.timeMs).toBe(EPOCH);
  model.setReplayTime(EPOCH + 1e9);
  expect(model.getSnapshot().replay!.timeMs).toBe(EPOCH + 6000);
  model.dispose();
});

test('复盘中实时图新增节点：视图不变、范围末尾延长、时刻不动', async () => {
  const g = replaySample();
  const live = fakeLive(g);
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  model.setMode('replay');
  layout.resolveAll();
  await flush();
  layout.resolveAll();
  await flush();
  const before = model.getSnapshot();
  const requests = layout.reqs.length;
  // An immutable update, as the live session makes it: unchanged nodes and edges keep their objects.
  live.set({
    nodes: { ...g.nodes, z: node('z', 't1', 9000) },
    edges: { ...g.edges, 'b->z': { id: 'b->z', sessionId: 's1', from: 'b', to: 'z', kind: 'sequence' } },
  });
  await vi.advanceTimersByTimeAsync(60);
  const s = model.getSnapshot();
  expect(s.view).toBe(before.view);
  expect(s.positions).toBe(before.positions);
  expect(s.replay!.timeMs).toBe(EPOCH + 6000);
  expect(s.replay!.range).toEqual({ startMs: EPOCH, endMs: EPOCH + 9000 });
  expect(layout.reqs.length).toBe(requests); // nothing to lay out
  model.dispose();
});

test('切回 live 后视图立即包含复盘期间新增的节点', async () => {
  const g = replaySample();
  const live = fakeLive(g);
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  model.setMode('replay');
  live.set({ nodes: { ...g.nodes, z: node('z', 't1', 9000) }, edges: g.edges });
  await vi.advanceTimersByTimeAsync(60);
  expect(model.getSnapshot().view.nodes.has('z')).toBe(false);
  model.setMode('live');
  const s = model.getSnapshot(); // no timer advanced
  expect(s.view.nodes.has('z')).toBe(true);
  expect(nodeOf(model, 'a')!.status).toBe('succeeded');
  expect(s.replay).toBeNull();
  model.dispose();
});

test('totals 按 messageId 去重并包含子代理内部节点', async () => {
  const u = (inputTokens: number, outputTokens: number, cachedInputTokens = 0) => ({ inputTokens, cachedInputTokens, outputTokens });
  const live = fakeLive(withEdges(
    [
      prompt('p1', 't1', 0),
      { ...node('x1', 't1', 1), messageId: 'm1', usage: u(100, 10) },
      { ...node('x2', 't1', 2), kind: 'tool', messageId: 'm1', usage: u(100, 10) },
      sub('s1', 't1', null, 3, 'a1'),
      { ...inner('i1', 'a1', 4), messageId: 'm2', usage: u(50, 5, 20) },
      { ...inner('i2', 'a1', 10), messageId: 'm3', usage: u(7, 1, 3) },
    ],
    [['p1', 'x1'], ['x1', 'x2'], ['x2', 's1'], ['s1', 'i1', 'spawn'], ['i1', 'i2']],
  ));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  model.setMode('replay'); // the agent is collapsed: its inner nodes still count
  expect(model.getSnapshot().view.nodes.has('i1')).toBe(false);
  expect(model.getSnapshot().replay!.totals).toEqual({ nodeCount: 6, usage: u(157, 16, 23) });
  model.setReplayTime(EPOCH + 5);
  await vi.advanceTimersByTimeAsync(60);
  expect(model.getSnapshot().replay!.totals).toEqual({ nodeCount: 5, usage: u(150, 15, 20) });
  model.dispose();
});

test('非 replay 视角下 setReplayTime 不起作用', async () => {
  const live = fakeLive(replaySample());
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  layout.resolveAll();
  await flush();
  const before = model.getSnapshot();
  const fn = vi.fn();
  model.subscribe(fn);
  model.setReplayTime(EPOCH + 3000);
  await vi.advanceTimersByTimeAsync(200);
  expect(fn).not.toHaveBeenCalled();
  expect(model.getSnapshot()).toBe(before);
  model.setMode('replay');
  expect(model.getSnapshot().replay!.timeMs).toBe(EPOCH + 6000);
  model.dispose();
});

test('复盘中拖动滑块：一轮布局进行中连续 setReplayTime，结束后只再跑 1 轮，用最后的时刻', async () => {
  const live = fakeLive(graph(Array.from({ length: 20 }, (_, i) => node(`n${i}`, 't1', i * 1000))));
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  layout.resolveAll();
  await flush();
  model.setMode('replay');
  const start = layout.reqs.length;
  expect(layout.pending()).toHaveLength(1);
  for (let k = 19; k >= 5; k--) {
    model.setReplayTime(EPOCH + k * 1000);
    await vi.advanceTimersByTimeAsync(16);
  }
  await vi.advanceTimersByTimeAsync(60);
  expect(layout.reqs.length).toBe(start); // still the one round
  expect(model.getSnapshot().view.nodes.size).toBe(6);
  layout.resolveAll();
  await flush();
  expect(layout.reqs.length).toBe(start + 1);
  expect(layout.reqs[start]!.input.nodes.map((n) => n.id)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4', 'n5']);
  layout.resolveAll();
  await vi.advanceTimersByTimeAsync(200);
  expect(layout.reqs.length).toBe(start + 1);
  model.dispose();
});

test('复盘中移动时刻但回放图没有变化：不重建视图、不请求布局，只更新时刻', async () => {
  const live = fakeLive(replaySample());
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  model.setMode('replay');
  model.setReplayTime(EPOCH + 2000); // a is running
  await vi.advanceTimersByTimeAsync(60);
  for (let k = 0; k < 3; k++) { layout.resolveAll(); await flush(); }
  const before = model.getSnapshot();
  const requests = layout.reqs.length;
  model.setReplayTime(EPOCH + 3000); // a is still running, nothing else started
  await vi.advanceTimersByTimeAsync(60);
  const s = model.getSnapshot();
  expect(s.view).toBe(before.view);
  expect(s.replay!.timeMs).toBe(EPOCH + 3000);
  expect(s.replay!.totals).toBe(before.replay!.totals);
  expect(s.replay!.marks).toBe(before.replay!.marks);
  expect(layout.reqs.length).toBe(requests);
  model.dispose();
});

test('复盘视角下的布局请求使用复盘尺寸；新尺寸的布局到达后 layoutMode 才切换', async () => {
  const live = fakeLive(replaySample());
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  layout.resolveAll();
  await flush();
  model.setMode('replay');
  const req = layout.pending()[0]!;
  expect(req.input.nodes).toEqual([
    { id: 'p1', width: 280, height: 64 }, { id: 'a', width: 240, height: 68 }, { id: 'b', width: 280, height: 72 },
  ]);
  expect(model.getSnapshot().layoutMode).toBe('live');
  layout.resolveAll();
  await flush();
  expect(model.getSnapshot().layoutMode).toBe('replay');
  model.dispose();
});

test('代理分组离开视图后忘掉“展开全部”：轮次折叠或切到拓扑再回来，按长度规则重新折叠', async () => {
  const live = fakeLive(longAgent(61));
  const layout = deterministicLayout();
  const model = createCanvasModel(live, layout.client);
  model.toggleAgent('a1');
  const group = () => model.getSnapshot().view.agentGroups[0];
  model.showFullTurn('agent:a1');
  expect(group()!.foldedIds).toEqual([]);
  model.toggleTurn('t1'); // collapse the container's turn: the group leaves the view
  expect(group()).toBeUndefined();
  model.toggleTurn('t1');
  expect(group()!.foldedIds).toHaveLength(20);
  model.showFullTurn('agent:a1');
  model.setMode('topology');
  model.setMode('live');
  expect(group()!.foldedIds).toHaveLength(20);
  model.dispose();
});

test('代理分组离开视图后忘掉冻结的折叠：回到视图时按当时的长度规则重新冻结', async () => {
  const live = fakeLive(longAgent(61));
  const layout = deterministicLayout();
  const model = createCanvasModel(live, layout.client);
  model.toggleAgent('a1');
  model.setAutoFold(false);
  const group = () => model.getSnapshot().view.agentGroups[0];
  expect(group()!.foldedIds).toHaveLength(20);
  model.setMode('topology'); // the group leaves the view
  live.set(longAgent(70));
  await vi.advanceTimersByTimeAsync(60);
  model.setMode('live');
  expect(group()!.foldedIds).toHaveLength(70 - 1 - 40);
  model.dispose();
});

test('expandTurn 只展开：折叠的轮次被展开，已展开的轮次不变（重复调用无副作用）', async () => {
  const turns = graph([node('a', 't1', 0), node('b', 't2', 10), node('c', 't3', 20), node('d', 't4', 30)]);
  const live = fakeLive(turns);
  const layout = fakeLayout();
  const model = createCanvasModel(live, layout.client);
  const collapsed = () => model.getSnapshot().view.turns.map((t) => t.collapsed);
  expect(collapsed()).toEqual([true, false, false, false]);
  model.expandTurn('t1');
  expect(collapsed()).toEqual([false, false, false, false]);
  model.expandTurn('t1');
  model.expandTurn('t4');
  expect(collapsed()).toEqual([false, false, false, false]);
  model.expandTurn('nope');
  model.dispose();
});

const readCall = (id: string, tMs: number, extra: Partial<GraphNode> = {}): GraphNode => ({
  ...node(id, 't1', tMs), kind: 'tool', status: 'succeeded', toolName: 'Read', title: 'Read', confirmed: true, ...extra,
});
const shownIds = (model: { getSnapshot(): { view: { nodes: Map<string, unknown> } } }) => [...model.getSnapshot().view.nodes.keys()].sort();

test('精简默认开启：空思考节点不画，连续的同类调用合并；setCompact(false) 画出全部', () => {
  const nodes = [
    node('p', 't1', 0), { ...node('th', 't1', 1), kind: 'thinking' as const, durationMs: 2000 },
    readCall('a', 2), readCall('b', 3), readCall('c', 4), node('x', 't1', 5),
  ];
  const model = createCanvasModel(fakeLive(graph(nodes)), fakeLayout().client);
  expect(model.getSnapshot().compact).toBe(true);
  expect(shownIds(model)).toEqual(['p', 'run:a', 'x']);
  const run = model.getSnapshot().view.nodes.get('run:a');
  expect(run).toMatchObject({ runCount: 3, thinkingMs: 2000 });
  model.setCompact(false);
  expect(model.getSnapshot().compact).toBe(false);
  expect(shownIds(model)).toEqual(['a', 'b', 'c', 'p', 'th', 'x']);
  model.setCompact(true);
  expect(shownIds(model)).toEqual(['p', 'run:a', 'x']);
  model.dispose();
});

test('expandRun 之后这组调用保持展开，新增的同类调用也不再并回去', async () => {
  const nodes = [node('p', 't1', 0), readCall('a', 2), readCall('b', 3), readCall('c', 4)];
  const live = fakeLive(graph(nodes));
  const model = createCanvasModel(live, fakeLayout().client);
  expect(shownIds(model)).toEqual(['p', 'run:a']);
  model.expandRun('run:a');
  expect(shownIds(model)).toEqual(['a', 'b', 'c', 'p']);
  live.set(graph([...nodes, readCall('d', 5)]));
  await vi.advanceTimersByTimeAsync(60);
  expect(shownIds(model)).toEqual(['a', 'b', 'c', 'd', 'p']);
  model.dispose();
});

test('自动折叠关闭期间不形成新的合并节点；重新开启后合并', async () => {
  const nodes = [node('p', 't1', 0), readCall('a', 2), readCall('b', 3)];
  const live = fakeLive(graph(nodes));
  const model = createCanvasModel(live, fakeLayout().client);
  expect(shownIds(model)).toEqual(['a', 'b', 'p']);
  model.setAutoFold(false);
  live.set(graph([...nodes, readCall('c', 4)]));
  await vi.advanceTimersByTimeAsync(60);
  expect(shownIds(model)).toEqual(['a', 'b', 'c', 'p']);
  model.setAutoFold(true);
  expect(shownIds(model)).toEqual(['p', 'run:a']);
  model.dispose();
});

test('展开过的调用不会因为选中其中第一个而被重新合并', async () => {
  const nodes = [node('p', 't1', 0), readCall('a', 2), readCall('b', 3), readCall('c', 4), readCall('d', 5), node('x', 't1', 6)];
  const live = fakeLive(graph(nodes));
  const model = createCanvasModel(live, fakeLayout().client);
  expect(shownIds(model)).toEqual(['p', 'run:a', 'x']);
  model.expandRun('run:a');
  model.setKeepVisible('a');
  live.set(graph([...nodes, node('y', 't1', 7)]));
  await vi.advanceTimersByTimeAsync(60);
  expect(shownIds(model)).toEqual(['a', 'b', 'c', 'd', 'p', 'x', 'y']);
  model.dispose();
});

test('在没有精简的视图里停止跟随，之后切到精简视图仍然会合并', () => {
  const nodes = [node('p', 't1', 0), readCall('a', 2), readCall('b', 3), readCall('c', 4), node('x', 't1', 5)];
  const outline = createCanvasModel(fakeLive(graph(nodes)), fakeLayout().client, { mode: 'outline' });
  outline.setAutoFold(false);
  outline.setMode('live');
  expect(shownIds(outline)).toEqual(['p', 'run:a', 'x']);
  outline.dispose();
  const full = createCanvasModel(fakeLive(graph(nodes)), fakeLayout().client, { compact: false });
  full.setAutoFold(false);
  full.setCompact(true);
  expect(shownIds(full)).toEqual(['p', 'run:a', 'x']);
  full.dispose();
});

test('停止跟随期间切换精简 / 完整：折叠按新视图重新计算', () => {
  const nodes: GraphNode[] = [node('p', 't1', 0)];
  for (let i = 0; i < 150; i++) {
    nodes.push({ ...node(`th${i}`, 't1', 1 + i * 2), kind: 'thinking', durationMs: 5 }, node(`x${i}`, 't1', 2 + i * 2));
  }
  const model = createCanvasModel(fakeLive(graph(nodes)), fakeLayout().client);
  expect(model.getSnapshot().view.nodes.size).toBe(41); // 151 compact nodes (no prompt): earlier + last 40
  model.setAutoFold(false);
  model.setCompact(false);
  expect(model.getSnapshot().view.nodes.size).toBe(41); // 301 nodes, folded by the same rule
  model.setCompact(true);
  expect(model.getSnapshot().view.nodes.size).toBe(41);
  model.dispose();
});

test('进出概览不会丢掉逐步视图里的“展开全部”', () => {
  const nodes: GraphNode[] = [];
  for (let i = 0; i <= 100; i++) nodes.push(node(`n${i}`, 't1', i));
  const model = createCanvasModel(fakeLive(graph(nodes)), fakeLayout().client);
  model.showFullTurn('t1');
  expect(model.getSnapshot().view.nodes.size).toBe(101);
  model.setMode('outline');
  expect([...model.getSnapshot().view.nodes.keys()]).toEqual(['turn:t1']);
  model.setMode('live');
  expect(model.getSnapshot().view.nodes.size).toBe(101);
  model.dispose();
});

test('在复盘里停止跟随，切回逐步视图后仍然会合并', () => {
  const nodes = [node('p', 't1', 0), readCall('a', 2), readCall('b', 3), readCall('c', 4), node('x', 't1', 5)];
  const model = createCanvasModel(fakeLive(graph(nodes)), fakeLayout().client);
  model.setMode('replay');
  model.setReplayTime(EPOCH + 1); // only p exists at this time: no run
  model.setAutoFold(false);
  model.setMode('live');
  expect(shownIds(model)).toEqual(['p', 'run:a', 'x']);
  model.dispose();
});

test('停止跟随时展开过的合并节点：它的编号不会让之后形成的新合并节点绕过冻结', async () => {
  const failed = readCall('a', 1, { status: 'failed', parentId: 'p' });
  const first = [readCall('b', 2, { parentId: 'p' }), readCall('c', 3, { parentId: 'p' }), readCall('d', 4, { parentId: 'p' })];
  const later = [readCall('f', 5, { parentId: 'p' }), readCall('g', 6, { parentId: 'p' }), readCall('h', 7, { parentId: 'p' })];
  const build = (calls: GraphNode[]): Graph => {
    const all = [node('p', 't1', 0), failed, ...calls];
    return {
      nodes: Object.fromEntries(all.map((x) => [x.id, x])),
      edges: Object.fromEntries(all.slice(1).map((x) => [`p->${x.id}`, { id: `p->${x.id}`, sessionId: 's1', from: 'p', to: x.id, kind: 'fork' as const }])),
    };
  };
  const live = fakeLive(build(first));
  const model = createCanvasModel(live, fakeLayout().client);
  expect(shownIds(model)).toEqual(['a', 'p', 'run:a']); // anchored on the failed first call
  model.setAutoFold(false);
  model.expandRun('run:a');
  expect(shownIds(model)).toEqual(['a', 'b', 'c', 'd', 'p']);
  live.set(build([...first, ...later]));
  await vi.advanceTimersByTimeAsync(60);
  expect(shownIds(model)).toEqual(['a', 'b', 'c', 'd', 'f', 'g', 'h', 'p']); // no new run under the reader
  model.dispose();
});
