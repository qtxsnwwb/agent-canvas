import { describe, expect, test } from 'vitest';
import { applyChanges, emptyGraph, type Change, type GraphNode, type Session } from '@claude-canvas/shared';
import { CursorNormalizer } from '../src/normalize/cursor.js';
import type { RawEvent } from '../src/store/store.js';
import { interleave, run, type RunResult } from './codex-fixtures.js';
import { at, CursorConv, iso } from './cursor-records.js';

// Fix round 1 of the Cursor normalizer review: edge removal (I1), the parallel rule's end time (I2), dispatch status
// after the parent's turn (I3), checkpointed derivation (I4), the abort rule, the agentId link, tool summaries.
// Synthetic records only.

const ROOT = 'c-root';
const SUB = 'c-sub';

const go = (events: RawEvent[], options?: { checkpointEvery?: number }): RunResult => run(new CursorNormalizer(options), events);
const nodeOf = (r: RunResult, id: string): GraphNode => {
  const n = r.graph.nodes[id];
  if (n === undefined) throw new Error(`no node ${id}; have ${Object.keys(r.graph.nodes).join(', ')}`);
  return n;
};
const edgeIds = (r: RunResult): string[] => Object.keys(r.graph.edges).sort();
const detailOf = (r: RunResult, id: string): Record<string, unknown> => {
  let d: Record<string, unknown> = {};
  for (const c of r.changes) {
    if (c.type === 'node_added' && c.node.id === id) d = { ...c.detail };
    if (c.type === 'node_updated' && c.id === id && c.detail !== undefined) d = { ...d, ...c.detail };
  }
  return d;
};
const graphOf = (r: RunResult, id = ROOT) => ({ nodes: r.graph.nodes, edges: r.graph.edges, session: r.sessions.get(id) });
const lineOf = (e: RawEvent): Record<string, unknown> => JSON.parse((e as { line: string }).line) as Record<string, unknown>;

/** Only the final record of each bubble and composer, each conversation in its own order (order, createdAt, id). */
function finalOnly(convs: RawEvent[][]): RawEvent[] {
  const out: RawEvent[] = [];
  for (const events of convs) {
    const last = new Map<string, RawEvent>();
    for (const e of events) {
      const rec = lineOf(e);
      last.set((e as { recordType: string }).recordType === 'composer' ? '\u0000composer' : String(rec.bubbleId), e);
    }
    const composer = last.get('\u0000composer');
    last.delete('\u0000composer');
    const key = (e: RawEvent): [number, string, string] => {
      const r = lineOf(e);
      return [typeof r.order === 'number' ? r.order : Infinity, String(r.createdAt ?? '￿'), String(r.bubbleId)];
    };
    const sorted = [...last.values()].sort((x, y) => {
      const [a, b] = [key(x), key(y)];
      return a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
    });
    if (composer !== undefined) out.push(composer);
    out.push(...sorted);
  }
  return out;
}

