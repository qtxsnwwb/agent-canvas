import { describe, expect, test } from 'vitest';
import { applyChanges, emptyGraph, type Change, type GraphNode } from '@agent-canvas/shared';
import { copilotNodeId, CopilotNormalizer } from '../src/normalize/copilot.js';
import { copilotTouches } from '../src/normalize/files.js';
import { NORMALIZER_FACTORIES } from '../src/normalize/registry.js';
import type { RawEvent } from '../src/store/store.js';
import { run, type RunResult } from './codex-fixtures.js';
import { CWD, E, ev, exampleLines, PROJECT, SID, startLine, transcript, workspace, WORKSPACE_YAML } from './copilot-fixtures.js';

const go = (events: RawEvent[], n = new CopilotNormalizer()): RunResult => run(n, events);
const id = (part: string): string => copilotNodeId(SID, part);
const call = (toolCallId: string): string => id(`call:${toolCallId}`);
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
const shape = (r: { graph: RunResult['graph']; sessions: RunResult['sessions'] }) => ({ nodes: r.graph.nodes, edges: r.graph.edges, session: r.sessions.get(SID) });
const withStart = (lines: string[]): RawEvent[] => transcript([startLine(), ...lines]);
const T = (s: number): string => new Date(Date.parse('2026-11-12T08:00:00.000Z') + s * 1000).toISOString();

/** Applies events in batches of `page`, optionally dropping and re-hydrating the session at `cut`. */
function paged(events: RawEvent[], page: number, cut?: number): { graph: RunResult['graph']; sessions: RunResult['sessions'] } {
  const n = new CopilotNormalizer();
  const changes: Change[] = [];
  const items = (evs: RawEvent[]) => evs.map((event) => ({ event, projectId: PROJECT }));
  const feed = (evs: RawEvent[]): void => {
    for (let i = 0; i < evs.length; i += page) changes.push(...n.applyBatch(items(evs.slice(i, i + page))).changes);
  };
  if (cut === undefined) feed(events);
  else {
    feed(events.slice(0, cut));
    n.dropSession(SID);
    n.applyBatch(items(events.slice(0, cut))); // hydration: its changes are already stored
    feed(events.slice(cut));
  }
  const sessions = new Map<string, NonNullable<ReturnType<RunResult['sessions']['get']>>>();
  for (const c of changes) if (c.type === 'session_upserted') sessions.set(c.session.id, c.session);
  return { graph: applyChanges(emptyGraph(), changes), sessions };
}

