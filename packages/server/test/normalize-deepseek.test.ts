import { describe, expect, test } from 'vitest';
import { applyChanges, emptyGraph, usageTotal, type Change, type Graph, type GraphNode, type Session } from '@agent-canvas/shared';
import { deepseekNodeId, DeepSeekNormalizer } from '../src/normalize/deepseek.js';
import { deepseekTouches } from '../src/normalize/files.js';
import { NORMALIZER_FACTORIES } from '../src/normalize/registry.js';
import type { RawEvent } from '../src/store/store.js';
import {
  callBlock,
  CHILD,
  CWD,
  DshLog,
  dshEvents,
  exampleChild,
  exampleGrandchild,
  exampleMain,
  GRANDCHILD,
  headerLine,
  isoOf,
  PROJECT,
  reasoningBlock,
  SID,
  T0,
  textBlock,
  timeOf,
} from './deepseek-fixtures.js';

interface Folded {
  graph: Graph;
  details: Map<string, Record<string, unknown>>;
  sessions: Map<string, Session>;
  session: Session | undefined;
  unknown: string[];
  changes: Change[];
}

/** Folds changes as the store does: graph, merged details (dropped with their node), the last session row of each id. */
function fold(changes: Change[], unknown: string[] = [], sid = SID): Folded {
  const details = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, Session>();
  for (const c of changes) {
    if (c.type === 'node_added') details.set(c.node.id, { ...c.detail });
    else if (c.type === 'node_updated' && c.detail !== undefined && details.has(c.id)) details.set(c.id, { ...details.get(c.id), ...c.detail });
    else if (c.type === 'node_removed') details.delete(c.id);
    else if (c.type === 'session_upserted') sessions.set(c.session.id, c.session);
  }
  return { graph: applyChanges(emptyGraph(), changes), details, sessions, session: sessions.get(sid), unknown, changes };
}

const projectOf = (ev: RawEvent): string => (ev.source === 'transcript' && ev.projectId != null ? ev.projectId : 'unknown');

/** One event at a time through apply. */
function go(events: RawEvent[], n = new DeepSeekNormalizer(), sid = SID): Folded {
  const changes: Change[] = [];
  const unknown: string[] = [];
  for (const ev of events) {
    const r = n.apply(ev, projectOf(ev));
    changes.push(...r.changes);
    if (r.unknownRecordType !== undefined) unknown.push(r.unknownRecordType);
  }
  return fold(changes, unknown, sid);
}

