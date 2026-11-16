import { describe, expect, test } from 'vitest';
import { applyChanges, emptyGraph, type Change, type Graph, type GraphNode, type Session } from '@agent-canvas/shared';
import { grokTouches } from '../src/normalize/files.js';
import { GROK_RUN_MAX_CHARS, grokNodeId, GrokNormalizer } from '../src/normalize/grok.js';
import { NORMALIZER_FACTORIES } from '../src/normalize/registry.js';
import type { RawEvent } from '../src/store/store.js';
import { CHILD, chunk, CWD, exampleLines, ext, iso, PROJECT, SID, summaryEntry, T0, text, transcript, upd, UPDATES_KEY } from './grok-fixtures.js';

/** The summary entry of the example session (as the source writes it). */
const ENTRY = summaryEntry({ title: 'Fix failing unit test in parser', summary: 'Fix failing unit test', model: 'grok-build', cwd: CWD, branch: 'main', createdAt: iso(T0) });

interface Folded {
  graph: Graph;
  details: Map<string, Record<string, unknown>>;
  session: Session | undefined;
  unknown: string[];
  changes: Change[];
}

/** Folds changes as the store does: graph, merged details (dropped with their node), the last session. */
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

const projectOf = (ev: RawEvent): string => ((ev.source === 'transcript' || ev.source === 'meta') && ev.projectId != null ? ev.projectId : 'unknown');

/** One event at a time through apply. */
function go(events: RawEvent[], n = new GrokNormalizer()): Folded {
  const changes: Change[] = [];
  const unknown: string[] = [];
  for (const ev of events) {
    const r = n.apply(ev, projectOf(ev));
    changes.push(...r.changes);
    if (r.unknownRecordType !== undefined) unknown.push(r.unknownRecordType);
  }
  return fold(changes, unknown);
}

