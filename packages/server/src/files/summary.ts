import {
  FILE_ACTIONS,
  FILE_TOUCHES_MAX,
  SESSION_FILES_MAX,
  normalizeFilePath,
  relativeToDir,
  type FileAction,
  type FileActionCounts,
  type GraphNode,
  type NodeStatus,
  type Session,
  type SessionFile,
  type SessionFilesResponse,
} from '@agent-canvas/shared';

/**
 * Per-session file summary: a pure function of a session record and its derived nodes (see SessionFilesResponse in
 * shared for the conventions: path key, touches, undated).
 *
 * - Every node's `files` count, whatever its kind; subagent-internal nodes (agentId set) belong to the session.
 * - Each entry's path is normalized again against the session's cwd (shared normalizeFilePath), so a relative or
 *   differently spelled path stored by an older normalizer still lands on its file. An entry whose path is not a
 *   non-empty string, or whose action is not a FileAction, is ignored.
 * - A (path key, action) named more than once by one node counts once.
 * - A touch on a node whose status is failed / denied is kept in the touches (marked `failed`) and counted in `failed`
 *   only: not in `counts`, and its time sets firstMs / lastMs only when the file has no successful touch.
 * - The touches are kept in full here (the cache's memory bound counts them); sessionFilesResponse caps the list.
 */

const ACTIONS = new Set<string>(FILE_ACTIONS);

/** Whether a node status means the call did not happen (its touches are not counted). */
export const isFailedStatus = (status: NodeStatus | null): boolean => status === 'failed' || status === 'denied';
const WINDOWS_STYLE = /^(?:[A-Za-z]:|\/\/)/;

/** A file's identity: the path lower-cased when Windows-style (drive letter or UNC root), else as is. */
export function pathKey(path: string): string {
  return WINDOWS_STYLE.test(path) ? path.toLowerCase() : path;
}