describe('the example file, line by line (spec 5.3)', () => {
  const r = go(transcript(exampleLines()));
  const PROMPT = id(E(2));
  const THINK = id(E(4));
  const VIEW = call('call_01');
  const BASH = call('call_02');
  const TEXT = id(E(10));
  const TASK = call('call_03');
  const GREP = call('call_04');
  const END = id(E(16));

  test('nodes: prompt, thinking, tool(view), tool(bash), text, subagent, its grep, shutdown; nothing unknown', () => {
    expect(Object.keys(r.graph.nodes)).toEqual([PROMPT, THINK, VIEW, BASH, TEXT, TASK, GREP, END]);
    expect(Object.values(r.graph.nodes).map((n) => n.kind)).toEqual(['prompt', 'thinking', 'tool', 'tool', 'text', 'subagent', 'tool', 'system']);
    expect(r.unknown).toEqual([]);
  });

  test('the empty assistant.message with toolRequests adds no text node', () => {
    expect(r.graph.nodes[id(E(5))]).toBeUndefined();
  });

  test('main thread chained in file order with sequence edges; the turn is the prompt; the subagent thread hangs off its dispatch', () => {
    const order = [PROMPT, THINK, VIEW, BASH, TEXT, TASK, END];
    expect(nodeOf(r, PROMPT).parentId).toBeNull();
    for (let i = 1; i < order.length; i++) expect(nodeOf(r, order[i]!).parentId).toBe(order[i - 1]);
    for (const nid of [THINK, VIEW, BASH, TEXT, TASK]) expect(nodeOf(r, nid).turnId).toBe(PROMPT);
    expect(nodeOf(r, GREP)).toMatchObject({ parentId: TASK, agentId: 'agent-explore-1' });
    expect(Object.values(r.graph.edges).find((e) => e.to === GREP)).toMatchObject({ from: TASK, kind: 'spawn' });
    expect(Object.values(r.graph.edges).filter((e) => e.kind === 'sequence')).toHaveLength(order.length - 1);
  });

  test('prompt, thinking and text content', () => {
    expect(nodeOf(r, PROMPT)).toMatchObject({ title: 'Prompt', summary: 'Fix the typo in README', timestamp: '2026-11-10T09:00:05.000Z' });
    expect(detailOf(r, PROMPT)).toEqual({ text: 'Fix the typo in README' });
    expect(nodeOf(r, THINK)).toMatchObject({ title: 'Thinking', summary: 'Need to open README first.' });
    expect(nodeOf(r, TEXT)).toMatchObject({ title: 'Text', summary: 'Fixed the typo.', messageId: 'm-2' });
    expect(detailOf(r, TEXT)).toEqual({ text: 'Fixed the typo.' });
  });

  test('view: succeeded, read touch, output = result.content; one node for toolRequests + start', () => {
    expect(nodeOf(r, VIEW)).toMatchObject({
      kind: 'tool',
      title: 'view',
      toolName: 'view',
      toolUseId: 'call_01',
      status: 'succeeded',
      timestamp: '2026-11-10T09:00:08.000Z',
      endedAt: '2026-11-10T09:00:08.300Z',
      durationMs: 300,
      files: [{ path: '/home/dev/demo/README.md', action: 'read' }],
      summary: '/home/dev/demo/README.md',
    });
    expect(nodeOf(r, VIEW).inputKey).toMatch(/^[0-9a-f]{16}$/);
    expect(detailOf(r, VIEW)).toEqual({ input: { path: '/home/dev/demo/README.md' }, output: '1. # Demo\n2. Teh demo app.' });
  });

  test('bash: failed, output = error.message, summary = the command, no file touch', () => {
    expect(nodeOf(r, BASH)).toMatchObject({ status: 'failed', summary: 'npm test', endedAt: '2026-11-10T09:00:12.000Z', durationMs: 2000 });
    expect(nodeOf(r, BASH).files).toBeUndefined();
    expect(detailOf(r, BASH).output).toBe('Command exited with code 1');
  });

  test('subagent: title from subagent.started, succeeded by subagent.completed, linked child', () => {
    expect(nodeOf(r, TASK)).toMatchObject({ kind: 'subagent', title: 'Explore', status: 'succeeded', childAgentId: 'agent-explore-1', endedAt: '2026-11-11T10:00:30.000Z', summary: 'Read-only search' });
  });

  test('shutdown: a system node at its time with the session usage (sum over modelMetrics), no turn', () => {
    expect(nodeOf(r, END)).toMatchObject({ kind: 'system', systemSubtype: 'shutdown', timestamp: '2026-11-11T10:05:00.000Z', turnId: null, usage: { inputTokens: 5000, cachedInputTokens: 0, outputTokens: 300 } });
  });

  test('session: origin copilot, project as given, cwd and branch from session.start, title = first prompt, ended', () => {
    expect(r.sessions.get(SID)).toEqual({
      id: SID,
      projectId: PROJECT,
      origin: 'copilot',
      cwd: CWD,
      title: 'Fix the typo in README',
      gitBranch: 'main',
      status: 'ended',
      sourceDeleted: false,
      startedAt: '2026-11-10T09:00:00.000Z',
      lastActivityAt: '2026-11-11T10:05:00.000Z',
    });
  });

  test('one batch, every page size and a drop + re-hydrate at every cut give the same graph and session', () => {
    const events = transcript(exampleLines());
    const want = shape(r);
    for (let page = 1; page <= events.length; page++) expect(shape(paged(events, page)), `page ${page}`).toEqual(want);
    for (let cut = 1; cut < events.length; cut++) expect(shape(paged(events, 3, cut)), `cut ${cut}`).toEqual(want);
  });
});

