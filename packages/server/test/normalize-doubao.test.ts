import { describe, expect, test } from 'vitest';
import { applyChanges, emptyGraph, type Change, type Graph, type GraphNode, type Session } from '@agent-canvas/shared';
import { doubaoNodeId, DoubaoNormalizer } from '../src/normalize/doubao.js';
import { doubaoTouches } from '../src/normalize/files.js';
import { NORMALIZER_FACTORIES } from '../src/normalize/registry.js';
import type { RawEvent } from '../src/store/store.js';
import {
  assignment,
  assistant,
  call,
  CONV,
  createAgentOk,
  DOUBAO_PROJECT_ID,
  exampleChild,
  exampleMain,
  LEAF,
  MAIN,
  metaEvent,
  MTIME,
  offsetOf,
  ORG,
  REMINDER,
  rowEvents,
  T1,
  T2,
  T3,
  tool,
  user,
} from './doubao-fixtures.js';

interface Folded {
  graph: Graph;
  details: Map<string, Record<string, unknown>>;
  session: Session | undefined;
  unknown: string[];
}

/** Folds changes as the store does: graph, merged details (dropped with their node), the last session row. */
function fold(changes: Change[], unknown: string[] = []): Folded {
  const details = new Map<string, Record<string, unknown>>();
  let session: Session | undefined;
  for (const c of changes) {
    if (c.type === 'node_added') details.set(c.node.id, { ...c.detail });
    else if (c.type === 'node_updated' && c.detail !== undefined && details.has(c.id)) details.set(c.id, { ...details.get(c.id), ...c.detail });
    else if (c.type === 'node_removed') details.delete(c.id);
    else if (c.type === 'session_upserted') session = c.session;
  }
  return { graph: applyChanges(emptyGraph(), changes), details, session, unknown };
}

/** One event at a time through apply. */
function go(events: RawEvent[], n = new DoubaoNormalizer()): Folded {
  const changes: Change[] = [];
  const unknown: string[] = [];
  for (const ev of events) {
    const r = n.apply(ev, DOUBAO_PROJECT_ID);
    changes.push(...r.changes);
    if (r.unknownRecordType !== undefined) unknown.push(r.unknownRecordType);
  }
  return fold(changes, unknown);
}

/** In batches of `page` through applyBatch; with `cut`, the session is dropped there and re-hydrated from the events so far. */
function paged(events: RawEvent[], page: number, cut?: number): Folded {
  const n = new DoubaoNormalizer();
  const changes: Change[] = [];
  const unknown: string[] = [];
  const items = (evs: RawEvent[]) => evs.map((event) => ({ event, projectId: DOUBAO_PROJECT_ID }));
  const feed = (evs: RawEvent[]): void => {
    for (let i = 0; i < evs.length; i += page) {
      const r = n.applyBatch(items(evs.slice(i, i + page)));
      changes.push(...r.changes);
      for (const u of r.unknown) if (u !== undefined) unknown.push(u);
    }
  };
  if (cut === undefined) feed(events);
  else {
    feed(events.slice(0, cut));
    n.dropSession(CONV);
    n.applyBatch(items(events.slice(0, cut))); // hydration: its changes are stored already
    feed(events.slice(cut));
  }
  return fold(changes, unknown);
}

/** Nodes, edges and details in a comparable form (sorted by id). */
function shape(f: Folded) {
  const nodes = Object.values(f.graph.nodes).sort((a, b) => a.id.localeCompare(b.id));
  const edges = Object.values(f.graph.edges).map((e) => `${e.from}->${e.to}:${e.kind}`).sort();
  const details = [...f.details.entries()].sort(([a], [b]) => a.localeCompare(b));
  return { nodes, edges, details, session: f.session };
}

const id = (part: string, agentId: string | null = null): string => doubaoNodeId(CONV, agentId, part);
const nodesOf = (f: Folded): GraphNode[] => Object.values(f.graph.nodes);
const at = (iso: string): string => new Date(Date.parse(iso)).toISOString();

