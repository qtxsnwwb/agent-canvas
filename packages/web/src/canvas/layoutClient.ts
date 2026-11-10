import { turnSignature, type TurnLayout, type TurnLayoutInput } from './layout';

export interface WorkerLike {
  postMessage(msg: unknown): void;
  terminate(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export interface LayoutClient { layout(input: TurnLayoutInput): Promise<TurnLayout>; dispose(): void }

const CACHE_LIMIT = 300;

/** Same-origin module worker emitted by Vite as its own file (CSP forbids blob:/inline workers). */
export function createBrowserLayoutWorker(): WorkerLike {
  return new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}

interface Pending { cacheKey: string; resolve(l: TurnLayout): void; reject(e: Error): void }

/** Results cached by key+signature (LRU, max 300); concurrent equal requests share one computation. */
export function createLayoutClient(createWorker: () => WorkerLike): LayoutClient {
  const cache = new Map<string, TurnLayout>();
  const inflight = new Map<string, Promise<TurnLayout>>();
  const pending = new Map<number, Pending>();
  let worker: WorkerLike | null = null;
  let nextId = 1;
  let disposed = false;

  function failAll(err: Error): void {
    const all = [...pending.values()];
    pending.clear();
    inflight.clear();
    for (const p of all) p.reject(err);
  }
  function dropWorker(err: Error): void {
    const w = worker;
    worker = null;
    if (w) {
      w.onmessage = null;
      w.onerror = null;
      w.terminate();
    }
    failAll(err);
  }
  function ensureWorker(): WorkerLike {
    if (worker) return worker;
    const w = createWorker();
    w.onmessage = (ev) => {
      const data = ev.data as { id: number; layout?: TurnLayout; error?: string };
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      inflight.delete(p.cacheKey);
      if (data.error !== undefined || !data.layout) {
        p.reject(new Error(data.error ?? 'layout worker returned no layout'));
        return;
      }
      cache.set(p.cacheKey, data.layout);
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
      p.resolve(data.layout);
    };
    w.onerror = (ev) => {
      const msg = (ev as { message?: string } | null)?.message;
      dropWorker(new Error(`layout worker failed${msg ? `: ${msg}` : ''}`));
    };
    worker = w;
    return w;
  }

  return {
    layout(input) {
      if (disposed) return Promise.reject(new Error('layout client disposed'));
      const cacheKey = `${input.key}\u0000${turnSignature(input)}`;
      const hit = cache.get(cacheKey);
      if (hit) {
        cache.delete(cacheKey); // refresh recency
        cache.set(cacheKey, hit);
        return Promise.resolve(hit);
      }
      const running = inflight.get(cacheKey);
      if (running) return running;
      const promise = new Promise<TurnLayout>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { cacheKey, resolve, reject });
        try {
          ensureWorker().postMessage({ id, input });
        } catch (err) {
          pending.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      inflight.set(cacheKey, promise);
      promise.catch(() => { if (inflight.get(cacheKey) === promise) inflight.delete(cacheKey); });
      return promise;
    },
    dispose() {
      disposed = true;
      dropWorker(new Error('layout client disposed'));
    },
  };
}
