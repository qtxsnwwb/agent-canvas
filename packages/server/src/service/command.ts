import { parseArgs } from 'node:util';
import { isNpxPath, PACKAGE_NAME } from '../cli-commands.js';
import { loadConfig } from '../config.js';
import type { HooksCliIo } from '../hooks-cli.js';
import { readLock, type LockHolder } from '../lock.js';
import { serviceBackend } from './backend.js';
import { readServiceLock, statusLines, stopRunning, waitForStart, type StopResult } from './client.js';
import { serviceDefinition } from './definition.js';
import { manifestPath, readManifest, removeManifest, writeManifest, type ServiceManifest } from './manifest.js';
import type { ServiceBackend, ServiceDefinition, ServiceSystem } from './types.js';

/*
 * `agent-canvas service install|uninstall|status|start|stop|restart` (spec 2026-11-25-background-service-design.md 4).
 * The manifest, when there is one, decides the data directory and port; otherwise the current shell's settings do.
 */

export interface ServiceCommandOptions {
  system: ServiceSystem;
  io: HooksCliIo;
  cliPath: string;
  nodePath: string;
  /** Default: the system's own (serviceBackend); null where the background service is not supported. */
  backend?: ServiceBackend | null;
}

const UNSUPPORTED = '这个系统不支持后台常驻（只支持 Windows、macOS、Linux）';
const NOT_INSTALLED_START = '还没有安装后台常驻：先运行 agent-canvas service install，或在终端里用 agent-canvas start';
const START_TIMEOUT_MS = 15_000;

/**
 * What `stop` says for a result, and its exit code. `stale`: the pid of the lock left behind (null: not known);
 * `logFile`: the service's log, named while it is still starting.
 */
function stopMessage(result: StopResult, o: { stale: LockHolder | null; logFile: string }): { text: string; code: 0 | 1 } {
  switch (result) {
    case 'stopped':
      return { text: '已停止', code: 0 };
    case 'not-running':
      return { text: '没有在运行', code: 0 };
    case 'stale':
      return { text: o.stale !== null ? `没有在运行（锁文件残留，进程号 ${o.stale.pid}）` : '没有在运行（锁文件残留）', code: 0 };
    case 'starting':
      return { text: `服务正在启动（可能在重建数据），稍后再试；日志：${o.logFile}`, code: 1 };
    case 'timeout':
      return { text: '服务没有在 30 秒内退出', code: 1 };
    case 'old-version':
      return { text: '服务在运行，但不能用这个命令停止（版本较旧）：请在它的终端里按 Ctrl+C', code: 1 };
    case 'maintenance':
      return { text: '正在重建数据 / 压缩数据库，做完会自己退出', code: 1 };
    case 'unreachable':
      return { text: '连不上服务', code: 1 };
  }
}

interface Context extends ServiceCommandOptions {
  backend: ServiceBackend | null;
}

/** The definition from the current shell: its data directory, the given port (default: the configured one). */
function shellDefinition(c: Context, port?: number): ServiceDefinition {
  return serviceDefinition({ env: c.system.env, port: port ?? loadConfig(c.system.env).port, nodePath: c.nodePath, cliPath: c.cliPath });
}

/** The service to act on: the installed one (manifest), else the one the current shell would run. */
function currentDefinition(c: Context): { def: ServiceDefinition; manifest: ServiceManifest | null } {
  const manifest = readManifest(c.system);
  return { def: manifest ?? shellDefinition(c), manifest };
}

/** Asks before changing anything, as `hooks install` does; false: refused or declined (already said). */
async function confirmed(c: Context, yes: boolean, refusal: string): Promise<boolean> {
  if (yes) return true;
  if (!c.io.isInteractive) {
    c.io.err(refusal);
    return false;
  }
  if (await c.io.confirm('继续吗？(y/N) ')) return true;
  c.io.out('已取消，未做任何改动');
  return false;
}

