import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { start, type Running } from '../src/cli-commands.js';
import { loadConfig, SERVICE_ENV_VARS } from '../src/config.js';
import { createControlKey } from '../src/control.js';
import { lockPath, type LockHolder } from '../src/lock.js';
import type { DeliveryStatus, NotificationMessage } from '../src/notify/desktop.js';
import type { ServiceNotifier } from '../src/notify/service.js';
import { formatUptime, statusLines, stopRunning, waitForStart } from '../src/service/client.js';
import { pickServiceEnv, serviceDefinition } from '../src/service/definition.js';
import { manifestPath, readManifest, removeManifest, writeManifest, type ServiceManifest } from '../src/service/manifest.js';

/*
 * The service core: the environment list, the definition, the manifest, and the stop / status client. Temp
 * directories and port 0 only; nothing is registered with the system.
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
let running: Running | null;
let stub: FastifyInstance | null;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-service-core-'));
  dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  running = null;
  stub = null;
});
afterEach(async () => {
  await running?.close().catch(() => undefined);
  await stub?.close().catch(() => undefined);
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10 });
});

const SPEC_LIST = [
  'AGENT_CANVAS_DATA_DIR',
  'AGENT_CANVAS_PROJECTS_DIR',
  'AGENT_CANVAS_CODEX_DIR',
  'AGENT_CANVAS_CURSOR_DB',
  'AGENT_CANVAS_GEMINI_DIR',
  'AGENT_CANVAS_GROK_DIR',
  'AGENT_CANVAS_COPILOT_DIR',
  'AGENT_CANVAS_DSH_DIR',
  'AGENT_CANVAS_WORKBUDDY_DIR',
  'AGENT_CANVAS_CODEBUDDY_DIR',
  'AGENT_CANVAS_DOUBAO_DIR',
  'AGENT_CANVAS_QWEN_DIR',
  'GEMINI_CLI_HOME',
  'GROK_HOME',
  'COPILOT_HOME',
  'DSH_HOME',
  'WORKBUDDY_CONFIG_DIR',
  'CODEBUDDY_CONFIG_DIR',
  'QWEN_RUNTIME_DIR',
  'QWEN_HOME',
];

describe('SERVICE_ENV_VARS', () => {
  test('is exactly the spec list, in order', () => {
    expect([...SERVICE_ENV_VARS]).toEqual(SPEC_LIST);
  });

  test('covers every variable config.ts reads, and setting each changes the config', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'config.ts'), 'utf8');
    const names = new Set<string>();
    for (const m of source.matchAll(/['"]([A-Z][A-Z0-9_]*_[A-Z0-9_]+)['"]|\benv\.([A-Z][A-Z0-9_]+)/g)) names.add(m[1] ?? m[2]!);
    for (const exempt of ['APPDATA', 'LOCALAPPDATA']) names.delete(exempt);
    expect([...names].filter((n) => !SERVICE_ENV_VARS.includes(n))).toEqual([]);
    expect(names.size).toBeGreaterThan(0);

    const clean: NodeJS.ProcessEnv = {};
    const base = loadConfig(clean);
    for (const name of SERVICE_ENV_VARS) {
      const value = path.join(tmp, name.toLowerCase());
      expect(loadConfig({ [name]: value }), name).not.toEqual(base);
    }
  });

  test('the test and tuning switches are not picked', () => {
    const picked = pickServiceEnv({ AGENT_CANVAS_TIMING_SCALE: '0.01', AGENT_CANVAS_STATS_WARMUP: '0', AGENT_CANVAS_DATA_DIR: '/d' });
    expect(picked).toEqual({ AGENT_CANVAS_DATA_DIR: '/d' });
  });

  test('pickServiceEnv keeps the empty string and skips unset variables', () => {
    expect(pickServiceEnv({ AGENT_CANVAS_CODEX_DIR: '', QWEN_HOME: '/q', PATH: '/bin' })).toEqual({ AGENT_CANVAS_CODEX_DIR: '', QWEN_HOME: '/q' });
  });
});

describe('serviceDefinition', () => {
  test('argv, data dir from the environment, log file under dataDir/logs', () => {
    const def = serviceDefinition({ env: { AGENT_CANVAS_DATA_DIR: dataDir, GROK_HOME: '/g' }, port: 4400, nodePath: '/n/node', cliPath: '/c/cli.js' });
    expect(def.dataDir).toBe(dataDir);
    expect(def.logFile).toBe(path.join(dataDir, 'logs', 'service.log'));
    expect(def.argv).toEqual(['/n/node', '/c/cli.js', 'start', '--port', '4400', '--log-file', def.logFile, '--service']);
    expect(def.env).toEqual({ AGENT_CANVAS_DATA_DIR: dataDir, GROK_HOME: '/g' });
    expect(def).toMatchObject({ nodePath: '/n/node', cliPath: '/c/cli.js', port: 4400 });
  });

  test('without AGENT_CANVAS_DATA_DIR the data dir is the default one', () => {
    expect(serviceDefinition({ env: {}, port: 4317, nodePath: 'n', cliPath: 'c' }).dataDir).toBe(loadConfig({}).dataDir);
  });
});

describe('manifest', () => {
  test.each([
    ['win32 with APPDATA', 'win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'C:\\Users\\a', 'C:\\Users\\a\\AppData\\Roaming\\agent-canvas\\service.json'],
    ['win32 without APPDATA', 'win32', {}, 'C:\\Users\\a', 'C:\\Users\\a\\AppData\\Roaming\\agent-canvas\\service.json'],
    ['darwin', 'darwin', {}, '/Users/a', '/Users/a/Library/Application Support/agent-canvas/service.json'],
    ['linux with XDG_CONFIG_HOME', 'linux', { XDG_CONFIG_HOME: '/x/cfg' }, '/home/a', '/x/cfg/agent-canvas/service.json'],
    ['linux without XDG_CONFIG_HOME', 'linux', {}, '/home/a', '/home/a/.config/agent-canvas/service.json'],
  ] as const)('manifestPath: %s', (_name, platform, env, home, expected) => {
    expect(manifestPath({ platform, env, home })).toBe(expected);
  });

  const sample = (system: { platform: NodeJS.Platform }): ServiceManifest => ({
    ...serviceDefinition({ env: { AGENT_CANVAS_DATA_DIR: dataDir }, port: 4401, nodePath: '/n/node', cliPath: '/c/cli.js' }),
    version: 1,
    platform: system.platform,
    where: 'Windows 启动项 HKCU\\...\\Run\\AgentCanvas',
    installedAt: '2026-11-25T00:00:00.000Z',
  });

  test('write, read, remove', () => {
    const system = { platform: process.platform, env: { APPDATA: path.join(tmp, 'roaming'), XDG_CONFIG_HOME: path.join(tmp, 'cfg') }, home: path.join(tmp, 'home') };
    expect(readManifest(system)).toBeNull();
    const m = sample(system);
    writeManifest(system, m);
    expect(readManifest(system)).toEqual(m);
    removeManifest(system);
    expect(readManifest(system)).toBeNull();
    removeManifest(system); // already gone: no error
  });

  test('a garbage or incomplete file reads as null', () => {
    const system = { platform: process.platform, env: { APPDATA: path.join(tmp, 'roaming'), XDG_CONFIG_HOME: path.join(tmp, 'cfg') }, home: path.join(tmp, 'home') };
    const file = manifestPath(system);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json {');
    expect(readManifest(system)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: 1 }));
    expect(readManifest(system)).toBeNull();
  });
});

function writeLock(record: Record<string, unknown>): void {
  fs.writeFileSync(lockPath(dataDir), JSON.stringify({ pid: process.pid, startedAt: '2026-11-25T00:00:00.000Z', ...record }));
}

describe('stopRunning', () => {
  test('a real service stops', async () => {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    vi.stubEnv('AGENT_CANVAS_DATA_DIR', dataDir);
    vi.stubEnv('AGENT_CANVAS_PROJECTS_DIR', path.join(tmp, 'projects'));
    vi.stubEnv('AGENT_CANVAS_CODEX_DIR', '');
    vi.stubEnv('AGENT_CANVAS_CURSOR_DB', '');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('APPDATA', path.join(home, 'AppData', 'Roaming'));
    vi.stubEnv('LOCALAPPDATA', path.join(home, 'AppData', 'Local'));
    running = await start({ port: 0 }, { notifier: new FakeNotifier(), storage: false, searchIndex: false, statsWarmup: false, service: true });
    const holder = await waitForStart(dataDir, { timeoutMs: 5000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now });
    expect(holder).toMatchObject({ pid: process.pid, command: 'start', service: true });
    expect(holder?.port).toBeGreaterThan(0);
    expect(await stopRunning(dataDir, { timeoutMs: 10_000 })).toBe('stopped');
    expect(fs.existsSync(lockPath(dataDir))).toBe(false);
  });

  test('no lock: not-running', async () => {
    expect(await stopRunning(dataDir)).toBe('not-running');
  });

  test('a lock whose holder is gone: not-running', async () => {
    writeLock({ pid: 2 ** 22 + 12345, command: 'start', port: 4999 });
    expect(await stopRunning(dataDir)).toBe('not-running');
  });

  test('an old-format lock of a live process: old-version', async () => {
    writeLock({});
    expect(await stopRunning(dataDir)).toBe('old-version');
  });

  test('a service with a port but no key file: old-version', async () => {
    writeLock({ command: 'start', version: '0.4.0', service: true, port: 4999 });
    expect(await stopRunning(dataDir)).toBe('old-version');
  });

  test.each(['compact', 'rebuild'])('a %s holder: maintenance', async (command) => {
    writeLock({ command, version: '0.5.0', service: false, port: null });
    expect(await stopRunning(dataDir)).toBe('maintenance');
  });

  test('a port nothing listens on: unreachable', async () => {
    const probe = Fastify();
    await probe.listen({ port: 0, host: '127.0.0.1' });
    const port = (probe.server.address() as { port: number }).port;
    await probe.close(); // now free
    createControlKey(dataDir);
    writeLock({ command: 'start', version: '0.5.0', service: true, port });
    expect(await stopRunning(dataDir)).toBe('unreachable');
  });

  test('a service that answers 202 and never exits: timeout', async () => {
    stub = Fastify();
    let seen: string | undefined;
    stub.post('/api/control/stop', async (req, reply) => {
      seen = String(req.headers['x-agent-canvas-key']);
      return reply.code(202).send({});
    });
    await stub.listen({ port: 0, host: '127.0.0.1' });
    const port = (stub.server.address() as { port: number }).port;
    const key = createControlKey(dataDir);
    writeLock({ command: 'start', version: '0.5.0', service: true, port });
    expect(await stopRunning(dataDir, { timeoutMs: 500 })).toBe('timeout');
    expect(seen).toBe(key);
  });
});

describe('waitForStart', () => {
  test('returns null once the time is up', async () => {
    let t = 0;
    const holder = await waitForStart(dataDir, { timeoutMs: 1000, sleep: async (ms) => void (t += ms), now: () => t });
    expect(holder).toBeNull();
  });

  test('ignores a holder without a port or a maintenance holder, then returns the listening one', async () => {
    let t = 0;
    const steps: Array<Record<string, unknown>> = [{ command: 'start', port: null }, { command: 'compact', port: null }, { command: 'start', port: 4555, version: '0.5.0' }];
    let i = 0;
    writeLock(steps[0]!);
    const holder = await waitForStart(dataDir, {
      timeoutMs: 10_000,
      sleep: async (ms) => {
        t += ms;
        i += 1;
        writeLock(steps[Math.min(i, steps.length - 1)]!);
      },
      now: () => t,
    });
    expect(holder).toMatchObject({ command: 'start', port: 4555 });
  });
});

describe('formatUptime', () => {
  test.each([
    [30_000, '不到 1 分钟'],
    [5 * 60_000, '5 分'],
    [(2 * 60 + 3) * 60_000, '2 小时 3 分'],
    [(3 * 24 + 4) * 3_600_000, '3 天 4 小时'],
  ])('%d ms', (ms, expected) => {
    expect(formatUptime(ms)).toBe(expected);
  });
});

describe('statusLines', () => {
  const startedAt = '2026-11-25T10:00:00.000Z';
  const now = Date.parse(startedAt) + (2 * 60 + 3) * 60_000;
  const holder = (over: Partial<LockHolder> = {}): LockHolder => ({ pid: 18244, startedAt, command: 'start', version: '0.5.0', service: true, port: 4317, ...over });
  const base = { now, logFile: 'C:\\logs\\service.log' };

  test('running + installed', () => {
    expect(statusLines({ ...base, holder: holder(), state: 'installed', where: 'Windows 启动项', kind: 'windows' })).toEqual({
      lines: ['服务：正在运行（进程号 18244，端口 4317，版本 0.5.0，已运行 2 小时 3 分）', '自动启动：已安装（Windows 启动项）', '日志：C:\\logs\\service.log'],
      code: 0,
    });
  });

  test('not running + absent', () => {
    expect(statusLines({ ...base, holder: null, state: 'absent', where: null, kind: 'linux' })).toEqual({
      lines: ['服务：没有运行', '自动启动：没有安装', '日志：C:\\logs\\service.log'],
      code: 3,
    });
  });

  test('maintenance holders', () => {
    const compact = statusLines({ ...base, holder: holder({ command: 'compact', port: null }), state: 'installed', where: 'w', kind: 'macos' });
    expect(compact.lines[0]).toBe('服务：没有运行（正在压缩数据库，进程号 18244）');
    expect(compact.code).toBe(3);
    const rebuild = statusLines({ ...base, holder: holder({ command: 'rebuild', port: null }), state: 'installed', where: 'w', kind: 'macos' });
    expect(rebuild.lines[0]).toBe('服务：没有运行（正在重建数据，进程号 18244）');
    expect(rebuild.code).toBe(3);
  });

  test('disabled: Windows names the task manager, Linux just says disabled', () => {
    expect(statusLines({ ...base, holder: null, state: 'disabled', where: 'Windows 启动项', kind: 'windows' }).lines[1]).toBe('自动启动：已安装，但在任务管理器里被停用（Windows 启动项）');
    expect(statusLines({ ...base, holder: null, state: 'disabled', where: '/home/a/.config/systemd/user/agent-canvas.service', kind: 'linux' }).lines[1]).toBe(
      '自动启动：已安装，但已停用（/home/a/.config/systemd/user/agent-canvas.service）',
    );
  });

  test('unsupported system, service running', () => {
    const r = statusLines({ ...base, holder: holder(), state: 'unsupported', where: null, kind: null });
    expect(r.lines[1]).toBe('自动启动：这个系统不支持');
    expect(r.code).toBe(0);
  });

  test('an old lock without version or start time still reads', () => {
    const r = statusLines({ ...base, holder: holder({ version: null, startedAt: '', port: null }), state: 'absent', where: null, kind: null });
    expect(r.lines[0]).toBe('服务：正在运行（进程号 18244，端口 未知，版本 未知）');
  });
});
