import { describe, expect, test } from 'vitest';
import { applyChanges, emptyGraph, type Change, type GraphNode } from '@agent-canvas/shared';
import { geminiNodeId, GeminiNormalizer } from '../src/normalize/gemini.js';
import { NORMALIZER_FACTORIES } from '../src/normalize/registry.js';
import { GEMINI_PROJECT_ENTRY_PREFIX } from '../src/sources/gemini/project.js';
import type { RawEvent } from '../src/store/store.js';
import { interleave, run, type RunResult } from './codex-fixtures.js';
import {
  CALL_READ,
  CALL_SHELL,
  dispatchMsg,
  exampleLines,
  legacyJson,
  M1,
  M2,
  M3,
  M4,
  M5,
  m2,
  m3,
  m4,
  m5,
  meta,
  metaLine,
  PROJECT,
  SID,
  SUB_ID,
  SUB_KEY,
  subagentLines,
  TITLE,
  transcript,
  userMsg,
} from './gemini-fixtures.js';

const go = (events: RawEvent[]): RunResult => run(new GeminiNormalizer(), events);
const id = (msg: string, part: string, agent: string | null = null): string => geminiNodeId(SID, agent, msg, part);
const nodeOf = (r: RunResult, nid: string): GraphNode => {
  const n = r.graph.nodes[nid];
  if (n === undefined) throw new Error(`no node ${nid}; have ${Object.keys(r.graph.nodes).join(', ')}`);
  return n;
};
const detailOf = (r: RunResult, nid: string): Record<string, unknown> => {
  let d: Record<string, unknown> = {};
  for (const c of r.changes) {
    if (c.type === 'node_added' && c.node.id === nid) d = { ...c.detail };
    if (c.type === 'node_updated' && c.id === nid && c.detail !== undefined) d = { ...d, ...c.detail };
  }
  return d;
};
const lines = (ls: unknown[]): string[] => ls.map((l) => (typeof l === 'string' ? l : JSON.stringify(l)));
const shape = (r: RunResult) => ({ nodes: r.graph.nodes, edges: r.graph.edges, session: r.sessions.get(SID) });
const subEvents = (): RawEvent[] => transcript(subagentLines(), { key: SUB_KEY, agentId: SUB_ID });

