#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { AddressInfo } from 'node:net';
import { buildServer } from './api/server.js';
import { loadConfig, type Config } from './config.js';
import { confirmOnStreams, defaultSettingsFile, runHooksInstall, runHooksUninstall, type HooksCliIo } from './hooks-cli.js';
import { acquireLock } from './lock.js';
import { NORMALIZER_VERSION } from './normalize/version.js';
import { NORMALIZER_VERSION_KEY, Pipeline, REBUILD_FLAG } from './pipeline.js';
import { startWatcher } from './sources/transcript/watcher.js';
import { openStore, type Store } from './store/store.js';

export interface Running {
  url: string;
  /** The address the server is actually bound to. */
  address: { address: string; port: number };
  close(): Promise<void>;
}

const USAGE = `Usage:
  claude-canvas start [--port <n>]   Watch transcripts and serve the canvas
  claude-canvas rebuild              Re-derive the graph from the stored raw log
  claude-canvas hooks install [--port <n>] [--yes] [--settings <file>]
                                     Add the claude-canvas hooks to Claude Code's settings.json
  claude-canvas hooks uninstall [--port <n>] [--yes] [--settings <file>]
                                     Remove them again
`;

/** packages/web/dist next to this package (works from both src/ and dist/); null while it is not built. */
function defaultWebDist(): string | null {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? dir : null;
}

function resolveConfig(overrides: Partial<Config>): Config {
  const config = loadConfig(process.env, { webDist: defaultWebDist(), ...overrides });
  fs.mkdirSync(config.dataDir, { recursive: true });
  return config;
}

/**
 * Why the derived tables must be rebuilt before serving, or null. A brand-new empty database just records the
 * current normalizer version.
 */
export function rebuildReason(store: Store): string | null {
  if (store.getMeta(REBUILD_FLAG) !== null) return 'interrupted rebuild';
  const stored = store.getMeta(NORMALIZER_VERSION_KEY);
  if (stored === null) {
    if (store.hasRawEvents()) return 'no recorded normalizer version';
    store.setMeta(NORMALIZER_VERSION_KEY, String(NORMALIZER_VERSION));
    return null;
  }
  return stored === String(NORMALIZER_VERSION) ? null : `normalizer version ${stored} -> ${NORMALIZER_VERSION}`;
}

export interface StartOptions {
  /** Receives stdout lines (the rebuild notice). */
  log?: (line: string) => void;
  /** Rebuild progress, when a rebuild runs before listening. */
  progress?: (done: number, total: number) => void;
}

export async function start(overrides: Partial<Config> = {}, options: StartOptions = {}): Promise<Running> {
  const config = resolveConfig(overrides);
  const lock = acquireLock(config.dataDir);
  let store: Store | null = null;
  let app: ReturnType<typeof buildServer> | null = null;
  let watcher: ReturnType<typeof startWatcher> | null = null;
  let pipeline: Pipeline;
  try {
    store = openStore(config.dbPath, options.log ? { log: options.log } : {});
    pipeline = new Pipeline(store, config, { log: (line) => process.stderr.write(`${line}\n`) });
    const reason = rebuildReason(store);
    if (reason !== null) {
      options.log?.(`claude-canvas rebuilding derived data (reason: ${reason})`);
      pipeline.rebuild(options.progress);
    }
    app = buildServer({ store, pipeline, config });
    await app.listen({ port: config.port, host: config.host });
    // The initial scan runs in the background; the server is already answering requests.
    watcher = startWatcher(pipeline, config);
  } catch (err) {
    await app?.close().catch(() => undefined);
    store?.close();
    lock.release();
    throw err;
  }
  const bound = app.server.address() as AddressInfo;
  const url = `http://${config.host}:${bound.port}`;
  let closing: Promise<void> | null = null;
  const openedStore = store;
  const server = app;
  return {
    url,
    address: { address: bound.address, port: bound.port },
    close() {
      closing ??= (async () => {
        try {
          await watcher!.close();
          await server.close();
          await pipeline.idle();
          openedStore.close();
        } finally {
          lock.release();
        }
      })();
      return closing;
    },
  };
}

/** Re-derives all graph data from the raw log with a fresh store and pipeline (no watcher, nothing pending). */
export function rebuild(overrides: Partial<Config> = {}, options: { progress?: (done: number, total: number) => void } = {}): void {
  const config = resolveConfig(overrides);
  const lock = acquireLock(config.dataDir);
  try {
    const store = openStore(config.dbPath);
    try {
      new Pipeline(store, config).rebuild(options.progress);
    } finally {
      store.close();
    }
  } finally {
    lock.release();
  }
}

function terminalIo(): HooksCliIo {
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    confirm: (question) => confirmOnStreams(question, process.stdin, process.stdout),
    isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    now: () => new Date(),
  };
}

async function hooksCommand(args: string[], env: NodeJS.ProcessEnv, io: HooksCliIo): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== 'install' && sub !== 'uninstall') {
    io.err(USAGE.trimEnd());
    return 1;
  }
  try {
    const { values } = parseArgs({
      args: rest,
      options: { port: { type: 'string' }, yes: { type: 'boolean' }, settings: { type: 'string' } },
      allowPositionals: false,
    });
    if (values.port !== undefined && !/^[0-9]+$/.test(values.port)) throw new Error(`invalid --port: ${values.port}`);
    const port = values.port === undefined ? loadConfig(env).port : Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid --port: ${values.port}`);
    const opts = { settingsFile: values.settings ?? defaultSettingsFile(env), port, yes: values.yes === true };
    return await (sub === 'install' ? runHooksInstall(opts, io) : runHooksUninstall(opts, io));
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export interface MainDeps {
  /** IO for the hooks commands; tests inject a fake so no TTY is needed. */
  hooksIo?: HooksCliIo;
  env?: NodeJS.ProcessEnv;
}

export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'hooks') return hooksCommand(rest, deps.env ?? process.env, deps.hooksIo ?? terminalIo());
  try {
    if (command === 'start') {
      const { values } = parseArgs({ args: rest, options: { port: { type: 'string' } }, allowPositionals: false });
      const overrides: Partial<Config> = {};
      if (values.port !== undefined) {
        const port = Number(values.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid --port: ${values.port}`);
        overrides.port = port;
      }
      const app = await start(overrides, {
        log: (line) => console.log(line),
        progress: (done, total) => process.stderr.write(`rebuild: ${done}/${total} sessions\n`),
      });
      console.log(`claude-canvas listening on ${app.url}`);
      process.once('SIGINT', () => {
        void app.close().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      });
      return -1; // keep running
    }
    if (command === 'rebuild') {
      parseArgs({ args: rest, options: {}, allowPositionals: false });
      rebuild({}, { progress: (done, total) => process.stderr.write(`rebuild: ${done}/${total} sessions\n`) });
      console.log('claude-canvas rebuild complete');
      return 0;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  process.stderr.write(USAGE);
  return 1;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  void main(process.argv.slice(2)).then((code) => {
    if (code >= 0) process.exit(code);
  });
}
