import fs from 'node:fs';
import path from 'node:path';

export interface Lock {
  release(): void;
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

function readHolder(file: string): { pid: number } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: unknown };
    return typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0 ? { pid: parsed.pid } : null;
  } catch {
    return null;
  }
}

/**
 * Takes `<dataDir>/agent-canvas.lock` (pid and start time), shared by `start` and `rebuild`. Throws when another
 * live process holds it; a lock left by a process that is no longer running is taken over.
 */
export function acquireLock(dataDir: string): Lock {
  const file = lockPath(dataDir);
  const content = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, content, { flag: 'wx' });
      return {
        release() {
          // Only remove the file if it is still ours.
          if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) fs.rmSync(file, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const holder = readHolder(file);
    if (holder !== null && isAlive(holder.pid)) {
      throw new Error(`agent-canvas is already running with this data directory (pid ${holder.pid}); lock file: ${file}`);
    }
    fs.rmSync(file, { force: true }); // stale (holder gone) or unreadable: take it over
  }
  throw new Error(`could not take the lock file ${file}`);
}
