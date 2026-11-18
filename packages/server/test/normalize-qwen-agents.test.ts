import { describe, expect, test } from 'vitest';
import { applyChanges, emptyGraph, type Change, type Graph, type GraphNode, type Session, type Usage } from '@agent-canvas/shared';
import { QwenNormalizer, qwenNodeId } from '../src/normalize/qwen.js';
import type { RawEvent } from '../src/store/store.js';
import {
  agentArgs,
  agentEvents,
  agentMeta,
  agentResultDisplay,
  agentStem,
  agentThread,
  customTitle,
  fcall,
  line,
  Log,
  metaEvent,
  notification,
  PROJECT,
  qwenEvents,
  SID,
  system,
  T0,
  text,
  thought,
  titleSidecar,
  turnResult,
  usageMeta,
} from './qwen-fixtures.js';

// The Qwen Code normalizer: subagent threads, the agent and title sidecars (spec 6, 7, 8; docs/formats/qwen-code.md
// 1.4, 5, 6). Expectations come from the spec and the format reference, not from the implementation.

interface Folded {
  graph: Graph;
  details: Map<string, Record<string, unknown>>;
  session: Session | undefined;
  unknown: string[];
  changes: Change[];
}

function fold(changes: Change[], unknown: string[]): Folded {
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

/** The project the pipeline passes: a line's stored one; a sidecar's from its key (the same project here). */
const projectOf = (ev: RawEvent): string => (ev.source === 'transcript' ? (ev.projectId ?? 'unknown') : PROJECT);

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

/** One by one, one batch, pages of 2 and 3, a rebuild at every cut: the same graph, details, usage, title, status, labels. */
function run(events: RawEvent[]): Folded {
  const f = go(events);
  const want = comparable(f);
  expect(comparable(paged(events, Math.max(1, events.length)))).toEqual(want);
  expect(comparable(paged(events, 2))).toEqual(want);
  expect(comparable(paged(events, 3))).toEqual(want);
  for (let cut = 1; cut < events.length; cut++) expect(comparable(paged(events, 2, cut)), `rebuild at ${cut}`).toEqual(want);
  expect(paged(events, 2).unknown).toEqual(f.unknown);
  return f;
}

const AGENT = 'Explore-call_b7';
const MODEL = 'qwen3-coder-flash';
const NM = (uuid: string, part: string): string => qwenNodeId(SID, null, uuid, part);
const NA = (agent: string, uuid: string, part: string): string => qwenNodeId(SID, agent, uuid, part);
const nodeOf = (f: Folded, id: string): GraphNode => {
  const n = f.graph.nodes[id];
  if (n === undefined) throw new Error(`no node ${id}; have ${Object.keys(f.graph.nodes).join(', ')}`);
  return n;
};
const spawnEdges = (f: Folded): string[] => Object.values(f.graph.edges).filter((e) => e.kind === 'spawn').map((e) => e.id).sort();
const usage = (inputTokens: number, cachedInputTokens: number, outputTokens: number): Usage => ({ inputTokens, cachedInputTokens, outputTokens });

/** The parent session: a prompt; a reply delegating to an `agent` call; the call's result; a final reply; turn_result. */
function mainLog(o: { subagentType?: string; callId?: string; extraCall?: { name: string; id: string; type?: string } } = {}): { log: Log; ids: Record<string, string> } {
  const log = new Log();
  const ids: Record<string, string> = {};
  const callId = o.callId ?? 'call_b7';
  ids.p1 = log.prompt('find the callers of uploadChunk');
  const calls = [fcall('agent', agentArgs(o.subagentType ?? 'explore-type'), callId)];
  if (o.extraCall !== undefined) calls.push(fcall(o.extraCall.name, agentArgs(o.extraCall.type), o.extraCall.id));
  ids.a1 = log.reply([text('Delegating to an agent.'), ...calls], { usage: usageMeta(1000, 10) });
  ids.r1 = log.result('agent', 'One caller: src/a.ts:12.', { id: callId, resultDisplay: agentResultDisplay('Explore') });
  ids.a2 = log.reply([text('Found it.')]);
  ids.t1 = log.add((env) => turnResult('completed', env));
  return { log, ids };
}

/** All orders of `xs`. */
function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [xs.slice()];
  const out: T[][] = [];
  xs.forEach((x, i) => {
    for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) out.push([x, ...rest]);
  });
  return out;
}

