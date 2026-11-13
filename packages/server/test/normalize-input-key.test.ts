import { expect, test } from 'vitest';
import { applyChange, type Change, type Graph, type GraphNode } from '@agent-canvas/shared';
import { CodexNormalizer } from '../src/normalize/codex.js';
import { CursorNormalizer } from '../src/normalize/cursor.js';
import { inputKeyOf } from '../src/normalize/input-key.js';
import { Normalizer } from '../src/normalize/normalizer.js';
import { CodexThread, run as runCodex, type RunResult } from './codex-fixtures.js';
import { CursorConv } from './cursor-records.js';
import { assistantBlock, hook, run, toolResult, userPrompt } from './fixtures.js';

const KEY = /^[0-9a-f]{16}$/;
const use = (uuid: string, parent: string, id: string, name: string, input: unknown, over: { agentId?: string } = {}) =>
  assistantBlock(uuid, parent, { type: 'tool_use', id, name, input }, over);
/** A change as live consumers get it (through JSON: the store, the change log, the websocket). */
const applyTo = (graph: Graph, c: Change): Graph => applyChange(graph, JSON.parse(JSON.stringify(c)) as Change);
const nodeOf = (r: RunResult, id: string): GraphNode => {
  const n = r.graph.nodes[id];
  if (n === undefined) throw new Error(`no node ${id}`);
  return n;
};

// ---- Claude Code ----

test('Claude Code: tool and dispatch nodes carry inputKey; same input (any key order) same key, other input other key', () => {
  const { graph } = run(new Normalizer(), [
    userPrompt('u1', null, 'x'),
    use('a1', 'u1', 't1', 'Bash', { command: 'npm test', timeout: 1000 }),
    use('a2', 'a1', 't2', 'Bash', { timeout: 1000, command: 'npm test' }),
    use('a3', 'a2', 't3', 'Bash', { command: 'npm test', timeout: 2000 }),
    use('a4', 'a3', 't4', 'Agent', { description: 'd', prompt: 'p' }),
  ]);
  const k1 = graph.nodes['tool:t1']!.inputKey;
  expect(k1).toMatch(KEY);
  expect(k1).toBe(inputKeyOf('Bash', { command: 'npm test', timeout: 1000 }));
  expect(graph.nodes['tool:t2']!.inputKey).toBe(k1);
  expect(graph.nodes['tool:t3']!.inputKey).not.toBe(k1);
  expect(graph.nodes['tool:t4']).toMatchObject({ kind: 'subagent', inputKey: inputKeyOf('Agent', { description: 'd', prompt: 'p' }) });
  expect(graph.nodes['u1']).not.toHaveProperty('inputKey');
});

test('Claude Code: a hook-only node takes the key of its hook input, then follows the transcript input; rebuild equals live', () => {
  const events = [
    userPrompt('u1', null, 'x'),
    hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls', description: 'hook form' }, tool_use_id: 't1' }),
    use('a1', 'u1', 't1', 'Bash', { command: 'ls' }),
    toolResult('u2', 'a1', 't1', 'ok'),
  ];
  const live = new Normalizer();
  const first = run(live, events.slice(0, 2));
  expect(first.graph.nodes['tool:t1']!.inputKey).toBe(inputKeyOf('Bash', { command: 'ls', description: 'hook form' }));
  const rest = run(live, events.slice(2));
  const patch = rest.changes.find((c) => c.type === 'node_updated' && c.id === 'tool:t1');
  expect(patch).toMatchObject({ patch: { inputKey: inputKeyOf('Bash', { command: 'ls' }) } });
  const rebuilt = run(new Normalizer(), events);
  expect(rebuilt.graph.nodes['tool:t1']!.inputKey).toBe(inputKeyOf('Bash', { command: 'ls' }));
  // Live graph = the first chunk's graph with the second chunk's changes applied.
  let graph = first.graph;
  for (const c of rest.changes) graph = applyTo(graph, c);
  expect(graph.nodes).toEqual(rebuilt.graph.nodes);
});

test('Claude Code: the same record applied twice changes nothing about inputKey; a missing input is the key of {}', () => {
  const n = new Normalizer();
  const rec = use('a1', 'u1', 't1', 'Read', { file_path: '/a.ts' });
  run(n, [userPrompt('u1', null, 'x'), rec]);
  const again = run(n, [rec]);
  for (const c of again.changes) if (c.type === 'node_updated') expect(c.patch).not.toHaveProperty('inputKey');
  const { graph } = run(new Normalizer(), [userPrompt('u1', null, 'x'), use('a1', 'u1', 't1', 'Read', undefined)]);
  // The transcript parser stores a missing input as {} (what the detail shows): the key is that of {}.
  expect(graph.nodes['tool:t1']!.inputKey).toBe(inputKeyOf('Read', {}));
});

