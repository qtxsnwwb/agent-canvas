import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { ProjectIdResolver } from '../project-ids.js';
import type { PollRecord, PollSink, PollSource, PollStatus } from '../poll.js';
import { KEY_PREFIXES } from '../source.js';
import { openCursorDb, type CursorDbReader, type DbResult, type HeaderRow } from './db.js';
import { cursorCwd, cursorProjectId, workspaceStorageDir } from './project.js';
import { CURSOR_RECORD_TYPES } from './records.js';
import { bubbleFinished, bubbleIdsOf, bubbleRecord, isObject, subagentInfoOf, trimComposer } from './trim.js';

const PREFIX = KEY_PREFIXES.cursor;
export const DEFAULT_INTERVAL_MS = 3000;
/** A conversation that changed within this window is processed every round (spec 5.2 step 2). */
export const RECENT_MS = 10 * 60 * 1000;
/** The last this-many bubbles of a processed conversation are always re-read (spec 5.2 step 3). */
export const TAIL_BUBBLES = 20;
/** Records per ingestRecords call (a conversation's first import is split into batches of this size). */
const BATCH_RECORDS = 256;
/** Bubble lookups between two yields to the event loop. */
const READS_PER_YIELD = 256;

export interface PollTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: PollTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface CursorSourceOptions {
  /** Cursor's `state.vscdb`; its sibling `../workspaceStorage` gives working directories. */
  dbPath: string;
  /** Pause between the end of one round and the start of the next (default 3 s). */
  intervalMs?: number;
  /** Clock, ms since epoch (status times, the "recently active" rule). */
  now?: () => number;
  timers?: PollTimers;
  /** Project ids already in use (any origin), for reusing one that differs only in letter case. */
  knownProjectIds?: () => Iterable<string>;
  /** Opens the database (tests wrap it to observe reads). Default: openCursorDb, read-only. */
  openDb?: (dbPath: string) => DbResult<CursorDbReader>;
}

interface BubbleSeen {
  hash: string;
  finished: boolean;
}

/** What this run knows about one conversation (composer). */
interface ConvState {
  /** Header `lastUpdatedAt` at the last clean read; undefined forces the next round to process it. */
  lastUpdatedAt: number | null | undefined;
  /** Clock time a stored record of it last changed. */
  changedAt: number | null;
  composerHash: string | null;
  /** Bubbles stored by this run: hash of the stored line, finished then. */
  bubbles: Map<string, BubbleSeen>;
}

const hashOf = (line: string): string => createHash('sha1').update(line).digest('hex');
const errorOf = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));
const yieldNow = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const headerUpdatedAt = (h: HeaderRow): number | null => {
  const v = h.value?.lastUpdatedAt;
  return h.lastUpdatedAt ?? (typeof v === 'number' && Number.isFinite(v) ? v : null) ?? h.createdAt;
};
const isArchived = (h: HeaderRow): boolean => h.isArchived || h.value?.isArchived === true;
const isDraft = (h: HeaderRow): boolean => h.value?.isDraft === true;
const headerUnifiedMode = (h: HeaderRow): string | null => {
  const v = h.value?.unifiedMode;
  return typeof v === 'string' && v !== '' ? v : null;
};

/**
 * Polls Cursor's state database (spec 5): every round reads the `composerHeaders` table, picks the conversations to
 * process (unarchived, non-draft main conversations, and subagents whose root conversation is picked; only those that
 * changed or were recently active), reads their `composerData` and only the bubbles that need reading, and pushes the
 * trimmed records (composer first, then bubbles) through the sink under `cursor:<composerId>`. A conversation we hold
 * data for that is archived or gone is marked "source deleted" and not read again (until it is unarchived). Nothing is
 * remembered across restarts: the first round re-reads every picked conversation (the pipeline drops records it
 * already stored) and re-asserts the "source deleted" marks of stored sessions.
 */