/** A random interleaving of `streams` keeping each one's order. */
function interleave(streams: readonly RawEvent[][], rand: () => number): RawEvent[] {
  const at = streams.map(() => 0);
  const out: RawEvent[] = [];
  for (;;) {
    const open = streams.map((s, i) => (at[i]! < s.length ? i : -1)).filter((i) => i >= 0);
    if (open.length === 0) return out;
    const i = open[Math.floor(rand() * open.length)]!;
    out.push(streams[i]![at[i]!++]!);
  }
}

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

describe('subagent thread records (reference 5.2)', () => {
  const main = mainLog();
  const agent = agentThread(AGENT, { agentName: 'Explorer' });
  const events = [...qwenEvents(main.log.lines), ...agentEvents(AGENT, agent.log.lines), metaEvent(agentMeta({ agentId: AGENT, agentType: 'Explore', toolUseId: 'call_b7', model: MODEL }), { agentStem: AGENT })];
  const f = run(events);
  const a = agent.ids;

  test('one node per shown part, in chain order, of the agent thread; telemetry shows nothing; nothing unknown', () => {
    expect(f.unknown).toEqual([]);
    const want = [NA(AGENT, a.p!, 'prompt'), NA(AGENT, a.a1!, 'thought:0'), NA(AGENT, a.a1!, 'text:1'), NA(AGENT, a.c1!, 'call:call_c1'), NA(AGENT, a.a2!, 'text:0')];
    const mine = Object.values(f.graph.nodes).filter((n) => n.agentId === AGENT).map((n) => n.id);
    expect(mine).toEqual(want);
    for (let k = 1; k < want.length; k++) expect(f.graph.edges[`${want[k - 1]}->${want[k]}`]?.kind).toBe('sequence');
    expect(nodeOf(f, want[0]!)).toMatchObject({ kind: 'prompt', summary: 'Find every caller of uploadChunk', turnId: want[0] });
  });

  test('a result without status is a success; usage once per round, on its first node', () => {
    expect(nodeOf(f, NA(AGENT, a.c1!, 'call:call_c1'))).toMatchObject({ kind: 'tool', status: 'succeeded', toolName: 'grep_search', usage: null });
    expect(f.details.get(NA(AGENT, a.c1!, 'call:call_c1'))?.output).toBe('src/a.ts:12: uploadChunk(');
    expect(nodeOf(f, NA(AGENT, a.a1!, 'thought:0')).usage).toEqual(usage(5120, 0, 64));
    expect(nodeOf(f, NA(AGENT, a.a1!, 'text:1')).usage).toBeNull();
    expect(nodeOf(f, NA(AGENT, a.a2!, 'text:0')).usage).toEqual(usage(5300, 0, 20));
  });

  test('the thread model is the sidecar model (records have none)', () => {
    expect(f.details.get(NA(AGENT, a.a1!, 'thought:0'))).toEqual({ text: 'Searching first.', raw: { model: MODEL } });
    expect(f.details.get(NA(AGENT, a.c1!, 'call:call_c1'))).toMatchObject({ input: { pattern: 'uploadChunk' }, raw: { model: MODEL } });
    expect(f.details.get(NA(AGENT, a.p!, 'prompt'))).toEqual({ text: 'Find every caller of uploadChunk' });
  });

  test('the dispatch is a subagent node linked to the thread; the thread hangs off it by a spawn edge', () => {
    const d = NM(main.ids.a1!, 'call:call_b7');
    expect(nodeOf(f, d)).toMatchObject({ kind: 'subagent', childAgentId: AGENT, toolName: 'agent', status: 'succeeded', agentId: null });
    expect(nodeOf(f, NA(AGENT, a.p!, 'prompt')).parentId).toBe(d);
    expect(spawnEdges(f)).toEqual([`${d}->${NA(AGENT, a.p!, 'prompt')}`]);
  });

  test('title: sidecar agentType over the records’ agentName over subagent_type', () => {
    expect(nodeOf(f, NM(main.ids.a1!, 'call:call_b7')).title).toBe('Explore');
  });

  test('the session is the parent’s: status idle from the main thread, title from its prompt; agent times count as activity', () => {
    expect(f.session).toMatchObject({ id: SID, origin: 'qwen', status: 'idle', title: 'find the callers of uploadChunk', projectId: PROJECT });
    expect(Date.parse(f.session!.lastActivityAt)).toBe(T0 + 100_000 + 6_000);
  });

  test('forks: agent_bootstrap (and its history), launch prompt, retry, session-ready show nothing, are not unknown and are not kept', () => {
    const log = new Log({ prefix: 'k', t0: T0 + 200_000, agent: { agentId: 'fork-call_f1', agentName: 'fork' } });
    log.sys('agent_bootstrap', { kind: 'fork', history: [{ role: 'user', parts: [text('SECRET-FORK inherited context')] }], systemInstruction: 'SECRET-FORK system' });
    log.sys('agent_launch_prompt', { displayText: 'SECRET-FORK launch' });
    log.sys('agent_retry', { attempt: 2 });
    const r = log.add((env) => line('assistant', undefined, env, { message: { role: 'model', parts: [text('forked answer')] }, usageMetadata: usageMeta(10, 1) }));
    log.sys('agent_session_ready', { callId: 'call_x', subagentSessionReady: true });
    const m = mainLog({ callId: 'call_f1', subagentType: 'fork' });
    const g = run([...qwenEvents(m.log.lines), ...agentEvents('fork-call_f1', log.lines)]);
    expect(g.unknown).toEqual([]);
    expect(Object.values(g.graph.nodes).filter((n) => n.agentId === 'fork-call_f1').map((n) => n.id)).toEqual([NA('fork-call_f1', r, 'text:0')]);
    expect(JSON.stringify([g.graph, [...g.details]])).not.toContain('SECRET-FORK');
    expect(nodeOf(g, NA('fork-call_f1', r, 'text:0')).parentId).toBe(NM(m.ids.a1!, 'call:call_f1'));
  });

  test('a resumed agent: the interrupted tail is a dead branch, the resumed run continues from its explicit parent', () => {
    const log = new Log({ prefix: 'q', t0: T0 + 300_000, agent: { agentId: AGENT } });
    const p = log.prompt('go', { payload: null, parts: [text('go')] });
    const a1 = log.reply([text('first round')], { usage: usageMeta(100, 5) });
    const dead = log.reply([fcall('read_file', { file_path: 'x' }, 'call_dead')]);
    log.at(a1).sys('agent_retry', { attempt: 2 });
    const a2 = log.reply([text('resumed round')], { usage: usageMeta(200, 7) });
    const g = run([...qwenEvents(mainLog().log.lines), ...agentEvents(AGENT, log.lines)]);
    const mine = Object.values(g.graph.nodes).filter((n) => n.agentId === AGENT);
    expect(mine.map((n) => n.id)).toEqual([NA(AGENT, p, 'prompt'), NA(AGENT, a1, 'text:0'), NA(AGENT, a2, 'text:0')]);
    expect(g.graph.nodes[NA(AGENT, dead, 'call:call_dead')]).toBeUndefined();
    expect(mine.reduce((s, n) => s + (n.usage?.inputTokens ?? 0), 0)).toBe(300);
  });

  test('a background agent’s completion notice in the main thread is a system node', () => {
    const log = mainLog().log;
    const note = log.add((env) => notification('Background agent finished', env));
    const g = run(qwenEvents(log.lines));
    expect(nodeOf(g, NM(note, 'system'))).toMatchObject({ kind: 'system', title: 'Notification', systemSubtype: 'notification', summary: 'Background agent finished', agentId: null });
  });
});

