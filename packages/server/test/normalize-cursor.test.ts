import { describe, expect, test } from 'vitest';
import type { GraphEdge, GraphNode, Session } from '@claude-canvas/shared';
import { CursorNormalizer } from '../src/normalize/cursor.js';
import { NORMALIZER_FACTORIES, NormalizerRegistry } from '../src/normalize/registry.js';
import type { RawEvent } from '../src/store/store.js';
import { interleave, run, type RunResult } from './codex-fixtures.js';
import { at, CursorConv, iso, T0 } from './cursor-records.js';

// Synthetic records only (shaped like the record contract of src/sources/cursor/records.ts, invented content).

const ROOT = 'c-root';
const SUB = 'c-sub';

const go = (events: RawEvent[]): RunResult => run(new CursorNormalizer(), events);
const nodes = (r: RunResult): GraphNode[] => Object.values(r.graph.nodes);
const nodeOf = (r: RunResult, id: string): GraphNode => {
  const n = r.graph.nodes[id];
  if (n === undefined) throw new Error(`no node ${id}; have ${Object.keys(r.graph.nodes).join(', ')}`);
  return n;
};
const edgeIds = (r: RunResult): string[] => Object.keys(r.graph.edges).sort();
const edgesByKind = (r: RunResult, kind: GraphEdge['kind']): string[] => Object.values(r.graph.edges).filter((e) => e.kind === kind).map((e) => e.id).sort();
const detailOf = (r: RunResult, id: string): Record<string, unknown> => {
  let d: Record<string, unknown> = {};
  for (const c of r.changes) {
    if (c.type === 'node_added' && c.node.id === id) d = { ...c.detail };
    if (c.type === 'node_updated' && c.id === id && c.detail !== undefined) d = { ...d, ...c.detail };
  }
  return d;
};
const session = (r: RunResult, id = ROOT) => r.sessions.get(id)!;
/** The whole graph (nodes, edges) and the session, for comparisons across arrival orders. */
const shape = (r: RunResult) => ({ nodes: r.graph.nodes, edges: r.graph.edges, session: r.sessions.get(ROOT) });

describe('sessions (composer records)', () => {
  test('a main conversation becomes a cursor session: title, cwd, project, created and last-activity times', () => {
    const c = new CursorConv({ id: ROOT, projectId: 'D--work-app' });
    const r = go([c.composer({ name: 'Fix the parser', createdAt: at(-5), cwd: 'D:\\work\\app' }), c.user('u1', 'please fix it', 0), c.text('a1', 'on it', 3)]);
    expect(session(r)).toMatchObject({
      id: ROOT,
      origin: 'cursor',
      projectId: 'D--work-app',
      cwd: 'D:\\work\\app',
      title: 'Fix the parser',
      gitBranch: null,
      sourceDeleted: false,
      startedAt: iso(at(-5)),
      lastActivityAt: iso(at(3) + 500),
    });
    expect(r.unknown).toEqual([]);
  });

  test('title: composer name, else the first user bubble (trimmed, whitespace collapsed, 60 characters)', () => {
    const c = new CursorConv({ id: ROOT });
    const long = `  first   line\n\nsecond ${'x'.repeat(80)}  `;
    const r1 = go([c.composer({ name: null }), c.user('u1', long, 0), c.user('u2', 'later prompt', 10)]);
    expect(session(r1).title).toBe(`first line second ${'x'.repeat(80)}`.slice(0, 60));
    // The composer arriving later with a name takes over.
    const c2 = new CursorConv({ id: ROOT });
    const r2 = go([c2.user('u1', 'some prompt', 0), c2.composer({ name: 'Named later' })]);
    expect(session(r2).title).toBe('Named later');
    // Before any composer record: the prompt.
    const c3 = new CursorConv({ id: ROOT });
    expect(session(go([c3.user('u1', 'some prompt', 0)])).title).toBe('some prompt');
  });

  test('created time falls back to the earliest bubble; last activity is the latest bubble time of any thread', () => {
    const c = new CursorConv({ id: ROOT });
    const s = new CursorConv({ id: SUB, sessionId: ROOT });
    const r = go([c.composer({ createdAt: null }), c.user('u1', 'go', 2), c.task('t1', 'tc1', 'loading', 4), s.subagentComposer('tc1'), s.user('su', 'task', 5), s.text('sa', 'late sub text', 40)]);
    expect(session(r).startedAt).toBe(iso(at(2)));
    expect(session(r).lastActivityAt).toBe(iso(at(40) + 500));
  });

  test('a subagent record arriving first creates the root session (one session, no other)', () => {
    const s = new CursorConv({ id: SUB, sessionId: ROOT });
    const r = go([s.subagentComposer('tc1'), s.user('su', 'task', 5)]);
    expect([...r.sessions.keys()]).toEqual([ROOT]);
    expect(nodes(r)).toEqual([]); // held until its dispatch arrives
  });

  test('hooks are ignored for now; meta events too', () => {
    const n = new CursorNormalizer();
    const hook: RawEvent = { source: 'hook', origin: 'cursor', receivedAt: iso(T0), eventName: 'stop', sessionId: ROOT, payload: '{}' };
    expect(n.apply(hook, 'p1')).toEqual({ changes: [] });
    expect(n.hasSession(ROOT)).toBe(false);
  });
});

