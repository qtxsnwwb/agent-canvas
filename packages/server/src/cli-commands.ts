import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { AddressInfo } from 'node:net';
import { buildServer } from './api/server.js';
import { loadConfig, type Config } from './config.js';
import { runHookForward } from './hook-forward.js';
import {
  confirmOnStreams,
  defaultCodexHooksFile,
  defaultCursorHooksFile,
  defaultSettingsFile,
  runCodexHooksInstall,
  runCodexHooksUninstall,
  runCursorHooksInstall,
  runCursorHooksUninstall,
  runHooksInstall,
  runHooksUninstall,
  type HooksCliIo,
} from './hooks-cli.js';
import { acquireLock } from './lock.js';
import { NORMALIZER_VERSION } from './normalize/version.js';
import { DesktopNotifier } from './notify/desktop.js';
import { NotificationService, type ServiceNotifier } from './notify/service.js';
import { NORMALIZER_VERSION_KEY, Pipeline, REBUILD_FLAG } from './pipeline.js';
import { ClaudeFileSource } from './sources/claude.js';
import { storeLookup } from './sources/codex/lookup.js';
import { CodexFileSource } from './sources/codex/source.js';
import { CursorSource } from './sources/cursor/source.js';
import type { PollSource } from './sources/poll.js';
import type { FileSource } from './sources/source.js';
import { startWatcher } from './sources/transcript/watcher.js';
import { FilesService } from './files/service.js';
import { StatsService, storeStatsSource } from './stats/service.js';
import { startStatsWarmup, type StatsWarmup } from './stats/warmup.js';
import {
  migrateAll,
  startStorageMaintenance,
  STORAGE_META,
  vacuumIfDue,
  type StorageMaintenance,
  type StorageMaintenanceOptions,
  type VacuumResult,
} from './store/migrate-storage.js';
import { openStore, type Store } from './store/store.js';

export interface Running {
  url: string;
  /** The address the server is actually bound to. */
  address: { address: string; port: number };
  /**
   * The stats warm-up (see stats/warmup.ts; it builds the stats summaries, then the file summaries): resolves once it
   * has run, or was stopped by close(); never rejects. null when it is off.
   */
  statsWarmup: Promise<void> | null;
  close(): Promise<void>;
}

const USAGE = `Usage:
  agent-canvas [--port <n>]         Same as start
  agent-canvas start [--port <n>]   Watch transcripts and serve the canvas
  agent-canvas --version            Print the version
  agent-canvas rebuild              Re-derive the graph from the stored raw log
  agent-canvas compact [--force]    Compress the stored records still uncompressed and reclaim free space (VACUUM);
                                     the service must not be running. --force: skip the free-disk-space check
  agent-canvas hooks install [--port <n>] [--yes] [--settings <file>]
                                     Add the agent-canvas hooks to Claude Code's settings.json
  agent-canvas hooks uninstall [--port <n>] [--yes] [--settings <file>]
                                     Remove them again
  agent-canvas hooks install --codex [--port <n>] [--yes] [--settings <file>]
                                     Add the forwarding hooks to Codex's ~/.codex/hooks.json
  agent-canvas hooks uninstall --codex [--port <n>] [--yes] [--settings <file>]
                                     Remove them again
  agent-canvas hooks install --cursor [--port <n>] [--yes] [--settings <file>]
                                     Add the forwarding hooks to Cursor's ~/.cursor/hooks.json
  agent-canvas hooks uninstall --cursor [--port <n>] [--yes] [--settings <file>]
                                     Remove them again
  agent-canvas hook-forward [--origin <claude|codex|cursor>] [--port <n>]
                                     Forward one hook payload from stdin to the server (run by Codex / Cursor)
`;

/** This installation's cli.js (next to this module in dist/), as written into Codex's hook commands. */
export function defaultCliPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where the built web app may be, given the directory this module runs from: `web/` next to `dist/` in the published
 * package, then `packages/web/dist` in the repository (from both src/ and dist/).
 */
export function webDistCandidates(here: string = HERE): string[] {
  return [path.resolve(here, '..', 'web'), path.resolve(here, '..', '..', 'web', 'dist')];
}

/** The first candidate that holds a built page; null while the web app is not built. */
function defaultWebDist(): string | null {
  for (const dir of webDistCandidates()) {
    try {
      if (fs.statSync(path.join(dir, 'index.html')).isFile()) return dir;
    } catch {
      // not there: try the next one
    }
  }
  return null;
}

