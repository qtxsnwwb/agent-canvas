import { describe, expect, test } from 'vitest';
import {
  COMPARE_FILES_MAX,
  COMPARE_TOOLS_MAX,
  COMPARE_TURNS_MAX,
  ORIGINS,
  type FileTouch,
  type GraphNode,
  type Origin,
  type SeqChange,
  type Session,
} from '@agent-canvas/shared';
import { buildCompare, compareSide, type CompareInput } from '../src/compare/compare.js';
import { CompareService } from '../src/compare/service.js';
import { summarizeSessionFiles, type SessionFilesSummary } from '../src/files/summary.js';
import { aggregateStats } from '../src/stats/aggregate.js';
import { SessionSummaryCache, type SessionSummarySource } from '../src/stats/session-cache.js';
import { summarizeSession, turnDurationMs, type SessionSummary } from '../src/stats/summary.js';

// Invented sessions only. The clock: 2026-11-24 12:00 UTC.
const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const iso = (ms: number): string => new Date(ms).toISOString();
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function mkSession(id: string, o: Partial<Session> = {}): Session {
  return {
    id, projectId: 'p1', origin: 'claude', cwd: '/w/app', title: null, gitBranch: null, status: 'idle',
    sourceDeleted: false, startedAt: iso(NOW - 2 * H), lastActivityAt: iso(NOW - H), ...o,
  };
}
let seq = 0;
function n(ms: number, o: Partial<GraphNode> = {}): GraphNode {
  return {
    id: `n${seq++}`, sessionId: 's', turnId: null, agentId: null, parentId: null, kind: 'text', status: null,
    timestamp: iso(ms), confirmed: true, title: 't', summary: 'reply words', toolName: null, toolUseId: null,
    messageId: null, durationMs: null, usage: null, systemSubtype: null, childAgentId: null, endedAt: null, ...o,
  };
}
const promptNode = (ms: number, turnId: string, summary: string, o: Partial<GraphNode> = {}): GraphNode =>
  n(ms, { kind: 'prompt', turnId, summary, ...o });
const callNode = (ms: number, turnId: string | null, toolName: string, o: Partial<GraphNode> = {}): GraphNode =>
  n(ms, { kind: 'tool', turnId, toolName, title: toolName, status: 'succeeded', durationMs: 1000, ...o });

function input(session: Session, nodes: GraphNode[]): CompareInput {
  return { session, summary: summarizeSession(session, nodes), files: summarizeSessionFiles(session, nodes) };
}
const pair = (left: CompareInput | null, right: CompareInput | null, nowMs = NOW) =>
  buildCompare(left, right, { sameSession: left !== null && right !== null && left.session.id === right.session.id, nowMs });

/** A session with calls of the given tools (`[name, calls, failed]`) in one turn. */
function withTools(id: string, tools: [string, number, number][], o: Partial<Session> = {}): CompareInput {
  const start = NOW - 2 * H;
  const nodes: GraphNode[] = [promptNode(start, `${id}-T`, 'do it')];
  let t = start;
  for (const [name, calls, failed] of tools) {
    for (let i = 0; i < calls; i++) nodes.push(callNode(++t, `${id}-T`, name, { status: i < failed ? 'failed' : 'succeeded' }));
  }
  return input(mkSession(id, o), nodes);
}