/** In batches of `page` through applyBatch; with `cut`, the session is dropped and re-hydrated there. */
function paged(events: RawEvent[], page: number, cut?: number): Folded {
  const n = new DeepSeekNormalizer();
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

const nid = (part: string, agent: string | null = null, sid = SID): string => deepseekNodeId(sid, agent, part);
/** The node made by the row with `seq` (offset seq + 1); `k`: the block index inside an assistant message. */
const at = (seq: number, k?: number, agent: string | null = null): string => nid(k === undefined ? `@${seq + 1}` : `@${seq + 1}.${k}`, agent);
const call = (turn: number, step: number, id: string, agent: string | null = null): string => nid(`call:${turn}.${step}.${id}`, agent);
const nodeOf = (f: Folded, id: string): GraphNode => {
  const n = f.graph.nodes[id];
  if (n === undefined) throw new Error(`no node ${id}; have ${Object.keys(f.graph.nodes).join(', ')}`);
  return n;
};

const main = exampleMain();
const child = exampleChild();
const grand = exampleGrandchild();
const mainEvents = (): RawEvent[] => dshEvents(main.header, main.lines);
const childEvents = (): RawEvent[] => dshEvents(child.header, child.lines, { agentId: CHILD });
const grandEvents = (): RawEvent[] => dshEvents(grand.header, grand.lines, { agentId: GRANDCHILD });

describe('the example session (spec 3.3 table)', () => {
  const f = go(mainEvents());
  const P1 = at(3);
  const THINK = at(6, 0);
  const TEXT1 = at(6, 1);
  const A1 = call(1, 1, 'call_00_a');
  const A2 = call(1, 2, 'call_00_a');
  const TEXT2 = at(17, 0);
  const COMPACT = at(24);
  const P2 = at(27);
  const SUB = call(2, 1, 'call_00_s');
  const EXT = call(2, 1, 'call_01_e');
  const INT = at(37);

  test('nodes in order; injected messages, the inbox splice, request headers, compaction brackets and brackets add nothing and are not unknown', () => {
    expect(f.unknown).toEqual([]);
    expect(Object.keys(f.graph.nodes)).toEqual([P1, THINK, TEXT1, A1, A2, TEXT2, COMPACT, P2, SUB, EXT, INT]);
    expect(Object.keys(f.graph.edges)).toHaveLength(10);
    expect(Object.values(f.graph.edges).every((e) => e.kind === 'sequence')).toBe(true);
  });

  test('a human prompt (source.kind user) opens the turn', () => {
    expect(nodeOf(f, P1)).toMatchObject({ kind: 'prompt', title: 'Prompt', parentId: null, turnId: P1, agentId: null, timestamp: isoOf(timeOf(3)), summary: 'Fix the failing test' });
    expect(f.details.get(P1)).toEqual({ text: 'Fix the failing test' });
  });

  test('reasoning, text and tool-call blocks: thinking, text and tool nodes in model order, with the message id; usage and model on the text', () => {
    expect(nodeOf(f, THINK)).toMatchObject({ kind: 'thinking', title: 'Thinking', parentId: P1, turnId: P1, messageId: 'msg-1', usage: null, summary: 'I should run the tests first.' });
    expect(f.details.get(THINK)).toEqual({ text: 'I should run the tests first.' });
    expect(nodeOf(f, TEXT1)).toMatchObject({ kind: 'text', title: 'Text', parentId: THINK, messageId: 'msg-1', usage: { inputTokens: 145, cachedInputTokens: 1664, outputTokens: 124 } });
    expect(f.details.get(TEXT1)).toEqual({ text: 'Running the tests.', raw: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } });
  });

  test('a tool-call block and its tool/call are one node; tool/result pairs by callId within the step', () => {
    expect(nodeOf(f, A1)).toMatchObject({
      kind: 'tool',
      title: 'bash',
      toolName: 'bash',
      toolUseId: 'call_00_a',
      status: 'succeeded',
      parentId: TEXT1,
      turnId: P1,
      messageId: 'msg-1',
      usage: null,
      summary: 'npm test',
      timestamp: isoOf(timeOf(6)),
      endedAt: isoOf(timeOf(8)),
      durationMs: 2000,
    });
    expect(nodeOf(f, A1).inputKey).toMatch(/^[0-9a-f]{16}$/);
    expect(f.details.get(A1)).toEqual({ input: { command: 'npm test' }, output: '1 failed\n' });
  });

  test('the same callId in another step is another node; an isError result fails it; usage of a message without text goes on its first tool node', () => {
    expect(nodeOf(f, A2)).toMatchObject({ kind: 'tool', toolName: 'read_file', toolUseId: 'call_00_a', status: 'failed', parentId: A1, messageId: 'msg-2', usage: { inputTokens: 50, cachedInputTokens: 1800, outputTokens: 10 } });
    expect(nodeOf(f, A2).files).toEqual([{ path: 'D:/Projects/Demo/src/parser.ts', action: 'read' }]);
    expect(f.details.get(A2)).toMatchObject({ input: { path: 'src/parser.ts' }, output: 'no such file', raw: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } });
    expect(nodeOf(f, TEXT2)).toMatchObject({ kind: 'text', turnId: P1, messageId: 'msg-3', usage: { inputTokens: 20, cachedInputTokens: 1900, outputTokens: 30 } });
  });

  test('the compaction checkpoint is a system node outside any turn; earlier nodes stay', () => {
    expect(nodeOf(f, COMPACT)).toMatchObject({ kind: 'system', title: 'Compact', systemSubtype: 'compact', turnId: null, parentId: TEXT2, status: null });
    expect(f.details.get(COMPACT)).toEqual({ text: 'This is an automatically generated checkpoint of the conversation so far.' });
  });

  test('subagent dispatches: subagent nodes titled by the catalog label; an external one has no thread', () => {
    expect(nodeOf(f, P2)).toMatchObject({ kind: 'prompt', turnId: P2, parentId: COMPACT });
    expect(nodeOf(f, SUB)).toMatchObject({ kind: 'subagent', title: 'parser check', toolName: 'subagent', status: 'succeeded', childAgentId: null, turnId: P2, usage: { inputTokens: 100, cachedInputTokens: 1000, outputTokens: 20 } });
    expect(nodeOf(f, EXT)).toMatchObject({ kind: 'subagent', title: 'codex', status: 'succeeded', childAgentId: null, usage: null });
  });

  test('turn/end aborted: an Interrupted system node ends the turn', () => {
    expect(nodeOf(f, INT)).toMatchObject({ kind: 'system', title: 'Interrupted', systemSubtype: 'interrupt', turnId: P2, parentId: EXT, timestamp: isoOf(timeOf(37)) });
  });

  test('session: id, origin, project, created time from the header; cwd from the last working-directory/change; title from the last session/title', () => {
    expect(f.session).toEqual({
      id: SID,
      projectId: PROJECT,
      origin: 'deepseek',
      cwd: 'D:\\Projects\\Demo\\packages\\api',
      title: 'Fix the parser test',
      gitBranch: null,
      status: 'running',
      sourceDeleted: false,
      startedAt: isoOf(T0),
      lastActivityAt: isoOf(timeOf(37)),
    });
    expect(f.changes.filter((c) => c.type === 'session_upserted').length).toBeGreaterThanOrEqual(1);
  });

  test('one by one = any page size = drop and re-hydrate at any point', () => {
    const events = mainEvents();
    const want = comparable(f);
    for (const page of [1, 2, 3, 7, 100]) expect(comparable(paged(events, page))).toEqual(want);
    for (let cut = 1; cut < events.length; cut++) expect(comparable(paged(events, 3, cut))).toEqual(want);
  });

  test('registered for origin deepseek', () => {
    expect(NORMALIZER_FACTORIES.deepseek?.()).toBeInstanceOf(DeepSeekNormalizer);
  });
});

