import { expect, test, vi } from 'vitest';
import { createLayoutClient, type WorkerLike } from '../src/canvas/layoutClient';
import type { TurnLayout, TurnLayoutInput } from '../src/canvas/layout';

class FakeWorker implements WorkerLike {
  sent: { id: number; input: TurnLayoutInput }[] = [];
  terminated = false;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  postMessage(msg: unknown): void { this.sent.push(msg as { id: number; input: TurnLayoutInput }); }
  terminate(): void { this.terminated = true; }
  reply(i: number, layout: TurnLayout): void { this.onmessage?.({ data: { id: this.sent[i]!.id, layout } }); }
  fail(i: number, error: string): void { this.onmessage?.({ data: { id: this.sent[i]!.id, error } }); }
}
/** Two nodes by default: single-node inputs are answered without the worker. */
const input = (key: string, ids: string[] = ['a', 'b']): TurnLayoutInput => ({ key, nodes: ids.map((id) => ({ id, width: 10, height: 10 })), edges: [] });
const result = (key: string, w = 10): TurnLayout => ({ key, width: w, height: 10, anchorX: 5, positions: { a: { x: 0, y: 0 } } });

test('相同签名的请求只计算一次，之后走缓存', async () => {
  const w = new FakeWorker();
  const c = createLayoutClient(() => w);
  const p1 = c.layout(input('t'));
  const p2 = c.layout(input('t'));
  expect(w.sent.length).toBe(1);
  w.reply(0, result('t'));
  const [r1, r2] = await Promise.all([p1, p2]);
  expect(r1).toBe(r2);
  expect(r1).toEqual(result('t'));
  expect(await c.layout(input('t'))).toBe(r1);
  expect(w.sent.length).toBe(1);
});

test('应答乱序到达时，各请求拿到各自的结果', async () => {
  const w = new FakeWorker();
  const c = createLayoutClient(() => w);
  const pa = c.layout(input('A'));
  const pb = c.layout(input('B'));
  expect(w.sent.length).toBe(2);
  w.reply(1, result('B', 22));
  w.reply(0, result('A', 11));
  expect((await pa).width).toBe(11);
  expect((await pb).width).toBe(22);
});

test('Worker 报错：进行中的请求 reject，下一次请求新建 Worker 并成功', async () => {
  const workers: FakeWorker[] = [];
  const c = createLayoutClient(() => { const w = new FakeWorker(); workers.push(w); return w; });
  const p = c.layout(input('t'));
  const rejected = expect(p).rejects.toBeDefined();
  workers[0]!.onerror?.({ message: 'boom' });
  await rejected;
  expect(workers[0]!.terminated).toBe(true);
  const p2 = c.layout(input('t'));
  expect(workers.length).toBe(2);
  workers[1]!.reply(0, result('t'));
  expect(await p2).toEqual(result('t'));
});

test('应答带 error 字段时该请求 reject，且不写入缓存', async () => {
  const w = new FakeWorker();
  const c = createLayoutClient(() => w);
  const p = c.layout(input('t'));
  const rejected = expect(p).rejects.toThrow('bad');
  w.fail(0, 'bad');
  await rejected;
  const p2 = c.layout(input('t'));
  expect(w.sent.length).toBe(2);
  w.reply(1, result('t'));
  expect(await p2).toEqual(result('t'));
});

test('dispose 后终止 Worker，未完成的请求 reject', async () => {
  const w = new FakeWorker();
  const c = createLayoutClient(() => w);
  const p = c.layout(input('t'));
  const rejected = expect(p).rejects.toBeDefined();
  c.dispose();
  await rejected;
  expect(w.terminated).toBe(true);
});

/** Throws from postMessage the first `times` times (e.g. a DataCloneError), then behaves normally. */
class ThrowingWorker extends FakeWorker {
  constructor(private times: number) { super(); }
  override postMessage(msg: unknown): void {
    if (this.times > 0) {
      this.times--;
      throw new Error('cannot post');
    }
    super.postMessage(msg);
  }
}

