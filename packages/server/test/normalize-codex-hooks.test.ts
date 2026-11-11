import { beforeEach, describe, expect, test } from 'vitest';
import { applyChanges, emptyGraph, type Change, type GraphNode } from '@claude-canvas/shared';
import { CodexNormalizer } from '../src/normalize/codex.js';
import { parseCodexHook } from '../src/normalize/codex-hooks.js';
import { NORMALIZER_VERSION } from '../src/normalize/version.js';
import type { RawEvent } from '../src/store/store.js';
import { CodexThread, interleave, nextTime, run, type RunResult } from './codex-fixtures.js';

let n: CodexNormalizer;
beforeEach(() => {
  n = new CodexNormalizer();
});

/** A Codex hook raw event as `POST /hooks?origin=codex` stores it; fields as documented (spec 2.3). */
function hook(eventName: string, body: Record<string, unknown> = {}, opts: { session?: string; at?: string; projectId?: string } = {}): RawEvent {
  const session = opts.session ?? 'root1';
  return {
    source: 'hook',
    origin: 'codex',
    receivedAt: opts.at ?? nextTime(),
    eventName,
    sessionId: session,
    payload: JSON.stringify({
      session_id: session,
      transcript_path: `/home/u/.codex/sessions/2026/11/11/rollout-x-${session}.jsonl`,
      cwd: '/work/app',
      hook_event_name: eventName,
      model: 'gpt-x',
      ...body,
    }),
    projectId: opts.projectId ?? 'p1',
  };
}
const pre = (id: string, cmd = 'ls', extra: Record<string, unknown> = {}) =>
  hook('PreToolUse', { turn_id: 't1', tool_name: 'exec', tool_use_id: id, tool_input: { cmd }, ...extra });
const post = (id: string, response: unknown = { exit_code: 0, output: 'ok' }, extra: Record<string, unknown> = {}) =>
  hook('PostToolUse', { turn_id: 't1', tool_name: 'exec', tool_use_id: id, tool_input: {}, tool_response: response, ...extra });
const permission = (extra: Record<string, unknown> = {}) =>
  hook('PermissionRequest', { turn_id: 't1', tool_name: 'exec', tool_input: { cmd: 'rm -rf build' }, ...extra });

/** `run` with each hook's own projectId (the fixture's run gives hooks 'unknown'). */
function apply(events: RawEvent[]): RunResult {
  const changes: Change[] = [];
  const unknown: string[] = [];
  const sessions = new Map();
  for (const ev of events) {
    const r = n.apply(ev, ev.source === 'hook' ? (ev.projectId ?? 'unknown') : ev.source === 'transcript' ? (ev.projectId ?? 'unknown') : 'p1');
    if (r.unknownRecordType !== undefined) unknown.push(r.unknownRecordType);
    changes.push(...r.changes);
    for (const c of r.changes) if (c.type === 'session_upserted') sessions.set(c.session.id, c.session);
  }
  return { changes, graph: applyChanges(emptyGraph(), changes), unknown, sessions };
}
const node = (r: RunResult, id: string): GraphNode => {
  const x = r.graph.nodes[id];
  if (!x) throw new Error(`no node ${id}; have ${Object.keys(r.graph.nodes).join(', ')}`);
  return x;
};
const status = (r: RunResult) => r.sessions.get('root1')?.status;

test('NORMALIZER_VERSION 已升级', () => {
  expect(NORMALIZER_VERSION).toBe(17);
});

