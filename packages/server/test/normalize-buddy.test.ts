import { describe, expect, test } from 'vitest';
import { applyChanges, emptyGraph, type Change, type Graph, type GraphNode, type Session } from '@agent-canvas/shared';
import { activeBranch, type BranchLine } from '../src/normalize/buddy-branch.js';
import { BuddyNormalizer, buddyNodeId } from '../src/normalize/buddy.js';
import { buddyTouches } from '../src/normalize/files.js';
import { NORMALIZER_FACTORIES } from '../src/normalize/registry.js';
import type { RawEvent } from '../src/store/store.js';
import {
  aiTitle,
  assistantMessage,
  buddyEvents,
  Chain,
  CHILD,
  customTitle,
  CWD,
  everyCustomLine,
  exampleChild,
  exampleMain,
  functionCallObjectArgs,
  GRANDCHILD,
  inputText,
  isoOf,
  modelUsage,
  openaiUsage,
  PROJECT,
  reasoningItem,
  record,
  resendForkNotice,
  SID,
  topicRecord,
  userMessage,
  userMessageString,
  wrapped,
} from './buddy-fixtures.js';

type Origin = 'workbuddy' | 'codebuddy';

interface Folded {
  graph: Graph;
  details: Map<string, Record<string, unknown>>;
  session: Session | undefined;
  unknown: string[];
  changes: Change[];
}

/** Folds changes as the store does: graph, merged details (dropped with their node), the last session row. */
function fold(changes: Change[], unknown: string[] = []): Folded {
  const details = new Map<string, Record<string, unknown>>();
  let session: Session | undefined;
  for (const c of changes) {
    if (c.type === 'node_added') details.set(c.node.id, { ...c.detail });
    else if (c.type === 'node_updated' && c.detail !== undefined && details.has(c.id)) details.set(c.id, { ...details.get(c.id), ...c.detail });
    else if (c.type === 'node_removed') details.delete(c.id);
    else if (c.type === 'session_upserted' && c.session.id === SID) session = c.session;
  }
  return { graph: applyChanges(emptyGraph(), changes), details, session, unknown, changes };
}

const projectOf = (ev: RawEvent): string => (ev.source === 'transcript' && ev.projectId != null ? ev.projectId : 'unknown');

/** One event at a time through apply. */
function go(events: RawEvent[], n: BuddyNormalizer = new BuddyNormalizer('codebuddy')): Folded {
  const changes: Change[] = [];
  const unknown: string[] = [];
  for (const ev of events) {
    const r = n.apply(ev, projectOf(ev));
    changes.push(...r.changes);
    if (r.unknownRecordType !== undefined) unknown.push(r.unknownRecordType);
  }
  return fold(changes, unknown);
}

/** In batches of `page` through applyBatch; with `cut`, the session is dropped there and re-hydrated. */
function paged(events: RawEvent[], page: number, cut?: number, origin: Origin = 'codebuddy'): Folded {
  const n = new BuddyNormalizer(origin);
  const changes: Change[] = [];
  const unknown: string[] = [];
  const items = (evs: RawEvent[]) => evs.map((event) => ({ event, projectId: projectOf(event) }));
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
    n.dropSession(SID);
    n.applyBatch(items(events.slice(0, cut))); // hydration: its changes are stored already
    feed(events.slice(cut));
  }
  return fold(changes, unknown);
}

const comparable = (f: Folded) => ({ nodes: f.graph.nodes, edges: f.graph.edges, details: Object.fromEntries([...f.details].sort()), session: f.session });

/** The id of the node line `i` of `events` makes. */
const nodeAt = (events: RawEvent[], i: number): string => {
  const ev = events[i]!;
  if (ev.source !== 'transcript') throw new Error('not a transcript event');
  return buddyNodeId(ev.sessionId, ev.agentId, `@${ev.offset}`);
};
const nodeOf = (f: Folded, id: string): GraphNode => {
  const n = f.graph.nodes[id];
  if (n === undefined) throw new Error(`no node ${id}; have ${Object.keys(f.graph.nodes).join(', ')}`);
  return n;
};
const tsOf = (line: string): number => JSON.parse(line).timestamp as number;
const usage = (inputTokens: number, cachedInputTokens: number, outputTokens: number) => ({ inputTokens, cachedInputTokens, outputTokens });
const edgeIds = (f: Folded): string[] => Object.keys(f.graph.edges).sort();
const chainEdges = (ids: string[]): string[] => ids.slice(1).map((id, k) => `${ids[k]}->${id}`).sort();

