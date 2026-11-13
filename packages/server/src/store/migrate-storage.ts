import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import type { Diagnostics } from '@agent-canvas/shared';
import type { Store } from './store.js';

/**
 * The one-time storage migration and the VACUUM after it.
 *
 * Migration: rows written before compression existed (enc 0) are rewritten through encodeBody, raw_event by ingest_id
 * range, then node_detail by rowid range. The ranges end at the highest key present when the migration began (rows
 * written later went through encodeBody already). Each batch is one write transaction that also records the position
 * reached in `meta`, so a process killed between batches continues from there and one killed during a batch redoes
 * that batch (it rolled back). A row is rewritten only when its compressed form decodes back to exactly the stored
 * text; a row that cannot be converted is left as it is and counted (`storage:failed`). Running it when done is a
 * no-op; a database created by this version is marked done when it is created.
 *
 * VACUUM: once, after the migration; only when there is room for it (vacuumSpaceProblem). It runs in a child process
 * (vacuumInChild) with the store's checkpointer paused; in the service, meanwhile, the
 * pipeline's writes are held (they queue and are applied afterwards) and meta writes are kept in memory; reads go on.
 * A skipped VACUUM is retried on later starts and by `agent-canvas compact` (which can skip the space check).
 */

/** `meta` keys of the storage migration. */
export const STORAGE_META = {
  /** 'done' once every row of both tables was visited (absent: pending). */
  migration: 'storage:migration',
  /** raw_event.ingest_id of the last row visited / the highest one when the migration began. */
  rawAfter: 'storage:raw_after',
  rawEnd: 'storage:raw_end',
  /** node_detail rowid of the last row visited / the highest one when the migration began. */
  detailAfter: 'storage:detail_after',
  detailEnd: 'storage:detail_end',
  /** Rows that could not be converted (left as they are). */
  failed: 'storage:failed',
  /** 'done' | 'skipped:<reason>' (absent: pending). */
  vacuum: 'storage:vacuum',
  /** When VACUUM last failed (error, timeout, checkpoint kept busy, no shrink); it is not retried for 24 h. */
  vacuumFailedAt: 'storage:vacuum_failed_at',
} as const;

/**
 * A batch stops at this many rows or this much text, whichever comes first. Measured (storage.bench.test.ts): a batch
 * of 8 MB stalled the event loop for about 335 ms (compress, verify, write); 1 MB keeps a batch's stall near 50 ms.
 */
export const MIGRATION_BATCH_ROWS = 2000;
export const MIGRATION_BATCH_BYTES = 1024 * 1024;
/**
 * Where SQLite's VACUUM writes, and so where free space is required (file = database file + WAL now):
 * - the temporary copy of the database (a file in SQLite's temp directory, sqliteTempDir(): this build has
 *   SQLITE_TEMP_STORE=1, i.e. temp files on disk) — up to `file`;
 * - the rewrite of the database from that copy, which in WAL mode goes through the WAL next to the database (the WAL
 *   grows to the new size, then the checkpoint copies it into the file and truncates both) — up to `file`.
 * Each needs VACUUM_SPACE_FACTOR × file free on its volume; when the temp directory is on the database's volume, that
 * volume needs both (2 × VACUUM_SPACE_FACTOR × file).
 */
export const VACUUM_SPACE_FACTOR = 1.2;

/**
 * The directory SQLite puts its temporary files in, as its OS layer picks it: Windows (GetTempPathW) TMP, TEMP,
 * USERPROFILE; elsewhere SQLITE_TMPDIR, TMPDIR, then /var/tmp, /usr/tmp, /tmp.
 */
export function sqliteTempDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const pick = (candidates: (string | undefined)[]): string | undefined => candidates.find((d) => d !== undefined && d !== '');
  if (platform === 'win32') return pick([env.TMP, env.TEMP, env.USERPROFILE]) ?? os.tmpdir();
  const fromEnv = pick([env.SQLITE_TMPDIR, env.TMPDIR]);
  if (fromEnv !== undefined) return fromEnv;
  for (const d of ['/var/tmp', '/usr/tmp', '/tmp']) {
    try {
      if (fs.statSync(d).isDirectory()) return d;
    } catch {
      // next
    }
  }
  return '.';
}

/** An id of the volume holding `dir` (its device number). */
export function volumeOf(dir: string): string {
  return String(fs.statSync(dir).dev);
}

/**
 * Null when VACUUM has room (see VACUUM_SPACE_FACTOR), else the reason it does not. Throws when a probe fails.
 */