describe('sides', () => {
  test('the stats page\'s numbers, plus steps, subagents, title, cwd, status', () => {
    const start = NOW - 3 * H;
    const nodes = [
      promptNode(start, 'T1', 'first'),
      callNode(start + 10 * S, 'T1', 'Bash', { status: 'failed' }),
      n(start + 11 * S, { kind: 'subagent', turnId: 'T1', toolName: 'Task', status: 'succeeded', childAgentId: 'ag1' }),
      callNode(start + 12 * S, null, 'Read', { agentId: 'ag1' }),
      n(start + 60 * S, { turnId: 'T1', messageId: 'm1', usage: { inputTokens: 100, cachedInputTokens: 1000, outputTokens: 10 } }),
      promptNode(start + H, 'T2', 'second'),
      n(start + H + 30 * S, { turnId: 'T2', messageId: 'm2', usage: { inputTokens: 50, cachedInputTokens: 500, outputTokens: 5 } }),
      n(start + H + 31 * S, { turnId: 'T2', messageId: 'm2', usage: { inputTokens: 50, cachedInputTokens: 500, outputTokens: 5 } }),
    ];
    const session = mkSession('s-full-id-123456', { title: null, cwd: '/w/app', status: 'idle', lastActivityAt: iso(start + H + 31 * S) });
    const side = compareSide(session, summarizeSession(session, nodes), NOW);
    expect(side).toEqual({
      sessionId: 's-full-id-123456', title: 's-full-i', origin: 'claude', projectId: 'p1', cwd: '/w/app', status: 'idle',
      lastActivityAt: iso(start + H + 31 * S),
      activeMs: 60 * S + 31 * S, turns: 2, steps: 8, toolCalls: 3, failed: 1, subagents: 1,
      tokens: { input: 150, cachedInput: 1500, output: 15 },
    });
  });

  test('a session without token data: tokens null (per session, whatever its origin)', () => {
    const session = mkSession('s1', { origin: 'claude', title: 'Has a title' });
    const side = compareSide(session, summarizeSession(session, [promptNode(NOW - H, 'T1', 'x')]), NOW);
    expect(side.tokens).toBeNull();
    expect(side.title).toBe('Has a title');
  });

  test('a running session: its open turn counts to now', () => {
    const start = NOW - 5 * MIN;
    const session = mkSession('s1', { status: 'running', lastActivityAt: iso(NOW - MIN) });
    const nodes = [promptNode(start, 'T1', 'x'), callNode(NOW - MIN, 'T1', 'Bash', { status: 'running', durationMs: null })];
    expect(compareSide(session, summarizeSession(session, nodes), NOW).activeMs).toBe(5 * MIN);
  });
});

describe('by tool', () => {
  test('merged by the literal name, by left + right calls descending, then name; a side without the tool is null', () => {
    const r = pair(
      withTools('a', [['Bash', 12, 1], ['Read', 30, 0], ['Edit', 2, 0]]),
      withTools('b', [['Bash', 20, 6], ['exec_command', 5, 2], ['Read', 1, 0]]),
    );
    expect(r.tools).toEqual([
      { toolName: 'Bash', left: { calls: 12, failed: 1 }, right: { calls: 20, failed: 6 } },
      { toolName: 'Read', left: { calls: 30, failed: 0 }, right: { calls: 1, failed: 0 } },
      { toolName: 'exec_command', left: null, right: { calls: 5, failed: 2 } },
      { toolName: 'Edit', left: { calls: 2, failed: 0 }, right: null },
    ]);
    expect(r.otherTools).toBeNull();
  });

  test('equal sums: by name', () => {
    const r = pair(withTools('a', [['b', 1, 0], ['a', 1, 0]]), withTools('b', [['c', 1, 0]]));
    expect(r.tools.map((t) => t.toolName)).toEqual(['a', 'b', 'c']);
  });

  test(`past ${COMPARE_TOOLS_MAX} tools: the rest summed per side into otherTools (「其他」)`, () => {
    const left: [string, number, number][] = [];
    for (let i = 0; i < COMPARE_TOOLS_MAX + 2; i++) left.push([`tool${String(i).padStart(2, '0')}`, 100 - i, 0]);
    // The right side has one of the two dropped tools, and one tool of its own that makes the list.
    const r = pair(withTools('a', left), withTools('b', [['tool31', 3, 1], ['zzz', 500, 0]]));
    expect(r.tools).toHaveLength(COMPARE_TOOLS_MAX);
    expect(r.tools[0]).toEqual({ toolName: 'zzz', left: null, right: { calls: 500, failed: 0 } });
    // Listed: zzz and tool00..tool28 (tool28 and tool31 both sum to 72: by name); past the limit: tool31 (left 69,
    // right 3), tool29 (left 71), tool30 (left 70).
    expect(r.tools.map((t) => t.toolName)).not.toContain('tool29');
    expect(r.otherTools).toEqual({ left: 71 + 70 + 69, right: 3 });
  });

  test(`exactly ${COMPARE_TOOLS_MAX} tools: all listed, otherTools null`, () => {
    const left: [string, number, number][] = [];
    for (let i = 0; i < COMPARE_TOOLS_MAX; i++) left.push([`t${i}`, 1, 0]);
    const r = pair(withTools('a', left), withTools('b', []));
    expect(r.tools).toHaveLength(COMPARE_TOOLS_MAX);
    expect(r.otherTools).toBeNull();
  });

  test('a call without a tool name is paired under the stats page\'s (unknown)', () => {
    const start = NOW - H;
    const r = pair(input(mkSession('a'), [promptNode(start, 'T', 'x'), callNode(start + 1, 'T', 'X', { toolName: null })]), null);
    expect(r.tools).toEqual([{ toolName: '(unknown)', left: { calls: 1, failed: 0 }, right: null }]);
  });
});

