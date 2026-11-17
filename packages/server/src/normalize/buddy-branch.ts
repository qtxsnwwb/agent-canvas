/*
 * The active branch of a WorkBuddy / CodeBuddy Code transcript (docs/formats/buddy-family.md section 7, a port of the
 * engine's resolveReplayHistory / resolveColdStartTargetId / getActiveHistory; spec 4.4). The file is an append-only
 * journal whose conversation entries form a `parentId` tree; a rewind, an edit-and-resend or a content filter appends a
 * marker and continues elsewhere in the tree. Without a marker the file is shown as it is (the engine does not walk:
 * duplicate ids would make a blind walk lose entries).
 *
 * The walk follows ids through an index (id -> entry positions) and each entry's previous entry, so it costs the length
 * of the branch it walks, not of the file; with `stop` it ends at the first entry of the previous branch it meets (the
 * rest of the walk from there is the previous walk's).
 */

/** The facts of one line the walk needs (a few ids and flags; never content). */
export interface BranchLine {
  id: string | null;
  parentId: string | null;
  logicalParentId: string | null;
  type: string;
  /** A custom ("fact") record: never the tip, never matched by the walk. */
  custom: boolean;
  /** `providerData.agent` is the compaction agent. */
  isCompactAgent: boolean;
  /** `providerData.contentFilterNotice` (an assistant message). */
  contentFilterNotice: boolean;
  /** A `resend-fork-notice` (rewind / edit tombstone). */
  resendForkNotice: boolean;
}

const SESSION_META = 'session-meta';

/** Flags of a whole file that decide whether and from where the walk runs. */
export interface BranchFlags {
  /** Index of the last tombstone (-1: none). */
  lastNotice: number;
  /** Index of the last conversation entry, and of the last one with an id (-1: none). */
  lastEntry: number;
  lastIdEntry: number;
  /** Index of the last line that is not session-meta (-1: none). */
  lastLine: number;
  /** Some line has a parentId (the engine walks nothing in a file without any). */
  hasParent: boolean;
  hasFilter: boolean;
  /** Some line has a logicalParentId and no parentId (a compaction boundary): the walk follows logicalParentId. */
  compact: boolean;
}

export function emptyFlags(): BranchFlags {
  return { lastNotice: -1, lastEntry: -1, lastIdEntry: -1, lastLine: -1, hasParent: false, hasFilter: false, compact: false };
}

export const isEntry = (l: BranchLine): boolean => !l.custom && l.type !== SESSION_META;

/** Adds line `i` to `flags` (lines in file order). */
export function addFlags(flags: BranchFlags, line: BranchLine, i: number): void {
  if (line.type === SESSION_META) return;
  flags.lastLine = i;
  if (line.resendForkNotice) flags.lastNotice = i;
  if (!line.custom) {
    flags.lastEntry = i;
    if (line.id !== null) flags.lastIdEntry = i;
  }
  if (line.parentId !== null) flags.hasParent = true;
  if (line.contentFilterNotice) flags.hasFilter = true;
  if (line.logicalParentId !== null && line.parentId === null) flags.compact = true;
}

/** The tombstone is the last line that matters (only facts after it): its parentId is the tip ("pending head"). */
export const pendingHead = (f: BranchFlags): boolean => f.lastNotice > f.lastEntry;

/** True when the file is shown as it is: no marker, or a marker in a file where no line has a parentId (and no pending head). */
export function showsAll(f: BranchFlags): boolean {
  if (pendingHead(f)) return false;
  return !f.hasParent || (!f.hasFilter && f.lastNotice < 0);
}

/** The next parent of a walk at `line` (the earliest of its run of one id), the engine's rule. */
export function nextParent(line: BranchLine, i: number, f: BranchFlags): string | null {
  if (line.parentId !== null) return line.parentId;
  return f.compact || i === f.lastLine || line.isCompactAgent ? line.logicalParentId : null;
}

/** How the walk finds entries: the entry before an entry, and the latest entry with an id before a position. */
export interface BranchIndex {
  /** Index of the conversation entry before entry `i` (custom lines are invisible to the walk), or -1. */
  prevEntry(i: number): number;
  /** Index of the latest conversation entry with id `id` before position `before`, or -1. */
  latestBefore(id: string, before: number): number;
}

