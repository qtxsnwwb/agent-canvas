import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Change, GraphNode } from '@agent-canvas/shared';
import { rebuildReason } from '../src/cli.js';
import { NORMALIZER_VERSION_KEY } from '../src/pipeline.js';
import { NORMALIZER_VERSION } from '../src/normalize/version.js';
import { openStore, type Store } from '../src/store/store.js';
import { SCHEMA_SQL_V13 } from './schema-v13.js';

// Temp dirs only. node_removed deletes a node's incoming edges through the edge_to index (session_id, to_id).
let tmp: string;
const stores: Store[] = [];
const open = (file: string): Store => {
  const s = openStore(file);
  stores.push(s);
  return s;
};
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-edge-to-'));
});
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

const hasEdgeToIndex = (file: string): boolean => {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'edge_to' AND tbl_name = 'edge'`).get() !== undefined;
  } finally {
    db.close();
  }
};

const node = (id: string): GraphNode => ({
  id, sessionId: 's1', turnId: null, agentId: null, childAgentId: null, parentId: null, kind: 'system', status: null,
  timestamp: '2026-11-01T00:00:00.000Z', confirmed: true, title: 'system', summary: '', toolName: null, toolUseId: null,
  messageId: null, durationMs: null, endedAt: null, usage: null, systemSubtype: null,
});
const session: Change = {
  type: 'session_upserted',
  session: {
    id: 's1', projectId: 'proj', origin: 'gemini', cwd: null, title: null, gitBranch: null, status: 'idle',
    sourceDeleted: false, startedAt: '2026-11-01T00:00:00.000Z', lastActivityAt: '2026-11-01T00:00:00.000Z',
  },
};

test('removing 2,000 nodes from a session of 60,000 chained edges is fast and leaves exactly the other edges', () => {
  const N = 60_000;
  const store = open(path.join(tmp, 'big.db'));
  const id = (i: number): string => `n${String(i).padStart(5, '0')}`;
  const build: Change[] = [session];
  for (let i = 0; i < N; i++) build.push({ type: 'node_added', node: node(id(i)), detail: {} });
  for (let i = 0; i + 1 < N; i++) build.push({ type: 'edge_added', edge: { id: `${id(i)}->${id(i + 1)}`, sessionId: 's1', from: id(i), to: id(i + 1), kind: 'sequence' } });
  store.applyChanges(build);
  expect(store.sessionEdges('s1')).toHaveLength(N - 1);

  // Every 30th node from 15 on: never adjacent, never the first or the last, so each removal takes exactly two edges.
  const removed = new Set<string>();
  for (let i = 15; removed.size < 2000; i += 30) removed.add(id(i));
  const started = performance.now();
  store.applyChanges([...removed].map((r): Change => ({ type: 'node_removed', sessionId: 's1', id: r })));
  const elapsed = performance.now() - started;
  expect(elapsed).toBeLessThan(2000); // the scan of every edge per removal took 7-9 s here

  const edges = store.sessionEdges('s1');
  expect(edges).toHaveLength(N - 1 - 2 * removed.size);
  expect(edges.some((e) => removed.has(e.from) || removed.has(e.to))).toBe(false);
  const expected = new Set<string>();
  for (let i = 0; i + 1 < N; i++) if (!removed.has(id(i)) && !removed.has(id(i + 1))) expected.add(`${id(i)}->${id(i + 1)}`);
  expect(new Set(edges.map((e) => e.id))).toEqual(expected);
  expect(store.nodePage('s1', null, N).length).toBe(N - removed.size);
}, 120_000);

test('a new database has the edge_to index', () => {
  const file = path.join(tmp, 'new.db');
  open(file);
  expect(hasEdgeToIndex(file)).toBe(true);
});

test('an existing database without the index gets it on open; no rebuild, normalizer version untouched', () => {
  const file = path.join(tmp, 'existing.db');
  const first = open(file);
  first.applyChanges([
    session,
    { type: 'node_added', node: node('a'), detail: {} },
    { type: 'node_added', node: node('b'), detail: {} },
    { type: 'edge_added', edge: { id: 'a->b', sessionId: 's1', from: 'a', to: 'b', kind: 'sequence' } },
  ]);
  first.setMeta(NORMALIZER_VERSION_KEY, String(NORMALIZER_VERSION));
  first.close();
  stores.splice(stores.indexOf(first), 1);
  const raw = new Database(file);
  raw.exec('DROP INDEX edge_to'); // as written by a build before the index existed
  raw.close();
  expect(hasEdgeToIndex(file)).toBe(false);

  const store = open(file);
  expect(hasEdgeToIndex(file)).toBe(true);
  expect(rebuildReason(store)).toBeNull();
  expect(store.sessionEdges('s1').map((e) => e.id)).toEqual(['a->b']);
  store.applyChanges([{ type: 'node_removed', sessionId: 's1', id: 'b' }]);
  expect(store.sessionEdges('s1')).toEqual([]);
});

test('a database migrated from the old edge layout gets the index too (the migration recreates the table)', () => {
  const file = path.join(tmp, 'v13.db');
  const old = new Database(file);
  old.exec(SCHEMA_SQL_V13);
  old.exec(`INSERT INTO meta (key, value) VALUES ('epoch', 'e'), ('hook_stat_ready', '1'), ('normalizer_version', '29')`);
  old.close();
  open(file);
  expect(hasEdgeToIndex(file)).toBe(true);
});

test("an older build's statements still work on a database that has the index", () => {
  const file = path.join(tmp, 'compat.db');
  const store = open(file);
  store.applyChanges([session]);
  store.close();
  stores.splice(stores.indexOf(store), 1);
  // What a build before the index does with the edge table: its own schema statement, writes, reads and deletes.
  const db = new Database(file);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS edge (session_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, tag TEXT NOT NULL,
      kind INTEGER NOT NULL, ord INTEGER NOT NULL, PRIMARY KEY (session_id, from_id, to_id, tag)) WITHOUT ROWID`);
    const insert = db.prepare(`INSERT OR REPLACE INTO edge (session_id, from_id, to_id, tag, kind, ord) VALUES (?, ?, ?, ?, ?, ?)`);
    insert.run('s1', 'a', 'b', '', 0, 1);
    insert.run('s1', 'b', 'c', '', 0, 2);
    db.prepare(`DELETE FROM edge WHERE session_id = ? AND (from_id = ? OR to_id = ?)`).run('s1', 'b', 'b');
    expect(db.prepare(`SELECT COUNT(*) FROM edge`).pluck().get()).toBe(0);
    insert.run('s1', 'x', 'y', '', 0, 3);
    db.exec(`DELETE FROM edge`);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  } finally {
    db.close();
  }
  expect(hasEdgeToIndex(file)).toBe(true);
});
