import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { HELD_HOOKS_FILE, Pipeline } from '../src/pipeline.js';
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

describe('VACUUM 期间的 hook 落在旁路文件里，不只在内存', () => {
  const sidecar = (): string => path.join(config.dataDir, HELD_HOOKS_FILE);
  const rawHooks = (s: Store, sessionId: string): string[] =>
    s.rawForSession(sessionId).flatMap((e) => (e.source === 'hook' ? [e.eventName] : []));

  test('持有期间写进旁路文件、数据库不动；放开后写入数据库并删掉文件', async () => {
    await fs.writeFile(abs('proj/s1.jsonl'), linesOf([userPrompt('u1', null, 'x')]));
    await p.ingestFile(abs('proj/s1.jsonl'));
    const release = p.holdWrites();
    const unlock = lockWrites();
    p.ingestHook('PreToolUse', 's1', JSON.stringify({ session_id: 's1', hook_event_name: 'PreToolUse' }));
    p.ingestHook('Stop', 's1', JSON.stringify({ session_id: 's1', hook_event_name: 'Stop' }));
    const lines = (await fs.readFile(sidecar(), 'utf8')).trim().split('\n');
    expect(lines.map((l) => (JSON.parse(l) as { eventName: string }).eventName)).toEqual(['PreToolUse', 'Stop']);
    unlock();
    release();
    await p.idle();
    expect(rawHooks(store, 's1')).toEqual(['PreToolUse', 'Stop']);
    await expect(fs.stat(sidecar())).rejects.toThrow();
    expect(store.dirtySessionIds()).toEqual([]); // re-derived after the drain
  });

  test('VACUUM 中途进程被杀：下次启动时找到旁路文件并写入，会话标记为待重新推导', async () => {
    await fs.writeFile(abs('proj/s1.jsonl'), linesOf([userPrompt('u1', null, 'x')]));
    await p.ingestFile(abs('proj/s1.jsonl'));
    p.holdWrites(); // never released: the process "dies" during VACUUM
    p.ingestHook('Stop', 's1', JSON.stringify({ session_id: 's1', hook_event_name: 'Stop' }));
    p.ingestHook('Notification', null, JSON.stringify({ hook_event_name: 'Notification' }));
    // a half-written last line (killed during the append) is ignored
    await fs.appendFile(sidecar(), '{"source":"hook","eventN');
    store.close();
    store = openStore(dbFile);
    const next = new Pipeline(store, config); // start: drains the sidecar
    expect(rawHooks(store, 's1')).toEqual(['Stop']);
    expect(store.allHookEventStats().reduce((n, s) => n + s.count, 0)).toBe(2);
    expect(store.dirtySessionIds()).toEqual(['s1']);
    await expect(fs.stat(sidecar())).rejects.toThrow();
    await next.scanAll(); // the scan touches dirty sessions: s1 is re-derived with the hook
    await next.idle();
    expect(store.dirtySessionIds()).toEqual([]);
  });

  test('写入数据库后、删文件前被杀：下次启动只删文件，不重复写入', async () => {
    await fs.writeFile(abs('proj/s1.jsonl'), linesOf([userPrompt('u1', null, 'x')]));
    await p.ingestFile(abs('proj/s1.jsonl'));
    const release = p.holdWrites();
    p.ingestHook('Stop', 's1', JSON.stringify({ session_id: 's1', hook_event_name: 'Stop' }));
    const content = await fs.readFile(sidecar(), 'utf8');
    release();
    await p.idle();
    await fs.writeFile(sidecar(), content); // as if the unlink after the drain never happened
    store.close();
    store = openStore(dbFile);
    new Pipeline(store, config);
    expect(rawHooks(store, 's1')).toEqual(['Stop']);
    await expect(fs.stat(sidecar())).rejects.toThrow();
  });
});
