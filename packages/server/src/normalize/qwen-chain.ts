/*
 * The live chain of a Qwen Code thread (docs/formats/qwen-code.md 4.2 and 4.5, spec section 5): the records from the
 * last physical conversation record, walked through `parentUuid` until null, a parent the file does not have (a
 * "history gap") or a record the walk already visited (a cycle), in root -> leaf order. The first occurrence of a
 * uuid decides its parent; a repeated uuid is a fragment of that record and moves nothing. Records that are not
 * conversation records (artifact / sources snapshots, managed-session wrappers) are never a leaf and never a link.
 *
 * Kept incrementally: a record whose parent is the current leaf is pushed (O(1)); one whose parent is on the chain
 * truncates the chain after it (O(records removed)); otherwise the walk from the new record collects records until it
 * meets the chain (O(records added)), and the part of the chain before the meeting point stays. The meeting-point
 * shortcut is exact except when the chain's root ends in a cycle that the truncation cuts; then the whole walk is redone.
 */

export interface ChainRecord {
  uuid: string;
  parentUuid: string | null;
  conversation: boolean;
}

/** How the walk ends at the root: a null parent, a parent not in the file, a parent already visited (index of it). */
type RootStop = { kind: 'empty' } | { kind: 'null' } | { kind: 'gap' } | { kind: 'cycle'; to: number };

/**
 * The live chain of a thread, kept incrementally. `add` takes records in physical order (a repeated uuid is a
 * fragment: it does not move anything) and returns the uuids that left the chain and those that joined it, both in
 * chain order. Equal, after any sequence of adds, to: last physical conversation record, walked through parentUuid
 * until null, a missing parent (gap) or a cycle; reversed.
 *
 * `gaps` / `cycles` count the chain roots that ended at a gap / a cycle, each root record counted once per kind (a
 * file that starts mid-conversation is one gap however long it grows).
 */
export class LiveChain {
  /** Conversation records by uuid: their parent (first occurrence). */
  private readonly parents = new Map<string, string | null>();
  private readonly ids: string[] = [];
  private readonly pos = new Map<string, number>();
  private root: RootStop = { kind: 'empty' };
  private readonly gapRoots = new Set<string>();
  private readonly cycleRoots = new Set<string>();
  private gapCount = 0;
  private cycleCount = 0;

  get chain(): readonly string[] {
    return this.ids;
  }

  get gaps(): number {
    return this.gapCount;
  }

  get cycles(): number {
    return this.cycleCount;
  }

  /** Index of `uuid` on the chain, or -1. */
  indexOf(uuid: string): number {
    return this.pos.get(uuid) ?? -1;
  }

  /** A conversation record with this uuid was added. */
  has(uuid: string): boolean {
    return this.parents.has(uuid);
  }

  add(rec: ChainRecord): { removed: string[]; added: string[] } {
    if (!rec.conversation || this.parents.has(rec.uuid)) return { removed: [], added: [] };
    const leaf = rec.uuid;
    this.parents.set(leaf, rec.parentUuid);
    // The walk from the new leaf, up to the chain (join), a root, a gap or a cycle among the records it collects.
    const fresh: string[] = [leaf];
    let seen: Set<string> | null = null;
    let join = -1;
    let stop: RootStop = { kind: 'null' };
    let cur = rec.parentUuid;
    for (;;) {
      if (cur === null) break;
      const at = this.pos.get(cur);
      if (at !== undefined) {
        join = at;
        break;
      }
      if (!this.parents.has(cur)) {
        stop = { kind: 'gap' };
        break;
      }
      if (cur === leaf || (seen !== null && seen.has(cur))) {
        stop = { kind: 'cycle', to: -1 }; // index fixed below
        break;
      }
      if (seen === null) seen = new Set([leaf]);
      seen.add(cur);
      fresh.push(cur);
      cur = this.parents.get(cur)!;
    }
    if (join >= 0) {
      // The chain up to the join point is the walk's continuation unless the root's cycle target is cut off.
      const r = this.root;
      if (r.kind === 'cycle' && r.to > join) return this.rewalk(leaf);
      const removed = this.truncate(join + 1);
      for (let k = fresh.length - 1; k >= 0; k--) this.push(fresh[k]!);
      this.setRoot();
      return { removed, added: fresh.reverse() };
    }
    const removed = this.truncate(0);
    for (let k = fresh.length - 1; k >= 0; k--) this.push(fresh[k]!);
    if (stop.kind === 'cycle') stop = { kind: 'cycle', to: this.pos.get(cur!)! };
    this.root = stop;
    this.count();
    return { removed, added: fresh.reverse() };
  }

  /** Cuts the chain to its first `n` records; returns the removed ones in chain order. */
  private truncate(n: number): string[] {
    const removed = this.ids.slice(n);
    for (const id of removed) this.pos.delete(id);
    this.ids.length = n;
    return removed;
  }

  private push(id: string): void {
    this.pos.set(id, this.ids.length);
    this.ids.push(id);
  }

  /** The root's stop after a join (the root record kept, or a new one when the chain was empty before). */
  private setRoot(): void {
    const first = this.ids[0];
    if (first === undefined) {
      this.root = { kind: 'empty' };
      return;
    }
    const p = this.parents.get(first) ?? null;
    if (p === null) this.root = { kind: 'null' };
    else {
      const at = this.pos.get(p);
      if (at !== undefined) this.root = { kind: 'cycle', to: at };
      else this.root = { kind: 'gap' }; // a known parent off the chain cannot be the root's (the walk would go on)
    }
    this.count();
  }

  private count(): void {
    const first = this.ids[0];
    if (first === undefined) return;
    if (this.root.kind === 'gap' && !this.gapRoots.has(first)) {
      this.gapRoots.add(first);
      this.gapCount += 1;
    } else if (this.root.kind === 'cycle' && !this.cycleRoots.has(first)) {
      this.cycleRoots.add(first);
      this.cycleCount += 1;
    }
  }

  /** The whole walk from `leaf` (a cycle cut by a re-root): removed / added by the common prefix with the old chain. */
  private rewalk(leaf: string): { removed: string[]; added: string[] } {
    const walked: string[] = [];
    const seen = new Set<string>();
    let cur: string | null = leaf;
    let stop: RootStop = { kind: 'null' };
    let cycleAt: string | null = null;
    while (cur !== null) {
      if (!this.parents.has(cur)) {
        stop = { kind: 'gap' };
        break;
      }
      if (seen.has(cur)) {
        stop = { kind: 'cycle', to: -1 };
        cycleAt = cur;
        break;
      }
      seen.add(cur);
      walked.push(cur);
      cur = this.parents.get(cur)!;
    }
    walked.reverse();
    let common = 0;
    while (common < walked.length && common < this.ids.length && walked[common] === this.ids[common]) common += 1;
    const removed = this.truncate(common);
    const added = walked.slice(common);
    for (const id of added) this.push(id);
    this.root = stop.kind === 'cycle' ? { kind: 'cycle', to: this.pos.get(cycleAt!)! } : stop;
    this.count();
    return { removed, added };
  }
}
