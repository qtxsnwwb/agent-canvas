import { describe, expect, test } from 'vitest';
import { applyChanges, emptyGraph, type GraphNode, type Session } from '@agent-canvas/shared';
import { CursorNormalizer } from '../src/normalize/cursor.js';
import type { RawEvent } from '../src/store/store.js';
import { interleave, run, type RunResult } from './codex-fixtures.js';
import { CursorConv } from './cursor-records.js';

// Fix round 2: type-1 bubbles that are background-task notices (`<system_notification>`), not user prompts.
// Synthetic records only.

const ROOT = 'c-root';
const SUB = 'c-sub';

const go = (events: RawEvent[]): RunResult => run(new CursorNormalizer(), events);
const nodeOf = (r: RunResult, id: string): GraphNode => {
  const n = r.graph.nodes[id];
  if (n === undefined) throw new Error(`no node ${id}; have ${Object.keys(r.graph.nodes).join(', ')}`);
  return n;
};
const detailOf = (r: RunResult, id: string): Record<string, unknown> => {
  let d: Record<string, unknown> = {};
  for (const c of r.changes) {
    if (c.type === 'node_added' && c.node.id === id) d = { ...c.detail };
    if (c.type === 'node_updated' && c.id === id && c.detail !== undefined) d = { ...d, ...c.detail };
  }
  return d;
};
const turnIds = (r: RunResult): string[] => [...new Set(Object.values(r.graph.nodes).map((n) => n.turnId ?? '-'))].sort();

/** Steps applied one after another on one normalizer, with the session as it stands after each step. */
function stepper() {
  const n = new CursorNormalizer();
  let latest = new Map<string, Session>();
  return (events: RawEvent[]): Session => {
    const r = run(n, events);
    latest = new Map([...latest, ...r.sessions]);
    return latest.get(ROOT)!;
  };
}

describe('a background-task notice is a system node, not a prompt', () => {
  test('shape, summary (high-level summary, else task, else the stripped text) and detail; it stays in the current turn', () => {
    const c = new CursorConv({ id: ROOT });
    const plain = '<system_notification>\n  Something   <b>finished</b> in the background.\n</system_notification>';
    const r = go([
      c.composer({ status: 'completed' }),
      c.user('u', 'start the indexer', 0),
      c.text('a', 'started it', 1),
      c.turnEnd('e', 2),
      c.notification('n1', 10, { task: 'Index the repository', summary: 'Indexed  412 files' }),
      c.notification('n2', 11, { task: '  Run the   test suite ', timestamp: false }),
      c.user('n3', plain, 12),
      c.text('a2', 'the tests pass', 13),
    ]);
    const n1 = nodeOf(r, c.node('n1'));
    expect(n1).toMatchObject({ kind: 'system', systemSubtype: 'task_notification', summary: 'Indexed 412 files', turnId: c.node('u'), parentId: c.node('e'), status: null });
    expect(n1.title).not.toMatch(/</);
    expect(nodeOf(r, c.node('n2'))).toMatchObject({ kind: 'system', summary: 'Run the test suite', turnId: c.node('u') });
    expect(nodeOf(r, c.node('n3'))).toMatchObject({ kind: 'system', summary: 'Something finished in the background.' });
    expect(nodeOf(r, c.node('a2'))).toMatchObject({ turnId: c.node('u'), parentId: c.node('n3') });
    expect(detailOf(r, c.node('n1')).text).toMatch(/^<timestamp>.*<\/timestamp>\n<system_notification>[\s\S]*<\/system_notification>$/);
    expect(turnIds(r)).toEqual([c.node('u')]); // one turn
    for (const n of Object.values(r.graph.nodes)) expect(n.summary).not.toMatch(/<\/?(timestamp|system_notification|task)>/);
  });

  test('a prompt that only contains such tags later in its text is a prompt', () => {
    const c = new CursorConv({ id: ROOT });
    const text = 'Why did I get this?\n<system_notification><task>x</task></system_notification>';
    const r = go([c.user('u', 'go', 0), c.user('q', text, 5)]);
    expect(nodeOf(r, c.node('q'))).toMatchObject({ kind: 'prompt', turnId: c.node('q') });
  });

  test('as the first bubble of a conversation it starts the (prompt-less) first turn; the title skips it', () => {
    const c = new CursorConv({ id: ROOT });
    const r = go([c.composer({ name: null }), c.notification('n', 0), c.text('a', 'noted', 1), c.user('u', 'now the real question', 5)]);
    expect(nodeOf(r, c.node('n'))).toMatchObject({ kind: 'system', turnId: null, parentId: null });
    expect(nodeOf(r, c.node('a')).turnId).toBeNull();
    expect(nodeOf(r, c.node('u')).turnId).toBe(c.node('u'));
    expect(r.sessions.get(ROOT)!.title).toBe('now the real question');
  });

  test('a subagent thread gets the same treatment', () => {
    const c = new CursorConv({ id: ROOT });
    const s = new CursorConv({ id: SUB, sessionId: ROOT });
    const r = go([c.user('u', 'go', 0), c.task('t', 'tc1', 'completed', 1, { durSec: 9 }), s.subagentComposer('tc1'), s.user('su', 'task', 2), s.notification('sn', 3), s.turnEnd('se', 4)]);
    expect(nodeOf(r, s.node('sn'))).toMatchObject({ kind: 'system', agentId: SUB, turnId: s.node('su') });
  });
});

