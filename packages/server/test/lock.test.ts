import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  acquireLock, holderResponds, isAlive, isStaleService, LockHeldError, lockPath, readLock, removeStaleLock, windowsListsPid, type AliveProbe,
  type LockHolder,
} from '../src/lock.js';

let dataDir: string;

/** A pid that is certainly not running: a child process that has already exited. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '0']).pid!;
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-lock-'));
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 10 });
});

test('锁记录命令、版本、后台模式；setPort 后记端口', () => {
  const lock = acquireLock(dataDir, { command: 'start', version: '1.2.3', service: true });
  try {
    expect(readLock(dataDir)).toMatchObject({ pid: process.pid, command: 'start', version: '1.2.3', service: true, port: null });
    expect(typeof readLock(dataDir)!.startedAt).toBe('string');
    lock.setPort(5000);
    expect(readLock(dataDir)).toMatchObject({ pid: process.pid, command: 'start', version: '1.2.3', service: true, port: 5000 });
  } finally {
    lock.release();
  }
  expect(readLock(dataDir)).toBeNull();
});

test('不写 service 时记为非后台模式', () => {
  const lock = acquireLock(dataDir, { command: 'compact', version: '0.4.0' });
  try {
    expect(readLock(dataDir)).toMatchObject({ command: 'compact', version: '0.4.0', service: false, port: null });
  } finally {
    lock.release();
  }
});

test('旧格式的锁文件当作 start 读', async () => {
  await fs.writeFile(lockPath(dataDir), JSON.stringify({ pid: process.pid, startedAt: '2026-01-01T00:00:00.000Z' }));
  expect(readLock(dataDir)).toEqual({
    pid: process.pid,
    startedAt: '2026-01-01T00:00:00.000Z',
    command: 'start',
    version: null,
    service: false,
    port: null,
  });
});

test('持有者进程已不在、没有锁文件、文件读不了：readLock 为 null', async () => {
  expect(readLock(dataDir)).toBeNull();
  await fs.writeFile(lockPath(dataDir), JSON.stringify({ pid: deadPid(), startedAt: '2026-01-01T00:00:00.000Z', command: 'start' }));
  expect(readLock(dataDir)).toBeNull();
  await fs.writeFile(lockPath(dataDir), '{not json');
  expect(readLock(dataDir)).toBeNull();
});

test('第二次取锁抛 LockHeldError，带第一个持有者，消息不变', () => {
  const lock = acquireLock(dataDir, { command: 'start', version: '1.2.3', service: true });
  try {
    let caught: unknown;
    try {
      acquireLock(dataDir, { command: 'compact', version: '1.2.3' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LockHeldError);
    const held = caught as LockHeldError;
    expect(held.holder).toMatchObject({ pid: process.pid, command: 'start', service: true });
    expect(held.message).toContain('already running with this data directory');
    expect(held.message).toContain(`pid ${process.pid}`);
    expect(held.file).toBe(lockPath(dataDir));
  } finally {
    lock.release();
  }
});

test('setPort 不改写已经不属于自己的锁文件', async () => {
  const lock = acquireLock(dataDir, { command: 'start', version: '1.2.3' });
  const other = JSON.stringify({ pid: process.pid, startedAt: '2026-01-01T00:00:00.000Z', command: 'rebuild' });
  await fs.writeFile(lockPath(dataDir), other);
  lock.setPort(5000);
  expect(await fs.readFile(lockPath(dataDir), 'utf8')).toBe(other);
  lock.release();
  expect(await fs.readFile(lockPath(dataDir), 'utf8')).toBe(other);
});

/** A port something listens on (closed by the caller), and one nothing listens on (bound, then freed). */
async function listening(): Promise<net.Server> {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}
const portOf = (server: net.Server): number => (server.address() as net.AddressInfo).port;
async function freePort(): Promise<number> {
  const server = await listening();
  const port = portOf(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const holderOn = (port: number | null, over: Partial<LockHolder> = {}): LockHolder => ({
  pid: process.pid,
  startedAt: '2026-11-25T00:00:00.000Z',
  command: 'start',
  version: '0.5.0',
  service: true,
  port,
  ...over,
});

test('holderResponds：端口有人监听为 true，没人监听或没有端口为 false', async () => {
  const server = await listening();
  try {
    expect(await holderResponds(holderOn(portOf(server)))).toBe(true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  expect(await holderResponds(holderOn(await freePort()), { timeoutMs: 300 })).toBe(false);
  expect(await holderResponds(holderOn(null))).toBe(false);
});

test('isStaleService：只有带端口、端口不应答的 start 持有者算残留', async () => {
  const dead = await freePort();
  expect(await isStaleService(holderOn(dead))).toBe(true);
  expect(await isStaleService(holderOn(null))).toBe(false); // still starting
  expect(await isStaleService(holderOn(dead, { command: 'rebuild' }))).toBe(false);
  expect(await isStaleService(holderOn(dead, { command: 'compact' }))).toBe(false);
  const server = await listening();
  try {
    expect(await isStaleService(holderOn(portOf(server)))).toBe(false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('removeStaleLock 只删仍然写着这个持有者的锁文件', async () => {
  const record = { pid: process.pid, startedAt: '2026-11-25T00:00:00.000Z', command: 'start', version: '0.5.0', service: true, port: 45123 };
  await fs.writeFile(lockPath(dataDir), JSON.stringify(record));
  const holder = readLock(dataDir)!;
  await fs.writeFile(lockPath(dataDir), JSON.stringify({ ...record, startedAt: '2026-11-25T01:00:00.000Z' })); // a newer taker
  removeStaleLock(lockPath(dataDir), holder);
  expect(readLock(dataDir)?.startedAt).toBe('2026-11-25T01:00:00.000Z');
  await fs.writeFile(lockPath(dataDir), JSON.stringify(record));
  removeStaleLock(lockPath(dataDir), holder);
  expect(readLock(dataDir)).toBeNull();
  removeStaleLock(lockPath(dataDir), holder); // already gone: fine
});

/** A probe whose signal-0 check fails with `code` (or succeeds with null) and whose process list answers `listed`. */
function probe(platform: NodeJS.Platform, code: string | null, listed: boolean | null): AliveProbe & { listedCalls: number[] } {
  const listedCalls: number[] = [];
  return {
    platform,
    listedCalls,
    signal(pid) {
      if (code !== null) throw Object.assign(new Error(code), { code });
      void pid;
    },
    listed(pid) {
      listedCalls.push(pid);
      return listed;
    },
  };
}

test('isAlive：信号检查成功为活，ESRCH 为不在，都不查进程列表', () => {
  for (const platform of ['win32', 'linux'] as const) {
    const ok = probe(platform, null, false);
    expect(isAlive(4242, ok)).toBe(true);
    const gone = probe(platform, 'ESRCH', true);
    expect(isAlive(4242, gone)).toBe(false);
    expect([...ok.listedCalls, ...gone.listedCalls]).toEqual([]);
  }
});

test('isAlive：Windows 上 EPERM 再查进程列表，列表里没有（已退出、记录还没放掉）就算不在', () => {
  const zombie = probe('win32', 'EPERM', false);
  expect(isAlive(18244, zombie)).toBe(false);
  expect(zombie.listedCalls).toEqual([18244]);
  // Another user's or an elevated process: listed, so alive.
  expect(isAlive(4, probe('win32', 'EPERM', true))).toBe(true);
  // The list could not be read: as before, alive.
  expect(isAlive(4, probe('win32', 'EPERM', null))).toBe(true);
});

test('isAlive：非 Windows 上 EPERM 就是活着，不查进程列表', () => {
  const p = probe('linux', 'EPERM', false);
  expect(isAlive(1, p)).toBe(true);
  expect(p.listedCalls).toEqual([]);
});

test.runIf(process.platform === 'win32')('windowsListsPid：列出自己，不列已退出的进程', () => {
  expect(windowsListsPid(process.pid)).toBe(true);
  expect(windowsListsPid(deadPid())).toBe(false);
});