describe('I1: edges a later record no longer derives are removed', () => {
  test('S1: a loading call completes before the next call started: parallel → sequential, fork edges withdrawn', () => {
    const c = new CursorConv({ id: ROOT });
    const events = [
      c.composer({ status: 'none' }),
      c.user('u', 'go', 0),
      c.tool('A', 'read_file_v2', 'loading', 1),
      c.tool('B', 'read_file_v2', 'completed', 5),
      c.update('A', { completedAtMs: at(3), toolFormerData: { status: 'completed' } }),
    ];
    const live = go(events);
    expect(edgeIds(live)).toEqual([`${c.node('A')}->${c.node('B')}`, `${c.node('u')}->${c.node('A')}`].sort());
    expect(graphOf(live)).toEqual(graphOf(go(finalOnly([events]))));
    const removed = live.changes.filter((x): x is Extract<Change, { type: 'edge_removed' }> => x.type === 'edge_removed').map((x) => x.id);
    expect(removed.sort()).toEqual([`${c.node('u')}->${c.node('A')}:fork`, `${c.node('u')}->${c.node('B')}`].sort());
  });

  test('S3: an order swap re-parents and leaves no cycle', () => {
    const c = new CursorConv({ id: ROOT });
    const events = [c.user('u', 'go', 0, { order: 0 }), c.text('a', 'one', 1, { order: 1 }), c.text('b', 'two', 2, { order: 2 }), c.update('b', { order: 1 }), c.update('a', { order: 2 })];
    const live = go(events);
    expect(edgeIds(live)).toEqual([`${c.node('b')}->${c.node('a')}`, `${c.node('u')}->${c.node('b')}`].sort());
    expect(graphOf(live)).toEqual(graphOf(go(finalOnly([events]))));
  });

  test('S5: an empty bubble that later becomes a tool takes its place in the chain', () => {
    const c = new CursorConv({ id: ROOT });
    const events = [
      c.user('u', 'go', 0),
      c.bubble({ bubbleId: 'x', type: 2, createdAt: iso(at(1)), startedAtMs: at(1) }),
      c.text('y', 'after', 5),
      c.update('x', { capabilityType: 15, completedAtMs: at(2), toolFormerData: { name: 'read_file_v2', status: 'completed', toolCallId: 'cx', params: '{"targetFile":"a.ts"}' } }),
    ];
    const live = go(events);
    expect(edgeIds(live)).toEqual([`${c.node('u')}->${c.node('x')}`, `${c.node('x')}->${c.node('y')}`].sort());
    expect(graphOf(live)).toEqual(graphOf(go(finalOnly([events]))));
  });
});

describe('I2: the parallel rule uses the end the node shows', () => {
  test('an error call without completedAtMs ends where the next bubble starts: later calls are sequential', () => {
    const c = new CursorConv({ id: ROOT });
    const r = go([
      c.user('u', 'go', 0),
      c.tool('A', 'grep', 'error', 1, { over: { completedAtMs: null } }),
      c.tool('B', 'grep', 'completed', 10),
      c.tool('C', 'grep', 'completed', 20),
      c.text('t', 'done', 30),
    ]);
    expect(nodeOf(r, c.node('A')).endedAt).toBe(iso(at(10)));
    expect(nodeOf(r, c.node('B')).parentId).toBe(c.node('A'));
    expect(nodeOf(r, c.node('C')).parentId).toBe(c.node('B'));
    expect(Object.values(r.graph.edges).filter((e) => e.kind === 'fork')).toEqual([]);
  });

  test('a loading call settled by the end of its turn no longer sweeps the later calls into a run', () => {
    const c = new CursorConv({ id: ROOT });
    const events = [c.user('u', 'go', 0), c.tool('A', 'grep', 'loading', 1), c.tool('B', 'grep', 'completed', 10), c.tool('C', 'grep', 'completed', 20), c.turnEnd('e', 30)];
    const r = go(events);
    expect(nodeOf(r, c.node('A'))).toMatchObject({ status: 'failed', endedAt: iso(at(10)) });
    expect(nodeOf(r, c.node('B')).parentId).toBe(c.node('A'));
    expect(nodeOf(r, c.node('C')).parentId).toBe(c.node('B'));
    expect(graphOf(r)).toEqual(graphOf(go(finalOnly([events]))));
  });
});

