import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_CHARS,
  SEARCH_MAX_LIMIT,
  SEARCH_MAX_MATCHES,
  SEARCH_MIN_CHARS,
  SEARCH_SNIPPET_CHARS,
  ORIGINS,
  STALE_AFTER_MS,
  type Change,
  type Diagnostics,
  type GraphNode,
  type GraphSnapshot,
  type NodeDetail,
  type Origin,
  type Project,
  type SearchHit,
  type SearchIndexStatus,
  type SearchMatch,
  type SeqChange,
  type Session,
} from '@agent-canvas/shared';
import { CorruptBodyError, decodeBody, encodeBody } from './codec.js';
import { STORAGE_META, type BodyTable, type ConvertResult } from './migrate-storage.js';
import { DERIVED_TABLES, MIGRATIONS, SCHEMA_SQL } from './schema.js';
import {
  DEFAULT_SEARCH_DETAIL,
  INDEXED_NODE_FIELDS,
  SearchIndex,
  indexTextOf,
  type ContentSearchOptions,
  type ContentSearchResult,
  type SearchIndexDetail,
} from './search-index.js';

/**
 * `source` is the channel an event came through (a session file, a hook, a file read whole); `origin` is the agent it
 * comes from (absent = 'claude'). `file` of transcript and meta events is the source's store key: for Claude Code the
 * path relative to projectsDir with `/` separators.
 */
export type RawEvent =
  | {
      source: 'transcript';
      origin?: Origin;
      file: string;
      offset: number;
      line: string;
      recordType: string;
      sessionId: string;
      agentId: string | null;
      /**
       * Set by sources whose file keys do not name the project (Codex: it comes from the file's first line); replay uses
       * it instead of the key. Absent / null for Claude Code, whose key names the project.
       */
      projectId?: string | null;
    }
  | {
      source: 'hook';
      origin?: Origin;
      receivedAt: string;
      eventName: string;
      sessionId: string | null;
      payload: string;
      /** Project derived from the payload's transcript_path at ingest; replay uses this stored value. */
      projectId?: string | null;
    }
  // custom-title.json, agent-*.meta.json contents; a Codex session_index.jsonl line
  | {
      source: 'meta';
      origin?: Origin;
      file: string;
      sessionId: string;
      agentId: string | null;
      payload: string;
      /**
       * Set by sources whose keys do not name the project (Codex index entries); stored in project_id and used by replay
       * instead of the key. Absent for Claude Code (and absent, not null, when read back without one).
       */
      projectId?: string | null;
    };
/**
 * As read back: `origin` is always present (rows stored before origins existed are 'claude'). `corrupt` is set (to the
 * error) when the stored body could not be decoded: `line` / `payload` is then '' and the event must not be replayed
 * (the pipeline skips and reports it); the other fields come from their own columns and are intact.
 */
export type StoredRawEvent = RawEvent & { ingestId: number; origin: Origin; corrupt?: string };
/** One hook counter of one origin (Diagnostics.hookEvents without the origin). */
export type HookEventStat = Omit<Diagnostics['hookEvents'][number], 'origin'>;

/**
 * The change log keeps at most this many rows; older ones are pruned down to 90% of it. It only serves a web client's
 * catch-up after a reconnect; one asking for a seq older than what is kept is told to resync (refetch the snapshot).
 */
export const CHANGE_LOG_MAX_ROWS = 50_000;
/** Rows inserted into the change log between two size checks. */
const PRUNE_CHECK_EVERY = 10_000;

export type StoreDiagnostics = Pick<Diagnostics, 'unknownRecords' | 'lastHookAt' | 'files'>;

export interface StoreOptions {
  changeLogMaxRows?: number;
  pruneCheckEvery?: number;
  /** Size the WAL file is truncated to when it restarts (default 64 MB). */
  walSizeLimitBytes?: number;
  /** How far past walSizeLimitBytes the WAL file may grow before settleWal waits (default 16 MB). */
  walSettleSlackBytes?: number;
  /** Receives every SQL statement executed (tests). */
  verbose?: (sql: unknown) => void;
  /** Receives notices about slow one-time work done while opening (start prints them); silent when omitted. */
  log?: (line: string) => void;
  /** Detail level of a newly created search index (benchmark); default DEFAULT_SEARCH_DETAIL. 'off': no index rows are written (benchmark baseline only). */
  searchDetail?: SearchIndexDetail | 'off';
}

/** `%x%` with `\`, `%` and `_` escaped (use with ESCAPE '\\'). */
function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Lower-cases ASCII letters only (like SQLite LIKE), so string indexes stay aligned with the original. */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * At most SEARCH_SNIPPET_CHARS characters including the `…` marks on truncated sides, centred on the match. A match
 * longer than the window is cut at the window's end.
 */
function snippetAround(text: string, atUnits: number, needle: string): string {
  const max = SEARCH_SNIPPET_CHARS;
  const cps = Array.from(text); // code points: a window edge never splits a surrogate pair
  if (cps.length <= max) return text;
  const at = Array.from(text.slice(0, atUnits)).length;
  const matchLen = Array.from(needle).length;
  const inner = max - 2;
  let start = Math.max(0, Math.min(at - Math.floor((inner - Math.min(matchLen, inner)) / 2), cps.length - inner));
  let end = Math.min(cps.length, start + inner);
  if (start === 0) end = Math.min(cps.length, end + 1);
  if (end === cps.length) start = Math.max(0, start - 1);
  return `${start > 0 ? '…' : ''}${cps.slice(start, end).join('')}${end < cps.length ? '…' : ''}`;
}