describe('nodes from bubbles', () => {
  test('type 1 → prompt starting a turn; type 2 text → text; thinking → thinking (summary, duration); chained in order', () => {
    const c = new CursorConv({ id: ROOT });
    const r = go([
      c.composer(),
      c.user('u1', 'hello there', 0),
      c.thinking('th1', 'considering   options', 1),
      c.text('a1', 'here is the answer', 3),
      c.user('u2', 'thanks', 10),
      c.thinking('th2', null, 11, { thinkingDurationMs: 700 }),
      c.text('a2', 'welcome', 12),
    ]);
    const u1 = nodeOf(r, c.node('u1'));
    expect(u1).toMatchObject({ kind: 'prompt', title: 'Prompt', summary: 'hello there', turnId: c.node('u1'), parentId: null, agentId: null, status: null, timestamp: iso(at(0)) });
    expect(nodeOf(r, c.node('th1'))).toMatchObject({ kind: 'thinking', title: 'Thinking', summary: 'considering options', durationMs: 1200, parentId: c.node('u1'), turnId: c.node('u1') });
    expect(nodeOf(r, c.node('a1'))).toMatchObject({ kind: 'text', title: 'Text', summary: 'here is the answer', parentId: c.node('th1'), turnId: c.node('u1') });
    expect(nodeOf(r, c.node('u2'))).toMatchObject({ kind: 'prompt', parentId: c.node('a1'), turnId: c.node('u2') });
    // thinking.text null: still a node, empty summary.
    expect(nodeOf(r, c.node('th2'))).toMatchObject({ kind: 'thinking', summary: '', durationMs: 700, turnId: c.node('u2') });
    expect(nodeOf(r, c.node('a2')).turnId).toBe(c.node('u2'));
    expect(edgeIds(r)).toEqual(
      [
        `${c.node('u1')}->${c.node('th1')}`,
        `${c.node('th1')}->${c.node('a1')}`,
        `${c.node('a1')}->${c.node('u2')}`,
        `${c.node('u2')}->${c.node('th2')}`,
        `${c.node('th2')}->${c.node('a2')}`,
      ].sort(),
    );
    expect(edgesByKind(r, 'sequence')).toHaveLength(5);
    expect(detailOf(r, c.node('u1'))).toMatchObject({ text: 'hello there' });
    expect(detailOf(r, c.node('a1'))).toMatchObject({ text: 'here is the answer' });
  });

  test('tool node: name, main argument as summary, input/output in the detail, status and times', () => {
    const c = new CursorConv({ id: ROOT });
    const r = go([
      c.composer(),
      c.user('u1', 'run it', 0),
      c.tool('t1', 'run_terminal_cmd', 'completed', 1, { params: { command: 'npm   test', explanation: 'run the tests' }, result: { output: 'all green' }, durSec: 4 }),
      c.tool('t2', 'read_file', 'completed', 6, { params: { targetFile: 'src/a.ts', offset: 3 } }),
      c.tool('t3', 'grep', 'completed', 8, { params: { pattern: 'TODO' } }),
      c.tool('t4', 'mystery_tool', 'completed', 10, { params: { alpha: 7, beta: 'second string value' } }),
    ]);
    const t1 = nodeOf(r, c.node('t1'));
    expect(t1).toMatchObject({
      kind: 'tool',
      title: 'run_terminal_cmd',
      toolName: 'run_terminal_cmd',
      toolUseId: 'call-t1',
      summary: 'npm test',
      status: 'succeeded',
      timestamp: iso(at(1)),
      endedAt: iso(at(5)),
      durationMs: 4000,
      childAgentId: null,
    });
    expect(detailOf(r, c.node('t1'))).toMatchObject({ input: { command: 'npm   test', explanation: 'run the tests' }, output: { output: 'all green' } });
    expect(nodeOf(r, c.node('t2')).summary).toBe('src/a.ts');
    expect(nodeOf(r, c.node('t3')).summary).toBe('TODO');
    expect(nodeOf(r, c.node('t4')).summary).toBe('second string value');
  });

  test('params that do not parse (cut at 64 KB): the raw text prefix is the summary and the input', () => {
    const c = new CursorConv({ id: ROOT });
    const cut = `{"command":"echo ${'y'.repeat(300)}`;
    const r = go([c.user('u1', 'go', 0), c.tool('t1', 'run_terminal_cmd', 'completed', 1, { params: cut, over: { truncated: ['params'] } })]);
    const t1 = nodeOf(r, c.node('t1'));
    expect(t1.summary.startsWith('{"command":"echo yyy')).toBe(true);
    expect(t1.summary.length).toBeLessThanOrEqual(200);
    expect(detailOf(r, c.node('t1')).input).toBe(cut);
    expect(r.unknown).toEqual([]);
  });

  test('status mapping: completed → succeeded, error → failed, cancelled → failed noting it, loading → running', () => {
    const c = new CursorConv({ id: ROOT });
    const r = go([
      c.composer({ status: 'none' }),
      c.user('u1', 'go', 0),
      c.tool('ok', 'read_file', 'completed', 1),
      c.tool('bad', 'read_file', 'error', 3),
      c.tool('stop', 'read_file', 'cancelled', 5),
      c.tool('run', 'read_file', 'loading', 7),
    ]);
    expect(nodeOf(r, c.node('ok')).status).toBe('succeeded');
    expect(nodeOf(r, c.node('bad')).status).toBe('failed');
    expect(nodeOf(r, c.node('stop')).status).toBe('failed');
    expect(String(detailOf(r, c.node('stop')).text)).toBe('已在 Cursor 中取消。');
    expect(detailOf(r, c.node('bad')).text).toBeNull();
    expect(nodeOf(r, c.node('run'))).toMatchObject({ status: 'running', endedAt: null, durationMs: null });
  });

  test('a loading tool in a turn that has ended is settled as failed ("never finished"): a later prompt, or a turnDurationMs bubble after it', () => {
    const c = new CursorConv({ id: ROOT });
    const r1 = go([c.composer(), c.user('u1', 'go', 0), c.tool('t1', 'read_file', 'loading', 1), c.user('u2', 'again', 20)]);
    expect(nodeOf(r1, c.node('t1'))).toMatchObject({ status: 'failed', endedAt: iso(at(20)), durationMs: 19_000 });
    expect(String(detailOf(r1, c.node('t1')).text)).toBe('未完成：本轮结束时工具仍在运行。');

    const d = new CursorConv({ id: ROOT });
    const r2 = go([d.composer(), d.user('u1', 'go', 0), d.tool('t1', 'read_file', 'loading', 1), d.turnEnd('end', 9)]);
    // Without completedAtMs it ends where the next bubble starts (fix round 1, I2).
    expect(nodeOf(r2, d.node('t1'))).toMatchObject({ status: 'failed', endedAt: iso(at(9)) });
    // A loading tool of the open last turn stays running.
    const e = new CursorConv({ id: ROOT });
    expect(nodeOf(go([e.user('u1', 'go', 0), e.tool('t1', 'read_file', 'loading', 1)]), e.node('t1')).status).toBe('running');
  });

  test('a completed tool without completedAtMs ends where the next bubble starts', () => {
    const c = new CursorConv({ id: ROOT });
    const r = go([c.user('u1', 'go', 0), c.tool('t1', 'read_file', 'completed', 1, { over: { completedAtMs: null } }), c.text('a1', 'read it', 7)]);
    expect(nodeOf(r, c.node('t1'))).toMatchObject({ status: 'succeeded', endedAt: iso(at(7)), durationMs: 6000 });
  });

  test('node start: startedAtMs, else createdAt, else the previous node of the thread', () => {
    const c = new CursorConv({ id: ROOT });
    const r = go([
      c.user('u1', 'go', 0),
      c.text('a1', 'no start ms', 2, { startedAtMs: null }),
      c.text('a2', 'no time at all', 9, { startedAtMs: null, createdAt: null, completedAtMs: null }),
    ]);
    expect(nodeOf(r, c.node('a1')).timestamp).toBe(iso(at(2)));
    expect(nodeOf(r, c.node('a2')).timestamp).toBe(iso(at(2)));
  });

  test('tokens: each bubble tokenCount becomes the node usage (no messageId: each counted once)', () => {
    const c = new CursorConv({ id: ROOT });
    const r = go([c.user('u1', 'go', 0), c.text('a1', 'x', 1, { tokenCount: { inputTokens: 1234, outputTokens: 56 } }), c.tool('t1', 'read_file', 'completed', 3)]);
    expect(nodeOf(r, c.node('a1'))).toMatchObject({ usage: { inputTokens: 1234, outputTokens: 56 }, messageId: null });
    expect(nodeOf(r, c.node('t1')).usage).toEqual({ inputTokens: 50, outputTokens: 5 });
    expect(nodeOf(r, c.node('u1')).usage).toBeNull(); // 0 / 0
  });

  test('unknown shapes: no node, counted by a shape label; JSON that does not parse is counted too', () => {
    const c = new CursorConv({ id: ROOT });
    const r = go([
      c.user('u1', 'go', 0),
      c.bubble({ bubbleId: 'e1', type: 2, capabilityType: 22, createdAt: iso(at(1)) }),
      c.bubble({ bubbleId: 'e2', type: 7, createdAt: iso(at(2)) }),
      c.text('a1', 'after', 3),
      c.event('bubble', '{"bubbleId":'),
      c.event('mystery', '{}'),
    ]);
    expect(r.unknown).toEqual(['bubble:type2/cap22/empty', 'bubble:type7/capnull', 'bubble:invalid-json', 'cursor:mystery']);
    expect(nodes(r).map((n) => n.id).sort()).toEqual([c.node('a1'), c.node('u1')].sort());
    expect(nodeOf(r, c.node('a1')).parentId).toBe(c.node('u1'));
  });
});

