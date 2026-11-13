import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Diagnostics } from '@agent-canvas/shared';
import { compact, main, start, type Running } from '../src/cli.js';
import { acquireLock } from '../src/lock.js';
import { STORAGE_META } from '../src/store/migrate-storage.js';
import { openStore } from '../src/store/store.js';
import { SCHEMA_SQL_V13 } from './schema-v13.js';

let tmp: string;
let projectsDir: string;
let dataDir: string;
const apps: Running[] = [];
const dbPath = (): string => path.join(dataDir, 'data.db');

beforeEach(async () => {
  vi.stubEnv('AGENT_CANVAS_CODEX_DIR', '');
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-compact-'));
  projectsDir = path.join(tmp, 'projects');
  dataDir = path.join(tmp, 'data');
  await fs.mkdir(projectsDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

/** The previous version's database: plain bodies, no enc columns; the normalizer version recorded as current. */
function oldDatabase(rows: number): void {
  const db = new Database(dbPath());
  db.exec(SCHEMA_SQL_V13);
  db.exec(`INSERT INTO meta (key, value) VALUES ('epoch', 'e'), ('hook_stat_ready', '1')`);
  const ins = db.prepare(`INSERT INTO raw_event (source, file, "offset", line_hash, record_type, session_id, body) VALUES ('transcript', 'p/s1.jsonl', ?, ?, 'x-unknown', 's1', ?)`);
  db.transaction(() => {
    for (let i = 0; i < rows; i++) {
      const line = JSON.stringify({ type: 'x-unknown', i, pad: `record ${i} `.repeat(60) });
      ins.run(i, createHash('sha1').update(line).digest('hex'), line);
    }
  })();
  db.close();
  const s = openStore(dbPath());
  s.close();
}

function encOf(): Record<number, number> {
  const db = new Database(dbPath(), { readonly: true });
  try {
    return Object.fromEntries((db.prepare(`SELECT enc, COUNT(*) AS n FROM raw_event GROUP BY enc`).all() as { enc: number; n: number }[]).map((r) => [r.enc, r.n]));
  } finally {
    db.close();
  }
}

test('compact：服务在运行时拒绝（同一把锁）', async () => {
  const lock = acquireLock(dataDir);
  try {
    await expect(compact({ projectsDir, dataDir })).rejects.toThrow(/already running/);
  } finally {
    lock.release();
  }
});

test('compact：做完剩下的迁移并 VACUUM，报告前后大小和进度；锁随后释放', async () => {
  oldDatabase(3000);
  const progress: [number, number][] = [];
  const r = await compact({ projectsDir, dataDir }, { progress: (m, t) => progress.push([m, t]), freeBytes: () => 10 ** 12 });
  expect(r.converted).toBe(3000);
  expect(r.vacuum).toMatchObject({ outcome: 'done' }); // shows the reason when it is not
  expect(r.after.fileBytes + r.after.walBytes).toBeLessThan((r.before.fileBytes + r.before.walBytes) / 2);
  expect(progress.at(-1)).toEqual([3000, 3000]);
  expect(encOf()).toEqual({ 1: 3000 });
  acquireLock(dataDir).release();
  const s = openStore(dbPath());
  try {
    expect(s.getMeta(STORAGE_META.migration)).toBe('done');
    expect(s.getMeta(STORAGE_META.vacuum)).toBe('done');
    expect(s.rawForSession('s1')).toHaveLength(3000);
  } finally {
    s.close();
  }
}, 60_000); // VACUUM runs in a child process: slow under a loaded full run

test('compact：空间不够时只迁移、跳过 VACUUM；--force 不查空间；已经做过也会再做', async () => {
  oldDatabase(500);
  const skipped = await compact({ projectsDir, dataDir }, { freeBytes: () => 1 });
  expect(skipped.vacuum).toMatchObject({ outcome: 'skipped', reason: expect.stringMatching(/^low-space/) });
  expect(encOf()).toEqual({ 1: 500 });
  const forced = await compact({ projectsDir, dataDir }, { force: true, freeBytes: () => 1 });
  expect(forced.vacuum.outcome).toBe('done');
  // Done, and nothing compressed since: not run again unless forced.
  const again = await compact({ projectsDir, dataDir }, { freeBytes: () => 10 ** 12 });
  expect(again).toMatchObject({ converted: 0, vacuum: { outcome: 'already' } });
  const forcedAgain = await compact({ projectsDir, dataDir }, { force: true, freeBytes: () => 1 });
  expect(forcedAgain.vacuum.outcome).toBe('done');
}, 60_000);

test('main compact：进度写到 stderr，前后大小写到 stdout；用法里有 compact', async () => {
  vi.stubEnv('AGENT_CANVAS_DATA_DIR', dataDir);
  vi.stubEnv('AGENT_CANVAS_PROJECTS_DIR', projectsDir);
  oldDatabase(300);
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void out.push(line));
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => (err.push(String(chunk)), true)) as typeof process.stderr.write);
  expect(await main(['compact', '--force'])).toBe(0);
  expect(err.join('')).toMatch(/compact: 300\/300/);
  expect(out.join('\n')).toMatch(/database file: .* -> /);
  out.length = 0;
  expect(await main(['compact'])).toBe(0);
  expect(out.join('\n')).toMatch(/VACUUM not needed/);
  expect(await main(['compact', '--bogus'])).toBe(1);
  out.length = 0;
  expect(await main(['--help'])).toBe(0);
  expect(out.join('\n')).toMatch(/agent-canvas compact \[--force\]/);
}, 60_000);

