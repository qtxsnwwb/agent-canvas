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
import { changesOf, type SessionFilesSummary } from '../files/summary.js';
import { callCounted, sessionTotals, statsRange, type SessionTotals } from '../stats/aggregate.js';
import { turnDurationMs, type SessionSummary } from '../stats/summary.js';

/**
 * Two sessions side by side (spec 2026-11-24-compare-design.md 4; CompareResponse in shared): a pure function of each
 * side's stats summary, file summary, the clock and the day function (the stats page's local day). A missing side
 * (null) pairs as an empty session. The totals and the by-tool rows count what the stats page counts with range `all`
 * (stats/aggregate.ts sessionTotals, callCounted).
 */

/** The day function and clock every number is taken at. */
export interface CompareClock {
  nowMs: number;
  /** Local day (`YYYY-MM-DD`) of a time, as the stats page's (localDayKey). */
  dayKey: (ms: number) => string;
}

/** One side's input: the session record read with the nodes, its stats summary, its file summary (null: none). */
export interface CompareInput {
  session: Session;
  summary: SessionSummary;
  files: SessionFilesSummary | null;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The stats page's numbers for one session (see CompareSide); `totals`: sessionTotals of it, when already computed. */
export function compareSide(session: Session, summary: SessionSummary, clock: CompareClock, totals?: SessionTotals): CompareSide {
  const { activeMs, turns, toolCalls, failed, tokens } = totals ?? sessionTotals(summary, 'all', clock.nowMs, clock.dayKey);
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
    toolCalls,
    failed,
    subagents: summary.subagentCount,
    tokens,
  };
}

/** One side's input with its sessionTotals (range `all`). */
type Counted = CompareInput & { totals: SessionTotals };

/** Calls per tool name: the calls the stats page counts (callCounted, range `all`). */
function toolCounts(side: Counted | undefined, clock: CompareClock): Map<string, CompareToolCounts> {
  const out = new Map<string, CompareToolCounts>();
  if (side === undefined) return out;
  const { inRange } = statsRange('all', clock.nowMs, clock.dayKey);
  for (const c of side.summary.calls) {
    if (!callCounted(c, side.totals.turnIn, inRange, clock.dayKey)) continue;
    let row = out.get(c.toolName);
    if (row === undefined) out.set(c.toolName, (row = { calls: 0, failed: 0 }));
    row.calls++;
    if (c.failed) row.failed++;
  }
  return out;
}

function pairTools(left: Counted | undefined, right: Counted | undefined, clock: CompareClock): Pick<CompareResponse, 'tools' | 'otherTools'> {
  const l = toolCounts(left, clock);
  const r = toolCounts(right, clock);
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
    // An undated turn starts at an unknown time (0 here): no duration rather than decades.
    activeMs: t.dated ? turnDurationMs(t, nowMs) : null,
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
    const changes = changesOf(f.counts);
    const known = out.get(key);
    if (known === undefined) out.set(key, { path: rel, counts: f.failed > 0 ? { reads, changes, failed: f.failed } : { reads, changes } });
    else {
      known.counts.reads += reads;
      known.counts.changes += changes;
      if (f.failed > 0) known.counts.failed = (known.counts.failed ?? 0) + f.failed;
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
  options: CompareClock & { sameSession: boolean },
): CompareResponse {
  const clock: CompareClock = { nowMs: options.nowMs, dayKey: options.dayKey };
  const counted = (x: CompareInput | null): Counted | undefined =>
    x === null ? undefined : { ...x, totals: sessionTotals(x.summary, 'all', clock.nowMs, clock.dayKey) };
  const l = counted(left);
  const r = counted(right);
  return {
    left: l === undefined ? null : compareSide(l.session, l.summary, clock, l.totals),
    right: r === undefined ? null : compareSide(r.session, r.summary, clock, r.totals),
    sameSession: options.sameSession,
    ...pairTools(l, r, clock),
    ...pairTurns(left?.summary, right?.summary, clock.nowMs),
    files: pairFiles(left, right),
  };
}