describe('tool calls', () => {
  test('a toolRequests item without a later tool.execution_start still yields one tool node (running)', () => {
    const r = go(withStart([ev('assistant.message', { messageId: 'm', content: 'Let me look.', toolRequests: [{ toolCallId: 'c1', name: 'glob', arguments: { pattern: '**/*.ts' } }] }, { at: T(1) })]));
    const tools = Object.values(r.graph.nodes).filter((n) => n.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ id: call('c1'), status: 'running', toolName: 'glob', summary: '**/*.ts', endedAt: null });
    // The text comes first, the call after it.
    const text = Object.values(r.graph.nodes).find((n) => n.kind === 'text')!;
    expect(tools[0]!.parentId).toBe(text.id);
  });

  test('with a start and a complete: exactly one node', () => {
    const r = go(
      withStart([
        ev('assistant.message', { messageId: 'm', content: '', toolRequests: [{ toolCallId: 'c1', name: 'view', arguments: { path: 'a.ts' } }] }, { at: T(1) }),
        ev('tool.execution_start', { toolCallId: 'c1', toolName: 'view', arguments: { path: 'a.ts' } }, { at: T(2) }),
        ev('tool.execution_complete', { toolCallId: 'c1', success: true, result: { content: 'x' } }, { at: T(3) }),
      ]),
    );
    expect(Object.keys(r.graph.nodes)).toEqual([call('c1')]);
    expect(nodeOf(r, call('c1'))).toMatchObject({ status: 'succeeded', files: [{ path: `${CWD}/a.ts`, action: 'read' }] });
  });

  test('tool.execution_complete before its start ends in the same node: status kept, name and input filled in', () => {
    const r = go(
      withStart([
        ev('tool.execution_complete', { toolCallId: 'c9', success: false, error: { message: 'boom' } }, { at: T(3) }),
        ev('tool.execution_start', { toolCallId: 'c9', toolName: 'bash', arguments: { command: 'make' } }, { at: T(2) }),
      ]),
    );
    expect(Object.keys(r.graph.nodes)).toEqual([call('c9')]);
    expect(nodeOf(r, call('c9'))).toMatchObject({ status: 'failed', toolName: 'bash', title: 'bash', summary: 'make', endedAt: T(3) });
    expect(detailOf(r, call('c9'))).toEqual({ input: { command: 'make' }, output: 'boom' });
  });

  test('arguments given as a JSON string are parsed (files, summary, inputKey, detail)', () => {
    const asObject = go(withStart([ev('tool.execution_start', { toolCallId: 'c1', toolName: 'edit', arguments: { path: '/w/x.ts', old_str: 'a', new_str: 'b' } }, { at: T(1) })]));
    const asString = go(withStart([ev('tool.execution_start', { toolCallId: 'c1', toolName: 'edit', arguments: JSON.stringify({ path: '/w/x.ts', old_str: 'a', new_str: 'b' }) }, { at: T(1) })]));
    expect(nodeOf(asString, call('c1'))).toEqual(nodeOf(asObject, call('c1')));
    expect(nodeOf(asString, call('c1')).files).toEqual([{ path: '/w/x.ts', action: 'edit' }]);
    expect(detailOf(asString, call('c1'))).toEqual({ input: { path: '/w/x.ts', old_str: 'a', new_str: 'b' } });
    // Not JSON: kept as the string.
    const raw = go(withStart([ev('tool.execution_start', { toolCallId: 'c2', toolName: 'mystery', arguments: 'not json {' }, { at: T(1) })]));
    expect(detailOf(raw, call('c2'))).toEqual({ input: 'not json {' });
  });

  test('the tool table: create → write, powershell command, file path keys in order', () => {
    const r = go(
      withStart([
        ev('tool.execution_start', { toolCallId: 'w', toolName: 'create', arguments: { file_path: '/w/second.ts', path: '/w/first.ts' } }, { at: T(1) }),
        ev('tool.execution_start', { toolCallId: 'p', toolName: 'powershell', arguments: { fullCommandText: 'Get-ChildItem' } }, { at: T(2) }),
        ev('tool.execution_start', { toolCallId: 'f', toolName: 'view', arguments: { fileName: 'rel/name.md' } }, { at: T(3) }),
      ]),
    );
    expect(nodeOf(r, call('w')).files).toEqual([{ path: '/w/first.ts', action: 'write' }]); // path before file_path
    expect(nodeOf(r, call('p'))).toMatchObject({ summary: 'Get-ChildItem', kind: 'tool' });
    expect(nodeOf(r, call('f')).files).toEqual([{ path: `${CWD}/rel/name.md`, action: 'read' }]);
  });

  test('a task call is a subagent node even without a thread', () => {
    const r = go(withStart([ev('tool.execution_start', { toolCallId: 't1', toolName: 'task', arguments: { agent_type: 'general-purpose', prompt: 'look around' } }, { at: T(1) })]));
    expect(nodeOf(r, call('t1'))).toMatchObject({ kind: 'subagent', title: 'general-purpose', childAgentId: null, status: 'running' });
  });
});