describe('upsert, order', () => {
  test('a later version of a bubble updates its node in place (loading → completed, growing text): never duplicated', () => {
    const c = new CursorConv({ id: ROOT });
    const events = [
      c.composer({ status: 'none' }),
      c.user('u1', 'go', 0),
      c.text('a1', 'partial', 1),
      c.tool('t1', 'read_file', 'loading', 2),
    ];
    const live = new CursorNormalizer();
    const r1 = run(live, events);
    expect(nodeOf(r1, c.node('t1')).status).toBe('running');
    const more = [
      c.update('a1', { text: 'partial and then the rest' }),
      c.update('t1', { completedAtMs: at(5), toolFormerData: { status: 'completed', result: '{"contents":"abc"}' } }),
      c.turnEnd('end', 6),
      c.composer({ status: 'completed' }),
    ];
    const r2 = run(live, more);
    const all = [...r1.changes, ...r2.changes];
    expect(all.filter((x) => x.type === 'node_added' && x.node.id === c.node('t1'))).toHaveLength(1);
    expect(all.filter((x) => x.type === 'node_added' && x.node.id === c.node('a1'))).toHaveLength(1);
    const full = go([...events, ...more]);
    expect(nodeOf(full, c.node('t1'))).toMatchObject({ status: 'succeeded', endedAt: iso(at(5)), durationMs: 3000 });
    expect(nodeOf(full, c.node('a1')).summary).toBe('partial and then the rest');
    expect(detailOf(full, c.node('t1')).output).toEqual({ contents: 'abc' });
    expect(detailOf(full, c.node('a1')).text).toBe('partial and then the rest');
    // Same result when the versions are applied in one run.
    expect(Object.keys(full.graph.nodes).sort()).toEqual(Object.keys(go(events).graph.nodes).concat(c.node('end')).sort());
  });

  test('order: by `order`, ties by createdAt then bubbleId; a bubble that moved is re-parented', () => {
    const c = new CursorConv({ id: ROOT });
    const r = go([
      c.user('u1', 'go', 0, { order: 0 }),
      c.text('b', 'tie later', 5, { order: 1 }),
      c.text('a', 'tie earlier', 3, { order: 1 }),
      c.text('z2', 'same time z', 7, { order: 2 }),
      c.text('z1', 'same time y', 7, { order: 2 }),
    ]);
    expect(nodeOf(r, c.node('a')).parentId).toBe(c.node('u1'));
    expect(nodeOf(r, c.node('b')).parentId).toBe(c.node('a'));
    expect(nodeOf(r, c.node('z1')).parentId).toBe(c.node('b'));
    expect(nodeOf(r, c.node('z2')).parentId).toBe(c.node('z1'));
    // A bubble re-stored with a new order moves: its node is re-parented (no new node).
    const c2 = new CursorConv({ id: ROOT });
    const ev = [c2.user('u1', 'go', 0), c2.text('a1', 'one', 1), c2.text('a2', 'two', 2)];
    const moved = [...ev, c2.update('a2', { order: 1 }), c2.update('a1', { order: 2 })];
    const rm = go(moved);
    expect(nodeOf(rm, c2.node('a2')).parentId).toBe(c2.node('u1'));
    expect(nodeOf(rm, c2.node('a1')).parentId).toBe(c2.node('a2'));
    expect(Object.keys(rm.graph.nodes)).toHaveLength(3);
  });

  test('a bubble that vanished from Cursor gets no further records: its node stays', () => {
    const c = new CursorConv({ id: ROOT });
    const r = go([c.user('u1', 'go', 0, { order: 0 }), c.text('gone', 'removed later', 1, { order: 1 }), c.text('a2', 'moved up', 2, { order: 1 })]);
    expect(Object.keys(r.graph.nodes)).toContain(c.node('gone'));
    expect(nodeOf(r, c.node('a2')).parentId).toBe(c.node('gone')); // tie on order 1: createdAt decides
  });
});