// ---- Codex ----

test('Codex: function calls, custom tool calls (string input) and spawn dispatches carry inputKey', () => {
  const root = new CodexThread({ id: 'cx1', cwd: '/work/app' });
  const events = [
    root.meta(),
    root.started('t1'),
    root.user('u1', 'x'),
    root.call('c1', 'shell', { command: ['bash', '-lc', 'ls'], workdir: '/work/app' }),
    root.output('c1', 'ok', 'function'),
    root.call('c2', 'shell', { workdir: '/work/app', command: ['bash', '-lc', 'ls'] }),
    root.output('c2', 'ok', 'function'),
    root.call('c3', 'shell', { workdir: '/work/app', command: ['bash', '-lc', 'ls -a'] }),
    root.output('c3', 'ok', 'function'),
    root.exec('c4', 'git status'),
    root.output('c4'),
    root.exec('c5', 'git status'),
    root.output('c5'),
    root.spawn('c6', 'helper'),
    root.complete(),
  ];
  const live = new CodexNormalizer();
  const head = runCodex(live, events.slice(0, 6));
  const tail = runCodex(live, events.slice(6));
  const r = runCodex(new CodexNormalizer(), events);
  const k1 = nodeOf(r, 'tool:c1').inputKey;
  expect(k1).toMatch(KEY);
  expect(nodeOf(r, 'tool:c2').inputKey).toBe(k1);
  expect(nodeOf(r, 'tool:c3').inputKey).not.toBe(k1);
  expect(nodeOf(r, 'tool:c4').inputKey).toBe(inputKeyOf('exec', 'git status'));
  expect(nodeOf(r, 'tool:c5').inputKey).toBe(nodeOf(r, 'tool:c4').inputKey);
  expect(nodeOf(r, 'tool:c6')).toMatchObject({ kind: 'subagent', inputKey: expect.stringMatching(KEY) });
  // Rebuild equals live.
  let graph = head.graph;
  for (const c of tail.changes) graph = applyTo(graph, c);
  expect(graph.nodes).toEqual(r.graph.nodes);
});

// ---- Cursor ----

test('Cursor: tool bubbles carry inputKey (params parsed, key order irrelevant); task dispatches too', () => {
  const c = new CursorConv({ id: 'c-root' });
  const r = runCodex(new CursorNormalizer(), [
    c.composer(),
    c.user('u1', 'go', 0),
    c.tool('t1', 'run_terminal_command_v2', 'completed', 1, { params: '{"command":"ls","cwd":"/w"}' }),
    c.tool('t2', 'run_terminal_command_v2', 'error', 3, { params: '{"cwd":"/w","command":"ls"}' }),
    c.tool('t3', 'run_terminal_command_v2', 'completed', 5, { params: '{"cwd":"/w","command":"ls -a"}' }),
    c.task('t4', 'tc4', 'completed', 7),
  ]);
  const k1 = nodeOf(r, c.node('t1')).inputKey;
  expect(k1).toBe(inputKeyOf('run_terminal_command_v2', { command: 'ls', cwd: '/w' }));
  expect(nodeOf(r, c.node('t2')).inputKey).toBe(k1);
  expect(nodeOf(r, c.node('t3')).inputKey).not.toBe(k1);
  expect(nodeOf(r, c.node('t4'))).toMatchObject({ kind: 'subagent', inputKey: expect.stringMatching(KEY) });
  expect(nodeOf(r, c.node('u1'))).not.toHaveProperty('inputKey');
});

test('Cursor: the key follows the latest version of a bubble; rebuild equals live', () => {
  const c = new CursorConv({ id: 'c-root' });
  const events = [
    c.composer(),
    c.user('u1', 'go', 0),
    c.tool('t1', 'run_terminal_command_v2', 'loading', 1, { params: '{"command":"npm te', over: { truncated: ['params'] } }),
  ];
  const later = c.update('t1', { toolFormerData: { status: 'completed', params: JSON.stringify({ command: 'npm test' }) }, truncated: [] });
  const live = new CursorNormalizer();
  const first = runCodex(live, events);
  expect(nodeOf(first, c.node('t1')).inputKey).toBe(inputKeyOf('run_terminal_command_v2', '{"command":"npm te'));
  const second = runCodex(live, [later]);
  const patch = second.changes.find((ch) => ch.type === 'node_updated' && ch.id === c.node('t1'));
  expect(patch).toMatchObject({ patch: { inputKey: inputKeyOf('run_terminal_command_v2', { command: 'npm test' }) } });
  let graph = first.graph;
  for (const ch of second.changes) graph = applyTo(graph, ch);
  const rebuilt = runCodex(new CursorNormalizer(), [...events, later]);
  expect(graph.nodes).toEqual(rebuilt.graph.nodes);
  const ref = runCodex(new CursorNormalizer({ checkpointEvery: Number.POSITIVE_INFINITY }), [...events, later]);
  expect(ref.graph.nodes).toEqual(rebuilt.graph.nodes);
});

