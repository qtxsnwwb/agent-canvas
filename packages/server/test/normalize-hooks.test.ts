import { beforeEach, expect, test } from 'vitest';
import type { Change } from '@claude-canvas/shared';
import type { RawEvent } from '../src/store/store.js';
import { Normalizer } from '../src/normalize/normalizer.js';
import { agentMeta, assistantBlock, hook, run, toolResult, userPrompt } from './fixtures.js';

let n: Normalizer;
beforeEach(() => {
  n = new Normalizer();
});

const pre = (id = 'tu1', input: object = { command: 'ls' }, name = 'Bash') =>
  hook('PreToolUse', { tool_name: name, tool_input: input, tool_use_id: id });
const use = (id = 'tu1', input: object = { command: 'ls' }, name = 'Bash') =>
  assistantBlock('a1', 'u1', { type: 'tool_use', id, name, input });

const sessionChanges = (changes: Change[]) => changes.filter((c) => c.type === 'session_upserted');
const lastStatus = (changes: Change[]) => {
  const last = sessionChanges(changes).at(-1);
  return last?.type === 'session_upserted' ? last.session.status : undefined;
};

test('hook 先到：占位节点，JSONL 到达后确认且 id 不变', () => {
  const { graph, changes } = run(n, [userPrompt('u1', null, 'x'), pre(), use()]);
  expect(Object.keys(graph.nodes)).toEqual(['u1', 'tool:tu1']);
  expect(graph.nodes['tool:tu1']).toMatchObject({ confirmed: true, parentId: 'u1', status: 'running' });
  const added = changes.find((c) => c.type === 'node_added' && c.node.id === 'tool:tu1');
  expect(added?.type === 'node_added' && added.node.confirmed).toBe(false);
});

test('PreToolUse 占位节点的字段', () => {
  const ev = pre('tu1', { command: 'ls' });
  const { changes } = run(n, [ev]);
  const added = changes.find((c) => c.type === 'node_added');
  expect(added).toMatchObject({
    node: {
      id: 'tool:tu1',
      kind: 'tool',
      status: 'running',
      confirmed: false,
      agentId: null,
      parentId: null,
      turnId: null,
      toolName: 'Bash',
      toolUseId: 'tu1',
      summary: '{"command":"ls"}',
      timestamp: ev.source === 'hook' ? ev.receivedAt : '',
    },
    detail: { input: { command: 'ls' } },
  });
});

test('PreToolUse 带 agent_id 和 Agent 工具名', () => {
  const { graph } = run(n, [
    hook('PreToolUse', { tool_name: 'Task', tool_input: { description: 'd' }, tool_use_id: 'tu9', agent_id: 'ag1' }),
  ]);
  expect(graph.nodes['tool:tu9']).toMatchObject({ kind: 'subagent', agentId: 'ag1', childAgentId: null });
});

test('JSONL 先到：PreToolUse 不产生节点变更', () => {
  run(n, [userPrompt('u1', null, 'x'), use()]);
  const r = n.apply(pre(), 'p');
  expect(r.changes.filter((c) => c.type !== 'session_upserted')).toEqual([]);
});

test('只有 hook：节点保持未确认并能走到终态', () => {
  const { graph } = run(n, [pre(), hook('PostToolUse', { tool_use_id: 'tu1', tool_response: 'ok', duration_ms: 40 })]);
  expect(graph.nodes['tool:tu1']).toMatchObject({ confirmed: false, status: 'succeeded', durationMs: 40 });
});

test('PostToolUse 写入 detail.output', () => {
  const { changes } = run(n, [pre(), hook('PostToolUse', { tool_use_id: 'tu1', tool_response: 'ok', duration_ms: 40 })]);
  expect(changes.at(-1)).toMatchObject({ type: 'node_updated', id: 'tool:tu1', detail: { output: 'ok' } });
});