/**
 * Waits for the service just started to listen; prints its address, or where to look. After the wait a service that
 * holds the lock without a port yet (a rebuild after an upgrade can take minutes) did start: exit 0.
 */
async function reportStart(c: Context, def: ServiceDefinition, timeoutPrefix: string): Promise<number> {
  const holder = await waitForStart(def.dataDir, { timeoutMs: START_TIMEOUT_MS, sleep: c.system.sleep, now: c.system.now });
  if (holder === null) {
    const starting = readLock(def.dataDir);
    if (starting !== null && starting.command === 'start' && starting.port === null) {
      c.io.out(`服务还在启动（可能在重建数据），看日志：${def.logFile}`);
      return 0;
    }
    c.io.err(`${timeoutPrefix}服务没有在 15 秒内起来，看日志：${def.logFile}`);
    return 1;
  }
  c.io.out(`已在后台启动：http://127.0.0.1:${holder.port}`);
  return 0;
}

async function install(c: Context, args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { port: { type: 'string' }, yes: { type: 'boolean' } }, allowPositionals: false });
  let port: number | undefined;
  if (values.port !== undefined) {
    port = /^[0-9]+$/.test(values.port) ? Number(values.port) : NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port 不合法：${values.port}`);
  }
  if (isNpxPath(c.cliPath)) {
    // The registration runs a command line that names this cli.js; npx's cache is not a stable place for it.
    c.io.err(
      `后台常驻要记下本程序的绝对路径，而现在是用 npx 临时运行的（${c.cliPath}），这个路径随时可能失效。\n`
      + `请先全局安装：npm install -g ${PACKAGE_NAME}\n然后运行：agent-canvas service install`,
    );
    return 1;
  }
  const { backend, system, io } = c;
  if (backend === null) {
    io.err(UNSUPPORTED);
    return 1;
  }
  const def = shellDefinition(c, port);
  // The installed service runs on its own data dir: installing for another one would start a second service there.
  const previous = readManifest(system);
  if (previous !== null && previous.dataDir !== def.dataDir) {
    const { holder: old } = await readServiceLock(previous.dataDir);
    if (old !== null && old.command === 'start') {
      io.err(`已有服务在运行（进程号 ${old.pid}，数据目录 ${previous.dataDir}）；先运行 agent-canvas service stop 停掉它，再重新安装`);
      return 1;
    }
  }
  const reason = await backend.check(def);
  if (reason !== null) {
    io.err(reason);
    return 1;
  }
  const file = manifestPath(system);
  if (previous !== null) io.out('更新已有的安装');
  for (const line of backend.plan(def)) io.out(line);
  io.out(`写服务清单：${file}`);
  if (!(await confirmed(c, values.yes === true, '非交互终端下需要加 --yes 才会写入'))) return 1;

  await backend.register(def);
  writeManifest(system, { ...def, version: 1, platform: system.platform, where: backend.where, installedAt: new Date(system.now()).toISOString() });
  io.out(`已登记：${backend.where}`);
  io.out(`已写入 ${file}`);
  const { holder } = await readServiceLock(def.dataDir);
  if (holder !== null && holder.command === 'start') {
    io.out(`已有服务在运行（进程号 ${holder.pid}）；先停掉它，再运行 agent-canvas service start`);
    return 0;
  }
  await backend.start(def);
  return reportStart(c, def, '已登记，但');
}

async function uninstall(c: Context, args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { yes: { type: 'boolean' } }, allowPositionals: false });
  const { backend, system, io } = c;
  const { def, manifest } = currentDefinition(c);
  if (backend === null) {
    if (manifest === null) {
      io.out('没有安装');
      return 0;
    }
    io.err(UNSUPPORTED);
    return 1;
  }
  if (manifest === null && (await backend.state(def)) === 'absent') {
    io.out('没有安装');
    return 0;
  }
  const file = manifestPath(system);
  io.out('将停止正在运行的服务（如果有）');
  io.out(`将取消登记：${backend.where}`);
  if (manifest !== null) io.out(`将删除服务清单：${file}`);
  io.out(`数据库、日志和设置都不动（${def.dataDir}）`);
  if (!(await confirmed(c, values.yes === true, '非交互终端下需要加 --yes 才会删除'))) return 1;

  const stopped = await stopRunning(def.dataDir, { sleep: system.sleep });
  if (stopped === 'stopped') io.out('已停止服务');
  else if (stopped !== 'not-running' && stopped !== 'stale') io.err(`没能停止服务：${stopMessage(stopped, { stale: null, logFile: def.logFile }).text}`);
  await backend.cancelRestart(def);
  await backend.unregister(def);
  io.out(`已取消登记：${backend.where}`);
  if (manifest !== null) {
    removeManifest(system);
    io.out(`已删除 ${file}`);
  }
  return 0;
}

async function status(c: Context): Promise<number> {
  const { def } = currentDefinition(c);
  const { backend } = c;
  const { holder, stale } = await readServiceLock(def.dataDir);
  const { lines, code } = statusLines({
    holder,
    stale,
    now: c.system.now(),
    state: backend === null ? 'unsupported' : await backend.state(def),
    where: backend?.where ?? null,
    logFile: def.logFile,
    kind: backend?.kind ?? null,
  });
  for (const line of lines) c.io.out(line);
  return code;
}

/** The installed service, or null after saying why there is none to start. */
function installed(c: Context): { manifest: ServiceManifest; backend: ServiceBackend } | null {
  const manifest = readManifest(c.system);
  if (manifest === null) {
    c.io.err(NOT_INSTALLED_START);
    return null;
  }
  if (c.backend === null) {
    c.io.err(UNSUPPORTED);
    return null;
  }
  return { manifest, backend: c.backend };
}

async function startService(c: Context): Promise<number> {
  const target = installed(c);
  if (target === null) return 1;
  const { manifest, backend } = target;
  const { holder } = await readServiceLock(manifest.dataDir);
  if (holder !== null && holder.command === 'start') {
    c.io.out(`服务已在运行（进程号 ${holder.pid}${holder.port !== null ? `，http://127.0.0.1:${holder.port}` : ''}）`);
    return 0;
  }
  await backend.start(manifest);
  return reportStart(c, manifest, '');
}

async function stop(c: Context): Promise<number> {
  const { def, manifest } = currentDefinition(c);
  const { stale } = await readServiceLock(def.dataDir);
  const result = await stopRunning(def.dataDir, { sleep: c.system.sleep });
  // A service that just crashed has no process, but the system would start it again in a moment.
  if (manifest !== null && c.backend !== null) await c.backend.cancelRestart(manifest);
  const { text, code } = stopMessage(result, { stale, logFile: def.logFile });
  if (code === 0) c.io.out(text);
  else c.io.err(text);
  return code;
}

async function restart(c: Context): Promise<number> {
  if (installed(c) === null) return 1;
  const stopped = await stop(c);
  return stopped === 0 ? startService(c) : stopped;
}

/** `agent-canvas service <sub> …`; `usage` is printed for an unknown subcommand. Returns the exit code. */
export async function serviceCommand(args: string[], o: ServiceCommandOptions & { usage?: string }): Promise<number> {
  const c: Context = { ...o, backend: o.backend === undefined ? serviceBackend(o.system) : o.backend };
  const [sub, ...rest] = args;
  try {
    switch (sub) {
      case 'install':
        return await install(c, rest);
      case 'uninstall':
        return await uninstall(c, rest);
    }
    if (sub === 'status' || sub === 'start' || sub === 'stop' || sub === 'restart') {
      parseArgs({ args: rest, options: {}, allowPositionals: false });
      if (sub === 'status') return await status(c);
      if (sub === 'start') return await startService(c);
      if (sub === 'stop') return await stop(c);
      return await restart(c);
    }
    c.io.err((o.usage ?? '').trimEnd());
    return 1;
  } catch (err) {
    c.io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
