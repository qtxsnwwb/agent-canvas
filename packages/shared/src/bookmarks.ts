import type { NodeKind, Origin } from './model.js';

/*
 * Bookmarks (spec 2026-11-24-bookmarks-design.md): a whole session or one step (a graph node), with an optional one-line
 * note. Stored by the server in its own table, kept across rebuilds.
 */

/** Longest note, in code points (`[...note].length`: an emoji counts 1). */
export const BOOKMARK_NOTE_MAX = 200;

/**
 * What the bookmarked place looked like when it was bookmarked, built by the server from the store (never taken from the
 * request) and written once. sessionTitle: the home page's rule (sessionName). For a step: its kind, tool name, a
 * one-line label (a tool or subagent call: tool name and what it did, as the attention page writes it; another kind: the
 * first 80 characters of its summary, else its title) and its timestamp; all four null for a session bookmark.
 */
export interface BookmarkSnapshot {
  sessionTitle: string;
  origin: Origin;
  projectId: string;
  cwd: string | null;
  nodeKind: NodeKind | null;
  toolName: string | null;
  stepLabel: string | null;
  nodeAt: string | null;
}

/**
 * One bookmark. nodeId null: the whole session. createdAt / noteUpdatedAt: ISO times (noteUpdatedAt null until the note
 * is changed after creation).
 */
export interface Bookmark {
  id: number;
  sessionId: string;
  nodeId: string | null;
  note: string;
  createdAt: string;
  noteUpdatedAt: string | null;
  snapshot: BookmarkSnapshot;
  /**
   * Filled when listing: what exists now. session: the session is stored; node: the step is (for a session bookmark, the
   * same as session). sessionTitle / projectName: the session's current ones (home page rules), null when it is gone.
   * sourceDeleted: the session's source file was deleted (it still opens).
   */
  now: { session: boolean; node: boolean; sessionTitle: string | null; sourceDeleted: boolean; projectName: string | null };
}

/** GET /api/bookmarks[?sessionId=]: by createdAt descending, then id descending; deleted ones left out. */
export interface BookmarkListResponse {
  bookmarks: Bookmark[];
}

/** Line breaks: a run of whitespace containing one of these is folded to one space. */
const LINE_BREAK = /[\n\r\v\f\u2028\u2029]/;

/**
 * A note as stored: trimmed, every run of whitespace containing a line break folded to one space (other whitespace kept),
 * at most BOOKMARK_NOTE_MAX code points after that. Empty is allowed.
 */
export function normalizeBookmarkNote(raw: string): { ok: true; note: string } | { ok: false; error: string } {
  const note = raw.trim().replace(/\s+/g, (ws) => (LINE_BREAK.test(ws) ? ' ' : ws));
  const length = [...note].length;
  if (length > BOOKMARK_NOTE_MAX) return { ok: false, error: `备注最多 ${BOOKMARK_NOTE_MAX} 个字，现在有 ${length} 个` };
  return { ok: true, note };
}