export interface Store {
  /** Runs `fn` in one SQLite transaction (nested calls become savepoints); all or nothing. */
  transaction<T>(fn: () => T): T;
  /** Returns the ingestId, or null for a duplicate transcript line. */
  insertRaw(event: RawEvent): number | null;
  /** True when this exact line is stored as a transcript raw event under `file` (the dedupe index; nothing inserted). */
  hasTranscriptLine(file: string, line: string): boolean;
  /** Highest `offset` of the transcript raw events stored under `file`, or null when there is none. */
  maxTranscriptOffset(file: string): number | null;
  /** 0 when the file has no recorded offset. */
  getOffset(file: string): number;
  setOffset(file: string, offset: number, size: number): void;
  /** Every recorded file offset (file is the relative store key). */
  listOffsets(): { path: string; offset: number; size: number }[];
  /**
   * Single transaction; assigns consecutive seq values. Within one call only the last session_upserted per session
   * is logged and returned. Logged and returned changes carry no node detail (node_added has `detail: {}`).
   */
  applyChanges(changes: Change[]): SeqChange[];
  /**
   * `nowMs` decides which running sessions are stale (not counted active). A project's cwd is the session cwd that
   * encodes to the project id (every non-alphanumeric character becomes `-`): the most frequent, ties to the
   * lexicographically smallest; null when none does.
   */
  listProjects(nowMs: number): Project[];
  /** Ordered by lastActivityAt descending. */
  listSessions(projectId: string): Session[];
  getSession(sessionId: string): Session | null;
  /** Sessions whose stored status is running or awaiting_permission (one pass over the session rows). */
  liveSessions(): Session[];
  /** Timestamp of the session's latest main-thread prompt node (served by node_main_prompt), or null when none. */
  latestMainPromptAt(sessionId: string): string | null;
  /**
   * Case-insensitive (ASCII only, as SQLite LIKE) literal substring search over session title, id, git branch, cwd
   * and the summaries of main-thread prompt nodes. Newest activity first; fewer than SEARCH_MIN_CHARS characters
   * after trimming gives []. `limit` is clamped to 1..SEARCH_MAX_LIMIT.
   */
  searchSessions(query: string, limit: number): SearchHit[];
  /** Query plans (EXPLAIN QUERY PLAN detail lines) of the two statements searchSessions runs; for tests. */
  searchPlans(): { sessions: string[]; prompts: string[] };
  /** Search inside sessions (node contents; search-index.ts SearchIndex.search). */
  searchContent(query: string, options?: ContentSearchOptions): ContentSearchResult;
  /**
   * The content index: indexing = it does not cover every node yet (built in the background by
   * startSearchIndexBuild); indexed / total in node row positions.
   */
  searchIndexStatus(): SearchIndexStatus;
  /** One batch of the background index build in its own transaction (SearchIndex.buildBatch). */
  searchIndexBatch(maxRows: number, maxBytes: number): { more: boolean; indexed: number };
  getGraph(sessionId: string): GraphSnapshot | null;
  /** The GraphSnapshot already serialized, built from the stored bodies without parsing them. */
  getGraphJson(sessionId: string): string | null;
  /**
   * One page of a session's nodes in primary-key (id) order: ids strictly greater than `afterId` (null: from the start), at
   * most `limit`, each with its rowid (rowid order = the snapshot's node order). Nodes only, no edges or detail; one index
   * range read, nothing held open after the call (safe to page across event-loop turns).
   */
  nodePage(sessionId: string, afterId: string | null, limit: number): { rowid: number; node: GraphNode }[];
  /** The last assigned change seq (the `seq` a snapshot taken now would carry); 0 before any change. */
  lastSeq(): number;
  getNodeDetail(sessionId: string, nodeId: string): NodeDetail | null;
  /** Ascending; with `limit`, at most that many (session-scoped only). */
  changesSince(seq: number, sessionId?: string, limit?: number): SeqChange[];
  /** Smallest retained seq, or the next seq when the change log is empty. */
  minSeq(): number;
  /** Ordered by ingestId ascending. */
  rawForSession(sessionId: string): StoredRawEvent[];
  /**
   * Keyset page over rawForSession: ingestId strictly greater than afterIngestId, ascending, at most `limit` rows and,
   * when `maxBytes` is given, stopping once the rows' raw text reaches it (always at least one row).
   */
  rawForSessionAfter(sessionId: string, afterIngestId: number, limit: number, maxBytes?: number): StoredRawEvent[];
  /** Payload of the most recent meta raw event for that file, or null. */
  latestMeta(file: string): string | null;
  /**
   * Session, agent and project stored with the first transcript raw event of a store key (served by the dedupe
   * index), or null when the key has none. Lets a source whose keys do not name the session (Codex) place a file that
   * is gone.
   */
  transcriptFileOwner(file: string): { sessionId: string; agentId: string | null; projectId: string | null } | null;
  /** Distinct project ids of the derived sessions, ascending. */
  sessionProjectIds(): string[];
  allSessionIdsInRaw(): string[];
  /**
   * Distinct session ids of the transcript raw events whose store key starts with `keyPrefix` (non-empty, e.g.
   * `cursor:`), ascending: the session of each key's first record (all records of a key belong to one session). One
   * index seek per key, whatever the number of records.
   */
  transcriptSessionIds(keyPrefix: string): string[];
  /** The store keys of transcript raw events that start with `keyPrefix` (non-empty), ascending; one seek per key. */
  transcriptKeys(keyPrefix: string): string[];
  /** Clears derived tables, the change log and unknown_stat; keeps raw_event, file_offset and meta. */
  clearDerived(): void;
  /**
   * Deletes one session's derived rows (session, nodes, details, edges, its change_log rows); for a per-session
   * re-derive inside the caller's transaction.
   */
  deleteDerivedForSession(sessionId: string): void;
  /** Marks a session whose stored raw events are ahead of its derived rows (see Pipeline); persistent. */
  markDirty(sessionId: string): void;
  clearDirty(sessionId: string): void;
  clearAllDirty(): void;
  dirtySessionIds(): string[];
  bumpUnknown(recordType: string, sample: string): void;
  getMeta(key: string): string | null;
  /** Every meta row whose key starts with `prefix` (non-empty), by key ascending. */
  metaWithPrefix(prefix: string): [string, string][];
  setMeta(key: string, value: string): void;
  deleteMeta(key: string): void;
  /** True when raw_event holds at least one row of this session (served by the raw_event_session index). */
  hasRawForSession(sessionId: string): boolean;
  /** True when raw_event holds at least one row. */
  hasRawEvents(): boolean;
  /**
   * Resolves at once unless the WAL file has grown past its size limit by more than WAL_SETTLE_SLACK_BYTES; then once
   * the checkpointer reports a complete checkpoint (or after about two seconds), so the caller's next write restarts
   * the WAL from its start instead of growing it. For a long import that writes back to back: SQLite restarts the WAL
   * only when a write begins after every frame was checkpointed, which never happens while writes keep arriving during
   * each (passive) checkpoint. Writes nothing; the event loop stays free while waiting.
   */
  settleWal(): Promise<void>;
  /** Random id generated when the database file was created; stable across restarts and rebuilds. */
  epoch(): string;
  /** Latest receivedAt of any stored hook event (kept in `meta`, no raw_event scan). */
  lastHookAt(): string | null;
  /**
   * Hook counts and latest receivedAt per event name (ascending) of one origin (default 'claude'), read from the
   * hook_stat counters only.
   */
  hookEventStats(origin?: Origin): HookEventStat[];
  /** Every hook counter, by origin then event name (ascending), read from the hook_stat counters only. */
  allHookEventStats(): Diagnostics['hookEvents'];
  /** The stored part of Diagnostics; the API adds the pipeline's live fields. */
  diagnostics(): StoreDiagnostics;
  // ---- storage migration (migrate-storage.ts)
  /**
   * Sessions the store marked dirty by itself since the last call (an update met a stored detail it could not decode;
   * see applyChanges), for the pipeline's in-memory dirty set.
   */
  takeNewlyDirty(): string[];
  /** Node details found undecodable since the store was opened (by getNodeDetail or an update). */
  unreadableDetailCount(): number;
  /** Highest raw_event ingest_id and node_detail rowid (0 for an empty table). */
  bodyKeyRange(): { raw: number; detail: number };
  /**
   * Rewrites through encodeBody the enc-0 rows of `table` whose key (raw_event: ingest_id, node_detail: rowid) is in
   * (after, end], in key order, at most `maxRows` and stopping once their text reaches `maxBytes` (at least one row).
   * A row is rewritten only when its compressed form decodes back to exactly its text; one that is not text, or does
   * not round-trip, is left as is and counted as failed. Runs in the caller's transaction, if any.
   */
  convertBodies(table: BodyTable, after: number, end: number, maxRows: number, maxBytes: number): ConvertResult;
  /** Sizes of the database file and its WAL (0 when missing, or for an in-memory database). */
  dbFileSizes(): { fileBytes: number; walBytes: number };
  /** The path the store was opened with. */
  dbPath(): string;
  /** VACUUM on this connection (an in-memory database; files are vacuumed by migrate-storage's child process). */
  vacuum(): void;
  /**
   * Until the returned function is called (once), setMeta / deleteMeta are kept in memory (getMeta and metaWithPrefix
   * see them) instead of written: for the time another connection holds the write lock (VACUUM). Calling them inside a
   * transaction meanwhile throws. The release writes them in one transaction; when that fails it throws and keeps them
   * (still visible) to be written with the next meta write or hold. Lost if the process dies while they are held.
   */
  holdMetaWrites(): () => void;
  close(): void;
}

const SAMPLE_MAX = 500;

/** edge.kind codes (index = stored value). */
const EDGE_KINDS = ['sequence', 'fork', 'spawn'] as const;
/** edge.tag of an edge whose id is not from->to + tag: this prefix and the whole id. */
const ODD_EDGE_TAG = '\u0001';

/**
 * The (from, to, tag) keys an edge id of the form from->to or from->to:fork can be stored under: one per '->' in it,
 * two when what follows ends in ':fork'. Usually exactly one or two.
 */
function edgeKeysOf(id: string): [string, string, string][] {
  const keys: [string, string, string][] = [];
  for (let at = id.indexOf('->'); at >= 0; at = id.indexOf('->', at + 1)) {
    const from = id.slice(0, at);
    const rest = id.slice(at + 2);
    keys.push([from, rest, '']);
    if (rest.endsWith(':fork')) keys.push([from, rest.slice(0, -':fork'.length), ':fork']);
  }
  return keys;
}

/** The `body` / `enc` parameters of a raw_event insert: the event's text through encodeBody. */
function withBody<T extends object>(event: T, text: string): T & { body: Buffer | string; enc: number } {
  const { data, enc } = encodeBody(text);
  return { ...event, body: data, enc }; // bound to the data column
}

/** A stored node detail as an object, or null when it cannot be decoded or parsed. */
function readDetail(data: unknown, enc: number): Partial<NodeDetail> | null {
  try {
    const parsed: unknown = JSON.parse(decodeBody(data, enc));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Partial<NodeDetail>) : null;
  } catch {
    return null;
  }
}
/** meta key set once hook_stat holds every stored hook row (backfilled, or created empty with a new database). */
const HOOK_STAT_READY = 'hook_stat_ready';
/** The one-time hook_stat backfill query; served by the old raw_event_hook partial index when the database has it. */
export const HOOK_STAT_BACKFILL_SELECT = `SELECT event_name, COUNT(*), MAX(received_at) FROM raw_event
  WHERE source = 'hook' AND event_name IS NOT NULL AND received_at IS NOT NULL
  GROUP BY event_name`;
/** Printed (through StoreOptions.log) when opening a database runs that backfill. */
export const HOOK_STAT_BACKFILL_NOTICE = 'agent-canvas counting stored hook events (one-time)…';

interface RawRow {
  ingest_id: number;
  source: string;
  origin: Origin;
  file: string | null;
  offset: number | null;
  record_type: string | null;
  session_id: string | null;
  agent_id: string | null;
  event_name: string | null;
  received_at: string | null;
  project_id: string | null;
  /** Through decodeBody only (text or BLOB, see enc). */
  data: unknown;
  enc: number;
}

