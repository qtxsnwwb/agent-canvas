import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { openStore, type RawEvent, type Store } from '../src/store/store.js';
import { assistantBlock, userPrompt } from './fixtures.js';

/*
 * Pipeline.holdWrites: while held (the storage job's VACUUM runs on another connection), no pipeline path writes; work
 * arriving meanwhile waits and is applied, in order, once released. Checked with a second connection that holds the
 * database's write lock: any write through the store would fail with SQLITE_BUSY.
 */

let tmp: string;
let dbFile: string;
let store: Store;
let config: Config;
let p: Pipeline;

const abs = (rel: string): string => path.join(config.projectsDir, ...rel.split('/'));
const linesOf = (events: RawEvent[]): string => events.map((e) => (e.source === 'transcript' ? e.line : '') + '\n').join('');
const turns = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 2));
};

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-pipeline-hold-'));
  config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), cursorDbPath: null });
  await fs.mkdir(path.join(config.projectsDir, 'proj'), { recursive: true });
  dbFile = path.join(tmp, 'data.db');
  store = openStore(dbFile);
  p = new Pipeline(store, config);
});
afterEach(async () => {
  store.close();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

/** Takes the write lock on a second connection (as VACUUM does) until the returned function is called. */
function lockWrites(): () => void {
  const other = new Database(dbFile);
  other.exec('BEGIN IMMEDIATE');
  return () => {
    other.exec('ROLLBACK');
    other.close();
  };
}

test('文件内容：放开之前不写，放开后照常写入', async () => {
  await fs.writeFile(abs('proj/s1.jsonl'), linesOf([userPrompt('u1', null, 'x')]));
  const release = p.holdWrites();
  const unlock = lockWrites();
  const ingest = p.ingestFile(abs('proj/s1.jsonl'));
  await turns();
  expect(p.ingestFailures()).toEqual([]);
  unlock();
  expect(store.getSession('s1')).toBeNull();
  release();
  await ingest;
  expect(store.getGraph('s1')!.nodes.map((n) => n.id)).toEqual(['u1']);
});

test('hook（有会话、无会话）排队，放开后按到达顺序写入，不丢', async () => {
  await fs.writeFile(abs('proj/s1.jsonl'), linesOf([userPrompt('u1', null, 'x')]));
  await p.ingestFile(abs('proj/s1.jsonl'));
  const release = p.holdWrites();
  const unlock = lockWrites();
  p.ingestHook('PreToolUse', 's1', JSON.stringify({ session_id: 's1', hook_event_name: 'PreToolUse', n: 1 }));
  p.ingestHook('Notification', null, JSON.stringify({ hook_event_name: 'Notification' }));
  p.ingestHook('Stop', 's1', JSON.stringify({ session_id: 's1', hook_event_name: 'Stop', n: 2 }));
  p.ingestHook('Stop', 's2', JSON.stringify({ session_id: 's2', hook_event_name: 'Stop' }));
  await turns();
  expect(p.ingestFailures()).toEqual([]);
  unlock();
  expect(store.allHookEventStats()).toEqual([]);
  release();
  await p.idle();
  expect(p.ingestFailures()).toEqual([]);
  const hooks = store.rawForSession('s1').filter((e) => e.source === 'hook');
  expect(hooks.map((e) => (e.source === 'hook' ? e.eventName : ''))).toEqual(['PreToolUse', 'Stop']);
  expect(store.allHookEventStats().reduce((n, s) => n + s.count, 0)).toBe(4);
});

test('全量扫描（含来源被删的标记）等到放开', async () => {
  await fs.writeFile(abs('proj/s1.jsonl'), linesOf([userPrompt('u1', null, 'x')]));
  await p.scanAll();
  await fs.rm(abs('proj/s1.jsonl'));
  await fs.writeFile(abs('proj/s2.jsonl'), linesOf([userPrompt('v1', null, 'y'), assistantBlock('v2', 'v1', { type: 'text', text: 'z' })]));
  const release = p.holdWrites();
  const unlock = lockWrites();
  const scan = p.scanAll();
  await turns();
  expect(p.ingestFailures()).toEqual([]);
  unlock();
  expect(store.getSession('s2')).toBeNull();
  release();
  await scan;
  await p.idle();
  expect(store.getSession('s1')!.sourceDeleted).toBe(true);
  expect(store.getGraph('s2')!.nodes).toHaveLength(2);
});

test('放开函数只生效一次；持有期间不能重建、不能再持有', () => {
  const release = p.holdWrites();
  expect(p.writesHeld()).toBe(true);
  expect(() => p.holdWrites()).toThrow();
  expect(() => p.rebuild()).toThrow(/held/);
  release();
  release();
  expect(p.writesHeld()).toBe(false);
  const again = p.holdWrites();
  again();
});