describe('the example session', () => {
  const main = exampleMain();
  const child = exampleChild();
  const ev = buddyEvents(main.lines);
  const cev = buddyEvents(child.lines, { agentId: CHILD });
  const f = go([...ev, ...cev]);
  const L = main.lines;
  const idx = (k: string): number => L.findIndex((l) => JSON.parse(l).id === main.ids[k]);
  const N = (k: string): string => nodeAt(ev, idx(k));

  test('nodes in file order; session-meta, snapshots, titles and turn metrics add nothing and are not unknown', () => {
    expect(f.unknown).toEqual([]);
    const mainNodes = ['p1', 'r1', 'c1', 'c2', 'a1', 'p2', 'sub', 'a2'].map(N);
    expect(Object.keys(f.graph.nodes)).toEqual([...mainNodes, nodeAt(cev, 1)]);
    expect(edgeIds(f)).toEqual([...chainEdges(mainNodes), `${N('sub')}->${nodeAt(cev, 1)}`].sort());
  });

  test('the prompt: the text inside user_query; its turn is the request', () => {
    expect(nodeOf(f, N('p1'))).toMatchObject({ kind: 'prompt', title: 'Prompt', summary: 'fix the failing test', parentId: null, turnId: N('p1'), agentId: null, timestamp: isoOf(tsOf(L[idx('p1')]!)) });
    expect(f.details.get(N('p1'))).toEqual({ text: 'fix the failing test' });
  });

  test('reasoning: a thinking node with the message id and model; it is the first node of its response, so it holds the usage', () => {
    expect(nodeOf(f, N('r1'))).toMatchObject({ kind: 'thinking', title: 'Thinking', summary: 'The test reads fixtures/a.json.', messageId: 'resp-1', parentId: N('p1'), turnId: N('p1'), usage: usage(400, 600, 50) });
    expect(f.details.get(N('r1'))).toEqual({ text: 'The test reads fixtures/a.json.', raw: { model: 'glm-5.2' } });
  });

  test('a call and its result are one tool node: input parsed from the JSON string, output from the result, timing', () => {
    const c1 = nodeOf(f, N('c1'));
    expect(c1).toMatchObject({ kind: 'tool', title: 'Bash', toolName: 'Bash', toolUseId: 'call_abc', status: 'succeeded', messageId: 'resp-1', summary: 'npm test', usage: null, parentId: N('r1') });
    expect(c1.endedAt).toBe(isoOf(tsOf(L[idx('res1')]!)));
    expect(c1.durationMs).toBe(tsOf(L[idx('res1')]!) - tsOf(L[idx('c1')]!));
    expect(c1.inputKey).toMatch(/^[0-9a-f]{16}$/);
    expect(f.details.get(N('c1'))).toEqual({ input: { command: 'npm test' }, output: '1 failed, 12 passed', raw: { model: 'glm-5.2' } });
  });

  test('a file tool names its file, resolved against the line cwd; the response holds its own usage', () => {
    expect(nodeOf(f, N('c2'))).toMatchObject({ toolName: 'Read', files: [{ path: `${CWD}/src/a.ts`, action: 'read' }], usage: usage(200, 1000, 30), messageId: 'resp-2' });
    expect(f.details.get(N('c2'))?.output).toBe('export const a = 1;');
  });

  test('the reply: a text node with its usage', () => {
    expect(nodeOf(f, N('a1'))).toMatchObject({ kind: 'text', title: 'Text', summary: 'Fixed: the fixture path was wrong.', usage: usage(400, 1100, 20), turnId: N('p1') });
  });

  test('the second request is a turn of its own; the Agent dispatch is a subagent node linked to the child thread', () => {
    expect(nodeOf(f, N('p2')).turnId).toBe(N('p2'));
    expect(nodeOf(f, N('sub'))).toMatchObject({ kind: 'subagent', title: 'reviewer', toolName: 'Task', childAgentId: CHILD, status: 'succeeded', turnId: N('p2') });
    const c = nodeOf(f, nodeAt(cev, 1));
    expect(c).toMatchObject({ kind: 'text', agentId: CHILD, parentId: N('sub'), summary: 'Reviewed: fine.', usage: usage(500, 0, 10) });
    expect(f.graph.edges[`${N('sub')}->${nodeAt(cev, 1)}`]?.kind).toBe('spawn');
  });

  test('session: bare id, origin, project, cwd from the lines, title from ai-title, times from the lines', () => {
    expect(f.session).toMatchObject({ id: SID, origin: 'codebuddy', projectId: PROJECT, cwd: CWD, title: 'Fix failing fixture test', status: 'running', gitBranch: null });
    const times = [...L, ...child.lines].map(tsOf);
    expect(f.session?.startedAt).toBe(isoOf(Math.min(...times)));
    expect(f.session?.lastActivityAt).toBe(isoOf(Math.max(...times)));
  });

  test('one by one = one batch = any page size = drop and re-hydrate anywhere; the child first or last', () => {
    const all = [...ev, ...cev];
    const want = comparable(f);
    expect(comparable(paged(all, all.length))).toEqual(want);
    expect(comparable(paged(all, 3))).toEqual(want);
    for (const cut of [1, 5, 9, 14, all.length - 1]) expect(comparable(paged(all, 4, cut))).toEqual(want);
    expect(comparable(go([...cev, ...ev]))).toEqual(want);
  });

  test('both origins from the same lines: the same graph; the session says which', () => {
    const wb = go(buddyEvents(main.lines, { origin: 'workbuddy' }), new BuddyNormalizer('workbuddy'));
    const cb = go(buddyEvents(main.lines, { origin: 'codebuddy' }), new BuddyNormalizer('codebuddy'));
    expect(wb.graph).toEqual(cb.graph);
    expect(wb.session?.origin).toBe('workbuddy');
    expect(cb.session?.origin).toBe('codebuddy');
  });

  test('registered for both origins', () => {
    expect(NORMALIZER_FACTORIES.workbuddy?.()).toBeInstanceOf(BuddyNormalizer);
    expect(NORMALIZER_FACTORIES.codebuddy?.()).toBeInstanceOf(BuddyNormalizer);
    const n = NORMALIZER_FACTORIES.workbuddy!();
    const r = n.apply(buddyEvents(main.lines, { origin: 'workbuddy' })[1]!, PROJECT);
    expect(r.changes.find((c) => c.type === 'session_upserted')).toMatchObject({ session: { origin: 'workbuddy' } });
  });

  test('holds no tool input', () => {
    const n = new BuddyNormalizer('codebuddy');
    go(ev, n);
    expect(n.toolInputCount(SID)).toBe(0);
    expect(n.hasSession(SID)).toBe(true);
    expect(n.sessionCount()).toBe(1);
  });
});

