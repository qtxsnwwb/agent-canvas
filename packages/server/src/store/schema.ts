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
  body        TEXT NOT NULL,   -- read through decodeBody (codec.ts): text when enc = 0, raw deflate (BLOB) when enc = 1
  origin      TEXT NOT NULL DEFAULT 'claude', -- 'claude' | 'codex'; added by migrateSchema on older databases
  enc         INTEGER NOT NULL DEFAULT 0      -- body encoding (codec.ts); added by migrateSchema on older databases
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
  detail     TEXT NOT NULL,    -- read through decodeBody (codec.ts), as raw_event.body
  enc        INTEGER NOT NULL DEFAULT 0, -- detail encoding; added by migrateSchema on older databases
  PRIMARY KEY (session_id, node_id)
);

CREATE TABLE IF NOT EXISTS edge (
  session_id TEXT NOT NULL,
  id         TEXT NOT NULL,
  body       TEXT NOT NULL,
  PRIMARY KEY (session_id, id)
);

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

-- Small key/value table: epoch, last_hook_at, normalizer_version, rebuild_in_progress, hook_stat_ready, a poll
-- source's note per unit it read completely ('poll:' + store key, e.g. poll:cursor:<id>; kept by rebuild), and the
-- storage migration's progress ('storage:' keys, migrate-storage.ts).
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Steps that bring an older database up to SCHEMA_SQL; migrateSchema (store.ts) runs each one only when its column is
 * missing, after SCHEMA_SQL, in one transaction. rawEventOrigin: every existing row is a Claude Code row.
 * hookStatByOrigin: rekeys hook_stat by (origin, event name), keeping the existing counters as 'claude'. rawEventEnc /
 * nodeDetailEnc: every existing row holds plain text (enc 0); the storage migration (migrate-storage.ts) compresses them
 * later, in the background.
 */
export const MIGRATIONS = {
  rawEventOrigin: `ALTER TABLE raw_event ADD COLUMN origin TEXT NOT NULL DEFAULT 'claude'`,
  rawEventEnc: `ALTER TABLE raw_event ADD COLUMN enc INTEGER NOT NULL DEFAULT 0`,
  nodeDetailEnc: `ALTER TABLE node_detail ADD COLUMN enc INTEGER NOT NULL DEFAULT 0`,
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
