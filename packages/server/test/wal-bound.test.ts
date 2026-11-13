import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { migrateAll, startStorageMaintenance } from '../src/store/migrate-storage.js';
import { startSearchIndexBuild } from '../src/store/search-index.js';
import { openStore, type RawEvent, type Store } from '../src/store/store.js';
import { SCHEMA_SQL_V13 } from './schema-v13.js';

/*
 * The WAL stays bounded during the long write loops (background migration, compact's migration, a full rebuild, the
 * index build): the checkpointer catches up between batches and the WAL restarts. Scaled down: WAL limit 1 MB and
 * slack 1 MB instead of 64 MB / 16 MB, on databases of 30+ MB, so the bound (a few MB) is far below what an unbounded
 * WAL would reach (about the size of the data written).
 */

const LIMIT = 1024 * 1024;
const opts = { walSizeLimitBytes: LIMIT, walSettleSlackBytes: LIMIT };
const BOUND = 8 * 1024 * 1024;
let tmp: string;
let file: string;
let store: Store | null = null;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-wal-bound-'));
  file = path.join(tmp, 'data.db');
});
afterEach(async () => {
  store?.close();
  store = null;
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

const walSize = (): number => {
  try {
    return fsSync.statSync(`${file}-wal`).size;
  } catch {
    return 0;
  }
};

/** An old database of about 36 MB of plain raw rows. */
function oldDatabase(): void {
  const db = new Database(file);
  db.exec(SCHEMA_SQL_V13);
  db.exec(`INSERT INTO meta (key, value) VALUES ('epoch', 'e'), ('hook_stat_ready', '1')`);
  const ins = db.prepare(`INSERT INTO raw_event (source, file, "offset", line_hash, record_type, session_id, body) VALUES ('transcript', 'p/s1.jsonl', ?, ?, 'x', 's1', ?)`);
  db.transaction(() => {
    for (let i = 0; i < 12_000; i++) {
      const line = JSON.stringify({ type: 'x', i, pad: createHash('sha256').update(String(i)).digest('hex').repeat(45) });
      ins.run(i, createHash('sha1').update(line).digest('hex'), line);
    }
  })();
  db.close();
}

test('后台迁移：WAL 不随改写的数据量增长', async () => {
  oldDatabase();
  expect(fsSync.statSync(file).size).toBeGreaterThan(30 * 1024 * 1024);
  store = openStore(file, opts);
  let max = 0;
  const job = startStorageMaintenance(
    store,
    { startupDone: () => true, importing: () => false, holdWrites: () => () => undefined },
    { pollMs: 1, freeBytes: () => 0, onBatch: () => void (max = Math.max(max, walSize())) },
  );
  await job.done;
  max = Math.max(max, walSize());
  console.log(`background migration: largest WAL ${(max / 1024 / 1024).toFixed(1)} MB`);
  expect(max).toBeLessThan(BOUND);
}, 120_000);

test('compact 的迁移（同步）：WAL 有界', () => {
  oldDatabase();
  store = openStore(file, opts);
  let max = 0;
  migrateAll(store, { onBatch: () => void (max = Math.max(max, walSize())) });
  max = Math.max(max, walSize());
  console.log(`compact migration: largest WAL ${(max / 1024 / 1024).toFixed(1)} MB`);
  expect(max).toBeLessThan(BOUND);
}, 120_000);

test('完整重建和随后的索引建立：WAL 有界', async () => {
  store = openStore(file, opts);
  const s = store;
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  s.transaction(() => {
    for (let k = 0; k < 300; k++) {
      const sessionId = `s${k}`;
      let parent: string | null = null;
      for (let i = 0; i < 30; i++) {
        const uuid = `${sessionId}-${i}`;
        const text = createHash('sha256').update(uuid).digest('hex').repeat(40);
        const record =
          i % 2 === 0
            ? { type: 'user', uuid, parentUuid: parent, timestamp: new Date(t0 + i * 1000).toISOString(), sessionId, cwd: '/w', message: { role: 'user', content: text } }
            : { type: 'assistant', uuid, parentUuid: parent, timestamp: new Date(t0 + i * 1000).toISOString(), sessionId, cwd: '/w', message: { id: `m-${uuid}`, role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } } };
        const ev: RawEvent = { source: 'transcript', file: `p/${sessionId}.jsonl`, offset: i, line: JSON.stringify(record), recordType: record.type, sessionId, agentId: null };
        s.insertRaw(ev);
        parent = uuid;
      }
    }
  });
  await new Promise((r) => setTimeout(r, 1500)); // the inserts' WAL is checkpointed and restarts with the next write
  const config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), cursorDbPath: null, codexSessionsDir: null });
  let max = 0;
  const apply = s.applyChanges.bind(s);
  vi.spyOn(s, 'applyChanges').mockImplementation((changes) => {
    max = Math.max(max, walSize());
    return apply(changes);
  });
  new Pipeline(s, config).rebuild();
  max = Math.max(max, walSize());
  console.log(`rebuild: largest WAL ${(max / 1024 / 1024).toFixed(1)} MB, database ${(fsSync.statSync(file).size / 1024 / 1024).toFixed(1)} MB`);
  expect(max).toBeLessThan(BOUND);

  expect(s.searchIndexStatus().indexing).toBe(true); // the rebuild left the index to the background build
  let maxIndex = 0;
  const batch = s.searchIndexBatch.bind(s);
  vi.spyOn(s, 'searchIndexBatch').mockImplementation((rows, bytes) => {
    maxIndex = Math.max(maxIndex, walSize());
    return batch(rows, bytes);
  });
  const build = startSearchIndexBuild(s, { startupDone: () => true, importing: () => false, writesHeld: () => false }, { pollMs: 1, batchRows: 200 });
  await build.done;
  maxIndex = Math.max(maxIndex, walSize());
  console.log(`index build: largest WAL ${(maxIndex / 1024 / 1024).toFixed(1)} MB`);
  expect(s.searchIndexStatus().indexing).toBe(false);
  expect(maxIndex).toBeLessThan(BOUND);
}, 180_000);