test('只有 JSONL：状态由内容推断', () => {
  const { graph } = run(n, [userPrompt('u1', null, 'x'), use(), toolResult('u2', 'a1', 'tu1', 'ok')]);
  expect(graph.nodes['tool:tu1']!.status).toBe('succeeded');
});

test('PermissionRequest 按工具名和入参匹配最新的执行中节点', () => {
  const { graph, changes } = run(n, [
    pre('tu1', { command: 'ls' }),
    pre('tu2', { command: 'rm x' }),
    hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm x' } }),
  ]);
  expect(graph.nodes['tool:tu2']!.status).toBe('awaiting_permission');
  expect(graph.nodes['tool:tu1']!.status).toBe('running');
  expect(lastStatus(changes)).toBe('awaiting_permission');
});

test('PermissionRequest 多个相同入参时取 timestamp 最新的', () => {
  const { graph } = run(n, [pre('tu1'), pre('tu2'), hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } })]);
  expect(graph.nodes['tool:tu2']!.status).toBe('awaiting_permission');
  expect(graph.nodes['tool:tu1']!.status).toBe('running');
});

test('PermissionRequest 匹配不到节点时只改会话状态', () => {
  const { graph, changes } = run(n, [pre(), hook('PermissionRequest', { tool_name: 'Write', tool_input: {} })]);
  expect(graph.nodes['tool:tu1']!.status).toBe('running');
  expect(lastStatus(changes)).toBe('awaiting_permission');
});

test('PermissionRequest 不跨 agent 匹配', () => {
  const { graph } = run(n, [
    pre(),
    hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' }, agent_id: 'ag1' }),
  ]);
  expect(graph.nodes['tool:tu1']!.status).toBe('running');
});

test('PermissionRequest 也能匹配由 JSONL 建立的节点', () => {
  const { graph } = run(n, [
    userPrompt('u1', null, 'x'),
    use(),
    hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } }),
  ]);
  expect(graph.nodes['tool:tu1']!.status).toBe('awaiting_permission');
});

test('等待权限的节点可被 tool_result 推到终态', () => {
  const { graph } = run(n, [
    userPrompt('u1', null, 'x'),
    pre(),
    use(),
    hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } }),
    toolResult('u2', 'a1', 'tu1', 'ok'),
  ]);
  expect(graph.nodes['tool:tu1']!.status).toBe('succeeded');
});

test('终态不回退', () => {
  const { graph } = run(n, [
    pre(),
    hook('PermissionDenied', { tool_use_id: 'tu1', reason: 'no' }),
    hook('PostToolUse', { tool_use_id: 'tu1', tool_response: 'late' }),
    hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } }),
  ]);
  expect(graph.nodes['tool:tu1']!.status).toBe('denied');
});

test('终态节点仍可补上 durationMs（起止时间推不出耗时时）', () => {
  const { graph } = run(n, [
    userPrompt('u1', null, 'x'),
    assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }, { timestamp: 'not-a-time' }),
    toolResult('u2', 'a1', 'tu1', 'ok'),
    hook('PostToolUse', { tool_use_id: 'tu1', tool_response: 'ok', duration_ms: 7 }),
  ]);
  expect(graph.nodes['tool:tu1']).toMatchObject({ status: 'succeeded', durationMs: 7 });
});

test('tool_result 先到并已推出耗时：之后 hook 的 duration_ms 不覆盖（先到先得）', () => {
  const { graph } = run(n, [
    userPrompt('u1', null, 'x'),
    assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }, { timestamp: '2026-03-01T10:00:00.000Z' }),
    toolResult('u2', 'a1', 'tu1', 'ok', undefined, { timestamp: '2026-03-01T10:00:02.000Z' }),
    hook('PostToolUse', { tool_use_id: 'tu1', tool_response: 'ok', duration_ms: 7 }),
  ]);
  expect(graph.nodes['tool:tu1']).toMatchObject({ durationMs: 2000, endedAt: '2026-03-01T10:00:02.000Z' });
});