describe('records', () => {
  test('every custom record type and session-meta: no node, not unknown', () => {
    const c = new Chain();
    c.prompt('go');
    const env = { id: 'x-1', parentId: c.tip ?? undefined, timestamp: c.now(), sessionId: SID, cwd: CWD };
    const f = go(buddyEvents([...c.lines, ...everyCustomLine(env)]));
    expect(f.unknown).toEqual([]);
    expect(Object.keys(f.graph.nodes)).toHaveLength(1);
  });

  test('SDK item types no reader handles, other types and bad lines are counted; the rest goes on', () => {
    const c = new Chain();
    c.prompt('go');
    const env = { id: 'z', parentId: c.tip ?? undefined, timestamp: c.now(), sessionId: SID, cwd: CWD };
    const lines = [...c.lines, record('hosted_tool_call', env), record('computer_call', env), record('computer_call_result', env), record('unknown', env), record('brand-new', env), '{not json', '[1,2]', JSON.stringify({ id: 'q' })];
    c.at('z').reply('after', 'resp-9');
    const f = go(buddyEvents([...lines, c.lines[c.lines.length - 1]!]));
    expect(f.unknown).toEqual([
      'codebuddy:hosted_tool_call',
      'codebuddy:computer_call',
      'codebuddy:computer_call_result',
      'codebuddy:unknown',
      'codebuddy:brand-new',
      'codebuddy:invalid-json',
      'codebuddy:not-an-object',
      'codebuddy:?',
    ]);
    expect(Object.values(f.graph.nodes).map((n) => n.kind)).toEqual(['prompt', 'text']);
  });

  test('user messages: only human text is a prompt; a message that is entirely injected makes no node', () => {
    const c = new Chain();
    c.prompt('real prompt');
    c.user([inputText(wrapped('ignored', 'additional-data').replace(/<user_query>.*<\/user_query>/, ''))], { conversationRequestId: 'req-1' });
    c.user('meta reminder', { isMeta: true });
    c.user('placeholder', { skipRun: true });
    c.user('attached', { isAdditionalData: true });
    c.user('compact trigger', { isCompactInternal: true });
    c.user('from compact agent', { agent: 'compact' });
    c.user('team note', { teammateMessage: { from: 'bob' } });
    c.user([inputText('<local-command-stdout>ok</local-command-stdout>')], {});
    c.user([inputText('<system-reminder data-role="current-context">ctx</system-reminder>')], {});
    c.prompt('second, bare', { bare: true });
    const ev = buddyEvents(c.lines);
    const f = go(ev);
    expect(f.unknown).toEqual([]);
    expect(Object.values(f.graph.nodes).map((n) => [n.kind, n.summary])).toEqual([
      ['prompt', 'real prompt'],
      ['prompt', 'second, bare'],
    ]);
  });

  test('a user message with string content; a session title-less session takes its first prompt', () => {
    const f = go(buddyEvents([userMessageString(wrapped('string content prompt'), { id: 'u', timestamp: 1, sessionId: SID, cwd: CWD })]));
    expect(Object.values(f.graph.nodes)[0]).toMatchObject({ kind: 'prompt', summary: 'string content prompt' });
    expect(f.session?.title).toBe('string content prompt');
  });

  test('the compaction boundary is a Compact system node; nodes before it stay', () => {
    const c = new Chain();
    c.prompt('long task');
    c.reply('working', 'resp-1');
    c.compactBoundary('the story so far');
    c.reply('continuing', 'resp-2');
    const ev = buddyEvents(c.lines);
    const f = go(ev);
    expect(Object.values(f.graph.nodes).map((n) => n.kind)).toEqual(['prompt', 'text', 'system', 'text']);
    expect(nodeOf(f, nodeAt(ev, 2))).toMatchObject({ kind: 'system', title: 'Compact', systemSubtype: 'compact', summary: '<cb_summary>the story so far</cb_summary>', parentId: nodeAt(ev, 1) });
    expect(f.details.get(nodeAt(ev, 2))).toEqual({ text: '<cb_summary>the story so far</cb_summary>' });
  });

  test('system messages: the /clear separator is a Clear node, any other a System node', () => {
    const c = new Chain();
    c.prompt('a');
    c.system('', { isSessionSeparator: true });
    c.system('You are a helpful agent.');
    const ev = buddyEvents(c.lines);
    const f = go(ev);
    expect(nodeOf(f, nodeAt(ev, 1))).toMatchObject({ kind: 'system', title: 'Clear', systemSubtype: 'clear' });
    expect(nodeOf(f, nodeAt(ev, 2))).toMatchObject({ kind: 'system', title: 'System', systemSubtype: null, summary: 'You are a helpful agent.' });
  });

  test('reasoning text: rawContent first, else content; empty reasoning makes no node', () => {
    const env = (id: string) => ({ id, timestamp: 1, sessionId: SID, cwd: CWD, providerData: { messageId: `m-${id}` } });
    const ev = buddyEvents([
      reasoningItem({ raw: ['raw one', ' raw two'], summary: ['summary'] }, env('r1')),
      reasoningItem({ raw: [], summary: ['only the summary'] }, env('r2')),
      reasoningItem({ summary: ['no rawContent key'] }, env('r3')),
      reasoningItem({ raw: [], summary: [] }, env('r4')),
    ]);
    const f = go(ev);
    expect(Object.values(f.graph.nodes).map((n) => [n.kind, n.summary])).toEqual([
      ['thinking', 'raw one raw two'],
      ['thinking', 'only the summary'],
      ['thinking', 'no rawContent key'],
    ]);
    expect(f.details.get(nodeAt(ev, 0))?.text).toBe('raw one raw two');
  });

  test('assistant text: output_text parts joined; a string content too; an empty reply makes no node', () => {
    const env = (id: string) => ({ id, timestamp: 1, sessionId: SID, cwd: CWD, providerData: { messageId: `m-${id}` } });
    const ev = buddyEvents([
      assistantMessage([{ type: 'output_text', text: 'one ' }, { type: 'output_text', text: 'two' }], env('a')),
      record('message', { ...env('b'), status: 'completed' }, { content: 'plain string' }, 'assistant'),
      assistantMessage([], env('c')),
    ]);
    const f = go(ev);
    expect(Object.values(f.graph.nodes).map((n) => n.summary)).toEqual(['one two', 'plain string']);
  });
});

