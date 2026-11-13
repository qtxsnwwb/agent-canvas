import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { decodeBody } from '../src/store/codec.js';
import { migrateAll, STORAGE_META } from '../src/store/migrate-storage.js';
import { openStore } from '../src/store/store.js';
import { SCHEMA_SQL_V13 } from './schema-v13.js';

/*
 * A real process killed in the middle of the migration (test/child/migrate-child.mjs runs the store's TypeScript
 * sources in plain Node): the database stays intact, every row decodes to its original text, and the next run continues
 * from the recorded position.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..');
let tmp: string;
let file: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-migrate-kill-'));
  file = path.join(tmp, 'data.db');
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

test('迁移进程在批与批之间/批中被杀：库完好，每行都能解码成原文，下次从记录的位置继续做完', async () => {
  const originals = new Map<number, string>();
  const db = new Database(file);
  db.exec(SCHEMA_SQL_V13);
  db.exec(`INSERT INTO meta (key, value) VALUES ('epoch', 'e'), ('hook_stat_ready', '1')`);
  const ins = db.prepare(`INSERT INTO raw_event (source, file, "offset", line_hash, record_type, session_id, body) VALUES ('transcript', 'p/s1.jsonl', ?, ?, 'x', 's1', ?)`);
  db.transaction(() => {
    for (let i = 0; i < 4000; i++) {
      const line = JSON.stringify({ type: 'x', i, pad: `record ${i} of the old database `.repeat(40) });
      originals.set(Number(ins.run(i, createHash('sha1').update(line).digest('hex'), line).lastInsertRowid), line);
    }
  })();
  db.close();

  const child = spawn(process.execPath, ['--import', './test/child/ts-register.mjs', './test/child/migrate-child.mjs', file, '20'], {
    cwd: SERVER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString();
      if ((out.match(/^batch /gm) ?? []).length >= 8) {
        child.kill('SIGKILL'); // most likely in the middle of the next batch
        resolve();
      }
      if (out.includes('done')) reject(new Error('the child finished before it was killed'));
    });
    child.on('exit', () => resolve());
  });
  await exited;
  expect(stderr).toBe('');

  const check = new Database(file, { readonly: true });
  try {
    expect(check.pragma('integrity_check', { simple: true })).toBe('ok');
    const rows = check.prepare(`SELECT ingest_id AS id, data, enc FROM raw_event ORDER BY ingest_id`).all() as { id: number; data: unknown; enc: number }[];
    expect(rows).toHaveLength(originals.size);
    for (const r of rows) expect(decodeBody(r.data, r.enc)).toBe(originals.get(r.id));
    const after = Number(check.prepare(`SELECT value FROM meta WHERE key = ?`).pluck().get(STORAGE_META.rawAfter));
    expect(after).toBeGreaterThanOrEqual(8 * 20);
    expect(after).toBeLessThan(4000);
    // Rows up to the recorded position are converted; none after it (a batch cut short rolled back).
    expect(rows.filter((r) => r.id <= after).every((r) => r.enc === 1)).toBe(true);
    expect(rows.filter((r) => r.id > after).every((r) => r.enc === 0)).toBe(true);
  } finally {
    check.close();
  }

  const s = openStore(file);
  try {
    expect(migrateAll(s).failed).toBe(0);
    expect(s.getMeta(STORAGE_META.migration)).toBe('done');
    const raw = s.rawForSession('s1');
    expect(raw).toHaveLength(originals.size);
    for (const e of raw) expect(e.source === 'transcript' ? e.line : '').toBe(originals.get(e.ingestId));
  } finally {
    s.close();
  }
}, 120_000);
