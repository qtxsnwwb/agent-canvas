import { CONTROL_HEADER, readControlKey } from '../control.js';
import { holderResponds, isStaleService, readLock, type LockHolder } from '../lock.js';
import type { ServiceBackend } from './types.js';

export type StopResult = 'stopped' | 'not-running' | 'stale' | 'timeout' | 'unreachable' | 'old-version' | 'maintenance';

const POLL_MS = 200;
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The lock's holder as the service commands see it: a `start` holder left behind by a service that is gone (its port
 * does not answer, lock.ts isStaleService) is not running; it is returned as `stale` instead.
 */
export async function readServiceLock(dataDir: string): Promise<{ holder: LockHolder | null; stale: LockHolder | null }> {
  const holder = readLock(dataDir);
  if (holder !== null && (await isStaleService(holder))) return { holder: null, stale: holder };
  return { holder, stale: null };
}

/**
 * Asks the running service to stop (spec 5): `POST /api/control/stop` on the port in the lock, with the control key,
 * then waits until the lock is released. `stale`: the lock was left by a service that is gone (nothing to stop);
 * `old-version`: the holder is a service from before the stop request existed (no port or no key file);
 * `maintenance`: a rebuild or compaction holds the lock, which is not stopped from here.
 */
export async function stopRunning(
  dataDir: string,
  o: { timeoutMs?: number; sleep?: (ms: number) => Promise<void>; fetch?: typeof fetch } = {},
): Promise<StopResult> {
  const { timeoutMs = 30_000, sleep = defaultSleep, fetch: doFetch = fetch } = o;
  const holder = readLock(dataDir);
  if (holder === null) return 'not-running';
  if (holder.command !== 'start') return 'maintenance';
  if (await isStaleService(holder)) return 'stale';
  const key = readControlKey(dataDir);
  if (holder.port === null || key === null) return 'old-version';
  try {
    const res = await doFetch(`http://127.0.0.1:${holder.port}/api/control/stop`, {
      method: 'POST',
      headers: { [CONTROL_HEADER]: key },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status !== 202) return 'unreachable';
  } catch {
    return 'unreachable';
  }
  for (let waited = 0; waited < timeoutMs; waited += POLL_MS) {
    await sleep(POLL_MS);
    if (readLock(dataDir) === null) return 'stopped';
  }
  return 'timeout';
}

/**
 * Polls until a `start` holder with a port that answers shows up (the service is listening); null after `timeoutMs`.
 * A holder whose port does not answer (a lock left behind) is checked once and then passed over.
 */
export async function waitForStart(
  dataDir: string,
  o: { timeoutMs: number; sleep: (ms: number) => Promise<void>; now: () => number },
): Promise<LockHolder | null> {
  const deadline = o.now() + o.timeoutMs;
  let stale: string | null = null;
  for (;;) {
    const holder = readLock(dataDir);
    if (holder !== null && holder.command === 'start' && holder.port !== null) {
      const id = `${holder.pid}/${holder.startedAt}/${holder.port}`;
      if (id !== stale) {
        if (await holderResponds(holder)) return holder;
        stale = id;
      }
    }
    if (o.now() >= deadline) return null;
    await o.sleep(POLL_MS);
  }
}

/** 「不到 1 分钟」「N 分」「H 小时 M 分」「D 天 H 小时」 */
export function formatUptime(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

/**
 * The lines `service status` prints (spec 4) and its exit code: 0 while a service runs, 3 otherwise. `stale`: a lock
 * left behind by a service that is gone (readServiceLock), shown when there is no live holder.
 */
export function statusLines(o: {
  holder: LockHolder | null;
  stale?: LockHolder | null;
  now: number;
  state: 'installed' | 'disabled' | 'absent' | 'unsupported';
  where: string | null;
  logFile: string;
  kind: ServiceBackend['kind'] | null;
}): { lines: string[]; code: 0 | 3 } {
  const { holder } = o;
  let service: string;
  let code: 0 | 3 = 3;
  if (holder === null) {
    service = o.stale != null ? `服务：没有运行（锁文件残留，进程号 ${o.stale.pid}）` : '服务：没有运行';
  } else if (holder.command === 'rebuild') {
    service = `服务：没有运行（正在重建数据，进程号 ${holder.pid}）`;
  } else if (holder.command === 'compact') {
    service = `服务：没有运行（正在压缩数据库，进程号 ${holder.pid}）`;
  } else {
    const started = Date.parse(holder.startedAt);
    const parts = [
      `进程号 ${holder.pid}`,
      `端口 ${holder.port ?? '未知'}`,
      `版本 ${holder.version ?? '未知'}`,
      ...(Number.isNaN(started) ? [] : [`已运行 ${formatUptime(o.now - started)}`]),
    ];
    service = `服务：正在运行（${parts.join('，')}）`;
    code = 0;
  }
  const where = o.where ?? '';
  let auto: string;
  if (o.state === 'installed') auto = `自动启动：已安装（${where}）`;
  else if (o.state === 'disabled') auto = o.kind === 'windows' ? `自动启动：已安装，但在任务管理器里被停用（${where}）` : `自动启动：已安装，但已停用（${where}）`;
  else if (o.state === 'absent') auto = '自动启动：没有安装';
  else auto = '自动启动：这个系统不支持';
  return { lines: [service, auto, `日志：${o.logFile}`], code };
}
