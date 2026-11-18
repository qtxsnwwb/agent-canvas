import { describe, expect, test } from 'vitest';
import { applyChanges, emptyGraph, type Change, type Graph, type GraphNode, type Session, type Usage } from '@agent-canvas/shared';
import { qwenTouches } from '../src/normalize/files.js';
import { QwenNormalizer, qwenNodeId } from '../src/normalize/qwen.js';
import { NORMALIZER_FACTORIES } from '../src/normalize/registry.js';
import type { RawEvent } from '../src/store/store.js';
import {
  assistant,
  compression,
  customTitle,
  CWD,
  exampleSession,
  fcall,
  hiddenUser,
  HOOK,
  image,
  isoOf,
  line,
  Log,
  midTurn,
  NON_CONVERSATION,
  notification,
  PROJECT,
  qwenEvents,
  QUIET_SYSTEM,
  realtimeUser,
  sessionModel,
  SID,
  signatureOnly,
  slashCommand,
  system,
  T0,
  text,
  thought,
  turnResult,
  usageMeta,
} from './qwen-fixtures.js';

// The Qwen Code normalizer, main threads (spec 4, 5, 7, 8; docs/formats/qwen-code.md 2-4, 6). Expectations come
// from the spec's tables and the format reference, not from the implementation.

interface Folded {
  graph: Graph;
  details: Map<string, Record<string, unknown>>;
  session: Session | undefined;
  unknown: string[];
}

/** Folds changes as the store does: graph, merged details (dropped with their node), the last session row. */
function fold(changes: Change[], unknown: string[]): Folded {
  const details = new Map<string, Record<string, unknown>>();
  let session: Session | undefined;
  for (const c of changes) {
    if (c.type === 'node_added') details.set(c.node.id, { ...c.detail });
    else if (c.type === 'node_updated' && c.detail !== undefined && details.has(c.id)) details.set(c.id, { ...details.get(c.id), ...c.detail });
    else if (c.type === 'node_removed') details.delete(c.id);
    else if (c.type === 'session_upserted' && c.session.id === SID) session = c.session;
  }
  return { graph: applyChanges(emptyGraph(), changes), details, session, unknown };
}

const projectOf = (ev: RawEvent): string => (ev.source === 'transcript' && ev.projectId != null ? ev.projectId : 'unknown');

/** One event at a time through apply. */
function go(events: RawEvent[]): Folded {
  const n = new QwenNormalizer();
  const changes: Change[] = [];
  const unknown: string[] = [];
  for (const ev of events) {
    const r = n.apply(ev, projectOf(ev));
    changes.push(...r.changes);
    if (r.unknownRecordType !== undefined) unknown.push(r.unknownRecordType);
  }
  return fold(changes, unknown);
}

/** In pages through applyBatch; with `cut`, the session is dropped there and re-hydrated from the events before it. */
function paged(events: RawEvent[], page: number, cut?: number): Folded {
  const n = new QwenNormalizer();
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
    n.applyBatch(items(events.slice(0, cut))); // a rebuild: these changes are in the store already
    feed(events.slice(cut));
  }
  return fold(changes, unknown);
}

const comparable = (f: Folded) => ({ nodes: f.graph.nodes, edges: f.graph.edges, details: Object.fromEntries([...f.details].sort()), session: f.session });

/** Line by line, and asserts that one batch, pages of 2 and 3, and a rebuild at every cut give the same graph, details, usage, title and status. */
function run(events: RawEvent[]): Folded {
  const f = go(events);
  const want = comparable(f);
  expect(comparable(paged(events, Math.max(1, events.length)))).toEqual(want);
  expect(comparable(paged(events, 2))).toEqual(want);
  expect(comparable(paged(events, 3))).toEqual(want);
  for (let cut = 1; cut < events.length; cut++) expect(comparable(paged(events, 2, cut)), `rebuild at ${cut}`).toEqual(want);
  // The unknown counts too: a rebuild does not count again what was counted (the replayed batch's labels are discarded).
  expect(paged(events, 2).unknown).toEqual(f.unknown);
  return f;
}

const N = (uuid: string, part: string): string => qwenNodeId(SID, null, uuid, part);
const nodeOf = (f: Folded, id: string): GraphNode => {
  const n = f.graph.nodes[id];
  if (n === undefined) throw new Error(`no node ${id}; have ${Object.keys(f.graph.nodes).join(', ')}`);
  return n;
};
const ids = (f: Folded): string[] => Object.keys(f.graph.nodes);
const edgeIds = (f: Folded): string[] => Object.keys(f.graph.edges).sort();
const chainEdges = (list: string[]): string[] => list.slice(1).map((id, k) => `${list[k]}->${id}`).sort();
const usage = (inputTokens: number, cachedInputTokens: number, outputTokens: number): Usage => ({ inputTokens, cachedInputTokens, outputTokens });
const totalUsage = (f: Folded): Usage => {
  const t = usage(0, 0, 0);
  for (const n of Object.values(f.graph.nodes)) {
    if (n.usage === null) continue;
    t.inputTokens += n.usage.inputTokens;
    t.cachedInputTokens! += n.usage.cachedInputTokens ?? 0;
    t.outputTokens += n.usage.outputTokens;
  }
  return t;
};
const ev = (log: Log): RawEvent[] => qwenEvents(log.lines);

