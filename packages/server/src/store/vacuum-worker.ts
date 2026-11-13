// Worker thread: VACUUM of a database file on its own connection (see migrate-storage.ts), then a truncating
// checkpoint so the file shrinks and the WAL (which VACUUM filled) is emptied. The service's main connection keeps
// reading meanwhile; its writes are held by the caller. Answers once: `{ ok: true, checkpoint }` or `{ ok: false, error }`.
// Kept free of non-erasable TypeScript syntax so Node can run the .ts source directly (tests).
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

const { dbPath } = workerData as { dbPath: string };

/** Truncating checkpoint, retried while a reader of the main connection keeps it from completing. */
function checkpoint(db: Database.Database): { busy: number; log: number; checkpointed: number } | null {
  let last: { busy: number; log: number; checkpointed: number } | null = null;
  for (let attempt = 0; attempt < 50; attempt++) {
    last = (db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number; log: number; checkpointed: number }[])[0] ?? null;
    if (last !== null && last.busy === 0) return last;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  return last;
}

let message: { ok: boolean; error?: string; checkpoint?: unknown };
try {
  const db = new Database(dbPath, { timeout: 10_000 });
  try {
    db.exec('VACUUM');
    message = { ok: true, checkpoint: checkpoint(db) };
  } finally {
    db.close();
  }
} catch (err) {
  message = { ok: false, error: err instanceof Error ? err.message : String(err) };
}
parentPort?.postMessage(message);
