import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { main, start, type MainDeps, type Running } from '../src/cli.js';
import type { HooksCliIo } from '../src/hooks-cli.js';
import { lockPath, readLock } from '../src/lock.js';
import type { DeliveryStatus, NotificationMessage } from '../src/notify/desktop.js';
import type { ServiceNotifier } from '../src/notify/service.js';
import { manifestPath, readManifest, writeManifest, type ServiceManifest } from '../src/service/manifest.js';
import type { ServiceBackend, ServiceDefinition, ServiceSystem } from '../src/service/types.js';

/*
 * `agent-canvas service …` with a fake system (temp home and env, nothing run) and a fake backend that records its
 * calls; "starting" the service runs a real start() in this process, on port 0, in the temp data directory, with a fake
 * notifier. Never the real registration, ~/.agent-canvas or port 4317.
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
let system: ServiceSystem;
let calls: string[];
let backend: ServiceBackend & { checkResult: string | null; startImpl: (def: ServiceDefinition) => Promise<void>; stateResult: 'installed' | 'disabled' | 'absent' };
let out: string[];
let err: string[];
let io: HooksCliIo & { answer: boolean };
let running: Running[];
let servers: net.Server[];

/** A port something accepts connections on, as a running service's (closed after the test). */
async function listeningPort(): Promise<number> {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return (server.address() as net.AddressInfo).port;
}

/** A port nothing listens on (bound, then freed): the port of a lock left behind. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const CLI = path.join('C:', 'agent-canvas', 'dist', 'cli.js');

const exists = (file: string): Promise<boolean> => fs.stat(file).then(() => true, () => false);

/** A real service in this process, as the system's start would launch it (port 0, the definition's data dir). */
async function launch(def: ServiceDefinition): Promise<void> {
  running.push(await start({ dataDir: def.dataDir, port: 0 }, { notifier: new FakeNotifier(), storage: false, searchIndex: false, statsWarmup: false }));
}

function deps(over: Partial<MainDeps> = {}): MainDeps {
  return { hooksIo: io, cliPath: CLI, serviceSystem: system, serviceBackend: backend, ...over };
}

const run = (args: string[], over: Partial<MainDeps> = {}): Promise<number> => main(['service', ...args], deps(over));

async function holdLock(record: Record<string, unknown>, dir: string = dataDir): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(lockPath(dir), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), ...record }));
}

function manifest(over: Partial<ServiceManifest> = {}): ServiceManifest {
  const dir = over.dataDir ?? dataDir;
  const logFile = path.join(dir, 'logs', 'service.log');
  return {
    version: 1,
    platform: system.platform,
    where: backend.where,
    installedAt: '2026-11-25T00:00:00.000Z',
    nodePath: process.execPath,
    cliPath: CLI,
    port: 45001,
    dataDir: dir,
    logFile,
    env: { AGENT_CANVAS_DATA_DIR: dir },
    argv: [process.execPath, CLI, 'start', '--port', '45001', '--log-file', logFile, '--service'],
    ...over,
  };
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-service-command-'));
  dataDir = path.join(tmp, 'data');
  const home = path.join(tmp, 'home');
  await fs.mkdir(path.join(tmp, 'projects'), { recursive: true });
  await fs.mkdir(home, { recursive: true });
  // start() reads process.env: temp directories only.
  vi.stubEnv('AGENT_CANVAS_DATA_DIR', path.join(tmp, 'unused-data'));
  vi.stubEnv('AGENT_CANVAS_PROJECTS_DIR', path.join(tmp, 'projects'));
  vi.stubEnv('AGENT_CANVAS_CODEX_DIR', '');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('APPDATA', path.join(home, 'AppData', 'Roaming'));
  vi.stubEnv('LOCALAPPDATA', path.join(home, 'AppData', 'Local'));
  const fail = (what: string) => (): never => {
    throw new Error(`the fake system does not ${what}`);
  };
  system = {
    platform: process.platform,
    env: {
      AGENT_CANVAS_DATA_DIR: dataDir,
      AGENT_CANVAS_PROJECTS_DIR: path.join(tmp, 'projects'),
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
    },
    home,
    uid: null,
    run: fail('run commands'),
    spawnDetached: fail('spawn'),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
  calls = [];
  running = [];
  servers = [];
  backend = {
    kind: 'windows',
    where: '假的启动项（测试）',
    checkResult: null,
    stateResult: 'absent',
    startImpl: launch,
    async check() {
      calls.push('check');
      return this.checkResult;
    },
    plan: (def) => [`计划：运行 ${def.argv.join(' ')}`],
    async register() {
      calls.push('register');
    },
    async unregister() {
      calls.push(`unregister:${(await exists(manifestPath(system))) ? 'manifest' : 'no-manifest'}`);
    },
    async start(def) {
      calls.push('start');
      await this.startImpl(def);
    },
    async cancelRestart(def) {
      calls.push(`cancelRestart:${readLock(def.dataDir) === null ? 'not-running' : 'running'}`);
    },
    async state() {
      return this.stateResult;
    },
  };
  out = [];
  err = [];
  io = {
    answer: true,
    out: (line) => void out.push(line),
    err: (line) => void err.push(line),
    async confirm() {
      return this.answer;
    },
    isInteractive: false,
    now: () => new Date(),
  };
});

