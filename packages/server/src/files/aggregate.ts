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
 * - Failed / denied touches (shared files.ts): counted in `failed` only. A file with any successful touch in scope (any
 *   time) is listed and dated by its successful touches in range only; a file without any, by its failed ones (zero
 *   counts). A session row is dated by its successful touches in range, else by its failed ones.
 * - changedOnly: files with at least one change in range. q (trimmed): case-insensitive substring of relativePath, the
 *   path as shown (`\` read as `/`).
 * - Ties: the spelling is that of the session with the earliest dated touch, lastOrigin that of the session with the
 *   latest one; on equal times, of the smaller session id.
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

/** okLast / failLast: latest dated successful / failed touch in range. */
interface SessionPart {
  session: Session; reads: number; changes: number; failed: number; okLast: number | null; failLast: number | null;
}
interface Latest { ms: number | null; origin: Origin | null; session: string }
interface Acc {
  path: string;
  /** Earliest dated touch of the file (any time; see SummaryFile.firstMs), for the spelling, and its session. */
  firstMs: number | null;
  firstSession: string;
  /** Any successful touch of the file in scope, at any time (decides whether failed touches may date it). */
  okAny: boolean;
  reads: number;
  changes: number;
  failed: number;
  created: boolean;
  deleted: boolean;
  okLast: Latest;
  failLast: Latest;
  sessions: SessionPart[];
}

/** Moves `l` to (ms, session) when later, or as late and of a smaller session id. */
function later(l: Latest, ms: number | null, session: Session): void {
  if (ms === null) return;
  if (l.ms === null || ms > l.ms || (ms === l.ms && session.id < l.session)) {
    l.ms = ms;
    l.origin = session.origin;
    l.session = session.id;
  }
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
      let changes = 0;
      let failed = 0;
      let created = false;
      let deleted = false;
      let okLast: number | null = null;
      let failLast: number | null = null;
      for (const t of file.touches) {
        if (fromMs !== null && (t.ms === null || t.ms < fromMs)) continue;
        if (t.failed) {
          failed++;
          if (t.ms !== null && (failLast === null || t.ms > failLast)) failLast = t.ms;
          continue;
        }
        if (t.action === 'read') reads++;
        else {
          changes++;
          if (t.action === 'write') created = true;
          else if (t.action === 'delete') deleted = true;
        }
        if (t.ms !== null && (okLast === null || t.ms > okLast)) okLast = t.ms;
      }
      if (reads + changes + failed === 0) continue;
      const c = file.counts;
      const okAny = c.read + c.edit + c.write + c.delete > 0;
      let acc = files.get(file.key);
      if (acc === undefined) {
        acc = {
          path: file.path, firstMs: file.firstMs, firstSession: session.id, okAny: false, reads: 0, changes: 0, failed: 0,
          created: false, deleted: false, okLast: { ms: null, origin: null, session: '' },
          failLast: { ms: null, origin: null, session: '' }, sessions: [],
        };
        files.set(file.key, acc);
      } else if (
        file.firstMs !== null &&
        (acc.firstMs === null || file.firstMs < acc.firstMs || (file.firstMs === acc.firstMs && session.id < acc.firstSession))
      ) {
        acc.path = file.path;
        acc.firstMs = file.firstMs;
        acc.firstSession = session.id;
      }
      if (okAny) acc.okAny = true;
      acc.reads += reads;
      acc.changes += changes;
      acc.failed += failed;
      if (created) acc.created = true;
      if (deleted) acc.deleted = true;
      later(acc.okLast, okLast, session);
      later(acc.failLast, failLast, session);
      acc.sessions.push({ session, reads, changes, failed, okLast, failLast });
    }
  }

  // A file with a successful touch is in range by its successful touches only; one without any, by its failed ones.
  const latest = (acc: Acc): Latest => (acc.okAny ? acc.okLast : acc.failLast);
  const lastOf = (acc: Acc): number | null => latest(acc).ms;
  const partLast = (p: SessionPart): number | null => (p.reads + p.changes > 0 ? p.okLast : p.failLast);

  const trimmed = input.q?.trim() ?? '';
  const q = trimmed === '' ? null : trimmed.replace(/\\/g, '/').toLowerCase();
  const listed: { acc: Acc; relativePath: string }[] = [];
  for (const acc of files.values()) {
    if (acc.okAny && acc.reads + acc.changes === 0) continue; // only failed touches in range
    if (input.changedOnly && acc.changes === 0) continue;
    const relativePath = relativeToDir(acc.path, projectDir);
    if (q !== null && !relativePath.toLowerCase().includes(q)) continue;
    listed.push({ acc, relativePath });
  }
  const tie = (a: (typeof listed)[number], b: (typeof listed)[number]): number =>
    cmp(a.relativePath, b.relativePath) || cmp(a.acc.path, b.acc.path);
  const byPath = (a: (typeof listed)[number], b: (typeof listed)[number]): number =>
    cmp(a.relativePath.toLowerCase(), b.relativePath.toLowerCase()) || tie(a, b);
  listed.sort(
    input.sort === 'path'
      ? byPath
      : input.sort === 'changes'
        ? (a, b) => b.acc.changes - a.acc.changes || byLastDesc(lastOf(a.acc), lastOf(b.acc)) || tie(a, b)
        : (a, b) => byLastDesc(lastOf(a.acc), lastOf(b.acc)) || tie(a, b),
  );
  const limit = Math.max(0, input.limit);
  const out = listed.slice(0, limit).map(({ acc, relativePath }): ProjectFile => {
    const parts = [...acc.sessions].sort((a, b) => byLastDesc(partLast(a), partLast(b)) || cmp(a.session.id, b.session.id));
    const sessions = parts.slice(0, FILE_SESSIONS_MAX).map((p): ProjectFileSession => ({
      sessionId: p.session.id, origin: p.session.origin, title: p.session.title, reads: p.reads, changes: p.changes,
      failed: p.failed, lastAt: iso(partLast(p)),
    }));
    const last = latest(acc);
    return {
      path: acc.path, relativePath, sessionCount: acc.sessions.length, reads: acc.reads, changes: acc.changes,
      created: acc.created, deleted: acc.deleted, failed: acc.failed, lastAt: iso(last.ms), lastOrigin: last.origin,
      sessions, sessionsTruncated: parts.length > FILE_SESSIONS_MAX,
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
