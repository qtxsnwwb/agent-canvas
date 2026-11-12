// Worker thread: checkpoints the WAL of a database file on its own connection.
// The main connection runs with wal_autocheckpoint = 0, so a checkpoint (copying the WAL into the database file and
// syncing it) never stalls the main thread's event loop. PASSIVE checkpoints do not block readers or writers.
// A `{ type: 'now', id }` message runs one at once and answers `{ type: 'checkpointed', id, busy, log, checkpointed }`
// (log = frames in the WAL, checkpointed = frames copied; equal means the next write restarts the WAL from its start).
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

const timer = setInterval(checkpoint, intervalMs);

parentPort?.on('message', (message: unknown) => {
  if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'now') {
    const r = checkpoint();
    parentPort?.postMessage({ type: 'checkpointed', id: (message as { id?: unknown }).id, ...(r ?? { busy: 1, log: -1, checkpointed: -1 }) });
    return;
  }
  if (message !== 'close') return;
  clearInterval(timer);
  checkpoint();
  db.close();
  parentPort?.close();
});
