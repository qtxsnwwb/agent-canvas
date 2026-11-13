import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Change, GraphEdge, GraphSnapshot } from '@agent-canvas/shared';
import { rebuildReason } from '../src/cli.js';
import { NORMALIZER_VERSION } from '../src/normalize/version.js';
import { openStore, type Store } from '../src/store/store.js';
import { SCHEMA_SQL_V13 } from './schema-v13.js';

let tmp: string;
let file: string;
let store: Store;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-store-edges-'));
  file = path.join(tmp, 'data.db');
  store = openStore(file);
  store.applyChanges([
    {
      type: 'session_upserted',
      session: {
        id: 's1', projectId: 'p', origin: 'claude', cwd: null, title: null, gitBranch: null, status: 'idle', sourceDeleted: false,
        startedAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z',
      },
    },
  ]);
});
afterEach(async () => {
  store.close();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

const edge = (from: string, to: string, kind: GraphEdge['kind'] = 'sequence', suffix = '', sessionId = 's1'): GraphEdge => ({
  id: `${from}->${to}${suffix}`,
  sessionId,
  from,
  to,
  kind,
});
const added = (e: GraphEdge): Change => ({ type: 'edge_added', edge: e });
const removed = (id: string, sessionId = 's1'): Change => ({ type: 'edge_removed', sessionId, id });
const edgesOf = (sessionId = 's1'): GraphEdge[] => store.getGraph(sessionId)!.edges;

test('边原样读回（id、sessionId、from、to、kind），顺序为写入顺序，替换的边移到最后', () => {
  const a = edge('n1', 'n2');
  const b = edge('n2', 'n3', 'spawn');
  const c = edge('n1', 'n3', 'fork', ':fork');
  store.applyChanges([added(a), added(b), added(c)]);
  expect(edgesOf()).toEqual([a, b, c]);
  const a2 = { ...a, kind: 'fork' as const };
  store.applyChanges([added(a2)]);
  expect(edgesOf()).toEqual([b, c, a2]);
  expect(JSON.parse(store.getGraphJson('s1')!) as GraphSnapshot).toEqual(store.getGraph('s1'));
});

test('getGraphJson 里每条边的 JSON 与 JSON.stringify(edge) 一致', () => {
  const a = edge('n1', 'n2');
  store.applyChanges([added(a)]);
  expect(store.getGraphJson('s1')).toContain(`"edges":[${JSON.stringify(a)}]`);
});

test('按 id 删除：普通边、带 :fork 后缀的边，以及节点 id 里带 "->" 或以 ":fork" 结尾的边', () => {
  const plain = edge('n1', 'n2');
  const fork = edge('n1', 'n2', 'fork', ':fork');
  const arrows = edge('a->b', 'c->d');
  const forky = edge('x', 'y:fork');
  const forkyFork = edge('x', 'y:fork', 'fork', ':fork');
  store.applyChanges([plain, fork, arrows, forky, forkyFork].map(added));
  expect(edgesOf()).toHaveLength(5);
  store.applyChanges([removed(fork.id)]);
  expect(edgesOf()).toEqual([plain, arrows, forky, forkyFork]);
  store.applyChanges([removed(arrows.id), removed(forky.id)]);
  expect(edgesOf()).toEqual([plain, forkyFork]);
  store.applyChanges([removed(forkyFork.id), removed(plain.id), removed('no->such')]);
  expect(edgesOf()).toEqual([]);
});

test('id 不是 from->to 形式的边也能存、读、删', () => {
  const odd: GraphEdge = { id: 'custom-edge-1', sessionId: 's1', from: 'n1', to: 'n2', kind: 'sequence' };
  const normal = edge('n1', 'n2');
  store.applyChanges([added(odd), added(normal)]);
  expect(edgesOf()).toEqual([odd, normal]);
  store.applyChanges([removed('custom-edge-1')]);
  expect(edgesOf()).toEqual([normal]);
});

test('按会话删除、清空派生数据都带上边；不同会话互不影响', () => {
  store.applyChanges([added(edge('n1', 'n2')), added(edge('n1', 'n2', 'sequence', '', 's2'))]);
  store.transaction(() => store.deleteDerivedForSession('s1'));
  expect(store.getGraph('s1')).toBeNull();
  const db = new Database(file, { readonly: true });
  try {
    expect(db.prepare(`SELECT COUNT(*) AS n FROM edge`).get()).toEqual({ n: 1 });
  } finally {
    db.close();
  }
  store.clearDerived();
  const db2 = new Database(file, { readonly: true });
  try {
    expect(db2.prepare(`SELECT COUNT(*) AS n FROM edge`).get()).toEqual({ n: 0 });
  } finally {
    db2.close();
  }
});

test('表结构：WITHOUT ROWID，没有 JSON body，也没有单独的主键索引', () => {
  const db = new Database(file, { readonly: true });
  try {
    const sql = (db.prepare(`SELECT sql FROM sqlite_schema WHERE name = 'edge'`).get() as { sql: string }).sql;
    expect(sql).toMatch(/WITHOUT ROWID/i);
    const cols = (db.prepare(`PRAGMA table_info(edge)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain('body');
    expect(cols).not.toContain('id');
    expect(db.prepare(`SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'edge'`).all()).toEqual([]);
  } finally {
    db.close();
  }
});

test('旧库：旧的 edge 表被换成新结构（派生数据，重建补回），并且会触发重建', () => {
  store.close();
  const oldFile = path.join(tmp, 'old.db');
  const old = new Database(oldFile);
  old.exec(SCHEMA_SQL_V13);
  old.exec(`INSERT INTO meta (key, value) VALUES ('epoch', 'e'), ('hook_stat_ready', '1'), ('normalizer_version', '29')`);
  old.prepare(`INSERT INTO edge (session_id, id, body) VALUES ('s1', 'n1->n2', ?)`).run(JSON.stringify(edge('n1', 'n2')));
  old.prepare(`INSERT INTO raw_event (source, file, "offset", line_hash, record_type, session_id, body) VALUES ('transcript', 'p/s1.jsonl', 0, 'h', 'user', 's1', '{}')`).run();
  old.close();
  store = openStore(oldFile);
  const db = new Database(oldFile, { readonly: true });
  try {
    expect((db.prepare(`SELECT sql FROM sqlite_schema WHERE name = 'edge'`).get() as { sql: string }).sql).toMatch(/WITHOUT ROWID/i);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM edge`).get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
  expect(NORMALIZER_VERSION).toBeGreaterThan(29);
  expect(rebuildReason(store)).toBe(`normalizer version 29 -> ${NORMALIZER_VERSION}`);
});
