import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { rebuild, start, type Running } from '../src/cli.js';
import { acquireLock, lockPath } from '../src/lock.js';
import { NORMALIZER_VERSION } from '../src/normalize/version.js';
import { openStore } from '../src/store/store.js';
import type { RawEvent } from '../src/store/store.js';
import { assistantBlock, userPrompt } from './fixtures.js';

let tmp: string;
let projectsDir: string;
let dataDir: string;
const apps: Running[] = [];

const linesOf = (events: RawEvent[]): string => events.map((e) => (e.source === 'transcript' ? e.line : '') + '\n').join('');
const dbPath = (): string => path.join(dataDir, 'data.db');
async function launch(log?: (line: string) => void): Promise<Running> {
  const app = await start({ projectsDir, dataDir, port: 0 }, { log });
  apps.push(app);
  return app;
}
async function stop(app: Running): Promise<void> {
  apps.splice(apps.indexOf(app), 1);
  await app.close();
}
/** A pid that is certainly not running: a child process that has already exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '0']);
  return r.pid!;
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-cli-'));
  projectsDir = path.join(tmp, 'projects');
  dataDir = path.join(tmp, 'data');
  await fs.mkdir(path.join(projectsDir, 'proj'), { recursive: true });
  await fs.writeFile(
    path.join(projectsDir, 'proj', 's1.jsonl'),
    linesOf([userPrompt('u1', null, 'x'), assistantBlock('a1', 'u1', { type: 'text', text: 'hi' }, { stopReason: 'end_turn' })]),
  );
});
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

test('锁文件：同一数据目录只能有一个持有者，释放后可再取', async () => {
  await fs.mkdir(dataDir, { recursive: true });
  const lock = acquireLock(dataDir);
  const content = JSON.parse(await fs.readFile(lockPath(dataDir), 'utf8')) as { pid: number; startedAt: string };
  expect(content.pid).toBe(process.pid);
  expect(typeof content.startedAt).toBe('string');
  expect(() => acquireLock(dataDir)).toThrow(new RegExp(`already running.*pid ${process.pid}`));
  lock.release();
  await expect(fs.stat(lockPath(dataDir))).rejects.toThrow();
  acquireLock(dataDir).release();
});

test('锁文件：持有者进程已不存在时接管', async () => {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(lockPath(dataDir), JSON.stringify({ pid: deadPid(), startedAt: '2026-01-01T00:00:00.000Z' }));
  const lock = acquireLock(dataDir);
  expect(JSON.parse(await fs.readFile(lockPath(dataDir), 'utf8')).pid).toBe(process.pid);
  lock.release();
});

test('start 与 rebuild 互斥；关闭后释放锁', async () => {
  const app = await launch();
  await expect(start({ projectsDir, dataDir, port: 0 })).rejects.toThrow(/already running.*pid/);
  expect(() => rebuild({ projectsDir, dataDir })).toThrow(/already running.*pid/);
  await stop(app);
  rebuild({ projectsDir, dataDir });
  const again = await launch();
  await stop(again);
});

test('全新数据库只记录当前归一化版本，不重建', async () => {
  const lines: string[] = [];
  const app = await launch((l) => lines.push(l));
  await stop(app);
  expect(lines.filter((l) => l.includes('rebuilding'))).toEqual([]);
  const store = openStore(dbPath());
  try {
    expect(store.getMeta('normalizer_version')).toBe(String(NORMALIZER_VERSION));
    expect(store.getMeta('rebuild_in_progress')).toBeNull();
  } finally {
    store.close();
  }
});

test.each([
  ['版本不同', (s: ReturnType<typeof openStore>) => s.setMeta('normalizer_version', '0'), /reason: normalizer version 0 -> /],
  ['上次重建未完成', (s: ReturnType<typeof openStore>) => s.setMeta('rebuild_in_progress', '1'), /reason: interrupted rebuild/],
])('start 在监听前自动重建：%s', async (_name, tamper, reason) => {
  const first = await launch();
  await vi.waitFor(async () => expect((await fetch(`${(apps.at(-1) as Running).url}/api/sessions/s1/graph`)).status).toBe(200));
  await stop(first);
  const s = openStore(dbPath());
  tamper(s);
  s.clearDerived(); // derived data gone: only a rebuild brings the session back
  s.close();
  const lines: string[] = [];
  const app = await launch((l) => lines.push(l));
  expect(lines[0]).toMatch(/^claude-canvas rebuilding derived data \(reason: /);
  expect(lines[0]).toMatch(reason);
  const res = await fetch(`${app.url}/api/sessions/s1/graph`);
  expect(res.status).toBe(200);
  await stop(app);
  const after = openStore(dbPath());
  try {
    expect(after.getMeta('normalizer_version')).toBe(String(NORMALIZER_VERSION));
    expect(after.getMeta('rebuild_in_progress')).toBeNull();
  } finally {
    after.close();
  }
});

test('rebuild 报告进度', async () => {
  const app = await launch();
  await vi.waitFor(async () => expect((await fetch(`${(apps.at(-1) as Running).url}/api/sessions/s1/graph`)).status).toBe(200));
  await stop(app);
  const progress: [number, number][] = [];
  rebuild({ projectsDir, dataDir }, { progress: (done, total) => progress.push([done, total]) });
  expect(progress.at(-1)).toEqual([1, 1]);
});
