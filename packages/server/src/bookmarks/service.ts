import {
  normalizeBookmarkNote,
  projectDisplayName,
  sessionName,
  type Bookmark,
  type BookmarkSnapshot,
  type GraphNode,
  type Project,
  type Session,
} from '@agent-canvas/shared';
import { permissionText } from '../attention/explain.js';
import type { Store, StoredBookmark } from '../store/store.js';

/*
 * Bookmarks (spec 2026-11-24-bookmarks-design.md 3, 6, 7): checks the requests, builds the snapshot from the store, keeps
 * deletes soft for BOOKMARK_PURGE_AFTER_MS (the page's undo), and tells its listeners which sessions' bookmarks changed
 * after every write (the server pushes that to the sessions-scope WebSocket connections).
 */

/** A deleted bookmark can be restored this long; after it, the next write removes it for good. */
export const BOOKMARK_PURGE_AFTER_MS = 24 * 60 * 60_000;
/** Length of a non-tool step's label: the first this many code points of its summary. */
export const STEP_LABEL_SUMMARY_CHARS = 80;

const SESSION_NOT_FOUND = '找不到这个会话';
const NODE_NOT_FOUND = '找不到这一步';
const BOOKMARK_NOT_FOUND = '找不到这个书签';
const NOT_RESTORABLE = '这个书签已经不能恢复了（删除超过 24 小时，或者那里已经重新收藏）';
const ALREADY_BOOKMARKED = '这里已经收藏过了';

export type BookmarkFailure = { ok: false; status: 400 | 404; error: string } | { ok: false; status: 409; error: string; bookmark: Bookmark };
export type BookmarkResult = { ok: true; status: 200 | 201; bookmark: Bookmark } | BookmarkFailure;