describe('I3: a dispatch after its parent turn ended', () => {
  test('the subagent never showed it finished: the task_v2 status, not running', () => {
    const c = new CursorConv({ id: ROOT });
    const s = new CursorConv({ id: SUB, sessionId: ROOT });
    const r = go([
      c.composer({ status: 'completed' }),
      c.user('u', 'go', 0),
      c.task('t', 'tc1', 'completed', 1, { durSec: 5 }),
      c.text('a', 'reply', 8),
      c.turnEnd('e', 9),
      s.subagentComposer('tc1', ROOT, { status: 'none' }),
      s.user('su', 'task', 2),
      s.text('sa', 'partial', 3),
    ]);
    expect(r.sessions.get(ROOT)!.status).toBe('idle');
    expect(nodeOf(r, c.node('t'))).toMatchObject({ status: 'succeeded', endedAt: iso(at(6)), childAgentId: SUB });
  });

  test('the subagent composer arrived but none of its bubbles: the task_v2 status once the turn ended; still loading → never finished', () => {
    const c = new CursorConv({ id: ROOT });
    const s = new CursorConv({ id: SUB, sessionId: ROOT });
    const r = go([c.user('u', 'go', 0), c.task('t', 'tc1', 'completed', 1), s.subagentComposer('tc1'), c.turnEnd('e', 9)]);
    expect(nodeOf(r, c.node('t')).status).toBe('succeeded');
    const d = new CursorConv({ id: ROOT });
    const r2 = go([d.user('u', 'go', 0), d.task('t', 'tc1', 'loading', 1), s.subagentComposer('tc1'), d.user('u2', 'next', 20)]);
    expect(nodeOf(r2, d.node('t'))).toMatchObject({ status: 'failed', endedAt: iso(at(20)) });
    expect(String(detailOf(r2, d.node('t')).text)).toBe('未完成：本轮结束时工具仍在运行。');
  });

  test('while the parent turn goes on, an unfinished subagent keeps the dispatch running', () => {
    const c = new CursorConv({ id: ROOT });
    const s = new CursorConv({ id: SUB, sessionId: ROOT });
    const r = go([c.composer({ status: 'none' }), c.user('u', 'go', 0), c.task('t', 'tc1', 'completed', 1), s.subagentComposer('tc1', ROOT, { status: 'none' }), s.user('su', 'task', 2)]);
    expect(nodeOf(r, c.node('t')).status).toBe('running');
  });
});

describe('abort rule', () => {
  test('composer aborted: loading calls of the last turn fail ("aborted"), the turn ends, the session is idle; a new prompt starts a turn', () => {
    const c = new CursorConv({ id: ROOT });
    const n = new CursorNormalizer();
    const r = run(n, [c.composer({ status: 'none' }), c.user('u', 'go', 0), c.tool('t1', 'grep', 'loading', 1), c.tool('t2', 'grep', 'loading', 2), c.composer({ status: 'aborted' })]);
    expect(r.sessions.get(ROOT)!.status).toBe('idle');
    expect(nodeOf(r, c.node('t1'))).toMatchObject({ status: 'failed' });
    expect(nodeOf(r, c.node('t2'))).toMatchObject({ status: 'failed' });
    expect(String(detailOf(r, c.node('t1')).text)).toBe('已中止：对话停止时工具仍在运行。');
    // Settled without an end, a call ends at the next bubble's start (I2 ruling): the two are drawn one after the other.
    expect(nodeOf(r, c.node('t1'))).toMatchObject({ endedAt: iso(at(2)) });
    expect(nodeOf(r, c.node('t2')).parentId).toBe(c.node('t1'));
    const more = run(n, [c.user('u2', 'try again', 30)]);
    expect(more.sessions.get(ROOT)!.status).toBe('running');
    expect(nodeOf(go([c.composer({ status: 'aborted' }), c.user('x', 'go', 0)]), c.node('x')).kind).toBe('prompt');
    expect(go([c.composer({ status: 'aborted' }), c.user('x', 'go', 0)]).sessions.get(ROOT)!.status).toBe('running');
  });
});

describe('subagent link by the task_v2 result agentId', () => {
  test('without a matching toolCallId, the result agentId links; both paths give the same graph', () => {
    const build = (byCall: boolean): RunResult => {
      const c = new CursorConv({ id: ROOT });
      const s = new CursorConv({ id: SUB, sessionId: ROOT });
      return go([
        c.user('u', 'go', 0),
        c.task('t', 'tc1', 'completed', 1, { durSec: 5, result: { agentId: SUB, summary: 'x' } }),
        s.composer({ name: null, subagentInfo: { parentComposerId: ROOT, rootParentConversationId: ROOT, toolCallId: byCall ? 'tc1' : null, subagentTypeName: 'explorer', subagentType: 3 } }),
        s.user('su', 'task', 2),
        s.turnEnd('se', 3),
      ]);
    };
    const viaAgent = build(false);
    expect(nodeOf(viaAgent, `bubble:${ROOT}:t`).childAgentId).toBe(SUB);
    expect(graphOf(viaAgent)).toEqual(graphOf(build(true)));
  });

  test('a subagent whose toolCallId names another task_v2 call goes to that call (toolCallId wins)', () => {
    const c = new CursorConv({ id: ROOT });
    const s = new CursorConv({ id: SUB, sessionId: ROOT });
    const r = go([
      c.user('u', 'go', 0),
      c.task('t1', 'tc1', 'completed', 1, { result: { agentId: SUB } }),
      c.task('t2', 'tc2', 'completed', 5),
      s.subagentComposer('tc2'),
      s.user('su', 'task', 6),
    ]);
    expect(nodeOf(r, c.node('t1')).childAgentId).toBeNull();
    expect(nodeOf(r, c.node('t2')).childAgentId).toBe(SUB);
    expect(nodeOf(r, s.node('su')).parentId).toBe(c.node('t2'));
  });
});

