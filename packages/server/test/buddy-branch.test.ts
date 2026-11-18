import { describe, expect, test } from 'vitest';
import { activeBranch, type BranchLine } from '../src/normalize/buddy-branch.js';

// Format reference section 7, "Active-branch algorithm". Every expected set below is worked out by hand from that
// algorithm (the comment before it gives the walk), not by calling the function under test.

/** A conversation entry (non-custom). */
const L = (id: string | null, parentId: string | null, o: Partial<BranchLine> = {}): BranchLine => ({
  id,
  parentId,
  logicalParentId: null,
  type: 'message',
  custom: false,
  isCompactAgent: false,
  contentFilterNotice: false,
  resendForkNotice: false,
  ...o,
});
/** A custom ("fact") record. */
const F = (type: string, parentId: string | null, id: string | null = null): BranchLine => L(id, parentId, { type, custom: true });
const notice = (parentId: string | null): BranchLine => L(null, parentId, { type: 'resend-fork-notice', custom: true, resendForkNotice: true });
const filter = (id: string, parentId: string | null): BranchLine => L(id, parentId, { contentFilterNotice: true });
const sorted = (s: ReadonlySet<number> | null): number[] | null => (s === null ? null : [...s].sort((a, b) => a - b));

describe('activeBranch', () => {
  test('no fork marker: null (show everything), even with forks, duplicate ids and compaction', () => {
    expect(activeBranch([])).toBeNull();
    expect(activeBranch([L('a', null), L('b', 'a'), L('c', 'b')])).toBeNull();
    // A sibling of b without a marker, a compaction boundary, a duplicate id: still no walk.
    expect(activeBranch([L('a', null), L('b', 'a'), L('x', 'a'), L('B', null, { logicalParentId: 'x' }), L('B', 'B'), F('ai-title', 'B')])).toBeNull();
  });

  test('rewind: the tombstone is last, so the tip is its parentId', () => {
    // 0 a, 1 b(a), 2 c(b), 3 d(c), 4 N(→b). Tip b: b(1) → a(0). Custom N hangs off b (active): kept.
    expect(sorted(activeBranch([L('a', null), L('b', 'a'), L('c', 'b'), L('d', 'c'), notice('b')]))).toEqual([0, 1, 4]);
  });

  test('rewind, then only facts after the tombstone: still the tombstone parent; a fact on the abandoned part is out', () => {
    // 0 a, 1 b(a), 2 c(b), 3 N(→b), 4 ai-title(→c), 5 turn-metrics(→b). Tip b: {0,1}; facts: 3 (→b) and 5 (→b) in, 4 (→c) out.
    expect(sorted(activeBranch([L('a', null), L('b', 'a'), L('c', 'b'), notice('b'), F('ai-title', 'c'), F('turn-metrics', 'b')]))).toEqual([0, 1, 3, 5]);
  });

  test('rewind, then the conversation continues: the tip is the last conversation entry after the tombstone', () => {
    // 0 a, 1 b(a), 2 c(b), 3 d(c), 4 N(→b), 5 e(b), 6 f(e). Tip f: f(6) → e(5) → b(1) → a(0); N (→b) kept.
    expect(sorted(activeBranch([L('a', null), L('b', 'a'), L('c', 'b'), L('d', 'c'), notice('b'), L('e', 'b'), L('f', 'e')]))).toEqual([0, 1, 4, 5, 6]);
  });

  test('edit and resend: the edited prompt and what followed it leave; the new prompt is a sibling', () => {
    // 0 u1, 1 a1(u1), 2 u2(a1), 3 a2(u2), 4 N(→a1), 5 u2'(a1), 6 a2'(u2'). Tip a2': 6 → 5 → 1 → 0; N (→a1) kept.
    const lines = [L('u1', null), L('a1', 'u1'), L('u2', 'a1'), L('a2', 'u2'), notice('a1'), L("u2'", 'a1'), L("a2'", "u2'")];
    expect(sorted(activeBranch(lines))).toEqual([0, 1, 4, 5, 6]);
  });

  test('rewind to an empty conversation: nothing; a new root after it is the only entry', () => {
    // 0 a, 1 b(a), 2 N(no parent). Tip absent: empty.
    expect(sorted(activeBranch([L('a', null), L('b', 'a'), notice(null)]))).toEqual([]);
    // + 3 x (no parent). Tip x: x(3), its parent absent → stop.
    expect(sorted(activeBranch([L('a', null), L('b', 'a'), notice(null), L('x', null)]))).toEqual([3]);
  });

  test('content filter notice: the filtered output is forked off', () => {
    // 0 u, 1 r1(u), 2 r2(r1), 3 notice F(→u). No tombstone, a filter notice → tip = last entry F: 3 → 0.
    expect(sorted(activeBranch([L('u', null), L('r1', 'u'), L('r2', 'r1'), filter('F', 'u')]))).toEqual([0, 3]);
    // The conversation continues after it: 4 u2(F), 5 r3(u2). Tip r3: 5 → 4 → 3 → 0.
    expect(sorted(activeBranch([L('u', null), L('r1', 'u'), L('r2', 'r1'), filter('F', 'u'), L('u2', 'F'), L('r3', 'u2')]))).toEqual([0, 3, 4, 5]);
  });

  test('compaction is not a branch switch: the walk crosses the boundary by logicalParentId', () => {
    // 0 a, 1 b(a), 2 B(no parent, logical b), 3 c(B), 4 d(c), 5 N(→c). compact = true (2 has logicalParentId and no
    // parentId). Tip c: c(3) → B(2): parentId absent, compact → logicalParentId b → b(1) → a(0). N (→c) kept.
    const lines = [L('a', null), L('b', 'a'), L('B', null, { logicalParentId: 'b' }), L('c', 'B'), L('d', 'c'), notice('c')];
    expect(sorted(activeBranch(lines))).toEqual([0, 1, 2, 3, 5]);
  });

  test('compaction agent lines and a boundary with a marker after it: everything before the boundary stays', () => {
    // 0 u, 1 r(u), 2 k1(r, agent compact), 3 k2(k1, agent compact), 4 B(no parent, logical k2), 5 u2(B), 6 r2(u2),
    // 7 N(→u2). Tip u2: 5 → B(4) → logical k2 → 3 → 2 → 1 → 0.
    const lines = [
      L('u', null),
      L('r', 'u'),
      L('k1', 'r', { isCompactAgent: true }),
      L('k2', 'k1', { isCompactAgent: true }),
      L('B', null, { logicalParentId: 'k2' }),
      L('u2', 'B'),
      L('r2', 'u2'),
      notice('u2'),
    ];
    expect(sorted(activeBranch(lines))).toEqual([0, 1, 2, 3, 4, 5, 7]);
  });

  test('duplicate ids: an entry and the immediately preceding entries with its id are taken together; the walk goes on from the earliest', () => {
    // 0 a, 1 X(a) message, 2 X(X) call sharing the id, 3 r(X), 4 s(r), 5 N(→r).
    // Tip r: r(3) → E = X: 2 has X; 1 (immediately before) has X too → take 2, 1; earliest 1 → E = a → 0.
    const lines = [L('a', null), L('X', 'a'), L('X', 'X', { type: 'function_call' }), L('r', 'X'), L('s', 'r'), notice('r')];
    expect(sorted(activeBranch(lines))).toEqual([0, 1, 2, 3, 5]);
  });

  test('duplicate ids that are not adjacent: one backward pass, the latest line with the id first', () => {
    // 0 a, 1 b(a), 2 x(b), 3 b(x) (a later line reusing id b), 4 y(b), 5 N(→y).
    // Tip y: 4 → E = b: scanning back from 3 finds 3 (2 is x: not the same id) → E = x → 2 → E = b: from 1 → 1 → a → 0.
    const lines = [L('a', null), L('b', 'a'), L('x', 'b'), L('b', 'x'), L('y', 'b'), notice('y')];
    expect(sorted(activeBranch(lines))).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test('facts are invisible to the walk: never matched by id (a snapshot reusing an entry id), never breaking a run of one id', () => {
    // 0 a, 1 X(a) message, 2 file-history-snapshot with id X (→X), 3 X(a) call, 4 N(→X).
    // Tip X: the latest entry with id X is 3 (2 is a fact); the entry before it (skipping the fact) is 1 with id X:
    // taken too; earliest 1 → E = a → 0. Facts 2 (→X) and 4 (→X) hang off an active entry: kept.
    const lines = [L('a', null), L('X', 'a'), F('file-history-snapshot', 'X', 'X'), L('X', 'a', { type: 'function_call' }), notice('X')];
    expect(sorted(activeBranch(lines))).toEqual([0, 1, 2, 3, 4]);
  });

  test('a dangling parent (an id no earlier entry has) is an anomaly: no branch selection, everything shown', () => {
    // 0 a, 1 b(missing), 2 c(b), 3 N(→c). Tip c: 2 → 1 → E = missing: not found → null.
    expect(activeBranch([L('a', null), L('b', 'missing'), L('c', 'b'), notice('c')])).toBeNull();
    // A tombstone whose parent does not exist: the same.
    expect(activeBranch([L('a', null), L('b', 'a'), notice('missing')])).toBeNull();
    // A logicalParentId that does not exist (in a file with compaction): the same.
    expect(activeBranch([L('a', null), L('B', null, { logicalParentId: 'gone' }), L('c', 'B'), notice('c')])).toBeNull();
    // A walk that does not pass the dangling entry still selects: 0 a, 1 x(missing), 2 b(a), 3 N(→b) → b(2) → a(0).
    expect(sorted(activeBranch([L('a', null), L('x', 'missing'), L('b', 'a'), notice('b')]))).toEqual([0, 2, 3]);
  });

  test('an absent parentId is a legitimate root: the walk ends there', () => {
    // 0 a, 1 r (no parent: a new root), 2 c(r), 3 N(→c). Tip c: 2 → 1 → no parent, end. {1,2} + N.
    expect(sorted(activeBranch([L('a', null), L('r', null), L('c', 'r'), notice('c')]))).toEqual([1, 2, 3]);
  });

  test('the tip is the last entry that has an id; with none after the tombstone, the tombstone parent', () => {
    // 0 a, 1 b(a), 2 c(b), 3 N(→a), 4 entry without id (→a). No entry with an id after N → tip a → {0}; N kept.
    expect(sorted(activeBranch([L('a', null), L('b', 'a'), L('c', 'b'), notice('a'), L(null, 'a')]))).toEqual([0, 3]);
    // 0 a, 1 b(a), 2 F(→a, filter), 3 entry without id. No tombstone; tip = last entry with an id = F → 2 → 0.
    expect(sorted(activeBranch([L('a', null), L('b', 'a'), filter('F', 'a'), L(null, 'F')]))).toEqual([0, 2]);
  });

  test('a marker in a file where no line has a parentId: shown as is (the engine does not walk)', () => {
    expect(activeBranch([L('a', null), L('b', null), filter('F', null)])).toBeNull();
    // A tombstone that is the last line still decides (it is the pending head): its parent is absent → empty.
    expect(sorted(activeBranch([L('a', null), L('b', null), notice(null)]))).toEqual([]);
  });

  test('session-meta lines are not lines of the conversation: never in the set, never the last line', () => {
    // 0 session-meta, 1 a, 2 b(a), 3 c(b), 4 N(→b), 5 session-meta. Tip b: 2 → 1.
    const meta = F('session-meta', null, 'm');
    expect(sorted(activeBranch([meta, L('a', null), L('b', 'a'), L('c', 'b'), notice('b'), meta]))).toEqual([1, 2, 4]);
  });

  test('several tombstones: the last one decides', () => {
    // 0 a, 1 b(a), 2 c(b), 3 N1(→a), 4 d(a), 5 e(d), 6 N2(→d). Tip d: 4 → 0. N2 (→d) kept; N1 (→a) kept.
    const lines = [L('a', null), L('b', 'a'), L('c', 'b'), notice('a'), L('d', 'a'), L('e', 'd'), notice('d')];
    expect(sorted(activeBranch(lines))).toEqual([0, 3, 4, 6]);
  });
});
