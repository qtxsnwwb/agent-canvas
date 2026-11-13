import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { openStore, type RawEvent, type Store } from '../src/store/store.js';
import { assistantBlock, userPrompt } from './fixtures.js';

let tmp: string;
let dbFile: string;
let store: Store;
let config: Config;

const abs = (rel: string): string => path.join(config.projectsDir, ...rel.split('/'));
const linesOf = (events: RawEvent[]): string => events.map((e) => (e.source === 'transcript' ? e.line : '') + '\n').join('');
const LONG = 'a long prompt that is stored compressed '.repeat(20);

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-pipeline-corrupt-'));
  config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), cursorDbPath: null });
  await fs.mkdir(path.join(config.projectsDir, 'proj'), { recursive: true });
  dbFile = path.join(tmp, 'data.db');
  store = openStore(dbFile);
});
afterEach(async () => {
  store.close();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

/** Damages the stored body of the transcript row with this record uuid in it (by ingest order, 1-based). */
function damage(ingestId: number): void {
  const db = new Database(dbFile);
  try {
    db.prepare(`UPDATE raw_event SET body = x'00112233', enc = 1 WHERE ingest_id = ?`).run(ingestId);
  } finally {
    db.close();
  }
}

async function ingestThree(): Promise<Pipeline> {
  await fs.writeFile(
    abs('proj/s1.jsonl'),
    linesOf([
      userPrompt('u1', null, LONG),
      assistantBlock('a1', 'u1', { type: 'text', text: `${LONG} reply` }),
      userPrompt('u2', 'a1', `${LONG} again`),
    ]),
  );
  const p = new Pipeline(store, config);
  await p.ingestFile(abs('proj/s1.jsonl'));
  expect(store.getGraph('s1')!.nodes.map((n) => n.id)).toEqual(['u1', 'a1', 'u2']);
  return p;
}

test('重建时跳过损坏的原始记录，按文件报告一次，其余照常', async () => {
  await ingestThree();
  damage(2);
  const p = new Pipeline(store, config);
  expect(() => p.rebuild()).not.toThrow();
  expect(store.getGraph('s1')!.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['u1', 'u2']));
  expect(store.getGraph('s1')!.nodes.map((n) => n.id)).not.toContain('a1');
  const failures = p.ingestFailures();
  expect(failures).toHaveLength(1);
  expect(failures[0]!.file).toBe('raw:proj/s1.jsonl');
  expect(failures[0]!.error).toMatch(/corrupt stored body/);
});

test('多条损坏的行只记一条（每个文件一条）', async () => {
  await ingestThree();
  damage(1);
  damage(3);
  const p = new Pipeline(store, config);
  p.rebuild();
  expect(p.ingestFailures()).toHaveLength(1);
});

test('会话重新载入内存（水合）时跳过损坏的行，新内容照常进来', async () => {
  await ingestThree();
  damage(2);
  const p = new Pipeline(store, config); // nothing in memory: the next line hydrates s1 from the raw rows
  await fs.appendFile(abs('proj/s1.jsonl'), linesOf([assistantBlock('a2', 'u2', { type: 'text', text: 'ok' })]));
  await p.ingestFile(abs('proj/s1.jsonl'));
  expect(store.getGraph('s1')!.nodes.map((n) => n.id)).toContain('a2');
  expect(p.ingestFailures().map((f) => f.file)).toEqual(['raw:proj/s1.jsonl']);
});

test('损坏的 hook 行按会话报告', async () => {
  await ingestThree();
  const p = new Pipeline(store, config);
  p.ingestHook('Stop', 's1', JSON.stringify({ session_id: 's1', hook_event_name: 'Stop', pad: LONG }));
  await p.idle();
  damage(4);
  const p2 = new Pipeline(store, config);
  p2.rebuild();
  expect(p2.ingestFailures().map((f) => f.file)).toEqual(['raw:hook:s1']);
});