test('PostToolUseFailure 标记 failed', () => {
  const { graph, changes } = run(n, [pre(), hook('PostToolUseFailure', { tool_use_id: 'tu1', error: 'boom', duration_ms: 3 })]);
  expect(graph.nodes['tool:tu1']).toMatchObject({ status: 'failed', durationMs: 3 });
  expect(changes.at(-1)).toMatchObject({ detail: { output: 'boom' } });
});

test('目标节点不存在的 Post* 与 PermissionDenied 只更新会话', () => {
  const { graph, changes } = run(n, [
    hook('PostToolUse', { tool_use_id: 'zz', tool_response: 'x' }),
    hook('PermissionDenied', { tool_use_id: 'zz' }),
  ]);
  expect(Object.keys(graph.nodes)).toEqual([]);
  expect(lastStatus(changes)).toBe('running');
});

test.each([
  [[hook('UserPromptSubmit', { prompt: 'x' })], 'running'],
  [[hook('UserPromptSubmit', {}), hook('Stop', {})], 'idle'],
  [[hook('UserPromptSubmit', {}), hook('StopFailure', { error: 'rate_limit' })], 'idle'],
  [[hook('Notification', { notification_type: 'idle_prompt', message: '' })], 'awaiting_input'],
  [[hook('Notification', { notification_type: 'permission_prompt', message: '' })], 'awaiting_permission'],
  [[hook('UserPromptSubmit', {}), hook('Notification', { notification_type: 'auth_success' })], 'running'],
  [[hook('SessionStart', { source: 'startup' }), hook('SessionEnd', { reason: 'other' })], 'ended'],
  [[hook('SessionEnd', {}), hook('Stop', {})], 'ended'],
  [[hook('SessionEnd', {}), hook('PostToolUse', { tool_use_id: 'x' })], 'ended'],
  [[hook('SessionEnd', {}), hook('SessionStart', { source: 'resume' })], 'idle'],
  [[hook('SessionEnd', {}), hook('UserPromptSubmit', {})], 'running'],
])('会话状态 %#', (events, expected) => {
  const { changes } = run(n, events);
  expect(lastStatus(changes)).toBe(expected);
});

test('SubagentStart 不改变任何东西，会话状态不变', () => {
  const { changes } = run(n, [hook('UserPromptSubmit', {}), hook('SubagentStart', { agent_id: 'ag1', agent_type: 'Explore' })]);
  expect(lastStatus(changes)).toBe('running');
});

test('SubagentStop 结束派发节点', () => {
  const { graph } = run(n, [
    pre('tu1', { description: 'd' }, 'Agent'),
    agentMeta('ag1', { toolUseId: 'tu1', agentType: 'Explore', description: 'd' }),
    hook('SubagentStop', { agent_id: 'ag1', agent_type: 'Explore' }),
  ]);
  expect(graph.nodes['tool:tu1']).toMatchObject({ kind: 'subagent', status: 'succeeded' });
});

test('SubagentStop 不覆盖已到终态的派发节点，未知 agent 被忽略', () => {
  const { graph } = run(n, [
    pre('tu1', { description: 'd' }, 'Agent'),
    agentMeta('ag1', { toolUseId: 'tu1', agentType: 'Explore', description: 'd' }),
    hook('PostToolUseFailure', { tool_use_id: 'tu1', error: 'x' }),
    hook('SubagentStop', { agent_id: 'ag1' }),
    hook('SubagentStop', { agent_id: 'ghost' }),
  ]);
  expect(graph.nodes['tool:tu1']!.status).toBe('failed');
});

test('PostCompact 创建未确认的 compact 系统节点', () => {
  const ev = hook('PostCompact', { trigger: 'auto', compact_summary: '摘要\n正文' });
  const { graph } = run(n, [ev]);
  const id = `compact:s1:${ev.source === 'hook' ? ev.receivedAt : ''}`;
  expect(graph.nodes[id]).toMatchObject({
    kind: 'system',
    systemSubtype: 'compact',
    confirmed: false,
    title: 'Compact',
    summary: '摘要 正文',
  });
});

