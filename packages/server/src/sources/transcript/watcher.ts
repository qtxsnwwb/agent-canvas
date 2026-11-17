import path from 'node:path';
import chokidar from 'chokidar';
import type { Config } from '../../config.js';
import type { Pipeline } from '../../pipeline.js';
import type { FileSource } from '../source.js';

/** The directories a source's watcher subscribes to: its watchRoots when it has them, else rootDir at watchDepth. */
export function watchRootsOf(source: FileSource): readonly { dir: string; depth: number }[] {
  return source.watchRoots ?? [{ dir: source.rootDir, depth: source.watchDepth }];
}

/**
 * Watches the root directory of each of the pipeline's file sources with chokidar (one watcher per source, at the
 * source's depth; one per entry of a source's watchRoots instead when it has them) and, independently, rescans hot files every `rescanMs` and lists every source's files every
 * `fullScanMs`, so that missed file-system events (common on Windows and network drives) are still picked up.
 */
export function startWatcher(pipeline: Pipeline, config: Config): { ready: Promise<void>; close(): Promise<void> } {
  let closed = false;
  const swallow = (): void => {};
  const onFile = (file: string): void => {
    if (!closed) void pipeline.ingestFile(file).catch(swallow);
  };
  const watchers = pipeline.fileSources().flatMap((source) => [
    ...watchRootsOf(source).map(({ dir, depth }) =>
      chokidar.watch(dir, { ignoreInitial: true, depth }).on('add', onFile).on('change', onFile).on('error', swallow),
    ),
    // Index files may live outside rootDir (Codex's session_index.jsonl): watch each one's directory, that file only.
    ...(source.indexFiles?.() ?? []).map((file) => {
      const target = path.resolve(file);
      const dir = path.dirname(target);
      return chokidar
        .watch(dir, { ignoreInitial: true, depth: 0, ignored: (p: string) => path.resolve(p) !== dir && path.resolve(p) !== target })
        .on('add', onFile)
        .on('change', onFile)
        .on('error', swallow);
    }),
  ]);

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