describe('subagent threads (three linking steps)', () => {
  const dispatch = (cid: string, at: number) => ev('tool.execution_start', { toolCallId: cid, toolName: 'task', arguments: { agent_type: 'explore' } }, { at: T(at) });

  test('1: data.parentToolCallId', () => {
    const r = go(withStart([dispatch('t1', 1), dispatch('t2', 2), ev('tool.execution_start', { toolCallId: 'k1', toolName: 'grep', arguments: { pattern: 'x' }, parentToolCallId: 't2' }, { at: T(3), agentId: 'ag-A' })]));
    expect(nodeOf(r, call('k1')).parentId).toBe(call('t2'));
    expect(nodeOf(r, call('t2')).childAgentId).toBe('ag-A');
    expect(nodeOf(r, call('t1')).childAgentId).toBeNull();
  });

  test('2: agentId equal to a call’s toolCallId', () => {
    const r = go(withStart([dispatch('t1', 1), dispatch('t2', 2), ev('assistant.reasoning', { reasoningId: 'r', content: 'sub thinks' }, { at: T(3), agentId: 't1' })]));
    const think = Object.values(r.graph.nodes).find((n) => n.kind === 'thinking')!;
    expect(think).toMatchObject({ parentId: call('t1'), agentId: 't1' });
    expect(nodeOf(r, call('t1')).childAgentId).toBe('t1');
  });

  test('3: the first new agentId after a subagent.started', () => {
    const r = go(
      withStart([
        ev('subagent.started', { toolCallId: 's1', agentName: 'explore', agentDisplayName: 'Explore', agentDescription: 'd' }, { at: T(1) }),
        ev('assistant.message', { messageId: 'x', content: 'sub says' }, { at: T(2), agentId: 'ag-Z' }),
        ev('assistant.message', { messageId: 'y', content: 'another agent, no start left' }, { at: T(3), agentId: 'ag-Y' }),
      ]),
    );
    const texts = Object.values(r.graph.nodes).filter((n) => n.kind === 'text');
    expect(texts.find((n) => n.agentId === 'ag-Z')!.parentId).toBe(call('s1'));
    expect(nodeOf(r, call('s1'))).toMatchObject({ kind: 'subagent', title: 'Explore', childAgentId: 'ag-Z' });
    // None of the steps applies: the thread is still shown under the session, unattached.
    const lone = texts.find((n) => n.agentId === 'ag-Y')!;
    expect(lone.parentId).toBeNull();
    expect(Object.values(r.graph.edges).some((e) => e.to === lone.id)).toBe(false);
  });

  test('a thread seen unlinked is attached when a later event names its call (parentToolCallId)', () => {
    const r = go(
      withStart([
        ev('assistant.message', { messageId: 'x', content: 'early' }, { at: T(1), agentId: 'ag-L' }),
        dispatch('t5', 2),
        ev('assistant.message', { messageId: 'y', content: 'late', parentToolCallId: 't5' }, { at: T(3), agentId: 'ag-L' }),
      ]),
    );
    const first = Object.values(r.graph.nodes).find((n) => n.summary === 'early')!;
    expect(first.parentId).toBe(call('t5'));
    expect(nodeOf(r, call('t5')).childAgentId).toBe('ag-L');
    expect(Object.values(r.graph.edges).find((e) => e.to === first.id)).toMatchObject({ kind: 'spawn', from: call('t5') });
  });

  test('subagent.failed fails the dispatch with its error', () => {
    const r = go(withStart([ev('subagent.started', { toolCallId: 's1', agentName: 'a', agentDisplayName: 'A', agentDescription: '' }, { at: T(1) }), ev('subagent.failed', { toolCallId: 's1', agentName: 'a', agentDisplayName: 'A', error: 'ran out of time' }, { at: T(5) })]));
    expect(nodeOf(r, call('s1'))).toMatchObject({ status: 'failed', endedAt: T(5), durationMs: 4000 });
    expect(detailOf(r, call('s1')).output).toBe('ran out of time');
  });
});