describe('tool summaries and statuses from real parameter names', () => {
  test('main argument per tool; MCP tools show their tool part; rejected → denied', () => {
    const c = new CursorConv({ id: ROOT });
    let sec = 0;
    const t = (id: string, name: string, params: unknown, result?: unknown) => c.tool(id, name, 'completed', (sec += 2), { params, ...(result !== undefined ? { result } : {}) });
    const r = go([
      c.user('u', 'go', 0),
      t('r', 'read_file_v2', { targetFile: 'src/a.ts', offset: 2 }),
      t('x', 'run_terminal_command_v2', { commandDescription: 'run tests', command: 'npm test', cwd: '/w' }, { output: 'ok', exitCode: 0, rejected: false }),
      t('g', 'ripgrep_raw_search', { path: 'src', pattern: 'TODO', glob: '*.ts' }),
      t('e', 'edit_file_v2', { relativeWorkspacePath: 'src/b.ts', streamingContent: 'x' }),
      t('f', 'glob_file_search', { targetDirectory: 'src', globPattern: '**/*.ts' }),
      t('w', 'web_search', { searchTerm: 'vitest shuffle' }),
      t('m', 'get_mcp_tools', { server: 'github', toolName: 'create_issue' }),
      t('d', 'todo_write', { todos: [{ id: '1', content: 'write tests', status: 'pending' }, { id: '2', content: 'fix it', status: 'pending' }] }),
      t('p', 'mcp-github-create_issue', { tools: [{ name: 'create_issue', parameters: '{"title":"Broken build","body":"x"}' }] }),
      t('a', 'await', ''),
      t('j', 'run_terminal_command_v2', { command: 'rm -rf build' }, { output: '', exitCode: null, rejected: true }),
    ]);
    const summary = (id: string) => nodeOf(r, c.node(id)).summary;
    expect(summary('r')).toBe('src/a.ts');
    expect(summary('x')).toBe('npm test');
    expect(summary('g')).toBe('TODO');
    expect(summary('e')).toBe('src/b.ts');
    expect(summary('f')).toBe('**/*.ts');
    expect(summary('w')).toBe('vitest shuffle');
    expect(summary('m')).toBe('github.create_issue');
    expect(summary('d')).toBe('write tests; fix it');
    expect(summary('p')).toBe('Broken build');
    expect(nodeOf(r, c.node('p'))).toMatchObject({ title: 'create_issue', toolName: 'mcp-github-create_issue' });
    expect(summary('a')).toBe('');
    expect(nodeOf(r, c.node('j')).status).toBe('denied');
    expect(String(detailOf(r, c.node('j')).text)).toBe('用户拒绝了这次调用。');
    expect(nodeOf(r, c.node('x')).status).toBe('succeeded');
  });
});