export class CursorSource implements PollSource {
  readonly origin = 'cursor' as const;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly timers: PollTimers;
  private readonly openDb: (dbPath: string) => DbResult<CursorDbReader>;
  private readonly storageDir: string;
  private readonly projects: ProjectIdResolver;

  private sink: PollSink | null = null;
  private stopped = false;
  private timer: unknown = null;
  private chain: Promise<void> = Promise.resolve();
  private pokeQueued = false;
  private readonly pokes = new Set<string>();
  private firstRound = true;
  private lastPollAt: string | null = null;
  private lastError: string | null = null;

  private readonly conv = new Map<string, ConvState>();
  /** Subagent composer id -> its root conversation id (never changes). */
  private readonly rootOfSub = new Map<string, string>();
  /** Root conversation id -> project id (first resolution wins for this run). */
  private readonly projectOfRoot = new Map<string, string>();
  /** Sessions we hold data for: ingested by this run, or stored by any run (read on the first round). */
  private readonly held = new Set<string>();
  /** Sessions this run marked "source deleted". */
  private readonly marked = new Set<string>();

  constructor(private readonly options: CursorSourceOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? REAL_TIMERS;
    this.openDb = options.openDb ?? openCursorDb;
    this.storageDir = workspaceStorageDir(options.dbPath);
    this.projects = new ProjectIdResolver(options.knownProjectIds ?? (() => []));
  }

  start(sink: PollSink): void {
    if (this.sink !== null || this.stopped) return;
    this.sink = sink;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
    await this.chain;
  }

  poke(sessionId: string): void {
    if (this.sink === null || this.stopped) return;
    this.pokes.add(sessionId);
    if (this.pokeQueued) return;
    this.pokeQueued = true;
    void this.pollOnce();
  }

  status(): PollStatus {
    return { lastPollAt: this.lastPollAt, lastError: this.lastError };
  }

  /** Runs one round after any running one; a no-op before start and after stop. Never rejects. */
  pollOnce(): Promise<void> {
    const run = this.chain.then(() => this.round());
    this.chain = run;
    return run;
  }

