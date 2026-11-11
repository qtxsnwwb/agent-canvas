import { afterEach, expect, test, vi } from 'vitest';
import { createThrottle } from '../src/throttle';

afterEach(() => {
  vi.useRealTimers();
});

test('持续事件下每 500ms 最多触发一次，且首次在 2 秒内触发', async () => {
  vi.useFakeTimers();
  const fired: number[] = [];
  const t0 = Date.now();
  const th = createThrottle(() => fired.push(Date.now() - t0), 500);
  for (let i = 0; i < 40; i++) {
    th.trigger();
    await vi.advanceTimersByTimeAsync(100); // an event every 100 ms for 4 s: a pure debounce would never fire
  }
  await vi.advanceTimersByTimeAsync(1000);
  expect(fired.length).toBeGreaterThanOrEqual(7);
  expect(fired[0]).toBeLessThanOrEqual(2000);
  for (let i = 1; i < fired.length; i++) expect(fired[i]! - fired[i - 1]!).toBeGreaterThanOrEqual(500);
  // the last event is never lost: a call follows it
  expect(fired.at(-1)!).toBeGreaterThanOrEqual(3900);
});

test('单个事件只触发一次；cancel 后不再触发', async () => {
  vi.useFakeTimers();
  const fn = vi.fn();
  const th = createThrottle(fn, 500);
  th.trigger();
  th.trigger();
  await vi.advanceTimersByTimeAsync(600);
  expect(fn).toHaveBeenCalledTimes(1);
  th.trigger();
  th.cancel();
  await vi.advanceTimersByTimeAsync(2000);
  expect(fn).toHaveBeenCalledTimes(1);
});