/** The latest of the ascending positions `list` below `before` (binary search), or -1. */
export function latestIn(list: number | readonly number[] | undefined, before: number): number {
  if (list === undefined) return -1;
  if (typeof list === 'number') return list < before ? list : -1;
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]! < before) {
      found = list[mid]!;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Records entry `i` with `id` in an id index (a single position, or an ascending list). */
export function indexId(index: Map<string, number | number[]>, id: string, i: number): void {
  const cur = index.get(id);
  if (cur === undefined) index.set(id, i);
  else if (typeof cur === 'number') index.set(id, [cur, i]);
  else cur.push(i);
}

/**
 * The result of a walk: the entries it visited (descending), the line it started at (-1: empty conversation),
 * whether it met a dangling parent (an id no earlier entry has: an anomaly, the branch is then not selected), and the
 * entry of the previous branch it stopped at (-1: it went to the root).
 */
export interface BranchWalk {
  visited: number[];
  tip: number;
  dangling: boolean;
  stoppedAt: number;
}

/**
 * The walk of format reference section 7 over `lines` with `flags` of the whole file; null when the file is shown as
 * it is. With `stop`, the walk ends at the first entry for which it is true (an entry of the previous branch: from
 * there on the walk is the previous one's, since the walk from an entry depends only on the entry).
 */
export function walk(lines: readonly BranchLine[], flags: BranchFlags, index: BranchIndex, stop: ((i: number) => boolean) | null): BranchWalk | null {
  if (showsAll(flags)) return null;
  const out: BranchWalk = { visited: [], tip: -1, dangling: false, stoppedAt: -1 };
  // The tip: the tombstone's parent while it is pending; else the last entry with an id after the last tombstone
  // (falling back to that tombstone's parent when there is none).
  let start = -1;
  if (!pendingHead(flags) && flags.lastIdEntry > flags.lastNotice) start = flags.lastIdEntry;
  else {
    const tipId = flags.lastNotice >= 0 ? lines[flags.lastNotice]!.parentId : null;
    if (tipId === null) return out; // an empty conversation
    start = index.latestBefore(tipId, lines.length);
    if (start < 0) {
      out.dangling = true;
      return out;
    }
  }
  out.tip = start;
  let i = start;
  for (;;) {
    if (stop !== null && stop(i)) {
      out.stoppedAt = i;
      return out;
    }
    out.visited.push(i);
    const id = lines[i]!.id;
    // The run of one id: the entries immediately before it with the same id are taken with it.
    let j = index.prevEntry(i);
    while (j >= 0 && id !== null && lines[j]!.id === id) {
      if (stop !== null && stop(j)) {
        out.stoppedAt = j;
        return out;
      }
      out.visited.push(j);
      i = j;
      j = index.prevEntry(i);
    }
    const parent = nextParent(lines[i]!, i, flags);
    if (parent === null) return out; // a root
    const k = index.latestBefore(parent, i);
    if (k < 0) {
      out.dangling = true;
      return out;
    }
    i = k;
  }
}

/** An index over a whole array of lines (for the pure function). */
function indexOf(lines: readonly BranchLine[]): BranchIndex {
  const ids = new Map<string, number | number[]>();
  const prev = new Int32Array(lines.length);
  let last = -1;
  lines.forEach((l, i) => {
    prev[i] = last;
    if (!isEntry(l)) return;
    if (l.id !== null) indexId(ids, l.id, i);
    last = i;
  });
  return { prevEntry: (i) => prev[i]!, latestBefore: (id, before) => latestIn(ids.get(id), before) };
}

/**
 * Indices of the lines on the active branch, or null when the file has no fork marker (show everything) — or when the
 * walk meets a dangling parent (an anomaly: the engine's safe default of showing the file as it is). Port of the
 * algorithm in format reference section 7. Custom lines are invisible to the walk (never matched by id, never breaking
 * a run of one id); afterwards a custom line is in the set when its parentId is the id of an active entry.
 */
export function activeBranch(lines: readonly BranchLine[]): ReadonlySet<number> | null {
  const flags = emptyFlags();
  lines.forEach((l, i) => addFlags(flags, l, i));
  const w = walk(lines, flags, indexOf(lines), null);
  if (w === null || w.dangling) return null;
  const set = new Set<number>(w.visited);
  const ids = new Set<string>();
  for (const i of w.visited) if (lines[i]!.id !== null) ids.add(lines[i]!.id!);
  lines.forEach((l, c) => {
    if (l.custom && l.type !== SESSION_META && l.parentId !== null && ids.has(l.parentId)) set.add(c);
  });
  return set;
}