/** A session of `count` closed turns, turn i lasting (i + 1) minutes with i calls, usage (10i, 1) at its end. */
function withTurns(id: string, count: number, usage = true): CompareInput {
  const nodes: GraphNode[] = [];
  const base = NOW - 100 * H;
  for (let i = 0; i < count; i++) {
    const start = base + i * H;
    const key = `${id}-T${i}`;
    nodes.push(promptNode(start, key, `prompt ${i + 1}`));
    for (let c = 0; c < i; c++) nodes.push(callNode(start + (c + 1) * S, key, 'Bash'));
    nodes.push(n(start + (i + 1) * MIN, { turnId: key, usage: usage ? { inputTokens: 10 * i, cachedInputTokens: 7, outputTokens: 1 } : null }));
  }
  return input(mkSession(id), nodes);
}

describe('by turn', () => {
  test('aligned by index from 1; the shorter side null past its last turn', () => {
    const left = withTurns('a', 3);
    const right = withTurns('b', 1, false);
    const r = pair(left, right);
    expect(r.turnsTruncated).toBe(false);
    expect(r.turns.map((t) => t.index)).toEqual([1, 2, 3]);
    expect(r.turns[0]!.left).toEqual({ promptNodeId: left.summary.turns[0]!.promptNodeId, promptHead: 'prompt 1', activeMs: MIN, toolCalls: 0, tokens: 1 });
    expect(r.turns[2]!.left).toEqual({ promptNodeId: left.summary.turns[2]!.promptNodeId, promptHead: 'prompt 3', activeMs: 3 * MIN, toolCalls: 2, tokens: 21 });
    // No token data on the right: tokens null (not 0).
    expect(r.turns[0]!.right).toEqual({ promptNodeId: right.summary.turns[0]!.promptNodeId, promptHead: 'prompt 1', activeMs: MIN, toolCalls: 0, tokens: null });
    expect(r.turns[1]!.right).toBeNull();
    expect(r.turns[2]!.right).toBeNull();
  });

  test('a turn without a prompt (prelude): promptNodeId null, head empty', () => {
    const start = NOW - H;
    const r = pair(input(mkSession('a'), [n(start), promptNode(start + MIN, 'T1', 'x')]), null);
    expect(r.turns[0]!.left).toMatchObject({ promptNodeId: null, promptHead: '' });
    expect(r.turns[1]!.left).toMatchObject({ promptHead: 'x' });
  });

  test(`past ${COMPARE_TURNS_MAX} turns on either side: the first ${COMPARE_TURNS_MAX} listed, turnsTruncated`, () => {
    const r = pair(withTurns('a', 2), withTurns('b', COMPARE_TURNS_MAX + 1));
    expect(r.turns).toHaveLength(COMPARE_TURNS_MAX);
    expect(r.turns[COMPARE_TURNS_MAX - 1]!.index).toBe(COMPARE_TURNS_MAX);
    expect(r.turnsTruncated).toBe(true);
    const exact = pair(withTurns('a', COMPARE_TURNS_MAX), null);
    expect(exact.turns).toHaveLength(COMPARE_TURNS_MAX);
    expect(exact.turnsTruncated).toBe(false);
  });
});

/** A session whose one turn touches each file `[path, reads, changes]` (paths absolute, or as given). */
function withFiles(id: string, cwd: string | null, files: [string, number, number][]): CompareInput {
  const start = NOW - H;
  const nodes: GraphNode[] = [promptNode(start, 'T', 'x')];
  let t = start;
  for (const [path, reads, changes] of files) {
    for (let i = 0; i < reads; i++) nodes.push(callNode(++t, 'T', 'Read', { files: [{ path, action: 'read' } satisfies FileTouch] }));
    for (let i = 0; i < changes; i++) nodes.push(callNode(++t, 'T', 'Edit', { files: [{ path, action: 'edit' } satisfies FileTouch] }));
  }
  return input(mkSession(id, { cwd }), nodes);
}

