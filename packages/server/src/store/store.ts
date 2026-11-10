import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  STALE_AFTER_MS,
  type Change,
  type Diagnostics,
  type GraphEdge,
  type GraphNode,
  type GraphSnapshot,
  type NodeDetail,
  type Project,
  type SeqChange,
  type Session,
} from '@claude-canvas/shared';
import { DERIVED_TABLES, SCHEMA_SQL } from './schema.js';

export type RawEvent =
  | { source: 'transcript'; file: string; offset: number; line: string; recordType: string; sessionId: string; agentId: string | null }
  | { source: 'hook'; receivedAt: string; eventName: string; sessionId: string | null; payload: string }
  | { source: 'meta'; file: string; sessionId: string; agentId: string | null; payload: string }; // custom-title.json, agent-*.meta.json contents
export type StoredRawEvent = RawEvent & { ingestId: number };

export interface Store {
  /** Returns the ingestId, or null for a duplicate transcript line. */
  insertRaw(event: RawEvent): number | null;
  /** 0 when the file has no recorded offset. */
  getOffset(file: string): number;
  setOffset(file: string, offset: number, size: number): void;
  /** Single transaction; assigns consecutive seq values. */
  applyChanges(changes: Change[]): SeqChange[];
  listProjects(): Project[];
  /** Ordered by lastActivityAt descending. */
  listSessions(projectId: string): Session[];
  getSession(sessionId: string): Session | null;
  getGraph(sessionId: string): GraphSnapshot | null;
  getNodeDetail(sessionId: string, nodeId: string): NodeDetail | null;
  changesSince(seq: number, sessionId?: string): SeqChange[];
  /** Ordered by ingestId ascending. */
  rawForSession(sessionId: string): StoredRawEvent[];
  /** Keyset page over rawForSession: ingestId strictly greater than afterIngestId, ascending, at most limit rows. */
  rawForSessionAfter(sessionId: string, afterIngestId: number, limit: number): StoredRawEvent[];
  /** Payload of the most recent meta raw event for that file, or null. */
  latestMeta(file: string): string | null;
  allSessionIdsInRaw(): string[];
  /** Clears derived tables and the change log; keeps raw_event and file_offset. */
  clearDerived(): void;
  bumpUnknown(recordType: string, sample: string): void;
  diagnostics(): Diagnostics;
  close(): void;
}

const SAMPLE_MAX = 500;

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

