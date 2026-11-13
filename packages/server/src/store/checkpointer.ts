// Worker thread: checkpoints the WAL of a database file on its own connection.
// The main connection runs with wal_autocheckpoint = 0, so a checkpoint (copying the WAL into the database file and
// syncing it) never stalls the main thread's event loop. PASSIVE checkpoints do not block readers or writers.
// A `{ type: 'now', id }` message runs one at once and answers `{ type: 'checkpointed', id, busy, log, checkpointed }`
// (log = frames in the WAL, checkpointed = frames copied; equal means the next write restarts the WAL from its start).
// `{ type: 'pause', id }` stops the periodic checkpoints and answers `{ type: 'paused', id }` (no checkpoint of this
// thread runs from then on: messages are handled between checkpoints); `{ type: 'resume' }` starts them again. VACUUM
// pauses it: SQLite gives a truncating checkpoint SQLITE_BUSY at once, without waiting, while another one runs.
// Kept free of non-erasable TypeScript syntax so Node can run the .ts source directly (tests).
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

const { dbPath, intervalMs } = workerData as { dbPath: string; intervalMs: number };
const db = new Database(dbPath);

const checkpoint = (): { busy: number; log: number; checkpointed: number } | null => {
  try {
    const row = db.pragma('wal_checkpoint(PASSIVE)') as { busy: number; log: number; checkpointed: number }[];
    return row[0] ?? null;
  } catch {
    return null; // busy or closing: the next tick retries
  }
};

let timer: ReturnType<typeof setInterval> | null = setInterval(checkpoint, intervalMs);

parentPort?.on('message', (message: unknown) => {
  const type = typeof message === 'object' && message !== null ? (message as { type?: unknown }).type : undefined;
  if (type === 'pause') {
    if (timer !== null) clearInterval(timer);
    timer = null;
    parentPort?.postMessage({ type: 'paused', id: (message as { id?: unknown }).id });
    return;
  }
  if (type === 'resume') {
    timer ??= setInterval(checkpoint, intervalMs);
    return;
  }
  if (type === 'now') {
    const r = checkpoint();
    parentPort?.postMessage({ type: 'checkpointed', id: (message as { id?: unknown }).id, ...(r ?? { busy: 1, log: -1, checkpointed: -1 }) });
    return;
  }
  if (message !== 'close') return;
  if (timer !== null) clearInterval(timer);
  checkpoint();
  db.close();
  parentPort?.close();
});