/** The decoded body of a raw row, or the decode error (CorruptBodyError) as `corrupt`. */
function rawText(r: RawRow): { text: string; corrupt?: string } {
  try {
    return { text: decodeBody(r.data, r.enc) };
  } catch (err) {
    if (err instanceof CorruptBodyError) return { text: '', corrupt: err.message };
    throw err;
  }
}

function toStoredRaw(r: RawRow): StoredRawEvent {
  const { text, corrupt } = rawText(r);
  const ev = toStoredRawText(r, text);
  if (corrupt !== undefined) ev.corrupt = corrupt;
  return ev;
}

function toStoredRawText(r: RawRow, body: string): StoredRawEvent {
  switch (r.source) {
    case 'transcript':
      return {
        ingestId: r.ingest_id,
        source: 'transcript',
        origin: r.origin,
        file: r.file!,
        offset: r.offset!,
        line: body,
        recordType: r.record_type!,
        sessionId: r.session_id!,
        agentId: r.agent_id,
        projectId: r.project_id,
      };
    case 'hook':
      return {
        ingestId: r.ingest_id,
        source: 'hook',
        origin: r.origin,
        receivedAt: r.received_at!,
        eventName: r.event_name!,
        sessionId: r.session_id,
        payload: body,
        projectId: r.project_id,
      };
    default:
      return {
        ingestId: r.ingest_id,
        source: 'meta',
        origin: r.origin,
        file: r.file!,
        sessionId: r.session_id!,
        agentId: r.agent_id,
        payload: body,
        ...(r.project_id !== null ? { projectId: r.project_id } : {}),
      };
  }
}

function changeSessionId(c: Change): string {
  switch (c.type) {
    case 'session_upserted':
      return c.session.id;
    case 'node_added':
      return c.node.sessionId;
    case 'edge_added':
      return c.edge.sessionId;
    case 'node_updated':
    case 'edge_removed':
      return c.sessionId;
  }
}

/** The form a change takes in the change log and on the wire: node detail is fetched on demand over REST. */
function withoutDetail(c: Change): Change {
  if (c.type === 'node_added') return { ...c, detail: {} };
  if (c.type === 'node_updated' && 'detail' in c) {
    const { detail: _detail, ...rest } = c;
    return rest;
  }
  return c;
}

const CHECKPOINT_INTERVAL_MS = 1000;
/** settleWal waits once the WAL file is this much larger than its size limit. */
const WAL_SETTLE_SLACK_BYTES = 16 * 1024 * 1024;
/** settleWal gives up waiting after this many checkpoint requests (50 ms apart) or this long per request. */
const WAL_SETTLE_ATTEMPTS = 40;
const WAL_SETTLE_REPLY_MS = 2000;
/** The WAL file is truncated to this size when it restarts; without a limit it keeps its high-water mark on disk. */
const WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * Auto-checkpoints on the main connection copy the WAL into the database file synchronously, stalling the event loop
 * for hundreds of milliseconds during an import. They are disabled here and a worker thread checkpoints instead.
 */
function startCheckpointer(db: Database.Database, dbPath: string, onError: () => void): Worker | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = ['checkpointer.js', 'checkpointer.ts'].map((f) => path.join(here, f)).find((f) => fs.existsSync(f));
  if (script === undefined) return null; // keep SQLite's automatic checkpoints
  try {
    const worker = new Worker(script, { workerData: { dbPath, intervalMs: CHECKPOINT_INTERVAL_MS } });
    worker.on('error', () => {
      onError();
      try {
        if (db.open) db.pragma('wal_autocheckpoint = 1000'); // fall back to automatic checkpoints
      } catch {
        // closing
      }
    });
    worker.unref();
    db.pragma('wal_autocheckpoint = 0');
    return worker;
  } catch {
    return null;
  }
}

/**
 * The storage format this build writes and understands, kept in `meta` (`storage_format`). 1: raw_event.data and
 * node_detail.data may be compressed (enc 0 / 1, codec.ts). A database written by a newer format is refused.
 */
export const STORAGE_FORMAT = 1;
export const STORAGE_FORMAT_KEY = 'storage_format';

/** A database whose storage format is newer than this build's: openStore refuses it without writing anything. */
export class NewerStorageFormatError extends Error {
  constructor(dbPath: string, found: string) {
    super(
      `this database was written by a newer version of agent-canvas (storage format ${found}; this version understands up to ` +
        `${STORAGE_FORMAT}): ${dbPath}. Install the newer version again, or restore a backup made before that upgrade.`,
    );
    this.name = 'NewerStorageFormatError';
  }
}

