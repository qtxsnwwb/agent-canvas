import http from 'node:http';

/*
 * `claude-canvas hook-forward --origin <claude|codex> --port <n>`: what a Codex command hook runs. Codex hooks cannot
 * send HTTP themselves; this reads the hook's JSON from stdin and POSTs it unchanged to the local server's
 * `/hooks?origin=<origin>`.
 *
 * Codex reads a hook's stdout, stderr and exit code, so this NEVER writes anything and ALWAYS exits 0: a server that is
 * not running, a slow server, garbage input or any error end the process quietly. It reads and writes no file, and it
 * imports node built-ins only (cli.js reaches it without loading the server), so it starts fast.
 */

export type ForwardOrigin = 'claude' | 'codex';

/** Connect + request + response, in total. */
export const FORWARD_TIMEOUT_MS = 1000;
/** Reading stdin (Codex writes the payload and closes it at once). */
export const STDIN_TIMEOUT_MS = 2000;
export const DEFAULT_FORWARD_PORT = 4317;

export interface ForwardArgs {
  origin: ForwardOrigin;
  port: number;
}

/** Lenient: an unknown or invalid value falls back to the default (the forwarder must never fail on its arguments). */
export function parseForwardArgs(args: readonly string[]): ForwardArgs {
  const out: ForwardArgs = { origin: 'codex', port: DEFAULT_FORWARD_PORT };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    let name: string;
    let value: string | undefined;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      name = arg.slice(0, eq);
      value = arg.slice(eq + 1);
    } else {
      name = arg;
      if (name === '--origin' || name === '--port') value = args[++i];
    }
    if (value === undefined) continue;
    if (name === '--origin') out.origin = value === 'claude' ? 'claude' : 'codex';
    if (name === '--port' && /^[0-9]{1,5}$/.test(value)) {
      const port = Number(value);
      if (port >= 1 && port <= 65535) out.port = port;
    }
  }
  return out;
}

/** All of `stream`; null when it does not end within `timeoutMs`. A stream error ends it with what was read. */
function readAll(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (value: Buffer | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      stream.on('data', (c: Buffer | string) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
      stream.on('end', () => finish(Buffer.concat(chunks)));
      stream.on('error', () => finish(Buffer.concat(chunks)));
      stream.on('close', () => finish(Buffer.concat(chunks)));
      stream.resume();
    } catch {
      finish(null);
    }
  });
}

/** POSTs `body`; resolves (never rejects) on the answer, a connection error, or after `timeoutMs`. */
function post(body: Buffer, args: ForwardArgs, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    try {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: args.port,
          method: 'POST',
          path: `/hooks?origin=${args.origin}`,
          agent: false,
          headers: { 'content-type': 'application/json', 'content-length': body.length },
        },
        (res) => {
          res.on('error', finish);
          res.on('end', finish);
          res.on('close', finish);
          res.resume(); // the answer is not used
        },
      );
      timer = setTimeout(() => {
        req.destroy();
        finish();
      }, timeoutMs);
      req.on('error', finish); // ECONNREFUSED arrives at once when nothing listens
      req.end(body);
    } catch {
      finish();
    }
  });
}

export interface ForwardDeps {
  stdin: NodeJS.ReadableStream;
  /** Overrides FORWARD_TIMEOUT_MS (tests). */
  timeoutMs?: number;
  /** Overrides STDIN_TIMEOUT_MS (tests). */
  stdinTimeoutMs?: number;
}

/** Reads stdin and forwards it; always resolves to 0. Empty input sends nothing. */
export async function runHookForward(args: readonly string[], deps: ForwardDeps): Promise<0> {
  try {
    const parsed = parseForwardArgs(args);
    const body = await readAll(deps.stdin, deps.stdinTimeoutMs ?? STDIN_TIMEOUT_MS);
    if (body !== null && body.length > 0) await post(body, parsed, deps.timeoutMs ?? FORWARD_TIMEOUT_MS);
  } catch {
    // nothing may reach the hook's output
  }
  return 0;
}

/**
 * The whole `hook-forward` process: forwards process.stdin, then exits 0 whatever happened. A last-resort timer makes
 * sure the process ends even if something keeps the event loop alive.
 */
export function hookForwardProcess(args: readonly string[]): void {
  const quit = (): never => process.exit(0);
  process.on('uncaughtException', quit);
  process.on('unhandledRejection', quit);
  setTimeout(quit, STDIN_TIMEOUT_MS + FORWARD_TIMEOUT_MS + 500).unref();
  void runHookForward(args, { stdin: process.stdin }).then(quit, quit);
}