describe('parallel tool calls', () => {
  test('adjacent tools whose start precedes the previous end fork from one parent and join at the next bubble', () => {
    const c = new CursorConv({ id: ROOT });
    const r = go([
      c.composer(),
      c.user('u1', 'go', 0),
      c.text('a0', 'reading three files', 1),
      c.tool('p1', 'read_file', 'completed', 2, { durSec: 5 }),
      c.tool('p2', 'read_file', 'completed', 3, { durSec: 5 }),
      c.tool('p3', 'read_file', 'loading', 4),
      c.text('a1', 'read them', 20),
    ]);
    // A loading tool in an open turn has no end: anything after it in the same run overlaps.
    const [a0, p1, p2, p3, a1] = ['a0', 'p1', 'p2', 'p3', 'a1'].map((b) => c.node(b));
    for (const p of [p1, p2, p3]) expect(nodeOf(r, p!).parentId).toBe(a0);
    expect(nodeOf(r, a1!).parentId).toBe(p3);
    expect(edgesByKind(r, 'fork')).toEqual([`${a0}->${p1}:fork`, `${a0}->${p2}`, `${a0}->${p3}`].sort());
    expect(edgesByKind(r, 'sequence')).toEqual(
      [`${c.node('u1')}->${a0}`, `${a0}->${p1}`, `${p1}->${a1}`, `${p2}->${a1}`, `${p3}->${a1}`].sort(),
    );
  });

  test('a tool that starts after the previous one ended is sequential', () => {
    const c = new CursorConv({ id: ROOT });
    const r = go([c.user('u1', 'go', 0), c.tool('s1', 'read_file', 'completed', 1, { durSec: 1 }), c.tool('s2', 'read_file', 'completed', 5), c.text('a1', 'done', 9)]);
    expect(nodeOf(r, c.node('s2')).parentId).toBe(c.node('s1'));
    expect(nodeOf(r, c.node('a1')).parentId).toBe(c.node('s2'));
    expect(edgesByKind(r, 'fork')).toEqual([]);
  });
});