describe('files', () => {
  test('three groups, each by left + right touches descending, then path; same cwd', () => {
    const r = pair(
      withFiles('a', '/w/app', [['/w/app/src/ci.yml', 3, 2], ['/w/app/a.ts', 1, 0], ['/w/app/only-left.ts', 0, 1], ['/w/app/b.ts', 1, 0]]),
      withFiles('b', '/w/app', [['/w/app/src/ci.yml', 5, 4], ['/w/app/b.ts', 0, 1], ['/w/app/a.ts', 0, 1], ['/w/app/z.ts', 2, 0], ['/w/app/y.ts', 2, 0]]),
    );
    expect(r.files.cwdsDiffer).toBe(false);
    expect(r.files.both).toEqual([
      { path: 'src/ci.yml', left: { reads: 3, changes: 2 }, right: { reads: 5, changes: 4 } },
      { path: 'a.ts', left: { reads: 1, changes: 0 }, right: { reads: 0, changes: 1 } },
      { path: 'b.ts', left: { reads: 1, changes: 0 }, right: { reads: 0, changes: 1 } },
    ]);
    expect(r.files.onlyLeft).toEqual([{ path: 'only-left.ts', left: { reads: 0, changes: 1 }, right: null }]);
    expect(r.files.onlyRight).toEqual([
      { path: 'y.ts', left: null, right: { reads: 2, changes: 0 } },
      { path: 'z.ts', left: null, right: { reads: 2, changes: 0 } },
    ]);
    expect(r.files.more).toEqual({ both: 0, onlyLeft: 0, onlyRight: 0 });
  });

  test('different cwds: paired by the path relative to each cwd, cwdsDiffer; a file outside the cwd keeps its absolute path', () => {
    const r = pair(
      withFiles('a', '/home/me/app', [['/home/me/app/src/x.ts', 1, 0], ['/etc/hosts', 1, 0]]),
      withFiles('b', '/tmp/clone/app', [['/tmp/clone/app/src/x.ts', 0, 2], ['/etc/hosts', 1, 0]]),
    );
    expect(r.files.cwdsDiffer).toBe(true);
    expect(r.files.both).toEqual([
      { path: 'src/x.ts', left: { reads: 1, changes: 0 }, right: { reads: 0, changes: 2 } },
      { path: '/etc/hosts', left: { reads: 1, changes: 0 }, right: { reads: 1, changes: 0 } },
    ]);
  });

  test('Windows paths: the same cwd spelled differently is not a difference; relative paths pair case-insensitively', () => {
    const r = pair(
      withFiles('a', 'D:\\w\\tea-shop', [['D:/w/tea-shop/src/A.ts', 1, 0]]),
      withFiles('b', 'd:/W/Tea-Shop', [['d:/w/TEA-SHOP/src/a.ts', 0, 1]]),
    );
    expect(r.files.cwdsDiffer).toBe(false);
    expect(r.files.both).toEqual([{ path: 'src/A.ts', left: { reads: 1, changes: 0 }, right: { reads: 0, changes: 1 } }]);
    expect(r.files.onlyLeft).toEqual([]);
    expect(r.files.onlyRight).toEqual([]);
  });

  test('a session without a cwd: its absolute paths; cwds differ when only one side has one', () => {
    const r = pair(withFiles('a', null, [['/w/app/x.ts', 1, 0]]), withFiles('b', '/w/app', [['/w/app/x.ts', 1, 0]]));
    expect(r.files.cwdsDiffer).toBe(true);
    expect(r.files.onlyLeft.map((f) => f.path)).toEqual(['/w/app/x.ts']);
    expect(r.files.onlyRight.map((f) => f.path)).toEqual(['x.ts']);
  });

  test(`past ${COMPARE_FILES_MAX} files in a group: the first ${COMPARE_FILES_MAX} listed, the rest counted in more`, () => {
    const many = (prefix: string, count: number): [string, number, number][] =>
      Array.from({ length: count }, (_, i) => [`/w/app/${prefix}${String(i).padStart(3, '0')}.ts`, 1, 0]);
    const r = pair(
      withFiles('a', '/w/app', [...many('both', COMPARE_FILES_MAX + 3), ...many('left', COMPARE_FILES_MAX + 1)]),
      withFiles('b', '/w/app', [...many('both', COMPARE_FILES_MAX + 3), ...many('right', 2)]),
    );
    expect(r.files.both).toHaveLength(COMPARE_FILES_MAX);
    expect(r.files.onlyLeft).toHaveLength(COMPARE_FILES_MAX);
    expect(r.files.onlyRight).toHaveLength(2);
    expect(r.files.more).toEqual({ both: 3, onlyLeft: 1, onlyRight: 0 });
    expect(r.files.both[0]!.path).toBe('both000.ts');
    expect(r.files.both[COMPARE_FILES_MAX - 1]!.path).toBe(`both${String(COMPARE_FILES_MAX - 1).padStart(3, '0')}.ts`);
  });
});