/** Version of the package this module belongs to (the package.json one level above dist/ or src/); 'unknown' when unreadable. */
export function packageVersion(here: string = HERE): string {
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(path.resolve(here, '..', 'package.json'), 'utf8'));
    const version = (pkg as { version?: unknown } | null)?.version;
    return typeof version === 'string' && version !== '' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * True when the path lies in npx's download cache (`…/_npx/<hash>/node_modules/…`): such an installation can vanish or
 * move at any time, so its path must not be written into another tool's configuration.
 */
export function isNpxPath(p: string): boolean {
  return /[\\/]_npx[\\/][^\\/]+[\\/]node_modules[\\/]/.test(p);
}

export const PACKAGE_NAME = '@qtxsnwwb/agent-canvas';

/**
 * The session-file directories read for this configuration: Claude Code's projects directory, and Codex's sessions
 * directory when `codexSessionsDir` names an existing directory (otherwise Codex is skipped silently). `store` lets the
 * Codex source place files from their stored raw events (files that are gone, restarts) without reading them.
 */
export function fileSources(config: Config, store?: Store): FileSource[] {
  const sources: FileSource[] = [new ClaudeFileSource(config.projectsDir)];
  const codexDir = config.codexSessionsDir;
  let isDir = false;
  try {
    isDir = codexDir !== null && codexDir !== '' && fs.statSync(codexDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (isDir) sources.push(new CodexFileSource(codexDir!, store ? storeLookup(store, config.projectsDir) : undefined));
  return sources;
}

/**
 * The polled sources of this configuration (used by `start` only; rebuild never reads Cursor's database): Cursor's
 * state database when `cursorDbPath` is set (a missing file is "Cursor not installed": polled, nothing read, no error).
 */
export function pollSources(config: Config, store?: Store): PollSource[] {
  if (config.cursorDbPath === null || config.cursorDbPath === '') return [];
  const lookup = store ? storeLookup(store, config.projectsDir) : null;
  return [new CursorSource({ dbPath: config.cursorDbPath, ...(lookup ? { knownProjectIds: () => lookup.knownProjectIds() } : {}) })];
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
  /** Delivery of desktop notifications (tests); default: the system's own (DesktopNotifier). */
  notifier?: ServiceNotifier;
  /**
   * Build the stats and file summaries in the background once start-up is done. Default: on, unless the environment sets
   * AGENT_CANVAS_STATS_WARMUP=0 (the test configuration does).
   */
  statsWarmup?: boolean;
  /**
   * The storage job (migrate-storage.ts: compress records stored before compression, then VACUUM), run in the
   * background once start-up is done when the database still needs it; options for tests, false: never.
   */
  storage?: StorageMaintenanceOptions | false;
}

/** True while the database still needs the storage job (its migration or its VACUUM is not done). */
function storageWorkDue(store: Store): boolean {
  return store.getMeta(STORAGE_META.migration) !== 'done' || store.getMeta(STORAGE_META.vacuum) !== 'done';
}

export async function start(overrides: Partial<Config> = {}, options: StartOptions = {}): Promise<Running> {
  const config = resolveConfig(overrides);
  const lock = acquireLock(config.dataDir);
  let store: Store | null = null;
  let app: ReturnType<typeof buildServer> | null = null;
  let watcher: ReturnType<typeof startWatcher> | null = null;
  let notifications: NotificationService | null = null;
  let stats: StatsService | null = null;
  let files: FilesService | null = null;
  let warmup: StatsWarmup | null = null;
  let storage: StorageMaintenance | null = null;
  let pipeline: Pipeline;
  try {
    store = openStore(config.dbPath, options.log ? { log: options.log } : {});
    pipeline = new Pipeline(store, config, {
      log: (line) => process.stderr.write(`${line}\n`),
      sources: fileSources(config, store),
      pollSources: pollSources(config, store),
    });
    const reason = rebuildReason(store);
    if (reason !== null) {
      options.log?.(`agent-canvas rebuilding derived data (reason: ${reason})`);
      pipeline.rebuild(options.progress);
    }
    notifications = new NotificationService({
      store,
      pipeline,
      notifier: options.notifier ?? new DesktopNotifier(),
      log: (line) => process.stderr.write(`${line}\n`),
    });
    stats = new StatsService(storeStatsSource(store));
    files = new FilesService(storeStatsSource(store));
    // After the (automatic) rebuild above; the job itself waits for the initial scan and the first poll rounds.
    if (options.storage !== false && storageWorkDue(store)) {
      storage = startStorageMaintenance(store, pipeline, { log: (line) => process.stderr.write(`${line}\n`), ...options.storage });
    }
    const storageJob = storage;
    app = buildServer({ store, pipeline, config, notifications, stats, files, ...(storageJob !== null ? { storage: storageJob } : {}) });
    await app.listen({ port: config.port, host: config.host });
    // After the (automatic) rebuild above, before the initial scan: its changes arrive while importing() holds.
    notifications.start(`http://${config.host}:${(app.server.address() as AddressInfo).port}`);
    // The initial scan runs in the background; the server is already answering requests.
    watcher = startWatcher(pipeline, config);
    if (options.statsWarmup ?? process.env.AGENT_CANVAS_STATS_WARMUP !== '0') {
      const statsNow = stats;
      const filesNow = files;
      const pipelineNow = pipeline;
      // One after the other: the file summaries are built once the stats ones are (each warm() never rejects).
      warmup = startStatsWarmup({
        warm: async () => {
          await statsNow.warm();
          await filesNow.warm();
        },
        settled: () => pipelineNow.startupDone(),
      });
    }
  } catch (err) {
    stats?.close();
    files?.close();
    await warmup?.stop();
    await storage?.stop();
    await notifications?.close().catch(() => undefined);
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
  const service = notifications!;
  const statsService = stats!;
  const filesService = files!;
  const statsWarmup = warmup;
  const storageJob = storage;
  return {
    url,
    address: { address: bound.address, port: bound.port },
    statsWarmup: statsWarmup?.done ?? null,
    close() {
      closing ??= (async () => {
        try {
          // The warm-up first: it stops waiting, and a summary build in progress stops at its next page.
          await statsWarmup?.stop();
          // The storage job stops before its next batch (a VACUUM in progress ends first, releasing held writes).
          await storageJob?.stop();
          statsService.close();
          filesService.close();
          await statsWarmup?.done;
          // Unsubscribes and stops the timer at once; deliveries in flight end within their timeout meanwhile.
          const notificationsClosed = service.close();
          await watcher!.close();
          await pipeline.close();
          await server.close();
          await pipeline.idle();
          await notificationsClosed;
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
      new Pipeline(store, config, { sources: fileSources(config, store) }).rebuild(options.progress);
    } finally {
      store.close();
    }
  } finally {
    lock.release();
  }
}

export interface CompactOptions {
  /** Skip the free-disk-space check before VACUUM. */
  force?: boolean;
  /** Migration progress (positions done, total), after each batch. */
  progress?: (migrated: number, total: number) => void;
  /** Free bytes of a directory's volume (tests); default fs.statfsSync. */
  freeBytes?: (dir: string) => number;
}

export interface CompactResult {
  converted: number;
  failed: number;
  vacuum: VacuumResult;
  before: { fileBytes: number; walBytes: number };
  after: { fileBytes: number; walBytes: number };
}

/**
 * `agent-canvas compact`: with the lock of start / rebuild (refused while the service runs), the remaining storage
 * migration synchronously, then VACUUM on this connection (even when one was done before; skipped when the volume has
 * less than 1.2 times the database's size free, unless `force`).
 */
export async function compact(overrides: Partial<Config> = {}, options: CompactOptions = {}): Promise<CompactResult> {
  const config = resolveConfig(overrides);
  const lock = acquireLock(config.dataDir);
  try {
    const store = openStore(config.dbPath);
    try {
      const before = store.dbFileSizes();
      const { converted, failed } = migrateAll(store, options.progress !== undefined ? { progress: options.progress } : {});
      const vacuum = await vacuumIfDue(store, {
        evenIfDone: true,
        ...(options.force === true ? { skipSpaceCheck: true } : {}),
        ...(options.freeBytes !== undefined ? { freeBytes: options.freeBytes } : {}),
      });
      return { converted, failed, vacuum, before, after: store.dbFileSizes() };
    } finally {
      store.close();
    }
  } finally {
    lock.release();
  }
}

const megabytes = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`;

function terminalIo(): HooksCliIo {
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    confirm: (question) => confirmOnStreams(question, process.stdin, process.stdout),
    isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    now: () => new Date(),
  };
}

async function hooksCommand(args: string[], env: NodeJS.ProcessEnv, io: HooksCliIo, cliPath: string): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== 'install' && sub !== 'uninstall') {
    io.err(USAGE.trimEnd());
    return 1;
  }
  try {
    const { values } = parseArgs({
      args: rest,
      options: { port: { type: 'string' }, yes: { type: 'boolean' }, settings: { type: 'string' }, codex: { type: 'boolean' }, cursor: { type: 'boolean' } },
      allowPositionals: false,
    });
    if (values.port !== undefined && !/^[0-9]+$/.test(values.port)) throw new Error(`invalid --port: ${values.port}`);
    const port = values.port === undefined ? loadConfig(env).port : Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid --port: ${values.port}`);
    if (values.codex === true && values.cursor === true) throw new Error('--codex and --cursor cannot be used together');
    if (sub === 'install' && (values.codex === true || values.cursor === true) && isNpxPath(cliPath)) {
      // Codex and Cursor run a command line that names this cli.js; npx's cache is not a stable place for it.
      throw new Error(
        `${values.codex === true ? 'Codex' : 'Cursor'} 的 hooks 里要写入本程序的绝对路径，而现在是用 npx 临时运行的（${cliPath}），这个路径随时可能失效。\n`
        + `请先全局安装：npm install -g ${PACKAGE_NAME}\n然后运行：agent-canvas hooks install ${values.codex === true ? '--codex' : '--cursor'}`,
      );
    }
    if (values.cursor === true) {
      const opts = { settingsFile: values.settings ?? defaultCursorHooksFile(env), port, yes: values.yes === true, nodePath: process.execPath, cliPath };
      return await (sub === 'install' ? runCursorHooksInstall(opts, io) : runCursorHooksUninstall(opts, io));
    }
    if (values.codex === true) {
      const opts = { settingsFile: values.settings ?? defaultCodexHooksFile(env), port, yes: values.yes === true, nodePath: process.execPath, cliPath };
      return await (sub === 'install' ? runCodexHooksInstall(opts, io) : runCodexHooksUninstall(opts, io));
    }
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
  /** stdin of `hook-forward` (default process.stdin). */
  stdin?: NodeJS.ReadableStream;
  /** cli.js written into Codex's / Cursor's hook commands (default: this installation's). */
  cliPath?: string;
}

export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  // No command (or only options) means `start`: `npx @qtxsnwwb/agent-canvas` just runs the service.
  const [command, ...rest] = argv.length === 0 || (argv[0]!.startsWith('--') && argv[0] !== '--version' && argv[0] !== '--help') ? ['start', ...argv] : argv;
  if (command === '--version' || command === '-v') {
    console.log(packageVersion());
    return 0;
  }
  if (command === '--help' || command === '-h') {
    console.log(USAGE.trimEnd());
    return 0;
  }
  if (command === 'hook-forward') return runHookForward(rest, { stdin: deps.stdin ?? process.stdin });
  if (command === 'hooks') return hooksCommand(rest, deps.env ?? process.env, deps.hooksIo ?? terminalIo(), deps.cliPath ?? defaultCliPath());
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
      console.log(`agent-canvas listening on ${app.url}`);
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
      console.log('agent-canvas rebuild complete');
      return 0;
    }
    if (command === 'compact') {
      const { values } = parseArgs({ args: rest, options: { force: { type: 'boolean' } }, allowPositionals: false });
      const r = await compact({}, { force: values.force === true, progress: (done, total) => process.stderr.write(`compact: ${done}/${total}\n`) });
      const size = (s: { fileBytes: number; walBytes: number }): string => megabytes(s.fileBytes + s.walBytes);
      if (r.failed > 0) console.log(`agent-canvas compact: ${r.failed} stored rows could not be compressed (kept as they were)`);
      if (r.vacuum.outcome === 'skipped') console.log(`agent-canvas compact: VACUUM skipped: ${r.vacuum.reason ?? ''}`);
      console.log(`agent-canvas compact: database file: ${size(r.before)} -> ${size(r.after)}`);
      return 0;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  process.stderr.write(USAGE);
  return 1;
}