test('main compact：VACUUM 失败（读快照让检查点做不完）时退出码 1；读者走后再跑就成功（busy 不退避）', async () => {
  vi.stubEnv('AGENT_CANVAS_DATA_DIR', dataDir);
  vi.stubEnv('AGENT_CANVAS_PROJECTS_DIR', projectsDir);
  oldDatabase(300);
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void out.push(line));
  vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write);
  const reader = new Database(dbPath(), { readonly: true });
  reader.exec('BEGIN');
  reader.prepare('SELECT COUNT(*) FROM raw_event').get();
  try {
    expect(await main(['compact', '--force'])).toBe(1);
  } finally {
    reader.exec('COMMIT');
    reader.close();
  }
  expect(out.join('\n')).toMatch(/VACUUM failed: busy/);
  out.length = 0;
  expect(await main(['compact'])).toBe(0);
  expect(out.join('\n')).not.toMatch(/VACUUM not tried|VACUUM failed/);
}, 120_000);

test('start：旧库在后台迁移并 VACUUM，诊断里看得到；之后重启什么都不做', async () => {
  oldDatabase(400);
  const app = await start({ projectsDir, dataDir, port: 0 }, { storage: { pollMs: 5, freeBytes: () => 10 ** 12 } });
  apps.push(app);
  let storage: Diagnostics['storage'];
  for (let i = 0; i < 400; i++) {
    storage = ((await (await fetch(`${app.url}/api/diagnostics`)).json()) as Diagnostics).storage;
    if (storage?.vacuum === 'done') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(storage!).toMatchObject({ migrating: false, vacuum: 'done', vacuumSkipReason: null, lastError: null, migrated: 400, total: 400 });
  expect(storage!.fileBytes).toBeGreaterThan(0);
  await apps.pop()!.close();
  expect(encOf()).toEqual({ 1: 400 });
  const again = await start({ projectsDir, dataDir, port: 0 }, { storage: { pollMs: 5, freeBytes: () => 10 ** 12 } });
  apps.push(again);
  const d = (await (await fetch(`${again.url}/api/diagnostics`)).json()) as Diagnostics;
  expect(d.storage).toMatchObject({ migrating: false, vacuum: 'done' });
}, 60_000);
