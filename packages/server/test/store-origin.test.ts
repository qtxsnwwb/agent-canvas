import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Change, Origin, Session } from '@claude-canvas/shared';
import { openStore, type Store } from '../src/store/store.js';
import { SCHEMA_SQL_V13 } from './schema-v13.js';

let store: Store;
let tmp: string;
beforeEach(async () => {
  store = openStore(':memory:');
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-store-origin-'));
});
afterEach(async () => {
  store.close();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

function upsert(id: string, projectId: string, origin: Origin, cwd: string | null = null): Change {
  const session: Session = {
    id,
    projectId,
    origin,
    cwd,
    title: null,
    gitBranch: null,
    status: 'idle',
    sourceDeleted: false,
    startedAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-01-01T00:00:00.000Z',
  };
  return { type: 'session_upserted', session };
}

test('会话的 origin 原样存取；listProjects 给出项目里出现过的来源（按名字排序）', () => {
  store.applyChanges([upsert('a', 'p1', 'codex'), upsert('b', 'p1', 'claude'), upsert('c', 'p1', 'codex'), upsert('d', 'p2', 'claude')]);
  expect(store.getSession('a')!.origin).toBe('codex');
  expect(store.listSessions('p1').map((s) => s.origin).sort()).toEqual(['claude', 'codex', 'codex']);
  const projects = store.listProjects(Date.now());
  expect(projects.map((p) => [p.id, p.sessionCount, p.origins])).toEqual([
    ['p1', 3, ['claude', 'codex']],
    ['p2', 1, ['claude']],
  ]);
});

test('按来源拆分不改变项目 cwd 的选取（最多的那个，平局取字典序最小）', () => {
  const cwdA = 'D:\\work\\app';
  const cwdB = 'D:/work/app';
  store.applyChanges([
    upsert('a', 'D--work-app', 'claude', cwdB),
    upsert('b', 'D--work-app', 'codex', cwdB),
    upsert('c', 'D--work-app', 'claude', cwdA),
    upsert('d', 'D--work-app', 'claude', cwdA),
    upsert('e', 'D--work-app', 'codex', cwdB),
  ]);
  // cwdB: 3 sessions over two origins, cwdA: 2 sessions.
  expect(store.listProjects(Date.now())[0]).toMatchObject({ cwd: cwdB, sessionCount: 5, origins: ['claude', 'codex'] });
});

test('原始事件带 origin：缺省为 claude；transcript 可带 projectId 并在读回时保留', () => {
  store.insertRaw({ source: 'transcript', file: 'p/s1.jsonl', offset: 0, line: '{"type":"user"}', recordType: 'user', sessionId: 's1', agentId: null });
  store.insertRaw({
    source: 'transcript',
    origin: 'codex',
    file: 'codex:2026/11/11/rollout-x.jsonl',
    offset: 0,
    line: '{"type":"session_meta"}',
    recordType: 'session_meta',
    sessionId: 's1',
    agentId: 't2',
    projectId: 'D--work-app',
  });
  store.insertRaw({ source: 'hook', receivedAt: '2026-01-01T00:00:01.000Z', eventName: 'Stop', sessionId: 's1', payload: '{}' });
  store.insertRaw({ source: 'meta', origin: 'codex', file: 'codex-index', sessionId: 's1', agentId: null, payload: '{}' });
  const raw = store.rawForSession('s1');
  expect(raw.map((e) => e.origin)).toEqual(['claude', 'codex', 'claude', 'codex']);
  expect(raw[0]).toMatchObject({ source: 'transcript', projectId: null });
  expect(raw[1]).toMatchObject({ source: 'transcript', projectId: 'D--work-app', agentId: 't2', file: 'codex:2026/11/11/rollout-x.jsonl' });
});

test('hook 计数按（来源，事件名）分开；hookEventStats 默认是 claude，allHookEventStats 带来源', () => {
  const hook = (eventName: string, receivedAt: string, origin?: Origin) =>
    store.insertRaw({ source: 'hook', origin, receivedAt, eventName, sessionId: 's1', payload: '{}' });
  hook('Stop', '2026-01-01T00:00:02.000Z');
  hook('Stop', '2026-01-01T00:00:05.000Z', 'codex');
  hook('Stop', '2026-01-01T00:00:03.000Z', 'claude');
  hook('PreToolUse', '2026-01-01T00:00:04.000Z', 'codex');
  expect(store.hookEventStats()).toEqual([{ eventName: 'Stop', count: 2, lastAt: '2026-01-01T00:00:03.000Z' }]);
  expect(store.hookEventStats('codex')).toEqual([
    { eventName: 'PreToolUse', count: 1, lastAt: '2026-01-01T00:00:04.000Z' },
    { eventName: 'Stop', count: 1, lastAt: '2026-01-01T00:00:05.000Z' },
  ]);
  expect(store.allHookEventStats()).toEqual([
    { origin: 'claude', eventName: 'Stop', count: 2, lastAt: '2026-01-01T00:00:03.000Z' },
    { origin: 'codex', eventName: 'PreToolUse', count: 1, lastAt: '2026-01-01T00:00:04.000Z' },
    { origin: 'codex', eventName: 'Stop', count: 1, lastAt: '2026-01-01T00:00:05.000Z' },
  ]);
  expect(store.lastHookAt()).toBe('2026-01-01T00:00:05.000Z');
});

test('迁移：上一版本的数据库打开后，原始事件都是 claude，hook 计数保留在 claude 名下，其余数据不变', () => {
  const file = path.join(tmp, 'old.db');
  const old = new Database(file);
  old.exec(SCHEMA_SQL_V13);
  old.exec(`INSERT INTO meta (key, value) VALUES ('epoch', 'old-epoch'), ('hook_stat_ready', '1'), ('normalizer_version', '13'),
    ('last_hook_at', '2026-01-01T00:00:07.000Z')`);
  old.prepare(`INSERT INTO raw_event (source, file, "offset", line_hash, record_type, session_id, agent_id, body)
    VALUES ('transcript', 'proj/s1.jsonl', 0, ?, 'user', 's1', NULL, '{"type":"user"}')`).run(createHash('sha1').update('{"type":"user"}').digest('hex'));
  old.exec(`INSERT INTO raw_event (source, event_name, received_at, session_id, project_id, body)
    VALUES ('hook', 'Stop', '2026-01-01T00:00:07.000Z', 's1', 'proj', '{}')`);
  old.exec(`INSERT INTO raw_event (source, file, session_id, agent_id, body)
    VALUES ('meta', 'proj/s1/custom-title.json', 's1', NULL, '{"customTitle":"T"}')`);
  old.exec(`INSERT INTO hook_stat (event_name, count, last_at) VALUES ('Stop', 4, '2026-01-01T00:00:07.000Z'),
    ('PreToolUse', 2, '2026-01-01T00:00:03.000Z')`);
  old.exec(`INSERT INTO file_offset (file, "offset", size) VALUES ('proj/s1.jsonl', 16, 16)`);
  const oldBody = JSON.stringify({
    id: 's1', projectId: 'proj', cwd: null, title: null, gitBranch: null, status: 'idle', sourceDeleted: false,
    startedAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z',
  });
  old.prepare(`INSERT INTO session (id, project_id, status, last_activity_at, body) VALUES ('s1', 'proj', 'idle', ?, ?)`).run(
    '2026-01-01T00:00:00.000Z',
    oldBody,
  );
  old.close();

  const s = openStore(file);
  try {
    expect(s.epoch()).toBe('old-epoch');
    expect(s.getMeta('normalizer_version')).toBe('13'); // the store does not touch it: start's rebuild check does
    const raw = s.rawForSession('s1');
    expect(raw.map((e) => [e.source, e.origin])).toEqual([
      ['transcript', 'claude'],
      ['hook', 'claude'],
      ['meta', 'claude'],
    ]);
    expect(raw[1]).toMatchObject({ source: 'hook', projectId: 'proj' });
    expect(s.hookEventStats()).toEqual([
      { eventName: 'PreToolUse', count: 2, lastAt: '2026-01-01T00:00:03.000Z' },
      { eventName: 'Stop', count: 4, lastAt: '2026-01-01T00:00:07.000Z' },
    ]);
    expect(s.hookEventStats('codex')).toEqual([]);
    expect(s.lastHookAt()).toBe('2026-01-01T00:00:07.000Z');
    expect(s.listOffsets()).toEqual([{ path: 'proj/s1.jsonl', offset: 16, size: 16 }]);
    // A session row written before sessions had an origin counts as claude.
    expect(s.listProjects(Date.now())).toEqual([expect.objectContaining({ id: 'proj', sessionCount: 1, origins: ['claude'] })]);
    // The transcript dedupe still holds for rows written before the migration.
    expect(
      s.insertRaw({ source: 'transcript', file: 'proj/s1.jsonl', offset: 0, line: '{"type":"user"}', recordType: 'user', sessionId: 's1', agentId: null }),
    ).toBeNull();
    // New counters go per origin, next to the migrated ones.
    s.insertRaw({ source: 'hook', origin: 'codex', receivedAt: '2026-01-01T00:00:09.000Z', eventName: 'Stop', sessionId: 's2', payload: '{}' });
    s.insertRaw({ source: 'hook', receivedAt: '2026-01-01T00:00:08.000Z', eventName: 'Stop', sessionId: 's1', payload: '{}' });
    expect(s.allHookEventStats()).toEqual([
      { origin: 'claude', eventName: 'PreToolUse', count: 2, lastAt: '2026-01-01T00:00:03.000Z' },
      { origin: 'claude', eventName: 'Stop', count: 5, lastAt: '2026-01-01T00:00:08.000Z' },
      { origin: 'codex', eventName: 'Stop', count: 1, lastAt: '2026-01-01T00:00:09.000Z' },
    ]);
  } finally {
    s.close();
  }

  // Reopening an already migrated database changes nothing.
  const again = openStore(file);
  try {
    expect(again.allHookEventStats()).toHaveLength(3);
    expect(again.rawForSession('s1')).toHaveLength(4); // 3 migrated + the claude hook
  } finally {
    again.close();
  }
  const check = new Database(file, { readonly: true });
  try {
    const cols = (t: string) => (check.prepare(`PRAGMA table_info(${t})`).all() as { name: string; pk: number }[]);
    expect(cols('raw_event').map((c) => c.name)).toContain('origin');
    expect(cols('hook_stat').filter((c) => c.pk > 0).map((c) => c.name)).toEqual(['origin', 'event_name']);
    const tables = (check.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name);
    expect(tables.filter((t) => t.startsWith('hook_stat'))).toEqual(['hook_stat']);
  } finally {
    check.close();
  }
});

test('迁移：hook_stat 出现之前的数据库（没有计数表）仍回填一次，记在 claude 名下', () => {
  const file = path.join(tmp, 'older.db');
  const old = new Database(file);
  old.exec(SCHEMA_SQL_V13);
  old.exec(`DROP TABLE hook_stat`);
  old.exec(`INSERT INTO meta (key, value) VALUES ('epoch', 'e')`);
  old.exec(`INSERT INTO raw_event (source, event_name, received_at, session_id, body) VALUES
    ('hook', 'Stop', '2026-01-01T00:00:02.000Z', 's1', '{}'), ('hook', 'Stop', '2026-01-01T00:00:05.000Z', 's1', '{}')`);
  old.close();
  const s = openStore(file);
  try {
    expect(s.allHookEventStats()).toEqual([{ origin: 'claude', eventName: 'Stop', count: 2, lastAt: '2026-01-01T00:00:05.000Z' }]);
  } finally {
    s.close();
  }
});

test('transcriptFileOwner：某个键的转写原始事件存的会话、线程和项目（走去重索引）；sessionProjectIds：会话的项目 id', () => {
  const base = { source: 'transcript' as const, origin: 'codex' as const, offset: 0, recordType: 'event_msg' };
  store.insertRaw({ ...base, file: 'codex:a/rollout-1.jsonl', line: '{"a":1}', sessionId: 'root', agentId: null, projectId: 'D--x' });
  store.insertRaw({ ...base, file: 'codex:a/rollout-2.jsonl', line: '{"a":1}', sessionId: 'root', agentId: 'sub', projectId: 'D--x' });
  expect(store.transcriptFileOwner('codex:a/rollout-1.jsonl')).toEqual({ sessionId: 'root', agentId: null, projectId: 'D--x' });
  expect(store.transcriptFileOwner('codex:a/rollout-2.jsonl')).toEqual({ sessionId: 'root', agentId: 'sub', projectId: 'D--x' });
  expect(store.transcriptFileOwner('codex:a/missing.jsonl')).toBeNull();
  store.insertRaw({ source: 'meta', origin: 'codex', file: 'codex:index/root', sessionId: 'root', agentId: null, payload: '{}' });
  expect(store.transcriptFileOwner('codex:index/root')).toBeNull();

  const sql: string[] = [];
  const s = openStore(':memory:', { verbose: (q) => sql.push(String(q)) });
  try {
    s.transcriptFileOwner('k');
    const q = sql.find((x) => /FROM raw_event/.test(x) && /LIMIT 1/.test(x))!;
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE raw_event (ingest_id INTEGER PRIMARY KEY, source TEXT, file TEXT, line_hash TEXT, session_id TEXT, agent_id TEXT, project_id TEXT);
        CREATE UNIQUE INDEX raw_event_transcript_dedupe ON raw_event (file, line_hash) WHERE source = 'transcript';`);
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${q}`).all() as { detail: string }[]).map((r) => r.detail).join('\n');
      expect(plan).toMatch(/USING INDEX raw_event_transcript_dedupe/);
    } finally {
      db.close();
    }
  } finally {
    s.close();
  }

  expect(store.sessionProjectIds()).toEqual([]);
  store.applyChanges([upsert('s2', 'p-b', 'claude'), upsert('s1', 'p-a', 'codex'), upsert('s3', 'p-a', 'claude')]);
  expect(store.sessionProjectIds()).toEqual(['p-a', 'p-b']);
});
