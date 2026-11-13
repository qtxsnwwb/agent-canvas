import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { STALE_AFTER_MS, type Change, type Origin, type SeqChange } from '@agent-canvas/shared';
import type { Config } from './config.js';
import { NORMALIZER_FACTORIES, NormalizerRegistry, type NormalizerFactories } from './normalize/registry.js';
import type { BatchItem } from './normalize/types.js';
import { NORMALIZER_VERSION } from './normalize/version.js';
import { ClaudeFileSource } from './sources/claude.js';
import { encodeProjectId } from './sources/codex/source.js';
import { fileUriToPath, normaliseCwd } from './sources/cursor/project.js';
import type { PollBatch, PollSink, PollSource, PollStatus } from './sources/poll.js';
import { ProjectIdResolver } from './sources/project-ids.js';
import { isPromise, KEY_PREFIXES, originOfKey, type FileClass, type FileSource, type MaybePromise } from './sources/source.js';
import { readNewLines } from './sources/transcript/reader.js';
import type { RawEvent, Store, StoredRawEvent } from './store/store.js';

/** Per-read byte budget; keeps each synchronous slice of work short so the event loop stays responsive. */
const READ_BUDGET_BYTES = 64 * 1024;
/** Time budget of one synchronous hydration slice. */
const HYDRATE_SLICE_MS = 8;
/** A hydration/rebuild page stops at this many rows or this much raw text, whichever comes first (at least one row). */
const HYDRATE_PAGE_ROWS = 200;
const HYDRATE_PAGE_BYTES = 256 * 1024;
const LIVE_STATUSES: ReadonlySet<string> = new Set(['running', 'awaiting_permission', 'awaiting_input']);
const UNKNOWN_PROJECT = 'unknown';
const REBUILD_PROGRESS_EVERY = 100;

/**
 * A Cursor hook's workspace root as a local directory spelled as the Cursor source spells a working directory: a
 * `file://` URI becomes a path, `/d:/x` becomes `d:\x`, then normaliseCwd (drive letter upper-cased, trailing separator
 * removed). Null for a URI that names no local path.
 */
function cursorRootPath(root: string): string | null {
  let p: string | null = root;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(root)) p = fileUriToPath(root);
  else if (/^\/[A-Za-z]:([\\/]|$)/.test(root)) p = root.slice(1).replace(/\//g, '\\');
  return p === null || p === '' ? null : normaliseCwd(p);
}
/** At most one failure log line per file (or hook session) per minute. */
const LOG_EVERY_MS = 60_000;

export interface PipelineOptions {
  /** Receives failure lines (stderr in the CLI). No conversation content is ever passed. */
  log?: (line: string) => void;
  /** The directories of session files to read; default: Claude Code's projectsDir only (defaultSources). */
  sources?: readonly FileSource[];
  /**
   * Sources whose data is polled (Cursor's database), at most one per origin: started after the initial scan, stopped
   * by close(), poked when a hook of their origin arrives. Default: none.
   */
  pollSources?: readonly PollSource[];
  /** The normalizer of each origin (tests); default NORMALIZER_FACTORIES. */
  normalizers?: NormalizerFactories;
}

/** The sources a pipeline reads when none are given: Claude Code's projects directory. */
export function defaultSources(config: Config): FileSource[] {
  return [new ClaudeFileSource(config.projectsDir)];
}
/** meta keys */
export const REBUILD_FLAG = 'rebuild_in_progress';
export const NORMALIZER_VERSION_KEY = 'normalizer_version';
/**
 * Hooks arriving while writes are held (the storage job's VACUUM) are appended to this file in the data directory, one
 * JSON raw event per line, instead of being kept in memory only, so a process killed meanwhile loses none: the file is
 * drained into the database when the writes are released, and by the next Pipeline (start) if it is still there.
 */
export const HELD_HOOKS_FILE = 'held-hooks.jsonl';
/** meta key: sha1 of the held-hooks file content last drained (a file drained but not deleted is not drained twice). */
export const HELD_HOOKS_DRAINED = 'held_hooks_drained';
/** meta key prefix of a poll source's notes about its units (PollSink.saveUnitState): `poll:` + the store key. */
export const POLL_STATE_PREFIX = 'poll:';

type Listener = (changes: SeqChange[]) => void;
type ResyncListener = (sessionId: string) => void;
/** Failure key of a session whose re-derive failed (shown as is in ingestFailures). */
const sessionKey = (sessionId: string): string => `session:${sessionId}`;
/**
 * Failure key of stored raw records that cannot be decoded (damaged bytes): one per store key, `raw:<key>`, or per
 * session for hook records, `raw:hook:<sessionId>`. Replay skips such a record.
 */
const corruptKey = (ev: StoredRawEvent): string => `raw:${ev.source === 'hook' ? `hook:${ev.sessionId}` : ev.file}`;
/** Failure keys that are not file paths. */
const isNonFileKey = (key: string): boolean => key.startsWith('hook') || key.startsWith('session:') || key.startsWith('raw:');
interface FileLock {
  running: Promise<void> | null;
  queued: Promise<void> | null;
}

const yieldToEventLoop = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/** A poll batch that found the pipeline closed after waiting its turn: rejected, not reported (PollSink contract). */
class PipelineClosed extends Error {
  constructor() {
    super('pipeline closed');
  }
}

function topLevelType(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const t = (parsed as { type?: unknown }).type;
      if (typeof t === 'string' && t !== '') return t;
    }
    return 'unknown';
  } catch {
    return 'invalid-json';
  }
}

export class Pipeline {
  /** One normalizer per origin; replaced wholesale by a rebuild (hydration checks identity to notice). */
  private normalizer: NormalizerRegistry;
  private readonly factories: NormalizerFactories;
  private readonly sources: readonly FileSource[];
  private readonly polls: readonly PollSource[];
  private pollsStarted = false;
  private closed = false;
  /** The first close()'s result, returned by every later call. */
  private closing: Promise<void> | null = null;
  /** ingestRecords calls in flight (importing()). */
  private pollIngests = 0;
  /** Tail of the poll batches' turns at store.settleWal (keeps their call order). */
  private walGate: Promise<void> = Promise.resolve();
  /** Poll store key -> offset of its next transcript raw event (seeded from the store on first use). */
  private readonly pollOffsets = new Map<string, number>();
  private readonly listeners = new Set<Listener>();
  private readonly resyncListeners = new Set<ResyncListener>();
  /**
   * Sessions whose committed raw events are ahead of their derived rows (mirror of the store's dirty_session, loaded
   * once): re-derived from their raw events on the next touch. Empty on the normal path.
   */
  private readonly dirty: Set<string>;
  private readonly locks = new Map<string, FileLock>();
  /** sessionId -> tail of that session's work chain; events for one session are applied strictly in order. */
  private readonly tails = new Map<string, Promise<void>>();
  /** Every unfinished ingest/hydration promise, for idle(). */
  private readonly active = new Set<Promise<unknown>>();
  /** sessionId -> last time it was touched while held in the Normalizer. */
  private readonly lastTouch = new Map<string, number>();
  /** Session ids whose main source file is gone; sourceDeleted stays true for them. */
  private readonly deleted = new Set<string>();
  /** Absolute file path or `hook:<sessionId>` -> last failure. */
  private readonly failures = new Map<string, { error: string; at: string }>();
  /** Failure key -> time (ms) of the last log line written for it (rate limit). */
  private readonly lastLogged = new Map<string, number>();
  private initialScanDone = false;
  private importDepth = 0;
  private readonly log: (line: string) => void;
  /** sessionId -> absolute paths of its files seen so far (the hot-set rescan stats only these). */
  private readonly filesBySession = new Map<string, Set<string>>();
  /** Known file sizes (mirror of file_offset.size) and last hook time, loaded from the store once. */
  private sizes: Map<string, number> | null = null;
  private lastHook: string | null = null;
  /** Hook events already inserted into raw_event (so a failed task does not insert them twice). */
  private readonly persistedHooks = new WeakSet<object>();
  /** Project ids of Cursor hooks for sessions the store does not know (the stored sessions' ids, case-insensitively reused). */
  private readonly cursorProjects = new ProjectIdResolver(() => this.store.sessionProjectIds());
  private flagsChecked = false;
  /** Absolute paths whose last classification threw (reported); cleared, with the failure, once one succeeds. */
  private readonly classifyFailed = new Set<string>();
  /** Index file (absolute path) -> its source's indexVersion when it was last read. */
  private readonly indexVersions = new Map<string, number>();
  /** Set while writes are held (holdWrites): resolves when they are released. */
  private writeHold: Promise<void> | null = null;