describe('minor fixes', () => {
  test('title: the first prompt with text', () => {
    const c = new CursorConv({ id: ROOT });
    const r = go([c.composer({ name: null }), c.bubble({ bubbleId: 'u0', type: 1, createdAt: iso(at(0)) }), c.user('u1', 'the real question', 1)]);
    expect(r.sessions.get(ROOT)!.title).toBe('the real question');
  });

  test('labels: JSON that is not an object; an unknown shape counted once, not per version', () => {
    const c = new CursorConv({ id: ROOT });
    const r = go([
      c.user('u', 'go', 0),
      c.event('bubble', '[]'),
      c.bubble({ bubbleId: 'e', type: 2, capabilityType: 22, createdAt: iso(at(1)) }),
      c.update('e', { startedAtMs: at(1) }),
    ]);
    expect(r.unknown).toEqual(['bubble:not-an-object', 'bubble:type2/cap22/empty']);
  });

  test('a bubble whose newer record has no recognised shape keeps its node', () => {
    const c = new CursorConv({ id: ROOT });
    const r = go([c.user('u', 'go', 0), c.text('a', 'one', 1), c.text('b', 'two', 2), c.update('a', { text: null })]);
    expect(nodeOf(r, c.node('a')).summary).toBe('one');
    expect(nodeOf(r, c.node('b')).parentId).toBe(c.node('a'));
  });
});

// ---- I4: checkpointed derivation equals a full re-derive ----

describe('I4: checkpointed derivation', () => {
  test('a long single turn with changes at many positions: the same changes as deriving the whole thread every time', () => {
    const c = new CursorConv({ id: ROOT });
    const events: RawEvent[] = [c.composer({ status: 'none' }), c.user('u', 'one long turn', 0)];
    const loading: string[] = [];
    const texts: string[] = [];
    for (let i = 1; i <= 400; i++) {
      const sec = i * 3;
      if (i % 7 === 0) {
        events.push(c.tool(`p${i}a`, 'grep', 'loading', sec), c.tool(`p${i}b`, 'grep', 'loading', sec + 1));
        loading.push(`p${i}a`, `p${i}b`);
      } else if (i % 5 === 0) events.push(c.tool(`t${i}`, 'read_file_v2', i % 2 === 0 ? 'error' : 'completed', sec, { over: i % 3 === 0 ? { completedAtMs: null } : {} }));
      else if (i % 11 === 0) events.push(c.thinking(`h${i}`, null, sec));
      else {
        events.push(c.text(`x${i}`, `step ${i}`, sec));
        texts.push(`x${i}`);
      }
      // Earlier bubbles change later: loading calls complete (some long after), texts grow, two bubbles swap.
      if (i % 13 === 0 && loading.length > 0) {
        const id = loading.splice(Math.floor(loading.length / 2), 1)[0]!;
        events.push(c.update(id, { completedAtMs: at(i * 3 - 30), toolFormerData: { status: 'completed' } }));
      }
      if (i % 17 === 0) events.push(c.update(texts[Math.floor(texts.length / 3)]!, { text: `revised at ${i}` }));
      if (i % 50 === 0) {
        const [x, y] = [texts[texts.length - 3]!, texts[texts.length - 2]!];
        const orderOf = (id: string): number => Number(lineOf(events.filter((e) => lineOf(e).bubbleId === id).at(-1)!).order);
        const [ox, oy] = [orderOf(x), orderOf(y)];
        events.push(c.update(x, { order: oy }), c.update(y, { order: ox }));
      }
    }
    events.push(c.turnEnd('end', 2000), c.composer({ status: 'completed' }));
    const full = go(events, { checkpointEvery: Number.POSITIVE_INFINITY });
    expect(go(events).changes).toEqual(full.changes);
    expect(go(events, { checkpointEvery: 3 }).changes).toEqual(full.changes);
    expect(graphOf(full)).toEqual(graphOf(go(finalOnly([events]))));
  });
});

// ---- fuzz: full graphs across arrival orders and a rebuild ----

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

interface Scenario {
  /** Each conversation's records in the order the source sends them. */
  convs: RawEvent[][];
  /** The versions of each bubble / composer, in order. */
  queues: RawEvent[][];
}