describe('records', () => {
  const header = headerLine();
  const run = (build: (l: DshLog) => void, opts: { header?: string } = {}): Folded => {
    const l = new DshLog();
    build(l);
    return go(dshEvents(opts.header ?? header, l.lines));
  };

  test('only source.kind user is a prompt; every other kind (retry and unknown kinds included) shows nothing and is not unknown', () => {
    const kinds = ['retry', 'agent-message', 'subagent-settled', 'skill-catalog', 'runtime-context', 'time-context', 'plugin:foo', 'some-future-kind', 'model'];
    const f = run((l) => {
      l.turnStart(1);
      for (const kind of kinds) l.user(`injected ${kind}`, { kind, form: 'notice', summary: 's' });
      l.add('user/message', { id: 'x', role: 'user', content: [textBlock('no source')] });
      l.user('typed by me');
    });
    expect(f.unknown).toEqual([]);
    expect(Object.values(f.graph.nodes).map((n) => [n.kind, f.details.get(n.id)?.text])).toEqual([['prompt', 'typed by me']]);
    expect(f.session?.title).toBe('typed by me');
  });

  test('a header alone makes the session (no nodes); a title-less session takes its first prompt', () => {
    const f = run(() => {});
    expect(f.session).toMatchObject({ id: SID, startedAt: isoOf(T0), cwd: CWD, title: null, projectId: PROJECT });
    expect(Object.keys(f.graph.nodes)).toEqual([]);
    const g = run((l) => {
      l.turnStart(1);
      l.user('  first\n prompt ');
      l.user('second');
    });
    expect(g.session?.title).toBe('first prompt');
  });

  test('session/title: the last one wins, whatever came before', () => {
    const f = run((l) => {
      l.title('A');
      l.turnStart(1);
      l.user('prompt text');
      l.title('B', 'provider');
      l.title('C', 'user');
    });
    expect(f.session?.title).toBe('C');
  });

  test('usage: input = inputTokens + cacheWriteTokens, cached = cacheReadTokens, output = outputTokens (reasoning not added); absent counts are 0', () => {
    const f = run((l) => {
      l.turnStart(1);
      l.user('go');
      l.assistant(1, 1, [textBlock('a')], { id: 'm1', usage: { inputTokens: 7, outputTokens: 11, cacheReadTokens: 13, cacheWriteTokens: 17, reasoningTokens: 19 } });
      l.assistant(1, 2, [textBlock('b')], { id: 'm2', usage: { inputTokens: 3, outputTokens: 4 } });
      l.assistant(1, 3, [textBlock('c')], { id: 'm3', usage: null });
    });
    expect(nodeOf(f, at(2, 0)).usage).toEqual({ inputTokens: 24, cachedInputTokens: 13, outputTokens: 11 });
    expect(nodeOf(f, at(3, 0)).usage).toEqual({ inputTokens: 3, cachedInputTokens: 0, outputTokens: 4 });
    expect(nodeOf(f, at(4, 0)).usage).toBeNull();
    expect(nodeOf(f, at(4, 0)).messageId).toBe('m3');
  });

  test('a prompt\'s and a compaction checkpoint\'s text blocks are joined with a newline (Task 4 review m3)', () => {
    const f = run((l) => {
      l.turnStart(1);
      l.add('user/message', { id: 'u', role: 'user', content: [textBlock('first line'), textBlock('second line')], source: { kind: 'user' } }); // 1
      l.turnEnd(1); // 2
      l.add('user/message', { id: 'k', role: 'user', content: [textBlock('## Summary'), textBlock('- point')], source: { kind: 'compact-checkpoint', compactionId: 'c1' } }); // 3
    });
    expect(f.details.get(at(1))).toEqual({ text: 'first line\nsecond line' });
    expect(nodeOf(f, at(1)).summary).toBe('first line second line');
    expect(f.details.get(at(3))).toEqual({ text: '## Summary\n- point' });
    expect(f.session?.title).toBe('first line second line');
  });

  test('an assistant message that makes no node (image only, empty after an interruption) adds its usage to the nearest preceding node of its thread that may carry it (Task 4 review m1)', () => {
    const build = (l: DshLog): void => {
      l.turnStart(1); // 0
      l.user('go'); // 1
      // No node before it in the thread but the prompt: the prompt carries it (no message id, counted on its own).
      l.assistant(1, 1, [{ type: 'image', attachment: { attachmentId: 'sha256:00' } }], { id: 'm0', usage: { inputTokens: 2, outputTokens: 1 } }); // 2
      // m1: its usage on its text; the thinking after it shares the message id and has no usage.
      l.assistant(1, 2, [textBlock('a'), reasoningBlock('b')], { id: 'm1', usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 100 } }); // 3
      l.assistant(1, 3, [{ type: 'image', attachment: { attachmentId: 'sha256:01' } }], { id: 'm2', usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1 } }); // 4
      l.assistant(1, 4, [textBlock('')], { id: 'm3', usage: { inputTokens: 1, outputTokens: 1 }, interrupted: true }); // 5
      // A message without usage changes nothing.
      l.assistant(1, 5, [textBlock('')], { id: 'm4', usage: null }); // 6
    };
    const l = new DshLog();
    build(l);
    const events = dshEvents(header, l.lines);
    const f = go(events);
    expect(Object.values(f.graph.nodes).map((n) => n.kind)).toEqual(['prompt', 'text', 'thinking']);
    expect(nodeOf(f, at(1)).usage).toEqual({ inputTokens: 2, cachedInputTokens: 0, outputTokens: 1 });
    // The thinking node (message m1, no usage) is passed over: m1's text holds m1 + m2 + m3.
    expect(nodeOf(f, at(3, 1))).toMatchObject({ kind: 'thinking', messageId: 'm1', usage: null });
    expect(nodeOf(f, at(3, 0)).usage).toEqual({ inputTokens: 10 + 6 + 1, cachedInputTokens: 100 + 3, outputTokens: 1 + 2 + 1 });
    // Session totals lose nothing.
    expect(usageTotal(Object.values(f.graph.nodes))).toEqual({ inputTokens: 2 + 10 + 6 + 1, cachedInputTokens: 103, outputTokens: 5 });
    const want = comparable(f);
    for (const page of [1, 2, 5]) expect(comparable(paged(events, page))).toEqual(want);
    for (let cut = 1; cut < events.length; cut++) expect(comparable(paged(events, 2, cut))).toEqual(want);
  });

  test('a message that makes no node in a thread with no node yet: its usage has nowhere to go and nothing fails', () => {
    const f = run((l) => {
      l.turnStart(1);
      l.assistant(1, 1, [{ type: 'image', attachment: { attachmentId: 'sha256:00' } }], { id: 'm0', usage: { inputTokens: 2, outputTokens: 1 } });
    });
    expect(f.unknown).toEqual([]);
    expect(Object.keys(f.graph.nodes)).toEqual([]);
  });

  test('consecutive text blocks are one node; empty blocks, images and tool additions make none; reasoning after text is a node of its own', () => {
    const f = run((l) => {
      l.turnStart(1);
      l.user('go');
      l.assistant(1, 1, [textBlock('one '), textBlock('two'), { type: 'image', attachment: { attachmentId: 'sha256:00' } }, { type: 'tool-addition', toolName: 'x' }, textBlock(''), reasoningBlock('hmm'), { type: 'future-block' }]);
    });
    expect(f.unknown).toEqual([]);
    expect(Object.values(f.graph.nodes).map((n) => n.kind)).toEqual(['prompt', 'text', 'thinking']);
    expect(f.details.get(at(2, 0))?.text).toBe('one two');
    expect(nodeOf(f, at(2, 0)).usage).not.toBeNull();
  });

  test('a tool/call before (or without) its block, and a result without turn/step, pair with the latest call of that id', () => {
    const f = run((l) => {
      l.turnStart(1);
      l.user('go');
      l.stepStart(1, 1);
      l.toolCall(1, 1, 'c1', 'bash', { command: 'ls' });
      l.assistant(1, 1, [callBlock('c1', 'bash', { command: 'ls' })], { id: 'm1' });
      l.toolResult(null, null, 'c1', 'a\nb');
    });
    expect(Object.values(f.graph.nodes).map((n) => n.kind)).toEqual(['prompt', 'tool']);
    expect(nodeOf(f, call(1, 1, 'c1'))).toMatchObject({ status: 'succeeded', messageId: 'm1', usage: { inputTokens: 100, cachedInputTokens: 1000, outputTokens: 20 } });
    expect(f.details.get(call(1, 1, 'c1'))).toMatchObject({ input: { command: 'ls' }, output: 'a\nb' });
  });

  test('arguments that are not JSON are kept as the string input; a replace of an earlier result keeps the first output; a replace for no call adds nothing', () => {
    const f = run((l) => {
      l.turnStart(1);
      l.user('go');
      l.toolCall(1, 1, 'c1', 'bash', '{"command": "ls');
      l.toolResult(1, 1, 'c1', 'full output');
      l.toolResult(1, 1, 'c1', '(pruned)', { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 } });
      l.toolResult(1, 1, 'nope', '(pruned)', { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } });
    });
    expect(Object.values(f.graph.nodes).map((n) => n.kind)).toEqual(['prompt', 'tool']);
    expect(f.details.get(call(1, 1, 'c1'))).toEqual({ input: '{"command": "ls', output: 'full output' });
  });

  test('a result for a call never announced makes its node (status from isError)', () => {
    const f = run((l) => {
      l.turnStart(1);
      l.user('go');
      l.toolResult(1, 1, 'lost', 'boom', { isError: true });
    });
    expect(nodeOf(f, call(1, 1, 'lost'))).toMatchObject({ kind: 'tool', status: 'failed', toolName: null, title: 'tool' });
  });

  test('turn/end error: a Turn failed node with the error message, and the turn\'s running calls fail; interrupted: Interrupted', () => {
    const f = run((l) => {
      l.turnStart(1);
      l.user('go');
      l.assistant(1, 1, [callBlock('c1', 'bash', { command: 'sleep 100' })]);
      l.turnEnd(1, { kind: 'error', error: { message: 'rate limited', code: 'RATE_LIMIT' } }); // 3
      l.turnStart(2);
      l.user('again');
      l.turnEnd(2, { kind: 'interrupted' }); // 6
      l.turnStart(3);
      l.user('third');
      l.turnEnd(3, { kind: 'max-tokens' });
      l.turnEnd(3, { kind: 'forked' });
    });
    expect(nodeOf(f, call(1, 1, 'c1'))).toMatchObject({ status: 'failed', endedAt: isoOf(timeOf(3)), durationMs: 1000 });
    expect(nodeOf(f, at(3))).toMatchObject({ kind: 'system', title: 'Turn failed', systemSubtype: 'interrupt', summary: 'rate limited', turnId: at(1), parentId: call(1, 1, 'c1') });
    expect(nodeOf(f, at(6))).toMatchObject({ kind: 'system', title: 'Interrupted', systemSubtype: 'interrupt', turnId: at(5) });
    expect(Object.values(f.graph.nodes).filter((n) => n.kind === 'system')).toHaveLength(2);
  });

  test('a prompt before its turn/start is still the turn\'s first node; nodes after turn/end are outside any turn', () => {
    const f = run((l) => {
      l.user('early');
      l.turnStart(1);
      l.assistant(1, 1, [textBlock('reply')]);
      l.turnEnd(1);
      l.user('compacted', { kind: 'compact-checkpoint', compactionId: 'x' });
    });
    expect(nodeOf(f, at(0))).toMatchObject({ kind: 'prompt', turnId: at(0) });
    expect(nodeOf(f, at(2, 0))).toMatchObject({ turnId: at(0) });
    expect(nodeOf(f, at(4))).toMatchObject({ kind: 'system', turnId: null });
  });

  test('the cwd change resolves later relative paths; header cwd before it', () => {
    const f = run((l) => {
      l.turnStart(1);
      l.user('go');
      l.toolCall(1, 1, 'c1', 'write_file', { file_path: 'a.txt', content: 'x' });
      l.cwd('D:\\Other');
      l.toolCall(1, 1, 'c2', 'edit', { path: 'b.txt' });
    });
    expect(nodeOf(f, call(1, 1, 'c1')).files).toEqual([{ path: 'D:/Projects/Demo/a.txt', action: 'write' }]);
    expect(nodeOf(f, call(1, 1, 'c2')).files).toEqual([{ path: 'D:/Other/b.txt', action: 'edit' }]);
    expect(f.session?.cwd).toBe('D:\\Other');
  });

  test('every known log-only type is skipped silently; a type not in the format reference is counted; bad lines are reported', () => {
    const known = [
      'step/start',
      'step/end',
      'compaction/start',
      'compaction/summary',
      'compaction/end',
      'compaction/prune',
      'agent/inbox/spliced',
      'system/message',
      'developer/message',
      'request/header',
      'request/context',
      'model/selection',
      'assistant/attempt',
      'tool/ptc-dispatch-start',
      'tool/ptc-dispatch',
      'command/run',
      'command/done',
      'subagent/descriptor',
      'subagent/model-selection-policy',
      'llm/retry',
      'llm/retry-started',
      'approval/asked',
      'approval/decided',
      'approval/policy',
      'plan/mode',
      'permission/preset',
      'sandbox/mode',
      'todo/write',
      'goal/change',
      'job/registered',
      'job/settled',
      'hook/invoked',
      'hook/result',
      'image/offload',
      'workspace/changes',
      'deliverables/presented',
      'feedback/given',
      'schedule/change',
      'agent-preset/selected',
      'session-log-deepseek/delivery-accepted',
      'session/title-llm-request',
      'web/deepseek-search-llm-request',
      'team/message',
      'tool-workflow/started',
      'plugin:my-plugin/thing',
      'session/end-seed',
    ];
    const f = run((l) => {
      for (const t of known) l.add(t, {});
      l.add('mystery/event', {});
      l.add('mystery/event', {}, { ignorable: true });
    });
    const bad = go(dshEvents(header, ['{oops', '[1]', '{"seq":1}']));
    expect(f.unknown).toEqual(['deepseek:mystery/event', 'deepseek:mystery/event']);
    expect(Object.keys(f.graph.nodes)).toEqual([]);
    expect(bad.unknown).toEqual(['deepseek:invalid-json', 'deepseek:not-an-object', 'deepseek:?']);
  });

  test('does not keep tool inputs', () => {
    const n = new DeepSeekNormalizer();
    go(mainEvents(), n);
    expect(n.toolInputCount(SID)).toBe(0);
    expect(n.sessionCount()).toBe(1);
    expect(n.hasSession(SID)).toBe(true);
  });
});