describe('arrival order (spec 6: sidecar and thread before or after, the same result)', () => {
  const main = mainLog();
  const agent = agentThread(AGENT, { agentName: 'Explorer' });
  const streams = {
    main: qwenEvents(main.log.lines),
    thread: agentEvents(AGENT, agent.log.lines),
    meta: [metaEvent(agentMeta({ agentId: AGENT, agentType: 'Explore', toolUseId: 'call_b7', model: MODEL }), { agentStem: AGENT })],
  };
  const want = comparable(go([...streams.main, ...streams.thread, ...streams.meta]));

  test('every permutation of (parent call, thread file, sidecar): the same graph, details and session, and each one incremental = batch = rebuilt', () => {
    for (const order of permutations(['main', 'thread', 'meta'] as const)) {
      const evs = order.flatMap((k) => streams[k]);
      expect(comparable(run(evs)), order.join(',')).toEqual(want);
    }
  });

  test('random interleavings line by line', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const evs = interleave([streams.main, streams.thread, streams.meta], rng(seed));
      expect(comparable(go(evs)), `seed ${seed}`).toEqual(want);
      expect(comparable(paged(evs, 3)), `seed ${seed} paged`).toEqual(want);
    }
  });

  test('a sidecar replaced by a newer version: the latest decides', () => {
    const old = metaEvent(agentMeta({ agentId: AGENT, agentType: 'Old', toolUseId: 'call_b7', model: 'old-model' }), { agentStem: AGENT });
    const f = run([...streams.main, old, ...streams.thread, ...streams.meta]);
    expect(comparable(f)).toEqual(want);
  });
});