describe('tool calls and results (format reference 3.5, 3.6, 5)', () => {
  const run = (build: (c: Chain) => void) => {
    const c = new Chain();
    c.prompt('go');
    build(c);
    const ev = buddyEvents(c.lines);
    return { ev, f: go(ev) };
  };

  test('result shapes: string, {type: text}, parts, other objects, the toolResult copy when there is no output', () => {
    const { ev, f } = run((c) => {
      for (const [k, out] of [
        ['a', 'plain'],
        ['b', { type: 'text', text: 'typed' }],
        ['c', [inputText('part 1'), { type: 'input_image', image: 'data:x' }, { type: 'image_blob_ref', blob_id: 'b' }, { type: 'input_file', filename: 'f' }, inputText('part 2')]],
        ['d', { content: 'from content' }],
        ['e', undefined],
      ] as const) {
        c.call('Bash', `call_${k}`, { command: k }, `resp-${k}`);
        c.result('Bash', `call_${k}`, out, `resp-${k}`, k === 'e' ? { pd: { toolResult: { content: 'from toolResult' } } } : {});
      }
    });
    const outs = [1, 3, 5, 7, 9].map((i) => f.details.get(nodeAt(ev, i))?.output);
    expect(outs).toEqual(['plain', 'typed', 'part 1\n[image]\n[image]\n[file]\npart 2', 'from content', 'from toolResult']);
  });

  test('status: incomplete, an error on the result or its toolResult fail the call; function_call_output is a result', () => {
    const { ev, f } = run((c) => {
      c.call('Bash', 'c1', { command: 'a' }, 'r1');
      c.result('Bash', 'c1', 'boom', 'r1', { status: 'incomplete' });
      c.call('Bash', 'c2', { command: 'b' }, 'r2');
      c.result('Bash', 'c2', 'x', 'r2', { pd: { toolResult: { error: 'denied' } } });
      c.call('Bash', 'c3', { command: 'c' }, 'r3');
      c.result('Bash', 'c3', 'x', 'r3', { pd: { error: { message: 'failed' } } });
      c.call('Bash', 'c4', { command: 'd' }, 'r4');
      c.result('Bash', 'c4', 'legacy ok', 'r4', { legacy: true });
    });
    expect([1, 3, 5, 7].map((i) => nodeOf(f, nodeAt(ev, i)).status)).toEqual(['failed', 'failed', 'failed', 'succeeded']);
    expect(f.details.get(nodeAt(ev, 7))?.output).toBe('legacy ok');
  });

  test('pairing: the nearest preceding call of the callId without a result; parallel results in any order; a reused callId is another call', () => {
    const { ev, f } = run((c) => {
      c.call('Read', 'x', { file_path: 'a' }, 'r1'); // 1
      c.call('Read', 'y', { file_path: 'b' }, 'r1'); // 2
      c.result('Read', 'y', 'B', 'r1'); // 3
      c.result('Read', 'x', 'A', 'r1'); // 4
      c.call('Read', 'x', { file_path: 'c' }, 'r2'); // 5 reuses x
      c.call('Read', 'x', { file_path: 'd' }, 'r2'); // 6 and again
      c.result('Read', 'x', 'D', 'r2'); // 7 → 6
      c.result('Read', 'x', 'C', 'r2'); // 8 → 5
    });
    expect([1, 2, 5, 6].map((i) => f.details.get(nodeAt(ev, i))?.output)).toEqual(['A', 'B', 'C', 'D']);
    expect(Object.values(f.graph.nodes).filter((n) => n.kind === 'tool')).toHaveLength(4);
  });

  test('an orphan result is dropped and counted; a call without a result stays running; a truncated or aborted draft fails', () => {
    const { ev, f } = run((c) => {
      c.result('Bash', 'nobody', 'lost', 'r0'); // 1
      c.call('Bash', 'open', { command: 'sleep' }, 'r1'); // 2
      c.call('Write', 'cut', '{"file_path": "a.ts", "content": "unterminated', 'r2', { pd: { codebuddyArgumentsTruncated: true } }); // 3
      c.call('Bash', 'gone', { command: 'x' }, 'r3', { pd: { isPartialAborted: true } }); // 4
      c.call('Bash', 'thrown', { command: 'y' }, 'r4', { pd: { discard: true } }); // 5
    });
    expect(f.unknown).toEqual(['codebuddy:orphan-result']);
    expect(f.graph.nodes[nodeAt(ev, 1)]).toBeUndefined();
    expect(nodeOf(f, nodeAt(ev, 2))).toMatchObject({ status: 'running', endedAt: null });
    for (const i of [3, 4, 5]) expect(nodeOf(f, nodeAt(ev, i))).toMatchObject({ status: 'failed', endedAt: isoOf(tsOf(ev[i]!.source === 'transcript' ? ev[i]!.line : '')) });
    expect(f.details.get(nodeAt(ev, 3))?.input).toBe('{"file_path": "a.ts", "content": "unterminated');
  });

  test('object arguments are accepted', () => {
    const c = new Chain();
    c.prompt('go');
    const line = functionCallObjectArgs('Edit', 'e1', { file_path: '/abs/x.ts', old_string: 'a', new_string: 'b' }, { id: 'f1', parentId: c.tip!, timestamp: c.now(), sessionId: SID, cwd: CWD, providerData: { messageId: 'm' } });
    const ev = buddyEvents([...c.lines, line]);
    const f = go(ev);
    expect(nodeOf(f, nodeAt(ev, 1))).toMatchObject({ toolName: 'Edit', files: [{ path: '/abs/x.ts', action: 'edit' }] });
  });
});