describe('the example file, line by line', () => {
  const r = go(transcript(exampleLines()));
  const PROMPT = id(M1, 'prompt');
  const THOUGHT = id(M2, 'thought:0');
  const TEXT = id(M2, 'text');
  const READ = id(M2, `call:${CALL_READ}`);
  const SHELL = id(M4, `call:${CALL_SHELL}`);
  const INFO = id(M5, 'info');

  test('nodes in order: prompt, thinking, text, read_file, run_shell_command, info; the functionResponse turn adds none', () => {
    expect(Object.keys(r.graph.nodes)).toEqual([PROMPT, THOUGHT, TEXT, READ, SHELL, INFO]);
    expect(Object.values(r.graph.nodes).map((n) => n.kind)).toEqual(['prompt', 'thinking', 'text', 'tool', 'tool', 'system']);
    expect(Object.keys(r.graph.nodes).some((k) => k.includes(M3))).toBe(false);
    expect(r.unknown).toEqual([]);
  });

  test('chained in order with sequence edges; turn = the prompt', () => {
    const order = [PROMPT, THOUGHT, TEXT, READ, SHELL, INFO];
    expect(nodeOf(r, PROMPT).parentId).toBeNull();
    for (let i = 1; i < order.length; i++) expect(nodeOf(r, order[i]!).parentId).toBe(order[i - 1]);
    expect(Object.values(r.graph.edges).map((e) => [e.from, e.to, e.kind])).toEqual(order.slice(1).map((to, i) => [order[i], to, 'sequence']));
    for (const nid of order) expect(nodeOf(r, nid).turnId).toBe(PROMPT);
  });

  test('prompt, thinking and text content', () => {
    expect(nodeOf(r, PROMPT)).toMatchObject({ title: 'Prompt', summary: 'Add a --verbose flag to cli.ts', timestamp: '2026-11-16T09:41:20.501Z', messageId: M1 });
    expect(detailOf(r, PROMPT)).toEqual({ text: 'Add a --verbose flag to cli.ts' });
    expect(nodeOf(r, THOUGHT)).toMatchObject({ title: 'Thinking', summary: 'Locating the CLI entry', timestamp: '2026-11-16T09:41:23.010Z' });
    expect(detailOf(r, THOUGHT).text).toBe('Locating the CLI entry\nNeed to see how args are parsed.');
    expect(nodeOf(r, TEXT)).toMatchObject({ title: 'Text', summary: "I'll read the file first.", messageId: M2 });
    expect(detailOf(r, TEXT)).toMatchObject({ text: "I'll read the file first.", raw: { model: 'gemini-2.5-pro' } });
  });

  test('usage: {input − cached, cached, output + thoughts} on the message’s text node, else its first call', () => {
    expect(nodeOf(r, TEXT).usage).toEqual({ inputTokens: 5210 - 4096, cachedInputTokens: 4096, outputTokens: 42 + 118 });
    expect(nodeOf(r, THOUGHT).usage).toBeNull();
    expect(nodeOf(r, READ).usage).toBeNull();
    expect(nodeOf(r, SHELL).usage).toEqual({ inputTokens: 6011 - 5120, cachedInputTokens: 5120, outputTokens: 210 });
  });

  test('read_file: succeeded, file touch read, output from functionResponse.response.output', () => {
    expect(nodeOf(r, READ)).toMatchObject({
      kind: 'tool',
      title: 'read_file',
      toolName: 'read_file',
      toolUseId: CALL_READ,
      status: 'succeeded',
      files: [{ path: '/home/dev/demo-app/src/cli.ts', action: 'read' }],
      endedAt: '2026-11-16T09:41:25.102Z',
      timestamp: '2026-11-16T09:41:24.880Z',
      durationMs: 222,
    });
    expect(nodeOf(r, READ).inputKey).toMatch(/^[0-9a-f]{16}$/);
    expect(detailOf(r, READ)).toMatchObject({ input: { file_path: '/home/dev/demo-app/src/cli.ts' }, output: "import { parseArgs } from 'node:util';\n..." });
  });

  test('run_shell_command: failed, the error as output, the command as summary, no file touch', () => {
    expect(nodeOf(r, SHELL)).toMatchObject({ status: 'failed', summary: 'npm test', toolName: 'run_shell_command' });
    expect(nodeOf(r, SHELL)).not.toHaveProperty('files');
    expect(detailOf(r, SHELL).output).toBe('Command exited with code 1');
  });

  test('info notice → system node', () => {
    expect(nodeOf(r, INFO)).toMatchObject({ kind: 'system', title: 'Info', systemSubtype: 'info', summary: 'Tool call was rejected by the user.' });
  });

  test('session: origin gemini, title from $set.summary, project as given, start from the metadata, idle', () => {
    expect(r.sessions.get(SID)).toEqual({
      id: SID,
      projectId: PROJECT,
      origin: 'gemini',
      cwd: null,
      title: TITLE,
      gitBranch: null,
      status: 'idle',
      sourceDeleted: false,
      startedAt: '2026-11-16T09:41:07.120Z',
      lastActivityAt: '2026-11-16T09:41:41.000Z',
    });
  });
});

