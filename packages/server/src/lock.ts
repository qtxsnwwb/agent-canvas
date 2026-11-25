import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { removeSync } from './fs-remove.js';

/** The command that holds the lock: the service, or one of the maintenance commands that must not run beside it. */
export type LockCommand = 'start' | 'rebuild' | 'compact';

/** What the lock file says about its holder (readLock, LockHeldError). */
export interface LockHolder {
  pid: number;
  startedAt: string;
  command: LockCommand;
  /** The holder's package version; null in a lock written before it was recorded. */
  version: string | null;
  /** Started with `--service` (the background service). */
  service: boolean;
  /** The port the service listens on, once it does; null before, and for rebuild / compact. */
  port: number | null;
}

/** What the taker records in the lock (acquireLock). */
export interface LockInfo {
  command: LockCommand;
  version: string;
  service?: boolean;
}

export interface Lock {
  release(): void;
  /** Records the port the service listens on (rewrites the file, only while it is still this lock's). */
  setPort(port: number): void;
}

/** Thrown by acquireLock while another live process holds the lock. */
export class LockHeldError extends Error {
  readonly holder: LockHolder;
  /** The lock file. */
  readonly file: string;
  constructor(holder: LockHolder, file: string) {
    super(`agent-canvas is already running with this data directory (pid ${holder.pid}); lock file: ${file}`);
    this.name = 'LockHeldError';
    this.holder = holder;
    this.file = file;
  }
}

export function lockPath(dataDir: string): string {
  return path.join(dataDir, 'agent-canvas.lock');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by someone else
  }
}

const COMMANDS: readonly LockCommand[] = ['start', 'rebuild', 'compact'];

/**
 * The holder recorded in the file, or null when it is missing or unreadable. A lock written before the command,
 * version, mode and port were recorded (only pid and start time) reads as a `start` holder.
 */
function readHolder(file: string): LockHolder | null {
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof value !== 'object' || value === null) return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const { pid, startedAt, command, version, service, port } = parsed;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  return {
    pid,
    startedAt: typeof startedAt === 'string' ? startedAt : '',
    command: COMMANDS.includes(command as LockCommand) ? (command as LockCommand) : 'start',
    version: typeof version === 'string' ? version : null,
    service: service === true,
    port: typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535 ? port : null,
  };
}

/** The live holder of `<dataDir>/agent-canvas.lock`; null when there is no file, it is unreadable, or its holder is gone. */
export function readLock(dataDir: string): LockHolder | null {
  const holder = readHolder(lockPath(dataDir));
  return holder !== null && isAlive(holder.pid) ? holder : null;
}

/**
 * Replaces the file's content in one step (a temporary file renamed over it), so a reader never sees it half
 * written and takes it for unreadable; falls back to writing in place when the rename is refused.
 */
function rewrite(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch {
    removeSync(tmp);
    fs.writeFileSync(file, content);
  }
}

/**
 * Takes `<dataDir>/agent-canvas.lock` (pid, start time, command, version, service mode; the port once listening),
 * shared by `start`, `rebuild` and `compact`. Throws LockHeldError when another live process holds it; a lock left by
 * a process that is no longer running is taken over.
 */
export function acquireLock(dataDir: string, info: LockInfo): Lock {
  const file = lockPath(dataDir);
  const record = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    command: info.command,
    version: info.version,
    service: info.service === true,
    port: null as number | null,
  };
  let content = JSON.stringify(record);
  /** Whether the file still holds what this lock wrote last. */
  const ours = (): boolean => {
    try {
      return fs.readFileSync(file, 'utf8') === content;
    } catch {
      return false;
    }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, content, { flag: 'wx' });
      return {
        release() {
          // Only remove the file if it is still ours.
          if (ours()) removeSync(file);
        },
        setPort(port) {
          if (!ours()) return;
          const next = JSON.stringify({ ...record, port });
          rewrite(file, next);
          content = next;
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const holder = readHolder(file);
    if (holder !== null && isAlive(holder.pid)) throw new LockHeldError(holder, file);
    removeSync(file); // stale (holder gone) or unreadable: take it over
  }
  throw new Error(`could not take the lock file ${file}`);
}

/** Whether 127.0.0.1:<port> accepts a TCP connection within `timeoutMs`. */
function connects(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Whether the holder's port accepts a TCP connection on 127.0.0.1 (tried `attempts` times, each given `timeoutMs`);
 * false when it records no port.
 */
export async function holderResponds(holder: LockHolder, o: { attempts?: number; timeoutMs?: number } = {}): Promise<boolean> {
  const { attempts = 2, timeoutMs = 500 } = o;
  if (holder.port === null) return false;
  for (let i = 0; i < attempts; i++) {
    if (await connects(holder.port, timeoutMs)) return true;
  }
  return false;
}

/**
 * A lock left behind by a service that is gone (spec 2026-11-25-background-service-design.md 5): a `start` holder
 * that records a port where nothing answers. Windows ends the service at logoff or shutdown without its clean-up, so
 * the lock stays; once its pid belongs to another process, the holder reads as alive. Such a holder does not count
 * as a running service. A holder without a port (still starting) and rebuild / compact holders are never stale.
 */
export async function isStaleService(holder: LockHolder): Promise<boolean> {
  return holder.command === 'start' && holder.port !== null && !(await holderResponds(holder));
}

/** Removes the lock file `file` when it still names `holder` (same pid, start time and port): a newer lock stays. */
export function removeStaleLock(file: string, holder: LockHolder): void {
  const current = readHolder(file);
  if (current === null || current.pid !== holder.pid || current.startedAt !== holder.startedAt || current.port !== holder.port) return;
  removeSync(file);
}