describe('the example session', () => {
  const { log, ids: u } = exampleSession();
  const events = ev(log);
  const f = run(events);
  const ts = (k: string): string => isoOf(T0 + (log.lines.findIndex((l) => JSON.parse(l).uuid === u[k]) + 1) * 1000);

  test('nodes in chain order, one per shown part; session_model and turn_result show nothing; nothing unknown', () => {
    expect(f.unknown).toEqual([]);
    const want = [N(u.p1!, 'prompt'), N(u.a1!, 'thought:0'), N(u.a1!, 'text:1'), N(u.a1!, 'call:call_a1'), N(u.a2!, 'text:0')];
    expect(ids(f)).toEqual(want);
    expect(edgeIds(f)).toEqual(chainEdges(want));
    expect(Object.values(f.graph.edges).every((e) => e.kind === 'sequence')).toBe(true);
  });

  test('the prompt: displayText, its own turn, the record time', () => {
    expect(nodeOf(f, N(u.p1!, 'prompt'))).toMatchObject({ kind: 'prompt', title: 'Prompt', summary: 'fix the flaky upload test', parentId: null, turnId: N(u.p1!, 'prompt'), agentId: null, timestamp: ts('p1'), messageId: u.p1 });
    expect(f.details.get(N(u.p1!, 'prompt'))).toEqual({ text: 'fix the flaky upload test' });
  });

  test('the reply: thinking first (holding the usage, Qwen OAuth rule), then text, then the call; model in the detail', () => {
    expect(nodeOf(f, N(u.a1!, 'thought:0'))).toMatchObject({ kind: 'thinking', title: 'Thinking', summary: 'The test races the cleanup.', turnId: N(u.p1!, 'prompt'), usage: usage(822, 17_408, 212) });
    expect(f.details.get(N(u.a1!, 'thought:0'))).toEqual({ text: 'The test races the cleanup.', raw: { model: 'qwen3-coder-plus' } });
    expect(nodeOf(f, N(u.a1!, 'text:1'))).toMatchObject({ kind: 'text', title: 'Text', usage: null });
  });

  test('the call and its result are one tool node: status, times, file, output, resultDisplay', () => {
    const c = nodeOf(f, N(u.a1!, 'call:call_a1'));
    expect(c).toMatchObject({ kind: 'tool', title: 'read_file', toolName: 'read_file', toolUseId: 'call_a1', status: 'succeeded', summary: 'test/upload.test.ts', usage: null, endedAt: ts('r1'), durationMs: 1000 });
    expect(c.files).toEqual([{ path: `${CWD}/test/upload.test.ts`, action: 'read' }]);
    expect(c.inputKey).toMatch(/^[0-9a-f]{16}$/);
    expect(f.details.get(N(u.a1!, 'call:call_a1'))).toEqual({ input: { file_path: 'test/upload.test.ts' }, output: "import { test } from 'vitest'", raw: { model: 'qwen3-coder-plus', resultDisplay: 'Read 84 lines' } });
  });

  test('the final reply holds its own usage', () => {
    expect(nodeOf(f, N(u.a2!, 'text:0')).usage).toEqual(usage(600, 18_000, 40));
  });

  test('session: bare id, origin, project, cwd, title from the first prompt, idle after turn_result, times', () => {
    expect(f.session).toMatchObject({ id: SID, origin: 'qwen', projectId: PROJECT, cwd: CWD, title: 'fix the flaky upload test', status: 'idle', startedAt: isoOf(T0 + 1000), lastActivityAt: ts('t1') });
  });

  test('registered as the qwen normalizer', () => {
    expect(NORMALIZER_FACTORIES.qwen?.()).toBeInstanceOf(QwenNormalizer);
  });

  test('node ids include the session id: a /branch copy with the same uuids is another set of nodes', () => {
    const other = '9c1e0c9a-5d2f-4e61-8a70-1c2d3e4f5a6b';
    const n = new QwenNormalizer();
    const copy = qwenEvents(log.lines.map((l) => l.replace(SID, other)), { sessionId: other });
    for (const e of events) n.apply(e, PROJECT);
    const added = copy.flatMap((e) => n.apply(e, PROJECT).changes).filter((c) => c.type === 'node_added');
    expect(added.map((c) => (c.type === 'node_added' ? c.node.id : ''))).toContain(qwenNodeId(other, null, u.p1!, 'prompt'));
    expect(qwenNodeId(other, null, u.p1!, 'prompt')).not.toBe(N(u.p1!, 'prompt'));
  });
});