describe('session status', () => {
  test('running while the last turn is open; idle once it ended and the composer says completed / aborted', () => {
    const c = new CursorConv({ id: ROOT });
    const live = new CursorNormalizer();
    let latest = new Map<string, Session>();
    // The session as it stands after these events (a step that changes nothing emits no session).
    const step = (events: RawEvent[]): RunResult => {
      const r = run(live, events);
      latest = new Map([...latest, ...r.sessions]);
      return { ...r, sessions: latest };
    };
    expect(session(step([c.composer({ status: 'completed' }), c.user('u1', 'go', 0)])).status).toBe('running'); // last bubble is the prompt
    expect(session(step([c.text('a1', 'working', 1)])).status).toBe('idle'); // composer completed, no running tool
    step([c.user('u2', 'more', 10)]);
    expect(session(step([c.composer({ status: 'none' }), c.tool('t1', 'read_file', 'loading', 11)])).status).toBe('running');
    // a running tool keeps it running whatever the composer says
    expect(session(step([c.composer({ status: 'completed' })])).status).toBe('running');
    expect(session(step([c.update('t1', { completedAtMs: at(12), toolFormerData: { status: 'completed' } }), c.composer({ status: 'none' })])).status).toBe('running');
    expect(session(step([c.turnEnd('end', 13)])).status).toBe('idle'); // turnDurationMs ends the turn
    expect(session(step([c.user('u3', 'and again', 30)])).status).toBe('running');
    expect(session(step([c.text('a3', 'stopped', 31), c.composer({ status: 'aborted' })])).status).toBe('idle');
    // no bubbles yet: idle
    const d = new CursorConv({ id: 'c-empty' });
    expect(go([d.composer()]).sessions.get('c-empty')!.status).toBe('idle');
  });

  test('a subagent turn does not decide the session status', () => {
    const c = new CursorConv({ id: ROOT });
    const s = new CursorConv({ id: SUB, sessionId: ROOT });
    const r = go([c.composer(), c.user('u1', 'go', 0), c.task('t1', 'tc1', 'completed', 1, { durSec: 3 }), c.turnEnd('end', 9), s.subagentComposer('tc1', ROOT, { status: 'none' }), s.user('su', 'task', 1)]);
    expect(session(r).status).toBe('idle');
  });
});

