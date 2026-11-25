import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { acquireLock, LockHeldError, lockPath, readLock } from '../src/lock.js';

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
