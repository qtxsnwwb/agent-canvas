import { expect, test } from 'vitest';
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
const input = (key: string, ids: string[] = ['a']): TurnLayoutInput => ({ key, nodes: ids.map((id) => ({ id, width: 10, height: 10 })), edges: [] });
const result = (key: string, w = 10): TurnLayout => ({ key, width: w, height: 10, positions: { a: { x: 0, y: 0 } } });

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
