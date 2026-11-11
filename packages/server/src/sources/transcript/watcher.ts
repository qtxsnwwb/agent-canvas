import chokidar from 'chokidar';
import type { Config } from '../../config.js';
import type { Pipeline } from '../../pipeline.js';

/**
 * Watches the root directory of each of the pipeline's file sources with chokidar (one watcher per source, at the
 * source's depth) and, independently, rescans hot files every `rescanMs` and lists every source's files every
 * `fullScanMs`, so that missed file-system events (common on Windows and network drives) are still picked up.
 */
export function startWatcher(pipeline: Pipeline, config: Config): { ready: Promise<void>; close(): Promise<void> } {
  let closed = false;
  const swallow = (): void => {};
  const onFile = (file: string): void => {
    if (!closed) void pipeline.ingestFile(file).catch(swallow);
  };
  const watchers = pipeline.fileSources().map((source) =>
    chokidar.watch(source.rootDir, { ignoreInitial: true, depth: source.watchDepth }).on('add', onFile).on('change', onFile).on('error', swallow),
  );

  // Two cadences on one timer, never overlapping: the hot-set rescan every rescanMs, and a full scan (directory
  // listing: missed files, deletions) once fullScanMs has passed since the last one.
  let rescanning: Promise<void> | null = null;
  let lastFull = Date.now();
  const timer = setInterval(() => {
    if (rescanning || closed) return;
    const full = Date.now() - lastFull >= config.fullScanMs;
    if (full) lastFull = Date.now();
    rescanning = (full ? pipeline.scanAll() : pipeline.rescan()).catch(swallow).finally(() => {
      rescanning = null;
    });
  }, config.rescanMs);

  const watchersReady = watchers.map(
    (w) =>
      new Promise<void>((resolve) => {
        w.once('ready', () => resolve());
      }),
  );
  const ready = Promise.all([...watchersReady, pipeline.scanAll()]).then(() => undefined);

  return {
    ready,
    async close() {
      closed = true;
      clearInterval(timer);
      await ready.catch(swallow);
      await rescanning;
      await Promise.all(watchers.map((w) => w.close()));
    },
  };
}