describe('user records (spec 4.1)', () => {
  test('a mod prompt is a system node; mid-turn, realtime prompts are prompts; notification and cron are system nodes; hidden kinds show nothing', () => {
    const log = new Log();
    const p = log.prompt('first');
    const mid = log.add((env) => midTurn('also check b.ts', env));
    const mod = log.prompt('mod text', { provenance: 'mod_prompt', payload: { displayText: 'from a mod', hookContext: '', mod: 'm' } });
    const noteA = log.add((env) => notification('Background agent finished', env));
    const noteB = log.add((env) => notification(undefined, env, 'notification', 'fallback text'));
    const cron = log.add((env) => notification('nightly', env, 'cron'));
    const rt = log.add((env) => realtimeUser('spoken words', env));
    const rta = log.reply([text('spoken answer')], { subtype: 'realtime_message' });
    for (const s of ['goal_runtime', 'agent_mention', 'agent_message'] as const) log.add((env) => hiddenUser(s, env));
    const f = run(ev(log));
    expect(f.unknown).toEqual([]);
    expect(ids(f)).toEqual([N(p, 'prompt'), N(mid, 'prompt'), N(mod, 'system'), N(noteA, 'system'), N(noteB, 'system'), N(cron, 'system'), N(rt, 'prompt'), N(rta, 'text:0')]);
    expect(nodeOf(f, N(mid, 'prompt'))).toMatchObject({ kind: 'prompt', summary: 'also check b.ts', turnId: N(p, 'prompt') });
    expect(nodeOf(f, N(mod, 'system'))).toMatchObject({ kind: 'system', title: 'Mod prompt', systemSubtype: 'mod_prompt', summary: 'from a mod', turnId: N(mod, 'system') });
    expect(nodeOf(f, N(noteA, 'system'))).toMatchObject({ kind: 'system', title: 'Notification', systemSubtype: 'notification', summary: 'Background agent finished', turnId: N(mod, 'system') });
    expect(f.details.get(N(noteB, 'system'))).toEqual({ text: 'fallback text' });
    expect(nodeOf(f, N(cron, 'system'))).toMatchObject({ title: 'Cron', systemSubtype: 'cron', summary: 'nightly' });
    expect(nodeOf(f, N(rt, 'prompt'))).toMatchObject({ kind: 'prompt', summary: 'spoken words', turnId: N(rt, 'prompt') });
    expect(nodeOf(f, N(rta, 'text:0'))).toMatchObject({ kind: 'text', summary: 'spoken answer', turnId: N(rt, 'prompt') });
  });

  test('prompt text: the three rules of spec 4.3; an empty displayText is still a prompt; images', () => {
    const log = new Log();
    const a = log.prompt('typed text');
    const b = log.prompt('', { payload: { displayText: '', hookContext: '' } });
    const c = log.prompt('ignored', { payload: null, parts: [text('old '), text('style'), text(HOOK)] });
    const d = log.prompt('ignored', { payload: null, parts: [text('look'), image()] });
    const f = run(ev(log));
    expect(f.details.get(N(a, 'prompt'))).toEqual({ text: 'typed text' });
    expect(nodeOf(f, N(b, 'prompt'))).toMatchObject({ kind: 'prompt', summary: '' });
    expect(f.details.get(N(b, 'prompt'))).toEqual({ text: '' });
    expect(f.details.get(N(c, 'prompt'))).toEqual({ text: 'old style' });
    expect(f.details.get(N(d, 'prompt'))).toEqual({ text: 'look\n[image]' });
  });

  test('unknown subtypes of user, assistant and tool_result are counted and show nothing, but stay links of the chain', () => {
    const log = new Log();
    const p = log.prompt('ask');
    log.add((env) => line('user', 'brand_new', env, { message: { role: 'user', parts: [text('x')] } }));
    log.add((env) => line('assistant', 'brand_new', env, { message: { role: 'model', parts: [text('x')] } }));
    log.add((env) => line('tool_result', 'brand_new', env, { message: { role: 'user', parts: [] } }));
    const a = log.reply([text('after')]);
    const f = run(ev(log));
    expect(f.unknown).toEqual(['qwen:user/brand_new', 'qwen:assistant/brand_new', 'qwen:tool_result/brand_new']);
    expect(ids(f)).toEqual([N(p, 'prompt'), N(a, 'text:0')]);
    expect(f.graph.edges[`${N(p, 'prompt')}->${N(a, 'text:0')}`]).toBeDefined();
  });
});