describe('titles and models', () => {
  const env = (id: string) => ({ id, timestamp: 5, sessionId: SID, cwd: CWD });
  const withTitles = (lines: string[]) => {
    const c = new Chain();
    c.prompt('the first prompt');
    return go(buddyEvents([...c.lines, ...lines])).session?.title;
  };

  test('custom-title > ai-title > topic > the first prompt; the latest of each; an empty custom title does not count', () => {
    expect(withTitles([])).toBe('the first prompt');
    expect(withTitles([topicRecord('old topic', env('t1')), topicRecord('newer topic', env('t2'))])).toBe('newer topic');
    expect(withTitles([aiTitle('ai one', env('a1')), topicRecord('topic', env('t1')), aiTitle('ai two', env('a2'))])).toBe('ai two');
    expect(withTitles([customTitle('mine', env('c1')), aiTitle('ai', env('a1')), topicRecord('topic', env('t'))])).toBe('mine');
    expect(withTitles([customTitle('mine', env('c1')), customTitle('', env('c2'))])).toBe('mine');
    expect(withTitles([customTitle('', env('c2')), aiTitle('ai', env('a1'))])).toBe('ai');
  });

  test('model auto is replaced by a concrete model of the session, earlier or later; requestModelId when model is auto', () => {
    const c = new Chain();
    c.prompt('go');
    c.reply('first', 'r1', { pd: { model: 'auto', requestModelId: 'auto' } });
    c.reply('second', 'r2', { pd: { model: 'auto', requestModelId: 'kimi-k3' } });
    c.reply('third', 'r3', { pd: { model: 'deepseek-v4', requestModelId: 'auto' } });
    c.reply('fourth', 'r4', { pd: { model: 'auto', requestModelId: 'auto' } });
    const ev = buddyEvents(c.lines);
    const f = go(ev);
    expect([1, 2, 3, 4].map((i) => f.details.get(nodeAt(ev, i))?.raw)).toEqual([{ model: 'kimi-k3' }, { model: 'kimi-k3' }, { model: 'deepseek-v4' }, { model: 'kimi-k3' }]);
    const only = new Chain();
    only.prompt('go');
    only.reply('x', 'r1', { pd: { model: 'auto', requestModelId: 'auto' } });
    const oev = buddyEvents(only.lines);
    expect(go(oev).details.get(nodeAt(oev, 1))?.raw).toEqual({ model: 'auto' });
  });
});

describe('turns', () => {
  test('without conversationRequestId: one turn per prompt; a queued prompt stays in the running turn', () => {
    const c = new Chain({ requestIds: false });
    c.prompt('one');
    c.reply('a', 'r1');
    c.user(wrapped('also this'), { startsNewUserRequest: false });
    c.reply('b', 'r2');
    c.prompt('two');
    c.reply('c', 'r3');
    const ev = buddyEvents(c.lines);
    const f = go(ev);
    expect([0, 1, 2, 3, 4, 5].map((i) => nodeOf(f, nodeAt(ev, i)).turnId)).toEqual([0, 0, 0, 0, 4, 4].map((i) => nodeAt(ev, i)));
    expect(nodeOf(f, nodeAt(ev, 2))).toMatchObject({ kind: 'prompt', summary: 'also this' });
  });

  test('with conversationRequestId: a request without a prompt node (a meta trigger) is a turn of its own; a queued prompt with another id stays', () => {
    const c = new Chain();
    c.prompt('one'); // 0 req-1
    c.reply('a', 'r1'); // 1
    c.user(wrapped('queued'), { startsNewUserRequest: false, conversationRequestId: 'req-q' }); // 2
    c.reply('b', 'r2'); // 3 req-1
    c.user('cron fired', { isMeta: true, conversationRequestId: 'req-cron' }); // 4 hidden
    c.request = 'req-cron';
    c.think(['scheduled work'], 'r3'); // 5
    c.reply('done', 'r3'); // 6
    const ev = buddyEvents(c.lines);
    const f = go(ev);
    expect([0, 1, 2, 3, 5, 6].map((i) => nodeOf(f, nodeAt(ev, i)).turnId)).toEqual([0, 0, 0, 0, 5, 5].map((i) => nodeAt(ev, i)));
    expect(f.graph.nodes[nodeAt(ev, 4)]).toBeUndefined();
  });

  test('a prompt without a request id adopts the id its outputs carry', () => {
    const c = new Chain();
    c.user(wrapped('old-style prompt'), {}); // 0: no conversationRequestId
    c.request = 'req-late';
    c.reply('a', 'r1'); // 1
    c.prompt('next'); // 2
    c.reply('b', 'r2'); // 3
    const ev = buddyEvents(c.lines);
    const f = go(ev);
    expect([0, 1, 2, 3].map((i) => nodeOf(f, nodeAt(ev, i)).turnId)).toEqual([0, 0, 2, 2].map((i) => nodeAt(ev, i)));
  });
});

