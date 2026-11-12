import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { ProjectIdResolver } from '../project-ids.js';
import type { PollRecord, PollSink, PollSource, PollStatus } from '../poll.js';
import { KEY_PREFIXES } from '../source.js';
import { isDatabaseLevelError, openCursorDb, type CursorDbReader, type DbResult, type HeaderRow } from './db.js';
import { cursorCwd, cursorProjectId, workspaceStorageDir } from './project.js';
import { CURSOR_RECORD_TYPES } from './records.js';
import {
  bubbleFinished,
  bubbleRecord,
  entriesOfList,
  inlineHeaders,
  isObject,
  subagentComposerIdsOf,
  subagentInfoOf,
  trimComposer,
} from './trim.js';

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
/**
 * Subagent conversations no session reaches through `subagentComposerIds` are looked up (composerData only, to learn
 * their `parentComposerId` / `rootParentConversationId`) at most this many per round, each once per run (again only
 * when it had no composerData and its header changed).
 */
export const ORPHAN_PROBES_PER_ROUND = 16;

/** Store key of a conversation's records: `cursor:<sessionId>` (main) or `cursor:<sessionId>/<subagentComposerId>`. */
export const cursorKey = (sessionId: string, agentId: string | null): string =>
  agentId === null ? `${PREFIX}${sessionId}` : `${PREFIX}${sessionId}/${agentId}`;

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

/**
 * The bubbles a unit's last complete read covered, as saved for a restart (SavedUnit): the first `n` header entries,
 * which had then the fingerprint `list`, and of which those in `unfinished` were not finished (or not written yet).
 * While the header's first `n` entries keep that fingerprint, an entry among them that this run has not read and that
 * was finished then is not read again (except in the tail).
 */
interface Baseline {
  n: number;
  list: string;
  unfinished: Set<string>;
}

/** What this run knows about one stored unit: a conversation as stored for one session (one store key). */
interface UnitState {
  /** Header `lastUpdatedAt` at the last clean read; undefined forces the next round to process it. */
  lastUpdatedAt: number | null | undefined;
  /** Clock time a stored record of it last changed. */
  changedAt: number | null;
  composerHash: string | null;
  /** Bubbles stored by this run under this key: hash of the stored line, finished then, index then. */
  bubbles: Map<string, BubbleSeen>;
  /** Restored from the note an earlier run saved (null: everything not in `bubbles` is read). */
  baseline: Baseline | null;
  /** Restored from a note and not read by this run yet (its first read is not activity). */
  restored: boolean;
}

/**
 * The note saved (PollSink.saveUnitState) for a unit after a complete read whose records are all stored: the header's
 * `lastUpdatedAt` then (`u`), the stored composer line's hash (`h`), the header entries then (`n`, fingerprint `l`) and
 * which of them were unfinished (`f`), the session's project (`p`), the conversation's `subagentComposerIds` (`k`) and,
 * for a subagent, its `parentComposerId` / `rootParentConversationId` (`par`, `root`). On start, a unit whose header
 * still shows `u` is taken as read (it is not due), so an unchanged database is not read again. A unit whose header
 * changed is due, and reads what a unit read earlier in the same run would read (Baseline): new entries, the tail and
 * the unfinished ones, all of it when its list changed before the end. Without a note (never read completely, e.g. an
 * import cut short) or with one that does not parse, a unit is read in full.
 */
interface SavedUnit {
  v: 1;
  u: number | null;
  h: string;
  n: number;
  l: string;
  f: string[];
  p: string;
  k: string[];
  par: string | null;
  root: string | null;
}

function parseSaved(text: string): SavedUnit | null {
  try {
    const v = JSON.parse(text) as Partial<SavedUnit>;
    const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((y) => typeof y === 'string');
    if (
      v?.v !== 1 ||
      !(v.u === null || typeof v.u === 'number') ||
      typeof v.h !== 'string' ||
      typeof v.n !== 'number' ||
      typeof v.l !== 'string' ||
      !strings(v.f) ||
      typeof v.p !== 'string' ||
      !strings(v.k) ||
      !(v.par === null || typeof v.par === 'string') ||
      !(v.root === null || typeof v.root === 'string')
    ) {
      return null;
    }
    return v as SavedUnit;
  } catch {
    return null;
  }
}

