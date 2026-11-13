import type { SeqChange } from './change.js';
import type { GraphEdge, GraphNode, NodeKind, Origin, Session } from './model.js';
import type { NotificationKind } from './notifications.js';

export interface GraphSnapshot { session: Session; nodes: GraphNode[]; edges: GraphEdge[]; seq: number }
export interface Diagnostics {
  unknownRecords: { recordType: string; count: number; sample: string }[];
  lastHookAt: string | null;
  /** Hook events received, by origin (ORIGINS order) then event name ascending; an event never received does not appear. */
  hookEvents: { origin: Origin; eventName: string; count: number; lastAt: string }[];
  /**
   * path is the file's store key: relative to the projects directory with `/` separators (Codex files: `codex:` + the
   * path relative to the Codex sessions directory). Cursor conversations are never listed: they are read from a
   * database, with no offsets (their keys, `cursor:<session>` / `cursor:<session>/<subagent>`, appear in ingestFailures).
   */
  files: { path: string; offset: number; size: number }[];
  /** Files (relative path) and hook sessions (`hook:<sessionId>`) whose last ingest attempt failed. */
  ingestFailures: { file: string; error: string; at: string }[];
  /**
   * True while the initial full scan or a rebuild is running, or while a poll source (Cursor) stores records before its
   * first completed round (its first import). Later polls do not count.
   */
  importing: boolean;
  normalizerVersion: number;
  dbEpoch: string;
  /** Codex's sessions directory as configured (null: Codex disabled) and whether it exists (stat only). */
  codex: { sessionsDir: string | null; sessionsDirExists: boolean };
  /**
   * Cursor's state database as configured (null: Cursor disabled) and whether it exists (stat only); lastPollAt /
   * lastError: the Cursor poll source's last completed poll and last error (null when none ran or none failed);
   * hasData: whether any Cursor records are stored (absent from servers before it existed).
   */
  cursor: { dbPath: string | null; dbExists: boolean; lastPollAt: string | null; lastError: string | null; hasData?: boolean };
  /**
   * Desktop notifications (see NotificationStatus): enabled = the master switch. Present whenever the service runs
   * (`agent-canvas start`); absent from servers built without notifications (and from servers before it existed).
   */
  notifications?: {
    enabled: boolean;
    available: boolean;
    lastSentAt: string | null;
    lastSentKind: NotificationKind | 'test' | null;
    lastError: string | null;
    lastErrorAt: string | null;
    settingsError: string | null;
  };
  /**
   * The database file and the one-time storage migration (compressing records stored before compression existed, then
   * VACUUM). fileBytes / walBytes: sizes of the database file and its WAL. migrating: the background migration is
   * running now. migrated / total: progress in row-key positions (about rows; equal once done). vacuum: 'skipped' with
   * vacuumSkipReason (e.g. `low-space: ...`, `busy`, `error: ...`) is retried at the next start and by `agent-canvas
   * compact`. lastError: why the migration or VACUUM failed this run, or how many rows could not be compressed; null
   * when none. unreadableDetails: node details found undecodable (damaged) since the service started; such a detail is
   * served empty with `unreadable: true`. Absent from servers before it existed.
   */
  storage?: {
    fileBytes: number;
    walBytes: number;
    migrating: boolean;
    migrated: number;
    total: number;
    vacuum: 'pending' | 'done' | 'skipped';
    vacuumSkipReason: string | null;
    lastError: string | null;
    unreadableDetails: number;
  };
  /** The content search index; absent from servers before it existed. */
  search?: SearchIndexStatus;
}

/**
 * The content search index (Diagnostics.search). indexing: the index is incomplete (a database from before it existed,
 * or one whose index was found inconsistent at start-up) and is being built in the background; content search then
 * answers from what is indexed. indexed / total: progress in node row positions (about nodes; zeros once complete).
 * lastError: why the build stopped in this run (it is retried at the next start); null while it runs or when none
 * failed. indexing true with lastError null: being built; with lastError set: incomplete, not being built now.
 * skipped: node rows the last build could not index as usual (an unreadable node row, not indexed; or an undecodable
 * detail, indexed from the node's summary only).
 */
export interface SearchIndexStatus { indexing: boolean; indexed: number; total: number; skipped: number; lastError: string | null }

/**
 * One place in a session's contents that contains the query: the node and a plain-text snippet around the first
 * occurrence in the node's searchable text. before / match / after are plain text (never HTML), whitespace collapsed,
 * about CONTENT_SNIPPET_SIDE_CHARS code points on each side; clippedStart / clippedEnd: text was left out there.
 * `at` is the node's timestamp; agentId the subagent thread the node belongs to (null: the main thread).
 */
export interface ContentHit {
  sessionId: string;
  projectId: string;
  origin: Origin;
  sessionTitle: string | null;
  nodeId: string;
  kind: NodeKind;
  toolName: string | null;
  at: string;
  agentId: string | null;
  snippet: { before: string; match: string; after: string; clippedStart: boolean; clippedEnd: boolean };
}

/**
 * GET /api/search/content?q=&origin=&projectId= (400 for an unknown origin). hits: sessions by last activity (newest
 * first), within a session by node time (newest first); at most CONTENT_MAX_HITS_PER_SESSION per session and
 * CONTENT_MAX_SESSIONS sessions. truncated: a limit (or the per-request work budget) left matches out. shortQuery: the
 * query has exactly 2 characters, so only the prompts and replies of sessions active in the last
 * CONTENT_SHORT_QUERY_DAYS days were scanned. indexing: the index is still being built, results may be incomplete.
 * A query under SEARCH_MIN_CHARS characters (after trimming) gives no hits.
 */
export interface ContentSearchResponse { hits: ContentHit[]; truncated: boolean; shortQuery: boolean; indexing: boolean }
export const CONTENT_MAX_HITS_PER_SESSION = 5;
export const CONTENT_MAX_SESSIONS = 50;
export const CONTENT_SHORT_QUERY_DAYS = 30;
export const CONTENT_SNIPPET_SIDE_CHARS = 40;

export type SearchField = 'title' | 'id' | 'branch' | 'cwd' | 'prompt';
/** nodeId is set only for `prompt` matches. */
export interface SearchMatch { field: SearchField; nodeId: string | null; snippet: string }
/** At most 3 matches per session: session fields first (title, id, branch, cwd), then prompts in time order. */
export interface SearchHit { session: Session; matches: SearchMatch[] }
export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_CHARS = 200;
export const SEARCH_SNIPPET_CHARS = 80;
export const SEARCH_MAX_MATCHES = 3;
export const SEARCH_DEFAULT_LIMIT = 30;
export const SEARCH_MAX_LIMIT = 100;
export type ClientMessage =
  | { type: 'subscribe'; scope: 'sessions' }
  | { type: 'subscribe'; scope: 'session'; sessionId: string; sinceSeq: number };
/**
 * `hello` is sent once, right after the socket opens; `epoch` identifies the database (a different epoch after a
 * reconnect means seqs are not comparable: resync). `resync`: refetch the snapshot of that session instead of
 * expecting a backlog. Catch-up `changes` come in chunks of at most 1000; node detail is never on the socket.
 */
export type ServerMessage =
  | { type: 'hello'; epoch: string }
  | { type: 'changes'; changes: SeqChange[] }
  | { type: 'resync'; sessionId: string };
