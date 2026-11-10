import chokidar from 'chokidar';
import type { Config } from '../../config.js';
import type { Pipeline } from '../../pipeline.js';

/**
 * Watches projectsDir with chokidar and, independently, rescans every `rescanMs` so that missed
 * file-system events (common on Windows and network drives) are still picked up.
 */
export function startWatcher(pipeline: Pipeline, config: Config): { ready: Promise<void>; close(): Promise<void> } {
  let closed = false;
  const swallow = (): void => {};
  const watcher = chokidar.watch(config.projectsDir, { ignoreInitial: true, depth: 3 });
  const onFile = (file: string): void => {
    if (!closed) void pipeline.ingestFile(file).catch(swallow);
  };
  watcher.on('add', onFile).on('change', onFile).on('error', swallow);

  let rescanning: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (rescanning || closed) return;
    rescanning = pipeline
      .rescan()
      .catch(swallow)
      .finally(() => {
        rescanning = null;
      });
  }, config.rescanMs);

  const watcherReady = new Promise<void>((resolve) => {
    watcher.once('ready', () => resolve());
  });
  const ready = Promise.all([watcherReady, pipeline.scanAll()]).then(() => undefined);

  return {
    ready,
    async close() {
      closed = true;
      clearInterval(timer);
      await ready.catch(swallow);
      await rescanning;
      await watcher.close();
    },
  };
}