describe('usage (spec 4.5, section 10 items 2-4)', () => {
  test('one usage per messageId, the largest, on the first displayed node of the response', () => {
    const c = new Chain();
    c.prompt('go'); // 0
    c.think(['plan'], 'r1'); // 1: first node of r1, no usage of its own
    c.call('Bash', 'k1', { command: 'a' }, 'r1', { usage: openaiUsage(1000, 10, 100) }); // 2
    c.reply('narration', 'r1', { usage: openaiUsage(1000, 20, 100) }); // 3: larger
    c.call('Bash', 'k2', { command: 'b' }, 'r1', { usage: openaiUsage(1000, 5, 100) }); // 4: smaller
    c.result('Bash', 'k1', 'ok', 'r1');
    c.result('Bash', 'k2', 'ok', 'r1');
    const ev = buddyEvents(c.lines);
    const f = go(ev);
    expect([1, 2, 3, 4].map((i) => nodeOf(f, nodeAt(ev, i)).usage)).toEqual([usage(900, 100, 20), null, null, null]);
  });

  test('providerData.usage and the message.usage mirror are read when there is no rawUsage', () => {
    const c = new Chain();
    c.prompt('go');
    const base = { timestamp: c.now(), sessionId: SID, cwd: CWD };
    const ev = buddyEvents([
      ...c.lines,
      assistantMessage('a', { ...base, id: 'a1', parentId: c.tip!, providerData: { messageId: 'm1', usage: { inputTokens: 300, outputTokens: 5, inputTokensDetails: [{ cached_tokens: 200 }] } } }),
      assistantMessage('b', { ...base, id: 'a2', parentId: 'a1', providerData: { messageId: 'm2' }, extra: { message: { usage: { input_tokens: 50, output_tokens: 2, total_tokens: 52, cache_read_input_tokens: 30 } } } }),
    ]);
    const f = go(ev);
    expect(nodeOf(f, nodeAt(ev, 1)).usage).toEqual(usage(100, 200, 5));
    expect(nodeOf(f, nodeAt(ev, 2)).usage).toEqual(usage(20, 30, 2));
  });

  test('model-usage raises the response it names; one with no displayed node is added to the nearest preceding node (its response holder)', () => {
    const c = new Chain();
    c.prompt('go'); // 0
    c.reply('a', 'r1', { usage: openaiUsage(100, 10) }); // 1
    c.fact((env) => modelUsage('r1', openaiUsage(200, 20), env)); // 2: raises r1
    c.call('Bash', 'k', { command: 'x' }, 'r2', { usage: openaiUsage(50, 5) }); // 3
    c.reply('b', 'r2'); // 4: second node of r2
    c.fact((env) => modelUsage('r-lost', openaiUsage(1000, 1, 400), env)); // 5: no node → nearest preceding is 4 (r2), held by 3
    c.fact((env) => modelUsage('r1', openaiUsage(150, 1), env)); // 6: smaller than r1's best: nothing
    const ev = buddyEvents(c.lines);
    const f = go(ev);
    expect(nodeOf(f, nodeAt(ev, 1)).usage).toEqual(usage(200, 0, 20));
    expect(nodeOf(f, nodeAt(ev, 3)).usage).toEqual(usage(50 + 600, 400, 5 + 1));
    expect(nodeOf(f, nodeAt(ev, 4)).usage).toBeNull();
    expect(f.unknown).toEqual([]);
  });

  test('without messageId each usage record counts once: on its own node, a bare model-usage on the preceding node', () => {
    const c = new Chain();
    c.prompt('go'); // 0
    c.reply('a', null, { usage: openaiUsage(100, 10) }); // 1
    c.reply('b', null, { usage: openaiUsage(100, 10) }); // 2
    c.fact((env) => modelUsage(null, openaiUsage(7, 1), env)); // 3
    c.fact((env) => modelUsage(null, openaiUsage(3, 1), env)); // 4
    const ev = buddyEvents(c.lines);
    const f = go(ev);
    expect(nodeOf(f, nodeAt(ev, 1)).usage).toEqual(usage(100, 0, 10));
    expect(nodeOf(f, nodeAt(ev, 2)).usage).toEqual(usage(110, 0, 12));
  });

  test('a model-usage line before any node counts nowhere; a later node of its response takes it over', () => {
    const c = new Chain();
    c.fact((env) => modelUsage('r1', openaiUsage(80, 8), env), { parentId: null }); // 0
    c.prompt('go'); // 1
    c.reply('a', 'r1'); // 2: r1's node arrives later
    const ev = buddyEvents(c.lines);
    const f = go(ev);
    expect(nodeOf(f, nodeAt(ev, 2)).usage).toEqual(usage(80, 0, 8));
    expect(nodeOf(f, nodeAt(ev, 1)).usage).toBeNull();
  });
});

describe('the active branch (spec 4.4)', () => {
  test('a rewind arriving mid-append removes the abandoned nodes (and their usage); the conversation continues from the head', () => {
    const c = new Chain();
    c.prompt('one'); // 0
    const a1 = c.peekId();
    c.reply('a1', 'r1', { usage: openaiUsage(10, 1) }); // 1
    c.prompt('two'); // 2
    c.reply('a2', 'r2', { usage: openaiUsage(20, 2) }); // 3
    c.call('Bash', 'k', { command: 'x' }, 'r3'); // 4
    c.rewind(a1); // 5
    const cut = c.lines.length;
    c.prompt('two, again'); // 6
    c.reply('a3', 'r4'); // 7
    const ev = buddyEvents(c.lines);
    const before = go(ev.slice(0, cut - 1));
    expect(Object.keys(before.graph.nodes)).toHaveLength(5);
    const n = new BuddyNormalizer('codebuddy');
    go(ev.slice(0, cut - 1), n);
    const rewind = n.apply(ev[cut - 1]!, PROJECT).changes;
    expect(rewind.filter((x) => x.type === 'node_removed').map((x) => (x as { id: string }).id)).toEqual([2, 3, 4].map((i) => nodeAt(ev, i)));
    const f = go(ev);
    const shown = [0, 1, 6, 7].map((i) => nodeAt(ev, i));
    expect(Object.keys(f.graph.nodes)).toEqual(shown);
    expect(edgeIds(f)).toEqual(chainEdges(shown));
    expect(nodeOf(f, nodeAt(ev, 6))).toMatchObject({ parentId: nodeAt(ev, 1), turnId: nodeAt(ev, 6) });
    expect(Object.values(f.graph.nodes).filter((x) => x.usage !== null)).toHaveLength(1);
  });

  test('edit and resend: the edited prompt goes, the resent one is its sibling', () => {
    const c = new Chain();
    c.prompt('one'); // 0
    const a1 = c.peekId();
    c.reply('a1', 'r1'); // 1
    c.prompt('typo'); // 2
    c.reply('a2', 'r2'); // 3
    c.rewind(a1); // 4
    c.prompt('fixed'); // 5
    c.reply('a3', 'r3'); // 6
    const ev = buddyEvents(c.lines);
    const f = go(ev);
    expect(Object.values(f.graph.nodes).map((x) => x.summary)).toEqual(['one', 'a1', 'fixed', 'a3']);
  });

  test('a content-filter notice forks off the filtered output', () => {
    const c = new Chain();
    const u = c.peekId();
    c.prompt('question'); // 0
    c.think(['thinking'], 'r1'); // 1
    c.reply('filtered answer', 'r1', { usage: openaiUsage(10, 1) }); // 2
    c.at(u).reply('This response was filtered.', null, { pd: { contentFilterNotice: true, strippedUserMessageId: u, skipRun: true } }); // 3
    const ev = buddyEvents(c.lines);
    const f = go(ev);
    expect(Object.keys(f.graph.nodes)).toEqual([0, 3].map((i) => nodeAt(ev, i)));
    expect(nodeOf(f, nodeAt(ev, 3)).parentId).toBe(nodeAt(ev, 0));
    expect(edgeIds(f)).toEqual(chainEdges([0, 3].map((i) => nodeAt(ev, i))));
  });

  test('compaction then a rewind after it: everything before the boundary stays', () => {
    const c = new Chain();
    c.prompt('one'); // 0
    c.reply('a1', 'r1'); // 1
    c.compactBoundary('summary'); // 2
    c.prompt('two'); // 3
    const a2 = c.peekId();
    c.reply('a2', 'r2'); // 4
    c.reply('a3', 'r3'); // 5
    c.rewind(a2); // 6
    const ev = buddyEvents(c.lines);
    const f = go(ev);
    expect(Object.keys(f.graph.nodes)).toEqual([0, 1, 2, 3, 4].map((i) => nodeAt(ev, i)));
  });

  test('a tombstone that keeps the current branch changes nothing (the incremental state equals a full walk)', () => {
    const c = new Chain();
    c.prompt('one');
    const a1 = c.peekId();
    c.reply('a1', 'r1', { usage: openaiUsage(10, 1) });
    c.call('Bash', 'k', { command: 'x' }, 'r2', { usage: openaiUsage(5, 1) });
    c.result('Bash', 'k', 'ok', 'r2');
    c.rewind(a1);
    c.prompt('two');
    c.think(['t'], 'r3');
    c.call('Read', 'k', { file_path: 'a' }, 'r3', { usage: openaiUsage(30, 3) });
    c.fact((env) => modelUsage('r-x', openaiUsage(4, 4), env));
    c.result('Read', 'k', 'A', 'r3');
    c.compactBoundary('s');
    c.reply('after', 'r4', { usage: openaiUsage(7, 7) });
    const ev = buddyEvents(c.lines);
    const n = new BuddyNormalizer('codebuddy');
    go(ev, n);
    const noop = buddyEvents([...c.lines, resendForkNotice({ parentId: c.tip!, timestamp: c.now(), sessionId: SID, cwd: CWD })]);
    const r = n.apply(noop[noop.length - 1]!, PROJECT);
    expect(r.changes.filter((x) => x.type !== 'session_upserted')).toEqual([]);
  });

  test('a subagent thread whose dispatch is abandoned is unlinked; the child keeps its nodes', () => {
    const main = exampleMain();
    const child = exampleChild();
    const c = new Chain();
    c.lines.push(...main.lines);
    c.at(main.ids.p2!).rewind(main.ids.p2!);
    const ev = buddyEvents(c.lines);
    const cev = buddyEvents(child.lines, { agentId: CHILD });
    const f = go([...ev, ...cev]);
    expect(nodeOf(f, nodeAt(cev, 1)).parentId).toBeNull();
    expect(Object.values(f.graph.nodes).some((x) => x.kind === 'subagent')).toBe(false);
    expect(comparable(go([...cev, ...ev]))).toEqual(comparable(f));
  });
});

