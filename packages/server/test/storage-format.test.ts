import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GraphSnapshot } from '@agent-canvas/shared';
import { main, rebuildReason } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { NORMALIZER_VERSION } from '../src/normalize/version.js';
import { Pipeline } from '../src/pipeline.js';
import { decodeBody } from '../src/store/codec.js';
import { migrateAll } from '../src/store/migrate-storage.js';
import { NewerStorageFormatError, openStore, STORAGE_FORMAT, type RawEvent, type Store } from '../src/store/store.js';
import { assistantBlock, hook, toolResult, userPrompt } from './fixtures.js';

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-storage-format-'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

const sha1File = (f: string): string => createHash('sha1').update(fsSync.readFileSync(f)).digest('hex');

describe('storage_format', () => {
  test('新库记下 storage_format = 1', () => {
    const s = openStore(path.join(tmp, 'a.db'));
    try {
      expect(STORAGE_FORMAT).toBe(1);
      expect(s.getMeta('storage_format')).toBe('1');
    } finally {
      s.close();
    }
  });

  test('更新的版本写的库：拒绝打开，说明原因，文件一个字节都不改', () => {
    const file = path.join(tmp, 'newer.db');
    const db = new Database(file);
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('storage_format', '2')`);
    db.close();
    const before = sha1File(file);
    expect(() => openStore(file)).toThrow(NewerStorageFormatError);
    expect(() => openStore(file)).toThrow(/written by a newer version of agent-canvas \(storage format 2/);
    expect(sha1File(file)).toBe(before);
    const check = new Database(file, { readonly: true });
    try {
      expect(check.prepare(`SELECT name FROM sqlite_schema`).pluck().all()).toEqual(['meta', 'sqlite_autoindex_meta_1']);
    } finally {
      check.close();
    }
  });

  test('agent-canvas start 在更新版本的库上：退出码 1，打印原因', async () => {
    const dataDir = path.join(tmp, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    const db = new Database(path.join(dataDir, 'data.db'));
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('storage_format', '7')`);
    db.close();
    vi.stubEnv('AGENT_CANVAS_DATA_DIR', dataDir);
    vi.stubEnv('AGENT_CANVAS_PROJECTS_DIR', path.join(tmp, 'projects'));
    vi.stubEnv('AGENT_CANVAS_CODEX_DIR', '');
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => void errors.push(line));
    expect(await main(['start', '--port', '0'])).toBe(1);
    expect(errors.join('\n')).toMatch(/newer version/);
    await expect(fs.stat(path.join(dataDir, 'agent-canvas.lock'))).rejects.toThrow(); // lock released
  });
});

/*
 * The previous release's store module (from git, branch main), run against databases of both formats: a database it
 * wrote upgrades cleanly; a database of the new format makes it fail when it opens (its statements name the old
 * columns), before it can read or re-derive anything.
 */
const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let oldDir: string | null = null;
let oldStoreModule: { openStore: (file: string) => Store } | null = null;