/** Fingerprint of header entries (ids and indexes, in order). */
const listHash = (entries: readonly { bubbleId: string; order: number }[]): string => {
  const h = createHash('sha1');
  for (const e of entries) h.update(`${e.bubbleId}:${e.order}\n`);
  return h.digest('hex');
};

/** A conversation's composerData as read this round (shared by every session that owns it). */
interface Loaded {
  data: Record<string, unknown>;
  /** The header entries (inline, else the pages), read on first use. */
  entries: { bubbleId: string; order: number }[] | null;
}

/** What a subagent's composerData says about where it hangs. */
interface Probe {
  /** Header lastUpdatedAt when read. */
  updatedAt: number | null;
  /** False when it had no composerData then (looked at again once its header changes). */
  hasData: boolean;
  parent: string | null;
  root: string | null;
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
const byRecency = (a: HeaderRow, b: HeaderRow): number => (headerUpdatedAt(b) ?? 0) - (headerUpdatedAt(a) ?? 0);

/**
 * Polls Cursor's state database (spec 5). Every round reads the `composerHeaders` table and picks the sessions:
 * unarchived, non-draft main conversations. A session's subagent conversations are those reached from its main
 * conversation through `subagentComposerIds` (transitively, through the subagents' own lists) or through a subagent's
 * `parentComposerId`; `rootParentConversationId` only places a subagent that has neither link. One subagent
 * conversation can belong to several sessions (forked conversations list the same subagents): it is stored once per
 * owning session, under `cursor:<sessionId>/<subagentComposerId>`; a main conversation under `cursor:<sessionId>` (its
 * composer id).
 * Only units that changed or were recently active are read, and of those only the bubbles that need reading; the
 * trimmed records (composer first, then bubbles) go through the sink. A conversation with no bubble yet produces
 * nothing. A session we hold data for that is archived or gone is marked "source deleted" and not read again (until it
 * is unarchived). Across restarts only a note per completely read unit is kept (SavedUnit): the first round reads
 * only units whose header changed since (or that were never read completely), and re-asserts the "source deleted"
 * marks of stored sessions.
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

  /** Store key -> what this run stored under it. */
  private readonly units = new Map<string, UnitState>();
  /** Composer id -> its `subagentComposerIds` at its last read. */
  private readonly children = new Map<string, string[]>();
  /** Subagent composer id -> its links, from its last composerData read. */
  private readonly probes = new Map<string, Probe>();
  /** Composer id -> its header pages as last read (text and parsed), so unchanged pages are not parsed again. */
  private readonly pageCache = new Map<string, { texts: string[]; parsed: unknown[][] }>();
  /** This round's composerData reads (or their failure), shared by every session owning the conversation. */
  private loaded = new Map<string, Loaded | null | Error>();
  /** Session (main conversation) id -> project id (first resolution wins for this run). */
  private readonly projectOfRoot = new Map<string, string>();
  /** Sessions we hold data for: ingested by this run, or stored by any run (read once, on the first good round). */
  private readonly held = new Set<string>();
  /** Sessions this run marked "source deleted". */
  private readonly marked = new Set<string>();
  /** Store key -> the note saved for it (as saved, by this or an earlier run). */
  private readonly saved = new Map<string, string>();

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
    } finally {
      this.loaded = new Map();
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
        this.restoreNotes(sink);
        this.firstRound = false;
        first = true;
      } catch (err) {
        sink.reportFailure(`${PREFIX}poll`, err);
      }
    }
    const byId = new Map(headers.map((h) => [h.composerId, h]));
    const roots = headers.filter((h) => !h.isSubagent && !isArchived(h) && !isDraft(h)).sort(byRecency);
    const selected = new Set(roots.map((h) => h.composerId));

    // An empty header table while we hold sessions is "nothing known this round" (a database being recreated), not
    // "everything was deleted". Only sessions are marked: a subagent conversation that disappears marks nothing.
    if (headers.length > 0) {
      for (const id of this.held) {
        if (selected.has(id) || this.marked.has(id)) continue;
        try {
          await sink.markSourceDeleted(id);
          this.marked.add(id);
          this.forget(sink, id);
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
    // A poked subagent conversation (a hook of it before its records were stored) pokes every session owning it.
    if (poked.size > 0) {
      for (const [sessionId, subs] of this.reach(selected, byId)) if (subs.some((id) => poked.has(id))) poked.add(sessionId);
    }

    // 1. Main conversations.
    for (const h of roots) {
      if (this.stopped) return false;
      if (!this.due(cursorKey(h.composerId, null), h, poked.has(h.composerId))) continue;
      await this.breathe(true);
      if (this.stopped) return false;
      await this.readUnit(sink, db, h, h.composerId, null);
    }

    // 2. A few subagents no session reaches yet: learn their parent / root links.
    const reached = new Set([...this.reach(selected, byId).values()].flat());
    const orphans = headers
      .filter((h) => h.isSubagent && !reached.has(h.composerId) && this.needsProbe(h))
      .sort(byRecency)
      .slice(0, ORPHAN_PROBES_PER_ROUND);
    for (const h of orphans) {
      if (this.stopped) return false;
      await this.breathe();
      this.probe(db, h);
    }

    // 3. Subagent units of each session whose main conversation is stored; repeated while reading reveals more
    //    (a subagent's own subagentComposerIds).
    const considered = new Set<string>();
    for (;;) {
      let more = false;
      const reach = this.reach(selected, byId);
      for (const root of roots) {
        const sessionId = root.composerId;
        if (this.units.get(cursorKey(sessionId, null))?.composerHash == null) continue; // no session yet
        for (const subId of reach.get(sessionId) ?? []) {
          const key = cursorKey(sessionId, subId);
          if (considered.has(key)) continue;
          considered.add(key);
          more = true;
          const h = byId.get(subId)!;
          if (this.stopped) return false;
          if (!this.due(key, h, poked.has(sessionId))) continue;
          await this.breathe(true);
          if (this.stopped) return false;
          await this.readUnit(sink, db, h, sessionId, subId);
        }
      }
      if (!more) break;
    }
    return true;
  }

  /**
   * Session id -> the subagent conversations it owns, in walk order: from the main conversation along
   * `subagentComposerIds` and along subagents' `parentComposerId` (both transitively), plus, for the main conversation,
   * subagents with neither link whose `rootParentConversationId` names it. Only ids with a subagent header row count.
   */
  private reach(selected: ReadonlySet<string>, byId: ReadonlyMap<string, HeaderRow>): Map<string, string[]> {
    const byParent = new Map<string, string[]>();
    const listed = new Set<string>();
    for (const ids of this.children.values()) for (const id of ids) listed.add(id);
    const byRoot = new Map<string, string[]>();
    for (const [id, p] of this.probes) {
      if (p.parent !== null) {
        const list = byParent.get(p.parent) ?? [];
        list.push(id);
        byParent.set(p.parent, list);
      } else if (p.root !== null && !listed.has(id)) {
        const list = byRoot.get(p.root) ?? [];
        list.push(id);
        byRoot.set(p.root, list);
      }
    }
    const out = new Map<string, string[]>();
    for (const sessionId of selected) {
      const owned: string[] = [];
      const seen = new Set<string>([sessionId]);
      const queue = [sessionId];
      while (queue.length > 0) {
        const x = queue.shift()!;
        const next = [...(this.children.get(x) ?? []), ...(byParent.get(x) ?? []), ...(x === sessionId ? (byRoot.get(x) ?? []) : [])];
        for (const id of next) {
          if (seen.has(id)) continue;
          seen.add(id);
          if (byId.get(id)?.isSubagent !== true) continue;
          owned.push(id);
          queue.push(id);
        }
      }
      out.set(sessionId, owned);
    }
    return out;
  }

  private needsProbe(h: HeaderRow): boolean {
    const p = this.probes.get(h.composerId);
    return p === undefined || (!p.hasData && p.updatedAt !== headerUpdatedAt(h));
  }

  /** Reads an unreached subagent's composerData for its links only. Its own problems are not reported. */
  private probe(db: CursorDbReader, h: HeaderRow): void {
    try {
      this.noteProbe(h, this.load(db, h.composerId));
    } catch (err) {
      if (err instanceof RoundAbort) throw err;
      this.probes.set(h.composerId, { updatedAt: headerUpdatedAt(h), hasData: false, parent: null, root: null });
    }
  }

  private noteProbe(h: HeaderRow, loaded: Loaded | null): void {
    const info = loaded === null ? null : subagentInfoOf(loaded.data);
    this.probes.set(h.composerId, {
      updatedAt: headerUpdatedAt(h),
      hasData: loaded !== null,
      parent: info?.parentComposerId ?? null,
      root: info?.rootParentConversationId ?? null,
    });
  }

  /**
   * The notes earlier runs saved: the links they recorded (subagent lists, a subagent's parent / root) are taken as
   * known; a unit's own state is restored by `due` when its header still shows the note's `lastUpdatedAt`.
   */
  private restoreNotes(sink: PollSink): void {
    this.saved.clear();
    for (const [key, text] of sink.loadUnitStates()) {
      const note = parseSaved(text);
      if (note === null) continue;
      this.saved.set(key, text);
      const rest = key.slice(PREFIX.length);
      const slash = rest.indexOf('/');
      const composerId = slash === -1 ? rest : rest.slice(slash + 1);
      if (!this.children.has(composerId)) this.children.set(composerId, note.k);
      if (slash !== -1 && !this.probes.has(composerId)) {
        this.probes.set(composerId, { updatedAt: note.u, hasData: true, parent: note.par, root: note.root });
      }
    }
  }

  /**
   * A unit this run has no state for but a saved note: its state as the note describes it, read already when its header
   * still shows the note's `lastUpdatedAt`, due otherwise (with the note's bubbles as its baseline).
   */
  private restoreUnit(key: string, h: HeaderRow): void {
    if (this.units.has(key)) return;
    const text = this.saved.get(key);
    const note = text === undefined ? null : parseSaved(text);
    if (note === null) return;
    this.units.set(key, {
      lastUpdatedAt: note.u === headerUpdatedAt(h) ? note.u : undefined,
      changedAt: null,
      composerHash: note.h,
      bubbles: new Map(),
      baseline: { n: note.n, list: note.l, unfinished: new Set(note.f) },
      restored: true,
    });
    if (h.isSubagent) return;
    const sessionId = key.slice(PREFIX.length);
    if (!this.projectOfRoot.has(sessionId)) this.projectOfRoot.set(sessionId, note.p);
  }

  /** Changed since the last clean read, recently active, poked, or never read by this run. */
  private due(key: string, h: HeaderRow, poked: boolean): boolean {
    this.restoreUnit(key, h);
    const state = this.units.get(key);
    if (state === undefined || state.lastUpdatedAt === undefined || poked) return true;
    const updated = headerUpdatedAt(h);
    if (updated !== state.lastUpdatedAt) return true;
    const recent = Math.max(updated ?? 0, state.changedAt ?? 0);
    return this.now() - recent < RECENT_MS;
  }

  /**
   * Forgets what this run stored for a session (its main conversation and its subagent units), and the notes saved for
   * them: unarchived, it is read in full again.
   */
  private forget(sink: PollSink, sessionId: string): void {
    const main = cursorKey(sessionId, null);
    const mine = (key: string): boolean => key === main || key.startsWith(`${main}/`);
    for (const key of [...this.units.keys()]) if (mine(key)) this.units.delete(key);
    for (const key of [...this.saved.keys()]) {
      if (!mine(key)) continue;
      try {
        sink.saveUnitState(key, null);
        this.saved.delete(key);
      } catch (err) {
        sink.reportFailure(key, err); // the note stays: a stale note only means its header is compared again
      }
    }
  }

  /**
   * A conversation's composerData, read once per round (null when absent). Records its `subagentComposerIds`. Throws
   * for a conversation whose composerData does not parse (the failure is shared by every owner this round).
   */
  private load(db: CursorDbReader, composerId: string): Loaded | null {
    const cached = this.loaded.get(composerId);
    if (cached instanceof Error) throw cached;
    if (cached !== undefined) return cached;
    try {
      const text = this.lookup(db.composerData(composerId));
      let result: Loaded | null = null;
      if (text !== null) {
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error('cursor: composerData is not JSON');
        }
        if (!isObject(data)) throw new Error('cursor: composerData is not a JSON object');
        result = { data, entries: null };
        this.children.set(composerId, subagentComposerIdsOf(data));
      }
      this.loaded.set(composerId, result);
      return result;
    } catch (err) {
      if (!(err instanceof RoundAbort)) this.loaded.set(composerId, errorOf(err));
      throw err;
    }
  }

  /**
   * The ordered header entries: the inline list when it is non-empty, otherwise the concatenated pages
   * `composerConvHeaders:<id>:<NNNNNN>` (one range query; a page whose text did not change is not parsed again).
   */
  private entries(db: CursorDbReader, composerId: string, loaded: Loaded): { bubbleId: string; order: number }[] {
    if (loaded.entries !== null) return loaded.entries;
    const inline = inlineHeaders(loaded.data);
    let list: unknown[] = inline;
    if (inline.length === 0) {
      const texts = this.lookup(db.headerPages(composerId));
      const before = this.pageCache.get(composerId);
      const parsed: unknown[][] = texts.map((text, i) => {
        if (before !== undefined && before.texts[i] === text) return before.parsed[i]!;
        let page: unknown;
        try {
          page = JSON.parse(text);
        } catch {
          throw new Error(`cursor: header page ${i} is not JSON`);
        }
        if (!Array.isArray(page)) throw new Error(`cursor: header page ${i} is not a JSON array`);
        return page;
      });
      if (texts.length > 0) this.pageCache.set(composerId, { texts, parsed });
      else this.pageCache.delete(composerId);
      list = parsed.flat();
    }
    loaded.entries = entriesOfList(list);
    return loaded.entries;
  }

  /**
   * Saves the unit's note (SavedUnit) after a complete read whose records are all stored, when it differs from the one
   * saved. A failure to save is reported under the key; the unit is then simply read in full after a restart.
   */
  private saveNote(sink: PollSink, key: string, h: HeaderRow, entries: { bubbleId: string; order: number }[], state: UnitState, projectId: string): void {
    const baseline = state.baseline;
    const unfinished: string[] = [];
    entries.forEach(({ bubbleId }, pos) => {
      const seen = state.bubbles.get(bubbleId);
      const finished = seen !== undefined ? seen.finished : baseline !== null && pos < baseline.n && !baseline.unfinished.has(bubbleId);
      if (!finished) unfinished.push(bubbleId);
    });
    const probe = h.isSubagent ? this.probes.get(h.composerId) : undefined;
    const note: SavedUnit = {
      v: 1,
      u: headerUpdatedAt(h),
      h: state.composerHash!,
      n: entries.length,
      l: listHash(entries),
      f: unfinished,
      p: projectId,
      k: this.children.get(h.composerId) ?? [],
      par: probe?.parent ?? null,
      root: probe?.root ?? null,
    };
    const text = JSON.stringify(note);
    if (this.saved.get(key) === text) return;
    try {
      sink.saveUnitState(key, text);
      this.saved.set(key, text);
    } catch (err) {
      sink.reportFailure(key, err);
    }
  }

  /**
   * Reads one unit — conversation `h` as stored for session `sessionId` (`agentId` null for the main conversation, its
   * composer id for a subagent) — and ingests what changed. Failures stay with the unit (reportFailure under its key).
   */
  private async readUnit(sink: PollSink, db: CursorDbReader, h: HeaderRow, sessionId: string, agentId: string | null): Promise<void> {
    const composerId = h.composerId;
    const key = cursorKey(sessionId, agentId);
    const known = this.units.get(key);
    const hadRead = known !== undefined && known.composerHash !== null && !known.restored;
    const state: UnitState = known ?? { lastUpdatedAt: undefined, changedAt: null, composerHash: null, bubbles: new Map<string, BubbleSeen>(), baseline: null, restored: false };
    state.restored = false;
    try {
      const loaded = this.load(db, composerId);
      if (h.isSubagent) this.noteProbe(h, loaded);
      const entries = loaded === null ? [] : this.entries(db, composerId, loaded);
      if (loaded === null || entries.length === 0) {
        // No composerData (a few listed rows) or no bubble yet: nothing to store, no session; look again on a change.
        state.lastUpdatedAt = headerUpdatedAt(h);
        this.units.set(key, state);
        sink.clearFailure(key);
        return;
      }
      const data = loaded.data;
      const cwd = cursorCwd(data, h.value, h.workspaceId, this.storageDir);
      let projectId: string;
      if (agentId === null) {
        projectId = this.projectOfRoot.get(sessionId) ?? cursorProjectId(this.projects, cwd, h.workspaceId);
        this.projectOfRoot.set(sessionId, projectId);
      } else {
        const rootProject = this.projectOfRoot.get(sessionId);
        if (rootProject === undefined) return; // the session's main conversation is not stored yet: next round
        projectId = rootProject;
      }

      const composerLine = trimComposer(data, { composerId, headerCreatedAt: h.createdAt, headerUnifiedMode: headerUnifiedMode(h), cwd });
      const composerHash = hashOf(composerLine);

      // Bubbles to read: unseen, unfinished when last seen, moved to another index since last stored, and the tail.
      // A bubble that dropped out of the list is not read and gets no record (its last one stands). With a baseline
      // (a restored note), "seen" also covers the finished entries of the note's unchanged list prefix.
      const tail = new Set(entries.slice(-TAIL_BUBBLES).map((e) => e.bubbleId));
      if (state.baseline !== null && (entries.length < state.baseline.n || listHash(entries.slice(0, state.baseline.n)) !== state.baseline.list)) {
        state.baseline = null;
      }
      const baseline = state.baseline;
      const pending: { record: PollRecord; bubbleId: string | null; seen: BubbleSeen | null }[] = [];
      if (composerHash !== state.composerHash) pending.push({ record: { recordType: CURSOR_RECORD_TYPES.composer, line: composerLine }, bubbleId: null, seen: null });
      const unreadable: string[] = [];
      for (let pos = 0; pos < entries.length; pos++) {
        const { bubbleId, order } = entries[pos]!;
        const before = state.bubbles.get(bubbleId);
        if (before !== undefined && before.finished && before.order === order && !tail.has(bubbleId)) continue;
        if (before === undefined && baseline !== null && pos < baseline.n && !baseline.unfinished.has(bubbleId) && !tail.has(bubbleId)) continue;
        await this.breathe();
        const text = this.lookup(db.bubble(composerId, bubbleId));
        if (text === null) continue; // listed but not written yet: read again next time
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
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
        this.units.set(key, state);
      }
      // A change seen after this run had already read the unit is activity (the first read is not).
      if (pending.length > 0 && hadRead) state.changedAt = this.now();
      if (state.composerHash !== null) this.held.add(sessionId);
      state.lastUpdatedAt = unreadable.length === 0 ? headerUpdatedAt(h) : undefined;
      this.units.set(key, state);
      if (unreadable.length > 0) {
        sink.reportFailure(key, new Error(`cursor: ${unreadable.length} bubble(s) not readable JSON (first: ${unreadable[0]})`));
      } else {
        sink.clearFailure(key);
        if (state.composerHash !== null) this.saveNote(sink, key, h, entries, state, projectId);
      }
    } catch (err) {
      state.lastUpdatedAt = undefined;
      this.units.set(key, state);
      if (err instanceof RoundAbort) throw err; // the database, not this conversation: no per-conversation failure
      sink.reportFailure(key, err);
    }
  }
}
