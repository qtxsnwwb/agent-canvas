import type { FileAction, NodeStatus, Origin } from './model.js';

/**
 * The file view's responses (`GET /api/sessions/:id/files`, `GET /api/files`). Computed from the `files` of derived
 * nodes and from session records only: paths, counts, times, tool names, session titles and ids, never conversation
 * content.
 *
 * Conventions shared by both:
 * - A file is identified by its path key: the normalized path, lower-cased when it is Windows-style (a drive letter or
 *   a UNC `//server/share` root), as is; POSIX paths are case-sensitive. `path` is the spelling first seen: in a
 *   session, of its first touch in node order; across sessions, that of the session whose first dated touch of it is
 *   earliest.
 * - A touch is one (file, action) of one node: a node naming the same file and action twice counts once; a node that
 *   reads and edits a file counts one read and one edit.
 * - reads = read touches; changes = edit + write + delete touches.
 * - Failed touches: a touch whose node status is `failed` or `denied` did not happen. It is still listed among a file's
 *   touches (with its status) and counted in `failed`, but it counts toward no read / change count, sets none of
 *   changed / created / deleted, and sets no first / last time (so it neither sorts a file nor puts it in a range),
 *   unless the file has no successful touch at all (in scope): then the file is still listed, with zero counts and
 *   changed false, and its times come from the failed touches. Touches still running or awaiting permission count.
 * - Times are ISO 8601 strings, a node's `timestamp` as stored. A touch whose timestamp is unparseable or not after
 *   1970-01-01T00:00:00Z is undated: it counts in range `all` only and never sets a first / last time (null when a
 *   file has no dated touch).
 */

/** Most touches listed per file in SessionFile.touches (the earliest are dropped; counts stay complete). */
export const FILE_TOUCHES_MAX = 500;
/** Most files in one SessionFilesResponse (the first in its order are kept; totals stay complete). */
export const SESSION_FILES_MAX = 2000;
/** Most sessions listed per file in ProjectFile.sessions (the least recent are dropped; sessionCount stays complete). */
export const FILE_SESSIONS_MAX = 50;
/** Most files in one ProjectFilesResponse (FILES_DEFAULT_LIMIT is also the largest `limit` accepted). */
export const FILES_LIMIT_MAX = 200;
export const FILES_DEFAULT_LIMIT = 200;
/** Longest `q` accepted. */
export const FILES_QUERY_MAX = 200;

/** `7d` / `30d`: from the start of the local day 6 / 29 days before today (the stats page's days); `all`: everything. */
export type FilesRange = '7d' | '30d' | 'all';
export const FILES_RANGES: readonly FilesRange[] = ['7d', '30d', 'all'];
export const FILES_DEFAULT_RANGE: FilesRange = 'all';

/**
 * `recent`: last touch time descending (undated last); `changes`: change count descending, then `recent`; `path`:
 * relativePath ascending (case-insensitive, then exact). Every sort ends with relativePath, then path, ascending.
 */
export type FilesSort = 'recent' | 'changes' | 'path';
export const FILES_SORTS: readonly FilesSort[] = ['recent', 'changes', 'path'];
export const FILES_DEFAULT_SORT: FilesSort = 'recent';

export interface FileActionCounts { read: number; edit: number; write: number; delete: number }

/** One touch of a file by one node of the session. */
export interface SessionFileTouch {
  /** The node (select it on the canvas with this id). */
  nodeId: string;
  action: FileAction;
  /** The node's tool name (e.g. `Edit`, `edit_file_v2`, `apply_patch`); null when the node has none. */
  toolName: string | null;
  /** The node's timestamp. */
  at: string;
  /** The node's status (running / awaiting_permission / succeeded / failed / denied), null when it has none. */
  status: NodeStatus | null;
  /** The subagent thread the node belongs to; null on the main thread. */
  agentId: string | null;
}