beforeAll(async () => {
  try {
    const show = (p: string): string => execFileSync('git', ['show', `main:packages/server/src/store/${p}`], { cwd: SERVER, encoding: 'utf8' });
    const storeSrc = show('store.ts');
    const schemaSrc = show('schema.ts');
    // Leftovers of earlier runs (a held file may have kept one from being removed).
    for (const d of await fs.readdir(path.join(SERVER, '.tmp')).catch(() => [] as string[])) {
      if (d.startsWith('main-store-')) await fs.rm(path.join(SERVER, '.tmp', d), { recursive: true, force: true }).catch(() => undefined);
    }
    oldDir = path.join(SERVER, '.tmp', `main-store-${process.pid}-${Date.now()}`);
    await fs.mkdir(oldDir, { recursive: true });
    await fs.writeFile(path.join(oldDir, 'store.ts'), storeSrc);
    await fs.writeFile(path.join(oldDir, 'schema.ts'), schemaSrc);
    oldStoreModule = (await import(pathToFileURL(path.join(oldDir, 'store.ts')).href)) as typeof oldStoreModule;
  } catch {
    oldStoreModule = null; // no git or no main branch: these tests are skipped
  }
}, 120_000); // transforming the old module takes a few seconds
afterAll(async () => {
  // The old openStore leaves its connection open when it throws, so the file may still be held: best effort.
  if (oldDir !== null) await fs.rm(oldDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
});

describe('the previous release (main)', () => {
  const LONG = 'some tool output that is long enough to be compressed '.repeat(10);
  function events(): RawEvent[] {
    return [
      userPrompt('u1', null, `please ${LONG}`),
      assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: LONG } }),
      toolResult('u2', 'a1', 'tu1', LONG),
      assistantBlock('a2', 'u2', { type: 'text', text: `done ${LONG}` }),
      hook('Stop'),
    ];
  }
  const config = (): ReturnType<typeof loadConfig> =>
    loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), cursorDbPath: null, codexSessionsDir: null });
  const strip = (g: GraphSnapshot): unknown => ({ session: g.session, nodes: g.nodes, edges: g.edges });

  test('它写的库：打开时改名列、加 enc、换 edge 表，自动重建后与新库推导结果一致，迁移后每行都能解码', (ctx) => {
    if (oldStoreModule === null) return ctx.skip();
    const evs = events();
    // The reference: this build from the same raw events.
    const ref = openStore(path.join(tmp, 'ref.db'));
    for (const e of evs) ref.insertRaw(e);
    new Pipeline(ref, config()).rebuild();
    const reference = strip(ref.getGraph('s1')!);
    ref.close();

    // What the previous release leaves: its schema, plain bodies, its derived rows (edges as JSON bodies), version 29.
    const oldFile = path.join(tmp, 'old.db');
    const old = oldStoreModule.openStore(oldFile);
    for (const e of evs) old.insertRaw(e);
    old.applyChanges([
      { type: 'node_added', node: { ...(reference as { nodes: GraphSnapshot['nodes'] }).nodes[0]! }, detail: { text: LONG } },
      { type: 'edge_added', edge: { id: 'u1->a1', sessionId: 's1', from: 'u1', to: 'a1', kind: 'sequence' } },
    ]);
    old.setMeta('normalizer_version', '29');
    old.close();

    const s = openStore(oldFile);
    try {
      const db = new Database(oldFile, { readonly: true });
      try {
        const cols = (t: string): string[] => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
        expect(cols('raw_event')).toEqual(expect.arrayContaining(['data', 'enc']));
        expect(cols('raw_event')).not.toContain('body');
        expect(cols('node_detail')).toEqual(expect.arrayContaining(['data', 'enc']));
        expect(cols('node_detail')).not.toContain('detail');
        expect((db.prepare(`SELECT sql FROM sqlite_schema WHERE name = 'edge'`).get() as { sql: string }).sql).toMatch(/WITHOUT ROWID/);
      } finally {
        db.close();
      }
      expect(s.getMeta('storage_format')).toBe('1');
      expect(rebuildReason(s)).toBe(`normalizer version 29 -> ${NORMALIZER_VERSION}`);
      new Pipeline(s, config()).rebuild();
      expect(strip(s.getGraph('s1')!)).toEqual(reference);
      expect(migrateAll(s).failed).toBe(0);
    } finally {
      s.close();
    }
    const db = new Database(oldFile, { readonly: true });
    try {
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      const rows = db.prepare(`SELECT data, enc FROM raw_event`).all() as { data: unknown; enc: number }[];
      expect(rows.filter((r) => r.enc === 1).length).toBeGreaterThan(0);
      for (const r of rows) expect(() => decodeBody(r.data, r.enc)).not.toThrow();
    } finally {
      db.close();
    }
  });

  test('它打开新格式的库：一打开就失败（准备语句时找不到旧列），不会读到压缩行', (ctx) => {
    if (oldStoreModule === null) return ctx.skip();
    // In the old module's directory, removed after all tests: the old openStore leaves its connection open when it throws.
    const file = path.join(oldDir!, 'new.db');
    const s = openStore(file);
    for (const e of events()) s.insertRaw(e);
    s.close();
    expect(() => oldStoreModule!.openStore(file)).toThrow(/no such column: (body|detail)|has no column named (body|detail)/);
  });
});