describe('linking without a sidecar (reference 5.3 rule 3)', () => {
  test('the agentId suffix -<callId> links to the agent call; title from the records’ agentName, model unknown', () => {
    const main = mainLog();
    const agent = agentThread(AGENT, { agentName: 'Explorer' });
    const f = run([...agentEvents(AGENT, agent.log.lines), ...qwenEvents(main.log.lines)]);
    const d = NM(main.ids.a1!, 'call:call_b7');
    expect(nodeOf(f, d)).toMatchObject({ kind: 'subagent', childAgentId: AGENT, title: 'Explorer' });
    expect(nodeOf(f, NA(AGENT, agent.ids.p!, 'prompt')).parentId).toBe(d);
    expect(f.details.get(NA(AGENT, agent.ids.a1!, 'thought:0'))).toEqual({ text: 'Searching first.' });
  });

  test('no agentName on the records: the call’s subagent_type; neither: the tool name', () => {
    const main = mainLog({ subagentType: 'explore-type' });
    const f = run([...qwenEvents(main.log.lines), ...agentEvents(AGENT, agentThread(AGENT, { agentName: null }).log.lines)]);
    expect(nodeOf(f, NM(main.ids.a1!, 'call:call_b7'))).toMatchObject({ title: 'explore-type', childAgentId: AGENT });
    const bare = new Log();
    bare.prompt('go');
    const a = bare.reply([fcall('task', { prompt: 'p' }, 'call_b7')]);
    const g = run([...qwenEvents(bare.lines), ...agentEvents(AGENT, agentThread(AGENT, { agentName: null }).log.lines)]);
    expect(nodeOf(g, NM(a, 'call:call_b7'))).toMatchObject({ kind: 'subagent', title: 'task', childAgentId: AGENT });
  });

  test('a sidecar without agentType: the records’ agentName', () => {
    const main = mainLog();
    const f = run([...qwenEvents(main.log.lines), ...agentEvents(AGENT, agentThread(AGENT, { agentName: 'Explorer' }).log.lines), metaEvent(agentMeta({ agentId: AGENT, toolUseId: 'call_b7' }), { agentStem: AGENT })]);
    expect(nodeOf(f, NM(main.ids.a1!, 'call:call_b7')).title).toBe('Explorer');
  });

  test('only calls not linked yet: a call a sidecar links is not taken by another thread’s suffix, in any order', () => {
    const main = mainLog();
    const twin = 'Twin-call_b7';
    const streams = [
      qwenEvents(main.log.lines),
      agentEvents(AGENT, agentThread(AGENT).log.lines),
      [metaEvent(agentMeta({ agentId: AGENT, agentType: 'Explore', toolUseId: 'call_b7' }), { agentStem: AGENT })],
      agentEvents(twin, agentThread(twin, { prefix: 'w', t0: T0 + 150_000 }).log.lines),
    ];
    let first: ReturnType<typeof comparable> | null = null;
    for (const order of permutations([0, 1, 2, 3])) {
      const f = go(order.flatMap((i) => streams[i]!));
      expect(nodeOf(f, NM(main.ids.a1!, 'call:call_b7')).childAgentId).toBe(AGENT);
      expect(Object.values(f.graph.nodes).find((n) => n.agentId === twin && n.kind === 'prompt')!.parentId).toBeNull();
      first ??= comparable(f);
      expect(comparable(f)).toEqual(first);
    }
  });

  test('the file name is a lossy form of the id: the records’ agentId names the thread; the sidecar beside it still applies', () => {
    const real = 'Explore:v2-call_b7';
    const stem = agentStem(real);
    expect(stem).toBe('Explore_v2-call_b7');
    const main = mainLog();
    const agent = agentThread(real);
    const meta = metaEvent(agentMeta({ agentId: real, agentType: 'Explore v2', toolUseId: 'call_b7', model: MODEL }), { agentStem: stem });
    const f = run([meta, ...agentEvents(stem, agent.log.lines), ...qwenEvents(main.log.lines)]);
    const first = NA(real, agent.ids.p!, 'prompt');
    expect(nodeOf(f, first)).toMatchObject({ agentId: real, parentId: NM(main.ids.a1!, 'call:call_b7') });
    expect(nodeOf(f, NM(main.ids.a1!, 'call:call_b7'))).toMatchObject({ childAgentId: real, title: 'Explore v2' });
    // Without the sidecar: the suffix of the records' id.
    const g = run([...agentEvents(stem, agent.log.lines), ...qwenEvents(main.log.lines)]);
    expect(nodeOf(g, first).parentId).toBe(NM(main.ids.a1!, 'call:call_b7'));
  });
});