describe('parseCodexHook', () => {
  test('已知事件、未知事件、坏载荷', () => {
    expect(parseCodexHook('Stop', JSON.stringify({ session_id: 's', cwd: '/w' }))).toMatchObject({ ok: true, hook: { sessionId: 's', cwd: '/w', status: 'idle', node: null } });
    expect(parseCodexHook('Frobnicate', JSON.stringify({ session_id: 's' }))).toEqual({ ok: false, unknownRecordType: 'hook:Frobnicate' });
    expect(parseCodexHook('Stop', 'nope')).toEqual({ ok: false, unknownRecordType: 'hook:invalid' });
    expect(parseCodexHook('Stop', '{}')).toEqual({ ok: false, unknownRecordType: 'hook:invalid' });
  });

  test('事件 → 会话状态', () => {
    const st = (e: string, body: object = {}) => {
      const p = parseCodexHook(e, JSON.stringify({ session_id: 's', tool_name: 'exec', tool_use_id: 'c', ...body }));
      return p.ok ? p.hook.status : 'x';
    };
    expect(st('SessionStart')).toBe('idle');
    expect(st('UserPromptSubmit')).toBe('running');
    expect(st('PreToolUse')).toBe('running');
    expect(st('PermissionRequest')).toBe('awaiting_permission');
    expect(st('PostToolUse')).toBe('running');
    expect(st('Stop')).toBe('idle');
    expect(st('Interrupt')).toBe('idle');
    expect(st('SessionEnd')).toBe('ended');
    for (const e of ['SubagentStart', 'SubagentStop', 'PostCompact', 'PreCompact']) expect(st(e)).toBeNull();
    // A subagent's hooks only move the session for its tool and permission events.
    expect(st('Stop', { agent_id: 'a' })).toBeNull();
    expect(st('PermissionRequest', { agent_id: 'a' })).toBe('awaiting_permission');
  });

  test('PostToolUse：明确报告错误或非零退出码才算失败', () => {
    const failed = (response: unknown) => {
      const p = parseCodexHook('PostToolUse', JSON.stringify({ session_id: 's', tool_name: 'exec', tool_use_id: 'c', tool_response: response }));
      return p.ok && p.hook.node?.kind === 'post_tool' ? p.hook.node.failed : 'x';
    };
    expect(failed({ exit_code: 0, output: 'ok' })).toBe(false);
    expect(failed('Error: just text that mentions errors')).toBe(false);
    expect(failed(undefined)).toBe(false);
    expect(failed({ exit_code: 2 })).toBe(true);
    expect(failed({ exitCode: 1 })).toBe(true);
    expect(failed({ success: false })).toBe(true);
    expect(failed({ is_error: true })).toBe(true);
    expect(failed({ error: 'boom' })).toBe(true);
    expect(failed({ error: null, exit_code: 0 })).toBe(false);
  });
});

