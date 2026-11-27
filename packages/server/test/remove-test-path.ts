import { removeSync } from '../src/fs-remove.js';

const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);

/**
 * Removes a test's temporary file or directory (with its contents; a missing path is fine). Built on removeSync, never
 * fs's own recursive remove (see fs-remove.ts); retries like that one's maxRetries / retryDelay, for Windows, where a
 * database or log a test just closed can stay locked for a moment.
 */
export function removeTestPath(target: string, o: { retries?: number; delayMs?: number } = {}): void {
  const { retries = 10, delayMs = 100 } = o;
  for (let attempt = 0; ; attempt++) {
    try {
      removeSync(target, { recursive: true });
      return;
    } catch (err) {
      if (attempt >= retries || !RETRYABLE.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
}