test('hook 创建会话：cwd、时间、projectId 来自 hook，之后被 transcript 升级', () => {
  const ev = hook('SessionStart', { source: 'startup' });
  const r = n.apply(ev, 'unknown');
  const receivedAt = ev.source === 'hook' ? ev.receivedAt : '';
  expect(r.changes).toEqual([
    {
      type: 'session_upserted',
      session: {
        id: 's1',
        projectId: 'unknown',
        cwd: '/w',
        title: null,
        gitBranch: null,
        status: 'idle',
        sourceDeleted: false,
        startedAt: receivedAt,
        lastActivityAt: receivedAt,
      },
    },
  ]);
  const second = n.apply(userPrompt('u1', null, 'x'), 'real');
  expect(second.changes[0]).toMatchObject({ type: 'session_upserted', session: { projectId: 'real' } });
});

test('hook 的 receivedAt 推进 lastActivityAt 但不回退', () => {
  const early = hook('Stop', {});
  const late = hook('Stop', {});
  const { changes } = run(n, [late, early]);
  const lateAt = late.source === 'hook' ? late.receivedAt : '';
  expect(sessionChanges(changes)).toHaveLength(1);
  expect(sessionChanges(changes)[0]).toMatchObject({ session: { lastActivityAt: lateAt } });
  const again = n.apply(early, 'p');
  expect(again.changes).toEqual([]);
});

const withPayload = (ev: RawEvent, payload: string): RawEvent => ({ ...(ev as Extract<RawEvent, { source: 'hook' }>), payload });

test('未知事件名和损坏载荷不抛出', () => {
  expect(n.apply(hook('FileChanged', {}), 'p').unknownRecordType).toBe('hook:FileChanged');
  expect(n.apply(withPayload(hook('Stop', {}), 'not json'), 'p')).toEqual({ changes: [], unknownRecordType: 'hook:invalid' });
  expect(n.apply(withPayload(hook('Stop', {}), '{}'), 'p').unknownRecordType).toBe('hook:invalid');
});

const T = (sec: number) => new Date(Date.parse('2026-02-01T00:00:00.000Z') + sec * 1000).toISOString();
const lagScenario = () => [
  hook('UserPromptSubmit', {}, T(10)),
  pre(),
  hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } }, T(12)),
  userPrompt('u1', null, 'x', { timestamp: T(9) }),
];

test('迟到的 transcript prompt 不覆盖较新的 hook 状态', () => {
  const events = lagScenario();
  events.splice(1, 1, hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'tu1' }, T(11)));
  const { graph, changes } = run(n, events);
  expect(lastStatus(changes)).toBe('awaiting_permission');
  expect(graph.nodes.u1).toBeDefined();
  expect(graph.nodes['tool:tu1']!.status).toBe('awaiting_permission');
});

test('迟到的 prompt 不把 Stop 之后的 idle 改回 running', () => {
  const { changes } = run(n, [hook('Stop', {}, T(20)), userPrompt('u1', null, 'x', { timestamp: T(15) })]);
  expect(lastStatus(changes)).toBe('idle');
});

test('迟到的 end_turn 不把 running 改回 idle', () => {
  const { changes } = run(n, [
    hook('UserPromptSubmit', {}, T(30)),
    assistantBlock('a1', null, { type: 'text', text: 'done' }, { stopReason: 'end_turn', timestamp: T(25) }),
  ]);
  expect(lastStatus(changes)).toBe('running');
});

test('正常顺序的 transcript 状态照常推进', () => {
  const { changes } = run(n, [
    userPrompt('u1', null, 'x', { timestamp: T(1) }),
    assistantBlock('a1', 'u1', { type: 'text', text: 'ok' }, { stopReason: 'end_turn', timestamp: T(2) }),
  ]);
  expect(lastStatus(changes)).toBe('idle');
  const r = n.apply(userPrompt('u2', 'a1', 'y', { timestamp: T(3) }), 'p1');
  expect(lastStatus(r.changes)).toBe('running');
});

