import type { SeqChange } from './change.js';
import type { GraphEdge, GraphNode, Origin, Session } from './model.js';
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
}

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