/** One file one session touched. */
export interface SessionFile {
  path: string;
  /** `path` relative to the session's cwd when inside it, else `path` in full (shared relativeToDir). */
  relativePath: string;
  counts: FileActionCounts;
  /** counts.read. */
  reads: number;
  /** counts.edit + counts.write + counts.delete. */
  changes: number;
  /** Any edit, write or delete. */
  changed: boolean;
  /** Any write (created or overwritten: the tools do not say which). */
  created: boolean;
  /** Any delete. */
  deleted: boolean;
  /** Failed / denied touches (listed in `touches`, counted nowhere else). Optional for compatibility; always set. */
  failed?: number;
  /** Earliest / latest dated successful touch time (failed ones only when there is no successful touch; null when none is dated). */
  firstAt: string | null;
  lastAt: string | null;
  /** In time order (undated first, then by time; ties in node order); at most FILE_TOUCHES_MAX, the latest kept. */
  touches: SessionFileTouch[];
  /** More touches than FILE_TOUCHES_MAX: `touches` lists the latest ones only. */
  touchesTruncated: boolean;
}

/** GET /api/sessions/:id/files (404 for an unknown session). */
export interface SessionFilesResponse {
  sessionId: string;
  origin: Origin;
  /** The session's working directory (what relativePath is relative to); null when unknown. */
  cwd: string | null;
  /**
   * The files the session touched (subagent-internal touches included): changes desc, then lastAt desc, then path; at
   * most SESSION_FILES_MAX (the first in that order).
   */
  files: SessionFile[];
  /** Files the session touched, all of them (≥ files.length). Optional for compatibility; always set. */
  totalFiles?: number;
  /** totalFiles > files.length. Optional for compatibility; always set. */
  truncated?: boolean;
  /** Over every file the session touched, listed or not. */
  totals: {
    /** All files (= totalFiles). */
    files: number;
    /** Files with changed: true. */
    changedFiles: number;
    reads: number;
    changes: number;
  };
  /** Nodes that named more files than they could record (filesTruncated): their extra files are not counted. */
  truncatedNodes: number;
}

/** One session's share of a file, within the range. */
export interface ProjectFileSession {
  sessionId: string;
  origin: Origin;
  /** The session's title (as in the sessions list), null when it has none. */
  title: string | null;
  reads: number;
  changes: number;
  /** Failed / denied touches in range. Optional for compatibility; always set. */
  failed?: number;
  /**
   * Latest dated successful touch in range by this session; when the session has none in range, its latest failed
   * one; null when none is dated.
   */
  lastAt: string | null;
}

/** One file of the project, over the range (and the origin filter). */
export interface ProjectFile {
  path: string;
  /** `path` relative to the project directory when inside it, else `path` in full. */
  relativePath: string;
  /**
   * Sessions with a touch of it in range, failed ones included (all of them, not only those listed in `sessions`).
   */
  sessionCount: number;
  reads: number;
  changes: number;
  /** Any successful write / delete in range. */
  created: boolean;
  deleted: boolean;
  /** Failed / denied touches in range. Optional for compatibility; always set. */
  failed?: number;
  /**
   * Latest dated successful touch in range (failed ones only for a file without any successful touch), and the origin
   * of the session that made it; null when none is dated.
   */
  lastAt: string | null;
  lastOrigin: Origin | null;
  /** lastAt descending (undated last), then session id; at most FILE_SESSIONS_MAX. */
  sessions: ProjectFileSession[];
  /** More sessions than FILE_SESSIONS_MAX touched it: the least recent are not listed. */
  sessionsTruncated: boolean;
}

/** GET /api/files. An unknown project gives an empty result (projectDir null, name from the id). */
export interface ProjectFilesResponse {
  projectId: string;
  /** shared projectDisplayName. */
  projectName: string;
  /** The project's directory (what relativePath is relative to); null when unknown. */
  projectDir: string | null;
  /** The files matching every filter, sorted, at most `limit`. */
  files: ProjectFile[];
  /** Files matching every filter before `limit` was applied. */
  totalFiles: number;
  /** totalFiles > files.length. */
  truncated: boolean;
  /** Sessions whose file summary could not be computed (skipped). */
  failedSessions: number;
  /** The service is still importing at answer time: the list may be filling in. */
  importing: boolean;
  /** Nodes (any time) of the project's sessions of the origin filter that named more files than they could record. */
  truncatedNodes: number;
}
