// Worker thread: checkpoints the WAL of a database file on its own connection.
// The main connection runs with wal_autocheckpoint = 0, so a checkpoint (copying the WAL into the database file and
// syncing it) never stalls the main thread's event loop. PASSIVE checkpoints do not block readers or writers.
// Kept free of non-erasable TypeScript syntax so Node can run the .ts source directly (tests).
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

const { dbPath, intervalMs } = workerData as { dbPath: string; intervalMs: number };
const db = new Database(dbPath);

const checkpoint = (): void => {
  try {
    db.pragma('wal_checkpoint(PASSIVE)');
  } catch {
    // busy or closing: the next tick retries
  }
};

const timer = setInterval(checkpoint, intervalMs);

parentPort?.on('message', (message: unknown) => {
  if (message !== 'close') return;
  clearInterval(timer);
  checkpoint();
  db.close();
  parentPort?.close();
});