describe('PreToolUse 占位与确认', () => {
  test('hook 先到：立即有一个未确认、执行中的工具节点；转录的调用到达后确认同一节点，保留更早的开始时间', () => {
    const root = new CodexThread({ id: 'root1' });
    const r1 = apply([root.meta(), root.started('t1'), root.user('u1', 'go')]);
    const h = pre('c1');
    const r2 = apply([h]);
    const added = r2.changes.find((c) => c.type === 'node_added');
    expect(added).toMatchObject({
      node: { id: 'tool:c1', confirmed: false, status: 'running', toolName: 'exec', toolUseId: 'c1', agentId: null, parentId: null, turnId: 't1', kind: 'tool' },
      detail: { input: { cmd: 'ls' } },
    });
    expect(added?.type === 'node_added' && added.node.timestamp).toBe(h.source === 'hook' ? h.receivedAt : '');
    expect(r2.changes.filter((c) => c.type === 'edge_added')).toEqual([]);
    const r3 = apply([root.exec('c1', 'ls -la')]);
    expect(r3.unknown).toEqual([]);
    expect(r3.changes.filter((c) => c.type === 'node_added')).toEqual([]);
    const all = applyChanges(applyChanges(r1.graph, r2.changes), r3.changes);
    expect(all.nodes['tool:c1']).toMatchObject({ confirmed: true, status: 'running', parentId: 'prompt:u1', title: 'exec', summary: 'ls -la', turnId: 't1', timestamp: h.source === 'hook' ? h.receivedAt : '' });
    expect(Object.keys(all.edges)).toContain('prompt:u1->tool:c1');
  });

  test('转录先到：PreToolUse 不建新节点', () => {
    const root = new CodexThread({ id: 'root1' });
    apply([root.meta(), root.started('t1'), root.user('u1', 'go'), root.exec('c1', 'ls')]);
    const r = apply([pre('c1')]);
    expect(r.changes.filter((c) => c.type === 'node_added')).toEqual([]);
  });

  test('子代理的 hook：节点在子代理线程里（agentId = agent_id）', () => {
    const r = apply([pre('c9', 'ls', { agent_id: 'sub1', agent_type: 'worker' })]);
    expect(node(r, 'tool:c9')).toMatchObject({ agentId: 'sub1', confirmed: false });
  });

  test('只有 hook：节点保持未确认，PostToolUse 结算', () => {
    const r = apply([pre('c1'), post('c1', { exit_code: 3 })]);
    expect(node(r, 'tool:c1')).toMatchObject({ confirmed: false, status: 'failed' });
    expect(node(r, 'tool:c1').endedAt).not.toBeNull();
    expect(n.toolInputCount('root1')).toBe(0);
  });

  test('tool_use_id 和 call_id 对不上：调用确认同一线程、同名、最早的未确认占位；结果确定', () => {
    const root = new CodexThread({ id: 'root1' });
    const events = [
      root.meta(), root.started('t1'), root.user('u1', 'go'),
      pre('hookA', 'a'), pre('hookB', 'b'),
      hook('PreToolUse', { tool_name: 'other', tool_use_id: 'hookO', tool_input: {} }),
      pre('hookS', 's', { agent_id: 'sub1' }),
      root.exec('callA', 'a'), root.output('callA'),
      root.exec('callB', 'b'),
    ];
    const r = apply(events);
    expect(r.unknown).toEqual([]);
    expect(node(r, 'tool:hookA')).toMatchObject({ confirmed: true, status: 'succeeded', parentId: 'prompt:u1', toolUseId: 'callA' });
    expect(node(r, 'tool:hookB')).toMatchObject({ confirmed: true, status: 'running', parentId: 'tool:hookA', toolUseId: 'callB' });
    expect(r.graph.nodes['tool:callA']).toBeUndefined();
    expect(r.graph.nodes['tool:callB']).toBeUndefined();
    expect(node(r, 'tool:hookO').confirmed).toBe(false);
    expect(node(r, 'tool:hookS').confirmed).toBe(false);
    const again = new CodexNormalizer();
    expect(run(again, events).graph).toEqual(r.graph);
  });

  test('已用相同 id 确认过一次：不再按名字回退匹配（避免配错）', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = apply([root.meta(), root.started('t1'), root.user('u1', 'go'), pre('c1'), root.exec('c1', 'ls'), pre('c3'), root.exec('c2', 'x')]);
    expect(node(r, 'tool:c1').confirmed).toBe(true);
    expect(node(r, 'tool:c2').confirmed).toBe(true);
    expect(node(r, 'tool:c3').confirmed).toBe(false);
  });

  test('已被确认过的 id 再来一次调用：仍是重复记录', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = apply([root.meta(), root.started('t1'), pre('c1'), root.exec('c1', 'ls'), root.exec('c1', 'ls')]);
    expect(r.unknown).toEqual(['duplicate-node-id']);
  });
});