/** A step's one-line label (BookmarkSnapshot.stepLabel). */
export function stepLabel(node: GraphNode): string {
  const label =
    node.kind === 'tool' || node.kind === 'subagent'
      ? permissionText(node.toolName, node.title, node.summary)
      : node.summary !== ''
        ? [...node.summary].slice(0, STEP_LABEL_SUMMARY_CHARS).join('')
        : node.title;
  return label.replace(/\s+/g, ' ').trim();
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The note of a request body: absent (when allowed) is ''; otherwise a string within the rules. */
function noteOf(body: Record<string, unknown>, required: boolean): { ok: true; note: string } | { ok: false; error: string } {
  const raw = body.note;
  if (raw === undefined && !required) return { ok: true, note: '' };
  if (typeof raw !== 'string') return { ok: false, error: 'note 必须是字符串' };
  return normalizeBookmarkNote(raw);
}

export class BookmarksService {
  private readonly store: Store;
  private readonly now: () => number;
  private readonly listeners = new Set<(sessionIds: string[]) => void>();

  constructor(deps: { store: Store; now?: () => number }) {
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
  }

  /** Called with the sessions whose bookmarks changed, after every write that changed something. */
  onUpdate(listener: (sessionIds: string[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Not deleted ones, of one session or all, by createdAt descending then id descending, each with what exists now.
   * Indexed reads only: a session by id and a node by primary key per row (each once per call), and the project list
   * once when a row needs a project name.
   */
  list(sessionId?: string): Bookmark[] {
    return this.resolve(this.store.listBookmarks(sessionId));
  }

  /** POST /api/bookmarks { sessionId, nodeId: string | null, note? }. Anything else in the body is ignored. */
  create(body: unknown): BookmarkResult {
    if (!isObject(body)) return { ok: false, status: 400, error: '请求体必须是对象' };
    const { sessionId, nodeId: rawNodeId } = body;
    if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, status: 400, error: 'sessionId 必须是非空的字符串' };
    if (rawNodeId !== undefined && rawNodeId !== null && (typeof rawNodeId !== 'string' || rawNodeId === '')) {
      return { ok: false, status: 400, error: 'nodeId 必须是非空的字符串或 null' };
    }
    const nodeId = typeof rawNodeId === 'string' ? rawNodeId : null;
    const note = noteOf(body, false);
    if (!note.ok) return { ok: false, status: 400, error: note.error };
    const result = this.store.transaction((): BookmarkResult => {
      this.purge();
      const session = this.store.getSession(sessionId);
      if (session === null) return { ok: false, status: 404, error: SESSION_NOT_FOUND };
      let node: GraphNode | null = null;
      if (nodeId !== null) {
        node = this.store.getNode(sessionId, nodeId);
        if (node === null) return { ok: false, status: 404, error: NODE_NOT_FOUND };
      }
      const existing = this.store.bookmarkByTarget(sessionId, nodeId);
      if (existing !== null && existing.deletedAt === null) {
        return { ok: false, status: 409, error: ALREADY_BOOKMARKED, bookmark: this.resolveOne(existing) };
      }
      // A soft-deleted row on this place goes first (its undo then answers 404).
      if (existing !== null) this.store.removeBookmark(existing.id);
      const id = this.store.insertBookmark({ sessionId, nodeId, note: note.note, createdAt: this.nowIso(), snapshot: snapshotOf(session, node) });
      return { ok: true, status: 201, bookmark: this.resolveOne(this.store.bookmarkById(id)!) };
    });
    if (result.ok) this.emit([sessionId]);
    return result;
  }

  /** PATCH /api/bookmarks/:id { note }. An unchanged note writes nothing. */
  updateNote(id: number, body: unknown): BookmarkResult {
    let changed = false;
    const result = this.store.transaction((): BookmarkResult => {
      this.purge();
      const row = this.store.bookmarkById(id);
      if (row === null || row.deletedAt !== null) return { ok: false, status: 404, error: BOOKMARK_NOT_FOUND };
      if (!isObject(body)) return { ok: false, status: 400, error: '请求体必须是对象' };
      const note = noteOf(body, true);
      if (!note.ok) return { ok: false, status: 400, error: note.error };
      if (note.note === row.note) return { ok: true, status: 200, bookmark: this.resolveOne(row) };
      this.store.setBookmarkNote(id, note.note, this.nowIso());
      changed = true;
      return { ok: true, status: 200, bookmark: this.resolveOne(this.store.bookmarkById(id)!) };
    });
    if (result.ok && changed) this.emit([result.bookmark.sessionId]);
    return result;
  }

  /** DELETE /api/bookmarks/:id: soft; restorable for BOOKMARK_PURGE_AFTER_MS. */
  remove(id: number): { ok: true } | { ok: false; status: 404; error: string } {
    const sessionId = this.store.transaction((): string | null => {
      this.purge();
      const row = this.store.bookmarkById(id);
      if (row === null || row.deletedAt !== null) return null;
      this.store.setBookmarkDeleted(id, this.nowIso());
      return row.sessionId;
    });
    if (sessionId === null) return { ok: false, status: 404, error: BOOKMARK_NOT_FOUND };
    this.emit([sessionId]);
    return { ok: true };
  }

  /**
   * POST /api/bookmarks/:id/restore: undoes a delete. 404 when the row is gone (unknown, purged, or removed because its
   * place was bookmarked again). A bookmark that is not deleted is answered as it is.
   */
  restore(id: number): BookmarkResult {
    let changed = false;
    const result = this.store.transaction((): BookmarkResult => {
      this.purge();
      const row = this.store.bookmarkById(id);
      if (row === null) return { ok: false, status: 404, error: NOT_RESTORABLE };
      if (row.deletedAt !== null) {
        this.store.setBookmarkDeleted(id, null);
        changed = true;
      }
      return { ok: true, status: 200, bookmark: this.resolveOne({ ...row, deletedAt: null }) };
    });
    if (result.ok && changed) this.emit([result.bookmark.sessionId]);
    return result;
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  /** Removes the rows deleted more than BOOKMARK_PURGE_AFTER_MS ago (at every write). */
  private purge(): void {
    this.store.purgeBookmarks(new Date(this.now() - BOOKMARK_PURGE_AFTER_MS).toISOString());
  }

  private emit(sessionIds: string[]): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(sessionIds);
      } catch {
        // a failing listener must not affect the write or the others
      }
    }
  }

  private resolveOne(row: StoredBookmark): Bookmark {
    return this.resolve([row])[0]!;
  }

  /** Adds `now` to each row: one read per distinct session and node, the project list once when needed. */
  private resolve(rows: StoredBookmark[]): Bookmark[] {
    const sessions = new Map<string, Session | null>();
    const sessionOf = (id: string): Session | null => {
      if (!sessions.has(id)) sessions.set(id, this.store.getSession(id));
      return sessions.get(id)!;
    };
    let projects: Map<string, Project> | null = null;
    const projectName = (session: Session): string => {
      projects ??= new Map(this.store.listProjects(this.now()).map((p) => [p.id, p]));
      return projectDisplayName(projects.get(session.projectId) ?? { id: session.projectId, cwd: session.cwd });
    };
    return rows.map(({ deletedAt: _deletedAt, ...row }) => {
      const session = sessionOf(row.sessionId);
      const node = session === null ? false : row.nodeId === null ? true : this.store.getNode(row.sessionId, row.nodeId) !== null;
      return {
        ...row,
        now: {
          session: session !== null,
          node,
          sessionTitle: session === null ? null : sessionName(session),
          sourceDeleted: session?.sourceDeleted ?? false,
          projectName: session === null ? null : projectName(session),
        },
      };
    });
  }
}

/** The snapshot written at creation, from the stored session and node. */
function snapshotOf(session: Session, node: GraphNode | null): BookmarkSnapshot {
  return {
    sessionTitle: sessionName(session),
    origin: session.origin ?? 'claude',
    projectId: session.projectId,
    cwd: session.cwd,
    nodeKind: node?.kind ?? null,
    toolName: node?.toolName ?? null,
    stepLabel: node === null ? null : stepLabel(node),
    nodeAt: node?.timestamp ?? null,
  };
}
