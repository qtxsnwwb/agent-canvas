import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { main, start, type MainDeps, type Running } from '../src/cli.js';
import { CONTROL_HEADER, CONTROL_KEY_FILE, readControlKey } from '../src/control.js';
import { lockPath, readLock } from '../src/lock.js';
import type { DeliveryStatus, NotificationMessage } from '../src/notify/desktop.js';
import type { ServiceNotifier } from '../src/notify/service.js';

/*
 * `main(['start', …])` as the background service runs it: temp data / projects / home directories (start() reads
 * process.env), an ephemeral port, a fake notifier, and an injected exit so this process survives the shutdown.
 */

class FakeNotifier implements ServiceNotifier {
  async notify(_m: NotificationMessage): Promise<void> {}
  status(): DeliveryStatus {
    return { available: true, lastError: null, lastErrorAt: null };
  }
  async close(): Promise<void> {}
}

let tmp: string;
let dataDir: string;
let exits: number[];
let deps: MainDeps;
let children: ChildProcess[];
let others: Running[];

const exists = (file: string): Promise<boolean> => fs.stat(file).then(() => true, () => false);

/** Sends the stop request the way `service stop` will: port from the lock, key from control.key, no Origin. */
async function requestStop(): Promise<Response> {
  const holder = readLock(dataDir);
  const key = readControlKey(dataDir);
  if (holder?.port == null || key === null) throw new Error('service not running');
  return fetch(`http://127.0.0.1:${holder.port}/api/control/stop`, { method: 'POST', headers: { [CONTROL_HEADER]: key } });
}

async function waitForShutdown(): Promise<void> {
  await vi.waitFor(
    async () => {
      expect(exits).toEqual([0]);
      expect(await exists(lockPath(dataDir))).toBe(false);
      expect(await exists(path.join(dataDir, CONTROL_KEY_FILE))).toBe(false);
    },
    { timeout: 10_000, interval: 50 },
  );
}

/** Writes a lock held by this (live) process, as `command` would. */
async function holdLock(command: 'start' | 'rebuild' | 'compact' | null): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  const record = { pid: process.pid, startedAt: '2026-11-25T00:00:00.000Z', ...(command !== null ? { command, version: '0.4.0', service: false, port: null } : {}) };
  await fs.writeFile(lockPath(dataDir), JSON.stringify(record));
}

/** Runs main with stderr captured; returns its exit code and what it wrote to stderr. */
async function runCaptured(argv: string[]): Promise<{ code: number; stderr: string }> {
  let stderr = '';
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
  try {
    const code = await main(argv, deps);
    return { code, stderr };
  } finally {
    spy.mockRestore();
  }
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-service-mode-'));
  dataDir = path.join(tmp, 'data');
  const home = path.join(tmp, 'home');
  await fs.mkdir(path.join(tmp, 'projects'), { recursive: true });
  await fs.mkdir(home, { recursive: true });
  vi.stubEnv('AGENT_CANVAS_DATA_DIR', dataDir);
  vi.stubEnv('AGENT_CANVAS_PROJECTS_DIR', path.join(tmp, 'projects'));
  vi.stubEnv('AGENT_CANVAS_CODEX_DIR', '');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('APPDATA', path.join(home, 'AppData', 'Roaming'));
  vi.stubEnv('LOCALAPPDATA', path.join(home, 'AppData', 'Local'));
  exits = [];
  children = [];
  others = [];
  deps = {
    exit: (code) => {
      exits.push(code);
    },
    startOptions: { notifier: new FakeNotifier(), storage: false, searchIndex: false },
  };
});
afterEach(async () => {
  for (const child of children) child.kill();
  for (const other of others) await other.close().catch(() => undefined);
  // A test that failed half-way leaves its service running: stop it before removing its directory.
  const holder = readLock(dataDir);
  if (holder?.pid === process.pid && holder.port !== null) {
    await requestStop().catch(() => undefined);
    await vi.waitFor(async () => expect(await exists(lockPath(dataDir))).toBe(false), { timeout: 10_000 }).catch(() => undefined);
  }
  vi.unstubAllEnvs();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

test('--service：另一个服务占着锁时说明并以 0 退出', async () => {
  await holdLock('start');
  const r = await runCaptured(['start', '--port', '0', '--service']);
  expect(r.code).toBe(0);
  expect(r.stderr).toContain(`agent-canvas: 已有服务在运行（进程号 ${process.pid}），这次不启动`);
});

test('--service：旧格式的锁当作服务，以 0 退出', async () => {
  await holdLock(null);
  expect((await runCaptured(['start', '--port', '0', '--service'])).code).toBe(0);
});

test('--service：compact / rebuild 占着锁时说明并以 1 退出', async () => {
  await holdLock('compact');
  const compact = await runCaptured(['start', '--port', '0', '--service']);
  expect(compact.code).toBe(1);
  expect(compact.stderr).toContain(`agent-canvas: 正在压缩数据库（进程号 ${process.pid}），稍后重试`);
  await holdLock('rebuild');
  const rebuild = await runCaptured(['start', '--port', '0', '--service']);
  expect(rebuild.code).toBe(1);
  expect(rebuild.stderr).toContain(`agent-canvas: 正在重建数据（进程号 ${process.pid}），稍后重试`);
});

test('不带 --service：锁被占时照旧报错并以 1 退出', async () => {
  await holdLock('start');
  const r = await runCaptured(['start', '--port', '0']);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain('already running with this data directory');
});

test('--log-file：输出写进日志（带时间）；停止请求让服务收尾，以 0 退出，锁和钥匙都删掉', async () => {
  const file = path.join(tmp, 'logs', 'service.log');
  const crashListeners = (): number => process.listenerCount('uncaughtException') + process.listenerCount('unhandledRejection');
  const before = crashListeners();
  expect(await main(['start', '--port', '0', '--log-file', file, '--service'], deps)).toBe(-1);
  expect(crashListeners()).toBe(before + 2); // a crash goes to the log (logCrashes)
  const log = await fs.readFile(file, 'utf8');
  expect(log).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z agent-canvas listening on http:\/\/127\.0\.0\.1:\d+$/m);
  expect(readLock(dataDir)).toMatchObject({ pid: process.pid, command: 'start', service: true });
  const res = await requestStop();
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ stopping: true });
  await waitForShutdown();
  expect(crashListeners()).toBe(before);
});

