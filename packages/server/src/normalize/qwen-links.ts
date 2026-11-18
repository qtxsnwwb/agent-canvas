/*
 * Which dispatch call each Qwen Code subagent thread hangs off (spec 6, docs/formats/qwen-code.md 5.3), kept
 * incrementally. The links are the result of one fixed procedure over what is read now, so the order in which calls,
 * threads and sidecars arrive does not matter:
 *
 * 1. Threads with a valid sidecar, in key order: in the thread its `parentAgentId` names (the main thread when null),
 *    the first shown call (in `order`) whose id is the sidecar's `toolUseId`, or, without one, whose id ends the
 *    thread's agent id after a `-`; among the calls not taken yet. A sidecar whose `toolUseId` matches no shown call
 *    leaves the thread unlinked: the suffix rule is only for threads without a valid sidecar.
 * 2. Threads without one, in key order: the first shown call, in any other thread, whose id ends the thread's agent
 *    id after a `-`, among the calls not taken yet.
 * 3. A link that makes a thread its own ancestor (malformed sidecars, ids ending with each other's call ids) is not
 *    made: in each such cycle the thread with the smallest key stays unlinked.
 *
 * A thread can only want calls whose id is one of its keys (its `toolUseId`, or every suffix of its agent id after a
 * `-`), so the procedure decomposes: an event changes the keys it touches (a call shown or hidden, a thread's id or
 * sidecar changed) and only the threads and calls connected to them through keys are decided again, in the same
 * order, which gives what the whole procedure would. Normally that is one thread and one call: a relink costs what it
 * touches, not the number of threads times the number of calls.
 */

/** A thread as the links see it: its key (MAIN `''` first, then agents by key) and its file's name form (null: main). */
export interface LinkThread {
  readonly key: string;
  readonly stem: string | null;
}

/** A shown dispatch call (`agent` / `task`) of a thread. */
export interface LinkCall<T extends LinkThread> {
  readonly callId: string | null;
  readonly thread: T;
}

/** What a thread's linking depends on: its agent id (records', else sidecar's, else file's) and its valid sidecar. */
export interface LinkInfo {
  realId: string;
  sidecar: { toolUseId: string | null; parentAgentId: string | null } | null;
}

/** The file-name form of an agent id (reference 5.2). */
export const agentStemOf = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, '_');

/** Every suffix of `id` after a `-` (the call ids an agent id `<name>-<callId>` may end with). */
function suffixes(id: string): string[] {
  const out: string[] = [];
  for (let i = id.indexOf('-'); i >= 0; i = id.indexOf('-', i + 1)) if (i + 1 < id.length) out.push(id.slice(i + 1));
  return out;
}

const byKey = (a: LinkThread, b: LinkThread): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

function addTo<K, V>(m: Map<K, Set<V>>, k: K, v: V): void {
  let s = m.get(k);
  if (s === undefined) m.set(k, (s = new Set()));
  s.add(v);
}

function removeFrom<K, V>(m: Map<K, Set<V>>, k: K, v: V): void {
  const s = m.get(k);
  if (s === undefined) return;
  s.delete(v);
  if (s.size === 0) m.delete(k);
}

interface Entry {
  info: LinkInfo;
  keys: string[];
}

export class SubagentLinks<T extends LinkThread, C extends LinkCall<T>> {
  private readonly entries = new Map<T, Entry>();
  /** Shown calls by call id. */
  private readonly live = new Map<string, C[]>();
  /** Threads by the call ids they may want. */
  private readonly wanters = new Map<string, Set<T>>();
  private readonly byRealId = new Map<string, Set<T>>();
  private readonly byStem = new Map<string, Set<T>>();
  /** Threads by the `parentAgentId` their sidecar names (as written, and in file-name form). */
  private readonly byParent = new Map<string, Set<T>>();
  private readonly byParentStem = new Map<string, Set<T>>();
  /** The procedure's choice per thread (rules 1, 2), and the link made (rule 3). */
  private readonly want = new Map<T, C>();
  private readonly made = new Map<T, C>();
  /** Threads left unlinked to break a cycle. */
  private readonly broken = new Set<T>();
  private readonly dirtyKeys = new Set<string>();
  private readonly dirtyThreads = new Set<T>();

