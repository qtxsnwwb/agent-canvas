import {
  COMPARE_FILES_MAX,
  COMPARE_TOOLS_MAX,
  COMPARE_TURNS_MAX,
  isWindowsStylePath,
  relativeToDir,
  samePath,
  sessionName,
  type CompareFileCounts,
  type CompareFileRow,
  type CompareFiles,
  type CompareResponse,
  type CompareSide,
  type CompareToolCounts,
  type CompareToolRow,
  type CompareTurnRow,
  type CompareTurnSide,
  type Session,
} from '@agent-canvas/shared';
import type { SessionFilesSummary } from '../files/summary.js';
import { turnDurationMs, type SessionSummary } from '../stats/summary.js';

/**
 * Two sessions side by side (spec 2026-11-24-compare-design.md 4; CompareResponse in shared): a pure function of each
 * side's stats summary, file summary and the clock. A missing side (null) pairs as an empty session.
 */

/** One side's input: the session record read with the nodes, its stats summary, its file summary (null: none). */
export interface CompareInput {
  session: Session;
  summary: SessionSummary;
  files: SessionFilesSummary | null;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The stats page's numbers for one session at `nowMs` (see CompareSide). */
export function compareSide(session: Session, summary: SessionSummary, nowMs: number): CompareSide {
  let activeMs = 0;
  let turns = 0;
  let input = 0;
  let cachedInput = 0;
  let output = 0;
  for (const t of summary.turns) {
    if (t.dated) {
      turns++;
      activeMs += turnDurationMs(t, nowMs);
    }
    input += t.inputTokens;
    cachedInput += t.cachedInputTokens;
    output += t.outputTokens;
  }
  for (const x of summary.extras) {
    input += x.inputTokens;
    cachedInput += x.cachedInputTokens;
    output += x.outputTokens;
  }
  let failed = 0;
  for (const c of summary.calls) if (c.failed) failed++;
  return {
    sessionId: session.id,
    title: sessionName(session),
    origin: session.origin,
    projectId: session.projectId,
    cwd: session.cwd,
    status: session.status,
    lastActivityAt: session.lastActivityAt,
    activeMs,
    turns,
    steps: summary.nodeCount,
    toolCalls: summary.calls.length,
    failed,
    subagents: summary.subagentCount,
    tokens: summary.usageNodes === 0 ? null : { input, cachedInput, output },
  };
}

function toolCounts(summary: SessionSummary | undefined): Map<string, CompareToolCounts> {
  const out = new Map<string, CompareToolCounts>();
  for (const c of summary?.calls ?? []) {
    let row = out.get(c.toolName);
    if (row === undefined) out.set(c.toolName, (row = { calls: 0, failed: 0 }));
    row.calls++;
    if (c.failed) row.failed++;
  }
  return out;
}

function pairTools(left: SessionSummary | undefined, right: SessionSummary | undefined): Pick<CompareResponse, 'tools' | 'otherTools'> {
  const l = toolCounts(left);
  const r = toolCounts(right);
  const names = new Set([...l.keys(), ...r.keys()]);
  const rows: CompareToolRow[] = [...names].map((toolName) => ({ toolName, left: l.get(toolName) ?? null, right: r.get(toolName) ?? null }));
  const sum = (row: CompareToolRow): number => (row.left?.calls ?? 0) + (row.right?.calls ?? 0);
  rows.sort((a, b) => sum(b) - sum(a) || cmp(a.toolName, b.toolName));
  if (rows.length <= COMPARE_TOOLS_MAX) return { tools: rows, otherTools: null };
  const rest = rows.slice(COMPARE_TOOLS_MAX);
  return {
    tools: rows.slice(0, COMPARE_TOOLS_MAX),
    otherTools: { left: rest.reduce((a, x) => a + (x.left?.calls ?? 0), 0), right: rest.reduce((a, x) => a + (x.right?.calls ?? 0), 0) },
  };
}

function turnSide(summary: SessionSummary | undefined, i: number, nowMs: number): CompareTurnSide | null {
  const t = summary?.turns[i];
  if (summary === undefined || t === undefined) return null;
  return {
    promptNodeId: t.promptNodeId,
    promptHead: t.promptHead,
    activeMs: turnDurationMs(t, nowMs),
    toolCalls: t.toolCalls,
    tokens: summary.usageNodes === 0 ? null : t.inputTokens + t.outputTokens,
  };
}

function pairTurns(left: SessionSummary | undefined, right: SessionSummary | undefined, nowMs: number): Pick<CompareResponse, 'turns' | 'turnsTruncated'> {
  const count = Math.max(left?.turns.length ?? 0, right?.turns.length ?? 0);
  const turns: CompareTurnRow[] = [];
  for (let i = 0; i < Math.min(count, COMPARE_TURNS_MAX); i++) {
    turns.push({ index: i + 1, left: turnSide(left, i, nowMs), right: turnSide(right, i, nowMs) });
  }
  return { turns, turnsTruncated: count > COMPARE_TURNS_MAX };
}

/**
 * One side's files by pairing key: the path relative to the session's cwd (the file page's relativePath), compared
 * case-insensitively when the file's path is Windows-style. Two files of one session landing on the same key (a
 * relative path kept as given that equals another's relative path) are added up.
 */
function filesByKey(input: CompareInput | null): Map<string, { path: string; counts: CompareFileCounts }> {
  const out = new Map<string, { path: string; counts: CompareFileCounts }>();
  if (input === null || input.files === null) return out;
  for (const f of input.files.files) {
    const rel = relativeToDir(f.path, input.session.cwd);
    const key = isWindowsStylePath(f.path) ? rel.toLowerCase() : rel;
    const reads = f.counts.read;
    const changes = f.counts.edit + f.counts.write + f.counts.delete;
    const known = out.get(key);
    if (known === undefined) out.set(key, { path: rel, counts: { reads, changes } });
    else {
      known.counts.reads += reads;
      known.counts.changes += changes;
    }
  }
  return out;
}

const touches = (c: CompareFileCounts | null): number => (c === null ? 0 : c.reads + c.changes);

/** (left + right) reads and changes descending, then path (case-insensitive, then exact, as the file page sorts paths). */
function byTouches(a: CompareFileRow, b: CompareFileRow): number {
  return (
    touches(b.left) + touches(b.right) - (touches(a.left) + touches(a.right)) ||
    cmp(a.path.toLowerCase(), b.path.toLowerCase()) ||
    cmp(a.path, b.path)
  );
}

function sameCwd(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return a === b || samePath(a, b);
}

function pairFiles(left: CompareInput | null, right: CompareInput | null): CompareFiles {
  const l = filesByKey(left);
  const r = filesByKey(right);
  const both: CompareFileRow[] = [];
  const onlyLeft: CompareFileRow[] = [];
  const onlyRight: CompareFileRow[] = [];
  for (const [key, x] of l) {
    const y = r.get(key);
    if (y === undefined) onlyLeft.push({ path: x.path, left: x.counts, right: null });
    else both.push({ path: x.path, left: x.counts, right: y.counts });
  }
  for (const [key, y] of r) if (!l.has(key)) onlyRight.push({ path: y.path, left: null, right: y.counts });
  const cut = (rows: CompareFileRow[]): CompareFileRow[] => rows.sort(byTouches).slice(0, COMPARE_FILES_MAX);
  const more = (rows: CompareFileRow[]): number => Math.max(0, rows.length - COMPARE_FILES_MAX);
  return {
    both: cut(both),
    onlyLeft: cut(onlyLeft),
    onlyRight: cut(onlyRight),
    more: { both: more(both), onlyLeft: more(onlyLeft), onlyRight: more(onlyRight) },
    cwdsDiffer: left !== null && right !== null && !sameCwd(left.session.cwd, right.session.cwd),
  };
}

/** `sameSession`: the request named the same id twice (the route decides it, a missing session included). */
export function buildCompare(
  left: CompareInput | null,
  right: CompareInput | null,
  options: { sameSession: boolean; nowMs: number },
): CompareResponse {
  const { nowMs } = options;
  return {
    left: left === null ? null : compareSide(left.session, left.summary, nowMs),
    right: right === null ? null : compareSide(right.session, right.summary, nowMs),
    sameSession: options.sameSession,
    ...pairTools(left?.summary, right?.summary),
    ...pairTurns(left?.summary, right?.summary, nowMs),
    files: pairFiles(left, right),
  };
}