test('postMessage 同步抛错：只 reject 这一个请求，不算 Worker 故障，inflight 里不留被拒绝的 promise', async () => {
  const workers: ThrowingWorker[] = [];
  const c = createLayoutClient(() => { const w = new ThrowingWorker(4); workers.push(w); return w; });
  const ok = c.layout(input('other'));
  expect(workers[0]!.sent).toHaveLength(0); // the first post threw: this request rejects ...
  await expect(ok).rejects.toThrow('cannot post');
  const pa = c.layout(input('A'));
  const pb = c.layout(input('A')); // same request right after a failure: not the rejected promise
  await expect(pa).rejects.toThrow('cannot post');
  await expect(pb).rejects.toThrow('cannot post');
  await expect(c.layout(input('B'))).rejects.toThrow('cannot post');
  // Four throws, yet the worker was kept and no cool-down started.
  expect(workers).toHaveLength(1);
  expect(workers[0]!.terminated).toBe(false);
  const p = c.layout(input('A'));
  workers[0]!.reply(0, result('A'));
  expect(await p).toEqual(result('A'));
});

test('单个请求 20 秒超时：所有挂起请求 reject，Worker 被丢弃', async () => {
  vi.useFakeTimers();
  try {
    const workers: FakeWorker[] = [];
    const c = createLayoutClient(() => { const w = new FakeWorker(); workers.push(w); return w; });
    const pa = c.layout(input('A'));
    const pb = c.layout(input('B'));
    const ra = expect(pa).rejects.toThrow(/timed out/);
    const rb = expect(pb).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(workers[0]!.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await ra;
    await rb;
    expect(workers[0]!.terminated).toBe(true);
    const p = c.layout(input('A'));
    expect(workers).toHaveLength(2);
    workers[1]!.reply(0, result('A'));
    expect(await p).toEqual(result('A'));
  } finally {
    vi.useRealTimers();
  }
});

test('连续 3 次 Worker 失败后等待 2 秒才新建 Worker；期间的请求立即 reject', async () => {
  vi.useFakeTimers();
  try {
    const workers: FakeWorker[] = [];
    const c = createLayoutClient(() => { const w = new FakeWorker(); workers.push(w); return w; });
    for (let i = 0; i < 3; i++) {
      const p = c.layout(input('t'));
      const rejected = expect(p).rejects.toBeDefined();
      workers[i]!.onerror?.({ message: 'boom' });
      await rejected;
    }
    expect(workers).toHaveLength(3);
    await expect(c.layout(input('t'))).rejects.toThrow(/2 s/);
    expect(workers).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1_999);
    await expect(c.layout(input('t'))).rejects.toThrow(/2 s/);
    await vi.advanceTimersByTimeAsync(1);
    const p = c.layout(input('t'));
    expect(workers).toHaveLength(4);
    workers[3]!.reply(0, result('t'));
    expect(await p).toEqual(result('t'));
  } finally {
    vi.useRealTimers();
  }
});

test('一次成功的应答清零连续失败计数', async () => {
  const workers: FakeWorker[] = [];
  const c = createLayoutClient(() => { const w = new FakeWorker(); workers.push(w); return w; });
  const fail = async (key: string) => {
    const p = c.layout(input(key));
    const rejected = expect(p).rejects.toBeDefined();
    workers[workers.length - 1]!.onerror?.({ message: 'boom' });
    await rejected;
  };
  await fail('f1');
  await fail('f2');
  const ok = c.layout(input('ok'));
  workers[2]!.reply(0, result('ok'));
  await ok;
  await fail('f3');
  await fail('f4');
  const p = c.layout(input('next')); // only 2 failures since the success: a new worker right away
  expect(workers).toHaveLength(5);
  workers[4]!.reply(0, result('next'));
  await p;
});

test('单节点输入在本地直接应答：不建 Worker，也不进缓存', async () => {
  const workers: FakeWorker[] = [];
  const c = createLayoutClient(() => { const w = new FakeWorker(); workers.push(w); return w; });
  const one: TurnLayoutInput = { key: 't', nodes: [{ id: 'x', width: 340, height: 60 }], edges: [] };
  expect(await c.layout(one)).toEqual({ key: 't', width: 340, height: 60, anchorX: 170, positions: { x: { x: 0, y: 0 } } });
  expect(workers).toHaveLength(0);
});

test('400 个不同的多节点输入各请求两次：第二次全部命中缓存', async () => {
  const w = new FakeWorker();
  const c = createLayoutClient(() => w);
  const keys = Array.from({ length: 400 }, (_, i) => `t${i}`);
  const first = keys.map((k) => c.layout(input(k)));
  expect(w.sent).toHaveLength(400);
  w.sent.forEach((m, i) => w.reply(i, result(m.input.key)));
  await Promise.all(first);
  const second = await Promise.all(keys.map((k) => c.layout(input(k))));
  expect(w.sent).toHaveLength(400);
  expect(second.map((l) => l.key)).toEqual(keys);
});