describe('nested agents (parentAgentId)', () => {
  const CHECK = 'checker-call_n1';
  const main = mainLog({ extraCall: { name: 'agent', id: 'call_n1', type: 'checker' } }); // a main call with the same id
  const a = new Log({ prefix: 'c', t0: T0 + 100_000, agent: { agentId: AGENT, agentName: 'Explore' } });
  const ap = a.prompt('Find callers', { payload: null, parts: [text('Find callers')] });
  const ac = a.add((env) => line('assistant', undefined, env, { message: { role: 'model', parts: [fcall('agent', agentArgs('checker'), 'call_n1')] } }));
  a.result('agent', 'checked', { id: 'call_n1', noStatus: true });
  const b = new Log({ prefix: 'g', t0: T0 + 110_000, agent: { agentId: CHECK, agentName: 'checker' } });
  const bp = b.prompt('Check it', { payload: null, parts: [text('Check it')] });
  b.reply([text('checked')]);
  const streams = [
    qwenEvents(main.log.lines),
    agentEvents(AGENT, a.lines),
    [metaEvent(agentMeta({ agentId: AGENT, agentType: 'Explore', toolUseId: 'call_b7' }), { agentStem: AGENT })],
    agentEvents(CHECK, b.lines),
    [metaEvent(agentMeta({ agentId: CHECK, agentType: 'checker', toolUseId: 'call_n1', parentAgentId: AGENT }), { agentStem: CHECK })],
  ];

  test('the nested thread hangs off the call in its parent agent’s thread (not the main call with the same id), in any order', () => {
    const f = run(streams.flat());
    const inner = NA(AGENT, ac, 'call:call_n1');
    expect(nodeOf(f, inner)).toMatchObject({ kind: 'subagent', agentId: AGENT, childAgentId: CHECK, title: 'checker' });
    expect(nodeOf(f, NA(CHECK, bp, 'prompt')).parentId).toBe(inner);
    expect(nodeOf(f, NA(AGENT, ap, 'prompt')).parentId).toBe(NM(main.ids.a1!, 'call:call_b7'));
    expect(nodeOf(f, NM(main.ids.a1!, 'call:call_n1')).childAgentId).toBeNull();
    expect(spawnEdges(f)).toEqual([`${NM(main.ids.a1!, 'call:call_b7')}->${NA(AGENT, ap, 'prompt')}`, `${inner}->${NA(CHECK, bp, 'prompt')}`].sort());
    const want = comparable(f);
    for (const order of permutations([0, 1, 2, 3, 4])) expect(comparable(go(order.flatMap((i) => streams[i]!))), order.join(',')).toEqual(want);
  });

  test('without the nested sidecar: the suffix rule still finds the nested call (the main call with that id is taken first only when nothing names the parent)', () => {
    const f = run([...streams[0]!, ...streams[1]!, ...streams[2]!, ...streams[3]!]);
    // Without a sidecar the threads are searched main first: the main call `call_n1` (agent tool) is the match.
    expect(nodeOf(f, NA(CHECK, bp, 'prompt')).parentId).toBe(NM(main.ids.a1!, 'call:call_n1'));
  });
});

