import fsp from 'node:fs/promises';
import path from 'node:path';
import { STALE_AFTER_MS, type Change, type SeqChange } from '@claude-canvas/shared';
import type { Config } from './config.js';
import { Normalizer } from './normalize/normalizer.js';
import { NORMALIZER_VERSION } from './normalize/version.js';
import { classifyPath, classifyRelPath, relPath, type TranscriptFile } from './sources/transcript/paths.js';
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
/** At most one failure log line per file (or hook session) per minute. */
const LOG_EVERY_MS = 60_000;

export interface PipelineOptions {
  /** Receives failure lines (stderr in the CLI). No conversation content is ever passed. */
  log?: (line: string) => void;
}
/** meta keys */
export const REBUILD_FLAG = 'rebuild_in_progress';
export const NORMALIZER_VERSION_KEY = 'normalizer_version';

type Listener = (changes: SeqChange[]) => void;
interface FileLock {
  running: Promise<void> | null;
  queued: Promise<void> | null;
}

const yieldToEventLoop = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

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
  private normalizer = new Normalizer();
  private readonly listeners = new Set<Listener>();
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
  private flagsChecked = false;

  constructor(
    private readonly store: Store,
    private readonly config: Config,
    options: PipelineOptions = {},
  ) {
    this.log = options.log ?? (() => {});
  }

  /** True while the initial full scan or a rebuild is running. */
  importing(): boolean {
    return this.importDepth > 0;
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
    const what = key.startsWith('hook') ? key : this.rel(key);
    this.log(`claude-canvas: ingest failed: ${what}: ${error}`);
  }

  onChanges(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
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
    return [...this.failures].map(([key, f]) => ({ file: key.startsWith('hook:') ? key : this.rel(key), error: f.error, at: f.at }));
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
   * `transcriptPath` is the payload's `transcript_path`: when it classifies as a session or agent file under
   * projectsDir, its project is stored with the raw event (so replay reproduces it) and used for a new session.
   */
  ingestHook(eventName: string, sessionId: string | null, payload: string, transcriptPath?: string | null): void {
    const receivedAt = new Date().toISOString();
    const cls = typeof transcriptPath === 'string' && transcriptPath !== '' ? classifyPath(this.config.projectsDir, transcriptPath) : null;
    const projectId = cls !== null && (cls.kind === 'session' || cls.kind === 'agent') ? cls.projectId : null;
    const event: RawEvent = { source: 'hook', receivedAt, eventName, sessionId, payload, projectId };
    this.seed();
    if (this.lastHook === null || receivedAt > this.lastHook) this.lastHook = receivedAt;
    const key = `hook:${sessionId}`;
    const onError = (err: unknown): void => {
      this.reportFailure(key, err);
      // The slice rolled back; keep the raw event alone so the next hydration or rebuild applies it.
      if (!this.persistedHooks.has(event)) {
        try {
          this.store.insertRaw(event);
          this.persistedHooks.add(event);
        } catch {
          // nothing more we can do
        }
      }
    };
    const needsQueue =
      sessionId !== null &&
      (this.tails.has(sessionId) ||
        (!this.normalizer.hasSession(sessionId) &&
          (this.store.getSession(sessionId) !== null ||
            (this.normalizer.needsPreSessionReplay(sessionId) && this.store.hasRawForSession(sessionId)))));
    if (!needsQueue) {
      try {
        this.applyHook(event);
        this.failures.delete(key);
      } catch (err) {
        onError(err);
      }
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
      if (initial) this.importDepth -= 1;
    }
  }

  private async fullScan(): Promise<void> {
    const files = await this.listFiles();
    const groups = new Map<string, { sessionId: string; files: string[] }>();
    for (const file of files) {
      const cls = classifyPath(this.config.projectsDir, file);
      if (cls === null) continue;
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
    this.markDeletedSources(new Set(files.map((f) => this.rel(f))));
  }

  /**
   * Cheap periodic check (every rescanMs): stats only the files of hot sessions (touched within evictAfterMs) plus
   * files whose last ingest failed, ingests those whose size changed, then evicts sessions untouched for evictAfterMs.
   * New files and deletions are left to chokidar and the full scan.
   */
  async rescan(): Promise<void> {
    const now = Date.now();
    const targets = new Set<string>();
    for (const [id, touched] of this.lastTouch) {
      if (now - touched > this.config.evictAfterMs) continue;
      for (const file of this.filesBySession.get(id) ?? []) targets.add(file);
    }
    for (const key of this.failures.keys()) if (!key.startsWith('hook:')) targets.add(key);
    for (const file of [...targets].sort()) {
      if (await this.unchanged(file)) continue;
      await this.safeIngest(file);
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
    this.normalizer = new Normalizer();
    this.lastTouch.clear();
    const ids = this.store.allSessionIdsInRaw();
    try {
      ids.forEach((id, i) => {
        this.normalizer = new Normalizer();
        const changes: Change[] = [];
        const unknown: [string, string][] = [];
        let after = 0;
        for (;;) {
          const page = this.store.rawForSessionAfter(id, after, HYDRATE_PAGE_ROWS, HYDRATE_PAGE_BYTES);
          if (page.length === 0) break;
          for (const ev of page) {
            const out = this.normalizer.apply(ev, this.projectOf(ev));
            changes.push(...out.changes);
            if (out.unknownRecordType !== undefined && ev.source !== 'meta') {
              unknown.push([out.unknownRecordType, ev.source === 'transcript' ? ev.line : ev.payload]);
            }
          }
          after = page[page.length - 1]!.ingestId;
        }
        this.atomically(null, () => {
          for (const [type, sample] of unknown) this.store.bumpUnknown(type, sample);
          return changes;
        });
        this.normalizer = new Normalizer(); // release this session before the next one
        if ((i + 1) % REBUILD_PROGRESS_EVERY === 0 || i + 1 === ids.length) progress?.(i + 1, ids.length);
      });
    } finally {
      // Sessions are re-hydrated on demand; leave nothing loaded-but-untracked.
      this.normalizer = new Normalizer();
      this.lastTouch.clear();
    }
    this.store.setMeta(NORMALIZER_VERSION_KEY, String(NORMALIZER_VERSION));
    this.store.deleteMeta(REBUILD_FLAG);
    // sourceDeleted flags were cleared with the derived tables; the next full scan's listing restores them.
    this.flagsChecked = false;
  }

  /** Files under projectsDir that classifyPath recognizes, in stable order. */
  async listFiles(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fsp.readdir(this.config.projectsDir, { recursive: true });
    } catch {
      return [];
    }
    return entries
      .map((rel) => path.join(this.config.projectsDir, rel))
      .filter((abs) => classifyPath(this.config.projectsDir, abs) !== null)
      .sort();
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

  /** Store key of a file: path relative to projectsDir with `/` separators. */
  private rel(absPath: string): string {
    return relPath(this.config.projectsDir, absPath) ?? absPath;
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
      await this.hydrate(sessionId);
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
    const cls = classifyPath(this.config.projectsDir, absPath);
    if (cls === null) return;
    if (cls.kind === 'title' || cls.kind === 'agent_meta') return this.ingestMeta(absPath, cls);

    const agentId = cls.kind === 'agent' ? cls.agentId : null;
    const file = this.rel(absPath);
    this.registerFile(cls.sessionId, absPath);
    for (;;) {
      let size: number;
      try {
        size = (await fsp.stat(absPath)).size;
      } catch {
        return; // file is gone: keep the stored offset, scanAll marks the session
      }
      if (cls.kind === 'session') this.clearDeleted(cls.sessionId);
      const from = this.store.getOffset(file);
      const res = await readNewLines(absPath, from, READ_BUDGET_BYTES);
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
            const event: RawEvent = { source: 'transcript', file, offset, line: text, recordType, sessionId: cls.sessionId, agentId };
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

  private async ingestMeta(absPath: string, cls: Extract<TranscriptFile, { kind: 'title' | 'agent_meta' }>): Promise<void> {
    let content: string;
    try {
      content = await fsp.readFile(absPath, 'utf8');
    } catch {
      return;
    }
    const size = Buffer.byteLength(content);
    const agentId = cls.kind === 'agent_meta' ? cls.agentId : null;
    const file = this.rel(absPath);
    this.registerFile(cls.sessionId, absPath);
    await this.enqueue(cls.sessionId, () => {
      // Compare against what is stored (not an in-memory cache) so the check survives restarts;
      // a file that was never recorded cannot have a stored copy, so skip the lookup.
      if (this.store.getOffset(file) > 0 && this.store.latestMeta(file) === content) return;
      const event: RawEvent = { source: 'meta', file, sessionId: cls.sessionId, agentId, payload: content };
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

  private applyHook(event: Extract<RawEvent, { source: 'hook' }>): void {
    const sessionId = event.sessionId;
    if (sessionId !== null) this.lastTouch.set(sessionId, Date.now());
    this.atomically(
      sessionId,
      () => {
        this.store.insertRaw(event);
        // The Normalizer only uses projectId for a new session or to upgrade 'unknown', so the stored value alone
        // (null -> 'unknown') gives the same result live and on replay.
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
          for (const ev of page) this.replayOne(ev);
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

  /** Every stored raw event of a session in ingest order, read page by page. */
  private *rawPages(sessionId: string): Generator<StoredRawEvent> {
    let after = 0;
    for (;;) {
      const page = this.store.rawForSessionAfter(sessionId, after, HYDRATE_PAGE_ROWS, HYDRATE_PAGE_BYTES);
      if (page.length === 0) return;
      yield* page;
      after = page[page.length - 1]!.ingestId;
    }
  }

  /** Derives the project from what is stored (relative path or the hook's stored projectId), never from projectsDir. */
  private projectOf(ev: StoredRawEvent): string {
    return ev.source === 'hook' ? (ev.projectId ?? UNKNOWN_PROJECT) : (classifyRelPath(ev.file)?.projectId ?? UNKNOWN_PROJECT);
  }

  private replayOne(ev: StoredRawEvent): Change[] {
    return this.normalizer.apply(ev, this.projectOf(ev)).changes;
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
  private markDeletedSources(listed: ReadonlySet<string>): void {
    const changes: Change[] = [];
    const firstPass = !this.flagsChecked;
    this.flagsChecked = true;
    for (const file of this.sizeMap().keys()) {
      const cls = classifyRelPath(file);
      if (cls?.kind !== 'session') continue;
      if (listed.has(file)) {
        if (firstPass || this.deleted.has(cls.sessionId)) {
          this.deleted.delete(cls.sessionId);
          const session = this.store.getSession(cls.sessionId);
          if (session?.sourceDeleted) changes.push({ type: 'session_upserted', session: { ...session, sourceDeleted: false } });
        }
        continue;
      }
      this.deleted.add(cls.sessionId);
      const session = this.store.getSession(cls.sessionId);
      if (session && !session.sourceDeleted) changes.push({ type: 'session_upserted', session: { ...session, sourceDeleted: true } });
    }
    this.commit(changes);
  }
}