describe('subagents (spec 4.6)', () => {
  test('a thread no result names hangs under the session, unlinked', () => {
    const child = exampleChild();
    const c = new Chain();
    c.prompt('go');
    c.reply('done', 'r1');
    const cev = buddyEvents(child.lines, { agentId: CHILD });
    const f = go([...buddyEvents(c.lines), ...cev]);
    expect(nodeOf(f, nodeAt(cev, 1))).toMatchObject({ agentId: CHILD, parentId: null });
    expect(Object.values(f.graph.edges).some((e) => e.kind === 'spawn')).toBe(false);
  });

  test('a nested subagent hangs off its parent subagent dispatch, in any arrival order', () => {
    const main = exampleMain();
    const c = new Chain({ prefix: 'c', sessionId: 'rt', t0: 1_790_000_030_000 });
    c.user('Review', { isMeta: true });
    c.call('Task', 'call_n', { subagent_type: 'checker' }, 'cr1');
    c.result('Task', 'call_n', 'ok', 'cr1', { pd: { toolResult: { subAgent: { sessionId: GRANDCHILD, descriptor: { role: 'checker' } } } } });
    const g = new Chain({ prefix: 'g', sessionId: 'rt2', t0: 1_790_000_040_000 });
    g.user('Check', { isMeta: true });
    g.reply('checked', 'gr1');
    const ev = buddyEvents(main.lines);
    const cev = buddyEvents(c.lines, { agentId: CHILD });
    const gev = buddyEvents(g.lines, { agentId: GRANDCHILD });
    const f = go([...ev, ...cev, ...gev]);
    expect(nodeOf(f, nodeAt(gev, 1))).toMatchObject({ agentId: GRANDCHILD, parentId: nodeAt(cev, 1) });
    expect(nodeOf(f, nodeAt(cev, 1))).toMatchObject({ kind: 'subagent', childAgentId: GRANDCHILD, title: 'checker', agentId: CHILD });
    for (const order of [
      [...gev, ...cev, ...ev],
      [...cev, ...gev, ...ev],
      [...ev, ...gev, ...cev],
    ]) {
      expect(comparable(go(order))).toEqual(comparable(f));
    }
  });
});

describe('restarts (the file was rewritten)', () => {
  test('a smaller offset resets the thread: stale nodes go, the new content is shown as if read fresh', () => {
    const c = new Chain();
    c.prompt('old one');
    c.reply('old reply', 'r1', { usage: openaiUsage(10, 1) });
    c.call('Bash', 'k', { command: 'x' }, 'r2');
    const d = new Chain({ t0: 1_790_000_500_000 });
    d.prompt('new one');
    d.reply('new reply', 'r9');
    const oldEv = buddyEvents(c.lines);
    const newEv = buddyEvents(d.lines);
    const f = go([...oldEv, ...newEv]);
    expect(comparable(f)).toEqual(comparable(go(newEv)));
    // The same through batches and a rebuild of the stored history.
    expect(comparable(paged([...oldEv, ...newEv], 2))).toEqual(comparable(f));
    expect(comparable(paged([...oldEv, ...newEv], 2, 4))).toEqual(comparable(f));
  });

  test('a restarted child thread keeps its link to the dispatch', () => {
    const main = exampleMain();
    const child = exampleChild();
    const ev = buddyEvents(main.lines);
    const cev = buddyEvents(child.lines, { agentId: CHILD });
    const f = go([...ev, ...cev, ...cev]);
    expect(comparable(f)).toEqual(comparable(go([...ev, ...cev])));
  });
});