describe('subagents (spec 3.5)', () => {
  const SUB = call(2, 1, 'call_00_s');
  const DEEP = call(1, 1, 'call_00_g', CHILD);
  const CHILD_PROMPT = at(2, undefined, CHILD);
  const GRAND_PROMPT = at(1, undefined, GRANDCHILD);

  test('the child file is a thread of the root session, linked to the dispatch the activation names; the grandchild hangs off the child\'s dispatch', () => {
    const f = go([...mainEvents(), ...childEvents(), ...grandEvents()]);
    expect(f.unknown).toEqual([]);
    expect([...f.sessions.keys()]).toEqual([SID]);
    expect(nodeOf(f, SUB)).toMatchObject({ kind: 'subagent', childAgentId: CHILD });
    expect(nodeOf(f, CHILD_PROMPT)).toMatchObject({ kind: 'prompt', agentId: CHILD, parentId: SUB, turnId: CHILD_PROMPT });
    expect(f.graph.edges[`${SUB}->${CHILD_PROMPT}`]).toMatchObject({ kind: 'spawn' });
    expect(nodeOf(f, DEEP)).toMatchObject({ kind: 'subagent', agentId: CHILD, childAgentId: GRANDCHILD, title: 'deeper' });
    expect(nodeOf(f, GRAND_PROMPT)).toMatchObject({ agentId: GRANDCHILD, parentId: DEEP });
    expect(f.session?.title).toBe('Fix the parser test'); // a thread's prompts never title the session
  });

  test('every arrival order of the three files, and every page size, gives the same graph', () => {
    const files = [mainEvents(), childEvents(), grandEvents()];
    const want = comparable(go(files.flat()));
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const o of orders) {
      const events = o.flatMap((i) => files[i]!);
      expect(comparable(go(events)), o.join()).toEqual(want);
      expect(comparable(paged(events, 4)), o.join()).toEqual(want);
      expect(comparable(paged(events, 5, 17)), o.join()).toEqual(want);
    }
    // Interleaved line by line.
    const mixed: RawEvent[] = [];
    for (let i = 0; i < Math.max(...files.map((x) => x.length)); i++) for (const x of [files[2]!, files[1]!, files[0]!]) if (i < x.length) mixed.push(x[i]!);
    expect(comparable(go(mixed))).toEqual(want);
  });

  test('a child header alone makes no session; child lines before the root header do not fake its creation time', () => {
    const n = new DeepSeekNormalizer();
    const r = n.apply(childEvents()[0]!, PROJECT);
    expect(r.changes).toEqual([]);
    const f = go([...childEvents(), ...mainEvents()]);
    expect(f.session?.startedAt).toBe(isoOf(T0));
  });

  test('an activation that matches no catalog row: the thread is shown unlinked', () => {
    const lines = main.lines.filter((l) => !l.includes('"subagent/catalog"'));
    const f = go([...dshEvents(main.header, lines), ...childEvents()]);
    const childFirst = Object.values(f.graph.nodes).find((n) => n.agentId === CHILD && n.kind === 'prompt')!;
    expect(childFirst.parentId).toBeNull();
    expect(Object.values(f.graph.edges).some((e) => e.kind === 'spawn')).toBe(false);
    expect(Object.values(f.graph.nodes).find((n) => n.toolUseId === 'call_00_s')).toMatchObject({ kind: 'subagent', childAgentId: null, title: 'agent-1' });
  });

  test('mode external: no thread, the dispatch is shown on its own', () => {
    const f = go([...mainEvents(), ...childEvents()]);
    expect(nodeOf(f, call(2, 1, 'call_01_e'))).toMatchObject({ kind: 'subagent', childAgentId: null });
    expect(Object.values(f.graph.nodes).some((n) => n.agentId === 'codex-thread-77')).toBe(false);
  });

  test('a rewritten child file replaces only its thread; the link is kept', () => {
    const l = new DshLog(0, T0 + 40_000);
    l.turnStart(1);
    l.user('check the parser again');
    const rewritten = dshEvents(child.header, l.lines, { agentId: CHILD });
    const f = go([...mainEvents(), ...childEvents(), ...rewritten]);
    const fresh = go([...mainEvents(), ...rewritten]);
    expect(comparable(f)).toEqual(comparable(fresh));
    expect(nodeOf(f, at(1, undefined, CHILD))).toMatchObject({ parentId: SUB, kind: 'prompt' });
    expect(Object.values(f.graph.nodes).filter((n) => n.agentId === CHILD)).toHaveLength(1);
  });

  test('a rewritten main file removes the stale nodes; the child thread is re-linked when the dispatch comes back', () => {
    const l = new DshLog();
    l.turnStart(1);
    l.user('Only this');
    const short = dshEvents(main.header, l.lines);
    const f = go([...mainEvents(), ...childEvents(), ...short]);
    const fresh = go([...childEvents(), ...short]);
    expect(comparable(f)).toEqual(comparable(fresh));
    expect(Object.values(f.graph.nodes).filter((n) => n.agentId === null).map((n) => f.details.get(n.id)?.text)).toEqual(['Only this']);
    expect(nodeOf(f, CHILD_PROMPT).parentId).toBeNull();
    expect(f.session?.title).toBe('Only this');
    expect(f.session?.cwd).toBe(CWD);
    const back = go([...mainEvents(), ...childEvents(), ...short, ...mainEvents()]);
    expect(comparable(back)).toEqual(comparable(go([...mainEvents(), ...childEvents()])));
  });
});