describe('messages and calls', () => {
  test('a user message whose content has a functionResponse part adds no node', () => {
    const r = go(transcript(lines([metaLine(), m3])));
    expect(Object.keys(r.graph.nodes)).toEqual([]);
    expect(r.sessions.get(SID)).toBeDefined();
  });

  test('re-appended three times (text → + scheduled call → + result): one text node, one tool node running → succeeded', () => {
    const r = go(transcript(lines([metaLine(), userMsg(M1, 'go'), m2(0), m2(1), m2(2)])));
    const added = r.changes.filter((c): c is Extract<Change, { type: 'node_added' }> => c.type === 'node_added').map((c) => c.node.id);
    expect(added.filter((x) => x === id(M2, 'text'))).toHaveLength(1);
    expect(added.filter((x) => x === id(M2, `call:${CALL_READ}`))).toHaveLength(1);
    expect(r.changes.some((c) => c.type === 'node_removed')).toBe(false);
    const statuses = r.changes.flatMap((c) =>
      c.type === 'node_added' && c.node.id === id(M2, `call:${CALL_READ}`) ? [c.node.status] : c.type === 'node_updated' && c.id === id(M2, `call:${CALL_READ}`) && c.patch.status !== undefined ? [c.patch.status] : [],
    );
    expect(statuses).toEqual(['running', 'succeeded']);
    expect(Object.values(r.graph.nodes).filter((n) => n.kind === 'text')).toHaveLength(1);
  });

  test('the same message re-appended unchanged emits nothing', () => {
    const n = new GeminiNormalizer();
    run(n, transcript(lines([metaLine(), userMsg(M1, 'go'), m2(2)])));
    const again = n.apply(transcript([JSON.stringify(m2(2))], { startOffset: 9999 })[0]!, PROJECT);
    expect(again.changes).toEqual([]);
  });

  test('status cancelled → failed; error → failed; scheduled / executing → running', () => {
    for (const [status, want] of [
      ['cancelled', 'failed'],
      ['error', 'failed'],
      ['success', 'succeeded'],
      ['scheduled', 'running'],
      ['executing', 'running'],
      ['awaiting_approval', 'running'],
    ] as const) {
      const r = go(transcript(lines([metaLine(), m4(status)])));
      expect(nodeOf(r, id(M4, `call:${CALL_SHELL}`)).status).toBe(want);
    }
  });

  test('warning and error notices; an unknown message type is reported and makes no node', () => {
    const r = go(
      transcript(
        lines([
          metaLine(),
          { id: 'w1', timestamp: '2026-11-16T09:41:00.000Z', content: 'careful', type: 'warning' },
          { id: 'e1', timestamp: '2026-11-16T09:41:01.000Z', content: 'boom', type: 'error' },
          { id: 'x1', timestamp: '2026-11-16T09:41:02.000Z', content: 'x', type: 'tool_group' },
        ]),
      ),
    );
    expect(Object.values(r.graph.nodes).map((n) => [n.kind, n.systemSubtype, n.title])).toEqual([
      ['system', 'warning', 'Warning'],
      ['system', 'error', 'Error'],
    ]);
    expect(r.unknown).toEqual(['gemini:tool_group']);
  });

  test('title falls back to the first prompt when there is no summary; status running while the last message is a user one', () => {
    const r = go(transcript(lines([metaLine(), userMsg(M1, '  first   prompt  '), userMsg('u2', 'second')])));
    expect(r.sessions.get(SID)).toMatchObject({ title: 'first prompt', status: 'running' });
  });

  test('garbage lines never throw and are reported', () => {
    const r = go(transcript(['[1]', '7', '{"id":', '{"$weird":1}', metaLine(), '{"id":"z","type":"user","content":{"weird":true}}']));
    expect(r.unknown).toEqual(['gemini:not-an-object', 'gemini:not-an-object', 'gemini:invalid-json', 'gemini:$weird', 'gemini:part.weird']);
  });
});

