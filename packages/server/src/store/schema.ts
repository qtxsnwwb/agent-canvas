/** Tables holding data derived from raw events; cleared by Store.clearDerived(). */
export const DERIVED_TABLES = ['session', 'node', 'edge', 'change_log'] as const;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS raw_event (
  ingest_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,
  file        TEXT,
  "offset"    INTEGER,
  line_hash   TEXT,
  record_type TEXT,
  session_id  TEXT,
  agent_id    TEXT,
  event_name  TEXT,
  received_at TEXT,
  body        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS raw_event_transcript_dedupe
  ON raw_event (file, line_hash) WHERE source = 'transcript';
CREATE INDEX IF NOT EXISTS raw_event_session ON raw_event (session_id, ingest_id);
CREATE INDEX IF NOT EXISTS raw_event_meta ON raw_event (file, ingest_id) WHERE source = 'meta';

CREATE TABLE IF NOT EXISTS file_offset (
  file     TEXT PRIMARY KEY,
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

CREATE TABLE IF NOT EXISTS node (
  session_id TEXT NOT NULL,
  id         TEXT NOT NULL,
  body       TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (session_id, id)
);

CREATE TABLE IF NOT EXISTS edge (
  session_id TEXT NOT NULL,
  id         TEXT NOT NULL,
  body       TEXT NOT NULL,
  PRIMARY KEY (session_id, id)
);

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
`;