describe('unlinked threads (no phantom session)', () => {
  test('a thread no call matches hangs under the session, unlinked', () => {
    const lone = 'Lone-call_zzz';
    const f = run([...qwenEvents(mainLog().log.lines), ...agentEvents(lone, agentThread(lone).log.lines)]);
    expect(Object.values(f.graph.nodes).find((n) => n.agentId === lone && n.kind === 'prompt')!.parentId).toBeNull();
    expect(spawnEdges(f)).toEqual([]);
  });

  test('a thread or a sidecar without its main file makes no session', () => {
    const t = go(agentEvents(AGENT, agentThread(AGENT).log.lines));
    expect(t.session).toBeUndefined();
    expect(t.changes.some((c) => c.type === 'session_upserted')).toBe(false);
    const m = go([metaEvent(agentMeta({ agentId: AGENT, agentType: 'Explore', toolUseId: 'call_b7' }), { agentStem: AGENT }), metaEvent(titleSidecar('A title', 'manual'))]);
    expect(m.changes).toEqual([]);
    expect(m.session).toBeUndefined();
  });
});

describe('the dispatch call and the live chain', () => {
  test('a dispatch call rewound away unlinks its thread; a record rejoining that branch links it again', () => {
    const main = mainLog();
    const agent = agentThread(AGENT, { agentName: 'Explorer' });
    const thread = agentEvents(AGENT, agent.log.lines);
    const meta = [metaEvent(agentMeta({ agentId: AGENT, agentType: 'Explore', toolUseId: 'call_b7' }), { agentStem: AGENT })];
    const first = NA(AGENT, agent.ids.p!, 'prompt');
    const d = NM(main.ids.a1!, 'call:call_b7');
    main.log.rewindTo(main.ids.p1!);
    main.log.prompt('never mind');
    let f = run([...qwenEvents(main.log.lines), ...thread, ...meta]);
    expect(f.graph.nodes[d]).toBeUndefined();
    expect(nodeOf(f, first).parentId).toBeNull();
    expect(spawnEdges(f)).toEqual([]);
    const cut = main.log.lines.length;
    main.log.add((env) => system('session_model', { modelId: 'm', authType: 'openai' }, env), { parent: main.ids.r1! });
    const all = qwenEvents(main.log.lines);
    f = run([...all, ...thread, ...meta]);
    expect(nodeOf(f, d)).toMatchObject({ childAgentId: AGENT, title: 'Explore' });
    expect(nodeOf(f, first).parentId).toBe(d);
    expect(spawnEdges(f)).toEqual([`${d}->${first}`]);
    // The thread and the sidecar read at any point of that history: the same.
    const want = comparable(f);
    for (const at of [0, 3, cut - 1, cut]) {
      expect(comparable(run([...all.slice(0, at), ...thread, ...meta, ...all.slice(at)])), `at ${at}`).toEqual(want);
    }
  });

  test('a dispatch node removed and added again by one line (a re-root that rotates a cyclic chain): the spawn edge comes back', () => {
    // a's parent is c (a cycle once c is read); e hangs off b: the walk from e is e, b, a, c, so every record moves.
    const log = new Log();
    const a = log.reply([fcall('agent', agentArgs('explore-type'), 'call_b7')], { parent: 'r-0003' });
    const b = log.reply([text('b')]);
    log.reply([text('c')]);
    log.reply([text('d')]);
    log.reply([text('e')], { parent: b });
    const agent = agentThread(AGENT);
    const thread = agentEvents(AGENT, agent.log.lines);
    const d = NM(a, 'call:call_b7');
    const first = NA(AGENT, agent.ids.p!, 'prompt');
    const f = run([...thread, ...qwenEvents(log.lines)]);
    expect(nodeOf(f, d).childAgentId).toBe(AGENT);
    expect(nodeOf(f, first).parentId).toBe(d);
    expect(spawnEdges(f)).toEqual([`${d}->${first}`]);
    expect(comparable(f)).toEqual(comparable(go([...qwenEvents(log.lines), ...thread])));
  });

  test('a thread file read again from its start (rewritten): its old nodes go, the link stays', () => {
    const main = mainLog();
    const old = agentThread(AGENT, { agentName: 'Explorer' });
    const fresh = agentThread(AGENT, { agentName: 'Explorer', prefix: 'n', t0: T0 + 400_000 });
    const f = go([...qwenEvents(main.log.lines), ...agentEvents(AGENT, old.log.lines), ...agentEvents(AGENT, fresh.log.lines)]);
    expect(Object.values(f.graph.nodes).filter((n) => n.agentId === AGENT).map((n) => n.messageId)).not.toContain(old.ids.p);
    expect(nodeOf(f, NA(AGENT, fresh.ids.p!, 'prompt')).parentId).toBe(NM(main.ids.a1!, 'call:call_b7'));
    expect(comparable(f)).toEqual(comparable(go([...qwenEvents(main.log.lines), ...agentEvents(AGENT, fresh.log.lines)])));
  });
});

