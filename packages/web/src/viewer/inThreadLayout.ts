import ELK from 'elkjs/lib/elk.bundled.js';
import { layoutTurn, singleNodeLayout, turnSignature, type TurnLayout } from '../canvas/layout';
import type { LayoutClient } from '../canvas/layoutClient';

/** Results kept per key+signature (a long session's groups; an exported file never changes, so nothing goes stale). */
const CACHE_LIMIT = 2_000;

/**
 * The exported file's layout client: elkjs's bundled build run on the page's own thread. The app runs it in a worker
 * loaded from its own file (layoutClient.ts), which an exported file cannot do: it is one file, and its content security
 * policy allows no worker. A large session is laid out more slowly here (the page waits while a turn is laid out).
 */
export function createInThreadLayoutClient(): LayoutClient {
  const elk = new ELK();
  const cache = new Map<string, Promise<TurnLayout>>();
  let disposed = false;
  return {
    layout(input) {
      if (disposed) return Promise.reject(new Error('layout client disposed'));
      const single = singleNodeLayout(input);
      if (single) return Promise.resolve(single);
      const key = `${input.key}\u0000${turnSignature(input)}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const running = layoutTurn(elk, input);
      cache.set(key, running);
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
      running.catch(() => { if (cache.get(key) === running) cache.delete(key); });
      return running;
    },
    dispose() {
      disposed = true;
      cache.clear();
    },
  };
}