test('SIGTERM 和 Ctrl+C 一样收尾，以 0 退出；两个信号的监听都撤掉', async () => {
  const before = { term: process.listeners('SIGTERM'), int: process.listeners('SIGINT') };
  let stdout = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  try {
    expect(await main(['start', '--port', '0'], deps)).toBe(-1);
  } finally {
    spy.mockRestore();
  }
  expect(stdout).toContain('agent-canvas listening on');
  const added = process.listeners('SIGTERM').filter((l) => !before.term.includes(l));
  expect(added).toHaveLength(1);
  expect(process.listeners('SIGINT').filter((l) => !before.int.includes(l))).toHaveLength(1);
  (added[0] as () => void)();
  await waitForShutdown();
  expect(process.listeners('SIGTERM')).toEqual(before.term);
  expect(process.listeners('SIGINT')).toEqual(before.int);
});

/** A live process that is not agent-canvas (a node child that sleeps): its pid stands for a reused one. */
async function unrelatedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  children.push(child);
  await new Promise((resolve) => child.once('spawn', resolve));
  return child.pid!;
}

/** A port nothing listens on (bound, then freed). */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A lock as a service that died without clean-up left it: another live process's pid, a port, its control key. */
async function staleLock(pid: number, port: number): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(lockPath(dataDir), JSON.stringify({ pid, startedAt: '2026-11-25T00:00:00.000Z', command: 'start', version: '0.5.0', service: true, port }));
  await fs.writeFile(path.join(dataDir, CONTROL_KEY_FILE), 'a'.repeat(64));
}

test('--service：锁文件残留（进程号被别的进程占用、端口不应答）时接管并启动', async () => {
  const pid = await unrelatedPid();
  const port = await freePort();
  await staleLock(pid, port);
  const r = await runCaptured(['start', '--port', '0', '--service']);
  expect(r.code).toBe(-1);
  expect(r.stderr).toContain(`锁文件残留（进程号 ${pid} 没有在端口 ${port} 上应答），接管`);
  const holder = readLock(dataDir);
  expect(holder).toMatchObject({ pid: process.pid, command: 'start', service: true });
  expect(holder?.port).toBeGreaterThan(0);
  expect(readControlKey(dataDir)).not.toBe('a'.repeat(64));
  const res = await requestStop();
  expect(res.status).toBe(202);
  await waitForShutdown();
});

test('--service：端口有服务应答时仍算在运行，以 0 退出、锁不动', async () => {
  const pid = await unrelatedPid();
  others.push(await start({ dataDir: path.join(tmp, 'other-data'), port: 0 }, { notifier: new FakeNotifier(), storage: false, searchIndex: false, statsWarmup: false }));
  await staleLock(pid, others[0]!.address.port);
  const r = await runCaptured(['start', '--port', '0', '--service']);
  expect(r.code).toBe(0);
  expect(r.stderr).toContain(`agent-canvas: 已有服务在运行（进程号 ${pid}），这次不启动`);
  expect(readLock(dataDir)).toMatchObject({ pid, port: others[0]!.address.port });
});

test('不带 --service：锁文件残留时照旧报错（终端里的 start 不变）', async () => {
  const pid = await unrelatedPid();
  await staleLock(pid, await freePort());
  const r = await runCaptured(['start', '--port', '0']);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain('already running with this data directory');
  expect(readLock(dataDir)?.pid).toBe(pid);
});