  // ---------------------------------------------------------------- loop

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = this.timers.set(() => {
      this.timer = null;
      void this.pollOnce().then(() => this.schedule(this.intervalMs));
    }, delay);
  }

  private async round(): Promise<void> {
    this.pokeQueued = false;
    const sink = this.sink;
    if (sink === null || this.stopped) return;
    try {
      await this.roundWith(sink);
    } catch (err) {
      // Defensive: roundWith handles its own failures; anything left is a database-level error.
      this.lastError = errorOf(err).message;
    }
  }

  private async roundWith(sink: PollSink): Promise<void> {
    let exists = false;
    try {
      exists = fs.statSync(this.options.dbPath).isFile();
    } catch {
      exists = false;
    }
    if (!exists) {
      this.lastError = null; // Cursor is not installed: nothing to poll, nothing to report
      return;
    }
    const opened = this.openDb(this.options.dbPath);
    if (!opened.ok) {
      this.lastError = `cannot open Cursor database: ${opened.error.message}`;
      return;
    }
    const db = opened.value;
    try {
      const headers = db.headers();
      if (!headers.ok) {
        this.lastError = `cannot read Cursor conversations: ${headers.error.message}`;
        return;
      }
      await this.process(sink, db, headers.value);
      this.lastPollAt = new Date(this.now()).toISOString();
      this.lastError = null;
    } finally {
      db.close();
    }
  }

  // ---------------------------------------------------------------- one round

  private async process(sink: PollSink, db: CursorDbReader, headers: HeaderRow[]): Promise<void> {
    const first = this.firstRound;
    this.firstRound = false;
    if (first) {
      try {
        for (const id of sink.storedSessionIds()) this.held.add(id);
      } catch (err) {
        sink.reportFailure(`${PREFIX}poll`, err);
      }
    }
    const roots = headers.filter((h) => !h.isSubagent && !isArchived(h) && !isDraft(h));
    const selected = new Set(roots.map((h) => h.composerId));

    // Archived or gone: mark once, forget what this run read of it (and of its subagents).
    for (const id of this.held) {
      if (selected.has(id) || this.marked.has(id)) continue;
      await sink.markSourceDeleted(id);
      this.marked.add(id);
      this.forget(id);
    }
    // Back again (unarchived), or a stored session flagged by an earlier run that is picked now: clear the flag.
    for (const id of selected) {
      if (this.marked.has(id) || (first && this.held.has(id))) {
        await sink.clearSourceDeleted(id);
        this.marked.delete(id);
      }
    }

    const poked = new Set(this.pokes);
    this.pokes.clear();
    const byRecency = (a: HeaderRow, b: HeaderRow): number => (headerUpdatedAt(b) ?? 0) - (headerUpdatedAt(a) ?? 0);
    for (const h of [...roots].sort(byRecency)) {
      if (this.stopped) return;
      if (this.due(h, poked.has(h.composerId))) await this.read(sink, db, h, selected);
    }
    for (const h of headers.filter((x) => x.isSubagent).sort(byRecency)) {
      if (this.stopped) return;
      const root = this.rootOfSub.get(h.composerId);
      if (root !== undefined && !selected.has(root)) continue;
      if (this.due(h, root !== undefined && poked.has(root))) await this.read(sink, db, h, selected);
    }
  }

  /** Changed since the last clean read, recently active, poked, or never read by this run. */
  private due(h: HeaderRow, poked: boolean): boolean {
    const state = this.conv.get(h.composerId);
    if (state === undefined || state.lastUpdatedAt === undefined || poked) return true;
    const updated = headerUpdatedAt(h);
    if (updated !== state.lastUpdatedAt) return true;
    const recent = Math.max(updated ?? 0, state.changedAt ?? 0);
    return this.now() - recent < RECENT_MS;
  }

  private forget(rootId: string): void {
    this.conv.delete(rootId);
    for (const [sub, root] of this.rootOfSub) if (root === rootId) this.conv.delete(sub);
  }

  /** Reads one conversation and ingests what changed. Failures stay with this conversation (reportFailure). */
  private async read(sink: PollSink, db: CursorDbReader, h: HeaderRow, selected: ReadonlySet<string>): Promise<void> {
    const id = h.composerId;
    const key = PREFIX + id;
    const known = this.conv.get(id);
    const hadRead = known !== undefined && known.composerHash !== null;
    const state = known ?? { lastUpdatedAt: undefined, changedAt: null, composerHash: null, bubbles: new Map<string, BubbleSeen>() };
    try {
      const text = db.composerData(id);
      if (!text.ok) throw text.error;
      if (text.value === null) {
        // No composerData (seen for a few empty conversations): nothing to store; look again when it changes.
        state.lastUpdatedAt = headerUpdatedAt(h);
        this.conv.set(id, state);
        sink.clearFailure(key);
        return;
      }
      let data: unknown;
      try {
        data = JSON.parse(text.value);
      } catch {
        throw new Error('cursor: composerData is not JSON');
      }
      if (!isObject(data)) throw new Error('cursor: composerData is not a JSON object');

      // Which session (root conversation) and project this conversation belongs to.
      let sessionId: string;
      let agentId: string | null;
      let projectId: string;
      const cwd = cursorCwd(data, h.value, h.workspaceId, this.storageDir);
      if (h.isSubagent) {
        const root = this.rootOf(data);
        if (root === null) {
          // Not a transient read problem: report it, and look again only when the conversation changes.
          state.lastUpdatedAt = headerUpdatedAt(h);
          this.conv.set(id, state);
          sink.reportFailure(key, new Error('cursor: subagent without a root conversation id'));
          return;
        }
        this.rootOfSub.set(id, root);
        if (!selected.has(root)) return; // its root is not collected: neither is it
        const rootProject = this.projectOfRoot.get(root);
        if (rootProject === undefined) return; // root not read yet (failed this round): next round
        sessionId = root;
        agentId = id;
        projectId = rootProject;
      } else {
        sessionId = id;
        agentId = null;
        projectId = this.projectOfRoot.get(id) ?? cursorProjectId(this.projects, cwd, h.workspaceId);
        this.projectOfRoot.set(id, projectId);
      }

      const composerLine = trimComposer(data, {
        composerId: id,
        workspaceId: h.workspaceId,
        headerCreatedAt: h.createdAt,
        headerLastUpdatedAt: h.lastUpdatedAt,
        headerUnifiedMode: headerUnifiedMode(h),
        cwd,
      });
      const composerHash = hashOf(composerLine);

      // Bubbles to read: unseen, unfinished when last seen, and the tail.
      const ids = bubbleIdsOf(data);
      const tail = new Set(ids.slice(-TAIL_BUBBLES));
      const pending: { record: PollRecord; bubbleId: string | null; seen: BubbleSeen | null }[] = [];
      if (composerHash !== state.composerHash) pending.push({ record: { recordType: CURSOR_RECORD_TYPES.composer, line: composerLine }, bubbleId: null, seen: null });
      const unreadable: string[] = [];
      let reads = 0;
      for (const bubbleId of ids) {
        const before = state.bubbles.get(bubbleId);
        if (before !== undefined && before.finished && !tail.has(bubbleId)) continue;
        if (++reads % READS_PER_YIELD === 0) await yieldNow();
        const raw = db.bubble(id, bubbleId);
        if (!raw.ok) throw raw.error;
        if (raw.value === null) continue; // listed but not written yet: read again next time
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.value);
        } catch {
          unreadable.push(bubbleId);
          continue;
        }
        if (!isObject(parsed)) {
          unreadable.push(bubbleId);
          continue;
        }
        const record = bubbleRecord(parsed, bubbleId);
        const line = JSON.stringify(record);
        const seen = { hash: hashOf(line), finished: bubbleFinished(record) };
        if (before !== undefined && before.hash === seen.hash) {
          before.finished = seen.finished;
          continue;
        }
        pending.push({ record: { recordType: CURSOR_RECORD_TYPES.bubble, line }, bubbleId, seen });
      }

      for (let i = 0; i < pending.length; i += BATCH_RECORDS) {
        const chunk = pending.slice(i, i + BATCH_RECORDS);
        await sink.ingestRecords({ key, projectId, sessionId, agentId, records: chunk.map((p) => p.record) });
        // Remembered only once stored (a rejected batch committed nothing).
        for (const p of chunk) {
          if (p.bubbleId === null) state.composerHash = composerHash;
          else state.bubbles.set(p.bubbleId, p.seen!);
        }
        this.held.add(sessionId);
        this.conv.set(id, state);
      }
      // A change seen after this run had already read the conversation is activity (the first read is not).
      if (pending.length > 0 && hadRead) state.changedAt = this.now();
      if (state.composerHash !== null) this.held.add(sessionId);
      state.lastUpdatedAt = unreadable.length === 0 ? headerUpdatedAt(h) : undefined;
      this.conv.set(id, state);
      if (unreadable.length > 0) {
        sink.reportFailure(key, new Error(`cursor: ${unreadable.length} bubble(s) not readable JSON (first: ${unreadable[0]})`));
      } else {
        sink.clearFailure(key);
      }
    } catch (err) {
      state.lastUpdatedAt = undefined;
      this.conv.set(id, state);
      sink.reportFailure(key, err);
    }
  }

  /** The root conversation of a subagent: `rootParentConversationId`, else its parent's root (or the parent). */
  private rootOf(data: unknown): string | null {
    const info = subagentInfoOf(data);
    if (info === null) return null;
    if (info.rootParentConversationId !== null) return info.rootParentConversationId;
    const parent = info.parentComposerId;
    return parent === null ? null : (this.rootOfSub.get(parent) ?? parent);
  }
}
