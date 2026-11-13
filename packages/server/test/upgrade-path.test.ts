import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ContentSearchResponse, Diagnostics } from '@agent-canvas/shared';
import { start, type Running } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { decodeBody } from '../src/store/codec.js';
import { openStore } from '../src/store/store.js';
import { SCHEMA_SQL_V13 } from './schema-v13.js';

/*
 * The whole upgrade in one start: an old-format database (plain rows, old columns and edge table, old normalizer
 * version) -> start runs the rebuild, then in the background the compression migration, VACUUM and the search index
 * build. It ends with VACUUM done, the index complete, the same nodes as a fresh derivation, a search that finds a
 * prompt (after VACUUM: index rowids still match the nodes), every raw row compressed and integrity_check ok.
 */

let tmp: string;
let projectsDir: string;
let dataDir: string;
const apps: Running[] = [];
beforeEach(async () => {
  vi.stubEnv('AGENT_CANVAS_CODEX_DIR', '');
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-upgrade-path-'));
  projectsDir = path.join(tmp, 'projects');
  dataDir = path.join(tmp, 'data');
  await fs.mkdir(projectsDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.unstubAllEnvs();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

const T0 = Date.parse('2026-10-01T00:00:00.000Z');
function lines(): { file: string; sessionId: string; offset: number; line: string; type: string }[] {
  const out: { file: string; sessionId: string; offset: number; line: string; type: string }[] = [];
  for (let k = 0; k < 20; k++) {
    const sessionId = `sess-${k}`;
    let parent: string | null = null;
    for (let i = 0; i < 12; i++) {
      const uuid = `${sessionId}-${i}`;
      const filler = createHash('sha256').update(uuid).digest('hex').repeat(8);
      const timestamp = new Date(T0 + (k * 100 + i) * 1000).toISOString();
      const record =
        i % 2 === 0
          ? { type: 'user', uuid, parentUuid: parent, timestamp, sessionId, cwd: '/w', message: { role: 'user', content: `prompt zebracorn${k} ${filler}` } }
          : { type: 'assistant', uuid, parentUuid: parent, timestamp, sessionId, cwd: '/w', message: { id: `m-${uuid}`, role: 'assistant', content: [{ type: 'text', text: `reply ${filler}` }], usage: { input_tokens: 1, output_tokens: 1 } } };
      out.push({ file: `D--w/${sessionId}.jsonl`, sessionId, offset: i, line: JSON.stringify(record), type: record.type });
      parent = uuid;
    }
  }
  return out;
}

test('旧库一次启动：重建、压缩迁移、VACUUM、建索引都做完，节点数一致，检索可用，库完好', async () => {
  const rows = lines();
  // The reference: this build from the same raw rows.
  const ref = openStore(path.join(tmp, 'ref.db'));
  for (const r of rows) ref.insertRaw({ source: 'transcript', file: r.file, offset: r.offset, line: r.line, recordType: r.type, sessionId: r.sessionId, agentId: null });
  new Pipeline(ref, loadConfig({}, { projectsDir, dataDir: path.join(tmp, 'refdata'), cursorDbPath: null, codexSessionsDir: null })).rebuild();
  const refNodes = ref.allSessionIdsInRaw().reduce((n, id) => n + (ref.getGraph(id)?.nodes.length ?? 0), 0);
  ref.close();
  expect(refNodes).toBe(240);

  // The previous version's database: old schema, plain bodies, an old derived row or two, an old normalizer version.
  const file = path.join(dataDir, 'data.db');
  const old = new Database(file);
  old.exec(SCHEMA_SQL_V13);
  old.exec(`INSERT INTO meta (key, value) VALUES ('epoch', 'e'), ('hook_stat_ready', '1'), ('normalizer_version', '13')`);
  const ins = old.prepare(`INSERT INTO raw_event (source, file, "offset", line_hash, record_type, session_id, body) VALUES ('transcript', ?, ?, ?, ?, ?, ?)`);
  old.transaction(() => {
    for (const r of rows) ins.run(r.file, r.offset, createHash('sha1').update(r.line).digest('hex'), r.type, r.sessionId, r.line);
  })();
  old.exec(`INSERT INTO edge (session_id, id, body) VALUES ('sess-0', 'a->b', '{"id":"a->b"}')`);
  old.close();

  const app = await start(
    { projectsDir, dataDir, port: 0, cursorDbPath: null },
    { storage: { pollMs: 5, freeBytes: () => 10 ** 13 }, searchIndex: { pollMs: 5 } },
  );
  apps.push(app);
  let d: Diagnostics | null = null;
  for (let i = 0; i < 600; i++) {
    d = (await (await fetch(`${app.url}/api/diagnostics`)).json()) as Diagnostics;
    if (d.storage?.vacuum === 'done' && d.storage.migrating === false && d.search?.indexing === false) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(d!.storage).toMatchObject({ vacuum: 'done', migrating: false, lastError: null, unreadableDetails: 0 });
  expect(d!.search).toMatchObject({ indexing: false });
  const found = (await (await fetch(`${app.url}/api/search/content?q=zebracorn7`)).json()) as ContentSearchResponse;
  expect(found.indexing).toBe(false);
  expect([...new Set(found.hits.map((h) => h.sessionId))]).toEqual(['sess-7']);
  expect(found.hits.length).toBeGreaterThan(0);
  await apps.pop()!.close();

  const db = new Database(file, { readonly: true });
  try {
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.prepare(`SELECT COUNT(*) FROM node`).pluck().get()).toBe(refNodes);
    const raw = db.prepare(`SELECT data, enc FROM raw_event`).all() as { data: unknown; enc: number }[];
    expect(raw).toHaveLength(rows.length);
    expect(raw.every((r) => r.enc === 1)).toBe(true);
    for (const r of raw) decodeBody(r.data, r.enc);
    expect(db.prepare(`SELECT value FROM meta WHERE key = 'storage_format'`).pluck().get()).toBe('1');
  } finally {
    db.close();
  }
}, 120_000);