function scenario(seed: number): Scenario {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const convs: RawEvent[][] = [];
  const queues = new Map<string, RawEvent[]>();
  let subCount = 0;

  const build = (conv: CursorConv, depth: number, link: { callId: string; byCall: boolean; parent: string } | null, startSec: number): void => {
    const events: RawEvent[] = [];
    convs.push(events);
    const add = (key: string, e: RawEvent): void => {
      events.push(e);
      const q = queues.get(`${conv.id}:${key}`) ?? [];
      q.push(e);
      queues.set(`${conv.id}:${key}`, q);
    };
    const composer = (status: string): RawEvent =>
      link === null
        ? conv.composer({ status, name: r() < 0.5 ? null : 'Named' })
        : conv.composer({
            name: null,
            status,
            subagentInfo: { parentComposerId: link.parent, rootParentConversationId: ROOT, toolCallId: link.byCall ? link.callId : null, subagentTypeName: 'explorer', subagentType: 3 },
          });
    const composerFirst = r() < 0.5;
    if (composerFirst) add('composer', composer('none'));
    let sec = startSec;
    const later: (() => void)[] = [];
    const ids: string[] = [];
    let n = 0;
    const turns = 1 + Math.floor(r() * 3);
    for (let t = 0; t < turns; t++) {
      const u = `u${t}`;
      add(u, conv.user(u, `prompt ${t} of ${conv.id}`, (sec += 2)));
      const steps = 2 + Math.floor(r() * 6);
      for (let k = 0; k < steps; k++) {
        const id = `b${n++}`;
        const x = r();
        if (x < 0.12) add(id, conv.thinking(id, r() < 0.3 ? null : 'hmm', (sec += 2)));
        else if (x < 0.3) {
          add(id, conv.text(id, 'partial', (sec += 2)));
          if (r() < 0.4) later.push(() => add(id, conv.update(id, { text: 'partial, then complete' })));
        } else if (x < 0.55) {
          const status = pick(['completed', 'error', 'cancelled', 'loading'] as const);
          add(id, conv.tool(id, pick(['read_file_v2', 'ripgrep_raw_search', 'edit_file_v2']), status, (sec += 2), { over: status !== 'loading' && r() < 0.3 ? { completedAtMs: null } : {} }));
          if (status === 'loading' && r() < 0.7) {
            const end = sec + Math.floor(r() * 6) - 1;
            later.push(() => add(id, conv.update(id, { completedAtMs: at(end), toolFormerData: { status: pick(['completed', 'error'] as const) } })));
          }
        } else if (x < 0.7) {
          const id2 = `b${n++}`;
          add(id, conv.tool(id, 'grep', 'loading', (sec += 2)));
          add(id2, conv.tool(id2, 'grep', 'loading', sec + 1));
          sec += 1;
          const end = sec + 3;
          later.push(() => add(id, conv.update(id, { completedAtMs: at(end), toolFormerData: { status: 'completed' } })));
          if (r() < 0.6) later.push(() => add(id2, conv.update(id2, { completedAtMs: at(end + 1), toolFormerData: { status: 'completed' } })));
        } else if (x < 0.82 && depth < 2) {
          const callId = `call-${conv.id}-${id}`;
          const child = new CursorConv({ id: `c-s${++subCount}`, sessionId: ROOT });
          const byCall = r() < 0.6;
          const status = pick(['completed', 'loading'] as const);
          add(id, conv.task(id, callId, status, (sec += 2), { result: byCall ? { summary: 'done' } : { summary: 'done', agentId: child.id } }));
          if (status === 'loading') later.push(() => add(id, conv.update(id, { completedAtMs: at(sec + 4), toolFormerData: { status: 'completed', result: JSON.stringify({ agentId: child.id }) } })));
          build(child, depth + 1, { callId, byCall, parent: conv.id }, sec);
        } else add(id, conv.bubble({ bubbleId: id, type: 2, capabilityType: 22, createdAt: iso(at((sec += 2))), startedAtMs: at(sec) }));
        ids.push(id);
        // Records of earlier bubbles arriving after later ones (as a poll round sends them).
        if (later.length > 0 && r() < 0.4) later.splice(Math.floor(r() * later.length), 1)[0]!();
      }
      if (r() < 0.5) add(`e${t}`, conv.turnEnd(`e${t}`, (sec += 2)));
    }
    for (const f of later.splice(0)) f();
    // An order swap of two adjacent bubbles (the list is not append-only).
    if (ids.length >= 2 && r() < 0.4) {
      const i = 1 + Math.floor(r() * (ids.length - 1));
      const [a, b] = [ids[i - 1]!, ids[i]!];
      const orderOf = (bid: string): number => Number(lineOf(queues.get(`${conv.id}:${bid}`)!.at(-1)!).order);
      const [oa, ob] = [orderOf(a), orderOf(b)];
      add(b, conv.update(b, { order: oa }));
      add(a, conv.update(a, { order: ob }));
    }
    add('composer', composer(pick(['completed', 'none', 'aborted'])));
  };

  build(new CursorConv({ id: ROOT }), 0, null, 0);
  return { convs, queues: [...queues.values()] };
}

