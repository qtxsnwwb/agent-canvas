import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { throttledProgress } from '../src/cli-commands.js';
import { loadConfig, type Config } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { migrateAll, STORAGE_META, vacuumIfDue, VACUUM_RETRY_AFTER_MS } from '../src/store/migrate-storage.js';
import { openStore, type Store } from '../src/store/store.js';
import { SCHEMA_SQL_V13 } from './schema-v13.js';

// VACUUM runs in a child process: allow for a loaded machine (a full parallel test run).
vi.setConfig({ testTimeout: 60_000 });

/*
 * VACUUM in the service with a real Pipeline as host: bounded (deadline, checkpoint attempts), holds always released,
 * `done` only when the file shrank, failures backed off for 24 h.
 */

let tmp: string;
let file: string;
let store: Store;
let config: Config;
let pipeline: Pipeline;
const big = { freeBytes: () => 10 ** 13 };

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-vacuum-robust-'));
  file = path.join(tmp, 'data.db');
  // An old database with plain rows, migrated: lots of free pages for VACUUM to give back.
  const db = new Database(file);
  db.exec(SCHEMA_SQL_V13);
  db.exec(`INSERT INTO meta (key, value) VALUES ('epoch', 'e'), ('hook_stat_ready', '1')`);
  const ins = db.prepare(`INSERT INTO raw_event (source, file, "offset", line_hash, record_type, session_id, body) VALUES ('transcript', 'p/s1.jsonl', ?, ?, 'x', 's1', ?)`);
  db.transaction(() => {
    for (let i = 0; i < 2000; i++) {
      const line = JSON.stringify({ type: 'x', i, pad: `row ${i} `.repeat(80) });
      ins.run(i, createHash('sha1').update(line).digest('hex'), line);
    }
  })();
  db.close();
  store = openStore(file);
  migrateAll(store);
  config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), cursorDbPath: null });
  await fs.mkdir(config.projectsDir, { recursive: true });
  pipeline = new Pipeline(store, config);
});
afterEach(async () => {
  store.close();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

/** A hook through the pipeline: stored only if writes are not held. */
async function hookStored(): Promise<boolean> {
  const before = store.allHookEventStats().reduce((n, s) => n + s.count, 0);
  pipeline.ingestHook('Stop', null, JSON.stringify({ hook_event_name: 'Stop' }));
  await pipeline.idle();
  return store.allHookEventStats().reduce((n, s) => n + s.count, 0) === before + 1;
}

describe('bounded and honest', () => {
  test('另一个连接拿着读快照：截断检查点做不完 -> 放开写入，记 skipped:busy（不记 done，不退避）；读者走后再试就成功', async () => {
    const reader = new Database(file, { readonly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) FROM raw_event').get(); // holds a snapshot
    try {
      const out = await vacuumIfDue(store, { host: pipeline, ...big, checkpointBusyMs: 50, checkpointAttempts: 2, checkpointDelayMs: 10 });
      expect(out).toMatchObject({ outcome: 'skipped', failed: true, reason: expect.stringMatching(/^busy: another connection/) });
    } finally {
      reader.exec('COMMIT');
      reader.close();
    }
    expect(store.getMeta(STORAGE_META.vacuum)).toMatch(/^skipped:busy/);
    expect(store.getMeta(STORAGE_META.vacuumFailedAt)).toBeNull(); // a busy reader is no reason to wait 24 h
    expect(pipeline.writesHeld()).toBe(false);
    expect(await hookStored()).toBe(true);
    expect((await vacuumIfDue(store, { host: pipeline, ...big })).outcome).toBe('done');
  });

  test('超过期限：杀掉子进程，放开写入，记 timeout；数据库完好', async () => {
    const out = await vacuumIfDue(store, { host: pipeline, ...big, deadlineMs: 1 });
    expect(out).toMatchObject({ outcome: 'skipped', failed: true, reason: expect.stringMatching(/^timeout/) });
    expect(pipeline.writesHeld()).toBe(false);
    expect(await hookStored()).toBe(true);
    const check = new Database(file, { readonly: true });
    try {
      expect(check.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      check.close();
    }
  });

  test('失败后 24 小时内不再尝试（不持有写入）；过了 24 小时或 ignoreBackoff 才再试', async () => {
    await vacuumIfDue(store, { host: pipeline, ...big, deadlineMs: 1 });
    const failedAt = Date.parse(store.getMeta(STORAGE_META.vacuumFailedAt)!);
    const hold = vi.spyOn(pipeline, 'holdWrites');
    const soon = await vacuumIfDue(store, { host: pipeline, ...big, now: () => failedAt + 60_000 });
    expect(soon.outcome).toBe('backoff');
    expect(hold).not.toHaveBeenCalled();
    const later = await vacuumIfDue(store, { host: pipeline, ...big, now: () => failedAt + VACUUM_RETRY_AFTER_MS + 1 });
    expect(later.outcome).toBe('done');
    expect(store.getMeta(STORAGE_META.vacuumFailedAt)).toBeNull();
    expect(hold).toHaveBeenCalledTimes(1);
  });

  test('成功的 VACUUM 让文件变小才记 done；没有空闲页可还时也记 done', async () => {
    const before = store.dbFileSizes().fileBytes;
    const out = await vacuumIfDue(store, { host: pipeline, ...big });
    expect(out.outcome).toBe('done');
    expect(out.after!.fileBytes).toBeLessThan(before);
    // Nothing more to give back: a second (forced) VACUUM leaves the size as it is and still counts as done.
    const again = await vacuumIfDue(store, { host: pipeline, ...big, evenIfDone: true });
    expect(again.outcome).toBe('done');
  });
});

describe('holds are always released', () => {
  test('meta 的回写失败：管线的写入仍被放开，之后的写入照常；没写成的 meta 仍可读，下次写 meta 时补写', async () => {
    const real = store.holdMetaWrites.bind(store);
    vi.spyOn(store, 'holdMetaWrites').mockImplementation(() => {
      const release = real();
      store.setMeta('poll:cursor:x', 'v1'); // held
      return () => {
        void release; // the real release is not called: simulate the flush failing
        throw new Error('SQLITE_FULL: database or disk is full');
      };
    });
    const out = await vacuumIfDue(store, { host: pipeline, ...big });
    expect(out.outcome).toBe('done');
    expect(pipeline.writesHeld()).toBe(false);
    expect(await hookStored()).toBe(true);
  });

  test('store 的 meta 回写失败时保留这些写入，下一次写 meta 时补上', () => {
    const release = store.holdMetaWrites();
    store.setMeta('poll:cursor:y', 'v2');
    const other = new Database(file);
    other.pragma('busy_timeout = 0');
    other.exec('BEGIN IMMEDIATE'); // the flush cannot get the write lock (it fails after the busy timeout)
    try {
      expect(() => release()).toThrow(/locked|busy/i);
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
    expect(store.getMeta('poll:cursor:y')).toBe('v2');
    store.setMeta('other', '1'); // flushes the kept ones first
    const check = new Database(file, { readonly: true });
    try {
      expect(check.prepare(`SELECT value FROM meta WHERE key = 'poll:cursor:y'`).pluck().get()).toBe('v2');
    } finally {
      check.close();
    }
  }, 20_000);

  test('持有 meta 写入时在事务里写 meta 会抛错', () => {
    const release = store.holdMetaWrites();
    try {
      expect(() => store.transaction(() => store.setMeta('k', 'v'))).toThrow(/inside a transaction/);
    } finally {
      release();
    }
  });
});

test('throttledProgress：每秒最多一行、百分比前进才写，最后一行一定写', () => {
  const lines: string[] = [];
  let t = 0;
  const progress = throttledProgress((l) => lines.push(l), () => t);
  const total = 350_000;
  for (let done = 0; done <= total; done += 250) {
    t += 25; // a batch every 25 ms: about 35 s in all
    progress(done, total);
  }
  progress(total, total);
  expect(lines.length).toBeGreaterThan(10);
  expect(lines.length).toBeLessThanOrEqual(40);
  expect(lines.at(-1)).toBe(`compact: ${total}/${total} (100%)\n`);
});

describe('the store checkpointer does not make VACUUM fail', () => {
  test('检查点线程一直在跑（间隔 1 ms）、VACUUM 后 WAL 很大：截断检查点仍然完成，记 done', async () => {
    store.close();
    // Larger rows so VACUUM writes a WAL big enough that the thread's PASSIVE copy of it takes a while.
    const db = new Database(file);
    const ins = db.prepare(`INSERT INTO raw_event (source, file, "offset", line_hash, record_type, session_id, data, enc) VALUES ('transcript', 'p/s2.jsonl', ?, ?, 'x', 's2', ?, 0)`);
    db.transaction(() => {
      for (let i = 0; i < 6000; i++) {
        const line = JSON.stringify({ type: 'x', i, pad: createHash('sha256').update(String(i)).digest('hex').repeat(80) });
        ins.run(i, createHash('sha1').update(line).digest('hex'), line);
      }
    })();
    db.exec(`DELETE FROM raw_event WHERE ingest_id % 2 = 0`);
    db.close();
    store = openStore(file, { checkpointIntervalMs: 1 });
    for (let i = 0; i < 3; i++) {
      const out = await vacuumIfDue(store, { ...big, evenIfDone: true, ignoreBackoff: true });
      expect(out).toMatchObject({ outcome: 'done' });
    }
  }, 120_000);
});