describe('PermissionRequest / PostToolUse', () => {
  test('PermissionRequest：按 tool_use_id 标记等待确认；会话等待确认', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = apply([root.meta(), root.started('t1'), root.exec('c1', 'ls'), permission({ tool_use_id: 'c1' })]);
    expect(node(r, 'tool:c1').status).toBe('awaiting_permission');
    expect(status(r)).toBe('awaiting_permission');
  });

  test('PermissionRequest 没有 tool_use_id：同线程同名、执行中的最新节点（同样输入优先）', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = apply([
      root.meta(), root.started('t1'),
      root.exec('c1', 'rm -rf build'), root.exec('c2', 'ls'), root.exec('c3', 'pwd'),
      permission({ tool_input: 'rm -rf build' }),
    ]);
    expect(node(r, 'tool:c1').status).toBe('awaiting_permission');
    expect(node(r, 'tool:c3').status).toBe('running');
    const r2 = apply([permission({ tool_input: { other: true } })]);
    expect(applyChanges(r.graph, r2.changes).nodes['tool:c3']!.status).toBe('awaiting_permission');
  });

  test('PostToolUse 结算；之后转录的输出纠正状态和结束时间（转录为准）', () => {
    const root = new CodexThread({ id: 'root1' });
    const base = [root.meta(), root.started('t1'), pre('c1'), root.exec('c1', 'ls')];
    const r = apply([...base, post('c1')]);
    expect(node(r, 'tool:c1').status).toBe('succeeded');
    const fail = root.command('cmd1', 'ls', { exitCode: 1 });
    const out = root.output('c1');
    const r2 = apply([fail, out]);
    const g = applyChanges(r.graph, r2.changes);
    expect(g.nodes['tool:c1']).toMatchObject({ status: 'failed', endedAt: JSON.parse((out as any).line).timestamp });
  });

  test('转录先结算：之后的 PostToolUse 不改', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = apply([root.meta(), root.started('t1'), root.exec('c1', 'ls'), root.command('cmd1', 'ls', { exitCode: 1 }), root.output('c1')]);
    const before = node(r, 'tool:c1');
    const r2 = apply([post('c1')]);
    expect(r2.changes.filter((c) => c.type !== 'session_upserted')).toEqual([]);
    expect(before.status).toBe('failed');
  });

  test('派发子代理的节点不被 PostToolUse 结算', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = apply([
      root.meta(), root.started('t1'),
      hook('PreToolUse', { tool_name: 'spawn_agent', tool_use_id: 'sp1', tool_input: { task_name: 'helper' } }),
      root.spawn('sp1', 'helper'),
      hook('PostToolUse', { tool_name: 'spawn_agent', tool_use_id: 'sp1', tool_response: { agent_id: 'x' } }),
    ]);
    expect(node(r, 'tool:sp1')).toMatchObject({ kind: 'subagent', status: 'running', confirmed: true });
    const r2 = apply([hook('PostToolUse', { tool_name: 'Agent', tool_use_id: 'sp2', tool_response: {} }), hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'sp2', tool_input: {} })]);
    expect(node(r2, 'tool:sp2')).toMatchObject({ kind: 'subagent', status: 'running' });
    expect(apply([hook('PostToolUse', { tool_name: 'Agent', tool_use_id: 'sp2', tool_response: {} })]).changes.filter((c) => c.type !== 'session_upserted')).toEqual([]);
  });
});