test('相同事件序列重放结果一致', () => {
  const events = lagScenario();
  const a = run(new Normalizer(), events).changes;
  const b = run(new Normalizer(), events).changes;
  expect(a).toEqual(b);
});

// ---- final fix wave, group 2: the content plane overrides hook-derived terminal status ----

const statusUpdates = (changes: Change[], id = 'tool:tu1') =>
  changes.flatMap((c) => (c.type === 'node_updated' && c.id === id && c.patch.status !== undefined ? [c.patch.status] : []));

test.each([
  ['PostToolUse 后 tool_result 报错', hook('PostToolUse', { tool_use_id: 'tu1', tool_response: 'ok' }), true, 'failed'],
  ['PostToolUseFailure 后 tool_result 成功', hook('PostToolUseFailure', { tool_use_id: 'tu1', error: 'x' }), false, 'succeeded'],
])('hook 设的终态被 tool_result 纠正：%s', (_name, settle, isError, expected) => {
  const { graph, changes } = run(n, [userPrompt('u1', null, 'x'), pre(), use(), settle, toolResult('u2', 'a1', 'tu1', 'out', isError)]);
  expect(graph.nodes['tool:tu1']!.status).toBe(expected);
  expect(changes.at(-1)).toMatchObject({ type: 'node_updated', id: 'tool:tu1', detail: { output: 'out' } });
});

test('SubagentStop 设的 succeeded 被报错的 tool_result 纠正为 failed', () => {
  const { graph } = run(n, [
    userPrompt('u1', null, 'x'),
    pre('tu1', { description: 'd' }, 'Agent'),
    use('tu1', { description: 'd' }, 'Agent'),
    agentMeta('ag1', { toolUseId: 'tu1', agentType: 'Explore', description: 'd' }),
    hook('SubagentStop', { agent_id: 'ag1' }),
    toolResult('u2', 'a1', 'tu1', 'crashed', true),
  ]);
  expect(graph.nodes['tool:tu1']!.status).toBe('failed');
});

test('denied 不被 tool_result 改写，但 output 仍写入', () => {
  const { graph, changes } = run(n, [
    userPrompt('u1', null, 'x'),
    pre(),
    use(),
    hook('PermissionDenied', { tool_use_id: 'tu1' }),
    toolResult('u2', 'a1', 'tu1', 'rejected', true),
  ]);
  expect(graph.nodes['tool:tu1']!.status).toBe('denied');
  expect(changes.at(-1)).toMatchObject({ type: 'node_updated', patch: {}, detail: { output: 'rejected' } });
});

test('来自 tool_result 的终态是最终的：之后的 hook 和重复 tool_result 都不改', () => {
  const { graph, changes } = run(n, [
    userPrompt('u1', null, 'x'),
    pre(),
    use(),
    hook('PostToolUse', { tool_use_id: 'tu1', tool_response: 'ok' }),
    toolResult('u2', 'a1', 'tu1', 'boom', true),
    hook('PostToolUse', { tool_use_id: 'tu1', tool_response: 'ok' }),
    toolResult('u3', 'u2', 'tu1', 'ok', false),
  ]);
  expect(graph.nodes['tool:tu1']!.status).toBe('failed');
  expect(statusUpdates(changes)).toEqual(['succeeded', 'failed']);
});

test('tool_result 先到时之后的 PostToolUseFailure 不改终态', () => {
  const { graph } = run(n, [
    userPrompt('u1', null, 'x'),
    use(),
    toolResult('u2', 'a1', 'tu1', 'ok'),
    hook('PostToolUseFailure', { tool_use_id: 'tu1', error: 'late' }),
  ]);
  expect(graph.nodes['tool:tu1']!.status).toBe('succeeded');
});