describe('session lifecycle and usage', () => {
  test('session.shutdown → ended; usage summed over every model, cache reads and writes', () => {
    const metrics = {
      'model-a': { usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 400, cacheWriteTokens: 50 } },
      'model-b': { usage: { inputTokens: 200, outputTokens: 20 } },
      broken: { usage: 'n/a' },
    };
    const r = go(withStart([ev('user.message', { content: 'hi' }, { at: T(1) }), ev('session.shutdown', { shutdownType: 'routine', modelMetrics: metrics, codeChanges: {} }, { at: T(9), id: 'shut-1' })]));
    expect(r.sessions.get(SID)!.status).toBe('ended');
    expect(nodeOf(r, id('shut-1'))).toMatchObject({ usage: { inputTokens: 1250, cachedInputTokens: 400, outputTokens: 120 }, timestamp: T(9), title: 'Session ended' });
  });

  test('session.resume after a shutdown → running again (no node of its own)', () => {
    const r = go(withStart([ev('user.message', { content: 'hi' }, { at: T(1) }), ev('session.shutdown', { modelMetrics: {} }, { at: T(2) }), ev('session.resume', { resumeTime: T(3), eventCount: 3 }, { at: T(3) })]));
    expect(r.sessions.get(SID)!.status).toBe('running');
    expect(r.sessions.get(SID)!.lastActivityAt).toBe(T(3));
    expect(Object.values(r.graph.nodes).map((n) => n.kind)).toEqual(['prompt', 'system']);
  });

  test('a hook event after the shutdown does not revive the session', () => {
    const r = go(withStart([ev('session.shutdown', { modelMetrics: {} }, { at: T(2) }), ev('hook.end', { hookInvocationId: 'h', hookType: 'sessionEnd', success: true }, { at: T(3) })]));
    expect(r.sessions.get(SID)!.status).toBe('ended');
  });

  test('a session.start alone makes a session (no nodes); garbage or unknown records alone make none', () => {
    const r = go(transcript([startLine()]));
    expect(r.sessions.get(SID)).toMatchObject({ status: 'running', startedAt: '2026-11-12T08:00:00.000Z', cwd: CWD, gitBranch: 'dev', title: null });
    expect(Object.keys(r.graph.nodes)).toEqual([]);
    const g = go(transcript(['not json', '[1,2]', '{"type":"foo.bar","id":"x","timestamp":"2026-11-12T08:00:00.000Z","data":{}}', '{"type":"hook.start","data":{}}']));
    expect(g.changes).toEqual([]);
    expect(g.unknown).toEqual(['copilot:invalid-json', 'copilot:not-an-object', 'copilot:foo.bar']);
  });

  test('compaction, truncation, error and abort nodes', () => {
    const r = go(
      withStart([
        ev('session.compaction_complete', { success: true, summaryContent: 'Summary of the work so far' }, { at: T(1), id: 'cmp' }),
        ev('session.truncation', { tokensRemovedDuringTruncation: 900, messagesRemovedDuringTruncation: 4 }, { at: T(2), id: 'trn' }),
        ev('session.error', { errorType: 'api', message: 'Rate limited' }, { at: T(3), id: 'err' }),
        ev('abort', { reason: 'user_initiated' }, { at: T(4), id: 'abt' }),
      ]),
    );
    expect(nodeOf(r, id('cmp'))).toMatchObject({ kind: 'system', systemSubtype: 'compact', title: 'Compact', summary: 'Summary of the work so far' });
    expect(nodeOf(r, id('trn'))).toMatchObject({ kind: 'system', systemSubtype: 'compact', title: 'Truncation' });
    expect(nodeOf(r, id('err'))).toMatchObject({ kind: 'system', systemSubtype: 'error', title: 'Error', summary: 'Rate limited' });
    expect(nodeOf(r, id('abt'))).toMatchObject({ kind: 'system', systemSubtype: 'interrupt', title: 'Interrupted', summary: 'user_initiated' });
  });
});