describe('assistant records (spec 4.1)', () => {
  test('part order kept; signature-only parts show nothing; a signed part with text is text; images are [image] text nodes', () => {
    const log = new Log();
    log.prompt('go');
    const a = log.reply([text('first'), thought('then think', 'sig'), signatureOnly(), { text: 'signed visible', thoughtSignature: 'x' }, image(), fcall('run_shell_command', { command: 'ls' }, 'c1'), text('last')]);
    const f = run(ev(log));
    expect(ids(f).slice(1)).toEqual([N(a, 'text:0'), N(a, 'thought:1'), N(a, 'text:3'), N(a, 'text:4'), N(a, 'call:c1'), N(a, 'text:6')]);
    expect(f.details.get(N(a, 'text:4'))).toMatchObject({ text: '[image]' });
    expect(nodeOf(f, N(a, 'call:c1'))).toMatchObject({ kind: 'tool', status: 'running', endedAt: null, summary: 'ls' });
  });

  test('an empty or whitespace text part shows nothing; a reply that shows nothing puts its usage on the node before it', () => {
    const log = new Log();
    const p = log.prompt('go');
    log.reply([text('  '), signatureOnly()], { usage: usageMeta(100, 10) });
    const f = run(ev(log));
    expect(ids(f)).toEqual([N(p, 'prompt')]);
    expect(nodeOf(f, N(p, 'prompt')).usage).toEqual(usage(100, 0, 10));
  });

  test('fragments: a repeated uuid appends its parts; the last usage counts once; model from the first', () => {
    const log = new Log();
    const p = log.prompt('go');
    const a = log.reply([thought('part one')], { usage: usageMeta(100, 5) });
    log.add((env) => assistant([text('part two')], env, { model: 'other-model', usage: usageMeta(100, 20) }), { uuid: a, parent: p });
    const f = run(ev(log));
    expect(ids(f)).toEqual([N(p, 'prompt'), N(a, 'thought:0'), N(a, 'text:1')]);
    expect(nodeOf(f, N(a, 'thought:0')).usage).toEqual(usage(100, 0, 20));
    expect(f.details.get(N(a, 'text:1'))).toEqual({ text: 'part two', raw: { model: 'qwen3-coder-plus' } });
    expect(totalUsage(f)).toEqual(usage(100, 0, 20));
  });

  test('a fragment of a record that is not the leaf: its new nodes come before the later records', () => {
    const log = new Log();
    const p = log.prompt('go');
    const a = log.reply([text('one')]);
    const b = log.reply([text('next')]);
    log.add((env) => assistant([text('two')], env), { uuid: a, parent: p, advance: false });
    const f = run(ev(log));
    const want = [N(p, 'prompt'), N(a, 'text:0'), N(a, 'text:1'), N(b, 'text:0')];
    expect(ids(f).sort()).toEqual([...want].sort());
    expect(edgeIds(f)).toEqual(chainEdges(want));
    expect(nodeOf(f, N(b, 'text:0')).parentId).toBe(N(a, 'text:1'));
  });

  test('a fragment before a reply that shows nothing: that reply’s usage moves to the new last node, counted once; results stay paired', () => {
    const log = new Log();
    const p = log.prompt('go');
    const a = log.reply([fcall('t', {}, 'k')], { usage: usageMeta(100, 10) });
    log.result('t', 'out', { id: 'k' });
    log.reply([signatureOnly()], { usage: usageMeta(50, 5) });
    log.add((env) => assistant([text('more of a')], env), { uuid: a, parent: p, advance: false });
    const f = run(ev(log));
    expect(totalUsage(f)).toEqual(usage(150, 0, 15));
    expect(nodeOf(f, N(a, 'text:1')).usage).toEqual(usage(50, 0, 5));
    expect(nodeOf(f, N(a, 'call:k'))).toMatchObject({ status: 'succeeded', usage: usage(100, 0, 10) });
    expect(f.details.get(N(a, 'call:k'))?.output).toBe('out');
  });
});

describe('tool calls and results (spec 4.2)', () => {
  test('parallel calls, results in any order; each record re-emits the call node', () => {
    const log = new Log();
    log.prompt('go');
    const a = log.reply([fcall('read_file', { file_path: 'a.ts' }, 'x1'), fcall('read_file', { file_path: 'b.ts' }, 'x2')]);
    log.result('read_file', 'B', { id: 'x2' });
    log.result('read_file', 'A', { id: 'x1' });
    const f = run(ev(log));
    expect(nodeOf(f, N(a, 'call:x1')).status).toBe('succeeded');
    expect(f.details.get(N(a, 'call:x1'))?.output).toBe('A');
    expect(f.details.get(N(a, 'call:x2'))?.output).toBe('B');
  });

  test('a result without id pairs with the first call of its name without a result in the reply it follows', () => {
    const log = new Log();
    log.prompt('go');
    const a = log.reply([fcall('glob', { pattern: '*.ts' }), fcall('glob', { pattern: '*.md' }), fcall('read_file', { path: 'z' })]);
    log.result('glob', 'first', { id: null });
    log.result('glob', 'second', { id: null });
    const f = run(ev(log));
    expect(f.unknown).toEqual([]);
    expect(f.details.get(N(a, 'call#0'))?.output).toBe('first');
    expect(f.details.get(N(a, 'call#1'))?.output).toBe('second');
    expect(nodeOf(f, N(a, 'call#2')).status).toBe('running');
  });

  test('an orphan result is dropped and counted; the nearest call of a reused id without a result is taken', () => {
    const log = new Log();
    log.prompt('go');
    log.result('read_file', 'nobody asked', { id: 'zzz' });
    const a = log.reply([fcall('read_file', { path: 'a' }, 'dup')]);
    const b = log.reply([fcall('read_file', { path: 'b' }, 'dup')]);
    log.result('read_file', 'to b', { id: 'dup' });
    log.result('read_file', 'to a', { id: 'dup' });
    log.result('read_file', 'none left', { id: 'dup' });
    const f = run(ev(log));
    expect(f.unknown).toEqual(['qwen:orphan-result', 'qwen:orphan-result']);
    expect(f.details.get(N(b, 'call:dup'))?.output).toBe('to b');
    expect(f.details.get(N(a, 'call:dup'))?.output).toBe('to a');
  });

  test('status: error status, an error in the response, cancelled (noted), success; output falls back to the error text', () => {
    const log = new Log();
    log.prompt('go');
    const a = log.reply([fcall('t', {}, 'e1'), fcall('t', {}, 'e2'), fcall('t', {}, 'c1'), fcall('t', {}, 's1')]);
    log.result('t', null, { id: 'e1', status: 'error', error: 'boom' });
    log.result('t', null, { id: 'e2', status: 'success', error: 'in the response' });
    log.result('t', 'partial', { id: 'c1', status: 'cancelled' });
    log.result('t', 'fine', { id: 's1', noStatus: true });
    const f = run(ev(log));
    expect(nodeOf(f, N(a, 'call:e1')).status).toBe('failed');
    expect(f.details.get(N(a, 'call:e1'))?.output).toBe('boom');
    expect(nodeOf(f, N(a, 'call:e2')).status).toBe('failed');
    expect(nodeOf(f, N(a, 'call:c1')).status).toBe('failed');
    expect(f.details.get(N(a, 'call:c1'))).toMatchObject({ output: 'partial', raw: { model: 'qwen3-coder-plus', cancelled: true } });
    expect(nodeOf(f, N(a, 'call:s1')).status).toBe('succeeded');
  });

  test('code_mode_tool_result and tool_loop_end show nothing and complete nothing', () => {
    const log = new Log();
    log.prompt('go');
    const a = log.reply([fcall('t', {}, 'k')]);
    log.result('t', 'nested', { id: 'k', subtype: 'code_mode_tool_result' });
    log.result('t', 'end', { id: 'k', subtype: 'tool_loop_end' });
    const f = run(ev(log));
    expect(f.unknown).toEqual([]);
    expect(nodeOf(f, N(a, 'call:k')).status).toBe('running');
  });

  test('the agent tool (and its old name task) is a subagent dispatch titled by subagent_type', () => {
    const log = new Log();
    log.prompt('go');
    const a = log.reply([fcall('agent', { description: 'd', prompt: 'p', subagent_type: 'Explore' }, 'call_b7'), fcall('task', { prompt: 'p' }, 'call_b8')]);
    const f = run(ev(log));
    expect(nodeOf(f, N(a, 'call:call_b7'))).toMatchObject({ kind: 'subagent', title: 'Explore', toolName: 'agent', childAgentId: null });
    expect(nodeOf(f, N(a, 'call:call_b8'))).toMatchObject({ kind: 'subagent', title: 'task' });
  });

  test('a result leaves with its record: the call is running again, its output gone', () => {
    const log = new Log();
    log.prompt('go');
    const a = log.reply([fcall('t', {}, 'k')]);
    log.result('t', 'out', { id: 'k' });
    log.rewindTo(a);
    const f = run(ev(log));
    expect(nodeOf(f, N(a, 'call:k'))).toMatchObject({ status: 'running', endedAt: null, durationMs: null });
    expect(f.details.get(N(a, 'call:k'))?.output ?? null).toBeNull();
  });
});