// ---- fix round 1: a key that changes or whose input goes away ----

test('Claude Code: transcript record first, then a PreToolUse hook with another input: the key stays the transcript one', () => {
  const events = [
    userPrompt('u1', null, 'x'),
    use('a1', 'u1', 't1', 'Bash', { command: 'ls' }),
    hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls', description: 'hook form' }, tool_use_id: 't1' }),
  ];
  const r = run(new Normalizer(), events);
  expect(r.graph.nodes['tool:t1']!.inputKey).toBe(inputKeyOf('Bash', { command: 'ls' }));
  for (const c of r.changes) if (c.type === 'node_updated') expect(c.patch).not.toHaveProperty('inputKey');
});

test('Claude Code: a subagent (sidechain) tool node carries its key; an input cannot go away (a missing one is {})', () => {
  const { graph } = run(new Normalizer(), [
    userPrompt('u1', null, 'x'),
    use('a1', 'u1', 'tA', 'Agent', { description: 'd', prompt: 'p' }),
    userPrompt('s1', null, 'sub', { agentId: 'ag1', isSidechain: true }),
    use('s2', 's1', 'tS', 'Bash', { command: 'ls' }, { agentId: 'ag1' }),
  ]);
  expect(graph.nodes['tool:tS']).toMatchObject({ agentId: 'ag1', inputKey: inputKeyOf('Bash', { command: 'ls' }) });
  // The same tool_use rewritten without an input: the parser's {} — a new key, never none.
  const n = new Normalizer();
  run(n, [userPrompt('u1', null, 'x'), use('a1', 'u1', 't1', 'Bash', { command: 'ls' })]);
  const again = run(n, [use('a1', 'u1', 't1', 'Bash', undefined)]);
  expect(again.changes.find((c) => c.type === 'node_updated' && c.id === 'tool:t1')).toMatchObject({ patch: { inputKey: inputKeyOf('Bash', {}) } });
});

test('Codex: a call record repeated with another input changes nothing (the node and its detail keep the first)', () => {
  const root = new CodexThread({ id: 'cx9', cwd: '/w' });
  const events = [root.meta(), root.started('t1'), root.user('u1', 'x'), root.call('c1', 'shell', { command: ['ls'] })];
  const n = new CodexNormalizer();
  const first = runCodex(n, events);
  const again = runCodex(n, [root.call('c1', 'shell', { command: ['ls', '-a'] })]);
  expect(again.changes.filter((c) => c.type !== 'session_upserted')).toEqual([]);
  expect(nodeOf(first, 'tool:c1').inputKey).toBe(inputKeyOf('shell', { command: ['ls'] }));
});

test('Cursor: params that go away keep the last key, in the normalizer state too; rebuild equals live', () => {
  const c = new CursorConv({ id: 'c-root' });
  const events = [c.composer(), c.user('u1', 'go', 0), c.tool('t1', 'run_terminal_command_v2', 'loading', 1, { params: { command: 'ls' } })];
  const gone = c.update('t1', { toolFormerData: { status: 'completed', params: null } });
  const back = c.update('t1', { toolFormerData: { params: JSON.stringify({ command: 'ls' }) } });
  const key = inputKeyOf('run_terminal_command_v2', { command: 'ls' });
  const live = new CursorNormalizer();
  const first = runCodex(live, events);
  const second = runCodex(live, [gone]);
  for (const ch of second.changes) if (ch.type === 'node_updated') expect(ch.patch).not.toHaveProperty('inputKey');
  let graph = first.graph;
  for (const ch of second.changes) graph = applyTo(graph, ch);
  expect(graph.nodes[c.node('t1')]!.inputKey).toBe(key);
  const rebuilt = runCodex(new CursorNormalizer(), [...events, gone]);
  expect(rebuilt.graph.nodes).toEqual(graph.nodes);
  const ref = runCodex(new CursorNormalizer({ checkpointEvery: Number.POSITIVE_INFINITY }), [...events, gone]);
  expect(ref.graph.nodes).toEqual(graph.nodes);
  // The params come back unchanged: no patch (the state kept the key, as the graph did).
  const third = runCodex(live, [back]);
  for (const ch of third.changes) if (ch.type === 'node_updated') expect(ch.patch).not.toHaveProperty('inputKey');
});