const main = exampleMain();
const child = exampleChild();
const mainRows = (o: { mtimeMs?: number | null } = {}) => rowEvents(main.lines, o);
const childRows = (o: { mtimeMs?: number | null } = {}) => rowEvents(child.lines, { agent: ORG, ...o });

describe('rows to nodes (spec 5.2)', () => {
  test('the registry holds a Doubao normaliser', () => {
    expect(NORMALIZER_FACTORIES.doubao).not.toBeNull();
    expect(NORMALIZER_FACTORIES.doubao!()).toBeInstanceOf(DoubaoNormalizer);
  });

  test('each row kind: prompts, replies, tool calls paired by id (parallel results in any order); no usage, model or cwd', () => {
    const f = go([metaEvent(main.assignment), ...mainRows()]);
    expect(f.unknown).toEqual([]);
    const L = main.lines;
    const p1 = id(`@${offsetOf(L, 0)}`);
    const plan = id(`@${offsetOf(L, 1)}`);
    expect(f.graph.nodes[p1]).toMatchObject({ kind: 'prompt', agentId: null, parentId: null, turnId: p1 });
    expect(f.details.get(p1)).toEqual({ text: 'Summarise the three reports in this folder' });
    expect(f.graph.nodes[plan]).toMatchObject({ kind: 'text', parentId: p1, turnId: p1, usage: null });
    expect(f.details.get(plan)).toEqual({ text: 'I will read the files first.' });
    const a1 = f.graph.nodes[id('call:call_a1')]!;
    const a2 = f.graph.nodes[id('call:call_a2')]!;
    expect(a1).toMatchObject({ kind: 'tool', toolName: 'Read', toolUseId: 'call_a1', status: 'succeeded', parentId: plan, files: [{ path: 'report-1.md', action: 'read' }] });
    expect(a2).toMatchObject({ kind: 'tool', toolName: 'Read', status: 'succeeded', parentId: a1.id, files: [{ path: 'report-2.md', action: 'read' }] });
    // `arguments` as an object and as a JSON string: the same parsed input.
    expect(f.details.get(a1.id)).toEqual({ input: { file_path: 'report-1.md' }, output: 'first report text' });
    expect(f.details.get(a2.id)).toEqual({ input: { file_path: 'report-2.md' }, output: 'second report text' });
    // A row of tool calls with no content is a normal row: just the call.
    expect(f.graph.nodes[id('call:call_c1')]).toMatchObject({ kind: 'subagent', toolName: 'create_agent', parentId: a2.id });
    const p2 = id(`@${offsetOf(L, 7)}`);
    expect(f.graph.nodes[p2]).toMatchObject({ kind: 'prompt', turnId: p2, parentId: id(`@${offsetOf(L, 6)}`) });
    expect(f.graph.nodes[id('call:call_b1')]).toMatchObject({ toolName: 'PowerShell', status: 'succeeded', turnId: p2 });
    expect(f.session).toMatchObject({ id: CONV, origin: 'doubao', projectId: DOUBAO_PROJECT_ID, cwd: null, title: 'Summarise the three reports in this folder', gitBranch: null });
    for (const n of nodesOf(f)) expect(n.usage).toBeNull();
    expect(JSON.stringify([...f.details.values()])).not.toMatch(/model/);
  });

  test('an assistant row with null content and tool calls is valid; empty content makes no text node', () => {
    const f = go(rowEvents([user('go'), assistant(null, [call('x1', 'Bash', { command: 'ls' })]), assistant('', [call('x2', 'Bash', { command: 'pwd' })]), tool('x1', 'a'), tool('x2', 'b')]));
    expect(f.unknown).toEqual([]);
    expect(nodesOf(f).map((n) => n.kind).sort()).toEqual(['prompt', 'tool', 'tool']);
  });

  test('two identical rows are two nodes', () => {
    const lines = [user('hi'), assistant('Same answer.'), assistant('Same answer.')];
    const f = go(rowEvents(lines));
    expect(nodesOf(f).filter((n) => n.kind === 'text').map((n) => n.id)).toEqual([id(`@${offsetOf(lines, 1)}`), id(`@${offsetOf(lines, 2)}`)]);
  });

  test('leading reminder blocks are stripped from a user row; a reminder-only user row makes nothing', () => {
    const lines = [user(`${REMINDER}\nReal question`), assistant('Answer.'), user(REMINDER), assistant('After the notice.')];
    const f = go(rowEvents(lines));
    expect(f.unknown).toEqual([]);
    const prompts = nodesOf(f).filter((n) => n.kind === 'prompt');
    expect(prompts.map((n) => n.id)).toEqual([id('@0')]);
    expect(f.details.get(id('@0'))).toEqual({ text: 'Real question' });
    expect(JSON.stringify(f)).not.toContain('answer in Chinese');
    expect(f.session!.title).toBe('Real question');
  });

  test('an unknown role, a non-string content, bad JSON and non-objects are skipped and counted', () => {
    const lines = [
      user('ok'),
      JSON.stringify({ role: 'system', content: 'hidden prompt' }),
      JSON.stringify({ content: 'no role' }),
      user([{ type: 'text', text: 'parts' }]),
      assistant({ text: 'object' }),
      JSON.stringify({ role: 'assistant' }),
      JSON.stringify({ role: 'tool', content: 'no id' }),
      JSON.stringify({ role: 'tool', tool_call_id: 'q', content: 7 }),
      '{not json',
      '[1,2]',
      assistant('fine'),
    ];
    const f = go(rowEvents(lines));
    expect(f.unknown).toEqual([
      'doubao:role/system',
      'doubao:role/?',
      'doubao:content/user',
      'doubao:content/assistant',
      'doubao:content/assistant',
      'doubao:tool/no-call-id',
      'doubao:content/tool',
      'doubao:invalid-json',
      'doubao:not-an-object',
    ]);
    expect(nodesOf(f).map((n) => n.kind)).toEqual(['prompt', 'text']);
    expect(JSON.stringify(f)).not.toContain('hidden prompt');
  });

  test('a result without its call shows as a finished call; a call without a result stays running', () => {
    const f = go(rowEvents([user('go'), tool('lost', 'orphan output'), assistant(undefined, [call('open', 'Bash', { command: 'sleep 9' })])]));
    expect(f.graph.nodes[id('call:lost')]).toMatchObject({ kind: 'tool', status: 'succeeded', toolName: null });
    expect(f.details.get(id('call:lost'))).toEqual({ output: 'orphan output' });
    expect(f.graph.nodes[id('call:open')]).toMatchObject({ status: 'running', endedAt: null });
  });
});