test('hook 终态与 tool_result 一致时不重复发状态变更', () => {
  const { changes } = run(n, [
    userPrompt('u1', null, 'x'),
    pre(),
    use(),
    hook('PostToolUse', { tool_use_id: 'tu1', tool_response: 'ok' }),
    toolResult('u2', 'a1', 'tu1', 'ok'),
  ]);
  expect(statusUpdates(changes)).toEqual(['succeeded']);
});

test('终态来源在重放时一致', () => {
  const events = [
    userPrompt('u1', null, 'x'),
    pre(),
    use(),
    hook('PostToolUse', { tool_use_id: 'tu1', tool_response: 'ok' }),
    toolResult('u2', 'a1', 'tu1', 'boom', true),
    hook('PostToolUse', { tool_use_id: 'tu1', tool_response: 'ok' }),
  ];
  expect(run(new Normalizer(), events).changes).toEqual(run(new Normalizer(), events).changes);
});

// ---- final fix wave, group 4: tool inputs leave memory once a node is terminal ----

test('终态节点的入参从内存中移除，执行中的仍可被 PermissionRequest 匹配', () => {
  run(n, [userPrompt('u1', null, 'x'), pre('tu1'), use('tu1'), pre('tu2', { command: 'pwd' })]);
  expect(n.toolInputCount('s1')).toBe(2);
  run(n, [toolResult('u2', 'a1', 'tu1', 'ok')]);
  expect(n.toolInputCount('s1')).toBe(1);
  const { changes } = run(n, [hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'pwd' } })]);
  expect(changes).toContainEqual(expect.objectContaining({ type: 'node_updated', id: 'tool:tu2', patch: { status: 'awaiting_permission' } }));
  run(n, [hook('PermissionDenied', { tool_use_id: 'tu2' })]);
  expect(n.toolInputCount('s1')).toBe(0);
});

test('hook 终态之后到达的 tool_use 不再记住入参', () => {
  run(n, [userPrompt('u1', null, 'x'), pre(), hook('PostToolUse', { tool_use_id: 'tu1', tool_response: 'ok' })]);
  expect(n.toolInputCount('s1')).toBe(0);
  run(n, [use()]);
  expect(n.toolInputCount('s1')).toBe(0);
  expect(n.toolInputCount('missing')).toBe(0);
});

test('PostToolUse 先到：endedAt 是 hook 的接收时间，耗时用 hook 的 duration_ms；之后的 tool_result 不改这两项', () => {
  const HOOK_AT = '2026-03-01T10:00:02.000Z';
  const { graph } = run(n, [
    userPrompt('u1', null, 'x'),
    use(),
    hook('PostToolUse', { tool_use_id: 'tu1', tool_response: 'ok', duration_ms: 1234 }, HOOK_AT),
    toolResult('u2', 'a1', 'tu1', 'ok', true, { timestamp: '2026-03-01T10:00:30.000Z' }),
  ]);
  expect(graph.nodes['tool:tu1']).toMatchObject({ status: 'failed', endedAt: HOOK_AT, durationMs: 1234 });
});

test('hook 没带 duration_ms 时由起止时间推出耗时', () => {
  const { graph } = run(n, [
    hook('PreToolUse', { tool_name: 'Bash', tool_input: {}, tool_use_id: 'tu1' }, '2026-03-01T10:00:00.000Z'),
    hook('PostToolUse', { tool_use_id: 'tu1', tool_response: 'ok' }, '2026-03-01T10:00:02.000Z'),
  ]);
  expect(graph.nodes['tool:tu1']).toMatchObject({ endedAt: '2026-03-01T10:00:02.000Z', durationMs: 2000 });
});

test('被拒绝（PermissionDenied）也记 endedAt', () => {
  const AT = '2026-03-01T10:00:05.000Z';
  const { graph } = run(n, [pre(), hook('PermissionDenied', { tool_use_id: 'tu1', reason: 'no' }, AT)]);
  expect(graph.nodes['tool:tu1']).toMatchObject({ status: 'denied', endedAt: AT });
});