export function vacuumSpaceProblem(
  dbDir: string,
  size: number,
  probe: { freeBytes: (dir: string) => number; tempDir: string; volumeOf: (dir: string) => string },
): string | null {
  const need = Math.ceil(size * VACUUM_SPACE_FACTOR);
  const dbFree = probe.freeBytes(dbDir);
  if (probe.volumeOf(dbDir) === probe.volumeOf(probe.tempDir)) {
    if (dbFree < 2 * need) {
      return `low-space: temporary copy and database on the same volume (temp directory ${probe.tempDir}): needs ${MB(2 * need)} free, ${MB(dbFree)} available`;
    }
    return null;
  }
  const tempFree = probe.freeBytes(probe.tempDir);
  if (tempFree < need) return `low-space: temporary copy (temp directory ${probe.tempDir}) needs ${MB(need)} free, ${MB(tempFree)} available`;
  if (dbFree < need) return `low-space: database volume needs ${MB(need)} free, ${MB(dbFree)} available`;
  return null;
}
/** VACUUM + checkpoint must answer within this; the child process is killed otherwise (writes are held meanwhile). */
export const VACUUM_DEADLINE_MS = 120_000;
/** The truncating checkpoint after VACUUM: busy timeout per attempt and attempts (a reader's snapshot blocks it). */
export const VACUUM_CHECKPOINT_BUSY_MS = 1000; // a reader holding a snapshot: up to 10 x (1 s + 0.5 s)
export const VACUUM_CHECKPOINT_ATTEMPTS = 10;
/** Wait between two checkpoint attempts: a checkpoint already running makes one fail at once, not after the timeout. */
export const VACUUM_CHECKPOINT_DELAY_MS = 500;
/** A failed VACUUM is not tried again (by the service or a plain `compact`) for this long; `compact --force` does. */
export const VACUUM_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
/** How long the service waits for the pipeline to stop importing before postponing VACUUM to the next start. */
export const VACUUM_QUIESCE_TIMEOUT_MS = 30_000;
/** The background job checks `startupDone` / `importing` this often, and starts anyway after STORAGE_MAX_WAIT_MS. */
export const STORAGE_POLL_MS = 1000;
export const STORAGE_MAX_WAIT_MS = 120_000;

export type BodyTable = 'raw_event' | 'node_detail';
export interface ConvertResult {
  /** Key of the last row visited (the range's end when `done`). */
  last: number;
  converted: number;
  failed: number;
  /** No enc-0 row is left in (after, end]. */
  done: boolean;
}

export interface MigrationOptions {
  batchRows?: number;
  batchBytes?: number;
  /** Tests: called inside each batch's transaction, before its progress is recorded; a throw rolls the batch back. */
  onBatch?: () => void;
}

/** What the background job needs from the pipeline. */
export interface StorageHost {
  startupDone(): boolean;
  importing(): boolean;
  /** Holds every pipeline write until the returned function is called (Pipeline.holdWrites). */
  holdWrites(): () => void;
}

export type StorageDiagnostics = NonNullable<Diagnostics['storage']>;

const num = (store: Store, key: string): number => Number(store.getMeta(key) ?? 0) || 0;

/**
 * One batch of the migration in one transaction (starting it on first use: the range ends are recorded). Returns
 * whether rows are left; never starts when the migration is done.
 */
export function migrateBatch(store: Store, options: MigrationOptions = {}): { more: boolean; converted: number; failed: number } {
  if (store.getMeta(STORAGE_META.migration) === 'done') return { more: false, converted: 0, failed: 0 };
  const rows = Math.max(1, options.batchRows ?? MIGRATION_BATCH_ROWS);
  const bytes = Math.max(1, options.batchBytes ?? MIGRATION_BATCH_BYTES);
  return store.transaction(() => {
    if (store.getMeta(STORAGE_META.rawEnd) === null) {
      const range = store.bodyKeyRange();
      store.setMeta(STORAGE_META.rawEnd, String(range.raw));
      store.setMeta(STORAGE_META.detailEnd, String(range.detail));
      store.setMeta(STORAGE_META.rawAfter, '0');
      store.setMeta(STORAGE_META.detailAfter, '0');
    }
    const rawAfter = num(store, STORAGE_META.rawAfter);
    const rawEnd = num(store, STORAGE_META.rawEnd);
    const detailAfter = num(store, STORAGE_META.detailAfter);
    const detailEnd = num(store, STORAGE_META.detailEnd);
    let r: ConvertResult;
    let more: boolean;
    if (rawAfter < rawEnd) {
      r = store.convertBodies('raw_event', rawAfter, rawEnd, rows, bytes);
      options.onBatch?.();
      store.setMeta(STORAGE_META.rawAfter, String(r.last));
      more = true; // the detail range follows (it may be empty: the next batch finds that out)
    } else if (detailAfter < detailEnd) {
      r = store.convertBodies('node_detail', detailAfter, detailEnd, rows, bytes);
      options.onBatch?.();
      store.setMeta(STORAGE_META.detailAfter, String(r.last));
      more = !r.done;
    } else {
      r = { last: 0, converted: 0, failed: 0, done: true };
      more = false;
    }
    if (r.failed > 0) store.setMeta(STORAGE_META.failed, String(num(store, STORAGE_META.failed) + r.failed));
    if (!more) store.setMeta(STORAGE_META.migration, 'done');
    return { more, converted: r.converted, failed: r.failed };
  });
}

