#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { AddressInfo } from 'node:net';
import { buildServer } from './api/server.js';
import { loadConfig, type Config } from './config.js';
import { Pipeline } from './pipeline.js';
import { startWatcher } from './sources/transcript/watcher.js';
import { openStore } from './store/store.js';

export interface Running {
  url: string;
  close(): Promise<void>;
}

const USAGE = `Usage:
  claude-canvas start [--port <n>]   Watch transcripts and serve the canvas
  claude-canvas rebuild              Re-derive the graph from the stored raw log
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

export async function start(overrides: Partial<Config> = {}): Promise<Running> {
  const config = resolveConfig(overrides);
  const store = openStore(config.dbPath);
  const pipeline = new Pipeline(store, config);
  const app = buildServer({ store, pipeline, config });
  let watcher: ReturnType<typeof startWatcher> | null = null;
  try {
    await app.listen({ port: config.port, host: config.host });
    // The initial scan runs in the background; the server is already answering requests.
    watcher = startWatcher(pipeline, config);
  } catch (err) {
    await app.close().catch(() => undefined);
    store.close();
    throw err;
  }
  const url = `http://${config.host}:${(app.server.address() as AddressInfo).port}`;
  let closing: Promise<void> | null = null;
  return {
    url,
    close() {
      closing ??= (async () => {
        await watcher!.close();
        await app.close();
        await pipeline.idle();
        store.close();
      })();
      return closing;
    },
  };
}

/** Re-derives all graph data from the raw log with a fresh store and pipeline (no watcher, nothing pending). */
export function rebuild(overrides: Partial<Config> = {}): void {
  const config = resolveConfig(overrides);
  const store = openStore(config.dbPath);
  try {
    new Pipeline(store, config).rebuild();
  } finally {
    store.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === 'start') {
      const { values } = parseArgs({ args: rest, options: { port: { type: 'string' } }, allowPositionals: false });
      const overrides: Partial<Config> = {};
      if (values.port !== undefined) {
        const port = Number(values.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid --port: ${values.port}`);
        overrides.port = port;
      }
      const app = await start(overrides);
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
      rebuild();
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