describe('rewind and removal', () => {
  test('$rewindTo emits node_removed for every node of the removed messages', () => {
    const n = new GeminiNormalizer();
    const before = run(n, transcript(exampleLines()));
    const out = n.apply(transcript([JSON.stringify({ $rewindTo: M2 })], { startOffset: 99999 })[0]!, PROJECT);
    const removed = out.changes.filter((c) => c.type === 'node_removed').map((c) => (c as { id: string }).id);
    expect(removed.sort()).toEqual([id(M2, 'thought:0'), id(M2, 'text'), id(M2, `call:${CALL_READ}`), id(M4, `call:${CALL_SHELL}`), id(M5, 'info')].sort());
    const graph = run(new GeminiNormalizer(), transcript([...exampleLines(), JSON.stringify({ $rewindTo: M2 })])).graph;
    expect(Object.keys(graph.nodes)).toEqual([id(M1, 'prompt')]);
    expect(Object.keys(graph.edges)).toEqual([]);
    expect(Object.keys(before.graph.nodes)).toHaveLength(6);
  });

  test('a message re-added after a rewind continues the chain from what is left', () => {
    const r = go(transcript([...exampleLines(), JSON.stringify({ $rewindTo: M4 }), JSON.stringify(userMsg('u9', 'again', '2026-11-16T09:50:00.000Z'))]));
    expect(nodeOf(r, id('u9', 'prompt')).parentId).toBe(id(M2, `call:${CALL_READ}`));
    expect(r.graph.nodes[id(M4, `call:${CALL_SHELL}`)]).toBeUndefined();
  });

  test('$patch removeIds removes one message; the next node is re-parented (node_updated)', () => {
    const n = new GeminiNormalizer();
    run(n, transcript(exampleLines()));
    const out = n.apply(transcript([JSON.stringify({ $patch: { removeIds: [M4] } })], { startOffset: 99999 })[0]!, PROJECT);
    expect(out.changes.filter((c) => c.type === 'node_removed').map((c) => (c as { id: string }).id)).toEqual([id(M4, `call:${CALL_SHELL}`)]);
    expect(out.changes).toContainEqual(expect.objectContaining({ type: 'node_updated', id: id(M5, 'info'), patch: expect.objectContaining({ parentId: id(M2, `call:${CALL_READ}`) }) }));
  });

  test('a re-appended message that lost its thoughts removes those nodes', () => {
    const r = go(transcript(lines([metaLine(), m2(0), { ...m2(0), thoughts: [] }])));
    expect(r.graph.nodes[id(M2, 'thought:0')]).toBeUndefined();
    expect(nodeOf(r, id(M2, 'text')).parentId).toBeNull();
  });

  test('$set.messages replaces every message: nodes of messages no longer there are removed', () => {
    const r = go(transcript([...exampleLines(), JSON.stringify({ $set: { messages: [userMsg(M1, 'Add a --verbose flag to cli.ts'), m5] } })]));
    expect(Object.keys(r.graph.nodes)).toEqual([id(M1, 'prompt'), id(M5, 'info')]);
    expect(nodeOf(r, id(M5, 'info')).parentId).toBe(id(M1, 'prompt'));
  });
});

describe('subagents', () => {
  const DISPATCH = id('a1e0c3d2-0006-4f00-8000-000000000006', 'call:call_dispatch_0');
  const SUB_PROMPT = id('sub-0001', 'prompt', SUB_ID);
  const main = (): RawEvent[] => transcript(lines([metaLine(), userMsg(M1, 'investigate'), dispatchMsg()]));

  test('a call whose agentId names a subagent thread → subagent node with childAgentId and a spawn edge', () => {
    const r = go([...main(), ...subEvents()]);
    expect(nodeOf(r, DISPATCH)).toMatchObject({ kind: 'subagent', childAgentId: SUB_ID, status: 'succeeded', title: 'codebase_investigator' });
    expect(nodeOf(r, SUB_PROMPT)).toMatchObject({ agentId: SUB_ID, parentId: DISPATCH, kind: 'prompt' });
    expect(r.graph.edges[`${DISPATCH}->${SUB_PROMPT}`]).toMatchObject({ kind: 'spawn' });
    expect(nodeOf(r, id('sub-0002', 'text', SUB_ID)).parentId).toBe(SUB_PROMPT);
    expect(r.sessions.get(SID)!.title).toBe('investigate');
  });

  test('the same graph whatever the arrival order (subagent file first, interleaved)', () => {
    const inOrder = shape(go([...main(), ...subEvents()]));
    expect(shape(go([...subEvents(), ...main()]))).toEqual(inOrder);
    for (const seed of [1, 2, 3, 4, 5]) expect(shape(go(interleave([main(), subEvents()], seed)))).toEqual(inOrder);
  });

  test('a call naming an agent with no thread is shown as the call itself (no child, no edge)', () => {
    const r = go(transcript(lines([metaLine(), { ...dispatchMsg(), toolCalls: [{ id: 'c9', name: 'read_file', args: {}, status: 'success', agentId: 'nobody' }] }])));
    expect(nodeOf(r, id('a1e0c3d2-0006-4f00-8000-000000000006', 'call:c9'))).toMatchObject({ kind: 'tool', childAgentId: null });
  });

  test('rewinding away the dispatch removes it; the subagent thread stays, detached (parentId null, no spawn edge)', () => {
    const r = go([...main(), ...subEvents(), ...transcript([JSON.stringify({ $rewindTo: 'a1e0c3d2-0006-4f00-8000-000000000006' })], { startOffset: 99999 })]);
    expect(r.graph.nodes[DISPATCH]).toBeUndefined();
    expect(nodeOf(r, SUB_PROMPT).parentId).toBeNull();
    expect(Object.values(r.graph.edges).some((e) => e.to === SUB_PROMPT || e.from === DISPATCH)).toBe(false);
    expect(r.changes).toContainEqual(expect.objectContaining({ type: 'node_updated', id: SUB_PROMPT, patch: expect.objectContaining({ parentId: null }) }));
  });
});