describe('system records (spec 4.4)', () => {
  test('chat_compression: a Compact node with the two counts; the compressed history goes nowhere; earlier nodes stay', () => {
    const log = new Log();
    const p = log.prompt('go');
    const c = log.add((env) => compression(env));
    const f = run(ev(log));
    expect(ids(f)).toEqual([N(p, 'prompt'), N(c, 'compact')]);
    expect(nodeOf(f, N(c, 'compact'))).toMatchObject({ kind: 'system', title: 'Compact', systemSubtype: 'compact' });
    expect(nodeOf(f, N(c, 'compact')).summary).toMatch(/182000.*21000/);
    expect(JSON.stringify([...f.details.values()])).not.toContain('SECRET-HISTORY');
    expect(JSON.stringify(f.graph)).not.toContain('SECRET-HISTORY');
  });

  test('slash_command: an invocation is a Command node; a result or a hidden invocation shows nothing', () => {
    const log = new Log();
    log.prompt('go');
    const s = log.add((env) => slashCommand('/compress', env));
    log.add((env) => slashCommand('/about', env, 'result'));
    log.add((env) => slashCommand('/secret', env, 'invocation', true));
    const f = run(ev(log));
    expect(ids(f).slice(1)).toEqual([N(s, 'command')]);
    expect(nodeOf(f, N(s, 'command'))).toMatchObject({ kind: 'system', title: 'Command', systemSubtype: 'slash_command', summary: '/compress' });
  });

  test('every listed subtype that shows nothing: no node, not unknown; an unlisted one is counted as system/<subtype>', () => {
    const log = new Log();
    const p = log.prompt('go');
    for (const [s, payload] of Object.entries(QUIET_SYSTEM)) log.sys(s, payload);
    log.sys('turn_attempt');
    log.sys('never_heard_of');
    const after = log.reply([text('still chained')]);
    const f = run(ev(log));
    expect(f.unknown).toEqual(['qwen:system/never_heard_of']);
    expect(ids(f)).toEqual([N(p, 'prompt'), N(after, 'text:0')]);
    expect(f.graph.edges[`${N(p, 'prompt')}->${N(after, 'text:0')}`]).toBeDefined();
  });

  test('records that are not conversation records: never the leaf, never a link (a record hanging off one is a gap)', () => {
    const log = new Log();
    const p = log.prompt('go');
    const a = log.reply([text('answer')]);
    for (const s of NON_CONVERSATION) log.sys(s, {}, { advance: false });
    const f = run(ev(log));
    expect(f.unknown).toEqual([]);
    expect(ids(f)).toEqual([N(p, 'prompt'), N(a, 'text:0')]);
    // A conversation record whose parent is a snapshot: the walk stops there (a history gap, counted once).
    const snap = log.sys('session_artifact_snapshot', {}, { advance: true });
    const x = log.reply([text('after the snapshot')], { parent: snap });
    const g = run(ev(log));
    expect(ids(g)).toEqual([N(x, 'text:0')]);
    expect(g.unknown).toEqual(['qwen:history-gap']);
  });
});

