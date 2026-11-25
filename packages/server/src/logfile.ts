import fs from 'node:fs';
import path from 'node:path';

/**
 * The background service's log (spec 2026-11-25-background-service-design.md 6): what `start` prints in a terminal,
 * each line prefixed with its ISO time. Over LOG_MAX_BYTES the file is renamed to `<file>.1` (replacing the earlier
 * one) and a new one begun: at most twice the limit on disk. Writing never throws: a log that cannot be written must
 * not stop the service.
 */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;

export interface LogFile {
  write(text: string): void;
  close(): void;
}

export function openLogFile(file: string, opts: { maxBytes?: number; now?: () => Date } = {}): LogFile {
  const maxBytes = opts.maxBytes ?? LOG_MAX_BYTES;
  const now = opts.now ?? ((): Date => new Date());
  const ensureDir = (): void => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch {
      // written nowhere then
    }
  };
  ensureDir();
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    // no file yet
  }
  let atLineStart = true;
  let closed = false;

  const append = (chunk: string): void => {
    const bytes = Buffer.byteLength(chunk);
    if (size > 0 && size + bytes > maxBytes) {
      try {
        fs.renameSync(file, `${file}.1`);
      } catch {
        // could not rotate: keep appending to the current file
      }
      try {
        size = fs.statSync(file).size;
      } catch {
        size = 0;
      }
    }
    try {
      fs.appendFileSync(file, chunk);
    } catch (err) {
      // The directory was removed while running: create it again, once.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
      ensureDir();
      try {
        fs.appendFileSync(file, chunk);
      } catch {
        return;
      }
    }
    size += bytes;
  };

  return {
    write(text) {
      if (closed || text === '') return;
      // Line by line, so the file rotates between lines; a line split over several writes gets one prefix.
      let i = 0;
      while (i < text.length) {
        const nl = text.indexOf('\n', i);
        const end = nl === -1 ? text.length : nl + 1;
        append(`${atLineStart ? `${now().toISOString()} ` : ''}${text.slice(i, end)}`);
        atLineStart = nl !== -1;
        i = end;
      }
    },
    close() {
      closed = true;
    },
  };
}

type WriteFn = typeof process.stdout.write;

/**
 * Sends everything written to process.stdout and process.stderr to `log` instead (the background service has no
 * terminal). Returns the function that puts the original writers back.
 */
export function captureProcessOutput(log: LogFile): () => void {
  const streams = [process.stdout, process.stderr] as const;
  const originals = streams.map((s) => s.write);
  for (const stream of streams) {
    const write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void): boolean => {
      const callback = typeof encoding === 'function' ? encoding : cb;
      // The encoding argument names how a string is encoded; text kept as text, bytes read as UTF-8.
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      log.write(text);
      if (callback !== undefined) process.nextTick(callback);
      return true;
    }) as WriteFn;
    stream.write = write;
  }
  return () => {
    streams.forEach((s, i) => {
      s.write = originals[i]!;
    });
  };
}
