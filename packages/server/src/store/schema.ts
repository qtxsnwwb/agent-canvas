/** Tables holding data derived from raw events; cleared by Store.clearDerived() (rebuild recomputes them). */
export const DERIVED_TABLES = ['session', 'node', 'node_detail', 'edge', 'change_log', 'unknown_stat'] as const;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS raw_event (
  ingest_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,
  file        TEXT,            -- store key: relative to projectsDir, '/' separators (Codex: 'codex:' + relative path)
  project_id  TEXT,            -- hooks: project derived from transcript_path at ingest (null when unknown); transcript: set by sources whose keys do not name the project (Codex)
  "offset"    INTEGER,
  line_hash   TEXT,
  record_type TEXT,
  session_id  TEXT,
  agent_id    TEXT,
  event_name  TEXT,
  received_at TEXT,
  data        TEXT NOT NULL,   -- read through decodeBody (codec.ts): text when enc = 0, zlib stream (BLOB) when enc = 1;
                               -- called "body" before storage format 1 (renamed so older builds fail to open the database)
  origin      TEXT NOT NULL DEFAULT 'claude', -- 'claude' | 'codex'; added by migrateSchema on older databases
  enc         INTEGER NOT NULL DEFAULT 0      -- data encoding (codec.ts); added by migrateSchema on older databases
);
CREATE UNIQUE INDEX IF NOT EXISTS raw_event_transcript_dedupe
  ON raw_event (file, line_hash) WHERE source = 'transcript';
CREATE INDEX IF NOT EXISTS raw_event_session ON raw_event (session_id, ingest_id);
-- raw_event_hook (event_name, received_at) WHERE source = 'hook' served the old hook-stats aggregation; openStore drops
-- it after the one-time hook_stat backfill, which still uses it on databases that have it.
CREATE INDEX IF NOT EXISTS raw_event_meta ON raw_event (file, ingest_id) WHERE source = 'meta';

-- Per-(origin, event name) hook counters, bumped in the transaction that inserts the raw hook row. Not derived graph
-- data: rebuild (clearDerived) leaves it alone. Backfilled once from the raw log when empty (databases from before it
-- existed). Databases from before the origin dimension had it keyed by event name only: migrateSchema rekeys it.
CREATE TABLE IF NOT EXISTS hook_stat (
  origin     TEXT NOT NULL,
  event_name TEXT NOT NULL,
  count      INTEGER NOT NULL,
  last_at    TEXT NOT NULL,
  PRIMARY KEY (origin, event_name)
);