  /** `order`: the order of calls (thread key, then place on its chain, then place in its record). */
  constructor(private readonly order: (a: C, b: C) => number) {}

  /** The link made for `t`. */
  linkOf(t: T): C | null {
    return this.made.get(t) ?? null;
  }

  /** An agent thread's id or sidecar is (now) `info`. */
  setThread(t: T, info: LinkInfo): void {
    const old = this.entries.get(t);
    if (old !== undefined) {
      for (const k of old.keys) {
        removeFrom(this.wanters, k, t);
        this.dirtyKeys.add(k);
      }
      removeFrom(this.byRealId, old.info.realId, t);
      this.dirtyParentsOf(old.info.realId);
      const p = old.info.sidecar?.parentAgentId ?? null;
      if (p !== null) {
        removeFrom(this.byParent, p, t);
        removeFrom(this.byParentStem, agentStemOf(p), t);
      }
      const w = this.want.get(t);
      if (w !== undefined && w.callId !== null) this.dirtyKeys.add(w.callId);
    } else if (t.stem !== null) {
      addTo(this.byStem, t.stem, t);
      for (const q of this.byParentStem.get(t.stem) ?? []) this.dirtyThreads.add(q);
    }
    const s = info.sidecar;
    const keys = s !== null && s.toolUseId !== null ? [s.toolUseId] : suffixes(info.realId);
    this.entries.set(t, { info, keys });
    for (const k of keys) {
      addTo(this.wanters, k, t);
      this.dirtyKeys.add(k);
    }
    addTo(this.byRealId, info.realId, t);
    this.dirtyParentsOf(info.realId);
    if (s?.parentAgentId != null) {
      addTo(this.byParent, s.parentAgentId, t);
      addTo(this.byParentStem, agentStemOf(s.parentAgentId), t);
    }
    this.dirtyThreads.add(t);
  }

  /** Something about `t` that its link's node shows changed (its name): reported as touched by the next settle. */
  touch(t: T): void {
    this.dirtyThreads.add(t);
  }

  /** A dispatch call is shown (its record joined its thread's chain). */
  show(c: C): void {
    if (c.callId === null) return;
    const list = this.live.get(c.callId);
    if (list === undefined) this.live.set(c.callId, [c]);
    else if (!list.includes(c)) list.push(c);
    this.dirtyKeys.add(c.callId);
  }

  /** A dispatch call is no longer shown. */
  hide(c: C): void {
    if (c.callId === null) return;
    const list = this.live.get(c.callId);
    if (list === undefined) return;
    const i = list.indexOf(c);
    if (i < 0) return;
    list.splice(i, 1);
    if (list.length === 0) this.live.delete(c.callId);
    this.dirtyKeys.add(c.callId);
  }