describe('records that make no node', () => {
  test('the ignore list: no node and no unknown report', () => {
    const ignored = [
      'assistant.turn_start',
      'assistant.turn_end',
      'assistant.intent',
      'session.resume',
      'session.info',
      'session.idle',
      'session.model_change',
      'session.context_changed',
      'hook.start',
      'hook.end',
      'permission.requested',
      'permission.completed',
      'skill.invoked',
    ];
    const r = go(withStart([ev('user.message', { content: 'go' }, { at: T(1) }), ...ignored.map((t, i) => ev(t, { context: { cwd: '/elsewhere' } }, { at: T(2 + i) }))]));
    expect(r.unknown).toEqual([]);
    expect(Object.values(r.graph.nodes).map((n) => n.kind)).toEqual(['prompt']);
    // A later context does not move the session's project or cwd.
    expect(r.sessions.get(SID)).toMatchObject({ projectId: PROJECT, cwd: CWD });
  });

  test('an unknown type is reported as copilot:<type>, cut and cleaned; never a content value', () => {
    const r = go(withStart([ev('foo.bar', {}), ev(`weird type!${'x'.repeat(80)}`, {}), JSON.stringify({ id: 'q', data: {} })]));
    expect(r.unknown).toEqual(['copilot:foo.bar', `copilot:weirdtype${'x'.repeat(51)}`, 'copilot:?']);
  });

  test('never throws on malformed records of known types', () => {
    const odd = [
      '{"type":"user.message"}',
      '{"type":"user.message","data":null,"id":5}',
      '{"type":"assistant.message","data":{"toolRequests":[null,"x",{"name":7}]}}',
      '{"type":"tool.execution_complete","data":{}}',
      '{"type":"tool.execution_start","data":{"toolCallId":{}}}',
      '{"type":"session.shutdown","data":{"modelMetrics":[1,2]}}',
      '{"type":"subagent.completed","data":{"toolCallId":null}}',
      '{"type":"session.start","data":{"context":"nope"},"timestamp":"not a date"}',
    ];
    expect(() => go(withStart(odd))).not.toThrow();
  });

  test('an event repeated (same id, e.g. a file re-read after Copilot rewrote it) adds nothing twice', () => {
    const lines = exampleLines();
    const once = go(transcript(lines));
    const twice = go(transcript([...lines, ...lines.slice(1)]));
    expect(Object.keys(twice.graph.nodes)).toEqual(Object.keys(once.graph.nodes));
    expect(twice.graph).toEqual(once.graph);
    // Re-read after the shutdown: the old prompt and resume do not revive the session (the event is skipped whole).
    const again = go(transcript([...lines, lines[1]!, lines[11]!]));
    expect(shape(again)).toEqual(shape(once));
  });
});

describe('workspace.yaml (title and cwd)', () => {
  test('title: name > summary > first prompt, whichever arrives first', () => {
    const recs = transcript(exampleLines());
    expect(go([...recs, workspace(WORKSPACE_YAML)]).sessions.get(SID)!.title).toBe('Fix README typo');
    expect(go([workspace(WORKSPACE_YAML), ...recs]).sessions.get(SID)!.title).toBe('Fix README typo');
    expect(go([...recs, workspace('summary: Only a summary\n')]).sessions.get(SID)!.title).toBe('Only a summary');
    expect(go([...recs, workspace('cwd: /x\n')]).sessions.get(SID)!.title).toBe('Fix the typo in README');
    // A later workspace.yaml replaces the earlier one.
    expect(go([...recs, workspace(WORKSPACE_YAML), workspace('summary: s2\n')]).sessions.get(SID)!.title).toBe('s2');
  });

  test('cwd falls back to the workspace when session.start has none; a workspace alone makes no session', () => {
    const r = go([workspace('cwd: /home/dev/other\n'), ...transcript([ev('user.message', { content: 'hi' })])]);
    expect(r.sessions.get(SID)!.cwd).toBe('/home/dev/other');
    expect(go([workspace(WORKSPACE_YAML)]).changes).toEqual([]);
  });

  test('restorePreSession keeps a workspace stored before the first record', () => {
    const n = new CopilotNormalizer();
    n.restorePreSession(SID, [workspace(WORKSPACE_YAML)]);
    expect(n.hasSession(SID)).toBe(true);
    const r = go(transcript([startLine()]), n);
    expect(r.sessions.get(SID)!.title).toBe('Fix README typo');
  });
});