describe('subagents (task_v2)', () => {
  function family() {
    const c = new CursorConv({ id: ROOT });
    const s = new CursorConv({ id: SUB, sessionId: ROOT });
    const root = [
      c.composer({ name: 'With a helper' }),
      c.user('u1', 'investigate', 0),
      c.task('t1', 'tc1', 'loading', 1),
      c.update('t1', { completedAtMs: at(30), toolFormerData: { status: 'completed', result: '{"summary":"found it"}' } }),
      c.text('a1', 'the helper found it', 31),
      c.turnEnd('end', 32),
    ];
    const sub = [
      s.subagentComposer('tc1', ROOT, { status: 'completed' }),
      s.user('su', 'look into t1', 2),
      s.tool('st1', 'grep', 'completed', 3, { params: { pattern: 'needle' } }),
      s.text('sa', 'it is in src/x.ts', 6),
      s.turnEnd('send', 7),
    ];
    return { c, s, root, sub };
  }

  test('a task_v2 bubble is a subagent node linked by toolCallId: childAgentId, spawn edge, inner nodes carry agentId', () => {
    const { c, s, root, sub } = family();
    const r = go([...root, ...sub]);
    const t1 = nodeOf(r, c.node('t1'));
    expect(t1).toMatchObject({ kind: 'subagent', toolName: 'task_v2', toolUseId: 'tc1', childAgentId: SUB, title: 'explorer', summary: 'look into t1', status: 'succeeded', agentId: null });
    expect(nodeOf(r, s.node('su'))).toMatchObject({ agentId: SUB, parentId: c.node('t1'), kind: 'prompt' });
    expect(nodeOf(r, s.node('st1'))).toMatchObject({ agentId: SUB, parentId: s.node('su'), summary: 'needle', status: 'succeeded' });
    expect(edgesByKind(r, 'spawn')).toEqual([`${c.node('t1')}->${s.node('su')}`]);
    expect(nodeOf(r, c.node('a1')).parentId).toBe(c.node('t1'));
    expect(session(r).title).toBe('With a helper');
  });

  test('either arrival order (and any interleaving) gives the same graph and session', () => {
    const { root, sub } = family();
    const ref = shape(go([...root, ...sub]));
    expect(shape(go([...sub, ...root]))).toEqual(ref);
    for (let seed = 1; seed <= 40; seed++) expect(shape(go(interleave([root, sub], seed)))).toEqual(ref);
  });

  test('the composer record arriving after the bubbles (root and subagent) changes nothing in the result', () => {
    const { root, sub } = family();
    const ref = shape(go([...root, ...sub]));
    const late = [...root.slice(1), ...sub.slice(1), sub[0]!, root[0]!];
    expect(shape(go(late))).toEqual(ref);
  });

  test('dispatch status follows the subagent: running while its last turn is open, then the task_v2 status', () => {
    const c = new CursorConv({ id: ROOT });
    const s = new CursorConv({ id: SUB, sessionId: ROOT });
    const live = new CursorNormalizer();
    const step = (events: RawEvent[]) => run(live, events);
    step([c.composer({ status: 'none' }), c.user('u1', 'go', 0), c.task('t1', 'tc1', 'completed', 1, { durSec: 2 })]);
    let r = step([s.subagentComposer('tc1', ROOT, { status: 'none' }), s.user('su', 'task', 2)]);
    const t1 = c.node('t1');
    const patchOf = (x: RunResult) => [...x.changes].reverse().find((ch) => ch.type === 'node_updated' && ch.id === t1 && ch.patch.status !== undefined);
    expect(patchOf(r)).toMatchObject({ patch: { status: 'running', endedAt: null } });
    r = step([s.text('sa', 'result', 4), s.turnEnd('send', 5)]);
    expect(patchOf(r)).toMatchObject({ patch: { status: 'succeeded', endedAt: iso(at(3)) } });
    // The task_v2 call failed: the dispatch fails once the subagent is done.
    const c2 = new CursorConv({ id: ROOT });
    const s2 = new CursorConv({ id: SUB, sessionId: ROOT });
    const r2 = go([c2.user('u1', 'go', 0), c2.task('t1', 'tc1', 'error', 1), s2.subagentComposer('tc1'), s2.user('su', 'task', 2), s2.turnEnd('send', 3)]);
    expect(nodeOf(r2, c2.node('t1')).status).toBe('failed');
  });

  test('a task_v2 whose subagent never appears: its own status; a subagent whose dispatch never arrives stays unshown', () => {
    const c = new CursorConv({ id: ROOT });
    const r = go([c.composer(), c.user('u1', 'go', 0), c.task('t1', 'tc1', 'completed', 1)]);
    expect(nodeOf(r, c.node('t1'))).toMatchObject({ kind: 'subagent', childAgentId: null, status: 'succeeded', title: 'explore' });
    expect(edgesByKind(r, 'spawn')).toEqual([]);
    const loading = new CursorConv({ id: ROOT });
    const r2 = go([loading.composer(), loading.user('u1', 'go', 0), loading.task('t1', 'tc1', 'loading', 1), loading.user('u2', 'next', 20)]);
    expect(nodeOf(r2, loading.node('t1')).status).toBe('failed');

    const s = new CursorConv({ id: SUB, sessionId: ROOT });
    const r3 = go([c.composer(), c.user('u1', 'go', 0), s.subagentComposer('tc-other'), s.user('su', 'task', 2), s.text('sa', 'x', 3)]);
    expect(nodes(r3).filter((n) => n.agentId !== null)).toEqual([]);
    expect([...r3.sessions.keys()]).toEqual([ROOT]);
  });

  test('nested subagents: a subagent dispatching its own subagent', () => {
    const c = new CursorConv({ id: ROOT });
    const s = new CursorConv({ id: SUB, sessionId: ROOT });
    const g = new CursorConv({ id: 'c-grand', sessionId: ROOT });
    const events = [
      c.user('u1', 'go', 0),
      c.task('t1', 'tc1', 'completed', 1, { durSec: 20 }),
      s.subagentComposer('tc1'),
      s.user('su', 'task', 2),
      s.task('st', 'tc2', 'completed', 3, { durSec: 5 }),
      g.subagentComposer('tc2', SUB),
      g.user('gu', 'sub task', 4),
      g.text('ga', 'deep result', 5),
    ];
    const ref = go(events);
    expect(nodeOf(ref, s.node('st'))).toMatchObject({ kind: 'subagent', agentId: SUB, childAgentId: 'c-grand' });
    expect(nodeOf(ref, g.node('gu'))).toMatchObject({ agentId: 'c-grand', parentId: s.node('st') });
    expect(edgesByKind(ref, 'spawn')).toEqual([`${c.node('t1')}->${s.node('su')}`, `${s.node('st')}->${g.node('gu')}`].sort());
    const reversed = go([...events.slice(5), ...events.slice(2, 5), ...events.slice(0, 2)]);
    expect(shape(reversed)).toEqual(shape(ref));
  });

  test('parallel subagents fork from one parent', () => {
    const c = new CursorConv({ id: ROOT });
    const r = go([c.user('u1', 'go', 0), c.task('t1', 'tc1', 'loading', 1), c.task('t2', 'tc2', 'loading', 2)]);
    expect(nodeOf(r, c.node('t2')).parentId).toBe(c.node('u1'));
    expect(edgesByKind(r, 'fork')).toEqual([`${c.node('u1')}->${c.node('t1')}:fork`, `${c.node('u1')}->${c.node('t2')}`].sort());
  });
});