describe('invalid lines (spec 4)', () => {
  test('each kind is skipped and counted; the rest goes on', () => {
    const log = new Log();
    const p = log.prompt('go');
    const bad = [
      'not json',
      '[1,2]',
      JSON.stringify({ parentUuid: null, sessionId: SID, type: 'user' }),
      JSON.stringify({ uuid: 'x1', parentUuid: 5, sessionId: SID, type: 'user' }),
      JSON.stringify({ uuid: 'x2', sessionId: SID, type: 'user' }),
      JSON.stringify({ uuid: 'x3', parentUuid: null, sessionId: 7, type: 'user' }),
      JSON.stringify({ uuid: 'x4', parentUuid: null, sessionId: SID, type: 'gemini' }),
      line('user', undefined, { uuid: 'x5', parentUuid: null, sessionId: 'another-session' }, { message: { role: 'user', parts: [text('elsewhere')] } }),
    ];
    const lines = [...log.lines, ...bad];
    const a = log.reply([text('answer')]);
    lines.push(log.lines[log.lines.length - 1]!);
    const f = run(qwenEvents(lines));
    expect(f.unknown).toEqual(['qwen:invalid-json', 'qwen:invalid-record', 'qwen:invalid-record', 'qwen:invalid-record', 'qwen:invalid-record', 'qwen:invalid-record', 'qwen:invalid-record', 'qwen:session-mismatch']);
    expect(ids(f)).toEqual([N(p, 'prompt'), N(a, 'text:0')]);
  });
});

describe('title (spec 7)', () => {
  test('the last custom_title in the file wins, even off the chain (a re-anchor side leaf); an empty one does not count', () => {
    const log = new Log();
    const p = log.prompt('the first prompt');
    log.add((env) => customTitle('Old title', env, 'auto'));
    log.add((env) => customTitle('Renamed', env, 'manual'), { advance: false }); // a re-anchor: a side leaf
    log.add((env) => customTitle('   ', env));
    log.reply([text('next record: the anchor is off the chain now')]);
    const f = run(ev(log));
    expect(f.session?.title).toBe('Renamed');
    expect(ids(f)[0]).toBe(N(p, 'prompt'));
  });

  test('a title record on an abandoned branch still names the session', () => {
    const log = new Log();
    const p = log.prompt('ask');
    log.reply([text('a')]);
    log.add((env) => customTitle('Kept', env));
    log.rewindTo(p);
    const f = run(ev(log));
    expect(f.session?.title).toBe('Kept');
  });

  test('without custom_title: the first prompt with display text (an empty one skips to the next; notices do not count)', () => {
    const log = new Log();
    log.add((env) => notification('Background agent finished', env));
    log.prompt('', { payload: { displayText: '', hookContext: '' } });
    log.prompt('the real ask\nsecond line');
    log.prompt('later ask');
    const f = run(ev(log));
    expect(f.session?.title).toBe('the real ask second line');
  });
});

describe('session status (spec 8)', () => {
  test('a prompt: running; turn_result completed: idle; no turn_result ever: running', () => {
    const log = new Log();
    log.prompt('go');
    expect(run(ev(log)).session?.status).toBe('running');
    log.reply([text('done')]);
    expect(run(ev(log)).session?.status).toBe('running');
    log.add((env) => turnResult('completed', env));
    expect(run(ev(log)).session?.status).toBe('idle');
    log.add((env) => midTurn('one more thing', env));
    expect(run(ev(log)).session?.status).toBe('running');
  });

  test('cancelled: idle with an Interrupted node; error: idle with a Turn failed node carrying the error, in the turn', () => {
    const log = new Log();
    const p = log.prompt('go');
    const c = log.add((env) => turnResult('cancelled', env));
    const p2 = log.prompt('again');
    const e = log.add((env) => turnResult('error', env, 'Rate limited'));
    const f = run(ev(log));
    expect(f.session?.status).toBe('idle');
    expect(nodeOf(f, N(c, 'turn-end'))).toMatchObject({ kind: 'system', title: 'Interrupted', systemSubtype: 'interrupt', turnId: N(p, 'prompt') });
    expect(nodeOf(f, N(e, 'turn-end'))).toMatchObject({ kind: 'system', title: 'Turn failed', systemSubtype: 'interrupt', summary: 'Rate limited', turnId: N(p2, 'prompt') });
    expect(f.details.get(N(e, 'turn-end'))).toEqual({ text: 'Rate limited' });
    const obj = new Log();
    obj.prompt('go');
    const e2 = obj.add((env) => turnResult('error', env, { message: 'quota exceeded', code: 429 }));
    expect(nodeOf(run(ev(obj)), qwenNodeId(SID, null, e2, 'turn-end')).summary).toBe('quota exceeded');
  });

  test('a rewind past a turn_result: the status follows the chain; the failed node goes with its record and comes back with it', () => {
    const log = new Log();
    const p1 = log.prompt('one');
    const a1 = log.reply([text('a')]);
    const t1 = log.add((env) => turnResult('completed', env));
    log.prompt('two');
    log.reply([text('b')]);
    const t2 = log.add((env) => turnResult('error', env, 'boom'));
    expect(run(ev(log)).graph.nodes[N(t2, 'turn-end')]).toBeDefined();
    log.rewindTo(t1); // back to after the first turn: idle (its turn_result)
    let f = run(ev(log));
    expect(f.graph.nodes[N(t2, 'turn-end')]).toBeUndefined();
    expect(f.session?.status).toBe('idle');
    log.rewindTo(a1); // past the first turn_result: the last status record is the first prompt
    f = run(ev(log));
    expect(f.session?.status).toBe('running');
    expect(ids(f)).toEqual([N(p1, 'prompt'), N(a1, 'text:0')]);
    // A record hanging off the abandoned error turn brings it back (a dead branch rejoining the chain).
    log.add((env) => sessionModel('openai', env), { parent: t2 });
    f = run(ev(log));
    expect(nodeOf(f, N(t2, 'turn-end'))).toMatchObject({ title: 'Turn failed', summary: 'boom' });
    expect(f.details.get(N(t2, 'turn-end'))).toEqual({ text: 'boom' });
    expect(f.session?.status).toBe('idle');
  });
});

