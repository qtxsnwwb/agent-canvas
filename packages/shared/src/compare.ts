import type { Origin, SessionStatus } from './model.js';

/**
 * GET /api/compare?a=<sessionId>&b=<sessionId> (spec 2026-11-24-compare-design.md, sections 4 and 5): two sessions'
 * numbers side by side, computed from the stats page's session summary and the file page's file summary.
 *
 * Definitions: a side's activeMs, turns, toolCalls, failed and tokens are exactly what the stats page totals for the
 * session with range `all` (server stats/aggregate.ts sessionTotals): its turns and extras dated on a day up to today.
 * - activeMs: Σ turnDurationMs(turn, now) over those turns (in progress counts to now, cut 15 min after the last
 *   activity); turns: their number.
 * - toolCalls / failed: tool and subagent calls (subagent-internal ones included) / those failed or denied, of those
 *   turns and extras.
 * - tokens: the stats page's three categories summed over those turns and extras; null when the session has no token
 *   data (no node carries usage) or nothing of it is counted.
 * - steps: every node of the session; subagents: dispatch nodes (`kind === 'subagent'`).
 * - The by-tool rows count the same calls; the by-turn rows list every turn of the session (an undated one too: its
 *   activeMs null).
 *
 * Content: session titles, prompt heads (≤ 80 code points, a cut one ends in `…`), file paths and cwds; the page masks
 * them by rule.
 */

/** Most tool rows; the remaining tools are summed into `otherTools` (「其他」). */
export const COMPARE_TOOLS_MAX = 30;
/** Most turn rows (the first ones); more: `turnsTruncated`. */
export const COMPARE_TURNS_MAX = 50;
/** Most file rows per group (the first in the group's order); the rest are counted in `files.more`. */
export const COMPARE_FILES_MAX = 100;

export interface CompareTokens { input: number; cachedInput: number; output: number }

export interface CompareSide {
  sessionId: string;
  /** The pages' name for the session (shared sessionName). */
  title: string;
  origin: Origin;
  projectId: string;
  cwd: string | null;
  status: SessionStatus;
  lastActivityAt: string;
  activeMs: number;
  turns: number;
  steps: number;
  toolCalls: number;
  failed: number;
  subagents: number;
  tokens: CompareTokens | null;
}

export interface CompareToolCounts { calls: number; failed: number }

/** One tool name (paired literally between the sides); a side without that tool (or without a session) is null. */
export interface CompareToolRow {
  toolName: string;
  left: CompareToolCounts | null;
  right: CompareToolCounts | null;
}

/** One side's turn: prompt node (null when the turn has none, e.g. a prelude), its head, duration, calls, tokens. */
export interface CompareTurnSide {
  promptNodeId: string | null;
  /** The prompt node's summary (else title), whitespace collapsed, ≤ 80 code points (a cut one ends in `…`); '' without a prompt. */
  promptHead: string;
  /** turnDurationMs at answer time; null for an undated turn (its start is unknown: the page shows 「—」). */
  activeMs: number | null;
  toolCalls: number;
  /** New input + output of the turn; null when the session has no token data. */
  tokens: number | null;
}

/** Turn `index` (1-based) of each side, aligned by position; a side without that turn is null. */
export interface CompareTurnRow {
  index: number;
  left: CompareTurnSide | null;
  right: CompareTurnSide | null;
}

/**
 * Successful reads and changes of a file (the file page's counts). `failed`: its failed or denied touches, present only
 * when there are some (a file touched only by failed attempts reads 0 / 0 and says so).
 */
export interface CompareFileCounts { reads: number; changes: number; failed?: number }

/**
 * One file, paired by its path relative to each session's cwd (the file page's relativePath: the absolute path when
 * outside the cwd); `path` is that relative path (the left side's spelling when both have it).
 */
export interface CompareFileRow {
  path: string;
  left: CompareFileCounts | null;
  right: CompareFileCounts | null;
}

export interface CompareFiles {
  /** Each group by (left + right reads and changes) descending, then path; at most COMPARE_FILES_MAX. */
  both: CompareFileRow[];
  onlyLeft: CompareFileRow[];
  onlyRight: CompareFileRow[];
  /** Files of each group past COMPARE_FILES_MAX (not listed). */
  more: { both: number; onlyLeft: number; onlyRight: number };
  /** Both sessions found and their cwds differ (the pairing is by relative path). */
  cwdsDiffer: boolean;
}

export interface CompareResponse {
  /** null: no session with that id. */
  left: CompareSide | null;
  right: CompareSide | null;
  /** The same id on both sides. */
  sameSession: boolean;
  /** By (left + right calls) descending, then name; at most COMPARE_TOOLS_MAX. */
  tools: CompareToolRow[];
  /** Calls of the tools past COMPARE_TOOLS_MAX, per side (「其他」); null when every tool is listed. */
  otherTools: { left: number; right: number } | null;
  /** At most COMPARE_TURNS_MAX, from turn 1. */
  turns: CompareTurnRow[];
  /** Either side has more than COMPARE_TURNS_MAX turns. */
  turnsTruncated: boolean;
  files: CompareFiles;
}
