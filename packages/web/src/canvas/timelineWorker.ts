import type { WorkerLike } from './layoutClient';

/**
 * The app's 时间线 worker: a same-origin module worker emitted by Vite as its own file (CSP forbids blob:/inline workers).
 * Only the live source imports this (liveSource.ts); the exported viewer must not (it allows no worker).
 */
export function createBrowserTimelineWorker(): WorkerLike {
  return new Worker(new URL('./timeline.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}
