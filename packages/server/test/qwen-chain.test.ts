import { describe, expect, test } from 'vitest';
import { LiveChain, type ChainRecord } from '../src/normalize/qwen-chain.js';

// The live chain (docs/formats/qwen-code.md 4.2 / 4.5, spec section 5). Every expectation is a whole-file walk computed
// here independently of the class. It is the reference's rule (4.2 steps 2-5) with one change of ours: a fragment (a
// later line with a uuid already seen) never moves the leaf. So the leaf is the last physical conversation record whose
// uuid is new, where the reference takes the uuid of the last conversation line even when that line is a fragment of an
// earlier record. The walk goes through parentUuid (first occurrence decides) until null, a parent not in the file, or
// a record already visited; reversed.

const r = (uuid: string, parentUuid: string | null, conversation = true): ChainRecord => ({ uuid, parentUuid, conversation });

/** The whole-file walk over a list of records, written without the class (reference 4.2 steps 2-5; fragments never lead). */
function wholeFile(records: readonly ChainRecord[]): string[] {
  const parent = new Map<string, string | null>();
  let leaf: string | null = null;
  for (const rec of records) {
    if (!rec.conversation || parent.has(rec.uuid)) continue;
    parent.set(rec.uuid, rec.parentUuid);
    leaf = rec.uuid;
  }
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = leaf;
  while (cur !== null && parent.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    cur = parent.get(cur)!;
  }
  return out.reverse();
}

/** Adds each record, checking after every add that the chain is the whole-file walk and that removed / added explain the change. */
function feed(records: readonly ChainRecord[]): { chain: LiveChain; steps: { removed: string[]; added: string[] }[] } {
  const chain = new LiveChain();
  const steps: { removed: string[]; added: string[] }[] = [];
  records.forEach((rec, i) => {
    const before = [...chain.chain];
    const step = chain.add(rec);
    steps.push(step);
    const want = wholeFile(records.slice(0, i + 1));
    expect(chain.chain, `after record ${i} (${rec.uuid})`).toEqual(want);
    // removed is a suffix of the old chain, added a suffix of the new one, and the rest is common.
    const kept = before.length - step.removed.length;
    expect(before.slice(kept)).toEqual(step.removed);
    expect([...before.slice(0, kept), ...step.added]).toEqual(want);
    for (const id of want) expect(chain.indexOf(id)).toBe(want.indexOf(id));
  });
  return { chain, steps };
}

