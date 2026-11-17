/*
 * The active branch of a WorkBuddy / CodeBuddy Code transcript (docs/formats/buddy-family.md section 7, a port of the
 * engine's resolveReplayHistory / resolveColdStartTargetId / getActiveHistory; spec 4.4). The file is an append-only
 * journal whose conversation entries form a `parentId` tree; a rewind, an edit-and-resend or a content filter appends a
 * marker and continues elsewhere in the tree. Without a marker the file is shown as it is (the engine does not walk:
 * duplicate ids would make a blind walk lose entries).
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

/** The result of a walk: the active line indices, and the index of the line the walk started at (-1: none). */
export interface BranchWalk {
  set: Set<number>;
  tip: number;
}

const SESSION_META = 'session-meta';

/** Flags of a whole file that decide whether and from where the walk runs. */
export interface BranchFlags {
  /** Index of the last tombstone (-1: none). */
  lastNotice: number;
  /** Index of the last conversation entry (-1: none). */
  lastEntry: number;
  /** Index of the last line that is not session-meta (-1: none). */
  lastLine: number;
  /** Some line has a parentId (the engine walks nothing in a file without any). */
  hasParent: boolean;
  hasFilter: boolean;
  /** Some line has a logicalParentId and no parentId (a compaction boundary): the walk follows logicalParentId. */
  compact: boolean;
}

export function emptyFlags(): BranchFlags {
  return { lastNotice: -1, lastEntry: -1, lastLine: -1, hasParent: false, hasFilter: false, compact: false };
}

/** Adds line `i` to `flags` (lines in file order). */
export function addFlags(flags: BranchFlags, line: BranchLine, i: number): void {
  if (line.type === SESSION_META) return;
  flags.lastLine = i;
  if (line.resendForkNotice) flags.lastNotice = i;
  if (!line.custom) flags.lastEntry = i;
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

const isEntry = (l: BranchLine): boolean => !l.custom && l.type !== SESSION_META;

/** The index of the conversation entry before `i` (custom lines are invisible to the walk), or -1. */
function prevEntry(lines: readonly BranchLine[], i: number): number {
  for (let j = i - 1; j >= 0; j--) if (isEntry(lines[j]!)) return j;
  return -1;
}

/**
 * The walk of format reference section 7, with the flags of the whole file (`flags`). Null when the file is shown as it
 * is. Custom lines are invisible to the walk (never matched by id, never breaking a run of one id); afterwards a custom
 * line is in the set when its parentId is the id of an active entry.
 */
export function walkBranch(lines: readonly BranchLine[], flags: BranchFlags): BranchWalk | null {
  if (showsAll(flags)) return null;
  const set = new Set<number>();
  // The tip: the tombstone's parent while it is pending; else the last entry with an id (after the last tombstone,
  // falling back to that tombstone's parent when there is none).
  let start = -1;
  let tipId: string | null = null;
  if (pendingHead(flags)) {
    tipId = lines[flags.lastNotice]!.parentId;
  } else {
    for (let i = lines.length - 1; i > flags.lastNotice; i--) {
      const l = lines[i]!;
      if (isEntry(l) && l.id !== null) {
        start = i;
        break;
      }
    }
    if (start < 0 && flags.lastNotice >= 0) tipId = lines[flags.lastNotice]!.parentId;
  }
  if (start < 0) {
    if (tipId === null) return { set, tip: -1 };
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]!;
      if (isEntry(l) && l.id === tipId) {
        start = i;
        break;
      }
    }
    if (start < 0) return { set, tip: -1 };
  }
  const tip = start;
  const ids = new Set<string>();
  // One backward pass: take the entry, and every entry immediately before it with the same id; go on from the
  // earliest of them with its parent.
  let i = start;
  for (;;) {
    const id = lines[i]!.id;
    set.add(i);
    if (id !== null) ids.add(id);
    let j = prevEntry(lines, i);
    while (j >= 0 && id !== null && lines[j]!.id === id) {
      set.add(j);
      i = j;
      j = prevEntry(lines, i);
    }
    const parent = nextParent(lines[i]!, i, flags);
    if (parent === null) break;
    let k = j;
    while (k >= 0 && lines[k]!.id !== parent) k = prevEntry(lines, k);
    if (k < 0) break;
    i = k;
  }
  for (let c = 0; c < lines.length; c++) {
    const l = lines[c]!;
    if (l.custom && l.type !== SESSION_META && l.parentId !== null && ids.has(l.parentId)) set.add(c);
  }
  return { set, tip };
}

/** Indices of the lines on the active branch, or null when the file has no fork marker (show everything). Port of the algorithm in format reference section 7. */
export function activeBranch(lines: readonly BranchLine[]): ReadonlySet<number> | null {
  const flags = emptyFlags();
  lines.forEach((l, i) => addFlags(flags, l, i));
  return walkBranch(lines, flags)?.set ?? null;
}