describe('missing and same sessions', () => {
  test('a missing side: null, and pairing treats it as empty', () => {
    const left = withFiles('a', '/w/app', [['/w/app/x.ts', 1, 0]]);
    const r = pair(left, null);
    expect(r.left?.sessionId).toBe('a');
    expect(r.right).toBeNull();
    expect(r.sameSession).toBe(false);
    expect(r.tools).toEqual([{ toolName: 'Read', left: { calls: 1, failed: 0 }, right: null }]);
    expect(r.turns).toEqual([{ index: 1, left: expect.objectContaining({ promptHead: 'x' }), right: null }]);
    expect(r.files).toEqual({
      both: [], onlyLeft: [{ path: 'x.ts', left: { reads: 1, changes: 0 }, right: null }], onlyRight: [], more: { both: 0, onlyLeft: 0, onlyRight: 0 },
      cwdsDiffer: false,
    });
    const none = pair(null, null);
    expect(none).toEqual({
      left: null, right: null, sameSession: false, tools: [], otherTools: null, turns: [], turnsTruncated: false,
      files: { both: [], onlyLeft: [], onlyRight: [], more: { both: 0, onlyLeft: 0, onlyRight: 0 }, cwdsDiffer: false },
    });
  });

  test('Review Focus 1: a session compared with itself — every pair equal, nothing one-sided', () => {
    const one = withFiles('a', '/w/app', [['/w/app/x.ts', 2, 1], ['/w/app/y.ts', 0, 1]]);
    const more = withTurns('a', 3);
    const both: CompareInput = { session: one.session, summary: more.summary, files: one.files };
    const r = pair(both, both);
    expect(r.sameSession).toBe(true);
    expect(r.left).toEqual(r.right);
    for (const t of r.tools) expect(t.left).toEqual(t.right);
    for (const t of r.turns) expect(t.left).toEqual(t.right);
    expect(r.files.onlyLeft).toEqual([]);
    expect(r.files.onlyRight).toEqual([]);
    for (const f of r.files.both) expect(f.left).toEqual(f.right);
    expect(r.files.cwdsDiffer).toBe(false);
  });

  test('Review Focus 2: a Claude Code session against a Codex session with no turns and no token data', () => {
    const claude = withTools('a', [['Bash', 3, 1], ['Read', 2, 0]], { origin: 'claude' });
    // Codex: only internal nodes (no main-thread turn), no usage.
    const codexSession = mkSession('b', { origin: 'codex', cwd: '/w/app' });
    const codex = input(codexSession, [callNode(NOW - H, null, 'exec_command', { agentId: 'ag', files: [{ path: '/w/app/x.ts', action: 'read' }] })]);
    const r = pair(claude, codex);
    expect(r.right).toMatchObject({ origin: 'codex', turns: 0, activeMs: 0, toolCalls: 1, tokens: null });
    expect(r.left!.tokens).toBeNull();
    expect(r.tools.every((t) => (t.left === null) !== (t.right === null))).toBe(true);
    expect(r.turns.every((t) => t.right === null)).toBe(true);
    expect(r.files.onlyRight.map((f) => f.path)).toEqual(['x.ts']);
  });
});