  /**
   * Decides again what the events since the last settle may have changed. `changed`: threads whose link changed;
   * `touched`: every thread decided again or touched (their first node and their call's node are worth refreshing).
   */
  settle(): { changed: T[]; touched: T[] } {
    if (this.dirtyKeys.size === 0 && this.dirtyThreads.size === 0) return { changed: [], touched: [] };
    // The threads connected to the changed keys through the keys they want.
    const threads = new Set<T>();
    const keys: string[] = [...this.dirtyKeys];
    const seenKeys = new Set<string>(keys);
    const addThread = (t: T): void => {
      if (threads.has(t)) return;
      threads.add(t);
      for (const k of this.entries.get(t)?.keys ?? []) if (!seenKeys.has(k)) {
        seenKeys.add(k);
        keys.push(k);
      }
    };
    for (const t of this.dirtyThreads) addThread(t);
    for (let i = 0; i < keys.length; i++) for (const t of this.wanters.get(keys[i]!) ?? []) addThread(t);
    this.dirtyKeys.clear();
    this.dirtyThreads.clear();
    // Rules 1 and 2 over them, in key order.
    const sorted = [...threads].filter((t) => this.entries.has(t)).sort(byKey);
    const taken = new Set<C>();
    const next = new Map<T, C | null>();
    const choose = (t: T, e: Entry, accept: (c: C) => boolean): void => {
      const cands: C[] = [];
      for (const k of e.keys) for (const c of this.live.get(k) ?? []) if (c.thread !== t && !taken.has(c) && accept(c)) cands.push(c);
      cands.sort(this.order);
      const c = cands[0] ?? null;
      if (c !== null) taken.add(c);
      next.set(t, c);
    };
    for (const t of sorted) {
      const e = this.entries.get(t)!;
      if (e.info.sidecar === null) continue;
      const p = e.info.sidecar.parentAgentId;
      if (p === null) {
        choose(t, e, (c) => c.thread.stem === null); // the main thread's calls
        continue;
      }
      const parent = this.findAgent(p);
      if (parent === null) next.set(t, null);
      else choose(t, e, (c) => c.thread === parent);
    }
    for (const t of sorted) {
      const e = this.entries.get(t)!;
      if (e.info.sidecar === null) choose(t, e, () => true);
    }
    const changedWant: T[] = [];
    for (const t of sorted) {
      const c = next.get(t) ?? null;
      if ((this.want.get(t) ?? null) === c) continue;
      if (c === null) this.want.delete(t);
      else this.want.set(t, c);
      changedWant.push(t);
    }
    // Rule 3 for the threads whose choice changed, the members of a cycle through them, and those left unlinked before.
    const check: T[] = [...changedWant, ...this.broken];
    const inCheck = new Set<T>(check);
    for (let i = 0; i < check.length; i++) {
      for (const m of this.cycleOf(check[i]!) ?? []) if (!inCheck.has(m)) {
        inCheck.add(m);
        check.push(m);
      }
    }
    const changed: T[] = [];
    for (const t of check) {
      const cycle = this.cycleOf(t);
      const cut = cycle !== null && cycle.every((m) => byKey(t, m) <= 0);
      if (cut) this.broken.add(t);
      else this.broken.delete(t);
      const link = cut ? null : (this.want.get(t) ?? null);
      if ((this.made.get(t) ?? null) === link) continue;
      if (link === null) this.made.delete(t);
      else this.made.set(t, link);
      changed.push(t);
    }
    const touched = new Set<T>([...threads, ...changed]);
    return { changed, touched: [...touched] };
  }

  /** The agent thread an id names: by its agent id (smallest key first), else by its file-name form. */
  private findAgent(id: string): T | null {
    const pick = (s: Set<T> | undefined): T | null => {
      let best: T | null = null;
      for (const t of s ?? []) if (best === null || byKey(t, best) < 0) best = t;
      return best;
    };
    return pick(this.byRealId.get(id)) ?? pick(this.byStem.get(agentStemOf(id)));
  }

  /** Threads whose sidecar's parent lookup may resolve differently once a thread's id is or was `id`. */
  private dirtyParentsOf(id: string): void {
    for (const q of this.byParent.get(id) ?? []) this.dirtyThreads.add(q);
    for (const q of this.byParentStem.get(agentStemOf(id)) ?? []) this.dirtyThreads.add(q);
  }

  /** The threads of the cycle `t` is on through the chosen links (its own ancestor), or null. */
  private cycleOf(t: T): T[] | null {
    const path: T[] = [t];
    const seen = new Set<T>(path);
    for (let cur = this.want.get(t)?.thread; cur !== undefined && cur.stem !== null; cur = this.want.get(cur)?.thread) {
      if (cur === t) return path;
      if (seen.has(cur)) return null;
      seen.add(cur);
      path.push(cur);
    }
    return null;
  }
}
