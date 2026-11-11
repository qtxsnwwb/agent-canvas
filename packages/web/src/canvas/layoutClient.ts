import { singleNodeLayout, turnSignature, type TurnLayout, type TurnLayoutInput } from './layout';

export interface WorkerLike {
  postMessage(msg: unknown): void;
  terminate(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export interface LayoutClient { layout(input: TurnLayoutInput): Promise<TurnLayout>; dispose(): void }

/** Large enough for every group of a long session (a fixed limit; simpler than one sized by the request count). */
export const CACHE_LIMIT = 2_000;
/** A request with no reply after this long counts as a hung worker. */
export const LAYOUT_TIMEOUT_MS = 20_000;
/** After this many worker failures in a row (no successful reply in between), wait before starting a new worker. */
export const MAX_CONSECUTIVE_FAILURES = 3;
export const WORKER_RETRY_MS = 2_000;

/** Same-origin module worker emitted by Vite as its own file (CSP forbids blob:/inline workers). */
export function createBrowserLayoutWorker(): WorkerLike {
  return new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}

interface Pending { cacheKey: string; timer: ReturnType<typeof setTimeout>; resolve(l: TurnLayout): void; reject(e: Error): void }

/**
 * Results cached by key+signature (LRU, max CACHE_LIMIT); concurrent equal requests share one computation. A single-node
 * input is answered at once without the worker or the cache (it needs no layout). A worker that
 * errors, cannot be created or does not answer within 20 s is dropped and every pending request rejects; after 3
 * such failures in a row the client waits 2 s before starting a new worker, rejecting requests meanwhile.
 */
export function createLayoutClient(createWorker: () => WorkerLike): LayoutClient {
  const cache = new Map<string, TurnLayout>();
  const inflight = new Map<string, Promise<TurnLayout>>();
  const pending = new Map<number, Pending>();
  let worker: WorkerLike | null = null;
  let nextId = 1;
  let disposed = false;
  let failures = 0;
  let coolingDown: ReturnType<typeof setTimeout> | null = null;

  function failAll(err: Error): void {
    const all = [...pending.values()];
    pending.clear();
    inflight.clear();
    for (const p of all) {
      clearTimeout(p.timer);
      p.reject(err);
    }
  }
  function dropWorker(err: Error): void {
    const w = worker;
    worker = null;
    if (w) {
      w.onmessage = null;
      w.onerror = null;
      try { w.terminate(); } catch { /* already gone */ }
    }
    failAll(err);
  }
  /** Drops the worker after a failure and starts the cool-down once failures pile up. */
  function workerFailed(err: Error): void {
    dropWorker(err);
    failures++;
    if (failures >= MAX_CONSECUTIVE_FAILURES && coolingDown === null && !disposed) {
      coolingDown = setTimeout(() => { coolingDown = null; }, WORKER_RETRY_MS);
    }
  }
  function ensureWorker(): WorkerLike {
    if (worker) return worker;
    const w = createWorker();
    w.onmessage = (ev) => {
      const data = ev.data as { id: number; layout?: TurnLayout; error?: string };
      const p = pending.get(data.id);
      if (!p) return;
      failures = 0; // the worker is alive and answering
      clearTimeout(p.timer);
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
      workerFailed(new Error(`layout worker failed${msg ? `: ${msg}` : ''}`));
    };
    worker = w;
    return w;
  }

  return {
    layout(input) {
      if (disposed) return Promise.reject(new Error('layout client disposed'));
      const single = singleNodeLayout(input);
      if (single) return Promise.resolve(single);
      const cacheKey = `${input.key}\u0000${turnSignature(input)}`;
      const hit = cache.get(cacheKey);
      if (hit) {
        cache.delete(cacheKey); // refresh recency
        cache.set(cacheKey, hit);
        return Promise.resolve(hit);
      }
      const running = inflight.get(cacheKey);
      if (running) return running;
      if (worker === null && coolingDown !== null) {
        return Promise.reject(new Error(
          `layout worker failed ${failures} times in a row; a new one starts in ${WORKER_RETRY_MS / 1000} s`,
        ));
      }
      let failedSync = false;
      const promise = new Promise<TurnLayout>((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(
          () => workerFailed(new Error(`layout worker timed out after ${LAYOUT_TIMEOUT_MS / 1000} s`)),
          LAYOUT_TIMEOUT_MS,
        );
        pending.set(id, { cacheKey, timer, resolve, reject });
        const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));
        let w: WorkerLike;
        try {
          w = ensureWorker();
        } catch (err) {
          failedSync = true;
          // No worker could be created: a worker failure; it rejects this request (still pending) with the rest.
          workerFailed(toError(err));
          return;
        }
        try {
          w.postMessage({ id, input });
        } catch (err) {
          // The message could not be sent (e.g. it is not cloneable): only this request fails, the worker is fine.
          failedSync = true;
          clearTimeout(timer);
          pending.delete(id);
          reject(toError(err));
        }
      });
      if (failedSync) return promise; // already rejected: never shared through `inflight`
      inflight.set(cacheKey, promise);
      promise.catch(() => { if (inflight.get(cacheKey) === promise) inflight.delete(cacheKey); });
      return promise;
    },
    dispose() {
      disposed = true;
      if (coolingDown !== null) clearTimeout(coolingDown);
      coolingDown = null;
      dropWorker(new Error('layout client disposed'));
    },
  };
}