describe('forks (spec 3.4)', () => {
  const FORK = 'aaaaaaaa-1111-4222-8333-444444444444';
  const FORKCHILD = 'bbbbbbbb-1111-4222-8333-444444444444';
  /** A fork of the example after its turn 2: the copied prefix, the inherited cut, then its own dispatch of `agent-1`. */
  function forkLog(): string[] {
    const l = new DshLog(main.lines.length);
    l.endSeed(true); // 38: the cut
    l.turnEnd(2, { kind: 'forked' });
    l.turnStart(3); // 40
    l.user('Spawn another'); // 41
    l.assistant(3, 1, [callBlock('call_00_s', 'subagent', { prompt: 'fork child' })], { id: 'fmsg-1' });
    l.catalog(FORKCHILD, 'agent-1', { label: 'fork child' });
    l.toolResult(3, 1, 'call_00_s', 'started subagent agent-1', { meta: { kind: 'activation', name: 'agent-1' } });
    l.turnEnd(3);
    return [...main.lines, ...l.lines];
  }
  const forkHeader = headerLine({ id: FORK, seeded: true });
  const forkChild = (): RawEvent[] => {
    const l = new DshLog(0, T0 + 90_000);
    l.turnStart(1);
    l.user('fork child');
    return dshEvents(headerLine({ id: FORKCHILD, parent: FORK, origin: 'subagent' }), l.lines, { sessionId: FORK, agentId: FORKCHILD });
  };

  test('a fork is a session of its own showing the copied prefix; inherited catalog rows and activations do not link', () => {
    const fork = dshEvents(forkHeader, forkLog(), { sessionId: FORK });
    for (const events of [[...fork, ...forkChild()], [...forkChild(), ...fork]]) {
      const f = go(events, new DeepSeekNormalizer(), FORK);
      expect(f.unknown).toEqual([]);
      expect([...f.sessions.keys()]).toEqual([FORK]);
      const own = (part: string, agent: string | null = null): string => nid(part, agent, FORK);
      expect(f.details.get(own('@4'))?.text).toBe('Fix the failing test');
      expect(f.graph.nodes[own('call:2.1.call_00_s')]).toMatchObject({ kind: 'subagent', childAgentId: null });
      expect(f.graph.nodes[own('call:3.1.call_00_s')]).toMatchObject({ kind: 'subagent', childAgentId: FORKCHILD, title: 'fork child' });
      const first = Object.values(f.graph.nodes).find((n) => n.agentId === FORKCHILD)!;
      expect(first.parentId).toBe(own('call:3.1.call_00_s'));
    }
  });

  test('the same fork applied one by one, in pages and re-hydrated gives the same graph', () => {
    const events = [...dshEvents(forkHeader, forkLog(), { sessionId: FORK }), ...forkChild()];
    const want = go(events, new DeepSeekNormalizer(), FORK);
    const n = new DeepSeekNormalizer();
    const changes: Change[] = [];
    for (let i = 0; i < events.length; i += 5) changes.push(...n.applyBatch(events.slice(i, i + 5).map((event) => ({ event, projectId: PROJECT }))).changes);
    const g = fold(changes, [], FORK);
    expect({ nodes: g.graph.nodes, edges: g.graph.edges, details: Object.fromEntries([...g.details].sort()), session: g.session }).toEqual({
      nodes: want.graph.nodes,
      edges: want.graph.edges,
      details: Object.fromEntries([...want.details].sort()),
      session: want.session,
    });
  });
});