/** Throws NewerStorageFormatError when `meta.storage_format` is above STORAGE_FORMAT (or not a number). Reads only. */
function checkStorageFormat(db: Database.Database, dbPath: string): void {
  if (db.prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'meta'`).get() === undefined) return;
  const value = db.prepare(`SELECT value FROM meta WHERE key = ?`).pluck().get(STORAGE_FORMAT_KEY) as string | undefined;
  if (value === undefined) return;
  const n = Number(value);
  if (!Number.isInteger(n) || n > STORAGE_FORMAT) throw new NewerStorageFormatError(dbPath, value);
}

const hasColumn = (db: Database.Database, table: string, column: string): boolean =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);

/**
 * Brings a database written by a version before the origin dimension up to SCHEMA_SQL (see MIGRATIONS), in one
 * transaction; does nothing on a current database. Derived session rows written before it lack `origin`: the
 * normalizer version bump makes start rebuild them, and listProjects reads a missing origin as 'claude'.
 */
function migrateSchema(db: Database.Database): void {
  db.transaction(() => {
    if (!hasColumn(db, 'raw_event', 'origin')) db.exec(MIGRATIONS.rawEventOrigin);
    if (!hasColumn(db, 'hook_stat', 'origin')) db.exec(MIGRATIONS.hookStatByOrigin);
    if (hasColumn(db, 'raw_event', 'body')) db.exec(MIGRATIONS.rawEventData);
    if (hasColumn(db, 'node_detail', 'detail')) db.exec(MIGRATIONS.nodeDetailData);
    if (!hasColumn(db, 'raw_event', 'enc')) db.exec(MIGRATIONS.rawEventEnc);
    if (!hasColumn(db, 'node_detail', 'enc')) db.exec(MIGRATIONS.nodeDetailEnc);
    if (hasColumn(db, 'edge', 'body')) db.exec(MIGRATIONS.edgeCompact);
  })();
}

export function openStore(dbPath: string, options: StoreOptions = {}): Store {
  const maxRows = options.changeLogMaxRows ?? CHANGE_LOG_MAX_ROWS;
  const pruneEvery = options.pruneCheckEvery ?? PRUNE_CHECK_EVERY;
  const db = new Database(dbPath, options.verbose ? { verbose: options.verbose } : {});
  try {
    checkStorageFormat(db, dbPath); // before anything is written
  } catch (err) {
    db.close();
    throw err;
  }
  db.pragma('journal_mode = WAL');
  // A WAL that grew during an import is cut back to this size the next time it restarts after a full checkpoint.
  db.pragma(`journal_size_limit = ${options.walSizeLimitBytes ?? WAL_SIZE_LIMIT_BYTES}`);
  db.exec(SCHEMA_SQL);
  migrateSchema(db);
  const search = new SearchIndex(db, options.searchDetail ?? DEFAULT_SEARCH_DETAIL);
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(meta.value AS INTEGER) < ${STORAGE_FORMAT}`).run(
    STORAGE_FORMAT_KEY,
    String(STORAGE_FORMAT),
  );
  let checkpointerFailed = false;
  const checkpointer =
    dbPath === ':memory:' || dbPath === ''
      ? null
      : startCheckpointer(db, dbPath, () => {
          checkpointerFailed = true;
        });
  const walLimit = options.walSizeLimitBytes ?? WAL_SIZE_LIMIT_BYTES;
  const walPath = `${dbPath}-wal`;
  /** Checkpoint requests waiting for the worker's answer, by request id. */
  const replies = new Map<number, (complete: boolean) => void>();
  let nextRequest = 0;
  checkpointer?.on('message', (m: { type?: unknown; id?: unknown; busy?: unknown; log?: unknown; checkpointed?: unknown }) => {
    if (m?.type !== 'checkpointed' || typeof m.id !== 'number') return;
    const reply = replies.get(m.id);
    replies.delete(m.id);
    reply?.(m.busy === 0 && typeof m.log === 'number' && m.log >= 0 && m.log === m.checkpointed);
  });
  /** One immediate checkpoint by the worker: true when it copied every frame. */
  const checkpointNow = (): Promise<boolean> =>
    new Promise((resolve) => {
      const id = nextRequest++;
      const timer = setTimeout(() => {
        replies.delete(id);
        resolve(false);
      }, WAL_SETTLE_REPLY_MS);
      timer.unref();
      replies.set(id, (complete) => {
        clearTimeout(timer);
        resolve(complete);
      });
      try {
        checkpointer!.postMessage({ type: 'now', id });
      } catch {
        replies.delete(id);
        clearTimeout(timer);
        resolve(false);
      }
    });
  const walFileSize = (): number => {
    try {
      return fs.statSync(walPath).size;
    } catch {
      return 0;
    }
  };

  // INSERT ... SELECT ... WHERE NOT EXISTS (rather than INSERT OR IGNORE): with AUTOINCREMENT, an
  // ignored insert would still consume an ingest_id and leave gaps.
  const insertRawTranscript = db.prepare(
    `INSERT INTO raw_event (source, origin, file, "offset", line_hash, record_type, session_id, agent_id, project_id, data, enc)
     SELECT 'transcript', @origin, @file, @offset, @lineHash, @recordType, @sessionId, @agentId, @projectId, @body, @enc
     WHERE NOT EXISTS (
       SELECT 1 FROM raw_event WHERE source = 'transcript' AND file = @file AND line_hash = @lineHash
     )`,
  );
  const insertRawHook = db.prepare(
    `INSERT INTO raw_event (source, origin, event_name, received_at, session_id, project_id, data, enc)
     VALUES ('hook', @origin, @eventName, @receivedAt, @sessionId, @projectId, @body, @enc)`,
  );
  const insertRawMeta = db.prepare(
    `INSERT INTO raw_event (source, origin, file, session_id, agent_id, project_id, data, enc)
     VALUES ('meta', @origin, @file, @sessionId, @agentId, @projectId, @body, @enc)`,
  );
  const selectTranscriptLine = db
    .prepare(`SELECT 1 FROM raw_event WHERE source = 'transcript' AND file = ? AND line_hash = ?`)
    .pluck();
  const selectMaxTranscriptOffset = db.prepare(
    `SELECT MAX("offset") AS off FROM raw_event WHERE source = 'transcript' AND file = ?`,
  );
  const selectOffset = db.prepare(`SELECT "offset" AS off FROM file_offset WHERE file = ?`);
  const upsertOffset = db.prepare(
    `INSERT INTO file_offset (file, "offset", size) VALUES (@file, @offset, @size)
     ON CONFLICT(file) DO UPDATE SET "offset" = excluded."offset", size = excluded.size`,
  );
  const selectMeta = db.prepare(`SELECT value FROM meta WHERE key = ?`).pluck();
  const created = db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('epoch', ?)`).run(randomUUID()).changes === 1;
  const epoch = selectMeta.get('epoch') as string;
  const upsertMeta = db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  const deleteMeta = db.prepare(`DELETE FROM meta WHERE key = ?`);
  const selectMetaRange = db.prepare(`SELECT key, value FROM meta WHERE key >= ? AND key < ? ORDER BY key`).raw();
  const selectAnyRaw = db.prepare(`SELECT 1 FROM raw_event LIMIT 1`).pluck();
  const selectAnyRawForSession = db.prepare(`SELECT 1 FROM raw_event WHERE session_id = ? LIMIT 1`).pluck();
  const upsertLaterMeta = db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE excluded.value > meta.value`,
  );

  const insertChange = db.prepare(`INSERT INTO change_log (session_id, body) VALUES (?, ?)`);
  const upsertSession = db.prepare(
    `INSERT INTO session (id, project_id, status, last_activity_at, body)
     VALUES (@id, @projectId, @status, @lastActivityAt, @body)
     ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, status = excluded.status,
       last_activity_at = excluded.last_activity_at, body = excluded.body`,
  );
  const insertNode = db.prepare(`INSERT OR REPLACE INTO node (session_id, id, body) VALUES (?, ?, ?)`);
  const selectNodeRowid = db.prepare(`SELECT rowid FROM node WHERE session_id = ? AND id = ?`).pluck();
  const selectNodeRow = db.prepare(`SELECT rowid, body FROM node WHERE session_id = ? AND id = ?`);
  const updateNode = db.prepare(`UPDATE node SET body = ? WHERE session_id = ? AND id = ?`);
  const insertDetail = db.prepare(`INSERT OR REPLACE INTO node_detail (session_id, node_id, data, enc) VALUES (?, ?, ?, ?)`);
  const upsertDetail = (sessionId: string, nodeId: string, detail: string): void => {
    const { data, enc } = encodeBody(detail);
    insertDetail.run(sessionId, nodeId, data, enc);
  };
  const selectDetail = db.prepare(`SELECT data, enc FROM node_detail WHERE session_id = ? AND node_id = ?`);
  const selectNodeWithDetail = db.prepare(
    `SELECT d.data AS data, d.enc AS enc FROM node n
     LEFT JOIN node_detail d ON d.session_id = n.session_id AND d.node_id = n.id
     WHERE n.session_id = ? AND n.id = ?`,
  );
  const insertEdge = db.prepare(`INSERT OR REPLACE INTO edge (session_id, from_id, to_id, tag, kind, ord) VALUES (?, ?, ?, ?, ?, ?)`);
  const deleteEdgeKey = db.prepare(`DELETE FROM edge WHERE session_id = ? AND from_id = ? AND to_id = ? AND tag = ?`);
  // Only for an id that is not of the from->to form (never written by the normalizers): scans the session's edges.
  const deleteEdgeByTag = db.prepare(`DELETE FROM edge WHERE session_id = ? AND tag = ?`);
  /** Removes the edge with this id (whichever of its possible keys it is stored under); true when one was removed. */
  const deleteEdgeById = (sessionId: string, id: string, oddToo = true): boolean => {
    let removed = false;
    for (const [from, to, tag] of edgeKeysOf(id)) if (deleteEdgeKey.run(sessionId, from, to, tag).changes > 0) removed = true;
    return removed || (oddToo && deleteEdgeByTag.run(sessionId, `${ODD_EDGE_TAG}${id}`).changes > 0);
  };

  // Active = effective status running/awaiting_*: a `running` session older than STALE_AFTER_MS is stale, not active.
  // strftime normalizes the stored ISO timestamp so it compares correctly with the cutoff's toISOString().
  // The stale rule below (running and last activity older than STALE_AFTER_MS) must stay in sync with
  // effectiveStatus in shared/status.ts. One divergence: an unparseable last_activity_at is not counted active
  // here (strftime gives NULL, so the >= test is false), while effectiveStatus is never stale for it (a NaN
  // comparison is false), i.e. it would count as active.
  // A session row written before sessions had an origin (rebuilt on the next start) counts as 'claude'.
  const selectProjects = db.prepare(
    `SELECT project_id AS id, json_extract(body, '$.cwd') AS cwd,
            COALESCE(json_extract(body, '$.origin'), 'claude') AS origin, COUNT(*) AS sessionCount,
            SUM(CASE WHEN status IN ('awaiting_input', 'awaiting_permission') THEN 1
                     WHEN status = 'running' AND strftime('%Y-%m-%dT%H:%M:%fZ', last_activity_at) >= @cutoff THEN 1
                     ELSE 0 END) AS activeSessionCount
     FROM session GROUP BY project_id, cwd, origin ORDER BY project_id`,
  );
  const selectSessions = db.prepare(`SELECT body FROM session WHERE project_id = ? ORDER BY last_activity_at DESC, id`);
  const selectSession = db.prepare(`SELECT body FROM session WHERE id = ?`).pluck();
  const selectLiveSessions = db
    .prepare(`SELECT body FROM session WHERE status IN ('running', 'awaiting_permission') ORDER BY last_activity_at DESC, id`)
    .pluck();
  // Repeats the node_main_prompt partial index predicate verbatim so the index is used.
  const selectLatestMainPrompt = db
    .prepare(
      `SELECT MAX(json_extract(body, '$.timestamp')) FROM node
       WHERE session_id = ? AND json_extract(body, '$.kind') = 'prompt' AND json_extract(body, '$.agentId') IS NULL`,
    )
    .pluck();
  // Query text is only ever a bound parameter (already LIKE-escaped by likePattern). The prompt condition repeats
  // the node_main_prompt partial index predicate verbatim so the index is used. Cost per request, honestly: one pass
  // over the session rows (the OR over title/id/branch/cwd cannot use an index) plus the main-thread prompt rows via
  // the index; node bodies of other kinds (tools, text, ...) are never scanned.
  const searchSessionsStmt = db.prepare(
    `SELECT body FROM session
     WHERE json_extract(body, '$.title') LIKE @pattern ESCAPE '\\'
        OR id LIKE @pattern ESCAPE '\\'
        OR json_extract(body, '$.gitBranch') LIKE @pattern ESCAPE '\\'
        OR json_extract(body, '$.cwd') LIKE @pattern ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM node n WHERE n.session_id = session.id
                     AND json_extract(n.body, '$.kind') = 'prompt'
                     AND json_extract(n.body, '$.agentId') IS NULL
                     AND json_extract(n.body, '$.summary') LIKE @pattern ESCAPE '\\')
     ORDER BY last_activity_at DESC, id
     LIMIT @limit`,
  );
  const searchPromptsStmt = db.prepare(
    `SELECT id, json_extract(body, '$.summary') AS summary FROM node
     WHERE session_id = @sessionId AND json_extract(body, '$.kind') = 'prompt'
       AND json_extract(body, '$.agentId') IS NULL
       AND json_extract(body, '$.summary') LIKE @pattern ESCAPE '\\'
     ORDER BY json_extract(body, '$.timestamp'), rowid
     LIMIT @limit`,
  );
  const selectNodeBodies = db.prepare(`SELECT body FROM node WHERE session_id = ? ORDER BY rowid`).pluck();
  const selectNodePageFirst = db.prepare(`SELECT rowid, body FROM node WHERE session_id = ? ORDER BY id LIMIT ?`);
  const selectNodePageAfter = db.prepare(`SELECT rowid, body FROM node WHERE session_id = ? AND id > ? ORDER BY id LIMIT ?`);
  const selectEdges = db.prepare(`SELECT from_id, to_id, tag, kind FROM edge WHERE session_id = ? ORDER BY ord`).raw();
  /** A session's edges, each serialized as JSON.stringify(edge) would (snapshot order). */
  const edgeJsons = (sessionId: string): string[] =>
    (selectEdges.all(sessionId) as [string, string, string, number | string][]).map(([from, to, tag, kind]) =>
      JSON.stringify({
        id: tag.startsWith(ODD_EDGE_TAG) ? tag.slice(ODD_EDGE_TAG.length) : `${from}->${to}${tag}`,
        sessionId,
        from,
        to,
        kind: typeof kind === 'number' ? (EDGE_KINDS[kind] ?? String(kind)) : kind,
      }),
    );
  const selectChanges = db.prepare(`SELECT seq, body FROM change_log WHERE seq > ? ORDER BY seq`);
  const selectChangesForSession = db.prepare(
    `SELECT seq, body FROM change_log WHERE seq > ? AND session_id = ? ORDER BY seq`,
  );
  const selectChangesForSessionLimit = db.prepare(
    `SELECT seq, body FROM change_log WHERE seq > ? AND session_id = ? ORDER BY seq LIMIT ?`,
  );
  const selectMinSeq = db.prepare(`SELECT MIN(seq) FROM change_log`).pluck();
  const selectSeqCounter = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'change_log'`).pluck();
  const countChanges = db.prepare(`SELECT COUNT(*) FROM change_log`).pluck();
  const pruneChanges = db.prepare(
    `DELETE FROM change_log WHERE seq < (SELECT seq FROM change_log ORDER BY seq DESC LIMIT 1 OFFSET ?)`,
  );
  const selectRawForSession = db.prepare(`SELECT * FROM raw_event WHERE session_id = ? ORDER BY ingest_id`);
  const selectRawAfter = db.prepare(
    `SELECT * FROM raw_event WHERE session_id = ? AND ingest_id > ? ORDER BY ingest_id LIMIT ?`,
  );
  const selectLatestMeta = db.prepare(
    `SELECT data, enc FROM raw_event WHERE source = 'meta' AND file = ? ORDER BY ingest_id DESC LIMIT 1`,
  );
  const selectTranscriptOwner = db.prepare(
    `SELECT session_id AS sessionId, agent_id AS agentId, project_id AS projectId FROM raw_event
     WHERE source = 'transcript' AND file = ? LIMIT 1`,
  );
  const selectSessionProjectIds = db.prepare(`SELECT DISTINCT project_id FROM session ORDER BY project_id`).pluck();
  const selectRawSessionIds = db.prepare(
    `SELECT DISTINCT session_id AS id FROM raw_event WHERE session_id IS NOT NULL ORDER BY session_id`,
  );
  // The next stored key after `file` (exclusive) below `end`: a loose scan of the dedupe index, one seek per key, never
  // the rows of a key (a large conversation has tens of thousands).
  const selectNextTranscriptFile = db
    .prepare(`SELECT MIN(file) FROM raw_event WHERE source = 'transcript' AND file > ? AND file < ?`)
    .pluck();
  const upsertUnknown = db.prepare(
    `INSERT INTO unknown_stat (record_type, count, sample) VALUES (?, 1, ?)
     ON CONFLICT(record_type) DO UPDATE SET count = count + 1`,
  );
  const selectHookStats = db.prepare(
    `SELECT event_name AS eventName, count, last_at AS lastAt FROM hook_stat WHERE origin = ? ORDER BY event_name`,
  );
  const selectAllHookStats = db.prepare(
    `SELECT origin, event_name AS eventName, count, last_at AS lastAt FROM hook_stat ORDER BY origin, event_name`,
  );
  const bumpHookStat = db.prepare(
    `INSERT INTO hook_stat (origin, event_name, count, last_at) VALUES (?, ?, 1, ?)
     ON CONFLICT(origin, event_name) DO UPDATE SET count = count + 1, last_at = MAX(last_at, excluded.last_at)`,
  );
  const insertHookTx = db.transaction((event: Extract<RawEvent, { source: 'hook' }>): number => {
    const origin = event.origin ?? 'claude';
    const id = Number(insertRawHook.run({ ...withBody(event, event.payload), origin, projectId: event.projectId ?? null }).lastInsertRowid);
    upsertLaterMeta.run('last_hook_at', event.receivedAt);
    bumpHookStat.run(origin, event.eventName, event.receivedAt);
    return id;
  });
  // Databases from before hook_stat existed: backfill it once (one transaction), then never again. It runs before the
  // old raw_event_hook index is dropped, so on such a database it reads that index instead of scanning raw_event
  // bodies. A database created just now has nothing to backfill. Such a database predates origins: every hook is 'claude'.
  db.transaction(() => {
    if (selectMeta.get(HOOK_STAT_READY) !== undefined) return;
    if (!created && db.prepare(`SELECT 1 FROM hook_stat LIMIT 1`).get() === undefined) {
      options.log?.(HOOK_STAT_BACKFILL_NOTICE);
      db.exec(`INSERT INTO hook_stat (origin, event_name, count, last_at) SELECT 'claude', * FROM (${HOOK_STAT_BACKFILL_SELECT})`);
    }
    upsertMeta.run(HOOK_STAT_READY, '1');
  })();
  db.exec(`DROP INDEX IF EXISTS raw_event_hook`);
  // A database created just now (its epoch was written above) holds nothing to compress or reclaim: the storage
  // migration is done from the start.
  if (created) {
    db.transaction(() => {
      upsertMeta.run(STORAGE_META.migration, 'done');
      upsertMeta.run(STORAGE_META.vacuum, 'done');
    })();
  }
  const selectMaxIngestId = db.prepare(`SELECT MAX(ingest_id) FROM raw_event`).pluck();
  const selectMaxDetailRowid = db.prepare(`SELECT MAX(rowid) FROM node_detail`).pluck();
  const convertSelect: Record<BodyTable, Database.Statement> = {
    raw_event: db.prepare(`SELECT ingest_id AS id, data FROM raw_event WHERE ingest_id > ? AND ingest_id <= ? AND enc = 0 ORDER BY ingest_id LIMIT ?`),
    node_detail: db.prepare(`SELECT rowid AS id, data FROM node_detail WHERE rowid > ? AND rowid <= ? AND enc = 0 ORDER BY rowid LIMIT ?`),
  };
  const convertUpdate: Record<BodyTable, Database.Statement> = {
    raw_event: db.prepare(`UPDATE raw_event SET data = ?, enc = ? WHERE ingest_id = ?`),
    node_detail: db.prepare(`UPDATE node_detail SET data = ?, enc = ? WHERE rowid = ?`),
  };
  /** setMeta / deleteMeta kept in memory while held (holdMetaWrites); null when not held. */
  let heldMeta: Map<string, string | null> | null = null;
  /** Held meta writes whose flush failed: still visible to getMeta, written again with the next meta write. */
  let unflushedMeta: Map<string, string | null> | null = null;
  /** Writes held meta values in one transaction; on failure keeps them in unflushedMeta and rethrows. */
  const flushMeta = (entries: Map<string, string | null>): void => {
    try {
      db.transaction(() => {
        for (const [key, value] of entries) {
          if (value === null) deleteMeta.run(key);
          else upsertMeta.run(key, value);
        }
      })();
    } catch (err) {
      unflushedMeta = new Map([...(unflushedMeta ?? []), ...entries]);
      throw err;
    }
  };
  /** The value of `key` among the held or unflushed meta writes (undefined: none). */
  const pendingMeta = (key: string): string | null | undefined => {
    if (heldMeta?.has(key)) return heldMeta.get(key);
    if (unflushedMeta?.has(key)) return unflushedMeta.get(key);
    return undefined;
  };
  /** Before a direct meta write: the unflushed ones first (best effort, kept on failure). */
  const retryUnflushed = (): void => {
    if (unflushedMeta === null) return;
    const entries = unflushedMeta;
    unflushedMeta = null;
    try {
      flushMeta(entries);
    } catch {
      // kept in unflushedMeta by flushMeta
    }
  };
  const selectUnknown = db.prepare(`SELECT record_type, count, sample FROM unknown_stat ORDER BY record_type`);
  const selectFiles = db.prepare(`SELECT file, "offset", size FROM file_offset ORDER BY file`);

  /**
   * Node details written by the applyChanges call in progress, by session and node id, written (encoded once each) when
   * the call ends: a node added and then updated in the same call (a tool call and its result, a whole session during a
   * rebuild) is compressed once instead of written, read back, decoded, merged and compressed again.
   */
  const pendingDetails = new Map<string, { sessionId: string; nodeId: string; detail: object }>();
  /** Node details found undecodable (by key), since the store was opened: Diagnostics.storage.unreadableDetails. */
  const unreadableDetails = new Set<string>();
  /** Sessions this store marked dirty itself (an undecodable detail met by a merge), until takeNewlyDirty(). */
  const newlyDirty = new Set<string>();
  const detailKey = (sessionId: string, nodeId: string): string => `${sessionId}\u0000${nodeId}`;
  /**
   * Search index rows to rewrite when the applyChanges call in progress ends, by the same key as pendingDetails: the
   * node's current row (rowid, body) and the rowid its index row is stored under (`stale`, null: none yet; a node
   * re-added by INSERT OR REPLACE gets a new rowid). `storedDetail`: the index text needs the stored detail (a patch
   * changed an indexed field and the call carries no detail for the node).
   */
  const pendingIndex = new Map<string, { rowid: number; node: GraphNode; stale: number | null; storedDetail: boolean }>();
  function flushDetails(): void {
    for (const { sessionId, nodeId, detail } of pendingDetails.values()) upsertDetail(sessionId, nodeId, JSON.stringify(detail));
    // Index rows, from the final detail in memory (no detail is read back except for a patch without one).
    for (const [key, entry] of pendingIndex) {
      let detail: Partial<NodeDetail> | null | undefined = pendingDetails.get(key)?.detail as Partial<NodeDetail> | undefined;
      if (detail === undefined && entry.storedDetail) {
        const row = selectDetail.get(entry.node.sessionId, entry.node.id) as { data: unknown; enc: number } | undefined;
        detail = row === undefined ? {} : readDetail(row.data, row.enc);
        if (detail === null) continue; // an undecodable detail: its index row stays as it is (the session is re-derived)
      }
      search.write(entry.stale, entry.rowid, indexTextOf(entry.node, detail ?? {}));
    }
    pendingDetails.clear();
    pendingIndex.clear();
  }

  function applyOne(c: Change, seq: number): void {
    switch (c.type) {
      case 'session_upserted':
        upsertSession.run({
          id: c.session.id,
          projectId: c.session.projectId,
          status: c.session.status,
          lastActivityAt: c.session.lastActivityAt,
          body: JSON.stringify(c.session),
        });
        break;
      case 'node_added': {
        const key = detailKey(c.node.sessionId, c.node.id);
        // The rowid the node's index row is under now: the pending entry's, else the existing row's (replaced below).
        const prior = pendingIndex.get(key);
        const stale = prior !== undefined ? prior.stale : ((selectNodeRowid.get(c.node.sessionId, c.node.id) as number | undefined) ?? null);
        const rowid = Number(insertNode.run(c.node.sessionId, c.node.id, JSON.stringify(c.node)).lastInsertRowid);
        pendingDetails.set(key, { sessionId: c.node.sessionId, nodeId: c.node.id, detail: c.detail ?? {} });
        pendingIndex.set(key, { rowid, node: c.node, stale, storedDetail: false });
        break;
      }
      case 'node_updated': {
        const row = selectNodeRow.get(c.sessionId, c.id) as { rowid: number; body: string } | undefined;
        if (row === undefined) break; // updates to unknown nodes are ignored, as in shared applyChange
        const merged = { ...(JSON.parse(row.body) as GraphNode), ...c.patch } as GraphNode;
        updateNode.run(JSON.stringify(merged), c.sessionId, c.id);
        const indexKey = detailKey(c.sessionId, c.id);
        const indexed = pendingIndex.get(indexKey);
        if (indexed !== undefined) indexed.node = merged;
        else if (c.detail !== undefined || Object.keys(c.patch).some((k) => INDEXED_NODE_FIELDS.includes(k))) {
          // storedDetail: refined below once the detail merge is known
          pendingIndex.set(indexKey, { rowid: row.rowid, node: merged, stale: row.rowid, storedDetail: c.detail === undefined });
        }
        if (c.detail !== undefined) {
          // node_detail is touched only when the update carries detail.
          const key = detailKey(c.sessionId, c.id);
          let prev: object | undefined = pendingDetails.get(key)?.detail;
          if (prev === undefined) {
            const row = selectDetail.get(c.sessionId, c.id) as { data: unknown; enc: number } | undefined;
            const stored = row === undefined ? {} : readDetail(row.data, row.enc);
            if (stored === null) {
              // A stored detail that cannot be decoded (damaged, or an encoding this build does not know) is left as it
              // is, never overwritten by a partial merge: the session is marked dirty, so it is re-derived from its raw
              // events (which replaces the detail with the real one), and the detail is counted as unreadable.
              unreadableDetails.add(key);
              insertDirty.run(c.sessionId);
              newlyDirty.add(c.sessionId);
              pendingIndex.delete(indexKey); // nor is its index row rewritten from a partial detail
              break;
            }
            prev = stored;
          }
          pendingDetails.set(key, { sessionId: c.sessionId, nodeId: c.id, detail: { ...prev, ...c.detail } });
        }
        break;
      }
      case 'edge_added': {
        const e = c.edge;
        // An id that more than one key could spell (node ids with '->' or ending in ':fork'): it names one edge, so
        // whatever was stored under another spelling of it goes first.
        if (edgeKeysOf(e.id).length > 1) deleteEdgeById(e.sessionId, e.id, false);
        const base = `${e.from}->${e.to}`;
        const tag = e.id.startsWith(base) && (e.id.length === base.length || e.id.slice(base.length) === ':fork') ? e.id.slice(base.length) : `${ODD_EDGE_TAG}${e.id}`;
        const kind = EDGE_KINDS.indexOf(e.kind);
        insertEdge.run(e.sessionId, e.from, e.to, tag, kind >= 0 ? kind : e.kind, seq);
        break;
      }
      case 'edge_removed':
        deleteEdgeById(c.sessionId, c.id);
        break;
    }
  }

  let insertedSincePruneCheck = pruneEvery; // check on the first call
  function maybePrune(inserted: number): void {
    insertedSincePruneCheck += inserted;
    if (insertedSincePruneCheck < pruneEvery) return;
    insertedSincePruneCheck = 0;
    if ((countChanges.get() as number) <= maxRows) return;
    const keep = Math.max(1, Math.floor(maxRows * 0.9));
    pruneChanges.run(keep - 1);
  }

  const applyChangesTx = db.transaction((changes: Change[]): SeqChange[] => {
    // Only the last session_upserted per session survives (relative order of the rest is kept).
    const lastUpsert = new Map<string, number>();
    changes.forEach((c, i) => {
      if (c.type === 'session_upserted') lastUpsert.set(c.session.id, i);
    });
    const out: SeqChange[] = [];
    pendingDetails.clear();
    pendingIndex.clear();
    try {
      changes.forEach((c, i) => {
        if (c.type === 'session_upserted' && lastUpsert.get(c.session.id) !== i) return;
        const logged = withoutDetail(c);
        const seq = Number(insertChange.run(changeSessionId(c), JSON.stringify(logged)).lastInsertRowid);
        applyOne(c, seq);
        out.push({ ...logged, seq });
      });
      flushDetails();
    } finally {
      pendingDetails.clear();
      pendingIndex.clear();
    }
    maybePrune(out.length);
    return out;
  });

  const deleteSessionDerived = [
    db.prepare(`DELETE FROM session WHERE id = ?`),
    db.prepare(`DELETE FROM node WHERE session_id = ?`),
    db.prepare(`DELETE FROM node_detail WHERE session_id = ?`),
    db.prepare(`DELETE FROM edge WHERE session_id = ?`),
    db.prepare(`DELETE FROM change_log WHERE session_id = ?`),
  ];
  const insertDirty = db.prepare(`INSERT OR IGNORE INTO dirty_session (session_id) VALUES (?)`);
  const deleteDirty = db.prepare(`DELETE FROM dirty_session WHERE session_id = ?`);
  const selectDirty = db.prepare(`SELECT session_id FROM dirty_session ORDER BY session_id`).pluck();

  const clearDerivedTx = db.transaction(() => {
    for (const t of DERIVED_TABLES) db.exec(`DELETE FROM ${t}`);
    search.clear(); // no nodes, no index rows: complete (a rebuild then indexes every node as it writes it)
    // seq (AUTOINCREMENT) is deliberately NOT reset: it must stay monotonic so clients
    // holding an old sinceSeq still receive the rebuilt changes.
  });

  const toChanges = (rows: unknown[]): SeqChange[] =>
    (rows as { seq: number; body: string }[]).map((r) => ({ ...(JSON.parse(r.body) as Change), seq: r.seq }));

  const getSession = (sessionId: string): Session | null => {
    const body = selectSession.get(sessionId) as string | undefined;
    return body === undefined ? null : (JSON.parse(body) as Session);
  };

  const getGraphJson = (sessionId: string): string | null => {
    const session = selectSession.get(sessionId) as string | undefined;
    if (session === undefined) return null;
    const nodes = selectNodeBodies.all(sessionId) as string[];
    const edges = edgeJsons(sessionId);
    // The last assigned seq (not the session's own max): the snapshot reflects every change up to it, and it is never
    // below minSeq() - 1, so a client resubscribing with it is never told to resync again.
    const seq = lastSeq();
    return `{"session":${session},"nodes":[${nodes.join(',')}],"edges":[${edges.join(',')}],"seq":${seq}}`;
  };

  const lastSeq = (): number => (selectSeqCounter.get() as number | undefined) ?? 0;
  const transcriptKeys = (keyPrefix: string): string[] => {
    if (keyPrefix === '') throw new Error('transcriptKeys: empty key prefix');
    const end = keyPrefix.slice(0, -1) + String.fromCharCode(keyPrefix.charCodeAt(keyPrefix.length - 1) + 1);
    const keys: string[] = [];
    if (selectTranscriptOwner.get(keyPrefix) !== undefined) keys.push(keyPrefix); // `file > prefix` misses the prefix itself
    let file: string | null = keyPrefix;
    while ((file = (selectNextTranscriptFile.get(file, end) as string | null | undefined) ?? null) !== null) keys.push(file);
    return keys;
  };
  const lastHookAt = (): string | null => (selectMeta.get('last_hook_at') as string | undefined) ?? null;
  const listOffsets = (): { path: string; offset: number; size: number }[] =>
    (selectFiles.all() as { file: string; offset: number; size: number }[]).map((r) => ({
      path: r.file,
      offset: r.offset,
      size: r.size,
    }));

  return {
    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
    insertRaw(event) {
      if (event.source === 'transcript') {
        const lineHash = createHash('sha1').update(event.line).digest('hex');
        const res = insertRawTranscript.run({ ...withBody(event, event.line), origin: event.origin ?? 'claude', projectId: event.projectId ?? null, lineHash });
        return res.changes === 0 ? null : Number(res.lastInsertRowid);
      }
      if (event.source === 'hook') return insertHookTx(event);
      return Number(
        insertRawMeta.run({ ...withBody(event, event.payload), origin: event.origin ?? 'claude', projectId: event.projectId ?? null }).lastInsertRowid,
      );
    },
    hasTranscriptLine(file, line) {
      return selectTranscriptLine.get(file, createHash('sha1').update(line).digest('hex')) !== undefined;
    },
    maxTranscriptOffset(file) {
      return (selectMaxTranscriptOffset.get(file) as { off: number | null }).off;
    },
    getOffset(file) {
      const row = selectOffset.get(file) as { off: number } | undefined;
      return row?.off ?? 0;
    },
    setOffset(file, offset, size) {
      upsertOffset.run({ file, offset, size });
    },
    listOffsets,
    applyChanges(changes) {
      return applyChangesTx(changes);
    },
    listProjects(nowMs) {
      const cutoff = new Date(nowMs - STALE_AFTER_MS).toISOString();
      const rows = selectProjects.all({ cutoff }) as {
        id: string;
        cwd: string | null;
        origin: Origin;
        sessionCount: number;
        activeSessionCount: number;
      }[];
      const byId = new Map<string, { project: Project; cwdCounts: Map<string, number> }>();
      for (const r of rows) {
        let entry = byId.get(r.id);
        if (!entry) {
          entry = { project: { id: r.id, cwd: null, sessionCount: 0, activeSessionCount: 0, origins: [] }, cwdCounts: new Map() };
          byId.set(r.id, entry);
        }
        entry.project.sessionCount += r.sessionCount;
        entry.project.activeSessionCount += r.activeSessionCount;
        if (!entry.project.origins.includes(r.origin)) entry.project.origins.push(r.origin);
        if (r.cwd !== null && r.cwd.replace(/[^A-Za-z0-9]/g, '-') === r.id) {
          entry.cwdCounts.set(r.cwd, (entry.cwdCounts.get(r.cwd) ?? 0) + r.sessionCount);
        }
      }
      return [...byId.values()].map(({ project, cwdCounts }) => {
        let best: { cwd: string; n: number } | null = null;
        for (const [cwd, n] of cwdCounts) if (best === null || n > best.n || (n === best.n && cwd < best.cwd)) best = { cwd, n };
        const origins = ORIGINS.filter((o) => project.origins.includes(o));
        return { ...project, cwd: best?.cwd ?? null, origins };
      });
    },
    listSessions(projectId) {
      return (selectSessions.all(projectId) as { body: string }[]).map((r) => JSON.parse(r.body) as Session);
    },
    getSession,
    liveSessions() {
      return (selectLiveSessions.all() as string[]).map((body) => JSON.parse(body) as Session);
    },
    latestMainPromptAt(sessionId) {
      const v = selectLatestMainPrompt.get(sessionId) as string | null | undefined;
      return typeof v === 'string' ? v : null;
    },
    searchSessions(rawQuery, rawLimit) {
      const query = Array.from(rawQuery.trim()).slice(0, SEARCH_MAX_CHARS).join('').trim();
      if ([...query].length < SEARCH_MIN_CHARS) return [];
      const limit = Number.isFinite(rawLimit) ? Math.min(SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(rawLimit))) : SEARCH_DEFAULT_LIMIT;
      const pattern = likePattern(query);
      const needle = asciiLower(query);
      const hits: SearchHit[] = [];
      for (const row of searchSessionsStmt.all({ pattern, limit }) as { body: string }[]) {
        const session = JSON.parse(row.body) as Session;
        const matches: SearchMatch[] = [];
        const fields: [SearchMatch['field'], string | null][] = [
          ['title', session.title],
          ['id', session.id],
          ['branch', session.gitBranch],
          ['cwd', session.cwd],
        ];
        for (const [field, text] of fields) {
          if (text === null || matches.length >= SEARCH_MAX_MATCHES) continue;
          const at = asciiLower(text).indexOf(needle);
          if (at >= 0) matches.push({ field, nodeId: null, snippet: snippetAround(text, at, needle) });
        }
        if (matches.length < SEARCH_MAX_MATCHES) {
          const prompts = searchPromptsStmt.all({ sessionId: session.id, pattern, limit: SEARCH_MAX_MATCHES - matches.length }) as {
            id: string;
            summary: string;
          }[];
          for (const p of prompts) {
            const at = asciiLower(p.summary).indexOf(needle);
            if (at >= 0) matches.push({ field: 'prompt', nodeId: p.id, snippet: snippetAround(p.summary, at, needle) });
          }
        }
        hits.push({ session, matches });
      }
      return hits;
    },
    searchContent(query, options) {
      return search.search(query, options);
    },
    searchIndexStatus: () => search.status(),
    searchIndexBatch: (maxRows, maxBytes) => search.buildBatch(maxRows, maxBytes),
    searchPlans() {
      const params = { pattern: '%x%', limit: 1, sessionId: 's' };
      const plan = (stmt: { source: string }) =>
        (db.prepare(`EXPLAIN QUERY PLAN ${stmt.source}`).all(params) as { detail: string }[]).map((r) => r.detail);
      return { sessions: plan(searchSessionsStmt), prompts: plan(searchPromptsStmt) };
    },
    getGraph(sessionId) {
      const json = getGraphJson(sessionId);
      return json === null ? null : (JSON.parse(json) as GraphSnapshot);
    },
    getGraphJson,
    nodePage(sessionId, afterId, limit) {
      const rows = (afterId === null ? selectNodePageFirst.all(sessionId, limit) : selectNodePageAfter.all(sessionId, afterId, limit)) as {
        rowid: number;
        body: string;
      }[];
      return rows.map((r) => ({ rowid: r.rowid, node: JSON.parse(r.body) as GraphNode }));
    },
    lastSeq,
    getNodeDetail(sessionId, nodeId) {
      const row = selectNodeWithDetail.get(sessionId, nodeId) as { data: unknown; enc: number | null } | undefined;
      if (!row) return null;
      const empty: NodeDetail = { input: null, output: null, text: null, raw: null, nodeId };
      if (row.data === null) return empty;
      const d = readDetail(row.data, row.enc ?? 0);
      if (d === null) {
        unreadableDetails.add(detailKey(sessionId, nodeId));
        return { ...empty, unreadable: true };
      }
      return { ...empty, ...d, nodeId };
    },
    changesSince(seq, sessionId, limit) {
      if (sessionId === undefined) return toChanges(selectChanges.all(seq));
      return toChanges(
        limit === undefined ? selectChangesForSession.all(seq, sessionId) : selectChangesForSessionLimit.all(seq, sessionId, limit),
      );
    },
    minSeq() {
      const min = selectMinSeq.get() as number | null;
      if (min !== null) return min;
      return lastSeq() + 1;
    },
    rawForSession(sessionId) {
      return (selectRawForSession.all(sessionId) as RawRow[]).map(toStoredRaw);
    },
    rawForSessionAfter(sessionId, afterIngestId, limit, maxBytes) {
      if (maxBytes === undefined) return (selectRawAfter.all(sessionId, afterIngestId, limit) as RawRow[]).map(toStoredRaw);
      const out: StoredRawEvent[] = [];
      let bytes = 0;
      for (const row of selectRawAfter.iterate(sessionId, afterIngestId, limit) as IterableIterator<RawRow>) {
        const ev = toStoredRaw(row);
        out.push(ev);
        // The decoded text's length (what the page holds in memory), not the stored size.
        bytes += ev.source === 'transcript' ? ev.line.length : ev.payload.length;
        if (bytes >= maxBytes) break; // ends the iteration (and the statement)
      }
      return out;
    },
    latestMeta(file) {
      // A latest row that cannot be decoded counts as none: the caller writes the current content again.
      const row = selectLatestMeta.get(file) as { data: unknown; enc: number } | undefined;
      if (row === undefined) return null;
      try {
        return decodeBody(row.data, row.enc);
      } catch (err) {
        if (err instanceof CorruptBodyError) return null;
        throw err;
      }
    },
    transcriptFileOwner(file) {
      const row = selectTranscriptOwner.get(file) as { sessionId: string; agentId: string | null; projectId: string | null } | undefined;
      return row ?? null;
    },
    sessionProjectIds() {
      return selectSessionProjectIds.all() as string[];
    },
    allSessionIdsInRaw() {
      return (selectRawSessionIds.all() as { id: string }[]).map((r) => r.id);
    },
    transcriptSessionIds(keyPrefix) {
      if (keyPrefix === '') throw new Error('transcriptSessionIds: empty key prefix');
      const ids = new Set<string>();
      for (const file of transcriptKeys(keyPrefix)) {
        const sessionId = (selectTranscriptOwner.get(file) as { sessionId: string | null } | undefined)?.sessionId;
        if (sessionId != null) ids.add(sessionId);
      }
      return [...ids].sort();
    },
    transcriptKeys,
    clearDerived() {
      clearDerivedTx();
    },
    deleteDerivedForSession(sessionId) {
      search.deleteForSession(sessionId); // while the node rows still name the index rows
      for (const stmt of deleteSessionDerived) stmt.run(sessionId);
    },
    markDirty(sessionId) {
      insertDirty.run(sessionId);
    },
    clearDirty(sessionId) {
      deleteDirty.run(sessionId);
    },
    clearAllDirty() {
      db.exec(`DELETE FROM dirty_session`);
    },
    dirtySessionIds: () => selectDirty.all() as string[],
    bumpUnknown(recordType, sample) {
      upsertUnknown.run(recordType, sample.slice(0, SAMPLE_MAX));
    },
    lastHookAt,
    async settleWal() {
      if (checkpointer === null || checkpointerFailed || !db.open) return;
      if (walFileSize() <= walLimit + (options.walSettleSlackBytes ?? WAL_SETTLE_SLACK_BYTES)) return;
      for (let attempt = 0; attempt < WAL_SETTLE_ATTEMPTS && db.open && !checkpointerFailed; attempt++) {
        if (await checkpointNow()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    epoch: () => epoch,
    getMeta(key) {
      const pending = pendingMeta(key);
      if (pending !== undefined) return pending;
      return (selectMeta.get(key) as string | undefined) ?? null;
    },
    metaWithPrefix(prefix) {
      if (prefix === '') throw new Error('metaWithPrefix: empty prefix');
      const end = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
      const rows = selectMetaRange.all(prefix, end) as [string, string][];
      if (heldMeta === null && unflushedMeta === null) return rows;
      const merged = new Map(rows);
      for (const [key, value] of [...(unflushedMeta ?? []), ...(heldMeta ?? [])]) {
        if (key < prefix || key >= end) continue;
        if (value === null) merged.delete(key);
        else merged.set(key, value);
      }
      return [...merged].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    },
    setMeta(key, value) {
      if (heldMeta !== null) {
        // Held writes are flushed outside any transaction: one made inside a transaction could outlive its rollback.
        if (db.inTransaction) throw new Error('setMeta inside a transaction while meta writes are held');
        heldMeta.set(key, value);
        return;
      }
      retryUnflushed();
      upsertMeta.run(key, value);
      unflushedMeta?.delete(key);
    },
    deleteMeta(key) {
      if (heldMeta !== null) {
        if (db.inTransaction) throw new Error('deleteMeta inside a transaction while meta writes are held');
        heldMeta.set(key, null);
        return;
      }
      retryUnflushed();
      deleteMeta.run(key);
      unflushedMeta?.delete(key);
    },
    hookEventStats: (origin = 'claude') => selectHookStats.all(origin) as HookEventStat[],
    allHookEventStats: () => selectAllHookStats.all() as Diagnostics['hookEvents'],
    hasRawEvents: () => selectAnyRaw.get() !== undefined,
    hasRawForSession: (sessionId) => selectAnyRawForSession.get(sessionId) !== undefined,
    diagnostics() {
      return {
        unknownRecords: (selectUnknown.all() as { record_type: string; count: number; sample: string }[]).map((r) => ({
          recordType: r.record_type,
          count: r.count,
          sample: r.sample,
        })),
        lastHookAt: lastHookAt(),
        files: listOffsets(),
      };
    },
    takeNewlyDirty() {
      const ids = [...newlyDirty];
      newlyDirty.clear();
      return ids;
    },
    unreadableDetailCount: () => unreadableDetails.size,
    bodyKeyRange() {
      return { raw: (selectMaxIngestId.get() as number | null) ?? 0, detail: (selectMaxDetailRowid.get() as number | null) ?? 0 };
    },
    convertBodies(table, after, end, maxRows, maxBytes) {
      const rows: { id: number; data: unknown }[] = [];
      let bytes = 0;
      let cut = false;
      for (const row of convertSelect[table].iterate(after, end, maxRows) as IterableIterator<{ id: number; data: unknown }>) {
        rows.push(row);
        bytes += typeof row.data === 'string' ? row.data.length : row.data instanceof Uint8Array ? row.data.length : 0;
        if (bytes >= maxBytes) {
          cut = true;
          break; // ends the iteration (and the statement) before the updates below
        }
      }
      let converted = 0;
      let failed = 0;
      for (const row of rows) {
        if (typeof row.data !== 'string') {
          failed += 1;
          continue;
        }
        try {
          const { data, enc } = encodeBody(row.data);
          if (enc === 0) continue; // short or incompressible: stays as it is
          if (decodeBody(data, enc) !== row.data) {
            failed += 1; // not representable as UTF-8 byte for byte (e.g. a lone surrogate): keep the text
            continue;
          }
          convertUpdate[table].run(data, enc, row.id);
          converted += 1;
        } catch {
          failed += 1;
        }
      }
      const done = !cut && rows.length < maxRows;
      return { last: done || rows.length === 0 ? end : rows[rows.length - 1]!.id, examined: rows.length, converted, failed, done };
    },
    dbFileSizes() {
      const size = (f: string): number => {
        try {
          return fs.statSync(f).size;
        } catch {
          return 0;
        }
      };
      if (dbPath === ':memory:' || dbPath === '') return { fileBytes: 0, walBytes: 0 };
      return { fileBytes: size(dbPath), walBytes: size(walPath) };
    },
    dbPath: () => dbPath,
    vacuum() {
      db.exec('VACUUM');
      if (dbPath !== ':memory:' && dbPath !== '') db.pragma('wal_checkpoint(TRUNCATE)');
    },
    holdMetaWrites() {
      if (heldMeta !== null) throw new Error('meta writes are already held');
      const held = new Map<string, string | null>(unflushedMeta ?? []);
      unflushedMeta = null;
      heldMeta = held;
      return () => {
        if (heldMeta !== held) return;
        heldMeta = null;
        flushMeta(held);
      };
    },
    close() {
      for (const reply of [...replies.values()]) reply(false);
      replies.clear();
      checkpointer?.postMessage('close');
      db.close();
    },
  };
}
