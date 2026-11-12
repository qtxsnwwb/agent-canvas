import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { ProjectIdResolver } from '../project-ids.js';
import type { PollRecord, PollSink, PollSource, PollStatus } from '../poll.js';
import { KEY_PREFIXES } from '../source.js';
import { isDatabaseLevelError, openCursorDb, type CursorDbReader, type DbResult, type HeaderRow } from './db.js';
import { cursorCwd, cursorProjectId, workspaceStorageDir } from './project.js';
import { CURSOR_RECORD_TYPES } from './records.js';
import { bubbleEntriesOf, bubbleFinished, bubbleRecord, isObject, subagentInfoOf, trimComposer } from './trim.js';

const PREFIX = KEY_PREFIXES.cursor;
export const DEFAULT_INTERVAL_MS = 3000;
/** A conversation that changed within this window is processed every round (spec 5.2 step 2). */
export const RECENT_MS = 10 * 60 * 1000;
/** The last this-many bubbles of a processed conversation are always re-read (spec 5.2 step 3). */
export const TAIL_BUBBLES = 20;
/** Records per ingestRecords call (a conversation's first import is split into batches of this size). */
const BATCH_RECORDS = 256;
/** Wall time a round may run before it yields to the event loop (checked per lookup, conversation and batch). */
const YIELD_BUDGET_MS = 10;
/** Consecutive failed KV lookups after which the round is abandoned whatever the error. */
export const MAX_FAILED_LOOKUPS = 3;