describe('times (spec 5.3): the nth prompt takes the nth demand', () => {
  test('every node of a turn has its demand time; the reminder-only section is not a demand; order does not matter', () => {
    for (const events of [[metaEvent(main.assignment), ...mainRows()], [...mainRows(), metaEvent(main.assignment)]]) {
      const f = go(events);
      const L = main.lines;
      for (const n of nodesOf(f)) {
        const second = n.turnId === id(`@${offsetOf(L, 7)}`);
        expect(n.timestamp, n.id).toBe(at(second ? T2 : T1));
      }
      expect(f.graph.nodes[id('call:call_a1')]).toMatchObject({ endedAt: at(T1) });
      expect(f.session).toMatchObject({ startedAt: at(T1), lastActivityAt: at(T2) });
    }
    expect(shape(go([metaEvent(main.assignment), ...mainRows()]))).toEqual(shape(go([...mainRows(), metaEvent(main.assignment)])));
  });

  test('fallback to the file modification time: no assignment, a time that does not parse, more prompts than demands', () => {
    const none = go(mainRows());
    for (const n of nodesOf(none)) expect(n.timestamp).toBe(new Date(MTIME).toISOString());
    const bad = go([metaEvent(assignment([{ at: 'last tuesday', text: 'Summarise' }, { at: T2, text: 'Now chart them' }])), ...mainRows()]);
    const p2 = id(`@${offsetOf(main.lines, 7)}`);
    for (const n of nodesOf(bad)) expect(n.timestamp, n.id).toBe(n.turnId === p2 ? at(T2) : new Date(MTIME).toISOString());
    const short = go([metaEvent(assignment([{ at: T1, text: 'Summarise' }])), ...mainRows()]);
    for (const n of nodesOf(short)) expect(n.timestamp, n.id).toBe(n.turnId === p2 ? new Date(MTIME).toISOString() : at(T1));
    // A later assignment with the second demand moves the second turn to its time.
    const whole = go([metaEvent(assignment([{ at: T1, text: 'Summarise' }])), ...mainRows(), metaEvent(main.assignment)]);
    expect(shape(whole)).toEqual(shape(go([metaEvent(main.assignment), ...mainRows()])));
  });

  test('the modification time travels with the rows: replaying the same events gives the same times', () => {
    const a = go(mainRows({ mtimeMs: MTIME + 5000 }));
    const b = paged(mainRows({ mtimeMs: MTIME + 5000 }), 3, 4);
    expect(shape(b)).toEqual(shape(a));
    for (const n of nodesOf(a)) expect(n.timestamp).toBe(new Date(MTIME + 5000).toISOString());
  });
});