/** The whole remaining migration, synchronously (`agent-canvas compact`). */
export function migrateAll(
  store: Store,
  options: MigrationOptions & { progress?: (migrated: number, total: number) => void } = {},
): { converted: number; failed: number } {
  let converted = 0;
  let failed = 0;
  for (;;) {
    const r = migrateBatch(store, options);
    store.checkpointIfLarge(); // keeps the WAL bounded (no event loop to wait on here)
    converted += r.converted;
    failed += r.failed;
    if (options.progress !== undefined) {
      const { migrated, total } = progressOf(store);
      options.progress(migrated, total);
    }
    if (!r.more) return { converted, failed };
  }
}

/** Rows (by key position) visited so far and in all; before the migration began, 0 of the current key range. */
function progressOf(store: Store): { migrated: number; total: number } {
  if (store.getMeta(STORAGE_META.rawEnd) === null) {
    if (store.getMeta(STORAGE_META.migration) === 'done') return { migrated: 0, total: 0 };
    const range = store.bodyKeyRange();
    return { migrated: 0, total: range.raw + range.detail };
  }
  const total = num(store, STORAGE_META.rawEnd) + num(store, STORAGE_META.detailEnd);
  if (store.getMeta(STORAGE_META.migration) === 'done') return { migrated: total, total };
  return { migrated: Math.min(total, num(store, STORAGE_META.rawAfter) + num(store, STORAGE_META.detailAfter)), total };
}

