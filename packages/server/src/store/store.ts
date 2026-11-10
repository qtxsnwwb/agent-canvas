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
  STALE_AFTER_MS,
  type Change,
  type Diagnostics,
  type GraphSnapshot,
  type NodeDetail,
  type Project,
  type SearchHit,
  type SearchMatch,
  type SeqChange,
  type Session,
} from '@claude-canvas/shared';
import { DERIVED_TABLES, SCHEMA_SQL } from './schema.js';

/** `file` of transcript and meta events is relative to projectsDir with `/` separators. */
export type RawEvent =
  | { source: 'transcript'; file: string; offset: number; line: string; recordType: string; sessionId: string; agentId: string | null }
  | {
      source: 'hook';
      receivedAt: string;
      eventName: string;
      sessionId: string | null;
      payload: string;
      /** Project derived from the payload's transcript_path at ingest; replay uses this stored value. */
      projectId?: string | null;
    }
  | { source: 'meta'; file: string; sessionId: string; agentId: string | null; payload: string }; // custom-title.json, agent-*.meta.json contents
export type StoredRawEvent = RawEvent & { ingestId: number };

/** The change log keeps at most this many rows; older ones are pruned down to 90% of it. */
export const CHANGE_LOG_MAX_ROWS = 200_000;
/** Rows inserted into the change log between two size checks. */
const PRUNE_CHECK_EVERY = 10_000;

export type StoreDiagnostics = Pick<Diagnostics, 'unknownRecords' | 'lastHookAt' | 'files'>;

export interface StoreOptions {
  changeLogMaxRows?: number;
  pruneCheckEvery?: number;
  /** Size the WAL file is truncated to when it restarts (default 64 MB). */
  walSizeLimitBytes?: number;
  /** Receives every SQL statement executed (tests). */
  verbose?: (sql: unknown) => void;
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
  /**
   * Case-insensitive (ASCII only, as SQLite LIKE) literal substring search over session title, id, git branch, cwd
   * and the summaries of main-thread prompt nodes. Newest activity first; fewer than SEARCH_MIN_CHARS characters
   * after trimming gives []. `limit` is clamped to 1..SEARCH_MAX_LIMIT.
   */
  searchSessions(query: string, limit: number): SearchHit[];
  /** Query plans (EXPLAIN QUERY PLAN detail lines) of the two statements searchSessions runs; for tests. */
  searchPlans(): { sessions: string[]; prompts: string[] };
  getGraph(sessionId: string): GraphSnapshot | null;
  /** The GraphSnapshot already serialized, built from the stored bodies without parsing them. */
  getGraphJson(sessionId: string): string | null;
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
  allSessionIdsInRaw(): string[];
  /** Clears derived tables, the change log and unknown_stat; keeps raw_event, file_offset and meta. */
  clearDerived(): void;
  bumpUnknown(recordType: string, sample: string): void;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  deleteMeta(key: string): void;
  /** True when raw_event holds at least one row. */
  hasRawEvents(): boolean;
  /** Random id generated when the database file was created; stable across restarts and rebuilds. */
  epoch(): string;
  /** Latest receivedAt of any stored hook event (kept in `meta`, no raw_event scan). */
  lastHookAt(): string | null;
  /** Hook counts and latest receivedAt per event name (ascending), read from the hook_stat counters only. */
  hookEventStats(): Diagnostics['hookEvents'];
  /** The stored part of Diagnostics; the API adds the pipeline's live fields. */
  diagnostics(): StoreDiagnostics;
  close(): void;
}

const SAMPLE_MAX = 500;
/** meta key set once hook_stat holds every stored hook row (backfilled, or created empty with a new database). */
const HOOK_STAT_READY = 'hook_stat_ready';

interface RawRow {
  ingest_id: number;
  source: string;
  file: string | null;
  offset: number | null;
  record_type: string | null;
  session_id: string | null;
  agent_id: string | null;
  event_name: string | null;
  received_at: string | null;
  project_id: string | null;
  body: string;
}