-- Sessions whose committed raw events are ahead of their derived rows (a hook whose processing failed was stored
-- alone). The pipeline re-derives such a session from its raw events on the next touch and removes the row in the same
-- transaction. Not derived data: clearDerived leaves it alone (a full rebuild clears it explicitly).
CREATE TABLE IF NOT EXISTS dirty_session (
  session_id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS file_offset (
  file     TEXT PRIMARY KEY,   -- store key, as raw_event.file
  "offset" INTEGER NOT NULL,
  size     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  status           TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  body             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS session_project ON session (project_id, last_activity_at);

-- body only: node detail (full input/output/text) lives in node_detail, off the snapshot path.
CREATE TABLE IF NOT EXISTS node (
  session_id TEXT NOT NULL,
  id         TEXT NOT NULL,
  body       TEXT NOT NULL,
  PRIMARY KEY (session_id, id)
);

-- Search over main-thread prompts: the search statements repeat this exact predicate so SQLite can use the index.
-- node_prompt was an earlier, broader version of it (it also covered subagent prompts).
DROP INDEX IF EXISTS node_prompt;
CREATE INDEX IF NOT EXISTS node_main_prompt ON node (session_id)
  WHERE json_extract(body, '$.kind') = 'prompt' AND json_extract(body, '$.agentId') IS NULL;

CREATE TABLE IF NOT EXISTS node_detail (
  session_id TEXT NOT NULL,
  node_id    TEXT NOT NULL,
  data       TEXT NOT NULL,    -- read through decodeBody (codec.ts), as raw_event.data; called "detail" before format 1
  enc        INTEGER NOT NULL DEFAULT 0, -- detail encoding; added by migrateSchema on older databases
  PRIMARY KEY (session_id, node_id)
);

-- One row per edge, stored once: no JSON body, no copy of the id. An edge's id is from_id || '->' || to_id || tag
-- (tag '' or ':fork', as every normalizer forms it); an id of any other form is kept whole in tag as char(1) || id.
-- kind: 0 sequence, 1 fork, 2 spawn. ord: seq of the change that last wrote the edge (snapshot order). Edges of a
-- session are a prefix range of the primary key (WITHOUT ROWID: the table is that b-tree, no separate index).
-- Databases from before this layout have edge (session_id, id, body): migrateSchema replaces that table (derived data;
-- the normalizer version bump makes start rebuild it).
CREATE TABLE IF NOT EXISTS edge (
  session_id TEXT NOT NULL,
  from_id    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  tag        TEXT NOT NULL,
  kind       INTEGER NOT NULL,
  ord        INTEGER NOT NULL,
  PRIMARY KEY (session_id, from_id, to_id, tag)
) WITHOUT ROWID;

-- Bounded (see CHANGE_LOG_MAX_ROWS); bodies never carry node detail.
CREATE TABLE IF NOT EXISTS change_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  body       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS change_log_session ON change_log (session_id, seq);

CREATE TABLE IF NOT EXISTS unknown_stat (
  record_type TEXT PRIMARY KEY,
  count       INTEGER NOT NULL,
  sample      TEXT NOT NULL
);

-- The user's bookmarks (spec 2026-11-24-bookmarks-design.md 7). Not derived data: not in DERIVED_TABLES, so rebuild,
-- the automatic rebuild on start and compact keep its rows; an older build opening the database never reads it.
-- node_id '' marks a session bookmark (nodeId null in the API), so (session_id, node_id) is one place, also for deleted
-- rows (creating on a place whose row is soft-deleted removes that row first). AUTOINCREMENT: an id is never reused,
-- so the undo of a purged bookmark cannot restore another one. snapshot: JSON BookmarkSnapshot, written once.
-- deleted_at: soft delete (lists leave the row out; restore clears it); rows deleted over 24 h ago are purged on a write.
CREATE TABLE IF NOT EXISTS bookmark (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  node_id         TEXT NOT NULL,
  note            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  note_updated_at TEXT,
  deleted_at      TEXT,
  snapshot        TEXT NOT NULL,
  UNIQUE (session_id, node_id)
);

-- Small key/value table: epoch, last_hook_at, normalizer_version, rebuild_in_progress, hook_stat_ready, a poll
-- source's note per unit it read completely ('poll:' + store key, e.g. poll:cursor:<id>; kept by rebuild), and the
-- storage migration's progress ('storage:' keys, migrate-storage.ts).
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Index of the edges by their target node, for removing a node's incoming edges (node_removed) without scanning the
 * session's edges. Created by openStore after migrateSchema (edgeCompact recreates the edge table, which drops its
 * indexes), on new and existing databases alike: an extra index changes nothing for an older build that opens the
 * database afterwards (it is maintained by SQLite on every write). Statements that need it name it with INDEXED BY:
 * without ANALYZE statistics the planner keeps the primary key's session range for `to_id = ?`.
 */
export const EDGE_TO_INDEX = 'edge_to';
export const EDGE_TO_INDEX_SQL = `CREATE INDEX IF NOT EXISTS ${EDGE_TO_INDEX} ON edge (session_id, to_id)`;

/**
 * Indexes of the attention page's queries (store.ts ATTENTION_QUERIES), created by openStore at every open like
 * EDGE_TO_INDEX (a no-op once they exist; no rebuild needed: SQLite fills an index from the rows already stored, and
 * maintains it on every write, also for an older build). The queries repeat each partial predicate verbatim so SQLite
 * uses the index. Without them each query read every node (or every raw event) of the session; measured on a 500,000-node,
 * 1.3 GB database: 130-280 ms per call for a 100,000-node session, against under 0.2 ms with the index. Creating the three
 * on that database at its first open took 3.8-4.1 s in all (+19 MB); writes through applyChanges got about 6% slower.
 * - node_main_time: a session's main-thread nodes by time (mainTailNodes: the current turn's tail). Its predicate has a
 *   term (`timestamp IS NOT NULL`) the older main-thread statements (latestMainPromptAt, the session search) do not
 *   contain, so they keep node_main_prompt instead of walking every main-thread node through this one.
 * - node_awaiting_permission: the few nodes waiting for permission, of any thread (a subagent's included).
 * - raw_event_session_hook: a session's hook events by time (hookEventsSince: StopFailure and the like leave no node).
 */
export const ATTENTION_INDEXES = ['node_main_time', 'node_awaiting_permission', 'raw_event_session_hook'] as const;
export const ATTENTION_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS node_main_time ON node (session_id, json_extract(body, '$.timestamp'))
  WHERE json_extract(body, '$.agentId') IS NULL AND json_extract(body, '$.timestamp') IS NOT NULL;
CREATE INDEX IF NOT EXISTS node_awaiting_permission ON node (session_id)
  WHERE json_extract(body, '$.status') = 'awaiting_permission';
CREATE INDEX IF NOT EXISTS raw_event_session_hook ON raw_event (session_id, received_at) WHERE source = 'hook';
`;

/**
 * Steps that bring an older database up to SCHEMA_SQL; migrateSchema (store.ts) runs each one only when its column is
 * missing, after SCHEMA_SQL, in one transaction. rawEventOrigin: every existing row is a Claude Code row.
 * hookStatByOrigin: rekeys hook_stat by (origin, event name), keeping the existing counters as 'claude'. rawEventEnc /
 * nodeDetailEnc: every existing row holds plain text (enc 0); the storage migration (migrate-storage.ts) compresses them
 * later, in the background. rawEventData / nodeDetailData: the data columns' new names (storage format 1); an older
 * build's statements name `body` / `detail` and fail when it prepares them, so it refuses to run on such a database
 * instead of misreading compressed rows. edgeCompact: replaces the old edge table (session_id, id, body) by the compact layout; its
 * rows are derived data, rebuilt by the rebuild the normalizer version bump triggers.
 */
export const MIGRATIONS = {
  rawEventOrigin: `ALTER TABLE raw_event ADD COLUMN origin TEXT NOT NULL DEFAULT 'claude'`,
  rawEventData: `ALTER TABLE raw_event RENAME COLUMN body TO data`,
  nodeDetailData: `ALTER TABLE node_detail RENAME COLUMN detail TO data`,
  rawEventEnc: `ALTER TABLE raw_event ADD COLUMN enc INTEGER NOT NULL DEFAULT 0`,
  nodeDetailEnc: `ALTER TABLE node_detail ADD COLUMN enc INTEGER NOT NULL DEFAULT 0`,
  edgeCompact: `DROP TABLE edge;
CREATE TABLE IF NOT EXISTS edge (
  session_id TEXT NOT NULL,
  from_id    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  tag        TEXT NOT NULL,
  kind       INTEGER NOT NULL,
  ord        INTEGER NOT NULL,
  PRIMARY KEY (session_id, from_id, to_id, tag)
) WITHOUT ROWID;`,
  hookStatByOrigin: `
CREATE TABLE hook_stat_by_origin (
  origin     TEXT NOT NULL,
  event_name TEXT NOT NULL,
  count      INTEGER NOT NULL,
  last_at    TEXT NOT NULL,
  PRIMARY KEY (origin, event_name)
);
INSERT INTO hook_stat_by_origin (origin, event_name, count, last_at) SELECT 'claude', event_name, count, last_at FROM hook_stat;
DROP TABLE hook_stat;
ALTER TABLE hook_stat_by_origin RENAME TO hook_stat;
`,
} as const;
