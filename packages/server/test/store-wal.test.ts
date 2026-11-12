import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { openStore, type Store } from '../src/store/store.js';

// Fix wave: a long import writes transaction after transaction. SQLite restarts the WAL only when a write begins after
// a checkpoint copied every frame, which never happens while writes keep arriving during each passive checkpoint (the
// real-data trial's WAL reached 757 MB). settleWal waits for a complete checkpoint once the WAL file is past its limit.

let tmp: string;
let store: Store;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-store-wal-'));
});
afterEach(async () => {
  store.close();
  await new Promise((r) => setTimeout(r, 200)); // the checkpointer closes its handle asynchronously
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 10 }).catch(() => undefined);
});

const walSize = (dbPath: string): number => {
  try {
    return fs.statSync(`${dbPath}-wal`).size;
  } catch {
    return 0;
  }
};

test('writes separated by settleWal keep the WAL file near its size limit', async () => {
  const dbPath = path.join(tmp, 'data.db');
  const limit = 1024 * 1024;
  const slack = 1024 * 1024;
  store = openStore(dbPath, { walSizeLimitBytes: limit, walSettleSlackBytes: slack });
  const body = 'x'.repeat(200 * 1024);
  let peak = 0;
  for (let t = 0; t < 60; t++) {
    await store.settleWal();
    store.transaction(() => {
      for (let i = 0; i < 4; i++) {
        store.insertRaw({ source: 'transcript', origin: 'cursor', file: 'cursor:c', offset: t * 4 + i, line: `${t}:${i}:${body}`, recordType: 'bubble', sessionId: 'c', agentId: null, projectId: 'p' });
      }
    });
    peak = Math.max(peak, walSize(dbPath));
  }
  // 60 transactions of ~800 KB: about 48 MB written; the WAL stays within limit + slack + one transaction.
  expect(peak).toBeLessThan(limit + slack + 2 * 1024 * 1024);
}, 60_000);

test('settleWal resolves without waiting for a checkpoint while the WAL is small, and after close', async () => {
  const dbPath = path.join(tmp, 'data.db');
  store = openStore(dbPath, { walSizeLimitBytes: 1024 * 1024, walSettleSlackBytes: 1024 * 1024 });
  store.setMeta('x', 'y');
  let settled = false;
  const p = store.settleWal().then(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(true); // no checkpoint round trip to the worker
  await p;
  store.close();
  await store.settleWal();
  store = openStore(dbPath); // afterEach closes it
});