/** In batches of `page` through applyBatch; with `cut`, the session is dropped and re-hydrated there. */
function paged(events: RawEvent[], page: number, cut?: number): Folded {
  const n = new GrokNormalizer();
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

const nid = (part: string, agent: string | null = null): string => grokNodeId(SID, agent, part);
const call = (id: string, agent: string | null = null): string => nid(`call:${id}`, agent);
/** Node id of the chunk-run node that starts at line `i` of `lines` (ids come from the first chunk's file offset). */
function at(lines: string[], i: number, agent: string | null = null): string {
  let off = 0;
  for (let k = 0; k < i; k++) off += Buffer.byteLength(lines[k]!) + 1;
  return nid(`@${off}`, agent);
}
const nodeOf = (f: Folded, id: string): GraphNode => {
  const n = f.graph.nodes[id];
  if (n === undefined) throw new Error(`no node ${id}; have ${Object.keys(f.graph.nodes).join(', ')}`);
  return n;
};

describe('the example session (spec 5.2, research A6)', () => {
  const lines = exampleLines();
  const f = go([ENTRY, ...transcript(lines)]);
  const PROMPT = at(lines, 0);
  const THINK = at(lines, 1);
  const TEXT = at(lines, 6);

  test('prompt, thinking, tool(execute, failed), tool(search_replace, succeeded, edit touch), text with the turn usage', () => {
    expect(f.unknown).toEqual([]);
    expect(Object.keys(f.graph.nodes)).toEqual([PROMPT, THINK, call('call_1'), call('call_2'), TEXT]);
    expect(nodeOf(f, PROMPT)).toMatchObject({ kind: 'prompt', parentId: null, turnId: PROMPT, timestamp: iso(T0), summary: 'Fix the failing test' });
    expect(nodeOf(f, THINK)).toMatchObject({ kind: 'thinking', parentId: PROMPT, turnId: PROMPT, timestamp: iso(T0 + 2) });
    expect(nodeOf(f, call('call_1'))).toMatchObject({ kind: 'tool', toolName: 'execute', status: 'failed', parentId: THINK, endedAt: iso(T0 + 9), durationMs: 6000, summary: 'npm test' });
    expect(f.details.get(call('call_1'))).toEqual({ input: { command: 'npm test', description: 'Run tests' }, output: '1 test failed' });
    const edit = nodeOf(f, call('call_2'));
    expect(edit).toMatchObject({ kind: 'tool', title: 'search_replace', toolName: 'search_replace', status: 'succeeded', toolUseId: 'call_2' });
    expect(edit.files).toEqual([{ path: `${CWD}/src/parser.ts`, action: 'edit' }]);
    expect(edit.inputKey).toMatch(/^[0-9a-f]{16}$/);
    expect(nodeOf(f, TEXT)).toMatchObject({ kind: 'text', parentId: call('call_2'), usage: { inputTokens: 6200, cachedInputTokens: 4000, outputTokens: 820 } });
    expect(f.details.get(TEXT)).toEqual({ text: 'Fixed the off-by-one.' });
    expect(Object.keys(f.graph.edges)).toHaveLength(4);
  });

  test('session: title, cwd, project, branch from the summary entry; times from the records', () => {
    expect(f.session).toMatchObject({ id: SID, origin: 'grok', projectId: PROJECT, cwd: CWD, title: 'Fix failing unit test in parser', gitBranch: 'main', startedAt: iso(T0), lastActivityAt: iso(T0 + 19), status: 'running' });
  });

  test('title: generated_title, else session_summary, else the first prompt', () => {
    const g = go([summaryEntry({ title: null, summary: 'From summary', cwd: CWD }), ...transcript(lines)]);
    expect(g.session?.title).toBe('From summary');
    expect(go(transcript(lines)).session?.title).toBe('Fix the failing test');
  });

  test('one by one = any page size = drop and re-hydrate at any point', () => {
    const events = [ENTRY, ...transcript(lines)];
    const want = comparable(f);
    for (const page of [1, 2, 3, 100]) expect(comparable(paged(events, page))).toEqual(want);
    for (let cut = 1; cut < events.length; cut++) expect(comparable(paged(events, 2, cut))).toEqual(want);
  });

  test('registered for origin grok', () => {
    expect(NORMALIZER_FACTORIES.grok?.()).toBeInstanceOf(GrokNormalizer);
  });
});

describe('chunk coalescing', () => {
  test('five consecutive agent_message_chunk lines: one text node whose detail is the concatenation', () => {
    const lines = [chunk('user', 'hi'), ...['Hel', 'lo', ', ', 'wor', 'ld'].map((t, i) => chunk('agent', t, { ts: T0 + i }))];
    const f = go(transcript(lines));
    const TEXT = at(lines, 1);
    expect(Object.keys(f.graph.nodes)).toEqual([at(lines, 0), TEXT]);
    expect(f.details.get(TEXT)).toEqual({ text: 'Hello, world' });
    expect(nodeOf(f, TEXT)).toMatchObject({ summary: 'Hello, world', timestamp: iso(T0) });
    expect(f.changes.filter((c) => c.type === 'node_added')).toHaveLength(2);
    // Every page boundary, also inside the run, gives the same result.
    for (const page of [1, 2, 3, 4]) for (let cut = 1; cut < lines.length; cut++) expect(comparable(paged(transcript(lines), page, cut))).toEqual(comparable(f));
  });

  test('alternating chunk kinds: separate nodes', () => {
    const lines = [chunk('user', 'q'), chunk('agent', 'a1'), chunk('thought', 't1'), chunk('agent', 'a2'), chunk('thought', 't2'), chunk('thought', 't3')];
    const f = go(transcript(lines));
    expect(Object.values(f.graph.nodes).map((n) => n.kind)).toEqual(['prompt', 'text', 'thinking', 'text', 'thinking']);
    expect(f.details.get(at(lines, 4))).toEqual({ text: 't2t3' });
  });

  test('consecutive user chunks are one prompt; a run is cut by a tool call but not by a tool_call_update or an ignored record', () => {
    const lines = [
      chunk('user', 'part one, '),
      chunk('user', 'part two'),
      chunk('agent', 'a'),
      upd({ sessionUpdate: 'plan', entries: [] }),
      chunk('agent', 'b'),
      upd({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'ls', kind: 'search' }),
      chunk('agent', 'c'),
      upd({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' }),
      chunk('agent', 'd'),
    ];
    const f = go(transcript(lines));
    expect(f.details.get(at(lines, 0))).toEqual({ text: 'part one, part two' });
    expect(f.details.get(at(lines, 2))).toEqual({ text: 'ab' });
    expect(f.details.get(at(lines, 6))).toEqual({ text: 'cd' });
    expect(Object.keys(f.graph.nodes)).toHaveLength(4);
  });

  test('a user chunk without promptId after other records starts a new turn', () => {
    const lines = [chunk('user', 'one'), chunk('agent', 'r1'), chunk('user', 'two'), chunk('agent', 'r2')];
    const f = go(transcript(lines));
    expect(nodeOf(f, at(lines, 1)).turnId).toBe(at(lines, 0));
    expect(nodeOf(f, at(lines, 3)).turnId).toBe(at(lines, 2));
  });
});

describe('records', () => {
  test('legacy line without method: the whole line is params', () => {
    const legacy = JSON.stringify({ sessionId: SID, update: { sessionUpdate: 'user_message_chunk', content: text('legacy prompt') } });
    const f = go(transcript([legacy, chunk('agent', 'ok')]));
    expect(f.unknown).toEqual([]);
    expect(Object.values(f.graph.nodes).map((n) => n.kind)).toEqual(['prompt', 'text']);
  });

  test('_meta.promptId on params and on params.update both decide turns', () => {
    const lines = [chunk('user', 'q1', { promptId: 'p1' }), chunk('agent', 'a', { promptId: 'p1', metaOn: 'update' }), chunk('agent', 'b', { promptId: 'p2', metaOn: 'update' }), chunk('agent', 'c', { promptId: 'p2' })];
    const f = go(transcript(lines));
    expect(nodeOf(f, at(lines, 1)).turnId).toBe(at(lines, 0));
    // A new promptId opens a new turn: the run is cut; its first node names the turn.
    expect(nodeOf(f, at(lines, 2)).turnId).toBe(at(lines, 2));
    expect(f.details.get(at(lines, 2))).toEqual({ text: 'bc' });
  });

  test('params._meta wins over params.update._meta', () => {
    const line = JSON.stringify({ timestamp: T0, method: 'session/update', params: { sessionId: SID, _meta: { promptId: 'pA' }, update: { sessionUpdate: 'agent_message_chunk', content: text('x'), _meta: { promptId: 'pB' } } } });
    const lines = [chunk('user', 'q', { promptId: 'pA' }), line];
    const f = go(transcript(lines));
    expect(Object.keys(f.graph.nodes)).toHaveLength(2);
    expect(nodeOf(f, at(lines, 1)).turnId).toBe(at(lines, 0));
  });

  test('tool_call_update before tool_call: one node, ending as both say', () => {
    const lines = [
      chunk('user', 'q'),
      upd({ sessionUpdate: 'tool_call_update', toolCallId: 'c9', status: 'completed', content: [{ type: 'content', content: text('done') }] }, { ts: T0 + 5 }),
      upd({ sessionUpdate: 'tool_call', toolCallId: 'c9', title: 'Read a.ts', kind: 'read', status: 'pending', rawInput: { target_file: 'a.ts' } }, { ts: T0 + 6 }),
    ];
    const f = go([ENTRY, ...transcript(lines)]);
    const n = nodeOf(f, call('c9'));
    expect(Object.keys(f.graph.nodes)).toHaveLength(2);
    expect(n).toMatchObject({ status: 'succeeded', toolName: 'read', endedAt: iso(T0 + 5), title: 'Read a.ts', summary: 'a.ts', files: [{ path: `${CWD}/a.ts`, action: 'read' }] });
    expect(f.details.get(call('c9'))).toEqual({ output: 'done', input: { target_file: 'a.ts' } });
  });

  test('statuses error and cancelled are failed; completed succeeded; in_progress running', () => {
    const lines = [chunk('user', 'q')];
    const st = ['error', 'cancelled', 'completed', 'in_progress', 'failed'];
    st.forEach((s, i) => {
      lines.push(upd({ sessionUpdate: 'tool_call', toolCallId: `s${i}`, kind: 'execute', rawInput: { command: `c${i}` } }));
      lines.push(upd({ sessionUpdate: 'tool_call_update', toolCallId: `s${i}`, status: s }));
    });
    const f = go(transcript(lines));
    expect(st.map((_, i) => nodeOf(f, call(`s${i}`)).status)).toEqual(['failed', 'failed', 'succeeded', 'running', 'failed']);
  });

  test('missing rawInput: titled from title, else kind; no input key, no input in the detail', () => {
    const lines = [
      chunk('user', 'q'),
      upd({ sessionUpdate: 'tool_call', toolCallId: 'n1', title: 'Search the web', kind: 'fetch', status: 'pending' }),
      upd({ sessionUpdate: 'tool_call', toolCallId: 'n2', kind: 'search', status: 'pending' }),
      upd({ sessionUpdate: 'tool_call', toolCallId: 'n3' }),
    ];
    const f = go(transcript(lines));
    expect(nodeOf(f, call('n1'))).toMatchObject({ title: 'Search the web', toolName: 'fetch' });
    expect(nodeOf(f, call('n2'))).toMatchObject({ title: 'search', toolName: 'search' });
    expect(nodeOf(f, call('n3'))).toMatchObject({ title: 'tool', toolName: null });
    for (const c of ['n1', 'n2', 'n3']) {
      expect(nodeOf(f, call(c)).inputKey).toBeUndefined();
      expect(f.details.get(call(c))).not.toHaveProperty('input');
    }
  });

  test('output: content text, else rawOutput', () => {
    const lines = [
      chunk('user', 'q'),
      upd({ sessionUpdate: 'tool_call', toolCallId: 'o1', kind: 'execute', rawInput: { command: 'x' } }),
      upd({ sessionUpdate: 'tool_call_update', toolCallId: 'o1', status: 'completed', rawOutput: { exit_code: 0, stdout: 'fine' } }),
      upd({ sessionUpdate: 'tool_call', toolCallId: 'o2', kind: 'execute', rawInput: { command: 'y' } }),
      upd({ sessionUpdate: 'tool_call_update', toolCallId: 'o2', status: 'completed', content: [text('a'), { type: 'content', content: text('b') }], rawOutput: { ignored: true } }),
    ];
    const f = go(transcript(lines));
    expect(f.details.get(call('o1'))?.output).toEqual({ exit_code: 0, stdout: 'fine' });
    expect(f.details.get(call('o2'))?.output).toBe('a\nb');
  });

  test('plan / available_commands_update / current_mode_update: neither node nor report', () => {
    const lines = [chunk('user', 'q'), upd({ sessionUpdate: 'plan', entries: [] }), upd({ sessionUpdate: 'available_commands_update', availableCommands: [] }), upd({ sessionUpdate: 'current_mode_update', currentModeId: 'ask' })];
    const f = go(transcript(lines));
    expect(f.unknown).toEqual([]);
    expect(Object.keys(f.graph.nodes)).toHaveLength(1);
  });

  test('unknown session/update kinds, extension types and methods are reported by type name only', () => {
    const lines = [
      chunk('user', 'q'),
      upd({ sessionUpdate: 'usage_update', used: 1 }),
      ext({ sessionUpdate: 'compaction_checkpoint', id: 'cp1' }),
      JSON.stringify({ timestamp: T0, method: '_x.ai/session/update', params: { sessionId: SID, update: { type: 'DiffReview', secret: 'x' } } }),
      JSON.stringify({ timestamp: T0, method: '_x.ai/session/update', params: { sessionId: SID, type: 'memory_flush' } }),
      JSON.stringify({ timestamp: T0, method: 'other/thing', params: {} }),
      'not json',
      '[1,2]',
    ];
    const f = go(transcript(lines));
    expect(f.unknown).toEqual(['grok:usage_update', 'grok:compaction_checkpoint', 'grok:DiffReview', 'grok:memory_flush', 'grok:other/thing', 'grok:invalid-json', 'grok:not-an-object']);
    expect(Object.keys(f.graph.nodes)).toHaveLength(1);
  });

  test('never throws on garbage', () => {
    const n = new GrokNormalizer();
    const odd = ['{}', 'null', '{"method":"session/update"}', '{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update"}}}', '{"params":{"update":{"sessionUpdate":"agent_message_chunk","content":[1,{"text":2}]}}}', '{"method":"_x.ai/session/update","params":{"update":{"type":"turn_completed","usage":"x"}}}'];
    expect(() => go(transcript(odd), n)).not.toThrow();
    expect(() => n.apply({ source: 'meta', origin: 'grok', file: 'grok:@summary/x', sessionId: 'x', agentId: null, payload: '{bad' }, 'p')).not.toThrow();
    expect(() => n.apply({ source: 'hook', origin: 'grok', receivedAt: iso(T0), eventName: 'x', sessionId: SID, payload: '{}' }, 'p')).not.toThrow();
  });

  test('byte-identical lines at different offsets are all applied (no line dedupe in the normalizer; eventIds ignored)', () => {
    const same = (t: string): string => upd({ sessionUpdate: 'agent_message_chunk', content: text(t) }, { meta: { eventId: 'msg-1', promptId: 'p' } });
    const lines = [chunk('user', 'q', { promptId: 'p' }), same('1'), same('\n\n'), same('2'), same('\n\n'), same('3'), same('\n\n')];
    expect(go(transcript(lines)).details.get(at(lines, 1))).toEqual({ text: '1\n\n2\n\n3\n\n' });
  });

  test('M1: object-prototype names are not chunk kinds', () => {
    const lines = [chunk('user', 'q'), ...['constructor', '__proto__', 'toString', 'hasOwnProperty'].map((k) => upd({ sessionUpdate: k, content: text('x') }))];
    const f = go(transcript(lines));
    expect(f.unknown).toEqual(['grok:constructor', 'grok:__proto__', 'grok:toString', 'grok:hasOwnProperty']);
    expect(Object.keys(f.graph.nodes)).toHaveLength(1);
  });

  test('a file read again from its start (rewritten): the thread is rebuilt from the new content, as a fresh read gives', () => {
    const old = [chunk('user', 'old prompt', { promptId: 'p1' }), chunk('agent', 'old answer', { promptId: 'p1' }), upd({ sessionUpdate: 'tool_call', toolCallId: 'k', kind: 'read', rawInput: { target_file: 'a.ts' } }, { meta: { promptId: 'p1' } })];
    const fresh = [chunk('user', 'new prompt', { promptId: 'p1' }), chunk('agent', 'new answer', { promptId: 'p1' })];
    const n = new GrokNormalizer();
    const changes: Change[] = [];
    for (const e of [ENTRY, ...transcript(old), ...transcript(fresh)]) changes.push(...n.apply(e, PROJECT).changes);
    const want = go([ENTRY, ...transcript(fresh)]);
    expect(comparable(fold(changes))).toEqual(comparable(want));
  });
});

describe('usage', () => {
  const done = (promptId: string | null, input: number): string => ext({ sessionUpdate: 'turn_completed', ...(promptId !== null ? { prompt_id: promptId } : {}), usage: { inputTokens: input, outputTokens: 10, cachedReadTokens: 5, cacheCreationTokens: 2, reasoningTokens: 1 } });

  test('on the turn\'s last reply node; a repeated turn_completed is not counted twice; a later reply takes it over', () => {
    const lines = [chunk('user', 'q', { promptId: 'p1' }), chunk('agent', 'first', { promptId: 'p1' }), done('p1', 100), done('p1', 100), upd({ sessionUpdate: 'tool_call', toolCallId: 'k', kind: 'read' }, { meta: { promptId: 'p1' } }), chunk('agent', 'second', { promptId: 'p1' }), done('p1', 100)];
    const f = go(transcript(lines));
    const total = Object.values(f.graph.nodes).reduce((s, n) => s + (n.usage?.inputTokens ?? 0), 0);
    expect(total).toBe(102);
    expect(nodeOf(f, at(lines, 5)).usage).toEqual({ inputTokens: 102, cachedInputTokens: 5, outputTokens: 11 });
    expect(nodeOf(f, at(lines, 1)).usage).toBeNull();
  });

  test('turn_completed without prompt_id: the current turn; with an unknown prompt_id: the current turn; no node: no usage', () => {
    const lines = [chunk('user', 'q'), chunk('agent', 'r'), done(null, 7)];
    expect(nodeOf(go(transcript(lines)), at(lines, 1)).usage?.inputTokens).toBe(9);
    expect(Object.keys(go(transcript([done('zz', 7)])).graph.nodes)).toEqual([]);
  });
});

describe('rewind', () => {
  const three = (): string[] => [
    chunk('user', 'turn zero', { ts: T0 }),
    chunk('agent', 'r0', { ts: T0 + 1 }),
    chunk('user', 'turn one', { ts: T0 + 2 }),
    upd({ sessionUpdate: 'tool_call', toolCallId: 'k1', kind: 'edit', rawInput: { file_path: `${CWD}/one.ts` } }, { ts: T0 + 3 }),
    chunk('agent', 'r1', { ts: T0 + 4 }),
    chunk('user', 'turn two', { ts: T0 + 5 }),
    chunk('agent', 'r2', { ts: T0 + 6 }),
  ];

  test('target_prompt_index 1 over three turns removes turns 1 and 2; later lines append after turn 0', () => {
    const lines = [...three(), ext({ sessionUpdate: 'rewind_marker', target_prompt_index: 1 }, { ts: T0 + 7 }), chunk('agent', 'more', { ts: T0 + 8 }), chunk('user', 'new one', { ts: T0 + 9 })];
    const f = go(transcript(lines));
    expect(f.unknown).toEqual([]);
    const removed = f.changes.filter((c) => c.type === 'node_removed').map((c) => (c as { id: string }).id);
    expect(removed.sort()).toEqual([at(lines, 2), call('k1'), at(lines, 4), at(lines, 5), at(lines, 6)].sort());
    expect(Object.keys(f.graph.nodes)).toEqual([at(lines, 0), at(lines, 1), at(lines, 8), at(lines, 9)]);
    // "more" has no promptId: it continues turn 0 after its last node (a new node: the run was closed by the rewind).
    expect(nodeOf(f, at(lines, 8))).toMatchObject({ parentId: at(lines, 1), turnId: at(lines, 0) });
    expect(nodeOf(f, at(lines, 9))).toMatchObject({ parentId: at(lines, 8), turnId: at(lines, 9) });
    // A second rewind to 1 removes the new turn 1 only.
    const g = go(transcript([...lines, ext({ type: 'RewindMarker', target_prompt_index: 1 })]));
    expect(Object.keys(g.graph.nodes)).toEqual([at(lines, 0), at(lines, 1), at(lines, 8)]);
    for (const page of [1, 3]) for (let cut = 1; cut < lines.length; cut += 2) expect(comparable(paged(transcript(lines), page, cut))).toEqual(comparable(f));
  });

  test('a late update of a rewound call does not bring it back', () => {
    const lines = [...three(), ext({ sessionUpdate: 'rewind_marker', target_prompt_index: 1 }), upd({ sessionUpdate: 'tool_call_update', toolCallId: 'k1', status: 'completed' })];
    expect(go(transcript(lines)).graph.nodes[call('k1')]).toBeUndefined();
  });

  test('a rewind marker without an index removes nothing and is reported', () => {
    const lines = [...three(), ext({ sessionUpdate: 'rewind_marker' })];
    const f = go(transcript(lines));
    expect(f.unknown).toEqual(['grok:rewind_marker']);
    expect(Object.keys(f.graph.nodes)).toHaveLength(7);
    expect(f.changes.some((c) => c.type === 'node_removed')).toBe(false);
  });

  test('target_prompt_index 0 removes every turn; the session title falls back to the next first prompt', () => {
    const lines = [...three(), ext({ sessionUpdate: 'rewind_marker', target_prompt_index: 0 }), chunk('user', 'fresh start')];
    const f = go(transcript(lines));
    expect(Object.keys(f.graph.nodes)).toEqual([at(lines, 8)]);
    expect(f.session?.title).toBe('fresh start');
  });
});

describe('rewind by _meta.promptIndex (M4)', () => {
  test('turns without a promptIndex (no user prompt) are not prompts of their own', () => {
    const lines = [
      chunk('user', 'qa', { promptId: 'pa' }).replace('"promptId":"pa"', '"promptId":"pa","promptIndex":0'),
      chunk('agent', 'host', { promptId: 'pb' }),
      chunk('user', 'qc', { promptId: 'pc' }).replace('"promptId":"pc"', '"promptId":"pc","promptIndex":1'),
      chunk('agent', 'rc', { promptId: 'pc' }),
      ext({ sessionUpdate: 'rewind_marker', target_prompt_index: 1 }),
    ];
    const f = go(transcript(lines));
    expect(Object.keys(f.graph.nodes)).toEqual([at(lines, 0), at(lines, 1)]);
  });
});

describe('a rewind that removes a dispatch keeps the subagent thread, detached, with its usage (I4 ruling)', () => {
  test('no surviving node or edge points at a removed node', () => {
    const parent = [
      chunk('user', 'zero', { promptId: 'p0' }),
      chunk('user', 'one', { promptId: 'p1' }),
      upd({ sessionUpdate: 'tool_call', toolCallId: 'task_1', kind: 'other', rawInput: { prompt: 'x', subagent_type: 'explore' }, _meta: { toolName: 'task' } }, { meta: { promptId: 'p1' } }),
      upd({ sessionUpdate: 'tool_call_update', toolCallId: 'task_1', status: 'completed', rawOutput: { subagent_id: CHILD } }, { meta: { promptId: 'p1' } }),
      ext({ sessionUpdate: 'rewind_marker', target_prompt_index: 1 }),
    ];
    const child = transcript([chunk('user', 'go', { promptId: 'c' }), chunk('agent', 'did it', { promptId: 'c' }), ext({ sessionUpdate: 'turn_completed', prompt_id: 'c', usage: { inputTokens: 50, outputTokens: 5 } })], { agentId: CHILD });
    for (const events of [[ENTRY, ...transcript(parent), ...child], [ENTRY, ...child, ...transcript(parent)]]) {
      const f = go(events);
      const nodes = Object.values(f.graph.nodes);
      expect(nodes.filter((n) => n.agentId === CHILD)).toHaveLength(2);
      expect(nodes.find((n) => n.agentId === CHILD && n.kind === 'text')!.usage).toEqual({ inputTokens: 50, cachedInputTokens: 0, outputTokens: 5 });
      expect(nodes.find((n) => n.agentId === CHILD && n.kind === 'prompt')!.parentId).toBeNull();
      for (const n of nodes) if (n.parentId !== null) expect(f.graph.nodes[n.parentId], n.id).toBeDefined();
      for (const e of Object.values(f.graph.edges)) expect(f.graph.nodes[e.from] !== undefined && f.graph.nodes[e.to] !== undefined).toBe(true);
    }
  });
});

describe('open runs: bounded rewrites (I5)', () => {
  /** Bytes of node detail the store would serialize with one line per transaction (each change's detail, whole). */
  function stream(total: number, chunks: number): { bytes: number; texts: string[]; visibleOk: boolean } {
    const n = new GrokNormalizer();
    const piece = `${'w'.repeat(Math.round(total / chunks) - 1)} `;
    const lines = [chunk('user', 'go'), ...Array.from({ length: chunks }, () => chunk('agent', piece))];
    const events = transcript(lines);
    let bytes = 0;
    let visibleOk = true;
    const texts = new Map<string, string>();
    events.forEach((e, i) => {
      for (const c of n.apply(e, PROJECT).changes) {
        if (c.type === 'node_added') {
          bytes += ((c.detail.text as string | undefined)?.length ?? 0) + 11; // {"text":""}
          if (c.node.kind === 'text') texts.set(c.node.id, c.detail.text as string);
        }
        if (c.type === 'node_updated' && c.detail !== undefined) {
          bytes += ((c.detail.text as string | undefined)?.length ?? 0) + 11;
          texts.set(c.id, c.detail.text as string);
        }
      }
      // (a) after every applied line the whole text received so far is in the details.
      if (i > 0 && i % 97 === 0 && [...texts.values()].join('').length !== i * piece.length) visibleOk = false;
    });
    return { bytes, texts: [...texts.values()], visibleOk };
  }

  test('a 250 Ki answer in 2,500 chunks: at most 50× its size serialized, every byte visible after every line', () => {
    const r = stream(256_000, 2500);
    expect(r.visibleOk).toBe(true);
    expect(r.bytes / 256_000).toBeLessThan(50);
    expect(r.texts.every((t) => t.length <= GROK_RUN_MAX_CHARS + 103)).toBe(true);
  });

  test('a 2 MB answer in 20,000 chunks: linear too', { timeout: 60_000 }, () => {
    const r = stream(2_000_000, 20_000);
    expect(r.visibleOk).toBe(true);
    expect(r.bytes / 2_000_000).toBeLessThan(50);
  });

  test('a typical answer stays one node; a continuation never splits a chunk (or a surrogate pair)', () => {
    const lines = [chunk('user', 'go'), ...Array.from({ length: 300 }, () => chunk('agent', 'word '))];
    expect(Object.values(go(transcript(lines)).graph.nodes).filter((n) => n.kind === 'text')).toHaveLength(1);
    const emoji = '\u{1F600}';
    const big = [chunk('user', 'go'), ...Array.from({ length: GROK_RUN_MAX_CHARS }, () => chunk('agent', emoji))];
    const f = go(transcript(big));
    const texts = Object.values(f.graph.nodes).filter((n) => n.kind === 'text').map((n) => f.details.get(n.id)!.text as string);
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.join('')).toBe(emoji.repeat(GROK_RUN_MAX_CHARS));
    for (const t of texts) expect(t.length % 2).toBe(0);
    const single = go(transcript([chunk('user', 'go'), chunk('agent', emoji.repeat(GROK_RUN_MAX_CHARS))]));
    expect(Object.values(single.graph.nodes).filter((n) => n.kind === 'text')).toHaveLength(1);
  });
});

describe('subagent sessions as agent threads', () => {
  const parentLines = (): string[] => [
    chunk('user', 'look around', { promptId: 'p1' }),
    upd({ sessionUpdate: 'tool_call', toolCallId: 'task_1', title: 'explore', kind: 'other', rawInput: { description: 'Explore', prompt: 'find TODOs', subagent_type: 'explore' }, _meta: { toolName: 'task' } }, { meta: { promptId: 'p1' } }),
    upd({ sessionUpdate: 'tool_call_update', toolCallId: 'task_1', status: 'completed', rawOutput: { subagent_id: CHILD, summary: 'found 2' } }, { meta: { promptId: 'p1' } }),
    chunk('agent', 'done', { promptId: 'p1' }),
  ];
  const childLines = (): string[] => [chunk('user', 'find TODOs', { promptId: 'c1' }), upd({ sessionUpdate: 'tool_call', toolCallId: 'g1', kind: 'search', rawInput: { pattern: 'TODO' } }, { meta: { promptId: 'c1' } }), chunk('agent', 'found 2', { promptId: 'c1' })];
  const parent = (): RawEvent[] => [ENTRY, ...transcript(parentLines())];
  const child = (): RawEvent[] => transcript(childLines(), { agentId: CHILD, projectId: PROJECT });

  test('the thread hangs off the dispatch that names its id; same graph whether the child comes first or last', () => {
    const after = go([...parent(), ...child()]);
    const before = go([...child(), ...parent()]);
    expect(comparable(before)).toEqual(comparable(after));
    const first = at(childLines(), 0, CHILD);
    expect(nodeOf(after, first)).toMatchObject({ agentId: CHILD, parentId: call('task_1') });
    expect(nodeOf(after, call('task_1'))).toMatchObject({ kind: 'subagent', childAgentId: CHILD, title: 'explore' });
    expect(after.graph.edges[`${call('task_1')}->${first}`]).toMatchObject({ kind: 'spawn' });
    // Interleaved at every point, and paged with a drop at every cut.
    const all = [...parent(), ...child()];
    for (let k = 1; k < child().length; k++) {
      const mixed = [...child().slice(0, k), ...parent(), ...child().slice(k)];
      expect(comparable(go(mixed))).toEqual(comparable(after));
      for (let cut = 1; cut < mixed.length; cut += 2) expect(comparable(paged(mixed, 2, cut))).toEqual(comparable(after));
    }
    expect(comparable(paged(all, 3))).toEqual(comparable(after));
  });

  test('a dispatch that names another id is not linked: the thread hangs under the session', () => {
    const lines = parentLines();
    lines[2] = upd({ sessionUpdate: 'tool_call_update', toolCallId: 'task_1', status: 'completed', rawOutput: { subagent_id: 'someone-else' } });
    const f = go([ENTRY, ...transcript(lines), ...child()]);
    expect(nodeOf(f, at(childLines(), 0, CHILD)).parentId).toBeNull();
    expect(nodeOf(f, call('task_1'))).toMatchObject({ kind: 'subagent', childAgentId: null });
  });

  test('a rewind that removes the dispatch detaches the thread', () => {
    const lines = [chunk('user', 'zero', { promptId: 'p0' }), ...parentLines(), ext({ sessionUpdate: 'rewind_marker', target_prompt_index: 1 })];
    const f = go([ENTRY, ...transcript(lines), ...child()]);
    expect(f.graph.nodes[call('task_1')]).toBeUndefined();
    expect(nodeOf(f, at(childLines(), 0, CHILD)).parentId).toBeNull();
    expect(Object.values(f.graph.edges).some((e) => e.to === at(childLines(), 0, CHILD))).toBe(false);
    const g = go([ENTRY, ...child(), ...transcript(lines)]);
    expect(comparable(g)).toEqual(comparable(f));
  });

  test('the child thread alone makes the session (its records carry content)', () => {
    const f = go(child());
    expect(f.session).toMatchObject({ id: SID, projectId: PROJECT });
  });
});

describe('no phantom sessions', () => {
  test('a summary entry alone, ignored records alone, or garbage alone make no session', () => {
    for (const evs of [[ENTRY], transcript([upd({ sessionUpdate: 'plan', entries: [] })]), transcript(['garbage']), transcript([ext({ sessionUpdate: 'turn_completed', usage: {} })])]) {
      const f = go(evs);
      expect(f.session).toBeUndefined();
      expect(f.changes).toEqual([]);
    }
  });
});

describe('grokTouches (spec 5.2 tool table)', () => {
  test('tool names, path keys in order, locations fallback, ACP kind fallback', () => {
    expect(grokTouches('read_file', null, { target_file: 'a.ts', path: 'b.ts' }, [])).toEqual([{ path: 'a.ts', action: 'read' }]);
    expect(grokTouches('search_replace', 'edit', { file_path: 'x.ts' }, [{ path: '/w/y.ts' }])).toEqual([{ path: 'x.ts', action: 'edit' }]);
    expect(grokTouches('write', null, { filePath: 'w.ts' }, [])).toEqual([{ path: 'w.ts', action: 'write' }]);
    expect(grokTouches('edit_file', null, {}, [{ path: '/w/loc.ts' }])).toEqual([{ path: '/w/loc.ts', action: 'edit' }]);
    expect(grokTouches('run_terminal_cmd', 'execute', { command: 'cat a.ts' }, [{ path: '/w/a.ts' }])).toEqual([]);
    expect(grokTouches('grep', 'search', { path: 'src' }, [])).toEqual([]);
    expect(grokTouches('task', null, { prompt: 'x' }, [])).toEqual([]);
    expect(grokTouches('web_fetch', 'read', { path: 'a.ts' }, [])).toEqual([]); // a name not in the table: other
    expect(grokTouches(null, 'read', { path: 'r.ts' }, [])).toEqual([{ path: 'r.ts', action: 'read' }]);
    expect(grokTouches(null, 'edit', null, [{ path: '/w/e.ts' }])).toEqual([{ path: '/w/e.ts', action: 'edit' }]);
    expect(grokTouches(null, 'delete', { path: 'd.ts' }, [])).toEqual([{ path: 'd.ts', action: 'delete' }]);
    expect(grokTouches(null, 'execute', { path: 'x' }, [])).toEqual([]);
    expect(grokTouches(null, null, { path: 'x' }, [])).toEqual([]);
    expect(grokTouches('apply_patch', null, { input: '*** Begin Patch\n*** Update File: p.ts\n@@\n-a\n+b\n*** End Patch\n' }, [])).toEqual([{ path: 'p.ts', action: 'edit' }]);
  });
});

test('ids are origin-prefixed and stable', () => {
  expect(grokNodeId(SID, null, 'call:x')).toBe(`grok:${SID}:call:x`);
  expect(grokNodeId(SID, CHILD, '@0')).toBe(`grok:${SID}/${CHILD}:@0`);
  expect(UPDATES_KEY.startsWith('grok:')).toBe(true);
});