describe('the first demand without a user row (format reference A3)', () => {
  test('a prompt node from the assignment text opens the first turn, whichever file is read first', () => {
    const lines = [assistant('Working on it.'), assistant('Done.'), user('And now this'), assistant('Also done.')];
    const text = assignment([{ at: T1, text: `${REMINDER}\nThe first task` }, { at: T2, text: 'And now this' }]);
    const before = go([metaEvent(text), ...rowEvents(lines)]);
    const afterRows = go([...rowEvents(lines), metaEvent(text)]);
    expect(shape(afterRows)).toEqual(shape(before));
    const p0 = id('demand0');
    expect(before.graph.nodes[p0]).toMatchObject({ kind: 'prompt', parentId: null, turnId: p0, timestamp: at(T1) });
    expect(before.details.get(p0)).toEqual({ text: 'The first task' });
    expect(before.graph.nodes[id('@0')]).toMatchObject({ kind: 'text', parentId: p0, turnId: p0, timestamp: at(T1) });
    const p2 = id(`@${offsetOf(lines, 2)}`);
    expect(before.graph.nodes[p2]).toMatchObject({ kind: 'prompt', turnId: p2, timestamp: at(T2) });
    expect(before.session!.title).toBe('The first task');
    expect(Object.values(before.graph.edges).map((e) => `${e.from}->${e.to}`)).toContain(`${p0}->${id('@0')}`);
  });

  test('with a user row first, no prompt is made from the assignment (also when the assignment came first)', () => {
    const f = go([metaEvent(main.assignment), ...mainRows()]);
    expect(f.graph.nodes[id('demand0')]).toBeUndefined();
    expect(shape(f)).toEqual(shape(go([...mainRows(), metaEvent(main.assignment)])));
    expect(nodesOf(f).filter((n) => n.kind === 'prompt')).toHaveLength(2);
  });

  test('an assignment alone (no trajectory yet) shows its first demand; the thread file then confirms or replaces it', () => {
    const f = go([metaEvent(main.assignment)]);
    expect(f.graph.nodes[id('demand0')]).toMatchObject({ kind: 'prompt' });
    expect(f.session).toMatchObject({ id: CONV, title: 'Summarise the three reports in this folder' });
  });
});