describe('arrival order independence', () => {
  test('two subagents, root, composer records: any interleaving of the conversations gives the same graph', () => {
    const c = new CursorConv({ id: ROOT });
    const s1 = new CursorConv({ id: 'c-s1', sessionId: ROOT });
    const s2 = new CursorConv({ id: 'c-s2', sessionId: ROOT });
    const root = [
      c.user('u1', 'go', 0),
      c.thinking('th', 'plan', 1),
      c.task('t1', 'tc1', 'loading', 2),
      c.task('t2', 'tc2', 'loading', 3),
      c.update('t1', { completedAtMs: at(20), toolFormerData: { status: 'completed' } }),
      c.update('t2', { completedAtMs: at(25), toolFormerData: { status: 'error' } }),
      c.text('a1', 'both returned', 26),
      c.turnEnd('end', 27),
      c.composer({ status: 'completed', name: null }),
    ];
    const sub1 = [s1.subagentComposer('tc1'), s1.user('x', 'one', 2), s1.tool('x1', 'grep', 'completed', 3), s1.turnEnd('xe', 4)];
    const sub2 = [s2.user('y', 'two', 3), s2.tool('y1', 'grep', 'loading', 4), s2.update('y1', { completedAtMs: at(6), toolFormerData: { status: 'completed' } }), s2.subagentComposer('tc2')];
    const ref = shape(go([...root, ...sub1, ...sub2]));
    expect(Object.keys(ref.nodes)).toHaveLength(11);
    expect(ref.session).toMatchObject({ title: 'go', status: 'idle' });
    for (let seed = 1; seed <= 60; seed++) expect(shape(go(interleave([root, sub1, sub2], seed)))).toEqual(ref);
  });

  test('bubbles of one conversation in any order: the same graph, edges included', () => {
    const c = new CursorConv({ id: ROOT });
    const events = [
      c.composer(),
      c.user('u1', 'go', 0),
      c.text('a0', 'x', 1),
      c.tool('p1', 'read_file', 'completed', 2, { durSec: 5 }),
      c.tool('p2', 'read_file', 'completed', 3, { durSec: 5 }),
      c.text('a1', 'y', 9),
      c.user('u2', 'again', 20),
      c.text('a2', 'z', 21),
    ];
    const ref = go(events);
    for (let seed = 1; seed <= 30; seed++) {
      const shuffled = interleave(events.map((e) => [e]), seed);
      const r = go(shuffled);
      expect(r.graph.nodes).toEqual(ref.graph.nodes);
      expect(r.sessions.get(ROOT)).toEqual(ref.sessions.get(ROOT));
      expect(r.graph.edges).toEqual(ref.graph.edges);
    }
  });

  test('a long conversation updated in place and partly re-ordered: the same graph as its final records alone', () => {
    const c = new CursorConv({ id: ROOT });
    const events: RawEvent[] = [c.composer({ status: 'none' })];
    const finals = new Map<string, RawEvent>();
    const push = (bubbleId: string, e: RawEvent): void => {
      events.push(e);
      finals.set(bubbleId, e);
    };
    let sec = 0;
    for (let turn = 0; turn < 12; turn++) {
      push(`u${turn}`, c.user(`u${turn}`, `prompt ${turn}`, (sec += 2)));
      push(`th${turn}`, c.thinking(`th${turn}`, `thought ${turn}`, (sec += 1)));
      // two parallel loading tools, completed later; a third left loading (settled by the next prompt)
      push(`p${turn}a`, c.tool(`p${turn}a`, 'read_file', 'loading', (sec += 1)));
      push(`p${turn}b`, c.tool(`p${turn}b`, 'grep', 'loading', (sec += 1)));
      push(`p${turn}c`, c.tool(`p${turn}c`, 'grep', 'loading', (sec += 1)));
      push(`p${turn}a`, c.update(`p${turn}a`, { completedAtMs: at(sec + 3), toolFormerData: { status: 'completed' } }));
      push(`p${turn}b`, c.update(`p${turn}b`, { completedAtMs: at(sec + 4), toolFormerData: { status: turn % 3 === 0 ? 'error' : 'completed' } }));
      push(`a${turn}`, c.text(`a${turn}`, 'partial', (sec += 6)));
      push(`a${turn}`, c.update(`a${turn}`, { text: `answer ${turn} in full` }));
      if (turn % 4 === 1) push(`e${turn}`, c.turnEnd(`e${turn}`, (sec += 1)));
    }
    // An early answer moved behind its turn's thinking (the list changed): re-stored with a new order.
    const orderOf = (bubbleId: string): number => (JSON.parse((finals.get(bubbleId) as { line: string }).line) as { order: number }).order;
    const thOrder = orderOf('th3');
    const aOrder = orderOf('a3');
    push('a3', c.update('a3', { order: thOrder }));
    push('th3', c.update('th3', { order: aOrder }));
    events.push(c.composer({ status: 'completed' }));

    const live = go(events);
    // Reference: only the final record of each bubble, in conversation order (order, then createdAt, then id).
    const key = (e: RawEvent): [number, string, string] => {
      const r = JSON.parse((e as { line: string }).line) as { order: number; createdAt: string; bubbleId: string };
      return [r.order, r.createdAt, r.bubbleId];
    };
    const inOrder = [...finals.values()].sort((x, y) => {
      const [a, b] = [key(x), key(y)];
      return a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || (a[2] < b[2] ? -1 : 1);
    });
    const finalOnly = go([c.composer({ status: 'completed' }), ...inOrder]);
    expect(live.graph.nodes).toEqual(finalOnly.graph.nodes);
    expect(live.sessions.get(ROOT)).toEqual(finalOnly.sessions.get(ROOT));
    expect(live.graph.edges).toEqual(finalOnly.graph.edges);
    expect(nodeOf(live, c.node('p5c'))).toMatchObject({ status: 'failed' }); // never finished
    expect(nodeOf(live, c.node('p11c')).status).toBe('running'); // last turn still open
    expect(nodeOf(live, c.node('a3')).parentId).toBe(c.node('u3')); // moved to just after its prompt
    expect(nodeOf(live, c.node('p3a')).parentId).toBe(c.node('a3'));
    expect(nodeOf(live, c.node('th3')).parentId).toBe(c.node('p3c')); // joins the parallel run
  });

  test('replaying the same records after dropSession gives the same changes (rebuild = live)', () => {
    const c = new CursorConv({ id: ROOT });
    const events = [c.composer(), c.user('u1', 'go', 0), c.tool('t1', 'read_file', 'loading', 1), c.update('t1', { completedAtMs: at(2), toolFormerData: { status: 'completed' } }), c.turnEnd('e', 3)];
    const n = new CursorNormalizer();
    const first = run(n, events);
    expect(n.hasSession(ROOT)).toBe(true);
    expect(n.sessionCount()).toBe(1);
    n.dropSession(ROOT);
    expect(n.hasSession(ROOT)).toBe(false);
    // Task 5: hook marks are kept before a session exists, so a dropped session asks for its pre-session replay.
    expect(n.needsPreSessionReplay(ROOT)).toBe(true);
    const second = run(n, events);
    expect(second.changes).toEqual(first.changes);
  });
});

test('registered as the cursor normalizer', () => {
  expect(NORMALIZER_FACTORIES.cursor).not.toBeNull();
  expect(NORMALIZER_FACTORIES.cursor!()).toBeInstanceOf(CursorNormalizer);
  const c = new CursorConv({ id: ROOT });
  const out = new NormalizerRegistry().apply(c.user('u1', 'hi', 0), 'p1');
  expect(out.changes.some((x) => x.type === 'node_added')).toBe(true);
});