describe('determinism and cost', () => {
  test('endedAt is the first terminal time, the same in every batching and after a drop + re-hydrate', () => {
    const events = withStart([
      ev('subagent.started', { toolCallId: 's1', agentName: 'a', agentDisplayName: 'A', agentDescription: '' }, { at: T(1) }),
      ev('subagent.completed', { toolCallId: 's1', agentName: 'a', agentDisplayName: 'A' }, { at: T(10) }),
      ev('tool.execution_complete', { toolCallId: 's1', success: false, error: { message: 'late failure' } }, { at: T(20) }),
      ev('user.message', { content: 'more' }, { at: T(30) }),
    ]);
    const want = shape(go(events));
    expect(want.nodes[call('s1')]).toMatchObject({ status: 'failed', endedAt: T(10), durationMs: 9000 });
    for (let page = 1; page <= events.length; page++) expect(shape(paged(events, page)), `page ${page}`).toEqual(want);
    for (let cut = 1; cut < events.length; cut++) expect(shape(paged(events, 1, cut)), `cut ${cut}`).toEqual(want);
  });

  test('a 20,000-event session ingests line by line in well under 2 s (no per-event work proportional to the session)', () => {
    const lines: string[] = [startLine()];
    for (let i = 0; i < 4000; i++) {
      lines.push(ev('user.message', { content: `step ${i}` }, { at: T(i * 5) }));
      lines.push(ev('assistant.message', { messageId: `m${i}`, content: '', toolRequests: [{ toolCallId: `c${i}`, name: 'view', arguments: { path: `/w/f${i}.ts` } }] }, { at: T(i * 5 + 1) }));
      lines.push(ev('tool.execution_start', { toolCallId: `c${i}`, toolName: 'view', arguments: { path: `/w/f${i}.ts` } }, { at: T(i * 5 + 2) }));
      lines.push(ev('tool.execution_complete', { toolCallId: `c${i}`, success: true, result: { content: 'ok' } }, { at: T(i * 5 + 3) }));
      lines.push(ev('assistant.message', { messageId: `n${i}`, content: `done ${i}` }, { at: T(i * 5 + 4) }));
    }
    const events = transcript(lines);
    const n = new CopilotNormalizer();
    const t0 = performance.now();
    let nodes = 0;
    for (const e of events) for (const c of n.apply(e, PROJECT).changes) if (c.type === 'node_added') nodes++;
    const ms = performance.now() - t0;
    expect(nodes).toBe(12_000);
    expect(ms).toBeLessThan(2000);
  });

  test('NORMALIZER_FACTORIES.copilot makes a CopilotNormalizer', () => {
    expect(NORMALIZER_FACTORIES.copilot?.()).toBeInstanceOf(CopilotNormalizer);
  });
});

describe('copilotTouches (spec 5.3 tool table)', () => {
  test('view / create / edit / apply_patch; path keys in order; other tools none', () => {
    expect(copilotTouches('view', { path: 'a', file_path: 'b' })).toEqual([{ path: 'a', action: 'read' }]);
    expect(copilotTouches('create', { filePath: 'c' })).toEqual([{ path: 'c', action: 'write' }]);
    expect(copilotTouches('edit', { fileName: 'd', old_str: 'x', new_str: 'y' })).toEqual([{ path: 'd', action: 'edit' }]);
    expect(copilotTouches('apply_patch', { path: 'e' })).toEqual([{ path: 'e', action: 'edit' }]);
    for (const tool of ['bash', 'powershell', 'glob', 'grep', 'rg', 'task', 'web_fetch', 'unknown_tool']) expect(copilotTouches(tool, { path: '/x' }), tool).toEqual([]);
    expect(copilotTouches(null, { path: '/x' })).toEqual([]);
    expect(copilotTouches('view', null)).toEqual([]);
    expect(copilotTouches('view', { path: '   ' })).toEqual([]);
  });

  test('arguments as a JSON string are parsed first; apply_patch without a path reads its patch text', () => {
    expect(copilotTouches('view', JSON.stringify({ path: '/p.ts' }))).toEqual([{ path: '/p.ts', action: 'read' }]);
    const patch = ['*** Begin Patch', '*** Add File: new.ts', '+x', '*** Update File: old.ts', '@@', '-a', '+b', '*** End Patch', ''].join(String.fromCharCode(10));
    expect(copilotTouches('apply_patch', patch)).toEqual([{ path: 'new.ts', action: 'write' }, { path: 'old.ts', action: 'edit' }]);
    expect(copilotTouches('apply_patch', { input: patch })).toEqual([{ path: 'new.ts', action: 'write' }, { path: 'old.ts', action: 'edit' }]);
    expect(copilotTouches('apply_patch', JSON.stringify({ patch }))).toEqual([{ path: 'new.ts', action: 'write' }, { path: 'old.ts', action: 'edit' }]);
    expect(copilotTouches('view', 'not json')).toEqual([]);
  });
});