/** A database-level failure during a round: the round ends with lastError; no conversation is blamed. */
class RoundAbort extends Error {
  constructor(readonly cause: Error) {
    super(cause.message);
  }
}

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
  /** Hash of the line last stored for it. */
  hash: string;
  finished: boolean;
  /** Its index in the list when that line was stored. */
  order: number;
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
  private failedLookups = 0;
  private lastYield = 0;

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

  /** Yields to the event loop once this round has run for YIELD_BUDGET_MS of wall time since the last yield. */
  private async breathe(force = false): Promise<void> {
    if (!force && performance.now() - this.lastYield < YIELD_BUDGET_MS) return;
    await yieldNow();
    this.lastYield = performance.now();
  }

  /**
   * One KV lookup. A failure counts towards MAX_FAILED_LOOKUPS consecutive ones; a database-level failure, or reaching
   * that count, ends the round (RoundAbort). Other failures throw for the conversation being read.
   */
  private lookup<T>(result: DbResult<T>): T {
    if (result.ok) {
      this.failedLookups = 0;
      return result.value;
    }
    this.failedLookups += 1;
    if (isDatabaseLevelError(result.error) || this.failedLookups >= MAX_FAILED_LOOKUPS) throw new RoundAbort(result.error);
    throw result.error;
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
      this.failedLookups = 0;
      this.lastYield = performance.now();
      let completed: boolean;
      try {
        completed = await this.process(sink, db, headers.value);
      } catch (err) {
        if (!(err instanceof RoundAbort)) throw err;
        this.lastError = `Cursor database unavailable, round abandoned: ${err.cause.message}`;
        return;
      }
      if (!completed) return; // cut short by stop(): not a completed poll
      this.lastPollAt = new Date(this.now()).toISOString();
      this.lastError = null;
    } finally {
      db.close();
    }
  }

  // ---------------------------------------------------------------- one round

  /** One round over the read headers. False when stop() cut it short. Throws RoundAbort on a database-level failure. */
  private async process(sink: PollSink, db: CursorDbReader, headers: HeaderRow[]): Promise<boolean> {
    // Stored sessions of earlier runs, loaded once; retried next round when the sink fails.
    let first = false;
    if (this.firstRound) {
      try {
        for (const id of sink.storedSessionIds()) this.held.add(id);
        this.firstRound = false;
        first = true;
      } catch (err) {
        sink.reportFailure(`${PREFIX}poll`, err);
      }
    }
    const roots = headers.filter((h) => !h.isSubagent && !isArchived(h) && !isDraft(h));
    const selected = new Set(roots.map((h) => h.composerId));

    // An empty header table while we hold sessions is "nothing known this round" (a database being recreated), not
    // "everything was deleted".
    if (headers.length > 0) {
      // Archived or gone: mark once, forget what this run read of it (and of its subagents).
      for (const id of this.held) {
        if (selected.has(id) || this.marked.has(id)) continue;
        try {
          await sink.markSourceDeleted(id);
          this.marked.add(id);
          this.forget(id);
        } catch (err) {
          sink.reportFailure(PREFIX + id, err); // not marked: tried again next round
        }
      }
    }
    // Back again (unarchived), or a stored session flagged by an earlier run that is picked now: clear the flag.
    for (const id of selected) {
      if (this.marked.has(id) || (first && this.held.has(id))) {
        try {
          await sink.clearSourceDeleted(id);
          this.marked.delete(id);
        } catch (err) {
          sink.reportFailure(PREFIX + id, err); // still marked: tried again next round
        }
      }
    }

    const poked = new Set(this.pokes);
    this.pokes.clear();
    const byRecency = (a: HeaderRow, b: HeaderRow): number => (headerUpdatedAt(b) ?? 0) - (headerUpdatedAt(a) ?? 0);
    for (const h of [...roots].sort(byRecency)) {
      if (this.stopped) return false;
      if (!this.due(h, poked.has(h.composerId))) continue;
      await this.breathe(true);
      if (this.stopped) return false;
      await this.read(sink, db, h, selected);
    }
    const subagentIds = new Set(headers.filter((x) => x.isSubagent).map((x) => x.composerId));
    let todo = headers.filter((x) => x.isSubagent).sort(byRecency);
    // A nested subagent read before its parent's root is known waits; the pass repeats while that unblocks some.
    for (;;) {
      const waiting: HeaderRow[] = [];
      for (const h of todo) {
        if (this.stopped) return false;
        const root = this.rootOfSub.get(h.composerId);
        if (root !== undefined && !selected.has(root)) continue;
        if (!this.due(h, root !== undefined && poked.has(root))) continue;
        await this.breathe(true);
        if (this.stopped) return false;
        if ((await this.read(sink, db, h, selected, subagentIds)) === 'waiting') waiting.push(h);
      }
      if (waiting.length === 0 || waiting.length === todo.length) break;
      todo = waiting;
    }
    return true;
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
  private async read(
    sink: PollSink,
    db: CursorDbReader,
    h: HeaderRow,
    selected: ReadonlySet<string>,
    subagentIds: ReadonlySet<string> = new Set(),
  ): Promise<'waiting' | void> {
    const id = h.composerId;
    const key = PREFIX + id;
    const known = this.conv.get(id);
    const hadRead = known !== undefined && known.composerHash !== null;
    const state = known ?? { lastUpdatedAt: undefined, changedAt: null, composerHash: null, bubbles: new Map<string, BubbleSeen>() };
    try {
      const text = { value: this.lookup(db.composerData(id)) };
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
        const root = this.rootOf(data, subagentIds);
        if (root === undefined) return 'waiting'; // parent is a subagent whose root is not known yet: nothing cached
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

      const composerLine = trimComposer(data, { composerId: id, headerCreatedAt: h.createdAt, headerUnifiedMode: headerUnifiedMode(h), cwd });
      const composerHash = hashOf(composerLine);

      // Bubbles to read: unseen, unfinished when last seen, moved to another index since last stored, and the tail.
      // A bubble that dropped out of the list is not read and gets no record (its last one stands).
      const entries = bubbleEntriesOf(data);
      const tail = new Set(entries.slice(-TAIL_BUBBLES).map((e) => e.bubbleId));
      const pending: { record: PollRecord; bubbleId: string | null; seen: BubbleSeen | null }[] = [];
      if (composerHash !== state.composerHash) pending.push({ record: { recordType: CURSOR_RECORD_TYPES.composer, line: composerLine }, bubbleId: null, seen: null });
      const unreadable: string[] = [];
      for (const { bubbleId, order } of entries) {
        const before = state.bubbles.get(bubbleId);
        if (before !== undefined && before.finished && before.order === order && !tail.has(bubbleId)) continue;
        await this.breathe();
        const raw = { value: this.lookup(db.bubble(id, bubbleId)) };
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
        const record = bubbleRecord(parsed, bubbleId, order);
        const line = JSON.stringify(record);
        const seen = { hash: hashOf(line), finished: bubbleFinished(record), order };
        if (before !== undefined && before.hash === seen.hash) {
          before.finished = seen.finished;
          continue;
        }
        pending.push({ record: { recordType: CURSOR_RECORD_TYPES.bubble, line }, bubbleId, seen });
      }

      for (let i = 0; i < pending.length; i += BATCH_RECORDS) {
        if (i > 0) await this.breathe(true);
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
      if (err instanceof RoundAbort) throw err; // the database, not this conversation: no per-conversation failure
      sink.reportFailure(key, err);
    }
  }

  /**
   * The root conversation of a subagent: `rootParentConversationId`; else, when the parent is a main conversation,
   * the parent; when the parent is a subagent, its root once known (undefined until then: never guessed or cached).
   * Null when there is no usable id at all.
   */
  private rootOf(data: unknown, subagentIds: ReadonlySet<string>): string | null | undefined {
    const info = subagentInfoOf(data);
    if (info === null) return null;
    if (info.rootParentConversationId !== null) return info.rootParentConversationId;
    const parent = info.parentComposerId;
    if (parent === null) return null;
    const known = this.rootOfSub.get(parent);
    if (known !== undefined) return known;
    return subagentIds.has(parent) ? undefined : parent;
  }
}
