import type { Graph, NodeDetail, Session, SessionAnomaliesResponse, SessionFilesResponse } from '@agent-canvas/shared';
import type { LayoutClient } from './canvas/layoutClient';
import type { TimelineClient } from './canvas/timelineClient';

/**
 * A step's detail as the drawer shows it. `detail` null: there is no stored detail for this step (an export leaves out
 * the entry of a step that had none). `outputOriginalBytes`: the output was cut at export time; its size before (UTF-8
 * bytes); null when it was not cut.
 */
export interface StepDetail { detail: NodeDetail | null; outputOriginalBytes: number | null }

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
  /** A layout client for the canvas (one per canvas model; disposed with it). */
  createLayoutClient(): LayoutClient;
  /**
   * Where the 时间线 view computes (one per page; disposed with it): the app's moves a large session into a worker.
   * Absent: on the page's own thread (the exported viewer, whose content security policy allows no worker).
   */
  createTimelineClient?(): TimelineClient;
}
