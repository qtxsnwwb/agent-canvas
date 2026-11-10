import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Change, SeqChange } from '@claude-canvas/shared';
import type { Config } from './config.js';
import { Normalizer } from './normalize/normalizer.js';
import { classifyPath, type TranscriptFile } from './sources/transcript/paths.js';
import { readNewLines } from './sources/transcript/reader.js';
import type { RawEvent, Store, StoredRawEvent } from './store/store.js';

/** Per-read byte budget; keeps each synchronous slice of work short so the event loop stays responsive. */
const READ_BUDGET_BYTES = 64 * 1024;
/** Time budget of one synchronous hydration slice. */
const HYDRATE_SLICE_MS = 8;
/** Rows read from the store per hydration page. */
const HYDRATE_PAGE_ROWS = 200;
const UNKNOWN_PROJECT = 'unknown';

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
  private readonly failures = new Map<string, string>();
  /** Known file sizes (mirror of file_offset.size) and last hook time, loaded from the store once. */
  private sizes: Map<string, number> | null = null;
  private lastHook: string | null = null;
  /** Hook events already inserted into raw_event (so a failed task does not insert them twice). */
  private readonly persistedHooks = new WeakSet<object>();
  private flagsChecked = false;

  constructor(
    private readonly store: Store,
    private readonly config: Config,
  ) {}

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
    let n = 0;
    for (const id of this.lastTouch.keys()) if (this.normalizer.hasSession(id)) n += 1;
    return n;
  }

  /** Files whose last ingest attempt failed (unreadable, locked, ...). */
  ingestFailures(): { file: string; error: string }[] {
    return [...this.failures].map(([file, error]) => ({ file, error }));
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

  ingestHook(eventName: string, sessionId: string | null, payload: string): void {
    const receivedAt = new Date().toISOString();
    const event: RawEvent = { source: 'hook', receivedAt, eventName, sessionId, payload };
    this.seed();
    if (this.lastHook === null || receivedAt > this.lastHook) this.lastHook = receivedAt;
    const needsQueue =
      sessionId !== null &&
      (this.tails.has(sessionId) || (!this.normalizer.hasSession(sessionId) && this.store.getSession(sessionId) !== null));
    if (!needsQueue) {
      this.applyHook(event);
      return;
    }
    const key = `hook:${sessionId}`;
    this.enqueue(sessionId, () => this.applyHook(event)).then(
      () => {
        this.failures.delete(key);
      },
      (err: unknown) => {
        this.failures.set(key, err instanceof Error ? err.message : String(err));
        // Keep the raw event so it is applied by the next hydration or rebuild.
        if (!this.persistedHooks.has(event)) {
          try {
            this.store.insertRaw(event);
            this.persistedHooks.add(event);
          } catch {
            // nothing more we can do
          }
        }
      },
    );
  }

  async scanAll(): Promise<void> {
    const groups = new Map<string, { sessionId: string; files: string[] }>();
    for (const file of await this.listFiles()) {
      const cls = classifyPath(this.config.projectsDir, file);
      if (cls === null) continue;
      const key = `${cls.projectId}\u0000${cls.sessionId}`;
      const g = groups.get(key) ?? { sessionId: cls.sessionId, files: [] };
      g.files.push(file);
      groups.set(key, g);
    }
    const sizes = this.sizeMap();
    for (const { sessionId, files } of groups.values()) {
      for (const file of files) {
        const kind = classifyPath(this.config.projectsDir, file)?.kind;
        if (kind === 'title' || kind === 'agent_meta') {
          const known = sizes.get(file);
          try {
            if (known !== undefined && (await fsp.stat(file)).size === known) continue;
          } catch {
            continue;
          }
        }
        await this.safeIngest(file);
      }
      this.evictIfOld(sessionId);
    }
    this.markDeletedSources();
  }

  /** Cheap periodic check: ingest files whose size differs from the stored size, plus files not seen yet. */
  async rescan(): Promise<void> {
    const sizes = this.sizeMap();
    for (const file of await this.listFiles()) {
      const storedSize = sizes.get(file);
      if (storedSize !== undefined) {
        try {
          if ((await fsp.stat(file)).size === storedSize) continue;
        } catch {
          continue;
        }
      }
      await this.safeIngest(file);
    }
    this.markDeletedSources();
    const now = Date.now();
    for (const [id, touched] of [...this.lastTouch]) {
      if (now - touched > this.config.evictAfterMs && !this.tails.has(id)) this.drop(id);
    }
  }

  /** Re-derives everything from the raw log. */
  rebuild(): void {
    if (this.active.size > 0 || this.tails.size > 0) throw new Error('rebuild refused: ingest work is pending (await idle() first)');
    this.store.clearDerived();
    this.normalizer = new Normalizer();
    const changes: Change[] = [];
    for (const id of this.store.allSessionIdsInRaw()) {
      const projectBySession = new Map<string, string>();
      for (const ev of this.store.rawForSession(id)) changes.push(...this.replayOne(ev, projectBySession));
    }
    this.commit(changes);
    // Sessions are re-hydrated on demand; leave nothing loaded-but-untracked.
    this.normalizer = new Normalizer();
    this.lastTouch.clear();
    this.markDeletedSources();
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

  private seed(): void {
    if (this.sizes !== null) return;
    const d = this.store.diagnostics();
    this.sizes = new Map(d.files.map((f) => [f.path, f.size]));
    this.lastHook = d.lastHookAt;
  }

  private sizeMap(): Map<string, number> {
    this.seed();
    return this.sizes!;
  }

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
      this.failures.set(file, err instanceof Error ? err.message : String(err));
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
    for (;;) {
      let size: number;
      try {
        size = (await fsp.stat(absPath)).size;
      } catch {
        return; // file is gone: keep the stored offset, scanAll marks the session
      }
      if (cls.kind === 'session') this.clearDeleted(cls.sessionId);
      const from = this.store.getOffset(absPath);
      const res = await readNewLines(absPath, from, READ_BUDGET_BYTES);
      if (res.lines.length > 0) {
        await this.enqueue(cls.sessionId, () => {
          const changes: Change[] = [];
          for (const { offset, text } of res.lines) {
            const recordType = topLevelType(text);
            const event: RawEvent = {
              source: 'transcript',
              file: absPath,
              offset,
              line: text,
              recordType,
              sessionId: cls.sessionId,
              agentId,
            };
            if (this.store.insertRaw(event) === null) continue;
            const out = this.normalizer.apply(event, cls.projectId);
            changes.push(...out.changes);
            if (out.unknownRecordType !== undefined) this.store.bumpUnknown(out.unknownRecordType, text);
          }
          this.commit(changes);
        });
      }
      // Persist on any progress, including reads that only consumed blank lines.
      if (res.newOffset !== from || res.truncated) this.recordOffset(absPath, res.newOffset, size);
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
    await this.enqueue(cls.sessionId, () => {
      // Compare against what is stored (not an in-memory cache) so the check survives restarts;
      // a file that was never recorded cannot have a stored copy, so skip the lookup.
      if (this.store.getOffset(absPath) > 0 && this.store.latestMeta(absPath) === content) return;
      const event: RawEvent = { source: 'meta', file: absPath, sessionId: cls.sessionId, agentId, payload: content };
      this.store.insertRaw(event);
      this.commit(this.normalizer.apply(event, cls.projectId).changes);
      // Recorded so the rescan timer treats the file as known and only revisits it when its size changes.
      this.recordOffset(absPath, size, size);
    });
  }

  private applyHook(event: Extract<RawEvent, { source: 'hook' }>): void {
    const sessionId = event.sessionId;
    if (sessionId !== null) this.lastTouch.set(sessionId, Date.now());
    this.store.insertRaw(event);
    this.persistedHooks.add(event);
    const projectId = (sessionId !== null ? this.store.getSession(sessionId)?.projectId : undefined) ?? UNKNOWN_PROJECT;
    const out = this.normalizer.apply(event, projectId);
    if (out.unknownRecordType !== undefined) this.store.bumpUnknown(out.unknownRecordType, event.payload);
    this.commit(out.changes);
  }

  /**
   * A fresh (or evicted) Normalizer has no memory of sessions already in the store: replay their raw
   * history in short slices, discarding the changes (already persisted). Runs inside the session's
   * work chain, before the event about to be applied is inserted, so replay never includes it.
   */
  private async hydrate(sessionId: string): Promise<void> {
    const normalizer = this.normalizer;
    if (normalizer.hasSession(sessionId) || this.store.getSession(sessionId) === null) return;
    const projectBySession = new Map<string, string>();
    let after = 0;
    let done = false;
    try {
      while (!done) {
        const start = performance.now();
        while (!done && performance.now() - start < HYDRATE_SLICE_MS) {
          const page = this.store.rawForSessionAfter(sessionId, after, HYDRATE_PAGE_ROWS);
          for (const ev of page) this.replayOne(ev, projectBySession);
          if (page.length < HYDRATE_PAGE_ROWS) done = true;
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

  private replayOne(ev: StoredRawEvent, projectBySession: Map<string, string>): Change[] {
    let projectId: string;
    if (ev.source === 'hook') {
      projectId = (ev.sessionId !== null ? projectBySession.get(ev.sessionId) : undefined) ?? UNKNOWN_PROJECT;
    } else {
      projectId = classifyPath(this.config.projectsDir, ev.file)?.projectId ?? UNKNOWN_PROJECT;
      projectBySession.set(ev.sessionId, projectId);
    }
    return this.normalizer.apply(ev, projectId).changes;
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
    if (!recent) this.drop(sessionId);
  }

  private commit(changes: Change[]): void {
    if (changes.length === 0) return;
    const fixed =
      this.deleted.size === 0
        ? changes
        : changes.map((c): Change =>
            c.type === 'session_upserted' && this.deleted.has(c.session.id) && !c.session.sourceDeleted
              ? { ...c, session: { ...c.session, sourceDeleted: true } }
              : c,
          );
    const applied = this.store.applyChanges(fixed);
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
   * Flags sessions whose recorded source file no longer exists (data is kept; the flag is sticky) and
   * clears the flag for sessions whose file is back, including flags left over from a previous run.
   */
  private markDeletedSources(): void {
    const changes: Change[] = [];
    const firstPass = !this.flagsChecked;
    this.flagsChecked = true;
    for (const file of this.sizeMap().keys()) {
      const cls = classifyPath(this.config.projectsDir, file);
      if (cls?.kind !== 'session') continue;
      if (fs.existsSync(file)) {
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