describe('deepseekTouches (conservative table, argument names unverified)', () => {
  test('file tools by name, path argument names tried in order, JSON-string arguments parsed', () => {
    expect(deepseekTouches('read_file', { path: 'a.ts' })).toEqual([{ path: 'a.ts', action: 'read' }]);
    expect(deepseekTouches('read', '{"file_path":"b.ts"}')).toEqual([{ path: 'b.ts', action: 'read' }]);
    expect(deepseekTouches('write_file', { filePath: 'c.ts' })).toEqual([{ path: 'c.ts', action: 'write' }]);
    expect(deepseekTouches('edit', { target_file: 'd.ts', path: 'e.ts' })).toEqual([{ path: 'e.ts', action: 'edit' }]);
    expect(deepseekTouches('delete_file', { file: 'f.ts' })).toEqual([{ path: 'f.ts', action: 'delete' }]);
    expect(deepseekTouches('apply_patch', { input: '*** Begin Patch\n*** Add File: g.ts\n+x\n*** End Patch' })).toEqual([{ path: 'g.ts', action: 'write' }]);
  });

  test('shell, search, subagent and unknown tools name no file; bad arguments name none', () => {
    expect(deepseekTouches('bash', { command: 'cat a.ts', path: 'x' })).toEqual([]);
    expect(deepseekTouches('subagent', { path: 'x' })).toEqual([]);
    expect(deepseekTouches('grep', { path: 'x' })).toEqual([]);
    expect(deepseekTouches('read_file', '{"path": "cut')).toEqual([]);
    expect(deepseekTouches('read_file', null)).toEqual([]);
    expect(deepseekTouches('read_file', { path: '  ' })).toEqual([]);
  });
});