describe('the live chain in the graph (spec 5)', () => {
  test('rewind: abandoned nodes go with their usage; the conversation continues from the rewind point', () => {
    const log = new Log();
    const p1 = log.prompt('one');
    const a1 = log.reply([text('first answer')], { usage: usageMeta(100, 10) });
    log.prompt('two');
    log.reply([fcall('t', {}, 'k')], { usage: usageMeta(200, 20) });
    log.result('t', 'out', { id: 'k' });
    log.rewindTo(a1);
    const p3 = log.prompt('two, edited');
    const a3 = log.reply([text('better')], { usage: usageMeta(300, 30) });
    const f = run(ev(log));
    const want = [N(p1, 'prompt'), N(a1, 'text:0'), N(p3, 'prompt'), N(a3, 'text:0')];
    expect(ids(f)).toEqual(want);
    expect(edgeIds(f)).toEqual(chainEdges(want));
    expect(totalUsage(f)).toEqual(usage(400, 0, 40));
  });

  test('restore of a tool answer: the old result leaves, the new one completes the call', () => {
    const log = new Log();
    log.prompt('go');
    const a = log.reply([fcall('t', {}, 'k')]);
    log.result('t', 'old', { id: 'k' });
    log.reply([text('used old')]);
    log.rewindTo(a);
    log.result('t', 'restored', { id: 'k' });
    const f = run(ev(log));
    expect(f.details.get(N(a, 'call:k'))?.output).toBe('restored');
    expect(ids(f)).toHaveLength(2);
  });

  test('a dead branch that rejoins brings its nodes back with their details and usage', () => {
    const log = new Log();
    const p = log.prompt('go');
    const a = log.reply([fcall('read_file', { file_path: 'x.ts' }, 'k')], { usage: usageMeta(500, 50) });
    const r = log.result('read_file', 'X', { id: 'k' });
    log.rewindTo(p);
    log.prompt('other');
    log.add((env) => sessionModel('openai', env), { parent: r });
    const f = run(ev(log));
    expect(nodeOf(f, N(a, 'call:k'))).toMatchObject({ status: 'succeeded', usage: usage(500, 0, 50) });
    expect(f.details.get(N(a, 'call:k'))).toEqual({ input: { file_path: 'x.ts' }, output: 'X', raw: { model: 'qwen3-coder-plus' } });
  });

  test('auth type: the nearest preceding session_model or prompt executionContext on the chain', () => {
    const over = usageMeta(1000, 50, 0, 70, 1500); // derived outside the interval: the auth type decides
    const log = new Log();
    log.prompt('go', { authType: 'openai' });
    const a1 = log.reply([text('one')], { usage: over });
    log.add((env) => sessionModel('gemini-api-key', env));
    const a2 = log.reply([text('two')], { usage: over });
    log.prompt('again', { authType: 'qwen-oauth' });
    const a3 = log.reply([text('three')], { usage: over });
    const f = run(ev(log));
    expect(nodeOf(f, N(a1, 'text:0')).usage?.outputTokens).toBe(50);
    expect(nodeOf(f, N(a2, 'text:0')).usage?.outputTokens).toBe(120);
    expect(nodeOf(f, N(a3, 'text:0')).usage?.outputTokens).toBe(50);
    // Rewound to before the session_model: a reply there uses the prompt's auth again.
    log.rewindTo(a1);
    const a4 = log.reply([text('four')], { usage: over });
    expect(nodeOf(run(ev(log)), N(a4, 'text:0')).usage?.outputTokens).toBe(50);
  });

  test('a file that starts mid-conversation: shown from its first record, one gap counted', () => {
    const log = new Log();
    log.at('lost-parent');
    const p = log.prompt('go');
    const a = log.reply([text('x')]);
    const f = run(ev(log));
    expect(ids(f)).toEqual([N(p, 'prompt'), N(a, 'text:0')]);
    expect(f.unknown).toEqual(['qwen:history-gap']);
  });

  test('a cycle: the walk stops, counted once (the parent was missing until the cycle closed: a gap first)', () => {
    const log = new Log();
    const a = log.reply([text('a')], { parent: 'r-0003' });
    log.reply([text('b')]);
    const c = log.reply([text('c')]);
    expect(c).toBe('r-0003');
    log.reply([text('d')]);
    const f = run(ev(log));
    expect(ids(f)).toHaveLength(4);
    expect(f.unknown).toEqual(['qwen:history-gap', 'qwen:history-cycle']);
    expect(nodeOf(f, N(a, 'text:0')).parentId).toBeNull();
  });
});

