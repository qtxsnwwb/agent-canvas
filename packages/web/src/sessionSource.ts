import type { Bookmark, Graph, NodeDetail, Session, SessionAnomaliesResponse, SessionFilesResponse } from '@agent-canvas/shared';
import type { LayoutClient } from './canvas/layoutClient';
import type { TimelineClient } from './canvas/timelineClient';

/**
 * A step's detail as the drawer shows it. `detail` null: there is no stored detail for this step (an export leaves out
 * the entry of a step that had none). `outputOriginalBytes`: the output was cut at export time; its size before (UTF-8
 * bytes); null when it was not cut.
 */
export interface StepDetail { detail: NodeDetail | null; outputOriginalBytes: number | null }

/**
 * One session's bookmarks as its page reads and writes them (bookmarks spec 5): the live list and the writes, bound to
 * the session. The note is the user's own words and is never masked.
 */
export interface SessionBookmarks {
  /**
   * Calls `onList` with the session's bookmarks (null until the first list), again after every change anywhere (the
   * app's `bookmarks` push); a failed fetch keeps the last list. Returns the stop.
   */
  watch(onList: (bookmarks: readonly Bookmark[] | null) => void): () => void;
  /** Bookmarks the session (`nodeId` null) or one of its steps; `created` false: it was bookmarked already (that one). */
  create(nodeId: string | null, note?: string): Promise<{ created: boolean; bookmark: Bookmark }>;
  /** The note as typed (the server normalizes it; a failure carries its text). */
  patch(id: number, note: string): Promise<Bookmark>;
  /** Soft delete (restorable). */
  remove(id: number): Promise<unknown>;
  restore(id: number): Promise<Bookmark>;
}

/**
 * Where the session page reads one session from. Two implementations: the live one (liveSource.ts: the API and the
 * WebSocket) and the embedded one (viewer/data.ts: an ExportBundle in an exported HTML file). This module and every
 * page component take only this interface, so the viewer's bundle never reaches the API client.
 */
export interface SessionSource {
  getSession(): Session;
  /** The same object until the graph changes (consumers memoize on it). */
  getGraph(): Graph;
  /** Called after every change of the session or the graph; the embedded source never calls it. */
  subscribe(fn: () => void): () => void;
  /**
   * False for a snapshot: nothing is progressing, open steps do not grow and the session's status is not shown as
   * running (see snapshotClock in canvas/waterfall.ts).
   */
  readonly live: boolean;
  /** The detail the drawer shows for a node; rejects when it could not be loaded (the drawer shows the error). */
  nodeDetail(nodeId: string): Promise<StepDetail>;
  /** The session's files (the file panel); null: not available, the files button is not shown. */
  readonly files: (() => Promise<SessionFilesResponse>) | null;
  /** The session's anomalies (button, card markers, panel); null: not available, none of them is shown. */
  readonly anomalies: (() => Promise<SessionAnomaliesResponse>) | null;
  /**
   * The session's bookmarks (toolbar and drawer buttons, card stars); null: not available (the exported viewer), none
   * of them is shown.
   */
  readonly bookmarks: SessionBookmarks | null;
  /** A layout client for the canvas (one per canvas model; disposed with it). */
  createLayoutClient(): LayoutClient;
  /**
   * Where the 时间线 view computes (one per page; disposed with it): the app's moves a large session into a worker.
   * Absent: on the page's own thread (the exported viewer, whose content security policy allows no worker).
   */
  createTimelineClient?(): TimelineClient;
}
