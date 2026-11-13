import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  migrateAll,
  migrateBatch,
  startStorageMaintenance,
  STORAGE_META,
  storageStatus,
  vacuumIfDue,
  type StorageHost,
} from '../src/store/migrate-storage.js';
import { openStore, type Store } from '../src/store/store.js';
import { SCHEMA_SQL_V13 } from './schema-v13.js';

let tmp: string;
let file: string;
let store: Store | null;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-migrate-storage-'));
  file = path.join(tmp, 'data.db');
  store = null;
});
afterEach(async () => {
  store?.close();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');
const text = (i: number, n = 600): string => JSON.stringify({ type: 'user', i, message: `line ${i} `.repeat(Math.ceil(n / 8)) });

/** A database as the previous version left it: plain bodies and details, no enc column. */
function oldDatabase(rawRows: number, detailRows: number, at = file): void {
  const db = new Database(at);
  db.exec(SCHEMA_SQL_V13);
  db.exec(`INSERT INTO meta (key, value) VALUES ('epoch', 'e'), ('hook_stat_ready', '1')`);
  const raw = db.prepare(`INSERT INTO raw_event (source, file, "offset", line_hash, record_type, session_id, body) VALUES ('transcript', 'p/s1.jsonl', ?, ?, 'user', 's1', ?)`);
  const det = db.prepare(`INSERT INTO node_detail (session_id, node_id, detail) VALUES ('s1', ?, ?)`);
  db.transaction(() => {
    for (let i = 0; i < rawRows; i++) {
      const t = i % 5 === 4 ? `{"short":${i}}` : text(i);
      raw.run(i, sha1(t), t);
    }
    for (let i = 0; i < detailRows; i++) det.run(`n${i}`, i % 5 === 4 ? '{}' : JSON.stringify({ text: text(i) }));
  })();
  db.close();
}

function peek<T>(sql: string): T[] {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

const encCounts = (table: string): Record<number, number> =>
  Object.fromEntries(peek<{ enc: number; n: number }>(`SELECT enc, COUNT(*) AS n FROM ${table} GROUP BY enc`).map((r) => [r.enc, r.n]));

function snapshot(s: Store): { raw: string[]; details: unknown[] } {
  const raw = s.rawForSession('s1').map((e) => (e.source === 'transcript' ? e.line : e.payload));
  const ids = peek<{ node_id: string }>(`SELECT node_id FROM node_detail ORDER BY node_id`).map((r) => r.node_id);
  // getNodeDetail needs the node row; read the details through the store's decoder via a node row per detail.
  return { raw, details: ids.map((id) => s.getNodeDetail('s1', id)) };
}

function withNodes(s: Store, count: number): void {
  // node rows so getNodeDetail finds the details (the old database has details only)
  const db = new Database(file);
  const ins = db.prepare(`INSERT OR IGNORE INTO node (session_id, id, body) VALUES ('s1', ?, '{}')`);
  db.transaction(() => {
    for (let i = 0; i < count; i++) ins.run(`n${i}`);
  })();
  db.close();
  void s;
}

const host = (over: Partial<StorageHost> = {}): StorageHost => ({
  startupDone: () => true,
  importing: () => false,
  holdWrites: () => () => undefined,
  ...over,
});

describe('迁移', () => {
  test('新库：打开时就记为已完成，什么都不做', () => {
    store = openStore(file);
    expect(store.getMeta(STORAGE_META.migration)).toBe('done');
    expect(store.getMeta(STORAGE_META.vacuum)).toBe('done');
    const spy = vi.spyOn(store, 'convertBodies');
    expect(migrateBatch(store).more).toBe(false);
    expect(migrateAll(store)).toMatchObject({ converted: 0, failed: 0 });
    expect(spy).not.toHaveBeenCalled();
    expect(storageStatus(store)).toMatchObject({ migrating: false, vacuum: 'done', lastError: null });
  });

  test('旧库：全部转换，读出来逐字一致；短行仍是文本', () => {
    oldDatabase(50, 30);
    store = openStore(file);
    withNodes(store, 30);
    expect(store.getMeta(STORAGE_META.migration)).toBeNull();
    const before = snapshot(store);
    const result = migrateAll(store, { batchRows: 7 });
    expect(result).toMatchObject({ converted: 40 + 24, failed: 0 });
    expect(encCounts('raw_event')).toEqual({ 0: 10, 1: 40 });
    expect(encCounts('node_detail')).toEqual({ 0: 6, 1: 24 });
    expect(snapshot(store)).toEqual(before);
    expect(store.getMeta(STORAGE_META.migration)).toBe('done');
    expect(store.getMeta(STORAGE_META.vacuum)).toBeNull(); // pending
    const st = storageStatus(store);
    expect(st).toMatchObject({ migrating: false, vacuum: 'pending', vacuumSkipReason: null, lastError: null });
    expect(st.migrated).toBe(st.total);
    expect(st.total).toBe(80);
  });

  test('按字节数切批', () => {
    oldDatabase(20, 0);
    store = openStore(file);
    const spy = vi.spyOn(store, 'convertBodies');
    migrateAll(store, { batchRows: 1000, batchBytes: 2000 });
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  test('做了 N 批后中断：进度在 meta 里，重开后从记录的位置继续', () => {
    oldDatabase(40, 20);
    store = openStore(file);
    withNodes(store, 20);
    const before = snapshot(store);
    for (let i = 0; i < 3; i++) expect(migrateBatch(store, { batchRows: 5 }).more).toBe(true);
    expect(Number(store.getMeta(STORAGE_META.rawAfter))).toBe(15);
    store.close();
    store = openStore(file);
    const spy = vi.spyOn(store, 'convertBodies');
    migrateAll(store, { batchRows: 5 });
    expect(spy.mock.calls[0]![1]).toBe(15); // continued after the recorded position
    expect(encCounts('raw_event')).toEqual({ 0: 8, 1: 32 });
    expect(snapshot(store)).toEqual(before);
  });

  test('批内中断（事务回滚）：这一批不算数，行和进度都不变，下次重做', () => {
    oldDatabase(20, 0);
    store = openStore(file);
    migrateBatch(store, { batchRows: 5 });
    const encBefore = encCounts('raw_event');
    expect(() => migrateBatch(store!, { batchRows: 5, onBatch: () => { throw new Error('killed'); } })).toThrow('killed');
    expect(encCounts('raw_event')).toEqual(encBefore);
    expect(store.getMeta(STORAGE_META.rawAfter)).toBe('5');
    migrateAll(store, { batchRows: 5 });
    expect(encCounts('raw_event')).toEqual({ 0: 4, 1: 16 });
  });

  test('完成后再跑是空操作', () => {
    oldDatabase(10, 10);
    store = openStore(file);
    migrateAll(store);
    const spy = vi.spyOn(store, 'convertBodies');
    expect(migrateAll(store)).toMatchObject({ converted: 0, failed: 0 });
    expect(migrateBatch(store).more).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  test('迁移期间写入的行（新的压缩行、详情被替换）都正确', () => {
    oldDatabase(30, 10);
    store = openStore(file);
    withNodes(store, 10);
    migrateBatch(store, { batchRows: 4 });
    store.insertRaw({ source: 'transcript', file: 'p/s1.jsonl', offset: 1000, line: text(1000), recordType: 'user', sessionId: 's1', agentId: null });
    store.applyChanges([{ type: 'node_updated', sessionId: 's1', id: 'n1', patch: {}, detail: { output: 'new output '.repeat(50) } }]);
    while (migrateBatch(store, { batchRows: 4 }).more) {
      store.insertRaw({ source: 'hook', receivedAt: '2026-01-01T00:00:00.000Z', eventName: 'Stop', sessionId: 's1', payload: text(7) });
    }
    const raw = store.rawForSession('s1');
    expect(raw).toHaveLength(31 + raw.filter((e) => e.source === 'hook').length);
    expect(raw.every((e) => e.corrupt === undefined)).toBe(true);
    expect(raw.find((e) => e.source === 'transcript' && e.offset === 1000)).toMatchObject({ line: text(1000) });
    expect(store.getNodeDetail('s1', 'n1')).toMatchObject({ text: text(1), output: 'new output '.repeat(50) });
    expect(encCounts('node_detail')).toEqual({ 0: 2, 1: 8 });
  });

  test('转换失败的行原样保留并计数', () => {
    oldDatabase(10, 0);
    const db = new Database(file);
    db.exec(`UPDATE raw_event SET body = x'0102030405' WHERE ingest_id = 3`); // a BLOB marked plain: not convertible
    db.close();
    store = openStore(file);
    expect(migrateAll(store)).toMatchObject({ failed: 1 });
    expect(peek(`SELECT enc, typeof(body) AS t FROM raw_event WHERE ingest_id = 3`)).toEqual([{ enc: 0, t: 'blob' }]);
    expect(store.getMeta(STORAGE_META.failed)).toBe('1');
    expect(storageStatus(store).lastError).toMatch(/1 /);
  });
});

describe('后台任务', () => {
  test('等启动完成；导入期间暂停；批与批之间让出事件循环', async () => {
    oldDatabase(60, 0);
    store = openStore(file);
    let settled = false;
    let importing = false;
    const order: string[] = [];
    const job = startStorageMaintenance(store, host({ startupDone: () => settled, importing: () => importing }), {
      pollMs: 5,
      batchRows: 5,
      freeBytes: () => 0,
      onBatch: () => {
        order.push('batch');
        setImmediate(() => order.push('tick'));
      },
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(order).toEqual([]);
    expect(job.status().migrating).toBe(false);
    importing = true;
    settled = true;
    await new Promise((r) => setTimeout(r, 40));
    expect(order).toEqual([]);
    expect(job.status().migrating).toBe(true);
    importing = false;
    await job.done;
    expect(order.filter((o) => o === 'batch').length).toBeGreaterThanOrEqual(12);
    for (let i = 1; i < order.length; i++) if (order[i] === 'batch') expect(order[i - 1]).toBe('tick');
    expect(store.getMeta(STORAGE_META.migration)).toBe('done');
    expect(job.status()).toMatchObject({ migrating: false, vacuum: 'skipped' });
  });

  test('stop() 让任务在下一批前停下，进度保留', async () => {
    oldDatabase(60, 0);
    store = openStore(file);
    let batches = 0;
    const job = startStorageMaintenance(store, host(), { pollMs: 1, batchRows: 5, freeBytes: () => 0, onBatch: () => void batches++ });
    while (batches < 2) await new Promise((r) => setImmediate(r));
    await job.stop();
    const at = batches;
    await new Promise((r) => setTimeout(r, 20));
    expect(batches).toBe(at);
    expect(store.getMeta(STORAGE_META.migration)).toBeNull();
    expect(Number(store.getMeta(STORAGE_META.rawAfter))).toBe(5 * at);
  });

  test('一批出错：记下错误，本次不再继续，下次启动重试', async () => {
    oldDatabase(20, 0);
    store = openStore(file);
    const lines: string[] = [];
    const job = startStorageMaintenance(store, host(), {
      pollMs: 1,
      batchRows: 5,
      freeBytes: () => 0,
      log: (l) => lines.push(l),
      onBatch: () => {
        throw new Error('disk I/O error');
      },
    });
    await job.done;
    expect(job.status()).toMatchObject({ migrating: false, lastError: expect.stringContaining('disk I/O error') });
    expect(lines.some((l) => l.includes('disk I/O error'))).toBe(true);
    expect(store.getMeta(STORAGE_META.migration)).toBeNull();
    const again = startStorageMaintenance(store, host(), { pollMs: 1, freeBytes: () => 0 });
    await again.done;
    expect(store.getMeta(STORAGE_META.migration)).toBe('done');
  });
});

describe('VACUUM', () => {
  async function migratedOld(): Promise<void> {
    oldDatabase(3000, 1000);
    store = openStore(file);
    migrateAll(store);
  }

  test('可用空间不足 1.2 倍时跳过，记下原因；之后空间够了再试', async () => {
    await migratedOld();
    // The database file and its WAL as they are when the check runs (the checkpointer moves pages between them).
    const times = (f: number) => (): number => {
      const { fileBytes, walBytes } = store!.dbFileSizes();
      return Math.floor((fileBytes + walBytes) * f);
    };
    const out = await vacuumIfDue(store!, { freeBytes: times(1.15) });
    expect(out.outcome).toBe('skipped');
    expect(store!.getMeta(STORAGE_META.vacuum)).toMatch(/^skipped:low-space/);
    expect(storageStatus(store!)).toMatchObject({ vacuum: 'skipped', vacuumSkipReason: expect.stringMatching(/^low-space/) });
    const done = await vacuumIfDue(store!, { freeBytes: times(1.25) });
    expect(done.reason).toBeUndefined();
    expect(done.outcome).toBe('done');
    expect(store!.getMeta(STORAGE_META.vacuum)).toBe('done');
  });

  test('查不到可用空间时跳过并说明', async () => {
    await migratedOld();
    const out = await vacuumIfDue(store!, { freeBytes: () => { throw new Error('ENOSYS'); } });
    expect(out.outcome).toBe('skipped');
    expect(store!.getMeta(STORAGE_META.vacuum)).toMatch(/^skipped:free-space check failed: .*ENOSYS/);
  });

  test('成功：文件变小（WAL 也截断），数据不变；做完后再调是空操作；force 跳过空间检查', async () => {
    await migratedOld();
    withNodes(store!, 1000);
    const before = snapshot(store!);
    const sizeBefore = store!.dbFileSizes();
    const out = await vacuumIfDue(store!, { freeBytes: () => 10 ** 12 });
    expect(out).toMatchObject({ outcome: 'done' });
    expect(out.after!.fileBytes).toBeLessThan(sizeBefore.fileBytes * 0.7);
    expect(out.after!.walBytes).toBe(0);
    expect(snapshot(store!)).toEqual(before);
    const probe = vi.fn(() => 10 ** 12);
    expect((await vacuumIfDue(store!, { freeBytes: probe })).outcome).toBe('already');
    expect(probe).not.toHaveBeenCalled();
    expect((await vacuumIfDue(store!, { skipSpaceCheck: true, freeBytes: () => 0 })).outcome).toBe('already');
    expect((await vacuumIfDue(store!, { skipSpaceCheck: true, evenIfDone: true, freeBytes: () => 0 })).outcome).toBe('done');
  });

  test('服务里：在别的连接上执行，期间管线的写入被挡住，结束后放开', async () => {
    await migratedOld();
    const held: boolean[] = [];
    let holding = false;
    const h = host({
      holdWrites: () => {
        holding = true;
        held.push(true);
        return () => {
          holding = false;
        };
      },
    });
    let readsDuring = 0;
    const timer = setInterval(() => {
      if (holding) {
        store!.getMeta('epoch'); // reads keep working
        readsDuring++;
      }
    }, 1);
    try {
      const out = await vacuumIfDue(store!, { host: h, freeBytes: () => 10 ** 12 });
      expect(out.outcome).toBe('done');
    } finally {
      clearInterval(timer);
    }
    expect(held).toEqual([true]);
    expect(holding).toBe(false);
    expect(store!.getMeta(STORAGE_META.vacuum)).toBe('done');
  });

  test('服务里：导入一直不停，30 秒（这里注入为 30 毫秒）内静不下来就推迟', async () => {
    await migratedOld();
    const out = await vacuumIfDue(store!, { host: host({ importing: () => true }), quiesceTimeoutMs: 30, freeBytes: () => 10 ** 12 });
    expect(out.outcome).toBe('skipped');
    expect(store!.getMeta(STORAGE_META.vacuum)).toBe('skipped:busy');
  });

  test('VACUUM 期间 meta 写入先记在内存，读得到，结束后落盘', async () => {
    await migratedOld();
    const release = store!.holdMetaWrites();
    const other = new Database(file);
    other.exec('BEGIN IMMEDIATE'); // as VACUUM on another connection
    try {
      store!.setMeta('poll:cursor:x', 'v1');
      store!.deleteMeta('epoch-not-there');
      expect(store!.getMeta('poll:cursor:x')).toBe('v1');
      expect(store!.metaWithPrefix('poll:')).toEqual([['poll:cursor:x', 'v1']]);
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
    release();
    expect(peek(`SELECT value FROM meta WHERE key = 'poll:cursor:x'`)).toEqual([{ value: 'v1' }]);
  });
});