/** ms of a node timestamp; null when undated (unparseable, or not after 1970-01-01T00:00:00Z). */
export function touchMs(timestamp: string): number | null {
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

export interface SummaryTouch {
  nodeId: string;
  action: FileAction;
  toolName: string | null;
  at: string;
  /** null: undated. */
  ms: number | null;
  status: NodeStatus | null;
  agentId: string | null;
  /** status failed / denied. */
  failed: boolean;
}

export interface SummaryFile {
  key: string;
  /** Spelling of the first touch seen (node order). */
  path: string;
  /** Successful touches only. */
  counts: FileActionCounts;
  /** Failed / denied touches. */
  failed: number;
  /** Earliest / latest dated successful touch (of the failed ones when there is no successful touch; null when none). */
  firstMs: number | null;
  lastMs: number | null;
  /** Undated first, then by time; ties in node order. */
  touches: SummaryTouch[];
}

export interface SessionFilesSummary {
  /** In the response's order: changes desc, then lastMs desc (undated last), then path. */
  files: SummaryFile[];
  touchCount: number;
  truncatedNodes: number;
}

const changesOf = (c: FileActionCounts): number => c.edit + c.write + c.delete;

/** Sorts by changes desc, then last time desc (null last), then path asc. */
function compareFiles(a: SummaryFile, b: SummaryFile): number {
  return (
    changesOf(b.counts) - changesOf(a.counts) ||
    (b.lastMs ?? -Infinity) - (a.lastMs ?? -Infinity) ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  );
}

export function summarizeSessionFiles(session: Session, nodes: readonly GraphNode[]): SessionFilesSummary {
  interface Slot { file: SummaryFile; order: number[]; ok: number; failFirst: number | null; failLast: number | null }
  const files = new Map<string, Slot>();
  let touchCount = 0;
  let truncatedNodes = 0;
  let order = 0;
  for (const node of nodes) {
    if (node.filesTruncated === true) truncatedNodes++;
    const list = node.files;
    if (!Array.isArray(list) || list.length === 0) continue;
    const seen = new Set<string>();
    const ms = touchMs(node.timestamp);
    const failed = isFailedStatus(node.status);
    for (const entry of list as unknown[]) {
      if (entry === null || typeof entry !== 'object') continue;
      const { path: raw, action } = entry as { path?: unknown; action?: unknown };
      if (typeof raw !== 'string' || typeof action !== 'string' || !ACTIONS.has(action)) continue;
      const path = normalizeFilePath(raw, session.cwd);
      if (path === '') continue;
      const key = pathKey(path);
      const dedup = `${action}\u0000${key}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      let slot = files.get(key);
      if (slot === undefined) {
        slot = {
          file: {
            key, path, counts: { read: 0, edit: 0, write: 0, delete: 0 }, failed: 0, firstMs: null, lastMs: null, touches: [],
          },
          order: [], ok: 0, failFirst: null, failLast: null,
        };
        files.set(key, slot);
      }
      const f = slot.file;
      if (failed) {
        f.failed++;
        if (ms !== null) {
          if (slot.failFirst === null || ms < slot.failFirst) slot.failFirst = ms;
          if (slot.failLast === null || ms > slot.failLast) slot.failLast = ms;
        }
      } else {
        f.counts[action as FileAction]++;
        slot.ok++;
        if (ms !== null) {
          if (f.firstMs === null || ms < f.firstMs) f.firstMs = ms;
          if (f.lastMs === null || ms > f.lastMs) f.lastMs = ms;
        }
      }
      f.touches.push({
        nodeId: node.id, action: action as FileAction, toolName: node.toolName, at: node.timestamp, ms,
        status: node.status, agentId: node.agentId, failed,
      });
      slot.order.push(order++);
      touchCount++;
    }
  }
  const out: SummaryFile[] = [];
  for (const { file, order: seq, ok, failFirst, failLast } of files.values()) {
    if (ok === 0) {
      file.firstMs = failFirst;
      file.lastMs = failLast;
    }
    // Time order, undated first; ties keep node order (Array.prototype.sort is stable, touches were pushed in order).
    const indexed = file.touches.map((t, i) => ({ t, k: t.ms ?? -Infinity, i: seq[i]! }));
    indexed.sort((a, b) => a.k - b.k || a.i - b.i);
    file.touches = indexed.map((x) => x.t);
    out.push(file);
  }
  out.sort(compareFiles);
  return { files: out, touchCount, truncatedNodes };
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export function sessionFilesResponse(session: Session, summary: SessionFilesSummary): SessionFilesResponse {
  let changedFiles = 0;
  let reads = 0;
  let changes = 0;
  for (const f of summary.files) {
    const fileChanges = changesOf(f.counts);
    if (fileChanges > 0) changedFiles++;
    reads += f.counts.read;
    changes += fileChanges;
  }
  const files = summary.files.slice(0, SESSION_FILES_MAX).map((f): SessionFile => {
    const c = f.counts;
    const fileChanges = changesOf(c);
    const truncated = f.touches.length > FILE_TOUCHES_MAX;
    const kept = truncated ? f.touches.slice(f.touches.length - FILE_TOUCHES_MAX) : f.touches;
    return {
      path: f.path,
      relativePath: relativeToDir(f.path, session.cwd),
      counts: { ...c },
      reads: c.read,
      changes: fileChanges,
      changed: fileChanges > 0,
      created: c.write > 0,
      deleted: c.delete > 0,
      failed: f.failed,
      firstAt: iso(f.firstMs),
      lastAt: iso(f.lastMs),
      touches: kept.map((t) => ({ nodeId: t.nodeId, action: t.action, toolName: t.toolName, at: t.at, status: t.status, agentId: t.agentId })),
      touchesTruncated: truncated,
    };
  });
  return {
    sessionId: session.id,
    origin: session.origin,
    cwd: session.cwd,
    files,
    totalFiles: summary.files.length,
    truncated: summary.files.length > files.length,
    totals: { files: summary.files.length, changedFiles, reads, changes },
    truncatedNodes: summary.truncatedNodes,
  };
}
