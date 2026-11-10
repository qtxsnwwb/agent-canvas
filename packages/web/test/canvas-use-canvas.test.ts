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