test('PostToolUseFailure 与 SubagentStop 也记 endedAt', () => {
  const FAIL_AT = '2026-03-01T10:00:05.000Z';
  const STOP_AT = '2026-03-01T10:00:09.000Z';
  const { graph } = run(n, [
    pre('tu1'),
    hook('PostToolUseFailure', { tool_use_id: 'tu1', error: 'x' }, FAIL_AT),
    agentMeta('ag1', { toolUseId: 'tu2', agentType: 'Explore', description: 'd' }),
    hook('PreToolUse', { tool_name: 'Agent', tool_input: { prompt: 'p' }, tool_use_id: 'tu2' }),
    hook('SubagentStop', { agent_id: 'ag1' }, STOP_AT),
  ]);
  expect(graph.nodes['tool:tu1']).toMatchObject({ status: 'failed', endedAt: FAIL_AT });
  expect(graph.nodes['tool:tu2']).toMatchObject({ kind: 'subagent', status: 'succeeded', endedAt: STOP_AT });
});

const AT = (s: number) => new Date(Date.parse('2026-04-01T10:00:00.000Z') + s * 1000).toISOString();
const useAt = (at: string) => assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }, { timestamp: at });
const preAt = (at: string) => hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'tu1' }, at);

test('hook 先到再由 JSONL 确认：usage 取自消息，timestamp 改为 JSONL 的时间，id 不变', () => {
  const prompt = userPrompt('u1', null, 'x', { timestamp: AT(0) });
  const { graph } = run(n, [prompt, preAt(AT(10)), useAt(AT(5))]);
  const transcriptOnly = run(new Normalizer(), [prompt, useAt(AT(5))]).graph.nodes['tool:tu1']!;
  expect(Object.keys(graph.nodes)).toEqual(['u1', 'tool:tu1']);
  expect(transcriptOnly.usage).not.toBeNull();
  expect(graph.nodes['tool:tu1']).toMatchObject({ usage: transcriptOnly.usage, timestamp: AT(5), confirmed: true });
});

test('hook 先到且 PostToolUse 带 duration_ms，之后 JSONL 确认：耗时仍是 hook 的', () => {
  const { graph } = run(n, [
    userPrompt('u1', null, 'x', { timestamp: AT(0) }),
    preAt(AT(10)),
    hook('PostToolUse', { tool_use_id: 'tu1', tool_response: 'ok', duration_ms: 40 }, AT(20)),
    useAt(AT(5)),
  ]);
  expect(graph.nodes['tool:tu1']).toMatchObject({ timestamp: AT(5), endedAt: AT(20), durationMs: 40 });
});

test('hook 先到且耗时由 hook 起止推出，之后 JSONL 确认：耗时按 JSONL 起点重算', () => {
  const { graph } = run(n, [
    userPrompt('u1', null, 'x', { timestamp: AT(0) }),
    preAt(AT(10)),
    hook('PostToolUse', { tool_use_id: 'tu1', tool_response: 'ok' }, AT(20)),
    useAt(AT(5)),
  ]);
  expect(graph.nodes['tool:tu1']).toMatchObject({ timestamp: AT(5), endedAt: AT(20), durationMs: 15_000 });
});

test('PreToolUse、JSONL tool_use、tool_result：推出的耗时从 JSONL 起点算', () => {
  const { graph } = run(n, [
    userPrompt('u1', null, 'x', { timestamp: AT(0) }),
    preAt(AT(10)),
    useAt(AT(5)),
    toolResult('u2', 'a1', 'tu1', 'ok', false, { timestamp: AT(30) }),
  ]);
  expect(graph.nodes['tool:tu1']).toMatchObject({ timestamp: AT(5), endedAt: AT(30), durationMs: 25_000 });
});