describe('LiveChain', () => {
  test('append: each record extends the chain; nothing is removed', () => {
    const { chain, steps } = feed([r('a', null), r('b', 'a'), r('c', 'b')]);
    expect(chain.chain).toEqual(['a', 'b', 'c']);
    expect(steps.map((s) => s.removed)).toEqual([[], [], []]);
    expect(steps.map((s) => s.added)).toEqual([['a'], ['b'], ['c']]);
    expect(chain.gaps).toBe(0);
    expect(chain.cycles).toBe(0);
  });

  test('rewind (reference 4.3): the rewind marker hangs off the record before the target turn; what followed leaves', () => {
    // p1 a1 p2 a2 t2 | rewind (parent a1) session_model (parent rewind) p2' (parent session_model)
    const { chain, steps } = feed([r('p1', null), r('a1', 'p1'), r('p2', 'a1'), r('a2', 'p2'), r('t2', 'a2'), r('rw', 'a1'), r('sm', 'rw'), r('p3', 'sm')]);
    expect(steps[5]).toEqual({ removed: ['p2', 'a2', 't2'], added: ['rw'] });
    expect(chain.chain).toEqual(['p1', 'a1', 'rw', 'sm', 'p3']);
  });

  test('edit-and-resend: a rewind followed by the edited prompt, a sibling of the old one', () => {
    const { chain } = feed([r('p1', null), r('a1', 'p1'), r('p2', 'a1'), r('a2', 'p2'), r('rw', 'a1'), r('p2e', 'rw'), r('a2e', 'p2e')]);
    expect(chain.chain).toEqual(['p1', 'a1', 'rw', 'p2e', 'a2e']);
  });

  test('restore of a tool answer: rewind to the assistant record holding the call, then a new tool_result', () => {
    const { chain, steps } = feed([r('p', null), r('a', 'p'), r('res', 'a'), r('a2', 'res'), r('rw', 'a'), r('res2', 'rw'), r('sm', 'res2')]);
    expect(steps[4]).toEqual({ removed: ['res', 'a2'], added: ['rw'] });
    expect(chain.chain).toEqual(['p', 'a', 'rw', 'res2', 'sm']);
  });

  test('a title anchor is a one-record side leaf: the leaf while it is last, gone at the next record', () => {
    const { chain, steps } = feed([r('p', null), r('a', 'p'), r('title', 'a'), r('p2', 'a')]);
    expect(steps[2]).toEqual({ removed: [], added: ['title'] });
    expect(steps[3]).toEqual({ removed: ['title'], added: ['p2'] });
    expect(chain.chain).toEqual(['p', 'a', 'p2']);
  });

  test('non-conversation records as the last lines are never the leaf, and never a link', () => {
    const { chain, steps } = feed([r('p', null), r('a', 'p'), r('art', 'a', false), r('snap', 'art', false)]);
    expect(steps.slice(2)).toEqual([
      { removed: [], added: [] },
      { removed: [], added: [] },
    ]);
    expect(chain.chain).toEqual(['p', 'a']);
    // A record whose parent is a non-conversation record: its parent is missing (a gap).
    const g = feed([r('p', null), r('art', 'p', false), r('x', 'art')]);
    expect(g.chain.chain).toEqual(['x']);
    expect(g.chain.gaps).toBe(1);
  });

  test('a history gap: the walk stops at a parent the file lacks; a file starting mid-conversation is one gap', () => {
    const { chain } = feed([r('b', 'missing'), r('c', 'b'), r('d', 'c')]);
    expect(chain.chain).toEqual(['b', 'c', 'd']);
    expect(chain.gaps).toBe(1);
    // A record whose parent is unknown restarts the chain from it.
    const g = feed([r('a', null), r('b', 'a'), r('x', 'nowhere')]);
    expect(g.steps[2]).toEqual({ removed: ['a', 'b'], added: ['x'] });
    expect(g.chain.gaps).toBe(1);
  });

  test('a missing parent that arrives later: the walk goes on through it', () => {
    const { chain } = feed([r('b', 'a'), r('c', 'b'), r('a', null), r('d', 'c')]);
    expect(chain.chain).toEqual(['a', 'b', 'c', 'd']);
  });

  test('a cycle: the walk stops at the first record it meets again; counted once', () => {
    // a's parent is c, which arrives later with parent b, b with parent a.
    const { chain } = feed([r('a', 'c'), r('b', 'a'), r('c', 'b'), r('d', 'c')]);
    expect(chain.chain).toEqual(['a', 'b', 'c', 'd']);
    expect(chain.cycles).toBe(1);
    // A re-root that cuts the cycle's target off: the whole walk again.
    const cut = feed([r('a', 'd'), r('b', 'a'), r('c', 'b'), r('d', 'c'), r('e', 'b')]);
    expect(cut.chain.chain).toEqual(['c', 'd', 'a', 'b', 'e']);
  });

  test('fragments: a repeated uuid moves nothing, wherever it is', () => {
    const { chain, steps } = feed([r('p', null), r('a', 'p'), r('p', null), r('b', 'a'), r('a', 'p'), r('a', 'zzz')]);
    expect(steps[2]).toEqual({ removed: [], added: [] });
    expect(steps[4]).toEqual({ removed: [], added: [] });
    expect(steps[5]).toEqual({ removed: [], added: [] });
    expect(chain.chain).toEqual(['p', 'a', 'b']);
  });

  test('a parent that is known but off the chain: the dead branch comes back up to where it meets the chain', () => {
    const { chain, steps } = feed([r('p', null), r('a', 'p'), r('b', 'a'), r('c', 'b'), r('rw', 'p'), r('x', 'rw'), r('d', 'c')]);
    expect(steps[6]).toEqual({ removed: ['rw', 'x'], added: ['a', 'b', 'c', 'd'] });
    expect(chain.chain).toEqual(['p', 'a', 'b', 'c', 'd']);
  });

  test('a null parent restarts the chain', () => {
    const { steps } = feed([r('a', null), r('b', 'a'), r('n', null)]);
    expect(steps[2]).toEqual({ removed: ['a', 'b'], added: ['n'] });
  });

  /** A deterministic generator (mulberry32). */
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  for (const seed of [1, 2, 3, 7, 42, 99, 1234, 2026]) {
    test(`seed ${seed}: random appends, re-roots, gaps, fragments, side leaves and cycles equal the whole-file walk`, () => {
      const rand = rng(seed);
      const records: ChainRecord[] = [];
      const known: string[] = [];
      let tail: string | null = null;
      for (let i = 0; i < 400; i++) {
        const x = rand();
        const id = `u${i}`;
        let rec: ChainRecord;
        if (x < 0.55 || known.length === 0) rec = r(id, tail); // append at the recorder's tail
        else if (x < 0.7) rec = r(id, known[Math.floor(rand() * known.length)]!); // re-root anywhere (rewind / dead branch)
        else if (x < 0.75) rec = r(id, null); // restart
        else if (x < 0.8) rec = r(id, `missing${i}`); // gap
        else if (x < 0.85) rec = r(known[Math.floor(rand() * known.length)]!, tail); // fragment
        else if (x < 0.9) rec = r(id, tail, false); // non-conversation
        else if (x < 0.95) rec = r(`u${i + 1 + Math.floor(rand() * 5)}`, tail); // an id a later record may name as parent (cycles)
        else rec = r(id, tail); // a side leaf: does not become the tail
        records.push(rec);
        if (rec.conversation && !known.includes(rec.uuid)) known.push(rec.uuid);
        if (x < 0.8 && rec.conversation) tail = rec.uuid;
      }
      const { chain } = feed(records);
      expect(chain.chain).toEqual(wholeFile(records));
    });
  }
});