describe('determinism against the branch walk (randomised)', () => {
  /** A small seeded PRNG (mulberry32). */
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const CUSTOM = new Set(['resend-fork-notice', 'model-usage', 'ai-title', 'session-meta']);
  const branchLine = (line: string): BranchLine => {
    const r = JSON.parse(line) as Record<string, unknown>;
    const pd = (r.providerData ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
    return {
      id: str(r.id),
      parentId: str(r.parentId),
      logicalParentId: str(r.logicalParentId),
      type: r.type as string,
      custom: CUSTOM.has(r.type as string),
      isCompactAgent: typeof pd.agent === 'string' && pd.agent.toLowerCase() === 'compact',
      contentFilterNotice: pd.contentFilterNotice === true,
      resendForkNotice: r.type === 'resend-fork-notice',
    };
  };

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    test(`seed ${seed}: the nodes shown are the walk's lines, chained in file order; one by one = pages = rebuild`, () => {
      const next = rng(seed);
      const c = new Chain();
      const ids: string[] = [];
      c.prompt('start');
      ids.push(c.tip!);
      for (let k = 0; k < 120; k++) {
        const x = next();
        const pick = () => ids[Math.floor(next() * ids.length)]!;
        if (x < 0.45) c.reply(`r${k}`, `m${k}`, { usage: openaiUsage(10 + k, 1) });
        else if (x < 0.55) c.prompt(`p${k}`);
        else if (x < 0.62) c.rewind(pick());
        else if (x < 0.66) c.at(pick()).reply(`filtered ${k}`, null, { pd: { contentFilterNotice: true } });
        else if (x < 0.72) c.at(pick()).reply(`jump ${k}`, `m${k}`);
        else if (x < 0.76) c.reply(`dup ${k}`, `m${k}`, { id: c.tip ?? undefined }); // same id as the previous entry
        else if (x < 0.79) c.compactBoundary(`s${k}`);
        else if (x < 0.85) c.fact((env) => modelUsage(next() < 0.5 ? `m${k - 1}` : `lost${k}`, openaiUsage(5, 5), env));
        else if (x < 0.9) c.fact((env) => aiTitle(`t${k}`, env));
        else c.reply(`r${k}`, `m${k}`);
        if (c.tip !== null && !ids.includes(c.tip)) ids.push(c.tip);
      }
      const ev = buddyEvents(c.lines);
      const f = go(ev);
      const set = activeBranch(c.lines.map(branchLine));
      const want = c.lines
        .map((line, i) => ({ line, i }))
        .filter(({ line, i }) => !branchLine(line).custom && (set === null || set.has(i)) && branchLine(line).id !== null)
        .map(({ i }) => nodeAt(ev, i));
      expect(Object.keys(f.graph.nodes).sort()).toEqual([...want].sort());
      // Shown nodes are chained in file order.
      const order = ev.map((_, i) => nodeAt(ev, i)).filter((id) => id in f.graph.nodes);
      expect(order.map((id) => f.graph.nodes[id]!.parentId)).toEqual([null, ...order.slice(0, -1)]);
      expect(edgeIds(f)).toEqual(chainEdges(order));
      // A node with usage per messageId at most.
      const seen = new Set<string>();
      for (const n of Object.values(f.graph.nodes)) {
        if (n.usage === null || n.messageId === null) continue;
        expect(seen.has(n.messageId)).toBe(false);
        seen.add(n.messageId);
      }
      expect(comparable(paged(ev, 7))).toEqual(comparable(f));
      expect(comparable(paged(ev, 5, Math.floor(ev.length / 2)))).toEqual(comparable(f));
    });
  }
});

describe('buddyTouches (conservative table, tool and argument names unverified)', () => {
  test('file tools by name, path arguments tried in order, JSON-string arguments parsed', () => {
    expect(buddyTouches('Read', { file_path: 'a.ts' })).toEqual([{ path: 'a.ts', action: 'read' }]);
    expect(buddyTouches('read_file', { path: 'b.ts' })).toEqual([{ path: 'b.ts', action: 'read' }]);
    expect(buddyTouches('Write', '{"file_path":"c.ts","content":"x"}')).toEqual([{ path: 'c.ts', action: 'write' }]);
    expect(buddyTouches('write_to_file', { filePath: 'd.ts' })).toEqual([{ path: 'd.ts', action: 'write' }]);
    expect(buddyTouches('Edit', { file_path: 'e.ts' })).toEqual([{ path: 'e.ts', action: 'edit' }]);
    expect(buddyTouches('MultiEdit', { file_path: 'f.ts' })).toEqual([{ path: 'f.ts', action: 'edit' }]);
    expect(buddyTouches('replace_in_file', { target_file: 'g.ts' })).toEqual([{ path: 'g.ts', action: 'edit' }]);
    expect(buddyTouches('NotebookEdit', { notebook_path: 'h.ipynb' })).toEqual([{ path: 'h.ipynb', action: 'edit' }]);
    expect(buddyTouches('delete_file', { file: 'i.ts' })).toEqual([{ path: 'i.ts', action: 'delete' }]);
    expect(buddyTouches('Read', { file_path: 'first', path: 'second' })).toEqual([{ path: 'first', action: 'read' }]);
  });

  test('shell, search, subagent and unknown tools name no file; bad arguments name none', () => {
    expect(buddyTouches('Bash', { command: 'cat a.ts' })).toEqual([]);
    expect(buddyTouches('Grep', { pattern: 'x', path: 'src' })).toEqual([]);
    expect(buddyTouches('Task', { prompt: 'read a.ts' })).toEqual([]);
    expect(buddyTouches('Read', '{broken')).toEqual([]);
    expect(buddyTouches('Read', null)).toEqual([]);
    expect(buddyTouches('Read', { file_path: '  ' })).toEqual([]);
  });
});

describe('the user message builder', () => {
  test('a user message with several parts keeps only the query', () => {
    const f = go(buddyEvents([userMessage([inputText('<system-reminder data-role="user-context">x</system-reminder>'), inputText('<user_query>the ask</user_query>')], { id: 'u', timestamp: 1, sessionId: SID, cwd: CWD })]));
    expect(Object.values(f.graph.nodes).map((n) => n.summary)).toEqual(['the ask']);
  });
});
