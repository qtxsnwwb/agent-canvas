// Child process: VACUUM of a database file on its own connection (see migrate-storage.ts vacuumInChild), then a
// truncating checkpoint so the file shrinks and the WAL (which VACUUM filled) is emptied. A separate process, not a
// thread, so the parent can enforce a hard deadline by killing it: SQLite rolls an unfinished VACUUM back.
// argv: <dbPath> <checkpoint busy timeout ms> <checkpoint attempts> <ms between attempts>. Answers once over IPC:
// { ok: true, pagesBefore, freelistBefore, pagesAfter, checkpoint: { busy, log, checkpointed } } or { ok: false, error }.
// Kept free of non-erasable TypeScript syntax so Node can run the .ts source directly (tests).
import Database from 'better-sqlite3';

const [dbPath, busyArg, attemptsArg, delayArg] = process.argv.slice(2);
const busyMs = Number(busyArg ?? '1000');
const attempts = Math.max(1, Number(attemptsArg ?? '5'));
const delayMs = Math.max(0, Number(delayArg ?? '500'));
/** Blocks this process (it has nothing else to do) between two checkpoint attempts. */
const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

type Checkpoint = { busy: number; log: number; checkpointed: number };

function send(message: unknown): void {
  if (process.send) process.send(message, () => process.exit(0));
  else process.exit(0);
}

try {
  const db = new Database(dbPath ?? '', { timeout: 5000 });
  try {
    db.pragma('journal_size_limit = 67108864');
    const pagesBefore = db.pragma('page_count', { simple: true }) as number;
    const freelistBefore = db.pragma('freelist_count', { simple: true }) as number;
    db.exec('VACUUM');
    db.pragma(`busy_timeout = ${Math.max(0, Math.floor(busyMs))}`);
    let checkpoint: Checkpoint | null = null;
    // Busy at once when another checkpoint runs (the busy handler is not used for that), so wait between attempts.
    for (let i = 0; i < attempts; i++) {
      if (i > 0) pause(delayMs);
      checkpoint = (db.pragma('wal_checkpoint(TRUNCATE)') as Checkpoint[])[0] ?? null;
      if (checkpoint !== null && checkpoint.busy === 0) break;
    }
    const pagesAfter = db.pragma('page_count', { simple: true }) as number;
    send({ ok: true, pagesBefore, freelistBefore, pagesAfter, checkpoint });
  } finally {
    db.close();
  }
} catch (err) {
  send({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
