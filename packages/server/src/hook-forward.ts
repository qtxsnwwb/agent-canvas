import http from 'node:http';

/*
 * `agent-canvas hook-forward --origin <claude|codex|cursor> --port <n>`: what a Codex or Cursor command hook runs.
 * Their hooks cannot send HTTP themselves; this reads the hook's JSON from stdin and POSTs it unchanged to the local
 * server's `/hooks?origin=<origin>`.
 *
 * Codex and Cursor read a hook's stdout, stderr and exit code, so this ALWAYS exits 0 and writes nothing to stderr: a
 * server that is not running, a slow server, garbage input or any error end the process quietly. Its only output is
 * Cursor's explicit permission for a prompt: with `--origin cursor`, when the stdin payload parses and its
 * hook_event_name is `beforeSubmitPrompt`, exactly `{"continue":true}` on stdout (written before the POST, so also when
 * the server is down or slow); for every other event or input, nothing. When stdin is not closed within its time limit,
 * what was read by then counts: a payload that parses is answered and forwarded; a cut one is answered only when it
 * names beforeSubmitPrompt (and is not forwarded); nothing read, nothing printed. The whole run stays within
 * STDIN_TIMEOUT_MS + FORWARD_TIMEOUT_MS (plus a last-resort margin), under the hooks' 5 s timeout. It reads and writes no
 * file, and it imports node built-ins only (cli.js reaches it without loading the server), so it starts fast.
 *
 * What it cannot control: when node or cli.js is gone (moved, upgraded, deleted), the hook command fails before any of
 * this runs (an error on stderr, nothing on stdout, a non-zero exit). How Cursor treats that is to be checked at
 * acceptance; the documented remedy is `hooks uninstall --cursor` before moving or deleting agent-canvas.
 */

export type ForwardOrigin = 'claude' | 'codex' | 'cursor';

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
    if (name === '--origin') out.origin = value === 'claude' || value === 'cursor' ? value : 'codex';
    if (name === '--port' && /^[0-9]{1,5}$/.test(value)) {
      const port = Number(value);
      if (port >= 1 && port <= 65535) out.port = port;
    }
  }
  return out;
}

/**
 * All of `stream`, or what it gave within `timeoutMs` when it did not end by then (`complete` false). A stream error ends
 * it with what was read.
 */
function readAll(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<{ body: Buffer; complete: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (complete: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        stream.pause();
      } catch {
        // nothing more is read either way
      }
      resolve({ body: Buffer.concat(chunks), complete });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      stream.on('data', (c: Buffer | string) => {
        if (!done) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
      });
      stream.on('end', () => finish(true));
      stream.on('error', () => finish(true));
      stream.on('close', () => finish(true));
      stream.resume();
    } catch {
      finish(true);
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

/** What Cursor's beforeSubmitPrompt hook answers: let the prompt through. */
export const CURSOR_CONTINUE = '{"continue":true}';

/** A payload's text without a leading BOM. */
function payloadText(body: Buffer): string {
  const text = body.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** True when the payload is a JSON object. */
function parsesAsObject(body: Buffer): boolean {
  try {
    const parsed = JSON.parse(payloadText(body)) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/** A top-level-looking `"hook_event_name": "beforeSubmitPrompt"` in a payload that was cut off (stdin never closed). */
const CUT_PROMPT_EVENT = /^\s*\{[^]*?"hook_event_name"\s*:\s*"beforeSubmitPrompt"/;

/**
 * The answer the hook must print for this payload, or null for none (only Cursor's beforeSubmitPrompt has one).
 * `complete` false: the payload may be cut (stdin was not closed in time); if it does not parse, its event name is
 * still recognised in what was read.
 */
export function hookAnswer(origin: ForwardOrigin, body: Buffer, complete = true): string | null {
  if (origin !== 'cursor') return null;
  try {
    const parsed = JSON.parse(payloadText(body)) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return (parsed as Record<string, unknown>).hook_event_name === 'beforeSubmitPrompt' ? CURSOR_CONTINUE : null;
  } catch {
    if (complete) return null;
    try {
      return CUT_PROMPT_EVENT.test(payloadText(body)) ? CURSOR_CONTINUE : null;
    } catch {
      return null;
    }
  }
}

/** The subset of a writable stream the forwarder uses for its answer. */
export interface AnswerStream {
  write(chunk: string, cb?: (err?: Error | null) => void): boolean;
}

/** Writes `text`; resolves (never rejects) once it is flushed, on an error, or after `timeoutMs`. */
function writeAnswer(stream: AnswerStream, text: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    try {
      stream.write(text, done);
    } catch {
      done();
    }
  });
}

export interface ForwardDeps {
  stdin: NodeJS.ReadableStream;
  /** Where the hook's answer goes (default process.stdout). */
  stdout?: AnswerStream;
  /** Overrides FORWARD_TIMEOUT_MS (tests). */
  timeoutMs?: number;
  /** Overrides STDIN_TIMEOUT_MS (tests). */
  stdinTimeoutMs?: number;
}

/**
 * Reads stdin and forwards it; always resolves to 0. Empty input sends nothing. Stdin not closed in time: what was read
 * is used (see the top of this file); a cut payload that does not parse is not sent.
 */
export async function runHookForward(args: readonly string[], deps: ForwardDeps): Promise<0> {
  try {
    const parsed = parseForwardArgs(args);
    const { body, complete } = await readAll(deps.stdin, deps.stdinTimeoutMs ?? STDIN_TIMEOUT_MS);
    if (body.length === 0) return 0;
    const timeoutMs = deps.timeoutMs ?? FORWARD_TIMEOUT_MS;
    const answer = hookAnswer(parsed.origin, body, complete);
    // The answer goes out first (Cursor must get it even when the POST fails or times out); both finish before exit.
    const written = answer === null ? Promise.resolve() : writeAnswer(deps.stdout ?? process.stdout, answer, timeoutMs);
    const sent = complete || parsesAsObject(body) ? post(body, parsed, timeoutMs) : Promise.resolve();
    await Promise.all([written, sent]);
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