describe('session status and the subagent threads (spec 8: the main thread only)', () => {
  test('an agent thread’s prompts and turn ends change nothing in the status', () => {
    const main = mainLog();
    const a = new Log({ prefix: 'c', t0: T0 + 100_000, agent: { agentId: AGENT } });
    a.prompt('go', { payload: null, parts: [text('go')] });
    a.add((env) => turnResult('error', env, 'agent boom'));
    a.prompt('again', { payload: null, parts: [text('again')] });
    const f = run([...qwenEvents(main.log.lines), ...agentEvents(AGENT, a.lines)]);
    expect(f.session?.status).toBe('idle');
    const g = run([...agentEvents(AGENT, a.lines), ...qwenEvents(main.log.lines.slice(0, 2))]);
    expect(g.session?.status).toBe('running');
  });
});

describe('title sidecar (spec 7; reference 1.4, 6)', () => {
  const base = (): Log => {
    const log = new Log();
    log.prompt('the first prompt');
    log.reply([text('ok')]);
    return log;
  };
  const withTitle = (): Log => {
    const log = base();
    log.add((env) => customTitle('From the record', env, 'auto'));
    return log;
  };

  test('a custom_title record wins over the sidecar whatever its source', () => {
    for (const source of ['manual', 'auto', 'prompt']) {
      expect(run([metaEvent(titleSidecar('From the sidecar', source)), ...qwenEvents(withTitle().lines)]).session?.title).toBe('From the record');
      expect(run([...qwenEvents(withTitle().lines), metaEvent(titleSidecar('From the sidecar', source))]).session?.title).toBe('From the record');
    }
  });

  test('without one: the sidecar when its source is manual or auto, else the first prompt', () => {
    for (const [source, want] of [
      ['manual', 'From the sidecar'],
      ['auto', 'From the sidecar'],
      ['prompt', 'the first prompt'],
      ['other', 'the first prompt'],
    ] as const) {
      expect(run([...qwenEvents(base().lines), metaEvent(titleSidecar('From the sidecar', source))]).session?.title, source).toBe(want);
      expect(run([metaEvent(titleSidecar('From the sidecar', source)), ...qwenEvents(base().lines)]).session?.title, source).toBe(want);
    }
  });

  test('an invalid or oversized sidecar is ignored; the latest version decides', () => {
    for (const bad of ['not json', '[1]', titleSidecar('', 'manual'), titleSidecar('   ', 'auto'), titleSidecar(7, 'manual'), titleSidecar('x'.repeat(70 * 1024), 'manual')]) {
      expect(run([...qwenEvents(base().lines), metaEvent(bad)]).session?.title).toBe('the first prompt');
    }
    expect(run([...qwenEvents(base().lines), metaEvent(titleSidecar('Renamed', 'manual')), metaEvent(titleSidecar('the first prompt, cut', 'prompt'))]).session?.title).toBe('the first prompt');
    expect(run([...qwenEvents(base().lines), metaEvent('not json'), metaEvent(titleSidecar('Renamed', 'manual'))]).session?.title).toBe('Renamed');
  });
});

describe('subagent memory', () => {
  test('an 8 MB agent_bootstrap history is never kept nor shown', () => {
    const log = new Log({ prefix: 'k', t0: T0 + 200_000, agent: { agentId: AGENT } });
    log.sys('agent_bootstrap', { kind: 'fork', history: [{ role: 'user', parts: [text(`SECRET-BIG${'h'.repeat(1024 * 1024)}`)] }] });
    log.reply([thought('t'), text('after the bootstrap')]);
    const f = run([...qwenEvents(mainLog().log.lines), ...agentEvents(AGENT, log.lines)]);
    expect(JSON.stringify([f.graph, [...f.details]])).not.toContain('SECRET-BIG');
  });
});
