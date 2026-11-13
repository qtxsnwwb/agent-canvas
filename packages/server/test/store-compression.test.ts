import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Change, GraphNode } from '@agent-canvas/shared';
import { encodeBody } from '../src/store/codec.js';
import { openStore, type Store } from '../src/store/store.js';
import { SCHEMA_SQL_V13 } from './schema-v13.js';

let tmp: string;
let file: string;
let store: Store;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-store-compress-'));
  file = path.join(tmp, 'data.db');
  store = openStore(file);
});
afterEach(async () => {
  store.close();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

const LONG = JSON.stringify({ type: 'user', message: { content: 'some tool output line\n'.repeat(200) } });
const SHORT = '{"type":"user"}';
const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');

/** A second connection on the same file, for looking at what is stored (read only). */
function peek<T>(sql: string, ...params: unknown[]): T[] {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

function node(id: string, sessionId = 's1'): GraphNode {
  return {
    id, sessionId, turnId: null, agentId: null, parentId: null, kind: 'tool', status: 'running', timestamp: '2026-01-01T00:00:00.000Z',
    confirmed: true, title: 'Read', summary: '', toolName: 'Read', toolUseId: null, messageId: null, durationMs: null, usage: null,
    systemSubtype: null, childAgentId: null, endedAt: null,
  };
}

describe('schema', () => {
  test('新库：raw_event 和 node_detail 都有 enc 列，默认 0', () => {
    for (const table of ['raw_event', 'node_detail']) {
      const cols = peek<{ name: string; dflt_value: string; notnull: number }>(`PRAGMA table_info(${table})`);
      expect(cols.find((c) => c.name === 'enc')).toMatchObject({ dflt_value: '0', notnull: 1 });
    }
  });

  test('旧库打开后补上 enc 列，旧行都是 0，内容不变', async () => {
    store.close();
    const oldFile = path.join(tmp, 'old.db');
    const old = new Database(oldFile);
    old.exec(SCHEMA_SQL_V13);
    old.prepare(`INSERT INTO raw_event (source, file, "offset", line_hash, record_type, session_id, body) VALUES ('transcript', 'p/s1.jsonl', 0, ?, 'user', 's1', ?)`).run(sha1(LONG), LONG);
    old.prepare(`INSERT INTO node_detail (session_id, node_id, detail) VALUES ('s1', 'n1', ?)`).run(JSON.stringify({ text: 'x'.repeat(500) }));
    old.close();
    store = openStore(oldFile);
    file = oldFile;
    expect(peek(`SELECT enc, typeof(body) AS t FROM raw_event`)).toEqual([{ enc: 0, t: 'text' }]);
    expect(peek(`SELECT enc FROM node_detail`)).toEqual([{ enc: 0 }]);
    expect(store.rawForSession('s1')).toMatchObject([{ source: 'transcript', line: LONG }]);
  });
});

describe('写入', () => {
  test('长原始记录压缩存放（BLOB、enc 1），短的原样（TEXT、enc 0）；读回逐字一致', () => {
    store.insertRaw({ source: 'transcript', file: 'p/s1.jsonl', offset: 0, line: LONG, recordType: 'user', sessionId: 's1', agentId: null });
    store.insertRaw({ source: 'transcript', file: 'p/s1.jsonl', offset: 1, line: SHORT, recordType: 'user', sessionId: 's1', agentId: null });
    store.insertRaw({ source: 'hook', receivedAt: '2026-01-01T00:00:00.000Z', eventName: 'Stop', sessionId: 's1', payload: LONG });
    store.insertRaw({ source: 'meta', file: 'p/s1/custom-title.json', sessionId: 's1', agentId: null, payload: LONG });
    const rows = peek<{ enc: number; t: string; len: number }>(`SELECT enc, typeof(body) AS t, length(body) AS len FROM raw_event ORDER BY ingest_id`);
    expect(rows.map((r) => [r.enc, r.t])).toEqual([
      [1, 'blob'],
      [0, 'text'],
      [1, 'blob'],
      [1, 'blob'],
    ]);
    expect(rows[0]!.len).toBeLessThan(LONG.length / 4);
    const raw = store.rawForSession('s1');
    expect(raw.map((e) => (e.source === 'transcript' ? e.line : e.payload))).toEqual([LONG, SHORT, LONG, LONG]);
    expect(store.latestMeta('p/s1/custom-title.json')).toBe(LONG);
  });

  test('去重仍按原文的 line_hash：同一行再插入是重复，line_hash 是原文的 sha1', () => {
    const ev = { source: 'transcript' as const, file: 'p/s1.jsonl', offset: 0, line: LONG, recordType: 'user', sessionId: 's1', agentId: null };
    expect(store.insertRaw(ev)).toBe(1);
    expect(store.insertRaw({ ...ev, offset: 99 })).toBeNull();
    expect(store.hasTranscriptLine('p/s1.jsonl', LONG)).toBe(true);
    expect(peek(`SELECT line_hash FROM raw_event`)).toEqual([{ line_hash: sha1(LONG) }]);
  });

  test('节点详情压缩存放；更新时在旧详情上合并', () => {
    const detail = { input: { command: 'ls -la '.repeat(100) }, output: null, text: null, raw: null };
    const changes: Change[] = [{ type: 'node_added', node: node('n1'), detail }];
    store.applyChanges(changes);
    expect(peek(`SELECT enc, typeof(detail) AS t FROM node_detail`)).toEqual([{ enc: 1, t: 'blob' }]);
    expect(store.getNodeDetail('s1', 'n1')).toEqual({ ...detail, nodeId: 'n1' });
    store.applyChanges([{ type: 'node_updated', sessionId: 's1', id: 'n1', patch: {}, detail: { output: 'done' } }]);
    expect(store.getNodeDetail('s1', 'n1')).toEqual({ ...detail, output: 'done', nodeId: 'n1' });
    store.applyChanges([{ type: 'node_added', node: node('n2'), detail: { text: 'hi' } }]);
    expect(peek(`SELECT enc FROM node_detail WHERE node_id = 'n2'`)).toEqual([{ enc: 0 }]);
    expect(store.getNodeDetail('s1', 'n2')).toMatchObject({ text: 'hi', input: null });
  });
});

describe('新旧行并存', () => {
  /** Writes rows the way the previous version did: plain text, enc 0 (the column default). */
  function writeOld(sql: string, ...params: unknown[]): void {
    const db = new Database(file);
    try {
      db.prepare(sql).run(...params);
    } finally {
      db.close();
    }
  }

  test('rawForSession / rawForSessionAfter / latestMeta 读两种行', () => {
    writeOld(`INSERT INTO raw_event (source, file, "offset", line_hash, record_type, session_id, body) VALUES ('transcript', 'p/s1.jsonl', 0, ?, 'user', 's1', ?)`, sha1(LONG), LONG);
    writeOld(`INSERT INTO raw_event (source, file, session_id, body) VALUES ('meta', 'p/s1/custom-title.json', 's1', ?)`, `${LONG}old`);
    store.insertRaw({ source: 'transcript', file: 'p/s1.jsonl', offset: 1, line: `${LONG} `, recordType: 'user', sessionId: 's1', agentId: null });
    expect(store.latestMeta('p/s1/custom-title.json')).toBe(`${LONG}old`);
    store.insertRaw({ source: 'meta', file: 'p/s1/custom-title.json', sessionId: 's1', agentId: null, payload: `${LONG}new` });
    expect(store.latestMeta('p/s1/custom-title.json')).toBe(`${LONG}new`);
    expect(peek(`SELECT enc FROM raw_event ORDER BY ingest_id`)).toEqual([{ enc: 0 }, { enc: 0 }, { enc: 1 }, { enc: 1 }]);
    const all = store.rawForSession('s1');
    expect(all.map((e) => (e.source === 'transcript' ? e.line : e.payload))).toEqual([LONG, `${LONG}old`, `${LONG} `, `${LONG}new`]);
    expect(store.rawForSessionAfter('s1', 0, 10)).toEqual(all);
    // The byte budget counts the text, not the stored (compressed) size: one long row reaches a budget below its length.
    expect(store.rawForSessionAfter('s1', 0, 10, LONG.length - 1)).toHaveLength(1);
    expect(store.rawForSessionAfter('s1', 0, 10, 2 * LONG.length + 4)).toHaveLength(3);
    expect(store.hasTranscriptLine('p/s1.jsonl', LONG)).toBe(true);
  });

  test('getNodeDetail 和合并更新读旧详情', () => {
    store.applyChanges([{ type: 'node_added', node: node('n1'), detail: {} }]);
    writeOld(`UPDATE node_detail SET detail = ? WHERE node_id = 'n1'`, JSON.stringify({ input: { a: 'q'.repeat(400) } }));
    expect(store.getNodeDetail('s1', 'n1')).toMatchObject({ input: { a: 'q'.repeat(400) } });
    store.applyChanges([{ type: 'node_updated', sessionId: 's1', id: 'n1', patch: {}, detail: { output: 'o'.repeat(400) } }]);
    expect(peek(`SELECT enc FROM node_detail`)).toEqual([{ enc: 1 }]);
    expect(store.getNodeDetail('s1', 'n1')).toMatchObject({ input: { a: 'q'.repeat(400) }, output: 'o'.repeat(400) });
  });
});

describe('损坏的行', () => {
  function corrupt(sql: string): void {
    const db = new Database(file);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  }

  test('原始记录解压失败：读出来带 corrupt 标记，不抛出，前后的行照常', () => {
    for (let i = 0; i < 3; i++) {
      store.insertRaw({ source: 'transcript', file: 'p/s1.jsonl', offset: i, line: `${LONG}${i}`, recordType: 'user', sessionId: 's1', agentId: null });
    }
    corrupt(`UPDATE raw_event SET body = x'00112233445566' WHERE ingest_id = 2`);
    const page = store.rawForSessionAfter('s1', 0, 10, 10 ** 9);
    expect(page.map((e) => e.ingestId)).toEqual([1, 2, 3]);
    expect(page[0]!.corrupt).toBeUndefined();
    expect(page[1]!.corrupt).toMatch(/corrupt stored body/);
    expect(page[1]).toMatchObject({ source: 'transcript', file: 'p/s1.jsonl', line: '' });
    expect(page[2]).toMatchObject({ line: `${LONG}2` });
    expect(store.rawForSession('s1')).toHaveLength(3);
  });

  test('最近的 meta 解压失败时当作没有（下一次会重新写入）', () => {
    store.insertRaw({ source: 'meta', file: 'p/s1/custom-title.json', sessionId: 's1', agentId: null, payload: LONG });
    corrupt(`UPDATE raw_event SET body = x'0011' WHERE ingest_id = 1`);
    expect(store.latestMeta('p/s1/custom-title.json')).toBeNull();
  });

  test('节点详情解压失败：给空详情并标记 unreadable；更新时不抛出', () => {
    store.applyChanges([{ type: 'node_added', node: node('n1'), detail: { text: 't'.repeat(1000) } }]);
    corrupt(`UPDATE node_detail SET detail = x'0011223344' WHERE node_id = 'n1'`);
    expect(store.getNodeDetail('s1', 'n1')).toEqual({ nodeId: 'n1', input: null, output: null, text: null, raw: null, unreadable: true });
    store.applyChanges([{ type: 'node_updated', sessionId: 's1', id: 'n1', patch: {}, detail: { output: 'ok' } }]);
    expect(store.getNodeDetail('s1', 'n1')).toEqual({ nodeId: 'n1', input: null, output: 'ok', text: null, raw: null });
  });
});

test('encodeBody 的结果按 enc 写入（直接写 BLOB 也能读回）', () => {
  const { data, enc } = encodeBody(LONG);
  expect(enc).toBe(1);
  const db = new Database(file);
  db.prepare(`INSERT INTO raw_event (source, file, "offset", line_hash, record_type, session_id, body, enc) VALUES ('transcript', 'p/x.jsonl', 0, 'h', 'user', 'sx', ?, ?)`).run(data, enc);
  db.close();
  expect(store.rawForSession('sx')).toMatchObject([{ line: LONG }]);
});

test('同一次 applyChanges 里先新增再更新的详情只写一次（不先压缩再解压合并）', () => {
  const sql: string[] = [];
  const s = openStore(':memory:', { verbose: (q) => sql.push(String(q)) });
  try {
    sql.length = 0;
    s.applyChanges([
      { type: 'node_added', node: node('n1'), detail: { input: { command: 'x'.repeat(500) } } },
      { type: 'node_updated', sessionId: 's1', id: 'n1', patch: { status: 'succeeded' }, detail: { output: 'y'.repeat(500) } },
      { type: 'node_updated', sessionId: 's1', id: 'n1', patch: {}, detail: { text: 'z' } },
      { type: 'node_updated', sessionId: 's1', id: 'missing', patch: {}, detail: { text: 'ignored' } },
    ]);
    expect(sql.filter((q) => /INTO node_detail/.test(q))).toHaveLength(1);
    expect(sql.filter((q) => /SELECT detail/.test(q))).toHaveLength(0);
    expect(s.getNodeDetail('s1', 'n1')).toMatchObject({ input: { command: 'x'.repeat(500) }, output: 'y'.repeat(500), text: 'z' });
    expect(s.getNodeDetail('s1', 'missing')).toBeNull();
    // a later call merges with what the earlier one stored
    s.applyChanges([{ type: 'node_updated', sessionId: 's1', id: 'n1', patch: {}, detail: { raw: 1 } }]);
    expect(s.getNodeDetail('s1', 'n1')).toMatchObject({ input: { command: 'x'.repeat(500) }, text: 'z', raw: 1 });
  } finally {
    s.close();
  }
});