afterEach(async () => {
  for (const r of running) await r.close();
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  vi.unstubAllEnvs();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

describe('service install', () => {
  test('从 npx 缓存运行时拒绝，提示先全局安装', async () => {
    const npx = path.join(tmp, '_npx', 'abc123', 'node_modules', '@qtxsnwwb', 'agent-canvas', 'dist', 'cli.js');
    expect(await run(['install', '--yes'], { cliPath: npx })).toBe(1);
    expect(err.join('\n')).toContain('npm install -g @qtxsnwwb/agent-canvas');
    expect(err.join('\n')).toContain(npx);
    expect(calls).toEqual([]);
    expect(await exists(manifestPath(system))).toBe(false);
  });

  test('系统不支持时拒绝', async () => {
    expect(await run(['install', '--yes'], { serviceBackend: null })).toBe(1);
    expect(err).toEqual(['这个系统不支持后台常驻（只支持 Windows、macOS、Linux）']);
  });

  test('check 给出原因时打印并退出 1', async () => {
    backend.checkResult = 'Windows Script Host 不可用';
    expect(await run(['install', '--yes'])).toBe(1);
    expect(err).toEqual(['Windows Script Host 不可用']);
    expect(calls).toEqual(['check']);
    expect(await exists(manifestPath(system))).toBe(false);
  });

  test('非交互终端不带 --yes：打印计划后拒绝，什么都不写', async () => {
    expect(await run(['install', '--port', '45002'])).toBe(1);
    expect(out.join('\n')).toContain('计划：运行');
    expect(out.join('\n')).toContain(manifestPath(system));
    expect(err).toEqual(['非交互终端下需要加 --yes 才会写入']);
    expect(calls).toEqual(['check']);
    expect(await exists(manifestPath(system))).toBe(false);
  });

  test('交互终端里回答不：退出 1，什么都不写', async () => {
    io.isInteractive = true;
    io.answer = false;
    expect(await run(['install', '--port', '45002'])).toBe(1);
    expect(out).toContain('已取消，未做任何改动');
    expect(calls).toEqual(['check']);
    expect(await exists(manifestPath(system))).toBe(false);
  });

  test('写清单、登记、启动，打印地址', async () => {
    io.isInteractive = true;
    expect(await run(['install', '--port', '45003'])).toBe(0);
    expect(calls).toEqual(['check', 'register', 'start']);
    const m = readManifest(system);
    expect(m).toMatchObject({ version: 1, port: 45003, dataDir, cliPath: CLI, nodePath: process.execPath, where: backend.where, platform: system.platform });
    expect(m?.argv).toEqual([process.execPath, CLI, 'start', '--port', '45003', '--log-file', path.join(dataDir, 'logs', 'service.log'), '--service']);
    expect(out.join('\n')).toContain('计划：运行');
    expect(out.join('\n')).not.toContain('更新已有的安装');
    const port = readLock(dataDir)?.port;
    expect(port).toBeGreaterThan(0);
    expect(out).toContain(`已在后台启动：http://127.0.0.1:${port}`);
  });

  test('已有服务在运行：照常登记、更新清单的端口，但不启动，提示先停掉', async () => {
    writeManifest(system, manifest({ port: 45004 }));
    await holdLock({ command: 'start', version: '0.5.0', service: false, port: await listeningPort() });
    expect(await run(['install', '--port', '45005', '--yes'])).toBe(0);
    expect(calls).toEqual(['check', 'register']);
    expect(out).toContain('更新已有的安装');
    expect(out).toContain(`已有服务在运行（进程号 ${process.pid}）；先停掉它，再运行 agent-canvas service start`);
    expect(readManifest(system)?.port).toBe(45005);
  });

  test('装好的服务在另一个数据目录里运行：拒绝，什么都不写', async () => {
    const other = path.join(tmp, 'service-data');
    writeManifest(system, manifest({ dataDir: other, port: 45008 }));
    const before = await fs.readFile(manifestPath(system), 'utf8');
    await holdLock({ command: 'start', version: '0.5.0', service: true, port: await listeningPort() }, other);
    expect(await run(['install', '--port', '45009', '--yes'])).toBe(1);
    expect(err).toEqual([`已有服务在运行（进程号 ${process.pid}，数据目录 ${other}）；先运行 agent-canvas service stop 停掉它，再重新安装`]);
    expect(out).toEqual([]);
    expect(calls).toEqual([]);
    expect(await fs.readFile(manifestPath(system), 'utf8')).toBe(before);
  });

  test('服务 15 秒内没起来：退出 1，指向日志', async () => {
    let clock = 0;
    system.now = () => clock;
    system.sleep = async (ms) => void (clock += ms);
    backend.startImpl = async () => undefined;
    expect(await run(['install', '--yes'])).toBe(1);
    expect(calls).toEqual(['check', 'register', 'start']);
    expect(err).toEqual([`已登记，但服务没有在 15 秒内起来，看日志：${path.join(dataDir, 'logs', 'service.log')}`]);
    expect(readManifest(system)).not.toBeNull();
  });
});

test('install：15 秒后服务还在启动（锁里没有端口）：说还在启动，指向日志，退出 0', async () => {
  let clock = 0;
  system.now = () => clock;
  system.sleep = async (ms) => void (clock += ms);
  backend.startImpl = async (def) => holdLock({ command: 'start', version: '0.5.0', service: true, port: null }, def.dataDir);
  expect(await run(['install', '--yes'])).toBe(0);
  expect(calls).toEqual(['check', 'register', 'start']);
  expect(out).toContain(`服务还在启动（可能在重建数据），看日志：${path.join(dataDir, 'logs', 'service.log')}`);
  expect(err).toEqual([]);
});

test('start：15 秒后服务还在启动：说还在启动，退出 0', async () => {
  let clock = 0;
  system.now = () => clock;
  system.sleep = async (ms) => void (clock += ms);
  writeManifest(system, manifest());
  backend.startImpl = async (def) => holdLock({ command: 'start', version: '0.5.0', service: true, port: null }, def.dataDir);
  expect(await run(['start'])).toBe(0);
  expect(out).toEqual([`服务还在启动（可能在重建数据），看日志：${path.join(dataDir, 'logs', 'service.log')}`]);
});

describe('service uninstall', () => {
  test('没装过：说没有安装，退出 0', async () => {
    expect(await run(['uninstall', '--yes'])).toBe(0);
    expect(out).toEqual(['没有安装']);
    expect(calls).toEqual([]);
  });

  test('先取消待定的重启，再停服务、取消登记，最后删清单', async () => {
    writeManifest(system, manifest());
    await launch(manifest());
    expect(readLock(dataDir)).not.toBeNull();
    expect(await run(['uninstall', '--yes'])).toBe(0);
    expect(calls).toEqual(['cancelRestart:running', 'unregister:manifest']);
    expect(out).toContain('已停止服务');
    expect(readLock(dataDir)).toBeNull();
    expect(await exists(manifestPath(system))).toBe(false);
    expect(out).toContain(`已取消登记：${backend.where}`);
    expect(out).toContain(`已删除 ${manifestPath(system)}`);
  });

  test('非交互终端不带 --yes：拒绝，什么都不动', async () => {
    writeManifest(system, manifest());
    expect(await run(['uninstall'])).toBe(1);
    expect(calls).toEqual([]);
    expect(await exists(manifestPath(system))).toBe(true);
  });
});

describe('service status', () => {
  test('按清单里的数据目录查，不按当前 shell 的', async () => {
    const other = path.join(tmp, 'service-data');
    writeManifest(system, manifest({ dataDir: other }));
    backend.stateResult = 'installed';
    const port = await listeningPort();
    await holdLock({ command: 'start', version: '0.5.0', service: true, port }, dataDir); // the shell's, not the service's
    expect(await run(['status'])).toBe(3);
    expect(out).toEqual(['服务：没有运行', `自动启动：已安装（${backend.where}）`, `日志：${path.join(other, 'logs', 'service.log')}`]);

    out.length = 0;
    await holdLock({ command: 'start', version: '0.5.0', service: true, port }, other);
    expect(await run(['status'])).toBe(0);
    expect(out[0]).toMatch(new RegExp(`^服务：正在运行（进程号 ${process.pid}，端口 ${port}，版本 0\\.5\\.0`));
  });
});

describe('service status: a lock left behind', () => {
  test('锁文件残留（端口不应答）：没有运行，注明进程号，退出 3', async () => {
    writeManifest(system, manifest());
    await holdLock({ command: 'start', version: '0.5.0', service: true, port: await freePort() });
    expect(await run(['status'])).toBe(3);
    expect(out[0]).toBe(`服务：没有运行（锁文件残留，进程号 ${process.pid}）`);
  });
});

describe('service start', () => {
  test('锁文件残留（端口不应答）：照常启动', async () => {
    writeManifest(system, manifest());
    await holdLock({ command: 'start', version: '0.5.0', service: true, port: await freePort() });
    // As the service's `start --service` does (main takes the stale lock over), then runs.
    backend.startImpl = async (def) => {
      await fs.rm(lockPath(def.dataDir));
      await launch(def);
    };
    expect(await run(['start'])).toBe(0);
    expect(calls).toEqual(['start']);
    expect(out).toContain(`已在后台启动：http://127.0.0.1:${readLock(dataDir)?.port}`);
  });

  test('没装过：提示先 install，退出 1', async () => {
    expect(await run(['start'])).toBe(1);
    expect(err).toEqual(['还没有安装后台常驻：先运行 agent-canvas service install，或在终端里用 agent-canvas start']);
    expect(calls).toEqual([]);
  });

  test('已经在运行：说明，退出 0，不启动', async () => {
    writeManifest(system, manifest());
    await holdLock({ command: 'start', version: '0.5.0', service: true, port: await listeningPort() });
    expect(await run(['start'])).toBe(0);
    expect(out.join('\n')).toContain(`进程号 ${process.pid}`);
    expect(calls).toEqual([]);
  });

  test('通过系统机制启动，打印地址', async () => {
    writeManifest(system, manifest());
    expect(await run(['start'])).toBe(0);
    expect(calls).toEqual(['start']);
    expect(out).toContain(`已在后台启动：http://127.0.0.1:${readLock(dataDir)?.port}`);
  });
});

describe('service stop', () => {
  test('装过时没在运行也取消待定的重启', async () => {
    writeManifest(system, manifest());
    expect(await run(['stop'])).toBe(0);
    expect(calls).toEqual(['cancelRestart:not-running']);
    expect(out).toEqual(['没有在运行']);
  });

  test('装过时先取消待定的重启，再发停止请求', async () => {
    writeManifest(system, manifest());
    await launch(manifest());
    expect(await run(['stop'])).toBe(0);
    expect(calls).toEqual(['cancelRestart:running']);
    expect(out).toEqual(['已停止']);
    expect(readLock(dataDir)).toBeNull();
  });

  test('取消重启时系统已经把服务停了（launchctl bootout、systemctl stop）：仍说已停止', async () => {
    writeManifest(system, manifest());
    await launch(manifest());
    backend.cancelRestart = async () => {
      calls.push('cancelRestart');
      await running.pop()!.close();
    };
    expect(await run(['stop'])).toBe(0);
    expect(calls).toEqual(['cancelRestart']);
    expect(out).toEqual(['已停止']);
  });

  test('没装过时只停服务（例如终端里开的）', async () => {
    await launch(manifest());
    expect(await run(['stop'])).toBe(0);
    expect(calls).toEqual([]);
    expect(out).toEqual(['已停止']);
    expect(readLock(dataDir)).toBeNull();
  });

  test('旧版本的服务（锁里没有版本）：说明按 Ctrl+C，退出 1', async () => {
    await holdLock({});
    expect(await run(['stop'])).toBe(1);
    expect(err).toEqual(['服务在运行，但不能用这个命令停止（版本较旧）：请在它的终端里按 Ctrl+C']);
  });

  test('锁文件残留（端口不应答）：说没有在运行并注明残留，退出 0', async () => {
    await holdLock({ command: 'start', version: '0.5.0', service: true, port: await freePort() });
    expect(await run(['stop'])).toBe(0);
    expect(out).toEqual([`没有在运行（锁文件残留，进程号 ${process.pid}）`]);
    expect(err).toEqual([]);
  });

  test('服务正在启动（锁里有版本、还没有端口）：稍后再试，指向日志，退出 1', async () => {
    await holdLock({ command: 'start', version: '0.5.0', service: true, port: null });
    expect(await run(['stop'])).toBe(1);
    expect(err).toEqual([`服务正在启动（可能在重建数据），稍后再试；日志：${path.join(dataDir, 'logs', 'service.log')}`]);
  });

  test('正在重建 / 压缩：退出 1', async () => {
    await holdLock({ command: 'compact', version: '0.5.0', service: false, port: null });
    expect(await run(['stop'])).toBe(1);
    expect(err).toEqual(['正在重建数据 / 压缩数据库，做完会自己退出']);
  });
});

describe('service restart', () => {
  test('先停再启动', async () => {
    writeManifest(system, manifest());
    await launch(manifest());
    const before = readLock(dataDir)?.port;
    expect(await run(['restart'])).toBe(0);
    expect(calls).toEqual(['cancelRestart:running', 'start']);
    expect(out[0]).toBe('已停止');
    const after = readLock(dataDir)?.port;
    expect(after).not.toBe(before);
    expect(out).toContain(`已在后台启动：http://127.0.0.1:${after}`);
  });

  test('没装过：不停，提示先 install', async () => {
    await holdLock({ command: 'start', version: '0.5.0', service: false, port: null });
    expect(await run(['restart'])).toBe(1);
    expect(err).toEqual(['还没有安装后台常驻：先运行 agent-canvas service install，或在终端里用 agent-canvas start']);
    expect(readLock(dataDir)).not.toBeNull();
  });
});

test('--help 列出六个 service 命令', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    expect(await main(['--help'])).toBe(0);
    const text = log.mock.calls.map((c) => String(c[0])).join('\n');
    for (const line of [
      'agent-canvas service install [--port <n>] [--yes]',
      'agent-canvas service uninstall [--yes]',
      'agent-canvas service status',
      'agent-canvas service start',
      'agent-canvas service stop',
      'agent-canvas service restart',
    ]) {
      expect(text).toContain(line);
    }
  } finally {
    log.mockRestore();
  }
});

test('不认识的子命令：打印用法，退出 1', async () => {
  expect(await run(['bogus'])).toBe(1);
  expect(err.join('\n')).toContain('agent-canvas service install');
});