  constructor(
    private readonly store: Store,
    private readonly config: Config,
    options: PipelineOptions = {},
  ) {
    this.log = options.log ?? (() => {});
    this.sources = options.sources ?? defaultSources(config);
    this.polls = options.pollSources ?? [];
    this.factories = options.normalizers ?? NORMALIZER_FACTORIES;
    this.normalizer = this.newNormalizer();
    this.dirty = new Set(store.dirtySessionIds());
    // Hooks held during a VACUUM that the previous process did not live to store.
    try {
      this.drainHeldHooks();
    } catch (err) {
      this.reportFailure('hook', err);
    }
  }

  /** The file sources this pipeline reads (the watcher watches each). */
  fileSources(): readonly FileSource[] {
    return this.sources;
  }

  /** The poll sources this pipeline drives. */
  pollSources(): readonly PollSource[] {
    return this.polls;
  }

  /** Status of the poll source of `origin`, or null when there is none; a throwing status() becomes its lastError. */
  pollStatus(origin: Origin): PollStatus | null {
    const source = this.pollSourceFor(origin);
    if (source === null) return null;
    try {
      const { lastPollAt, lastError } = source.status();
      return { lastPollAt, lastError };
    } catch (err) {
      return { lastPollAt: null, lastError: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * True while the initial full scan or a rebuild is running, or while a poll source's records are being ingested before
   * its first completed round (the first import; later rounds would make it flicker every few seconds).
   */
  importing(): boolean {
    return this.importDepth > 0 || (this.pollIngests > 0 && this.polls.some((p) => this.pollStatus(p.origin)?.lastPollAt === null));
  }

  /**
   * The start-up work is over: the initial scan has run, no scan or rebuild is in progress (importing()), and every poll
   * source has completed (or failed) its first round. Unlike importing(), it does not flicker false between a poll
   * source's first batches. The stats warm-up waits for it.
   */
  startupDone(): boolean {
    if (!this.initialScanDone || this.importing()) return false;
    return this.polls.every((p) => {
      const status = this.pollStatus(p.origin);
      return status === null || status.lastPollAt !== null || status.lastError !== null;
    });
  }

  /**
   * Holds every write of the pipeline until the returned function is called (once; later calls do nothing): work
   * arriving meanwhile (file slices, hooks, poll batches, scan bookkeeping) waits, in its usual order, and is applied
   * after the release; nothing is dropped. For the storage job's VACUUM, which runs on another connection and takes
   * the database's write lock. Every write path checks the hold synchronously right before writing, so no write is in
   * flight once this returns. Throws when writes are already held; rebuild() refuses while they are.
   */
  holdWrites(): () => void {
    if (this.writeHold !== null) throw new Error('pipeline writes are already held');
    let open!: () => void;
    const hold = new Promise<void>((resolve) => {
      open = resolve;
    });
    this.writeHold = hold;
    return () => {
      if (this.writeHold !== hold) return;
      this.writeHold = null;
      // Before anything that waited runs: the held hooks go first, in arrival order.
      let drained: Set<string> = new Set();
      try {
        drained = this.drainHeldHooks();
      } catch (err) {
        this.reportFailure('hook', err);
      }
      open();
      for (const id of drained) void this.enqueue(id, () => {}).catch(() => undefined); // re-derive now
    };
  }

  private heldHooksPath(): string {
    return path.join(this.config.dataDir, HELD_HOOKS_FILE);
  }

  /** Appends a hook raw event to the held-hooks file; false when it could not be written (then it waits in memory). */
  private holdHook(event: RawEvent): boolean {
    try {
      fs.mkdirSync(this.config.dataDir, { recursive: true });
      fs.appendFileSync(this.heldHooksPath(), `${JSON.stringify(event)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stores the hooks of the held-hooks file (lines that do not parse, e.g. one cut short by a kill, are skipped): in one
   * transaction their raw events, a dirty mark for each session (re-derived on its next touch, as a hook whose
   * processing failed) and the file's hash in `meta`; then deletes the file. A file whose hash is already recorded was
   * stored before (killed before the delete): it is only deleted. Returns the sessions marked dirty.
   */
  private drainHeldHooks(): Set<string> {
    const file = this.heldHooksPath();
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      return new Set();
    }
    const hash = createHash('sha1').update(content).digest('hex');
    const sessions = new Set<string>();
    if (this.store.getMeta(HELD_HOOKS_DRAINED) !== hash) {
      const events: Extract<RawEvent, { source: 'hook' }>[] = [];
      for (const line of content.split('\n')) {
        if (line.trim() === '') continue;
        try {
          const e = JSON.parse(line) as Extract<RawEvent, { source: 'hook' }>;
          if (e?.source === 'hook' && typeof e.eventName === 'string' && typeof e.receivedAt === 'string' && typeof e.payload === 'string') events.push(e);
        } catch {
          // a line cut short by a kill
        }
      }
      this.store.transaction(() => {
        for (const e of events) {
          this.store.insertRaw(e);
          if (e.sessionId !== null) {
            this.store.markDirty(e.sessionId);
            sessions.add(e.sessionId);
          }
        }
        this.store.setMeta(HELD_HOOKS_DRAINED, hash);
      });
      for (const id of sessions) this.dirty.add(id);
    }
    fs.rmSync(file, { force: true });
    return sessions;
  }

  /** True while holdWrites() holds the writes. */
  writesHeld(): boolean {
    return this.writeHold !== null;
  }

  /**
   * Resolves once writes are not held. Callers write `if (this.writeHold !== null) await this.writable()` so the normal
   * path takes no extra turn.
   */
  private async writable(): Promise<void> {
    while (this.writeHold !== null) await this.writeHold;
  }

  /**
   * Stops the poll sources (a pipeline closed before its initial scan never starts them). Pending ingestion is left to
   * idle().
   */
  close(): Promise<void> {
    if (this.closing === null) {
      this.closed = true;
      // Never rejects: a stop() that throws (synchronously too) or rejects does not keep the others from stopping.
      this.closing = this.pollsStarted
        ? Promise.allSettled(this.polls.map(async (p) => p.stop())).then(() => undefined)
        : Promise.resolve();
    }
    return this.closing;
  }

  /**
   * Records a failure for diagnostics and writes one stderr line (file path / session and error message only, never
   * content), at most once per key per minute.
   */
  reportFailure(key: string, err: unknown): void {
    const error = err instanceof Error ? err.message : String(err);
    const now = Date.now();
    if (key !== 'hook') this.failures.set(key, { error, at: new Date(now).toISOString() });
    const last = this.lastLogged.get(key);
    if (last !== undefined && now - last < LOG_EVERY_MS) return;
    this.lastLogged.set(key, now);
    const what = isNonFileKey(key) ? key : this.rel(key);
    this.log(`agent-canvas: ingest failed: ${what}: ${error}`);
  }

  onChanges(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Called with a session id after that session was re-derived: subscribers of it should refetch its snapshot. */
  onResync(listener: ResyncListener): () => void {
    this.resyncListeners.add(listener);
    return () => {
      this.resyncListeners.delete(listener);
    };
  }

  lastHookAt(): string | null {
    this.seed();
    return this.lastHook;
  }

  /** Number of sessions currently held in the Normalizer's memory. */
  loadedSessionCount(): number {
    return this.normalizer.sessionCount();
  }

  /** Files whose last ingest attempt failed (unreadable, locked, ...). */
  ingestFailures(): { file: string; error: string; at: string }[] {
    return [...this.failures].map(([key, f]) => ({ file: isNonFileKey(key) ? key : this.rel(key), error: f.error, at: f.at }));
  }

  /** Resolves when no ingest or hydration work is pending. */
  async idle(): Promise<void> {
    while (this.active.size > 0) await Promise.allSettled([...this.active]);
  }

  /** Reads new content of one file. Concurrent calls for the same file are serialized (at most one queued rerun). */
  ingestFile(absPath: string): Promise<void> {
    let lock = this.locks.get(absPath);
    if (!lock) {
      lock = { running: null, queued: null };
      this.locks.set(absPath, lock);
    }
    const l = lock;
    if (!l.running && !l.queued) {
      l.running = this.runLocked(absPath, l);
      return this.track(l.running);
    }
    if (!l.queued) {
      const prev = l.running!;
      l.queued = prev
        .catch(() => undefined)
        .then(() => {
          l.queued = null;
          l.running = this.runLocked(absPath, l);
          return l.running;
        });
      this.track(l.queued);
    }
    return l.queued;
  }

  /**
   * `transcriptPath` is the payload's `transcript_path`: when the source of `origin` knows it as a session or agent
   * transcript, its project is stored with the raw event (so replay reproduces it) and used for a new session.
   * Cursor: `sessionId` is the payload's conversation id and `from.cwd` its first workspace root; the hook of a stored
   * subagent conversation is filed under its owning session and pokes every session owning it (cursorHookTarget).
   */
  ingestHook(
    eventName: string,
    sessionId: string | null,
    payload: string,
    transcriptPath?: string | null,
    origin: Origin = 'claude',
    from: { cwd: string | null; agentId: string | null } = { cwd: null, agentId: null },
  ): void {
    const receivedAt = new Date().toISOString();
    const source = this.sourceFor(origin);
    let projectId: string | null;
    let pokes: (string | null)[] = [sessionId];
    if (origin === 'cursor') ({ sessionId, projectId, pokes } = this.cursorHookTarget(sessionId, from.cwd));
    else
      projectId =
        origin === 'codex'
          ? this.codexHookProject(sessionId, transcriptPath ?? null, from)
          : source !== null && typeof transcriptPath === 'string' && transcriptPath !== ''
            ? source.projectOfTranscript(transcriptPath)
            : null;
    const event: RawEvent = { source: 'hook', origin, receivedAt, eventName, sessionId, payload, projectId };
    for (const id of pokes) this.pokePoll(origin, id);
    this.seed();
    if (this.lastHook === null || receivedAt > this.lastHook) this.lastHook = receivedAt;
    // Writes held (VACUUM): onto disk next to the database, stored when they are released (or at the next start).
    if (this.writeHold !== null && this.holdHook(event)) return;
    const key = `hook:${sessionId}`;
    const keepRaw = (): void => {
      if (this.writeHold !== null) {
        void this.track(this.writable().then(keepRaw));
        return;
      }
      if (!this.persistedHooks.has(event)) {
        try {
          this.store.transaction(() => {
            this.store.insertRaw(event);
            if (sessionId !== null) this.store.markDirty(sessionId);
          });
          this.persistedHooks.add(event);
          if (sessionId !== null) this.dirty.add(sessionId);
        } catch {
          // nothing more we can do
        }
      }
    };
    const onError = (err: unknown): void => {
      this.reportFailure(key, err);
      // The slice rolled back; keep the raw event alone (it must not be lost) and, in the same transaction, mark the
      // session dirty: its derived rows now lag behind its raw events until the next touch re-derives it.
      keepRaw();
    };
    const needsQueue =
      sessionId !== null &&
      (this.writeHold !== null ||
        this.tails.has(sessionId) ||
        this.dirty.has(sessionId) ||
        (!this.normalizer.hasSession(sessionId) &&
          (this.store.getSession(sessionId) !== null ||
            (this.normalizer.needsPreSessionReplay(sessionId) && this.store.hasRawForSession(sessionId)))));
    if (!needsQueue || sessionId === null) {
      const apply = (): void => {
        try {
          this.applyHook(event);
          this.failures.delete(key);
        } catch (err) {
          onError(err);
        }
      };
      // A hook without a session waits for held writes on its own (in arrival order); one with a session queues.
      if (this.writeHold !== null) void this.track(this.writable().then(apply));
      else apply();
      return;
    }
    this.enqueue(sessionId, () => this.applyHook(event)).then(() => {
      this.failures.delete(key);
    }, onError);
  }

  /**
   * Full scan: one directory listing; ingests files that are new or whose size differs from the stored size (this
   * also picks up files chokidar missed), evicts cold sessions, and derives deleted sources from the same listing.
   */
  async scanAll(): Promise<void> {
    const initial = !this.initialScanDone;
    this.initialScanDone = true;
    if (initial) this.importDepth += 1;
    try {
      await this.fullScan();
    } finally {
      if (initial) {
        this.importDepth -= 1;
        this.startPolls();
      }
    }
  }

  private async fullScan(): Promise<void> {
    await this.touchDirty();
    const files = await this.listFiles();
    const groups = new Map<string, { sessionId: string; files: string[] }>();
    const indexes: string[] = [];
    for (const file of files) {
      let cls: FileClass | null;
      try {
        const classified = this.classifyFile(file);
        cls = isPromise(classified) ? await classified : classified;
      } catch {
        continue; // reported by classifyFile
      }
      if (cls === null) continue;
      if (cls.kind === 'index') {
        indexes.push(file);
        continue;
      }
      this.registerFile(cls.sessionId, file);
      const key = `${cls.projectId}\u0000${cls.sessionId}`;
      const g = groups.get(key) ?? { sessionId: cls.sessionId, files: [] };
      g.files.push(file);
      groups.set(key, g);
    }
    for (const { sessionId, files: group } of groups.values()) {
      for (const file of group) {
        if (await this.unchanged(file)) continue;
        await this.safeIngest(file);
      }
      this.evictIfOld(sessionId);
    }
    // After every session file: the threads classified above are what an index's entries are placed by.
    for (const file of indexes) if (await this.indexDue(file)) await this.safeIngest(file);
    await this.markDeletedSources(new Set(files.map((f) => this.rel(f))));
  }

  /**
   * Cheap periodic check (every rescanMs): stats only the files of hot sessions (touched within evictAfterMs) plus
   * files whose last ingest failed, ingests those whose size changed, then evicts sessions untouched for evictAfterMs.
   * New files and deletions are left to chokidar and the full scan.
   */
  async rescan(): Promise<void> {
    await this.touchDirty();
    const now = Date.now();
    const targets = new Set<string>();
    for (const [id, touched] of this.lastTouch) {
      if (now - touched > this.config.evictAfterMs) continue;
      for (const file of this.filesBySession.get(id) ?? []) targets.add(file);
    }
    for (const key of this.failures.keys()) if (!isNonFileKey(key) && !this.isPollKey(key)) targets.add(key);
    for (const file of [...targets].sort()) {
      if (await this.unchanged(file)) continue;
      await this.safeIngest(file);
    }
    for (const source of this.sources) {
      for (const file of source.indexFiles?.() ?? []) if (await this.indexDue(file)) await this.safeIngest(file);
    }
    for (const [id, touched] of [...this.lastTouch]) {
      if (now - touched > this.config.evictAfterMs && !this.tails.has(id) && this.mayEvict(id)) this.drop(id);
    }
  }

  /** Re-derives everything from the raw log. */
  /**
   * Re-derives everything from the raw log, one session at a time: each session's raw rows are replayed page by page
   * through a fresh Normalizer and committed in that session's own transaction, then its state is released, so peak
   * memory is bounded by the largest session. `rebuild_in_progress` (meta) is set before the derived tables are
   * cleared and removed only after the last session and the normalizer version are written, so an interrupted
   * rebuild is detected and redone. unknown_stat is cleared and recomputed. `progress(done, total)` is called every
   * REBUILD_PROGRESS_EVERY sessions and after the last one.
   */
  rebuild(progress?: (done: number, total: number) => void): void {
    if (this.active.size > 0 || this.tails.size > 0) throw new Error('rebuild refused: ingest work is pending (await idle() first)');
    if (this.writeHold !== null) throw new Error('rebuild refused: writes are held');
    this.importDepth += 1;
    try {
      this.rebuildAll(progress);
    } finally {
      this.importDepth -= 1;
    }
  }

  private rebuildAll(progress?: (done: number, total: number) => void): void {
    this.store.setMeta(REBUILD_FLAG, '1');
    this.store.clearDerived();
    this.normalizer = this.newNormalizer();
    this.lastTouch.clear();
    const ids = this.store.allSessionIdsInRaw();
    try {
      ids.forEach((id, i) => {
        this.normalizer = this.newNormalizer();
        const changes: Change[] = [];
        const unknown: [string, string][] = [];
        let after = 0;
        for (;;) {
          const page = this.store.rawForSessionAfter(id, after, HYDRATE_PAGE_ROWS, HYDRATE_PAGE_BYTES);
          if (page.length === 0) break;
          const out = this.replay(page);
          for (const c of out.changes) changes.push(c);
          page.forEach((ev, k) => {
            const type = out.unknown[k];
            if (type !== undefined && ev.source !== 'meta') unknown.push([type, ev.source === 'transcript' ? ev.line : ev.payload]);
          });
          after = page[page.length - 1]!.ingestId;
        }
        this.atomically(null, () => {
          for (const [type, sample] of unknown) this.store.bumpUnknown(type, sample);
          return changes;
        });
        this.normalizer = this.newNormalizer(); // release this session before the next one
        if ((i + 1) % REBUILD_PROGRESS_EVERY === 0 || i + 1 === ids.length) progress?.(i + 1, ids.length);
      });
    } finally {
      // Sessions are re-hydrated on demand; leave nothing loaded-but-untracked.
      this.normalizer = this.newNormalizer();
      this.lastTouch.clear();
    }
    this.store.setMeta(NORMALIZER_VERSION_KEY, String(NORMALIZER_VERSION));
    // Every session was just re-derived from its raw events: no session is behind any more.
    this.store.clearAllDirty();
    for (const id of this.dirty) this.failures.delete(sessionKey(id));
    this.dirty.clear();
    this.store.deleteMeta(REBUILD_FLAG);
    // sourceDeleted flags were cleared with the derived tables; the next full scan's listing restores them.
    this.flagsChecked = false;
  }

  /** The files every source lists (absolute paths), in stable order. */
  async listFiles(): Promise<string[]> {
    const lists = await Promise.all(this.sources.map((s) => s.listFiles()));
    return lists.flat().sort();
  }

  // ---------------------------------------------------------------- poll sources

  private newNormalizer(): NormalizerRegistry {
    return new NormalizerRegistry(this.factories);
  }

  private pollSourceFor(origin: Origin): PollSource | null {
    return this.polls.find((p) => p.origin === origin) ?? null;
  }

  /** True for a store key of a polled origin: its failures are not files the rescan could re-read. */
  private isPollKey(key: string): boolean {
    return this.polls.length > 0 && this.pollSourceFor(originOfKey(key)) !== null;
  }

  /** Starts each poll source once, after the initial scan, unless the pipeline was closed. */
  private startPolls(): void {
    if (this.pollsStarted || this.closed) return;
    this.pollsStarted = true;
    for (const source of this.polls) {
      try {
        source.start(this.sinkFor(source));
      } catch (err) {
        this.reportFailure(`${KEY_PREFIXES[source.origin]}poll`, err);
      }
    }
  }

  /** A hook of `origin` arrived for a session: the poll source of that origin (if any) polls it soon. */
  private pokePoll(origin: Origin, sessionId: string | null): void {
    if (sessionId === null) return;
    const source = this.pollSourceFor(origin);
    if (source === null) return;
    try {
      source.poke(sessionId);
    } catch {
      // a failing source must not break hook ingestion
    }
  }

  /** What `source` may ask of the pipeline, bound to its origin. */
  private sinkFor(source: PollSource): PollSink {
    return {
      ingestRecords: (batch) => this.ingestPolled(source.origin, batch),
      markSourceDeleted: (sessionId) => this.markSourceDeleted(sessionId),
      clearSourceDeleted: (sessionId) => this.clearSourceDeleted(sessionId),
      reportFailure: (key, err) => this.reportFailure(key, err),
      clearFailure: (key) => {
        this.failures.delete(key);
      },
      storedSessionIds: () => this.store.transcriptSessionIds(KEY_PREFIXES[source.origin]),
      loadUnitStates: () =>
        new Map(this.store.metaWithPrefix(`${POLL_STATE_PREFIX}${KEY_PREFIXES[source.origin]}`).map(([k, v]) => [k.slice(POLL_STATE_PREFIX.length), v])),
      saveUnitState: (key, value) => {
        if (!key.startsWith(KEY_PREFIXES[source.origin])) throw new Error(`not a ${source.origin} key: ${key}`);
        if (value === null) this.store.deleteMeta(`${POLL_STATE_PREFIX}${key}`);
        else this.store.setMeta(`${POLL_STATE_PREFIX}${key}`, value);
      },
    };
  }

  /**
   * PollSink.ingestRecords: one transaction and one derivation per batch, in the session's work chain. Each record not
   * stored yet under the key becomes a transcript raw event whose offset is the key's next sequence number (0, 1, 2, ...
   * in ingestion order, continuing after the highest one stored), so a key's offsets follow ingest order as a file's
   * byte offsets do. A batch whose records are all stored already does nothing at all (no hydration, no derivation).
   * Before writing, batches wait in turn (in call order) for store.settleWal, which keeps the WAL bounded during a
   * long import.
   */
  private ingestPolled(origin: Origin, batch: PollBatch): Promise<void> {
    if (this.closed) return Promise.reject(new Error('pipeline closed'));
    if (batch.records.length === 0) return Promise.resolve();
    const { key } = batch;
    if (batch.records.every((r) => this.store.hasTranscriptLine(key, r.line))) return Promise.resolve();
    this.pollIngests += 1;
    const gate = this.walGate.then(() => this.store.settleWal());
    this.walGate = gate.catch(() => undefined);
    const run = (async (): Promise<void> => {
      try {
        await gate;
        if (this.closed) throw new PipelineClosed();
        await this.storePolled(origin, batch);
      } catch (err) {
        if (!(err instanceof PipelineClosed)) this.reportFailure(key, err);
        throw err;
      } finally {
        this.pollIngests -= 1;
      }
    })();
    return this.track(run);
  }

  /** The write of one poll batch (see ingestPolled), in the session's work chain. */
  private async storePolled(origin: Origin, batch: PollBatch): Promise<void> {
    const { key, sessionId, agentId, projectId } = batch;
    await this.enqueue(sessionId, () => {
      let next = this.pollOffsets.get(key) ?? (this.store.maxTranscriptOffset(key) ?? -1) + 1;
      this.atomically(
        sessionId,
        () => {
          // One transaction and one derivation for the whole batch.
          const items: BatchItem[] = [];
          const lines: string[] = [];
          for (const { recordType, line } of batch.records) {
            const event: RawEvent = { source: 'transcript', origin, file: key, offset: next, line, recordType, sessionId, agentId, projectId };
            if (this.store.insertRaw(event) === null) continue;
            next += 1;
            items.push({ event, projectId });
            lines.push(line);
          }
          const out = this.normalizer.applyBatch(items);
          out.unknown.forEach((type, k) => {
            if (type !== undefined) this.store.bumpUnknown(type, lines[k]!);
          });
          return out.changes;
        },
        () => this.pollOffsets.set(key, next),
      );
    });
    // No failure is cleared here: the key's failures may come from the source itself (clearFailure clears them).
  }

  /** PollSink.markSourceDeleted: the session is flagged, and stays flagged in every later change of it. */
  private async markSourceDeleted(sessionId: string): Promise<void> {
    if (this.writeHold !== null) await this.writable();
    if (this.closed) return;
    this.deleted.add(sessionId);
    const session = this.store.getSession(sessionId);
    if (session && !session.sourceDeleted) this.commit([{ type: 'session_upserted', session: { ...session, sourceDeleted: true } }]);
  }

  /** PollSink.clearSourceDeleted: also clears a flag stored by an earlier run (no longer in `deleted`). */
  private async clearSourceDeleted(sessionId: string): Promise<void> {
    if (this.writeHold !== null) await this.writable();
    if (this.closed) return;
    this.deleted.delete(sessionId);
    const session = this.store.getSession(sessionId);
    if (session?.sourceDeleted) this.commit([{ type: 'session_upserted', session: { ...session, sourceDeleted: false } }]);
  }

  // ---------------------------------------------------------------- internals

  /** Loads the size mirror and the last hook time once (file_offset and a meta key; never a raw_event scan). */
  private seed(): void {
    if (this.sizes !== null) return;
    this.sizes = new Map(this.store.listOffsets().map((f) => [f.path, f.size]));
    this.lastHook = this.store.lastHookAt();
  }

  private sizeMap(): Map<string, number> {
    this.seed();
    return this.sizes!;
  }

  /** True when the file's size equals the stored size (nothing new can be complete), or when it is gone. */
  private async unchanged(absPath: string): Promise<boolean> {
    const stored = this.sizeMap().get(this.rel(absPath));
    if (stored === undefined) return false;
    try {
      return (await fsp.stat(absPath)).size === stored;
    } catch {
      return true; // gone: the full scan's listing marks the session
    }
  }

  private registerFile(sessionId: string, absPath: string): void {
    let set = this.filesBySession.get(sessionId);
    if (!set) {
      set = new Set();
      this.filesBySession.set(sessionId, set);
    }
    set.add(absPath);
  }

  /**
   * A session whose stored status is running / awaiting_* with activity within STALE_AFTER_MS is never evicted: it is
   * live, and re-hydrating it on every event would be wasted work.
   */
  private mayEvict(sessionId: string): boolean {
    const session = this.store.getSession(sessionId);
    if (session === null || !LIVE_STATUSES.has(session.status)) return true;
    return Date.now() - Date.parse(session.lastActivityAt) > STALE_AFTER_MS;
  }

  /** Store key of a file (see FileSource.keyOf); the absolute path when no source knows it. */
  private rel(absPath: string): string {
    return this.locate(absPath)?.key ?? absPath;
  }

  /** The source an absolute path belongs to and its key there (the first source that has a key for it). */
  private locate(absPath: string): { source: FileSource; key: string } | null {
    for (const source of this.sources) {
      const key = source.keyOf(absPath);
      if (key !== null) return { source, key };
    }
    return null;
  }

  /** The configured source of the origin a store key belongs to (told by its prefix), or null. */
  private sourceOfKey(key: string): FileSource | null {
    return this.sourceFor(originOfKey(key));
  }

  private sourceFor(origin: Origin): FileSource | null {
    return this.sources.find((s) => s.origin === origin) ?? null;
  }

  /**
   * Session, project and pokes of a Cursor hook, decided once on arrival and stored with the raw event (replay uses the
   * stored values). A main conversation (`cursor:<id>` stored) is its own session. A subagent conversation stored under
   * `cursor:<session>/<id>` belongs to every such session (forks share subagents): the hook is filed under the lowest
   * of their ids and pokes each of them. Otherwise (nothing stored yet) the session is the conversation id. Project:
   * the session's own when the store knows the session (a hook never moves it); else the one stored with the records;
   * else the first workspace root encoded as the Cursor source encodes a working directory (reusing a known project id
   * that differs only in letter case); else null.
   */
  private cursorHookTarget(
    conversationId: string | null,
    workspaceRoot: string | null,
  ): { sessionId: string | null; projectId: string | null; pokes: (string | null)[] } {
    if (conversationId === null) return { sessionId: null, projectId: null, pokes: [] };
    const prefix = KEY_PREFIXES.cursor;
    let owner = this.store.transcriptFileOwner(`${prefix}${conversationId}`);
    let owners = owner === null ? [] : [conversationId];
    if (owner === null) {
      const suffix = `/${conversationId}`;
      const keys = this.store.transcriptKeys(prefix).filter((k) => k.endsWith(suffix) && k.indexOf('/') === k.length - suffix.length);
      owners = [...new Set(keys.map((k) => k.slice(prefix.length, k.length - suffix.length)))].sort();
      if (owners.length > 0) owner = this.store.transcriptFileOwner(`${prefix}${owners[0]}${suffix}`);
    }
    const sessionId = owners[0] ?? conversationId;
    const pokes = owners.length > 0 ? owners : [conversationId];
    const stored = this.store.getSession(sessionId)?.projectId ?? null;
    if (stored !== null && stored !== UNKNOWN_PROJECT) return { sessionId, projectId: stored, pokes };
    if (owner?.projectId != null && owner.projectId !== UNKNOWN_PROJECT) return { sessionId, projectId: owner.projectId, pokes };
    const cwd = workspaceRoot === null ? null : cursorRootPath(workspaceRoot);
    return { sessionId, projectId: cwd === null ? null : this.cursorProjects.forCwd(cwd), pokes };
  }

  /**
   * Project of a Codex hook, decided once on arrival and stored with the raw event (replay uses the stored value): the
   * payload's cwd encoded the way the Codex file source does it (reusing a project id that differs only in letter
   * case), for a session the store does not have yet; a known session keeps its project (a hook never moves it, a
   * subagent's worktree cwd included). A hook without a cwd falls back to its transcript_path.
   */
  private codexHookProject(sessionId: string | null, transcriptPath: string | null, from: { cwd: string | null; agentId: string | null }): string | null {
    const source = this.sourceFor('codex');
    let known: string | null = null;
    if (sessionId !== null) {
      const stored = this.store.getSession(sessionId)?.projectId ?? null;
      if (stored !== null && stored !== UNKNOWN_PROJECT) known = stored;
    }
    // A session the store already has keeps its project: a hook never moves it (not for its own cwd either).
    if (known !== null) return known;
    if (source?.projectOfHook) {
      const p = source.projectOfHook(sessionId, from.cwd, from.agentId);
      if (p !== null) return p;
    } else if (from.cwd !== null) {
      return encodeProjectId(from.cwd);
    }
    if (source !== null && transcriptPath !== null && transcriptPath !== '') {
      const p = source.projectOfTranscript(transcriptPath);
      if (p !== null) return p;
    }
    return known;
  }

  /** Classification of an absolute path by its source (a promise only from a source that classifies asynchronously). */
  private classifyFile(absPath: string): MaybePromise<FileClass | null> {
    const hit = this.locate(absPath);
    if (hit === null) return null;
    return this.classifyAt(absPath, hit.source, hit.key);
  }

  /**
   * `source.classify(key)`, where a throw (e.g. a Codex rollout whose first line is not complete yet) is reported as an
   * ingest failure of the file on every path (full scan, rescan, watcher event) and rethrown; the next classification
   * that succeeds clears that failure. A synchronous answer stays synchronous.
   */
  private classifyAt(absPath: string, source: FileSource, key: string): MaybePromise<FileClass | null> {
    const ok = (cls: FileClass | null): FileClass | null => {
      if (this.classifyFailed.delete(absPath)) this.failures.delete(absPath);
      return cls;
    };
    const fail = (err: unknown): never => {
      this.classifyFailed.add(absPath);
      this.reportFailure(absPath, err);
      throw err;
    };
    let classified: MaybePromise<FileClass | null>;
    try {
      classified = source.classify(key);
    } catch (err) {
      return fail(err);
    }
    return isPromise(classified) ? classified.then(ok, fail) : ok(classified);
  }

  /**
   * An index file is read again when its source can place more entries than at the last read (indexVersion), or when
   * its size differs from the recorded one; never while it does not exist.
   */
  private async indexDue(absPath: string): Promise<boolean> {
    const hit = this.locate(absPath);
    if (hit === null) return false;
    let size: number;
    try {
      size = (await fsp.stat(absPath)).size;
    } catch {
      return false;
    }
    if ((this.indexVersions.get(absPath) ?? 0) !== (hit.source.indexVersion?.() ?? 0)) return true;
    return this.sizeMap().get(hit.key) !== size;
  }

  /** `file` is the relative store key. */
  private recordOffset(file: string, offset: number, size: number): void {
    this.store.setOffset(file, offset, size);
    this.sizeMap().set(file, size);
  }

  /** Registers p in `active`; the cleanup runs before any consumer awaiting p resumes. */
  private track<T>(p: Promise<T>, onDone?: (self: Promise<void>) => void): Promise<T> {
    const done: Promise<void> = p.then(
      () => finish(),
      () => finish(),
    );
    const finish = (): void => {
      this.active.delete(done);
      onDone?.(done);
    };
    this.active.add(done);
    return p;
  }

  private async safeIngest(file: string): Promise<void> {
    try {
      await this.ingestFile(file);
      this.failures.delete(file);
    } catch (err) {
      this.reportFailure(file, err);
    }
  }

  /**
   * Runs `task` (synchronous: insert + normalize + commit) after any earlier work for this session and
   * after the session has been hydrated into the Normalizer.
   */
  private enqueue(sessionId: string, task: () => void): Promise<void> {
    const run = async (): Promise<void> => {
      if (this.writeHold !== null) await this.writable();
      if (this.dirty.has(sessionId)) this.tryRederive(sessionId);
      await this.hydrate(sessionId);
      if (this.writeHold !== null) await this.writable();
      this.lastTouch.set(sessionId, Date.now());
      task();
    };
    const prev = this.tails.get(sessionId);
    const p = prev ? prev.then(run) : run();
    const tail = p.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(sessionId, tail);
    this.track(p, () => {
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
    });
    return p;
  }

  private async runLocked(absPath: string, lock: FileLock): Promise<void> {
    try {
      await this.doIngest(absPath);
    } finally {
      lock.running = null;
    }
  }

  private async doIngest(absPath: string): Promise<void> {
    const hit = this.locate(absPath);
    if (hit === null) return;
    const { source, key: file } = hit;
    // A synchronous source (Claude Code) is not awaited: the read starts in the same tick as before.
    const classified = this.classifyAt(absPath, source, file);
    const cls = isPromise(classified) ? await classified : classified;
    if (cls === null) return;
    if (cls.kind === 'index') return this.ingestIndex(absPath, source, file);
    if (cls.kind === 'title' || cls.kind === 'agent_meta') return this.ingestMeta(absPath, source, file, cls);

    const agentId = cls.kind === 'agent' ? (cls.agentId ?? null) : null;
    const origin = source.origin;
    // Stored with each line only when the key does not name the project, so replay never has to read the file.
    const projectId = source.projectOfKey(file) === null ? cls.projectId : null;
    this.registerFile(cls.sessionId, absPath);
    for (;;) {
      let size: number;
      try {
        size = (await fsp.stat(absPath)).size;
      } catch {
        return; // file is gone: keep the stored offset, scanAll marks the session
      }
      if (this.writeHold !== null) await this.writable();
      if (cls.kind === 'session') this.clearDeleted(cls.sessionId);
      const from = this.store.getOffset(file);
      const res = await readNewLines(absPath, from, READ_BUDGET_BYTES);
      if (this.writeHold !== null) await this.writable();
      const progressed = res.newOffset !== from || res.truncated;
      // The size stored with an offset is the size this read accounts for: the whole file only when the read reached
      // its end. A slice cut short (read budget, kill, failure) leaves a stored size below the real one, so unchanged()
      // sends the next scan back to finish the file.
      const seen = res.newOffset >= size ? size : res.newOffset;
      if (res.lines.length > 0) {
        // One transaction per slice: raw rows + unknown stats + derived changes + offset, all or nothing.
        const slice = (): Change[] => {
          const changes: Change[] = [];
          for (const { offset, text } of res.lines) {
            const recordType = topLevelType(text);
            const event: RawEvent = {
              source: 'transcript',
              origin,
              file,
              offset,
              line: text,
              recordType,
              sessionId: cls.sessionId,
              agentId,
              projectId,
            };
            if (this.store.insertRaw(event) === null) continue;
            const out = this.normalizer.apply(event, cls.projectId);
            changes.push(...out.changes);
            if (out.unknownRecordType !== undefined) this.store.bumpUnknown(out.unknownRecordType, text);
          }
          this.store.setOffset(file, res.newOffset, seen);
          return changes;
        };
        await this.enqueue(cls.sessionId, () => this.atomically(cls.sessionId, slice, () => this.sizeMap().set(file, seen)));
      } else if (progressed) {
        // Reads that only consumed blank lines still persist their progress.
        this.recordOffset(file, res.newOffset, seen);
      } else if (this.sizeMap().get(file) !== size) {
        // No complete line yet (trailing partial line, or growth during the read): record the size so the rescan does
        // not reopen the file every tick; the next size change brings it back.
        this.recordOffset(file, from, size);
      }
      if (res.newOffset === from) return;
      await yieldToEventLoop();
    }
  }

  /** `file` is the store key of `absPath` in `source`. */
  private async ingestMeta(absPath: string, source: FileSource, file: string, cls: FileClass): Promise<void> {
    let content: string;
    try {
      content = await fsp.readFile(absPath, 'utf8');
    } catch {
      return;
    }
    const size = Buffer.byteLength(content);
    const agentId = cls.kind === 'agent_meta' ? (cls.agentId ?? null) : null;
    this.registerFile(cls.sessionId, absPath);
    await this.enqueue(cls.sessionId, () => {
      // Compare against what is stored (not an in-memory cache) so the check survives restarts;
      // a file that was never recorded cannot have a stored copy, so skip the lookup.
      if (this.store.getOffset(file) > 0 && this.store.latestMeta(file) === content) return;
      const event: RawEvent = { source: 'meta', origin: source.origin, file, sessionId: cls.sessionId, agentId, payload: content };
      this.atomically(
        cls.sessionId,
        () => {
          this.store.insertRaw(event);
          const changes = this.normalizer.apply(event, cls.projectId).changes;
          // Recorded so the rescan timer treats the file as known and only revisits it when its size changes.
          this.store.setOffset(file, size, size);
          return changes;
        },
        () => this.sizeMap().set(file, size),
      );
    });
  }

  /**
   * An index file (many sessions' entries in one file, e.g. Codex's session_index.jsonl): read whole; each entry the
   * source can place becomes a meta raw event of its own session under its own key, written only when it differs from
   * the latest one stored for that key (so nothing is written twice, across restarts too), in that session's work
   * chain. `file` is the store key of `absPath` in `source`; its size is recorded so scans only revisit it on change.
   */
  private async ingestIndex(absPath: string, source: FileSource, file: string): Promise<void> {
    if (source.indexEntries === undefined) return;
    const version = source.indexVersion?.() ?? 0;
    let bytes: Buffer;
    try {
      bytes = await fsp.readFile(absPath);
    } catch {
      return;
    }
    // The size read in bytes (not the decoded text's: a BOM or invalid UTF-8 would never match the file's size).
    const size = bytes.length;
    const content = bytes.toString('utf8');
    for (const entry of source.indexEntries(file, content)) {
      if (this.store.latestMeta(entry.key) === entry.payload) continue;
      await this.enqueue(entry.sessionId, () => {
        if (this.store.latestMeta(entry.key) === entry.payload) return;
        const event: RawEvent = {
          source: 'meta',
          origin: source.origin,
          file: entry.key,
          sessionId: entry.sessionId,
          agentId: entry.agentId,
          payload: entry.payload,
          projectId: entry.projectId, // stored: replay gives the normalizer the same project
        };
        this.atomically(entry.sessionId, () => {
          this.store.insertRaw(event);
          return this.normalizer.apply(event, entry.projectId).changes;
        });
      });
    }
    if (this.writeHold !== null) await this.writable();
    this.recordOffset(file, size, size);
    this.indexVersions.set(absPath, version);
  }

  private applyHook(event: Extract<RawEvent, { source: 'hook' }>): void {
    const sessionId = event.sessionId;
    if (sessionId !== null) this.lastTouch.set(sessionId, Date.now());
    this.atomically(
      sessionId,
      () => {
        this.store.insertRaw(event);
        // The stored projectId alone (null -> 'unknown') gives the same result live and on replay. (Claude: used only
        // for a new session or to upgrade 'unknown'; Codex: only until the session's first transcript record.)
        const out = this.normalizer.apply(event, event.projectId ?? UNKNOWN_PROJECT);
        if (out.unknownRecordType !== undefined) this.store.bumpUnknown(out.unknownRecordType, event.payload);
        return out.changes;
      },
      () => this.persistedHooks.add(event),
    );
  }

  /**
   * A fresh (or evicted) Normalizer has no memory of sessions already in the store: replay their raw
   * history in short slices, discarding the changes (already persisted). Runs inside the session's
   * work chain, before the event about to be applied is inserted, so replay never includes it.
   */
  private async hydrate(sessionId: string): Promise<void> {
    const normalizer = this.normalizer;
    if (normalizer.hasSession(sessionId)) return;
    if (this.store.getSession(sessionId) === null) {
      // No session row yet, but committed raw events (a title record, an agent meta, a hook whose slice failed) may
      // exist: restore what the Normalizer keeps before a session exists from them, as a rebuild would.
      if (normalizer.needsPreSessionReplay(sessionId)) normalizer.restorePreSession(sessionId, this.rawPages(sessionId));
      return;
    }
    let after = 0;
    let done = false;
    try {
      while (!done) {
        const start = performance.now();
        while (!done && performance.now() - start < HYDRATE_SLICE_MS) {
          const page = this.store.rawForSessionAfter(sessionId, after, HYDRATE_PAGE_ROWS, HYDRATE_PAGE_BYTES);
          this.replay(page);
          if (page.length === 0) done = true;
          else after = page[page.length - 1]!.ingestId;
        }
        if (!done) {
          await yieldToEventLoop();
          if (normalizer !== this.normalizer) return; // rebuilt meanwhile: this replay is obsolete
        }
      }
    } catch (err) {
      normalizer.dropSession(sessionId); // never leave a half-replayed session behind
      throw err;
    }
  }

  /** Scans touch dirty sessions even without new content, so a mark is resolved (or retried) at the scan cadence. */
  private async touchDirty(): Promise<void> {
    for (const id of [...this.dirty]) {
      if (!this.tails.has(id)) await this.enqueue(id, () => {});
    }
  }

  /** Re-derives a dirty session; a failure keeps the mark and is recorded (the next touch retries). */
  private tryRederive(sessionId: string): void {
    try {
      this.rederive(sessionId);
      this.failures.delete(sessionKey(sessionId));
    } catch (err) {
      this.reportFailure(sessionKey(sessionId), err);
    }
  }

  /**
   * One session of `rebuild`: replays the session's raw events in ingest order through the live Normalizer (whose
   * state for it is discarded first), and in one transaction replaces its derived rows with the result and clears its
   * dirty mark. Then sessions-list subscribers get the session row and the session's subscribers a resync.
   */
  private rederive(sessionId: string): void {
    this.normalizer.dropSession(sessionId);
    let applied: SeqChange[];
    try {
      const changes: Change[] = [];
      for (const page of this.rawPageList(sessionId)) for (const c of this.replay(page).changes) changes.push(c);
      applied = this.store.transaction(() => {
        this.store.deleteDerivedForSession(sessionId);
        const out = this.persist(changes);
        this.store.clearDirty(sessionId);
        return out;
      });
    } catch (err) {
      this.normalizer.dropSession(sessionId); // never keep a state the database does not have
      throw err;
    }
    this.dirty.delete(sessionId);
    this.lastTouch.set(sessionId, Date.now());
    this.notify(applied.filter((c) => c.type === 'session_upserted'));
    for (const listener of [...this.resyncListeners]) {
      try {
        listener(sessionId);
      } catch {
        // a failing subscriber must not break ingestion
      }
    }
  }

  /** Every stored raw event of a session in ingest order, read page by page (undecodable ones skipped, reported). */
  private *rawPages(sessionId: string): Generator<StoredRawEvent> {
    for (const page of this.rawPageList(sessionId)) yield* this.readable(page);
  }

  /** The events of a page whose stored body could be decoded; each one that could not is reported (corruptKey). */
  private readable(events: readonly StoredRawEvent[]): readonly StoredRawEvent[] {
    if (!events.some((ev) => ev.corrupt !== undefined)) return events;
    return events.filter((ev) => {
      if (ev.corrupt === undefined) return true;
      this.reportFailure(corruptKey(ev), new Error(`stored record ${ev.ingestId} skipped: ${ev.corrupt}`));
      return false;
    });
  }

  /** The pages of rawPages. */
  private *rawPageList(sessionId: string): Generator<StoredRawEvent[]> {
    let after = 0;
    for (;;) {
      const page = this.store.rawForSessionAfter(sessionId, after, HYDRATE_PAGE_ROWS, HYDRATE_PAGE_BYTES);
      if (page.length === 0) return;
      yield page;
      after = page[page.length - 1]!.ingestId;
    }
  }

  /**
   * Derives the project from what is stored (the event's stored projectId, else what its origin's source reads from the
   * key alone), never from a directory or a file's content.
   */
  private projectOf(ev: StoredRawEvent): string {
    if (ev.source === 'hook') return ev.projectId ?? UNKNOWN_PROJECT;
    if ((ev.source === 'transcript' || ev.source === 'meta') && ev.projectId != null) return ev.projectId;
    return this.sourceFor(ev.origin)?.projectOfKey(ev.file) ?? UNKNOWN_PROJECT;
  }

  /**
   * Applies stored raw events in order as one batch (a normalizer with applyBatch derives once per page; the others
   * apply them one by one, as before). Events whose stored body could not be decoded are skipped and reported (never
   * thrown); `unknown` stays aligned with `events`.
   */
  private replay(events: readonly StoredRawEvent[]): { changes: Change[]; unknown: (string | undefined)[] } {
    const good = this.readable(events);
    const out = this.normalizer.applyBatch(good.map((event) => ({ event, projectId: this.projectOf(event) })));
    if (good === events) return out;
    let k = 0;
    return { changes: out.changes, unknown: events.map((ev) => (ev.corrupt === undefined ? out.unknown[k++] : undefined)) };
  }

  private drop(sessionId: string): void {
    this.normalizer.dropSession(sessionId);
    this.lastTouch.delete(sessionId);
  }

  /** After a scan group: forget sessions that are not recently active; they re-hydrate on demand. */
  private evictIfOld(sessionId: string): void {
    if (this.tails.has(sessionId) || !this.lastTouch.has(sessionId)) return;
    const session = this.store.getSession(sessionId);
    const recent = session !== null && Date.now() - Date.parse(session.lastActivityAt) <= this.config.evictAfterMs;
    if (!recent && this.mayEvict(sessionId)) this.drop(sessionId);
  }

  /**
   * Runs `work` (store writes + Normalizer) and persists the changes it returns in one transaction, then notifies
   * listeners. On failure nothing of the slice is in the database; the session's Normalizer state, which may now be
   * ahead of the database, is dropped so the next event re-hydrates it from what was committed.
   */
  private atomically(sessionId: string | null, work: () => Change[], afterCommit?: () => void): void {
    let applied: SeqChange[];
    try {
      applied = this.store.transaction(() => this.persist(work()));
    } catch (err) {
      if (sessionId !== null) this.drop(sessionId);
      throw err;
    }
    afterCommit?.();
    this.notify(applied);
  }

  private commit(changes: Change[]): void {
    this.atomically(null, () => changes);
  }

  private persist(changes: Change[]): SeqChange[] {
    if (changes.length === 0) return [];
    const fixed =
      this.deleted.size === 0
        ? changes
        : changes.map((c): Change =>
            c.type === 'session_upserted' && this.deleted.has(c.session.id) && !c.session.sourceDeleted
              ? { ...c, session: { ...c.session, sourceDeleted: true } }
              : c,
          );
    return this.store.applyChanges(fixed);
  }

  private notify(applied: SeqChange[]): void {
    if (applied.length === 0) return;
    for (const listener of [...this.listeners]) {
      try {
        listener(applied);
      } catch {
        // a failing subscriber must not break ingestion
      }
    }
  }

  /** The main session file is back: stop forcing sourceDeleted. */
  private clearDeleted(sessionId: string): void {
    if (!this.deleted.delete(sessionId)) return;
    const session = this.store.getSession(sessionId);
    if (session?.sourceDeleted) this.commit([{ type: 'session_upserted', session: { ...session, sourceDeleted: false } }]);
  }

  /**
   * Flags sessions whose recorded source file is missing from the full scan's directory listing (data is kept; the
   * flag is sticky) and clears it for sessions whose file is back, including flags left over from a previous run.
   */
  private async markDeletedSources(listed: ReadonlySet<string>): Promise<void> {
    /** Session -> the flag it should carry; the changes are built from the stored sessions right before committing. */
    const flags: [string, boolean][] = [];
    const firstPass = !this.flagsChecked;
    this.flagsChecked = true;
    for (const file of [...this.sizeMap().keys()]) {
      const source = this.sourceOfKey(file);
      if (source === null) continue; // a key of a source that is not configured now
      // A synchronous source (Claude Code) is not awaited: the whole pass stays one synchronous step, as before.
      const main = source.mainSessionOf(file);
      const sessionId = isPromise(main) ? await main : main;
      if (sessionId === null) continue;
      if (listed.has(file)) {
        if (firstPass || this.deleted.has(sessionId)) {
          this.deleted.delete(sessionId);
          flags.push([sessionId, false]);
        }
        continue;
      }
      this.deleted.add(sessionId);
      flags.push([sessionId, true]);
    }
    if (this.writeHold !== null) await this.writable();
    const changes: Change[] = [];
    for (const [sessionId, deleted] of flags) {
      const session = this.store.getSession(sessionId);
      if (session !== null && session.sourceDeleted !== deleted) changes.push({ type: 'session_upserted', session: { ...session, sourceDeleted: deleted } });
    }
    this.commit(changes);
  }
}