// ---- consistency with the stats page

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random invented session: turns, calls of several statuses, subagents (resolved or not), usage with repeated message ids. */
function randomSession(rand: () => number, id: string, origin: Origin, projectId: string): { session: Session; nodes: GraphNode[] } {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
  const nodes: GraphNode[] = [];
  const withUsage = rand() < 0.7;
  const running = rand() < 0.3;
  let t = NOW - int(1, 20) * 24 * H - int(0, 23) * H;
  let msg = 0;
  const turnCount = int(0, 6);
  for (let i = 0; i < turnCount; i++) {
    const key = `${id}-T${i}`;
    nodes.push(promptNode(t, key, `prompt ${i}`));
    for (let k = int(0, 8); k > 0; k--) {
      t += int(1, 120) * S;
      const roll = rand();
      if (roll < 0.15) {
        const agent = `${id}-ag${i}-${k}`;
        nodes.push(n(t, { kind: 'subagent', turnId: key, toolName: 'Task', status: pick(['succeeded', 'failed'] as const), childAgentId: rand() < 0.8 ? agent : null }));
        for (let j = int(1, 3); j > 0; j--) {
          t += int(1, 30) * S;
          nodes.push(callNode(t, null, pick(['Read', 'Bash']), { agentId: agent, status: pick(['succeeded', 'failed', 'denied'] as const) }));
        }
      } else {
        const status = pick(['succeeded', 'succeeded', 'failed', 'denied'] as const);
        const dur = int(0, 90) * S;
        nodes.push(callNode(t, key, pick(['Bash', 'Read', 'Edit', 'exec_command']), { status, durationMs: rand() < 0.2 ? null : dur, endedAt: iso(t + dur) }));
      }
      if (withUsage && rand() < 0.6) {
        const repeat = rand() < 0.3 && msg > 0;
        nodes.push(n(t + 1, { turnId: key, messageId: `${id}-m${repeat ? msg : ++msg}`, usage: { inputTokens: int(0, 5000), cachedInputTokens: int(0, 50_000), outputTokens: int(0, 900) } }));
      }
    }
    t += int(1, 60) * MIN;
  }
  // Sometimes internal nodes with no turn at all (extras), sometimes a session exit carrying usage.
  if (turnCount === 0 && rand() < 0.5) nodes.push(callNode(t, null, 'Read', { agentId: `${id}-orphan` }));
  if (withUsage && rand() < 0.3) nodes.push(n(t + 2, { kind: 'system', systemSubtype: 'shutdown', usage: { inputTokens: 7, cachedInputTokens: 70, outputTokens: 1 } }));
  if (running && turnCount > 0) {
    t = Math.max(t, NOW - int(0, 30) * MIN);
    nodes.push(callNode(t, `${id}-T${turnCount - 1}`, 'Bash', { status: 'running', durationMs: null }));
  }
  const session = mkSession(id, {
    origin, projectId, status: running ? 'running' : 'idle', lastActivityAt: iso(Math.min(NOW - 1, t + 3)),
  });
  return { session, nodes: nodes.map((x) => ({ ...x, sessionId: id })) };
}

describe('consistency with the stats page (aggregateStats, range all, the only session of its origin and project)', () => {
  test.each([1, 2, 3, 4, 5, 6, 7, 8])('seed %i: activeMs, turns, toolCalls, failed and tokens equal the stats totals', (seed) => {
    const rand = rng(seed);
    // One session per origin and project, so the stats page's per-origin token rule is this session's.
    const entries = ORIGINS.map((origin, i) => {
      const { session, nodes } = randomSession(rand, `s${seed}-${i}`, origin, `proj-${i}`);
      return { session, summary: summarizeSession(session, nodes) };
    });
    for (const { session, summary } of entries) {
      const stats = aggregateStats({
        entries, failedSessions: 0, projects: [], range: 'all', origin: session.origin, projectId: session.projectId, nowMs: NOW, dayKey: utcDay,
      });
      const side = compareSide(session, summary, NOW);
      expect({ activeMs: side.activeMs, turns: side.turns, toolCalls: side.toolCalls, failed: side.failed, tokens: side.tokens }).toEqual({
        activeMs: stats.totals.activeMs, turns: stats.totals.turns, toolCalls: stats.totals.toolCalls, failed: stats.totals.failed,
        tokens: stats.totals.tokens,
      });
      // The turn rows add up to the side (every turn is dated here).
      const rows = buildCompare({ session, summary, files: null }, null, { sameSession: false, nowMs: NOW }).turns;
      expect(rows.reduce((a, r) => a + r.left!.activeMs, 0)).toBe(summary.turns.slice(0, COMPARE_TURNS_MAX).reduce((a, x) => a + turnDurationMs(x, NOW), 0));
    }
    // The seeds cover sessions with and without token data, running ones, and ones without turns.
    expect(entries.some((e) => e.summary.usageNodes === 0)).toBe(true);
    expect(entries.some((e) => e.summary.usageNodes > 0)).toBe(true);
  });
});

