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
  expect(graph.nodes['tool:tu9']).toMatchObject({ kind: 'subagent', agentId: 'ag1' });
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

test('终态节点仍可补上 durationMs', () => {
  const { graph } = run(n, [
    userPrompt('u1', null, 'x'),
    use(),
    toolResult('u2', 'a1', 'tu1', 'ok'),
    hook('PostToolUse', { tool_use_id: 'tu1', tool_response: 'ok', duration_ms: 7 }),
  ]);
  expect(graph.nodes['tool:tu1']).toMatchObject({ status: 'succeeded', durationMs: 7 });
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