describe('fuzz: whole graphs (nodes, edges, session) agree', () => {
  test('source order (conversations interleaved), final records only, any order of versions, a rebuild, and a full re-derive', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { convs, queues } = scenario(seed);
      const live = interleave(convs, seed);
      const ref = graphOf(go(finalOnly(convs)));
      const n = new CursorNormalizer();
      const first = run(n, live);
      expect(graphOf(first), `seed ${seed}: live`).toEqual(ref);
      n.dropSession(ROOT);
      expect(graphOf(run(n, live)), `seed ${seed}: rebuild`).toEqual(ref);
      expect(graphOf(go(interleave(queues, seed + 1000))), `seed ${seed}: shuffled`).toEqual(ref);
      expect(go(live, { checkpointEvery: Number.POSITIVE_INFINITY }).changes, `seed ${seed}: full re-derive`).toEqual(first.changes);
    }
  }, 60_000);
});

// ---- fix wave: batch apply and the checkpoint spacing ----

/** Node details as the store folds them: node_added's detail, then each node_updated's detail merged over it. */
function detailsOf(changes: Change[]): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const c of changes) {
    if (c.type === 'node_added') out[c.node.id] = { ...c.detail };
    if (c.type === 'node_updated' && c.detail !== undefined && out[c.id] !== undefined) out[c.id] = { ...out[c.id], ...c.detail };
  }
  return out;
}

/** The events applied in batches of `size` (Infinity: one batch), folded like `run`. */
function goBatched(events: RawEvent[], size: number, options?: { checkpointEvery?: number }): RunResult & { details: Record<string, Record<string, unknown>> } {
  const n = new CursorNormalizer(options);
  const changes: Change[] = [];
  const unknown: string[] = [];
  const step = Number.isFinite(size) ? size : Math.max(1, events.length);
  for (let i = 0; i < events.length; i += step) {
    const items = events.slice(i, i + step).map((event) => ({ event, projectId: (event as { projectId?: string | null }).projectId ?? 'unknown' }));
    const r = n.applyBatch(items);
    changes.push(...r.changes);
    for (const u of r.unknown) if (u !== undefined) unknown.push(u);
  }
  const sessions = new Map<string, Session>();
  for (const c of changes) if (c.type === 'session_upserted') sessions.set(c.session.id, c.session);
  return { changes, graph: applyChanges(emptyGraph(), changes), unknown, sessions, details: detailsOf(changes) };
}

describe('fix wave: a batch gives what its records applied one by one give', () => {
  test('graph, session, node details and unknown labels agree for batch sizes 1, 7, 64 and all-in-one; in source order and shuffled', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const { convs, queues } = scenario(seed);
      for (const events of [interleave(convs, seed), interleave(queues, seed + 1000)]) {
        const one = go(events);
        const ref = { ...graphOf(one), details: detailsOf(one.changes), unknown: one.unknown };
        for (const size of [1, 7, 64, Number.POSITIVE_INFINITY]) {
          const b = goBatched(events, size);
          expect({ ...graphOf(b), details: b.details, unknown: b.unknown }, `seed ${seed} size ${size}`).toEqual(ref);
        }
      }
    }
  }, 120_000);

  test('a single-record batch is apply', () => {
    const { convs } = scenario(7);
    const live = interleave(convs, 7);
    expect(goBatched(live, 1).changes).toEqual(go(live).changes);
  });

  test('checkpoints every 2 bubbles: the same changes as the reference derivation (M-T1)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { convs } = scenario(seed);
      const live = interleave(convs, seed);
      expect(go(live, { checkpointEvery: 2 }).changes, `seed ${seed}`).toEqual(go(live, { checkpointEvery: Number.POSITIVE_INFINITY }).changes);
    }
  }, 60_000);
});