describe('restarts (the file was rewritten)', () => {
  test('a smaller offset resets the thread: stale nodes, title and status go; the new content is shown as if read fresh', () => {
    const old = new Log();
    old.prompt('old one');
    old.add((env) => customTitle('Old title', env));
    old.reply([text('old reply')], { usage: usageMeta(10, 1) });
    old.add((env) => turnResult('completed', env));
    const fresh = new Log({ t0: T0 + 500_000 });
    fresh.prompt('new one');
    fresh.reply([text('new reply')]);
    const oldEv = ev(old);
    const newEv = ev(fresh);
    const f = go([...oldEv, ...newEv]);
    expect(comparable(f)).toEqual(comparable(go(newEv)));
    expect(f.session).toMatchObject({ title: 'new one', status: 'running' });
    expect(comparable(paged([...oldEv, ...newEv], 2))).toEqual(comparable(f));
    expect(comparable(paged([...oldEv, ...newEv], 2, 4))).toEqual(comparable(f));
  });
});

describe('randomised: appends, rewinds, rejoins, results and turn ends; one by one = pages = rebuilt', () => {
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  for (const seed of [3, 11, 29, 101]) {
    test(`seed ${seed}`, () => {
      const rand = rng(seed);
      const log = new Log();
      const all: string[] = [];
      let calls = 0;
      const open: string[] = [];
      for (let i = 0; i < 70; i++) {
        const x = rand();
        if (x < 0.2) all.push(log.prompt(`ask ${i}`));
        else if (x < 0.45) {
          const id = `k${calls++}`;
          open.push(id);
          all.push(log.reply([thought(`t${i}`), fcall('read_file', { file_path: `f${i}.ts` }, id)], { usage: usageMeta(100 + i, 10) }));
        } else if (x < 0.6 && open.length > 0) all.push(log.result('read_file', `out ${i}`, { id: open[Math.floor(rand() * open.length)]! }));
        else if (x < 0.7) all.push(log.add((env) => turnResult(rand() < 0.5 ? 'completed' : 'error', env, 'e')));
        else if (x < 0.8 && all.length > 0) all.push(log.rewindTo(all[Math.floor(rand() * all.length)]!));
        else if (x < 0.85 && all.length > 0) all.push(log.reply([text(`rejoin ${i}`)], { parent: all[Math.floor(rand() * all.length)]! }));
        else all.push(log.reply([text(`reply ${i}`)], { usage: usageMeta(50, 5) }));
      }
      const f = run(ev(log));
      // The nodes shown are exactly those of the records on the whole-file chain.
      const parent = new Map<string, string | null>();
      let leaf: string | null = null;
      for (const l of log.lines) {
        const r = JSON.parse(l) as { uuid: string; parentUuid: string | null };
        if (parent.has(r.uuid)) continue;
        parent.set(r.uuid, r.parentUuid);
        leaf = r.uuid;
      }
      const onChain = new Set<string>();
      for (let cur = leaf; cur !== null && parent.has(cur) && !onChain.has(cur); cur = parent.get(cur)!) onChain.add(cur);
      for (const n of Object.values(f.graph.nodes)) expect(onChain.has(n.messageId!), n.id).toBe(true);
      for (const l of log.lines) {
        const r = JSON.parse(l) as { uuid: string; type: string; subtype?: string };
        if (onChain.has(r.uuid) && r.type === 'user' && r.subtype === undefined) expect(f.graph.nodes[N(r.uuid, 'prompt')], r.uuid).toBeDefined();
      }
    });
  }
});

describe('qwenTouches (spec 9, conservative, unverified tool names)', () => {
  test('path arguments in order; write, edit / replace, read by name; others name no file', () => {
    expect(qwenTouches('write_file', { file_path: 'a', path: 'b' })).toEqual([{ path: 'a', action: 'write' }]);
    expect(qwenTouches('edit', { absolute_path: 'x' })).toEqual([{ path: 'x', action: 'edit' }]);
    expect(qwenTouches('replace', { path: 'y' })).toEqual([{ path: 'y', action: 'edit' }]);
    expect(qwenTouches('read_file', { absolute_path: 'z' })).toEqual([{ path: 'z', action: 'read' }]);
    expect(qwenTouches('run_shell_command', { command: 'cat a', path: 'a' })).toEqual([]);
    expect(qwenTouches('glob', { path: 'src' })).toEqual([]);
    expect(qwenTouches('write_file', 'not an object')).toEqual([]);
    expect(qwenTouches('write_file', { file_path: '' })).toEqual([]);
  });
});

describe('memory', () => {
  test('tool inputs are held only in the bounded detail cache', () => {
    const log = new Log();
    for (let i = 0; i < 300; i++) {
      log.prompt(`ask ${i}`);
      log.reply([fcall('write_file', { file_path: `f${i}`, content: 'c'.repeat(4000) }, `k${i}`)]);
      log.result('write_file', 'o'.repeat(4000), { id: `k${i}` });
    }
    const n = new QwenNormalizer();
    for (const e of ev(log)) n.apply(e, PROJECT);
    expect(n.toolInputCount(SID)).toBeGreaterThan(0);
    expect(n.toolInputCount(SID)).toBeLessThan(80); // 256 KiB of ~4 KB inputs and outputs
  });
});