describe('会话状态与会话创建', () => {
  test('UserPromptSubmit → 运行中；Stop → 空闲；SessionEnd → 已结束；之后只有 SessionStart / UserPromptSubmit 能恢复', () => {
    const root = new CodexThread({ id: 'root1' });
    let r = apply([root.meta(), hook('UserPromptSubmit', { prompt: 'x' })]);
    expect(status(r)).toBe('running');
    r = apply([hook('Stop', { last_assistant_message: 'done' })]);
    expect(status(r)).toBe('idle');
    r = apply([hook('SessionEnd', { reason: 'exit' })]);
    expect(status(r)).toBe('ended');
    r = apply([hook('PreToolUse', { tool_name: 'exec', tool_use_id: 'zz', tool_input: {} })]);
    expect(r.sessions.get('root1')?.status ?? 'ended').toBe('ended');
    r = apply([hook('SessionStart', { source: 'resume' })]);
    expect(status(r)).toBe('idle');
  });

  test('Interrupt → 空闲，不产生节点', () => {
    const root = new CodexThread({ id: 'root1' });
    apply([root.meta(), root.started('t1')]);
    const r = apply([hook('Interrupt', {})]);
    expect(status(r)).toBe('idle');
    expect(r.changes.filter((c) => c.type !== 'session_upserted')).toEqual([]);
  });

  test('hook 的状态不覆盖转录里更新的状态', () => {
    const root = new CodexThread({ id: 'root1' });
    const stale = hook('Stop', {}, { at: '2026-11-11T02:00:00.000Z' });
    const r = apply([root.meta(), root.started('t1'), stale]);
    expect(status(r) ?? 'running').toBe('running');
  });

  test('SubagentStart / SubagentStop / PostCompact：不改节点，不算未识别', () => {
    const root = new CodexThread({ id: 'root1' });
    apply([root.meta(), root.started('t1')]);
    const r = apply([hook('SubagentStart', { agent_id: 'a1', agent_type: 'w' }), hook('SubagentStop', { agent_id: 'a1', agent_type: 'w' }), hook('PostCompact', {})]);
    expect(r.unknown).toEqual([]);
    expect(r.changes.filter((c) => c.type !== 'session_upserted')).toEqual([]);
  });

  test('未知事件名计为未识别，不建会话', () => {
    const r = apply([hook('Frobnicate', {}, { session: 'fresh' })]);
    expect(r.unknown).toEqual(['hook:Frobnicate']);
    expect(n.hasSession('fresh')).toBe(false);
  });

  test('没见过的会话：SessionStart 建出 Codex 会话（cwd、项目来自 hook）；会话文件之后到达时合在一起', () => {
    const r = apply([hook('SessionStart', { source: 'startup' }, { session: 'root1', projectId: 'p-work' })]);
    expect(r.sessions.get('root1')).toMatchObject({ origin: 'codex', cwd: '/work/app', projectId: 'p-work', status: 'idle' });
    const root = new CodexThread({ id: 'root1', cwd: '/work/app2', projectId: 'p-work' });
    const r2 = apply([root.meta(), root.started('t1')]);
    expect(r2.sessions.get('root1')).toMatchObject({ cwd: '/work/app2', projectId: 'p-work', status: 'running' });
  });

  test('没见过的会话：Stop / SessionEnd / Interrupt / Subagent* 不凭空建会话', () => {
    for (const e of ['Stop', 'SessionEnd', 'Interrupt', 'SubagentStop', 'PostCompact']) {
      const r = apply([hook(e, {}, { session: `s-${e}` })]);
      expect(r.unknown).toEqual([]);
      expect(n.hasSession(`s-${e}`)).toBe(false);
    }
  });

  test('畸形 hook：未识别标签，无变化，不抛', () => {
    for (const payload of ['nope', '[]', '{"session_id":5}', 'null']) {
      const r = n.apply({ source: 'hook', origin: 'codex', receivedAt: nextTime(), eventName: 'PreToolUse', sessionId: null, payload }, 'p1');
      expect(r).toEqual({ changes: [], unknownRecordType: 'hook:invalid' });
    }
    const r = apply([hook('PreToolUse', { tool_name: 7, tool_use_id: {}, tool_input: null })]);
    expect(r.unknown).toEqual([]);
    expect(r.changes.filter((c) => c.type !== 'session_upserted')).toEqual([]);
  });
});