/** Free bytes on the volume holding `dir` (fs.statfsSync); throws when they cannot be told. */
export function freeBytesOf(dir: string): number {
  if (typeof fs.statfsSync !== 'function') throw new Error('fs.statfsSync is not available');
  const s = fs.statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

export interface VacuumOptions {
  /** Skip the free-space check (`compact --force`). */
  skipSpaceCheck?: boolean;
  /** Run even when it is recorded as done (`compact`). */
  evenIfDone?: boolean;
  /** Free bytes on the volume of a directory (default freeBytesOf). */
  freeBytes?: (dir: string) => number;
  /** SQLite's temp directory (default sqliteTempDir()) and the volume id of a directory (default volumeOf); tests. */
  tempDir?: string;
  volumeOf?: (dir: string) => string;
  /** In the service: the host's writes are held while VACUUM runs (in its child process). Absent: nothing is held (compact). */
  host?: StorageHost;
  quiesceTimeoutMs?: number;
  log?: (line: string) => void;
  /** Checked while waiting for the host to stop importing: true gives up at once (outcome 'stopped', nothing recorded). */
  stopped?: () => boolean;
  /** Try even when VACUUM failed within VACUUM_RETRY_AFTER_MS (`compact --force`). */
  ignoreBackoff?: boolean;
  /** Tests: deadline, checkpoint busy timeout and attempts, clock. */
  deadlineMs?: number;
  checkpointBusyMs?: number;
  checkpointAttempts?: number;
  checkpointDelayMs?: number;
  now?: () => number;
}

export interface VacuumResult {
  /**
   * 'already': it was done before (nothing ran). 'stopped': given up before starting (see VacuumOptions.stopped).
   * 'backoff': it failed recently and was not tried (reason says until when). 'skipped' with `failed`: it ran and
   * failed (error, timeout, checkpoint kept busy, no shrink); without: it did not run (space, import).
   */
  outcome: 'done' | 'skipped' | 'already' | 'stopped' | 'backoff';
  reason?: string;
  failed?: boolean;
  before?: { fileBytes: number; walBytes: number };
  after?: { fileBytes: number; walBytes: number };
}

const MB = (n: number): string => `${(n / 1024 / 1024).toFixed(0)} MB`;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/**
 * Runs VACUUM unless it is done already (see VacuumOptions.evenIfDone) or failed within VACUUM_RETRY_AFTER_MS (unless
 * ignoreBackoff), records the outcome in `meta` (`storage:vacuum`) and returns it with the file sizes before and after.
 * Never throws.
 *
 * VACUUM itself runs in a child process (vacuumInChild) with a hard deadline; in the service the host's writes and the
 * store's meta writes are held meanwhile and released in `finally` blocks that run whatever happens. It counts as done
 * only when the truncating checkpoint completed and the file shrank (or had no free pages to give back); a VACUUM that
 * errs, times out, cannot complete its checkpoint (a reader holds a snapshot) or does not shrink the file is recorded
 * as skipped, with the time (`storage:vacuum_failed_at`), and not retried for VACUUM_RETRY_AFTER_MS.
 */
export async function vacuumIfDue(store: Store, options: VacuumOptions = {}): Promise<VacuumResult> {
  const log = options.log ?? (() => {});
  try {
    return await vacuumUnsafe(store, options, log);
  } catch (err) {
    // Only a failing meta write can get here (recording the outcome); nothing is held any more.
    const reason = `error: ${err instanceof Error ? err.message : String(err)}`;
    log(`agent-canvas: database compaction (VACUUM) failed: ${reason}`);
    return { outcome: 'skipped', reason, failed: true };
  }
}

async function vacuumUnsafe(store: Store, options: VacuumOptions, log: (line: string) => void): Promise<VacuumResult> {
  if (store.getMeta(STORAGE_META.vacuum) === 'done' && options.evenIfDone !== true) return { outcome: 'already' };
  const failedAt = Date.parse(store.getMeta(STORAGE_META.vacuumFailedAt) ?? '');
  const now = (options.now ?? Date.now)();
  if (options.ignoreBackoff !== true && Number.isFinite(failedAt) && now - failedAt < VACUUM_RETRY_AFTER_MS) {
    const retryAt = new Date(failedAt + VACUUM_RETRY_AFTER_MS).toISOString();
    return { outcome: 'backoff', reason: `failed at ${new Date(failedAt).toISOString()}; retried after ${retryAt}` };
  }
  const skip = (reason: string, failed = false, backOff = failed): VacuumResult => {
    store.setMeta(STORAGE_META.vacuum, `skipped:${reason}`);
    if (backOff) store.setMeta(STORAGE_META.vacuumFailedAt, new Date(now).toISOString());
    log(`agent-canvas: database compaction (VACUUM) ${failed ? 'failed' : 'skipped'}: ${reason}`);
    return { outcome: 'skipped', reason, ...(failed ? { failed: true } : {}) };
  };
  const atStart = store.dbFileSizes();
  if (options.skipSpaceCheck !== true) {
    let problem: string | null;
    try {
      problem = vacuumSpaceProblem(path.dirname(path.resolve(store.dbPath())), atStart.fileBytes + atStart.walBytes, {
        freeBytes: options.freeBytes ?? freeBytesOf,
        tempDir: options.tempDir ?? sqliteTempDir(),
        volumeOf: options.volumeOf ?? volumeOf,
      });
    } catch (err) {
      return skip(`free-space check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (problem !== null) return skip(problem);
  }
  const host = options.host;
  if (host !== undefined) {
    const deadline = Date.now() + (options.quiesceTimeoutMs ?? VACUUM_QUIESCE_TIMEOUT_MS);
    while (host.importing()) {
      if (options.stopped?.() === true) return { outcome: 'stopped' };
      if (Date.now() >= deadline) return skip('busy: the service kept importing');
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    if (options.stopped?.() === true) return { outcome: 'stopped' };
  }
  let result: ChildResult;
  let releaseWrites: (() => void) | null = null;
  let releaseMeta: (() => void) | null = null;
  let resumeCheckpointer: (() => void) | null = null;
  let before = store.dbFileSizes(); // measured again once nothing writes any more
  try {
    if (host !== undefined) {
      releaseWrites = host.holdWrites();
      releaseMeta = store.holdMetaWrites();
    }
    // The store's own checkpointer would make the truncating checkpoint after VACUUM fail at once.
    resumeCheckpointer = await store.pauseCheckpointer();
    before = store.dbFileSizes();
    result = await vacuumInChild(store, options);
  } catch (err) {
    result = { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  } finally {
    // Each release on its own: a failing one (the held meta flush on a full disk) never keeps the other held.
    try {
      resumeCheckpointer?.();
    } catch (err) {
      log(`agent-canvas: resuming the checkpointer failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      releaseMeta?.();
    } catch (err) {
      log(`agent-canvas: writing the settings held during VACUUM failed (kept in memory, retried): ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      releaseWrites?.();
    } catch (err) {
      log(`agent-canvas: releasing the held writes failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (result.kind === 'error') return skip(`error: ${result.message}`, true);
  if (result.kind === 'timeout') return skip(`timeout: VACUUM did not finish within ${Math.round(result.ms / 1000)} s`, true);
  if (result.checkpoint === null || result.checkpoint.busy !== 0) {
    // Not backed off: a reader that held a snapshot is usually gone by the next start.
    return skip('busy: another connection held a read snapshot, so the file could not be truncated', true, false);
  }
  const after = store.dbFileSizes();
  if (!(after.fileBytes < before.fileBytes || result.freelistBefore === 0)) {
    return skip(`not-shrunk: ${MB(before.fileBytes)} before, ${MB(after.fileBytes)} after`, true);
  }
  store.setMeta(STORAGE_META.vacuum, 'done');
  store.deleteMeta(STORAGE_META.vacuumFailedAt);
  log(`agent-canvas: database compacted: ${MB(before.fileBytes + before.walBytes)} -> ${MB(after.fileBytes + after.walBytes)}`);
  return { outcome: 'done', before, after };
}

type ChildResult =
  | { kind: 'error'; message: string }
  | { kind: 'timeout'; ms: number }
  | { kind: 'ok'; freelistBefore: number; checkpoint: { busy: number; log: number; checkpointed: number } | null };

/**
 * VACUUM plus a truncating checkpoint in a child process (vacuum-child), killed when it has not answered within the
 * deadline (VACUUM_DEADLINE_MS: SQLite rolls the unfinished VACUUM back). An in-memory database is vacuumed on the
 * store's own connection.
 */
function vacuumInChild(store: Store, options: VacuumOptions): Promise<ChildResult> {
  const dbPath = store.dbPath();
  if (dbPath === ':memory:' || dbPath === '') {
    store.vacuum();
    return Promise.resolve({ kind: 'ok', freelistBefore: 0, checkpoint: { busy: 0, log: 0, checkpointed: 0 } });
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = ['vacuum-child.js', 'vacuum-child.ts'].map((f) => path.join(here, f)).find((f) => fs.existsSync(f));
  if (script === undefined) return Promise.resolve({ kind: 'error', message: 'vacuum-child script not found' });
  const deadlineMs = options.deadlineMs ?? VACUUM_DEADLINE_MS;
  const args = [
    path.resolve(dbPath),
    String(options.checkpointBusyMs ?? VACUUM_CHECKPOINT_BUSY_MS),
    String(options.checkpointAttempts ?? VACUUM_CHECKPOINT_ATTEMPTS),
    String(options.checkpointDelayMs ?? VACUUM_CHECKPOINT_DELAY_MS),
  ];
  return new Promise((resolve) => {
    let settled: ChildResult | null = null;
    const child = fork(script, args, { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      settled ??= { kind: 'timeout', ms: deadlineMs };
      child.kill();
    }, deadlineMs);
    child.on('message', (m: { ok?: unknown; error?: unknown; freelistBefore?: unknown; checkpoint?: unknown }) => {
      if (settled !== null) return;
      if (m?.ok === true) {
        settled = {
          kind: 'ok',
          freelistBefore: typeof m.freelistBefore === 'number' ? m.freelistBefore : -1,
          checkpoint: (m.checkpoint as { busy: number; log: number; checkpointed: number } | null) ?? null,
        };
      } else settled = { kind: 'error', message: typeof m?.error === 'string' ? m.error : 'VACUUM failed' };
    });
    child.on('error', (err) => {
      settled ??= { kind: 'error', message: err.message };
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(settled ?? { kind: 'error', message: `VACUUM process exited with code ${String(code)}${stderr === '' ? '' : `: ${stderr.trim().split('\n').pop()}`}` });
    });
  });
}

export interface StorageMaintenanceOptions extends MigrationOptions {
  pollMs?: number;
  maxWaitMs?: number;
  quiesceTimeoutMs?: number;
  freeBytes?: (dir: string) => number;
  log?: (line: string) => void;
}

export interface StorageMaintenance {
  /** Resolves when the job has finished or stopped; never rejects. */
  readonly done: Promise<void>;
  /** Stops before the next batch (a VACUUM in progress is finished first); resolves once the job has ended. */
  stop(): Promise<void>;
  status(): StorageDiagnostics;
}

/**
 * The service's background job: waits for the start-up work to be over (host.startupDone, or STORAGE_MAX_WAIT_MS),
 * then runs the migration batch by batch, yielding to the event loop between batches and pausing while the host is
 * importing, then VACUUM (vacuumIfDue: in a child process, with the host's writes held). A failing batch stops the job
 * until the next start (the error is reported in status() and logged). Its timers never keep the process alive.
 */
export function startStorageMaintenance(store: Store, host: StorageHost, options: StorageMaintenanceOptions = {}): StorageMaintenance {
  const pollMs = Math.max(1, options.pollMs ?? STORAGE_POLL_MS);
  const maxWaitMs = options.maxWaitMs ?? STORAGE_MAX_WAIT_MS;
  const log = options.log ?? (() => {});
  let stopped = false;
  /** Wakes the current wait at once (stop()). */
  let wake: (() => void) | null = null;
  const nap = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      timer.unref?.();
      function done(): void {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = done;
    });
  let migrating = false;
  let lastError: string | null = null;
  const settled = (): boolean => {
    try {
      return host.startupDone();
    } catch {
      return false;
    }
  };
  const importing = (): boolean => {
    try {
      return host.importing();
    } catch {
      return false;
    }
  };

  const run = async (): Promise<void> => {
    const since = Date.now();
    while (!stopped && !settled() && Date.now() - since < maxWaitMs) await nap(pollMs);
    if (stopped) return;
    if (store.getMeta(STORAGE_META.migration) !== 'done') {
      migrating = true;
      log('agent-canvas: compressing stored records (one-time, in the background)…');
      try {
        for (;;) {
          while (!stopped && importing()) await nap(pollMs);
          if (stopped) return;
          let more: boolean;
          try {
            more = migrateBatch(store, options).more;
          } catch (err) {
            lastError = `migration: ${err instanceof Error ? err.message : String(err)}`;
            log(`agent-canvas: compressing stored records failed (retried at the next start): ${lastError}`);
            return;
          }
          if (!more) break;
          await new Promise<void>((resolve) => setImmediate(resolve));
          // Lets the checkpointer catch up so the WAL restarts instead of growing to the size of the rewritten rows.
          await store.settleWal();
        }
      } finally {
        migrating = false;
      }
      log('agent-canvas: stored records compressed');
    }
    if (stopped) return;
    const result = await vacuumIfDue(store, {
      host,
      log,
      stopped: () => stopped,
      ...(options.freeBytes !== undefined ? { freeBytes: options.freeBytes } : {}),
      ...(options.quiesceTimeoutMs !== undefined ? { quiesceTimeoutMs: options.quiesceTimeoutMs } : {}),
    });
    if (result.failed === true) lastError = `vacuum: ${result.reason ?? 'failed'}`;
  };
  const done = run().catch((err: unknown) => {
    lastError = err instanceof Error ? err.message : String(err);
  });

  return {
    done,
    async stop() {
      stopped = true;
      wake?.();
      await done;
    },
    status: () => storageStatus(store, { migrating, lastError }),
  };
}

/** Diagnostics.storage from `meta` and the file sizes, plus the live state of a running job when there is one. */
export function storageStatus(store: Store, job: { migrating: boolean; lastError: string | null } = { migrating: false, lastError: null }): StorageDiagnostics {
  const { fileBytes, walBytes } = store.dbFileSizes();
  const { migrated, total } = progressOf(store);
  const v = store.getMeta(STORAGE_META.vacuum);
  const failed = num(store, STORAGE_META.failed);
  return {
    fileBytes,
    walBytes,
    migrating: job.migrating,
    migrated,
    total,
    vacuum: v === 'done' ? 'done' : v?.startsWith('skipped:') ? 'skipped' : 'pending',
    vacuumSkipReason: v?.startsWith('skipped:') ? v.slice('skipped:'.length) : null,
    unreadableDetails: store.unreadableDetailCount(),
    lastError: job.lastError ?? (failed > 0 ? `${failed} stored rows could not be compressed (kept as they were)` : null),
  };
}