describe('subagent threads (spec 5.4)', () => {
  const sub = id('call:call_c1');

  test('linked through the create_agent ok result, child read before or after the parent', () => {
    const parentFirst = go([metaEvent(main.assignment), ...mainRows(), metaEvent(child.assignment, { agent: ORG }), ...childRows()]);
    const childFirst = go([...childRows(), metaEvent(child.assignment, { agent: ORG }), ...mainRows(), metaEvent(main.assignment)]);
    expect(shape(childFirst)).toEqual(shape(parentFirst));
    expect(parentFirst.unknown).toEqual([]);
    expect(parentFirst.graph.nodes[sub]).toMatchObject({ kind: 'subagent', childAgentId: ORG });
    // The organizer's task came only through its assignment.md: a prompt node opens its thread, off the call.
    const p0 = id('demand0', ORG);
    expect(parentFirst.graph.nodes[p0]).toMatchObject({ kind: 'prompt', agentId: ORG, parentId: sub, timestamp: at(T3) });
    expect(Object.values(parentFirst.graph.edges).find((e) => e.to === p0)).toMatchObject({ from: sub, kind: 'spawn' });
    expect(parentFirst.graph.nodes[id('call:call_w1', ORG)]).toMatchObject({ files: [{ path: 'figures.csv', action: 'write' }], timestamp: at(T3) });
    // Only the main agent names the session.
    expect(parentFirst.session!.title).toBe('Summarise the three reports in this folder');
  });

  test('nested: an organizer creating a leaf names itself as parent_id', () => {
    const org = [assistant(undefined, [call('call_l1', 'create_agent', { subtask: 'Leaf work' })]), tool('call_l1', createAgentOk(LEAF, ORG, '7391000000000000002', 'agent_type: sub_agent'))];
    const leaf = [user('Leaf work'), assistant('Leaf done.')];
    const f = go([...mainRows(), ...rowEvents(org, { agent: ORG }), ...rowEvents(leaf, { agent: LEAF })]);
    expect(f.graph.nodes[id('call:call_l1', ORG)]).toMatchObject({ kind: 'subagent', childAgentId: LEAF });
    expect(f.graph.nodes[id('@0', LEAF)]).toMatchObject({ parentId: id('call:call_l1', ORG) });
  });

  test('a result that does not parse leaves the thread unlinked, under the session', () => {
    const variants = [
      createAgentOk(ORG, 'someone_else'), // parent_id must be main_agent for the main agent
      createAgentOk(ORG, 'main_agent', 'not-digits'),
      `create_agent ok\nparent_id: main_agent\nthread_id: 1`, // no agent_id
      createAgentOk(MAIN, 'main_agent'), // the caller itself
      `create_agent failed\nagent_id: ${ORG}\nparent_id: main_agent\nthread_id: 1`,
      `create_agent ok agent_id: ${ORG}`,
    ];
    for (const result of variants) {
      const lines = [user('go'), assistant(undefined, [call('call_c1', 'create_agent', { subtask: 'x' })]), tool('call_c1', result)];
      const f = go([...rowEvents(lines), ...childRows()]);
      expect(f.graph.nodes[sub], result).toMatchObject({ kind: 'subagent', childAgentId: null });
      expect(f.graph.nodes[id('@0', ORG)], result).toMatchObject({ agentId: ORG, parentId: null });
      expect(Object.values(f.graph.edges).some((e) => e.kind === 'spawn'), result).toBe(false);
    }
  });
});