describe('与转录的等价性', () => {
  /** A session with two turns, a failing command, a permission prompt, and a subagent (spawn + child thread). */
  function scenario() {
    const root = new CodexThread({ id: 'root1' });
    const sub = new CodexThread({ id: 'sub1', sessionId: 'root1', parent: 'root1', nickname: 'Helper', agentPath: '/root/helper' });
    // Hooks are received before the records describing the same step are read (their times are earlier).
    const t = (h: string) => ({ turn_id: h });
    const hooks = [
      hook('SessionStart', { source: 'startup' }),
      hook('UserPromptSubmit', { prompt: 'build it', ...t('t1') }),
      pre('c1'), post('c1'),
      pre('c2', 'make'), post('c2', { exit_code: 2 }),
      hook('PreToolUse', { tool_name: 'spawn_agent', tool_use_id: 'sp1', tool_input: { task_name: 'helper' }, ...t('t1') }),
      hook('PostToolUse', { tool_name: 'spawn_agent', tool_use_id: 'sp1', tool_response: 'started', ...t('t1') }),
      hook('SubagentStart', { agent_id: 'sub1', agent_type: 'worker' }),
      hook('PreToolUse', { tool_name: 'exec', tool_use_id: 'k1', tool_input: { cmd: 'pwd' }, agent_id: 'sub1', turn_id: 'st1' }),
      hook('PostToolUse', { tool_name: 'exec', tool_use_id: 'k1', tool_response: { exit_code: 0 }, agent_id: 'sub1', turn_id: 'st1' }),
      hook('SubagentStop', { agent_id: 'sub1', agent_type: 'worker' }),
      hook('Stop', { last_assistant_message: 'done' }),
      hook('UserPromptSubmit', { prompt: 'again', ...t('t2') }),
      pre('c3', 'rm x', t('t2')), permission({ tool_use_id: 'c3', ...t('t2') }), post('c3', { exit_code: 0 }, t('t2')),
      hook('Stop', {}),
    ];
    const transcriptRoot = [
      root.meta(), root.started('t1'), root.user('u1', 'build it'),
      ...root.reasoning('rs1'),
      root.exec('c1', 'ls'), root.command('cmd1', 'ls'), root.output('c1'), root.usage(),
      root.exec('c2', 'make'), root.command('cmd2', 'make', { exitCode: 2 }), root.output('c2'), root.usage(),
      root.spawn('sp1', 'helper'), root.activity('sp1', 'sub1', '/root/helper'), root.output('sp1', 'started', 'function'), root.usage(),
      ...root.assistant('m1', 'done'), root.complete(),
      root.started('t2'), root.user('u2', 'again'), root.exec('c3', 'rm x'), root.output('c3'), root.usage(), root.complete(),
    ];
    const transcriptSub = [
      sub.meta(), sub.started('st1'), sub.context('user', 'do the sub task', 'task1'),
      sub.exec('k1', 'pwd'), sub.output('k1'), sub.usage(), ...sub.assistant('sm1', 'sub done'), sub.complete(),
    ];
    return { transcriptRoot, transcriptSub, hooks };
  }
  const strip = (nodes: Record<string, GraphNode>) =>
    Object.fromEntries(Object.entries(nodes).map(([id, x]) => [id, { ...x, timestamp: '', durationMs: null }]));

  test('有 hooks（任意穿插）与没有 hooks：节点集合、字段（开始时间和耗时除外）和边都相同；同一顺序重放结果相同', () => {
    const { transcriptRoot, transcriptSub, hooks } = scenario();
    const plain = run(new CodexNormalizer(), interleave([transcriptRoot, transcriptSub], 7));
    expect(plain.unknown).toEqual([]);
    for (let seed = 1; seed <= 40; seed++) {
      const order = interleave([transcriptRoot, transcriptSub, hooks], seed);
      const withHooks = run(new CodexNormalizer(), order);
      expect(withHooks.unknown).toEqual([]);
      expect(strip(withHooks.graph.nodes)).toEqual(strip(plain.graph.nodes));
      expect(withHooks.graph.edges).toEqual(plain.graph.edges);
      for (const x of Object.values(withHooks.graph.nodes)) expect(x.confirmed).toBe(true);
      // Replaying the same stored order gives exactly the same graph.
      expect(run(new CodexNormalizer(), order).graph).toEqual(withHooks.graph);
    }
  });

  test('hook 比转录早到：开始时间取更早的那个', () => {
    const { transcriptRoot, transcriptSub, hooks } = scenario();
    const hooksFirst = run(new CodexNormalizer(), [...hooks, ...transcriptRoot, ...transcriptSub]);
    const plain = run(new CodexNormalizer(), [...transcriptRoot, ...transcriptSub]);
    for (const id of ['tool:c1', 'tool:c2', 'tool:c3', 'tool:k1']) {
      expect(hooksFirst.graph.nodes[id]!.timestamp < plain.graph.nodes[id]!.timestamp).toBe(true);
      expect(hooksFirst.graph.nodes[id]!.status).toBe(plain.graph.nodes[id]!.status);
    }
    expect(hooksFirst.graph.nodes['tool:c2']!.status).toBe('failed');
  });
});