export function openStore(dbPath: string): Store {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);

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
    `INSERT INTO raw_event (source, event_name, received_at, session_id, body)
     VALUES ('hook', @eventName, @receivedAt, @sessionId, @payload)`,
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

  const insertChange = db.prepare(`INSERT INTO change_log (session_id, body) VALUES (?, ?)`);
  const upsertSession = db.prepare(
    `INSERT INTO session (id, project_id, status, last_activity_at, body)
     VALUES (@id, @projectId, @status, @lastActivityAt, @body)
     ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, status = excluded.status,
       last_activity_at = excluded.last_activity_at, body = excluded.body`,
  );
  const insertNode = db.prepare(`INSERT OR REPLACE INTO node (session_id, id, body, detail) VALUES (?, ?, ?, ?)`);
  const selectNode = db.prepare(`SELECT body, detail FROM node WHERE session_id = ? AND id = ?`);
  const updateNode = db.prepare(`UPDATE node SET body = ?, detail = ? WHERE session_id = ? AND id = ?`);
  const insertEdge = db.prepare(`INSERT OR REPLACE INTO edge (session_id, id, body) VALUES (?, ?, ?)`);

  // Active = effective status running/awaiting_*: a `running` session older than STALE_AFTER_MS is stale, not active.
  // strftime normalizes the stored ISO timestamp so it compares correctly with the cutoff's toISOString().
  const selectProjects = db.prepare(
    `SELECT project_id AS id, MAX(json_extract(body, '$.cwd')) AS cwd, COUNT(*) AS sessionCount,
            SUM(CASE WHEN status IN ('awaiting_input', 'awaiting_permission') THEN 1
                     WHEN status = 'running' AND strftime('%Y-%m-%dT%H:%M:%fZ', last_activity_at) >= @cutoff THEN 1
                     ELSE 0 END) AS activeSessionCount
     FROM session GROUP BY project_id ORDER BY project_id`,
  );
  const selectSessions = db.prepare(`SELECT body FROM session WHERE project_id = ? ORDER BY last_activity_at DESC, id`);
  const selectSession = db.prepare(`SELECT body FROM session WHERE id = ?`);
  const selectNodes = db.prepare(`SELECT body FROM node WHERE session_id = ? ORDER BY rowid`);
  const selectEdges = db.prepare(`SELECT body FROM edge WHERE session_id = ? ORDER BY rowid`);
  const selectMaxSeq = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM change_log WHERE session_id = ?`);
  const selectChanges = db.prepare(`SELECT seq, body FROM change_log WHERE seq > ? ORDER BY seq`);
  const selectChangesForSession = db.prepare(
    `SELECT seq, body FROM change_log WHERE seq > ? AND session_id = ? ORDER BY seq`,
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
  const selectUnknown = db.prepare(`SELECT record_type, count, sample FROM unknown_stat ORDER BY record_type`);
  const selectLastHook = db.prepare(`SELECT MAX(received_at) AS at FROM raw_event WHERE source = 'hook'`);
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
        insertNode.run(c.node.sessionId, c.node.id, JSON.stringify(c.node), JSON.stringify(c.detail ?? {}));
        break;
      case 'node_updated': {
        const row = selectNode.get(c.sessionId, c.id) as { body: string; detail: string } | undefined;
        if (!row) break; // updates to unknown nodes are ignored, as in shared applyChange
        const node = { ...(JSON.parse(row.body) as GraphNode), ...c.patch };
        const detail = { ...(JSON.parse(row.detail) as object), ...(c.detail ?? {}) };
        updateNode.run(JSON.stringify(node), JSON.stringify(detail), c.sessionId, c.id);
        break;
      }
      case 'edge_added':
        insertEdge.run(c.edge.sessionId, c.edge.id, JSON.stringify(c.edge));
        break;
    }
  }

  const applyChangesTx = db.transaction((changes: Change[]): SeqChange[] => {
    const out: SeqChange[] = [];
    for (const c of changes) {
      const seq = Number(insertChange.run(changeSessionId(c), JSON.stringify(c)).lastInsertRowid);
      applyOne(c);
      out.push({ ...c, seq });
    }
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
    const row = selectSession.get(sessionId) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as Session) : null;
  };

  return {
    insertRaw(event) {
      if (event.source === 'transcript') {
        const lineHash = createHash('sha1').update(event.line).digest('hex');
        const res = insertRawTranscript.run({ ...event, lineHash });
        return res.changes === 0 ? null : Number(res.lastInsertRowid);
      }
      if (event.source === 'hook') return Number(insertRawHook.run(event).lastInsertRowid);
      return Number(insertRawMeta.run(event).lastInsertRowid);
    },
    getOffset(file) {
      const row = selectOffset.get(file) as { off: number } | undefined;
      return row?.off ?? 0;
    },
    setOffset(file, offset, size) {
      upsertOffset.run({ file, offset, size });
    },
    applyChanges(changes) {
      return applyChangesTx(changes);
    },
    listProjects() {
      const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
      return (selectProjects.all({ cutoff }) as Project[]).map((p) => ({
        id: p.id,
        cwd: p.cwd ?? null,
        sessionCount: p.sessionCount,
        activeSessionCount: p.activeSessionCount,
      }));
    },
    listSessions(projectId) {
      return (selectSessions.all(projectId) as { body: string }[]).map((r) => JSON.parse(r.body) as Session);
    },
    getSession,
    getGraph(sessionId) {
      const session = getSession(sessionId);
      if (!session) return null;
      const nodes = (selectNodes.all(sessionId) as { body: string }[]).map((r) => JSON.parse(r.body) as GraphNode);
      const edges = (selectEdges.all(sessionId) as { body: string }[]).map((r) => JSON.parse(r.body) as GraphEdge);
      const { seq } = selectMaxSeq.get(sessionId) as { seq: number };
      return { session, nodes, edges, seq };
    },
    getNodeDetail(sessionId, nodeId) {
      const row = selectNode.get(sessionId, nodeId) as { detail: string } | undefined;
      if (!row) return null;
      const d = JSON.parse(row.detail) as Partial<NodeDetail>;
      return { input: null, output: null, text: null, raw: null, ...d, nodeId };
    },
    changesSince(seq, sessionId) {
      return toChanges(sessionId === undefined ? selectChanges.all(seq) : selectChangesForSession.all(seq, sessionId));
    },
    rawForSession(sessionId) {
      return (selectRawForSession.all(sessionId) as RawRow[]).map(toStoredRaw);
    },
    rawForSessionAfter(sessionId, afterIngestId, limit) {
      return (selectRawAfter.all(sessionId, afterIngestId, limit) as RawRow[]).map(toStoredRaw);
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
    diagnostics() {
      return {
        unknownRecords: (selectUnknown.all() as { record_type: string; count: number; sample: string }[]).map((r) => ({
          recordType: r.record_type,
          count: r.count,
          sample: r.sample,
        })),
        lastHookAt: (selectLastHook.get() as { at: string | null }).at,
        files: (selectFiles.all() as { file: string; offset: number; size: number }[]).map((r) => ({
          path: r.file,
          offset: r.offset,
          size: r.size,
        })),
      };
    },
    close() {
      db.close();
    },
  };
}
