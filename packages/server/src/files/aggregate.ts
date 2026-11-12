import {
  FILE_SESSIONS_MAX,
  projectDisplayName,
  relativeToDir,
  type FilesRange,
  type FilesSort,
  type Origin,
  type Project,
  type ProjectFile,
  type ProjectFileSession,
  type ProjectFilesResponse,
  type Session,
} from '@agent-canvas/shared';
import type { SessionFilesSummary } from './summary.js';

/**
 * Aggregation of session file summaries into a ProjectFilesResponse: a pure function of the summaries, the filters and
 * the range start (see ProjectFilesResponse in shared for every field's meaning).
 *
 * - A file belongs to the project of the session that touched it (Session.projectId): a file touched by sessions of
 *   two projects is listed under each, with that project's touches only.
 * - Range: a file is listed when it has a touch at or after fromMs (dated touches only); every count, flag and time is
 *   of those touches. fromMs null (range `all`): every touch, undated ones included.
 * - changedOnly: files with at least one change in range. q: case-insensitive substring of the path (`\` read as `/`).
 * - Sorted (FilesSort), then cut to `limit`; per-file session rows are built for the listed files only.
 */

export interface ProjectFilesInput {
  entries: { session: Session; summary: SessionFilesSummary }[];
  /** For the project's directory and name; a project not listed has no directory and is named after its id. */
  projects: Pick<Project, 'id' | 'cwd'>[];
  projectId: string;
  origin: Origin | null;
  /** rangeStartMs(range, now). */
  fromMs: number | null;
  changedOnly: boolean;
  q: string | null;
  sort: FilesSort;
  limit: number;
  failedSessions: number;
  importing: boolean;
}

/** Start of the range: local midnight 6 (7d) / 29 (30d) days before the local day of `nowMs`; null for `all`. */
export function rangeStartMs(range: FilesRange, nowMs: number): number | null {
  if (range === 'all') return null;
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (range === '7d' ? 6 : 29));
  return d.getTime();
}

interface SessionPart { session: Session; reads: number; changes: number; lastMs: number | null }
interface Acc {
  path: string;
  /** Earliest dated touch of the file (any time), for the spelling. */
  firstMs: number | null;
  reads: number;
  changes: number;
  created: boolean;
  deleted: boolean;
  lastMs: number | null;
  lastOrigin: Origin | null;
  sessions: SessionPart[];
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byLastDesc = (a: number | null, b: number | null): number => (b ?? -Infinity) - (a ?? -Infinity);

export function aggregateProjectFiles(input: ProjectFilesInput): ProjectFilesResponse {
  const project = input.projects.find((p) => p.id === input.projectId);
  const projectDir = project?.cwd ?? null;
  const files = new Map<string, Acc>();
  let truncatedNodes = 0;
  const { fromMs } = input;

  for (const { session, summary } of input.entries) {
    if (session.projectId !== input.projectId) continue;
    if (input.origin !== null && session.origin !== input.origin) continue;
    truncatedNodes += summary.truncatedNodes;
    for (const file of summary.files) {
      let reads = 0;
      let edits = 0;
      let writes = 0;
      let deletes = 0;
      let lastMs: number | null;
      if (fromMs === null) {
        ({ read: reads, edit: edits, write: writes, delete: deletes } = file.counts);
        lastMs = file.lastMs;
      } else {
        if (file.lastMs === null || file.lastMs < fromMs) continue;
        lastMs = null;
        for (const t of file.touches) {
          if (t.ms === null || t.ms < fromMs) continue;
          if (t.action === 'read') reads++;
          else if (t.action === 'edit') edits++;
          else if (t.action === 'write') writes++;
          else deletes++;
          if (lastMs === null || t.ms > lastMs) lastMs = t.ms;
        }
      }
      const changes = edits + writes + deletes;
      if (reads + changes === 0) continue;
      let acc = files.get(file.key);
      if (acc === undefined) {
        acc = {
          path: file.path, firstMs: file.firstMs, reads: 0, changes: 0, created: false, deleted: false, lastMs: null,
          lastOrigin: null, sessions: [],
        };
        files.set(file.key, acc);
      } else if (file.firstMs !== null && (acc.firstMs === null || file.firstMs < acc.firstMs)) {
        acc.path = file.path;
        acc.firstMs = file.firstMs;
      }
      acc.reads += reads;
      acc.changes += changes;
      if (writes > 0) acc.created = true;
      if (deletes > 0) acc.deleted = true;
      if (lastMs !== null && (acc.lastMs === null || lastMs > acc.lastMs)) {
        acc.lastMs = lastMs;
        acc.lastOrigin = session.origin;
      }
      acc.sessions.push({ session, reads, changes, lastMs });
    }
  }

  const q = input.q === null || input.q === '' ? null : input.q.replace(/\\/g, '/').toLowerCase();
  const listed: { acc: Acc; relativePath: string }[] = [];
  for (const acc of files.values()) {
    if (input.changedOnly && acc.changes === 0) continue;
    if (q !== null && !acc.path.toLowerCase().includes(q)) continue;
    listed.push({ acc, relativePath: relativeToDir(acc.path, projectDir) });
  }
  const tie = (a: (typeof listed)[number], b: (typeof listed)[number]): number =>
    cmp(a.relativePath, b.relativePath) || cmp(a.acc.path, b.acc.path);
  const byPath = (a: (typeof listed)[number], b: (typeof listed)[number]): number =>
    cmp(a.relativePath.toLowerCase(), b.relativePath.toLowerCase()) || tie(a, b);
  listed.sort(
    input.sort === 'path'
      ? byPath
      : input.sort === 'changes'
        ? (a, b) => b.acc.changes - a.acc.changes || byLastDesc(a.acc.lastMs, b.acc.lastMs) || tie(a, b)
        : (a, b) => byLastDesc(a.acc.lastMs, b.acc.lastMs) || tie(a, b),
  );
  const limit = Math.max(0, input.limit);
  const out = listed.slice(0, limit).map(({ acc, relativePath }): ProjectFile => {
    const parts = [...acc.sessions].sort((a, b) => byLastDesc(a.lastMs, b.lastMs) || cmp(a.session.id, b.session.id));
    const sessions = parts.slice(0, FILE_SESSIONS_MAX).map((p): ProjectFileSession => ({
      sessionId: p.session.id, origin: p.session.origin, title: p.session.title, reads: p.reads, changes: p.changes,
      lastAt: iso(p.lastMs),
    }));
    return {
      path: acc.path, relativePath, sessionCount: acc.sessions.length, reads: acc.reads, changes: acc.changes,
      created: acc.created, deleted: acc.deleted, lastAt: iso(acc.lastMs), lastOrigin: acc.lastOrigin, sessions,
      sessionsTruncated: parts.length > FILE_SESSIONS_MAX,
    };
  });
  return {
    projectId: input.projectId,
    projectName: projectDisplayName({ id: input.projectId, cwd: projectDir }),
    projectDir,
    files: out,
    totalFiles: listed.length,
    truncated: listed.length > out.length,
    failedSessions: input.failedSessions,
    importing: input.importing,
    truncatedNodes,
  };
}
