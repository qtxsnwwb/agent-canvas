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

/** What Node would print for `reason`: an error's stack, else its text. */
function describeFailure(reason: unknown): string {
  return reason instanceof Error ? (reason.stack ?? `${reason.name}: ${reason.message}`) : String(reason);
}

/**
 * Writes a crash (an uncaught exception or unhandled rejection: what Node would print before dying) to `log`, then
 * exits with code 1 so the service manager restarts the service. Returns the function that removes the handlers.
 */
export function logCrashes(log: LogFile, exit: (code: number) => void): () => void {
  const crashed = (kind: string) => (reason: unknown): void => {
    log.write(`agent-canvas: ${kind}: ${describeFailure(reason)}\n`);
    exit(1);
  };
  const onException = crashed('uncaught exception');
  const onRejection = crashed('unhandled rejection');
  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);
  return () => {
    process.removeListener('uncaughtException', onException);
    process.removeListener('unhandledRejection', onRejection);
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

/**
 * The `--log-file` of a `start` command line (`argv` without node and the script; no command, or only options, is
 * `start` too, as main reads it), given as `--log-file <file>` or `--log-file=<file>`; null otherwise.
 */
export function startLogFile(argv: readonly string[]): string | null {
  const first = argv[0];
  const implied = first === undefined || (first.startsWith('--') && first !== '--version' && first !== '--help');
  const args = implied ? argv : first === 'start' ? argv.slice(1) : null;
  if (args === null) return null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--log-file') {
      const value = args[i + 1];
      return value !== undefined && value !== '' && !value.startsWith('-') ? value : null;
    }
    if (arg.startsWith('--log-file=')) return arg.slice('--log-file='.length) || null;
  }
  return null;
}

/** This process's output going to a log file: openLogFile, captureProcessOutput and logCrashes together. */
export interface ProcessLog {
  readonly file: string;
  readonly log: LogFile;
  /** Writes a failure before the commands could run (loading them) to the log, then exits 1. */
  fail(reason: unknown): void;
  /** Puts the output and the crash handlers back and closes the log; once. */
  stop(): void;
}

export function openProcessLog(file: string, exit: (code: number) => void): ProcessLog {
  const log = openLogFile(file);
  const restoreOutput = captureProcessOutput(log);
  // Node prints a crash straight to the terminal (not through process.stderr.write): put it in the log instead.
  const uninstallCrashLog = logCrashes(log, exit);
  let stopped = false;
  return {
    file,
    log,
    fail(reason) {
      log.write(`agent-canvas: load failed: ${describeFailure(reason)}\n`);
      exit(1);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      uninstallCrashLog();
      restoreOutput();
      log.close();
    },
  };
}

/** The log the entry (cli.ts) opened before loading the commands, until `start` takes it over. */
let early: ProcessLog | null = null;

/**
 * cli.ts, before it loads the commands: for a `start` with `--log-file`, opens that log now, so a failure to load them
 * (a native module built for another Node version, say) is written there too, not to a terminal the background service
 * does not have. Null for any other command line. `start` takes it over with takeProcessLog.
 */
export function openEarlyProcessLog(argv: readonly string[], exit: (code: number) => void): ProcessLog | null {
  const file = startLogFile(argv);
  if (file === null) return null;
  early?.stop();
  early = openProcessLog(file, exit);
  return early;
}

/** Closes the log the entry opened, if nobody took it over. */
export function closeEarlyProcessLog(): void {
  early?.stop();
  early = null;
}

/**
 * The log the entry opened, when it is `file`: it then belongs to the caller (once). One for another file is closed,
 * and null returned: the caller opens its own.
 */
export function takeProcessLog(file: string): ProcessLog | null {
  const taken = early;
  early = null;
  if (taken === null) return null;
  if (taken.file === file) return taken;
  taken.stop();
  return null;
}
