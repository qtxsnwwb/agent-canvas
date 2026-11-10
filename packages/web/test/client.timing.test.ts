import { expect, test, vi } from 'vitest';
import { openLiveSession } from '../src/client';
import { fakeSocket, mkNode, snapshot } from './helpers';

// Timing-sensitive: runs in the serial "timing" Vitest project (see vitest.config.ts).

test('a large snapshot is built in linear time', async () => {
  const nodes = Array.from({ length: 50_000 }, (_, i) => mkNode(`n${i}`));
  const t0 = performance.now();
  const live = await openLiveSession('s1', { fetchGraph: async () => snapshot({ seq: 1, nodes }), createSocket: () => fakeSocket() });
  expect(performance.now() - t0).toBeLessThan(1000);
  expect(Object.keys(live.getGraph().nodes)).toHaveLength(50_000);
  live.close();
});

test('a large changes message is applied in one pass and notifies once', async () => {
  const sock = fakeSocket();
  const live = await openLiveSession('s1', { fetchGraph: async () => snapshot({ seq: 1 }), createSocket: () => sock });
  const fn = vi.fn();
  live.subscribe(fn);
  const changes = Array.from({ length: 20_000 }, (_, i) => ({ seq: i + 2, type: 'node_added', node: mkNode(`n${i}`), detail: {} }));
  const t0 = performance.now();
  sock.receive({ type: 'changes', changes });
  expect(performance.now() - t0).toBeLessThan(1000);
  expect(Object.keys(live.getGraph().nodes)).toHaveLength(20_000);
  expect(fn).toHaveBeenCalledTimes(1);
  live.close();
});