describe('legacy .json and project entries', () => {
  const finalMessages = [userMsg(M1, 'Add a --verbose flag to cli.ts'), m2(2), m3, m4(), m5];
  const LEGACY_KEY = 'gemini:demo-app/chats/session-2026-11-16T09-41-3f9c2a1b.json';

  test('a legacy whole object gives the graph the .jsonl gives (same nodes and edges)', () => {
    const legacy = go([meta(LEGACY_KEY, legacyJson(finalMessages, { summary: TITLE }))]);
    const jsonl = go(transcript(exampleLines()));
    expect(legacy.graph).toEqual(jsonl.graph);
    expect(legacy.sessions.get(SID)!.title).toBe(TITLE);
  });

  test('a legacy file read twice, the second time with one more message: no duplicates', () => {
    const r = go([meta(LEGACY_KEY, legacyJson(finalMessages.slice(0, 2))), meta(LEGACY_KEY, legacyJson(finalMessages))]);
    expect(Object.keys(r.graph.nodes)).toEqual(Object.keys(go(transcript(exampleLines())).graph.nodes));
    expect(r.changes.filter((c) => c.type === 'node_removed')).toEqual([]);
  });

  test('once the session’s .jsonl was read, its legacy .json is ignored', () => {
    const r = go([...transcript(exampleLines()), meta(LEGACY_KEY, legacyJson([userMsg('other', 'x')]))]);
    expect(Object.keys(r.graph.nodes)).toHaveLength(6);
  });

  test('a project entry sets project and cwd (before or after the records); file touches resolve against it', () => {
    const entry = meta(`${GEMINI_PROJECT_ENTRY_PREFIX}${SID}`, JSON.stringify({ cwd: '/home/dev/demo-app' }), { projectId: '-home-dev-demo-app' });
    const rel = { ...m2(2), toolCalls: [{ ...(m2(2).toolCalls as object[])[0]!, args: { file_path: 'src/cli.ts' } }] };
    const events = transcript(lines([metaLine(), userMsg(M1, 'go'), rel]));
    for (const order of [[entry, ...events], [...events, entry]]) {
      const r = go(order);
      expect(r.sessions.get(SID)).toMatchObject({ projectId: '-home-dev-demo-app', cwd: '/home/dev/demo-app' });
      expect(nodeOf(r, id(M2, `call:${CALL_READ}`)).files).toEqual([{ path: '/home/dev/demo-app/src/cli.ts', action: 'read' }]);
    }
    // An entry alone creates no session.
    expect(go([entry]).sessions.size).toBe(0);
  });
});

describe('batching and the registry', () => {
  test('one batch gives the graph and session one-by-one application gives', () => {
    const events = [...transcript([...exampleLines(), JSON.stringify(dispatchMsg())]), ...subEvents(), ...transcript([JSON.stringify({ $rewindTo: M4 })], { startOffset: 99999 })];
    const one = shape(go(events));
    const n = new GeminiNormalizer();
    const out = n.applyBatch(events.map((event) => ({ event, projectId: PROJECT })));
    const graph = applyChanges(emptyGraph(), out.changes);
    expect(graph.nodes).toEqual(one.nodes);
    expect(graph.edges).toEqual(one.edges);
    expect(out.changes.filter((c) => c.type === 'session_upserted').pop()).toEqual({ type: 'session_upserted', session: one.session });
  });

  test('NORMALIZER_FACTORIES.gemini makes a GeminiNormalizer', () => {
    expect(NORMALIZER_FACTORIES.gemini?.()).toBeInstanceOf(GeminiNormalizer);
  });
});