describe('fix wave I2: a finished terminal call with a non-zero exit code is failed', () => {
  const term = (c: CursorConv, id: string, result: unknown, over: Record<string, unknown> = {}): RawEvent =>
    c.tool(id, 'run_terminal_command_v2', 'completed', 2, { params: { command: 'npm test' }, result, over });

  test('exit code 1 → failed, the note names it; 0 or none → succeeded; a rejection stays denied', () => {
    const c = new CursorConv({ id: ROOT });
    const r = go([
      c.composer(),
      c.user('u', 'go', 1),
      term(c, 'bad', { exitCode: 1, output: 'boom' }),
      term(c, 'ok', { exitCode: 0, output: 'fine' }),
      term(c, 'plain', { output: 'no code' }),
      term(c, 'no', { rejected: true, exitCode: 1 }),
      c.turnEnd('e', 9),
    ]);
    expect(nodeOf(r, c.node('bad')).status).toBe('failed');
    expect(detailOf(r, c.node('bad')).text).toBe('命令以退出码 1 结束。');
    expect(nodeOf(r, c.node('ok')).status).toBe('succeeded');
    expect(detailOf(r, c.node('ok')).text).toBeNull();
    expect(nodeOf(r, c.node('plain')).status).toBe('succeeded');
    expect(nodeOf(r, c.node('no')).status).toBe('denied');
  });

  test('only the terminal tool, only a result that was not cut, only once finished; it follows the latest record', () => {
    const c = new CursorConv({ id: ROOT });
    const events = [
      c.composer({ status: 'none' }),
      c.user('u', 'go', 1),
      c.tool('other', 'read_file_v2', 'completed', 2, { result: { exitCode: 3 } }),
      term(c, 'cut', '{"exitCode":2,"output":"xx', { truncated: ['result'] }),
      c.tool('run', 'run_terminal_command_v2', 'loading', 3),
    ];
    let r = go(events);
    expect(nodeOf(r, c.node('other')).status).toBe('succeeded');
    expect(nodeOf(r, c.node('cut')).status).toBe('succeeded');
    expect(nodeOf(r, c.node('run')).status).toBe('running');
    events.push(c.update('run', { completedAtMs: Date.parse('2026-11-12T08:00:05.000Z'), toolFormerData: { status: 'completed', result: '{"exitCode":127}' } }));
    r = go(events);
    expect(nodeOf(r, c.node('run')).status).toBe('failed');
    events.push(c.update('run', { toolFormerData: { result: '{"exitCode":0}' } }));
    r = go(events);
    expect(nodeOf(r, c.node('run')).status).toBe('succeeded');
    expect(detailOf(r, c.node('run')).text).toBeNull();
  });
});

describe('fix wave M5: node notes are Simplified Chinese', () => {
  test('cancelled, rejected, never finished and aborted calls', () => {
    const c = new CursorConv({ id: ROOT });
    const r = go([
      c.composer({ status: 'completed' }),
      c.user('u', 'go', 1),
      c.tool('x', 'grep', 'cancelled', 2),
      c.tool('j', 'run_terminal_command_v2', 'completed', 3, { result: { rejected: true } }),
      c.tool('l', 'grep', 'loading', 4),
      c.turnEnd('e', 9),
      c.user('u2', 'again', 10),
      c.tool('l2', 'grep', 'loading', 11),
      c.composer({ status: 'aborted' }),
    ]);
    expect(detailOf(r, c.node('x')).text).toBe('已在 Cursor 中取消。');
    expect(detailOf(r, c.node('j')).text).toBe('用户拒绝了这次调用。');
    expect(detailOf(r, c.node('l')).text).toBe('未完成：本轮结束时工具仍在运行。');
    expect(detailOf(r, c.node('l2')).text).toBe('已中止：对话停止时工具仍在运行。');
  });
});