describe('rewrites and determinism', () => {
  test('a rewritten file (read again from its start) re-derives the thread: what is left, nothing stale', () => {
    const kept = main.lines.slice(0, 4);
    const events = [metaEvent(main.assignment), ...mainRows(), ...rowEvents(kept, { mtimeMs: MTIME + 1 })];
    const f = go(events);
    const fresh = go([metaEvent(main.assignment), ...rowEvents(kept, { mtimeMs: MTIME + 1 })]);
    expect(shape(f).nodes).toEqual(shape(fresh).nodes);
    expect(shape(f).edges).toEqual(shape(fresh).edges);
    expect(shape(f).details).toEqual(shape(fresh).details);
    expect(JSON.stringify(f)).not.toContain('Now chart them');
  });

  test('a rewrite whose first row is no longer a user row brings the assignment prompt back', () => {
    const lines = [assistant('Started without a user row.'), assistant('More.')];
    const events = [metaEvent(main.assignment), ...mainRows(), ...rowEvents(lines, { mtimeMs: MTIME + 1 })];
    const f = go(events);
    expect(f.graph.nodes[id('demand0')]).toMatchObject({ kind: 'prompt', timestamp: at(T1) });
    expect(f.graph.nodes[id('@0')]).toMatchObject({ parentId: id('demand0') });
    expect(nodesOf(f).map((n) => n.id).sort()).toEqual([id('demand0'), id('@0'), id(`@${offsetOf(lines, 1)}`)].sort());
  });

  test('a rewrite that removes the first user row remakes the assignment prompt with the full demand text, as a fresh read and a replay do', () => {
    const long = `The first task: ${'details '.repeat(400)}end.`;
    const text = assignment([{ at: T1, text: `${REMINDER}\n${long}` }, { at: T2, text: 'Now chart them' }]);
    const v2 = [assistant('Started without a user row.'), assistant('More.')];
    const events = [metaEvent(text), ...mainRows(), ...rowEvents(v2, { mtimeMs: MTIME + 1 })];
    const f = go(events);
    expect(f.details.get(id('demand0'))).toEqual({ text: long });
    const fresh = go([metaEvent(text), ...rowEvents(v2, { mtimeMs: MTIME + 1 })]);
    expect(shape(f).nodes).toEqual(shape(fresh).nodes);
    expect(shape(f).details).toEqual(shape(fresh).details);
    for (const cut of [1, 5, events.length - 1]) expect(shape(paged(events, 3, cut)), `cut ${cut}`).toEqual(shape(f));
  });

  test('one-shot = row by row = in pages = dropped and re-hydrated midway', () => {
    const events = [...childRows(), metaEvent(main.assignment), ...mainRows(), metaEvent(child.assignment, { agent: ORG })];
    const one = paged(events, events.length);
    expect(shape(go(events))).toEqual(shape(one));
    for (const page of [1, 2, 5]) expect(shape(paged(events, page))).toEqual(shape(one));
    for (const cut of [1, 3, 5, 9, 15, 18]) expect(shape(paged(events, 4, cut)), `cut ${cut}`).toEqual(shape(one));
  });

  test('nothing of a row is kept: no tool inputs held', () => {
    const n = new DoubaoNormalizer();
    go([metaEvent(main.assignment), ...mainRows()], n);
    expect(n.toolInputCount(CONV)).toBe(0);
    expect(n.hasSession(CONV)).toBe(true);
    expect(n.sessionCount()).toBe(1);
  });
});

describe('doubaoTouches (unverified argument names)', () => {
  test('Read / Write / Edit with the first path argument found; other tools and bad input name nothing', () => {
    expect(doubaoTouches('Read', { file_path: 'a.md' })).toEqual([{ path: 'a.md', action: 'read' }]);
    expect(doubaoTouches('Write', { path: 'b.md' })).toEqual([{ path: 'b.md', action: 'write' }]);
    expect(doubaoTouches('Edit', '{"filePath":"c.md"}')).toEqual([{ path: 'c.md', action: 'edit' }]);
    expect(doubaoTouches('Edit', { file_path: 'first', path: 'second' })).toEqual([{ path: 'first', action: 'edit' }]);
    expect(doubaoTouches('Bash', { file_path: 'x' })).toEqual([]);
    expect(doubaoTouches('PowerShell', { command: 'cat x' })).toEqual([]);
    expect(doubaoTouches('Read', 'not json')).toEqual([]);
    expect(doubaoTouches('Read', ['a'])).toEqual([]);
    expect(doubaoTouches('read', { file_path: 'x' })).toEqual([]);
  });
});