test('hook 先到的工具节点：重放同一批原始事件得到相同节点', () => {
  const events = [
    userPrompt('u1', null, 'x', { timestamp: AT(0) }),
    preAt(AT(10)),
    hook('PostToolUse', { tool_use_id: 'tu1', tool_response: 'ok' }, AT(20)),
    useAt(AT(5)),
    toolResult('u2', 'a1', 'tu1', 'ok', false, { timestamp: AT(30) }),
  ];
  const first = run(n, events).graph;
  const second = run(new Normalizer(), events).graph;
  expect(second.nodes).toEqual(first.nodes);
  expect(first.nodes['tool:tu1']).toMatchObject({ durationMs: 15_000 });
});

test('JSONL 的 tool_use 写得比工具实际执行晚：确认后起点取较早的 hook 时间，耗时不为 0、起点不晚于结束', () => {
  const { graph } = run(n, [
    userPrompt('u1', null, 'x', { timestamp: AT(0) }),
    preAt(AT(1)),
    hook('PostToolUse', { tool_use_id: 'tu1', tool_response: 'ok' }, AT(3)),
    useAt(AT(5)),
  ]);
  expect(graph.nodes['tool:tu1']).toMatchObject({ timestamp: AT(1), endedAt: AT(3), durationMs: 2000 });
});

test('PreToolUse 晚于 JSONL tool_use 到达但接收时间更早：同样把起点降到较早的时间；两种到达顺序得到相同节点', () => {
  const prompt = userPrompt('u1', null, 'x', { timestamp: AT(0) });
  const result = toolResult('u2', 'a1', 'tu1', 'ok', false, { timestamp: AT(9) });
  const hookFirst = run(new Normalizer(), [prompt, preAt(AT(1)), useAt(AT(5)), result]).graph.nodes['tool:tu1'];
  const transcriptFirst = run(n, [prompt, useAt(AT(5)), preAt(AT(1)), result]).graph.nodes['tool:tu1'];
  expect(transcriptFirst).toMatchObject({ timestamp: AT(1), endedAt: AT(9), durationMs: 8000 });
  expect(transcriptFirst).toEqual(hookFirst);
});

test('PreToolUse 在 tool_result 之后到达且接收时间更早：推出的耗时按新起点重算；hook 给的耗时不变', () => {
  const prompt = userPrompt('u1', null, 'x', { timestamp: AT(0) });
  const derived = run(n, [prompt, useAt(AT(5)), toolResult('u2', 'a1', 'tu1', 'ok', false, { timestamp: AT(9) }), preAt(AT(1))]);
  expect(derived.graph.nodes['tool:tu1']).toMatchObject({ timestamp: AT(1), endedAt: AT(9), durationMs: 8000 });
  const fromHook = run(new Normalizer(), [
    prompt,
    useAt(AT(5)),
    hook('PostToolUse', { tool_use_id: 'tu1', tool_response: 'ok', duration_ms: 1234 }, AT(9)),
    preAt(AT(1)),
  ]);
  expect(fromHook.graph.nodes['tool:tu1']).toMatchObject({ timestamp: AT(1), durationMs: 1234 });
});

test('PreToolUse 晚于 JSONL 到达且接收时间更晚：起点保持 JSONL 的时间', () => {
  const { graph } = run(n, [userPrompt('u1', null, 'x', { timestamp: AT(0) }), useAt(AT(5)), preAt(AT(6))]);
  expect(graph.nodes['tool:tu1']!.timestamp).toBe(AT(5));
});

test('较早起点规则下重放同一批原始事件得到相同节点（两种到达顺序）', () => {
  for (const order of ['hook', 'transcript'] as const) {
    const prompt = userPrompt('u1', null, 'x', { timestamp: AT(0) });
    const post = hook('PostToolUse', { tool_use_id: 'tu1', tool_response: 'ok' }, AT(3));
    const events = order === 'hook' ? [prompt, preAt(AT(1)), post, useAt(AT(5))] : [prompt, useAt(AT(5)), preAt(AT(1)), post];
    expect(run(new Normalizer(), events).graph.nodes).toEqual(run(new Normalizer(), events).graph.nodes);
  }
});