function toStoredRaw(r: RawRow): StoredRawEvent {
  switch (r.source) {
    case 'transcript':
      return {
        ingestId: r.ingest_id,
        source: 'transcript',
        file: r.file!,
        offset: r.offset!,
        line: r.body,
        recordType: r.record_type!,
        sessionId: r.session_id!,
        agentId: r.agent_id,
      };
    case 'hook':
      return {
        ingestId: r.ingest_id,
        source: 'hook',
        receivedAt: r.received_at!,
        eventName: r.event_name!,
        sessionId: r.session_id,
        payload: r.body,
        projectId: r.project_id,
      };
    default:
      return {
        ingestId: r.ingest_id,
        source: 'meta',
        file: r.file!,
        sessionId: r.session_id!,
        agentId: r.agent_id,
        payload: r.body,
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
/** The WAL file is truncated to this size when it restarts; without a limit it keeps its high-water mark on disk. */
const WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * Auto-checkpoints on the main connection copy the WAL into the database file synchronously, stalling the event loop
 * for hundreds of milliseconds during an import. They are disabled here and a worker thread checkpoints instead.
 */
function startCheckpointer(db: Database.Database, dbPath: string): Worker | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = ['checkpointer.js', 'checkpointer.ts'].map((f) => path.join(here, f)).find((f) => fs.existsSync(f));
  if (script === undefined) return null; // keep SQLite's automatic checkpoints
  try {
    const worker = new Worker(script, { workerData: { dbPath, intervalMs: CHECKPOINT_INTERVAL_MS } });
    worker.on('error', () => {
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

export function openStore(dbPath: string, options: StoreOptions = {}): Store {
  const maxRows = options.changeLogMaxRows ?? CHANGE_LOG_MAX_ROWS;
  const pruneEvery = options.pruneCheckEvery ?? PRUNE_CHECK_EVERY;
  const db = new Database(dbPath, options.verbose ? { verbose: options.verbose } : {});
  db.pragma('journal_mode = WAL');
  // A WAL that grew during an import is cut back to this size the next time it restarts after a full checkpoint.
  db.pragma(`journal_size_limit = ${options.walSizeLimitBytes ?? WAL_SIZE_LIMIT_BYTES}`);
  db.exec(SCHEMA_SQL);
  const checkpointer = dbPath === ':memory:' || dbPath === '' ? null : startCheckpointer(db, dbPath);

  // INSERT ... SELECT ... WHERE NOT EXISTS (rather than INSERT OR IGNORE): with AUTOINCREMENT, an
  // ignored insert would still consume an ingest_id and leave gaps.
  const insertRawTranscript = db.prepare(
    `INSERT INTO raw_event (source, file, "offset", line_hash, record_type, session_id, agent_id, body)
     SELECT 'transcript', @file, @offset, @lineHash, @recordType, @sessionId, @agentId, @line
     WHERE NOT EXISTS (
       SELECT 1 FROM raw_event WHERE source = 'transcript' AND file = @file AND line_hash = @lineHash
     )`,
  );
  const insertRawHook = db.prepare(
    `INSERT INTO raw_event (source, event_name, received_at, session_id, project_id, body)
     VALUES ('hook', @eventName, @receivedAt, @sessionId, @projectId, @payload)`,
  );
  const insertRawMeta = db.prepare(
    `INSERT INTO raw_event (source, file, session_id, agent_id, body)
     VALUES ('meta', @file, @sessionId, @agentId, @payload)`,
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
  const selectAnyRaw = db.prepare(`SELECT 1 FROM raw_event LIMIT 1`).pluck();
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
  const selectNodeBody = db.prepare(`SELECT body FROM node WHERE session_id = ? AND id = ?`).pluck();
  const updateNode = db.prepare(`UPDATE node SET body = ? WHERE session_id = ? AND id = ?`);
  const upsertDetail = db.prepare(`INSERT OR REPLACE INTO node_detail (session_id, node_id, detail) VALUES (?, ?, ?)`);
  const selectDetail = db.prepare(`SELECT detail FROM node_detail WHERE session_id = ? AND node_id = ?`).pluck();
  const selectNodeWithDetail = db.prepare(
    `SELECT d.detail AS detail FROM node n
     LEFT JOIN node_detail d ON d.session_id = n.session_id AND d.node_id = n.id
     WHERE n.session_id = ? AND n.id = ?`,
  );
  const insertEdge = db.prepare(`INSERT OR REPLACE INTO edge (session_id, id, body) VALUES (?, ?, ?)`);

  // Active = effective status running/awaiting_*: a `running` session older than STALE_AFTER_MS is stale, not active.
  // strftime normalizes the stored ISO timestamp so it compares correctly with the cutoff's toISOString().
  // The stale rule below (running and last activity older than STALE_AFTER_MS) must stay in sync with
  // effectiveStatus in shared/status.ts. One divergence: an unparseable last_activity_at is not counted active
  // here (strftime gives NULL, so the >= test is false), while effectiveStatus is never stale for it (a NaN
  // comparison is false), i.e. it would count as active.
  const selectProjects = db.prepare(
    `SELECT project_id AS id, json_extract(body, '$.cwd') AS cwd, COUNT(*) AS sessionCount,
            SUM(CASE WHEN status IN ('awaiting_input', 'awaiting_permission') THEN 1
                     WHEN status = 'running' AND strftime('%Y-%m-%dT%H:%M:%fZ', last_activity_at) >= @cutoff THEN 1
                     ELSE 0 END) AS activeSessionCount
     FROM session GROUP BY project_id, cwd ORDER BY project_id`,
  );
  const selectSessions = db.prepare(`SELECT body FROM session WHERE project_id = ? ORDER BY last_activity_at DESC, id`);
  const selectSession = db.prepare(`SELECT body FROM session WHERE id = ?`).pluck();
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
  const selectEdgeBodies = db.prepare(`SELECT body FROM edge WHERE session_id = ? ORDER BY rowid`).pluck();
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
    `SELECT body FROM raw_event WHERE source = 'meta' AND file = ? ORDER BY ingest_id DESC LIMIT 1`,
  );
  const selectRawSessionIds = db.prepare(
    `SELECT DISTINCT session_id AS id FROM raw_event WHERE session_id IS NOT NULL ORDER BY session_id`,
  );
  const upsertUnknown = db.prepare(
    `INSERT INTO unknown_stat (record_type, count, sample) VALUES (?, 1, ?)
     ON CONFLICT(record_type) DO UPDATE SET count = count + 1`,
  );
  const selectHookStats = db.prepare(
    `SELECT event_name AS eventName, count, last_at AS lastAt FROM hook_stat ORDER BY event_name`,
  );
  const bumpHookStat = db.prepare(
    `INSERT INTO hook_stat (event_name, count, last_at) VALUES (?, 1, ?)
     ON CONFLICT(event_name) DO UPDATE SET count = count + 1, last_at = MAX(last_at, excluded.last_at)`,
  );
  const insertHookTx = db.transaction((event: Extract<RawEvent, { source: 'hook' }>): number => {
    const id = Number(insertRawHook.run({ ...event, projectId: event.projectId ?? null }).lastInsertRowid);
    upsertLaterMeta.run('last_hook_at', event.receivedAt);
    bumpHookStat.run(event.eventName, event.receivedAt);
    return id;
  });
  // Databases from before hook_stat existed: backfill it once (one transaction, one raw_event pass), then never again.
  // A database created just now has nothing to backfill.
  db.transaction(() => {
    if (selectMeta.get(HOOK_STAT_READY) !== undefined) return;
    if (!created && db.prepare(`SELECT 1 FROM hook_stat LIMIT 1`).get() === undefined) {
      db.exec(
        `INSERT INTO hook_stat (event_name, count, last_at)
         SELECT event_name, COUNT(*), MAX(received_at) FROM raw_event
         WHERE source = 'hook' AND event_name IS NOT NULL AND received_at IS NOT NULL
         GROUP BY event_name`,
      );
    }
    upsertMeta.run(HOOK_STAT_READY, '1');
  })();
  const selectUnknown = db.prepare(`SELECT record_type, count, sample FROM unknown_stat ORDER BY record_type`);
  const selectFiles = db.prepare(`SELECT file, "offset", size FROM file_offset ORDER BY file`);

  function applyOne(c: Change): void {
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
      case 'node_added':
        insertNode.run(c.node.sessionId, c.node.id, JSON.stringify(c.node));
        upsertDetail.run(c.node.sessionId, c.node.id, JSON.stringify(c.detail ?? {}));
        break;
      case 'node_updated': {
        const body = selectNodeBody.get(c.sessionId, c.id) as string | undefined;
        if (body === undefined) break; // updates to unknown nodes are ignored, as in shared applyChange
        updateNode.run(JSON.stringify({ ...(JSON.parse(body) as object), ...c.patch }), c.sessionId, c.id);
        if (c.detail !== undefined) {
          // node_detail is touched only when the update carries detail.
          const prev = selectDetail.get(c.sessionId, c.id) as string | undefined;
          const merged = { ...(prev === undefined ? {} : (JSON.parse(prev) as object)), ...c.detail };
          upsertDetail.run(c.sessionId, c.id, JSON.stringify(merged));
        }
        break;
      }
      case 'edge_added':
        insertEdge.run(c.edge.sessionId, c.edge.id, JSON.stringify(c.edge));
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
    changes.forEach((c, i) => {
      if (c.type === 'session_upserted' && lastUpsert.get(c.session.id) !== i) return;
      applyOne(c);
      const logged = withoutDetail(c);
      const seq = Number(insertChange.run(changeSessionId(c), JSON.stringify(logged)).lastInsertRowid);
      out.push({ ...logged, seq });
    });
    maybePrune(out.length);
    return out;
  });

  const clearDerivedTx = db.transaction(() => {
    for (const t of DERIVED_TABLES) db.exec(`DELETE FROM ${t}`);
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
    const edges = selectEdgeBodies.all(sessionId) as string[];
    // The last assigned seq (not the session's own max): the snapshot reflects every change up to it, and it is never
    // below minSeq() - 1, so a client resubscribing with it is never told to resync again.
    const seq = lastSeq();
    return `{"session":${session},"nodes":[${nodes.join(',')}],"edges":[${edges.join(',')}],"seq":${seq}}`;
  };

  const lastSeq = (): number => (selectSeqCounter.get() as number | undefined) ?? 0;
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
        const res = insertRawTranscript.run({ ...event, lineHash });
        return res.changes === 0 ? null : Number(res.lastInsertRowid);
      }
      if (event.source === 'hook') return insertHookTx(event);
      return Number(insertRawMeta.run(event).lastInsertRowid);
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
      const rows = selectProjects.all({ cutoff }) as { id: string; cwd: string | null; sessionCount: number; activeSessionCount: number }[];
      const byId = new Map<string, { project: Project; best: { cwd: string; n: number } | null }>();
      for (const r of rows) {
        let entry = byId.get(r.id);
        if (!entry) {
          entry = { project: { id: r.id, cwd: null, sessionCount: 0, activeSessionCount: 0 }, best: null };
          byId.set(r.id, entry);
        }
        entry.project.sessionCount += r.sessionCount;
        entry.project.activeSessionCount += r.activeSessionCount;
        if (r.cwd !== null && r.cwd.replace(/[^A-Za-z0-9]/g, '-') === r.id) {
          const b = entry.best;
          if (b === null || r.sessionCount > b.n || (r.sessionCount === b.n && r.cwd < b.cwd)) entry.best = { cwd: r.cwd, n: r.sessionCount };
        }
      }
      return [...byId.values()].map(({ project, best }) => ({ ...project, cwd: best?.cwd ?? null }));
    },
    listSessions(projectId) {
      return (selectSessions.all(projectId) as { body: string }[]).map((r) => JSON.parse(r.body) as Session);
    },
    getSession,
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
    getNodeDetail(sessionId, nodeId) {
      const row = selectNodeWithDetail.get(sessionId, nodeId) as { detail: string | null } | undefined;
      if (!row) return null;
      const d = row.detail === null ? {} : (JSON.parse(row.detail) as Partial<NodeDetail>);
      return { input: null, output: null, text: null, raw: null, ...d, nodeId };
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
        out.push(toStoredRaw(row));
        bytes += row.body.length;
        if (bytes >= maxBytes) break; // ends the iteration (and the statement)
      }
      return out;
    },
    latestMeta(file) {
      const row = selectLatestMeta.get(file) as { body: string } | undefined;
      return row?.body ?? null;
    },
    allSessionIdsInRaw() {
      return (selectRawSessionIds.all() as { id: string }[]).map((r) => r.id);
    },
    clearDerived() {
      clearDerivedTx();
    },
    bumpUnknown(recordType, sample) {
      upsertUnknown.run(recordType, sample.slice(0, SAMPLE_MAX));
    },
    lastHookAt,
    epoch: () => epoch,
    getMeta: (key) => (selectMeta.get(key) as string | undefined) ?? null,
    setMeta(key, value) {
      upsertMeta.run(key, value);
    },
    deleteMeta(key) {
      deleteMeta.run(key);
    },
    hookEventStats: () => selectHookStats.all() as Diagnostics['hookEvents'],
    hasRawEvents: () => selectAnyRaw.get() !== undefined,
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
    close() {
      checkpointer?.postMessage('close');
      db.close();
    },
  };
}