describe('fix round 1', () => {
  // I2 (removal cost) runs in gemini.timing.test.ts (the timing project).

  test('I3: endedAt is the first terminal time, the same line by line, in one batch, at every page boundary and after a re-hydrate', () => {
    const call = (status: string, ts: string) => ({ id: 'cx', name: 'run_shell_command', args: { command: 'make' }, status, timestamp: ts });
    const g = (status: string, ts: string) => JSON.stringify({ id: 'G', timestamp: '2026-11-16T10:00:00.000Z', type: 'gemini', content: '', toolCalls: [call(status, ts)] });
    const events = transcript([metaLine(), JSON.stringify(userMsg('U', 'go')), g('scheduled', '2026-11-16T10:00:01.000Z'), g('error', '2026-11-16T10:00:10.000Z'), g('success', '2026-11-16T10:00:20.000Z'), JSON.stringify(m5)]);
    const node = (graph: RunResult['graph']) => graph.nodes[id('G', 'call:cx')]!;
    const lineByLine = node(go(events).graph);
    expect(lineByLine).toMatchObject({ status: 'succeeded', endedAt: '2026-11-16T10:00:10.000Z', durationMs: 10_000 });
    for (let page = 1; page <= events.length; page++) {
      const n = new GeminiNormalizer();
      const changes: Change[] = [];
      for (let i = 0; i < events.length; i += page) changes.push(...n.applyBatch(events.slice(i, i + page).map((event) => ({ event, projectId: PROJECT }))).changes);
      expect(node(applyChanges(emptyGraph(), changes)), `page ${page}`).toEqual(lineByLine);
    }
    for (let cut = 1; cut < events.length; cut++) {
      const n = new GeminiNormalizer();
      const first = n.applyBatch(events.slice(0, cut).map((event) => ({ event, projectId: PROJECT }))).changes;
      n.dropSession(SID);
      n.applyBatch(events.slice(0, cut).map((event) => ({ event, projectId: PROJECT }))); // hydration (changes already stored)
      const rest = n.applyBatch(events.slice(cut).map((event) => ({ event, projectId: PROJECT }))).changes;
      expect(node(applyChanges(emptyGraph(), [...first, ...rest])), `cut ${cut}`).toEqual(lineByLine);
    }
  });

  test('I4: metadata and $set alone make no session; the first message does (start time from the metadata)', () => {
    const n = new GeminiNormalizer();
    const r = run(n, transcript(lines([metaLine(), { $set: { lastUpdated: '2026-11-16T09:41:08.000Z' } }])));
    expect(r.changes).toEqual([]);
    const next = n.apply(transcript([JSON.stringify(userMsg(M1, 'hello'))], { startOffset: 5000 })[0]!, PROJECT);
    expect(next.changes.find((c) => c.type === 'session_upserted')).toMatchObject({ session: { id: SID, startedAt: '2026-11-16T09:41:07.120Z', title: 'hello' } });
    // A legacy .json with no messages makes none either.
    expect(go([meta('gemini:demo-app/chats/session-x.json', legacyJson([]))]).sessions.size).toBe(0);
  });

  test('M1: an untimed first message gets the metadata startTime, line by line and in one batch', () => {
    const events = transcript(lines([metaLine(), { id: 'X1', content: [{ text: 'no ts' }], type: 'user' }]));
    const oneByOne = go(events).graph.nodes[id('X1', 'prompt')]!.timestamp;
    const batch = applyChanges(emptyGraph(), new GeminiNormalizer().applyBatch(events.map((event) => ({ event, projectId: PROJECT }))).changes).nodes[id('X1', 'prompt')]!.timestamp;
    expect(oneByOne).toBe('2026-11-16T09:41:07.120Z');
    expect(batch).toBe(oneByOne);
  });

  test('M2: a legacy .json seen before its .jsonl leaves nothing the .jsonl lacks', () => {
    const legacy = meta('gemini:demo-app/chats/session-2026-11-16T09-41-3f9c2a1b.json', legacyJson([userMsg(M1, 'a'), userMsg('OLDONLY', 'old')]));
    const jsonl = transcript(lines([metaLine(), userMsg(M1, 'a')]));
    const r = go([legacy, ...jsonl]);
    expect(Object.keys(r.graph.nodes)).toEqual([id(M1, 'prompt')]);
    expect(shape(r)).toEqual(shape(go(jsonl)));
  });

  test('M5: an unknown part key is named only when it looks like a schema key', () => {
    const r = go(transcript(lines([metaLine(), { id: 'p1', type: 'user', content: [{ 'sk-live-SECRET123 my password': 1 }] }, { id: 'p2', type: 'user', content: [{ newPartKind: 1 }] }])));
    expect(r.unknown).toEqual(['gemini:part', 'gemini:part.newPartKind']);
  });
});