describe('turns and session status with notices', () => {
  test('a notice after a finished turn leaves the session idle; assistant activity after it reopens the turn until the next turnDurationMs', () => {
    const c = new CursorConv({ id: ROOT });
    const step = stepper();
    expect(step([c.composer({ status: 'completed' }), c.user('u', 'go', 0), c.text('a', 'ok', 1), c.turnEnd('e', 2)]).status).toBe('idle');
    expect(step([c.notification('n', 10)]).status).toBe('idle'); // a trailing notice changes nothing
    expect(step([c.composer({ status: 'none' }), c.text('a2', 'the task finished, looking', 11)]).status).toBe('running');
    expect(step([c.tool('t', 'grep', 'loading', 12)]).status).toBe('running');
    expect(step([c.update('t', { completedAtMs: Date.parse('2026-11-12T08:00:13.000Z'), toolFormerData: { status: 'completed' } }), c.turnEnd('e2', 14)]).status).toBe('idle');
  });

  test('a notice after a pending prompt keeps the session running; after an open turn, too', () => {
    const c = new CursorConv({ id: ROOT });
    const step = stepper();
    expect(step([c.composer({ status: 'completed' }), c.user('u', 'go', 0)]).status).toBe('running');
    expect(step([c.notification('n', 1)]).status).toBe('running'); // the prompt is still the last real bubble
    const d = new CursorConv({ id: ROOT });
    const step2 = stepper();
    expect(step2([d.composer({ status: 'none' }), d.user('u', 'go', 0), d.tool('t', 'grep', 'loading', 1)]).status).toBe('running');
    expect(step2([d.notification('n', 2)]).status).toBe('running');
  });

  test('a loading call before the turnDurationMs bubble stays settled when a notice reopens the turn', () => {
    const c = new CursorConv({ id: ROOT });
    const r = go([c.composer({ status: 'none' }), c.user('u', 'go', 0), c.tool('t', 'grep', 'loading', 1), c.turnEnd('e', 2), c.notification('n', 5), c.text('a', 'more', 6)]);
    expect(nodeOf(r, c.node('t')).status).toBe('failed');
    expect(r.sessions.get(ROOT)!.status).toBe('running');
  });

  test('aborted: a trailing notice does not stop the abort rule', () => {
    const c = new CursorConv({ id: ROOT });
    const r = go([c.user('u', 'go', 0), c.tool('t', 'grep', 'loading', 1), c.notification('n', 2), c.composer({ status: 'aborted' })]);
    expect(r.sessions.get(ROOT)!.status).toBe('idle');
    expect(nodeOf(r, c.node('t')).status).toBe('failed');
  });
});

describe('prompt clean-up', () => {
  test('a leading <timestamp> is dropped from a prompt summary and title; a prompt that is exactly <user_query>…</user_query> is unwrapped', () => {
    const c = new CursorConv({ id: ROOT });
    const r = go([c.composer({ name: null }), c.user('u', '<timestamp>Thursday, 8:00 AM</timestamp>\n  fix   the build', 0)]);
    expect(nodeOf(r, c.node('u'))).toMatchObject({ kind: 'prompt', summary: 'fix the build' });
    expect(r.sessions.get(ROOT)!.title).toBe('fix the build');
    expect(detailOf(r, c.node('u')).text).toBe('<timestamp>Thursday, 8:00 AM</timestamp>\n  fix   the build');
    const d = new CursorConv({ id: ROOT });
    const r2 = go([d.composer({ name: null }), d.user('u', '  <user_query>\nwhat is this?\n</user_query> ', 0)]);
    expect(nodeOf(r2, d.node('u')).summary).toBe('what is this?');
    expect(r2.sessions.get(ROOT)!.title).toBe('what is this?');
    const e = new CursorConv({ id: ROOT });
    expect(nodeOf(go([e.user('u', '<user_query>a</user_query> and more', 0)]), e.node('u')).summary).toBe('<user_query>a</user_query> and more');
  });
});

describe('arrival order', () => {
  test('notices in the mix: source order, final records only and any interleaving give the same graph', () => {
    const c = new CursorConv({ id: ROOT });
    const s = new CursorConv({ id: SUB, sessionId: ROOT });
    const root = [
      c.composer({ status: 'none', name: null }),
      c.notification('n0', 0),
      c.user('u', 'go', 1),
      c.task('t', 'tc1', 'loading', 2),
      c.turnEnd('e', 3),
      c.notification('n1', 20, { summary: 'helper done' }),
      c.update('t', { completedAtMs: Date.parse('2026-11-12T08:00:19.000Z'), toolFormerData: { status: 'completed' } }),
      c.text('a', 'the helper is done', 21),
      c.turnEnd('e2', 22),
      c.composer({ status: 'completed', name: null }),
    ];
    const sub = [s.subagentComposer('tc1'), s.user('su', 'task', 3), s.notification('sn', 4), s.text('sa', 'done', 5), s.turnEnd('se', 6)];
    const shape = (r: RunResult) => ({ nodes: r.graph.nodes, edges: r.graph.edges, session: r.sessions.get(ROOT) });
    const ref = shape(go([...root, ...sub]));
    expect(ref.session).toMatchObject({ title: 'go', status: 'idle' });
    for (let seed = 1; seed <= 40; seed++) expect(shape(go(interleave([root, sub], seed))), `seed ${seed}`).toEqual(ref);
    // One batch gives the same graph and session.
    const batch = new CursorNormalizer().applyBatch([...root, ...sub].map((event) => ({ event, projectId: 'p1' })));
    const sessions = new Map<string, Session>();
    for (const ch of batch.changes) if (ch.type === 'session_upserted') sessions.set(ch.session.id, ch.session);
    expect({ nodes: applyChanges(emptyGraph(), batch.changes).nodes, edges: applyChanges(emptyGraph(), batch.changes).edges, session: sessions.get(ROOT) }).toEqual(ref);
  });
});