// ---- the service: two caches over one counting source, as buildServer wires them

class MemorySource implements SessionSummarySource {
  readonly sessionsById = new Map<string, { session: Session; nodes: GraphNode[] }>();
  reads: string[] = [];
  seq = 0;
  sessions(): Session[] {
    return [...this.sessionsById.values()].map((x) => x.session);
  }
  async readSession(sessionId: string): Promise<{ session: Session; nodes: GraphNode[]; seq: number } | null> {
    this.reads.push(sessionId);
    const x = this.sessionsById.get(sessionId);
    return x === undefined ? null : { session: x.session, nodes: x.nodes, seq: this.seq };
  }
}

function caches(source: SessionSummarySource) {
  const common = { capacity: 100, maxWeight: 1_000_000, yieldAfterMs: 10, closedMessage: 'closed' };
  const stats = new SessionSummaryCache<SessionSummary>(source, { ...common, summarize: summarizeSession, weight: (s) => s.calls.length });
  const files = new SessionSummaryCache<SessionFilesSummary>(source, { ...common, summarize: summarizeSessionFiles, weight: (s) => s.touchCount });
  files.shareReadsWith(stats);
  return { stats, files };
}

describe('CompareService', () => {
  test('one read per session builds both summaries; a second call reads nothing; a changed session is read again', async () => {
    const source = new MemorySource();
    const a = withFiles('a', '/w/app', [['/w/app/x.ts', 1, 1]]);
    const b = withTools('b', [['Bash', 2, 1]]);
    source.sessionsById.set('a', { session: a.session, nodes: [promptNode(NOW - H, 'T', 'x'), callNode(NOW - H + 1, 'T', 'Read', { files: [{ path: '/w/app/x.ts', action: 'read' }] })] });
    source.sessionsById.set('b', { session: b.session, nodes: [promptNode(NOW - H, 'T', 'y'), callNode(NOW - H + 1, 'T', 'Bash')] });
    const { stats, files } = caches(source);
    const svc = new CompareService({ stats, files, now: () => NOW });

    const first = await svc.compare('a', 'b');
    expect(source.reads.sort()).toEqual(['a', 'b']);
    expect(first.left?.sessionId).toBe('a');
    expect(first.right?.sessionId).toBe('b');
    expect(first.files.onlyLeft.map((f) => f.path)).toEqual(['x.ts']);

    source.reads = [];
    expect(await svc.compare('a', 'b')).toEqual(first);
    expect(await svc.compare('b', 'a')).toMatchObject({ left: { sessionId: 'b' }, right: { sessionId: 'a' } });
    expect(source.reads).toEqual([]);

    source.seq = 5;
    stats.noteChanges([{ seq: 5, type: 'node_updated', sessionId: 'a' } as unknown as SeqChange]);
    files.noteChanges([{ seq: 5, type: 'node_updated', sessionId: 'a' } as unknown as SeqChange]);
    await svc.compare('a', 'b');
    expect(source.reads).toEqual(['a']);
  });

  test('an unknown id: that side null (200 at the route); the same id twice: sameSession, read once', async () => {
    const source = new MemorySource();
    const a = withTools('a', [['Bash', 1, 0]]);
    source.sessionsById.set('a', { session: a.session, nodes: [promptNode(NOW - H, 'T', 'x'), callNode(NOW - H + 1, 'T', 'Bash')] });
    const { stats, files } = caches(source);
    const svc = new CompareService({ stats, files, now: () => NOW });

    const missing = await svc.compare('a', 'nope');
    expect(missing.left?.sessionId).toBe('a');
    expect(missing.right).toBeNull();
    expect(missing.sameSession).toBe(false);

    source.reads = [];
    const fresh = caches(source);
    const same = await new CompareService({ stats: fresh.stats, files: fresh.files, now: () => NOW }).compare('a', 'a');
    expect(source.reads).toEqual(['a']);
    expect(same.sameSession).toBe(true);
    expect(same.left).toEqual(same.right);
  });
});
