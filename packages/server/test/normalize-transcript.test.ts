import { beforeEach, expect, test } from 'vitest';
import type { Change } from '@claude-canvas/shared';
import { Normalizer } from '../src/normalize/normalizer.js';
import { summarize } from '../src/normalize/summary.js';
import { assistantBlock, rawLine, run, toolResult, userPrompt } from './fixtures.js';

let n: Normalizer;
beforeEach(() => {
  n = new Normalizer();
});

test('一轮对话：prompt → thinking → tool → result → text', () => {
  const { graph, changes } = run(n, [
    userPrompt('u1', null, '修一下登录', { promptId: 'p1' }),
    assistantBlock('a1', 'u1', { type: 'thinking', thinking: '' }, { messageId: 'm1', thinkingDurationMs: 1200 }),
    assistantBlock('a2', 'a1', { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x.ts' } }, { messageId: 'm1' }),
    toolResult('u2', 'a2', 'tu1', 'file body'),
    assistantBlock('a3', 'u2', { type: 'text', text: '改好了' }, { messageId: 'm2', stopReason: 'end_turn' }),
  ]);
  expect(Object.keys(graph.nodes)).toEqual(['u1', 'a1', 'tool:tu1', 'a3']);
  expect(graph.nodes.a1).toMatchObject({ kind: 'thinking', durationMs: 1200, summary: '', turnId: 'p1', parentId: 'u1' });
  expect(graph.nodes['tool:tu1']).toMatchObject({ kind: 'tool', status: 'succeeded', title: 'Read', confirmed: true, parentId: 'a1' });
  expect(graph.nodes.a3.parentId).toBe('tool:tu1');
  expect(Object.keys(graph.edges)).toEqual(['u1->a1', 'a1->tool:tu1', 'tool:tu1->a3']);
  const statuses = changes.flatMap((c) => (c.type === 'session_upserted' ? [c.session.status] : []));
  expect(statuses[0]).toBe('idle');
  expect(statuses).toContain('running');
  expect(statuses.at(-1)).toBe('idle');
});

test('工具出错标记 failed', () => {
  const { graph } = run(n, [
    userPrompt('u1', null, 'x'),
    assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'exit 1' } }),
    toolResult('u2', 'a1', 'tu1', 'boom', true),
  ]);
  expect(graph.nodes['tool:tu1'].status).toBe('failed');
});

test('Agent 工具产生 subagent 节点', () => {
  const { graph } = run(n, [
    userPrompt('u1', null, 'x'),
    assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Agent', input: { description: 'review', prompt: '...' } }),
  ]);
  expect(graph.nodes['tool:tu1']).toMatchObject({ kind: 'subagent', status: 'running' });
});

test('未知记录类型不产生变更并上报类型', () => {
  const r = n.apply(rawLine('atis-latch', { atis: 1 }), 'p');
  expect(r).toEqual({ changes: [], unknownRecordType: 'atis-latch' });
});

test('attachment 不产生节点但不打断父链', () => {
  const { graph, unknown } = run(n, [
    userPrompt('u1', null, 'x'),
    rawLine('attachment', { uuid: 'at1', parentUuid: 'u1', attachment: {} }),
    assistantBlock('a1', 'at1', { type: 'text', text: 'hi' }),
  ]);
  expect(graph.nodes.a1.parentId).toBe('u1');
  expect(unknown).toEqual([]);
});

test('结构异常的 assistant 记录成为 unknown 节点', () => {
  const { graph } = run(n, [userPrompt('u1', null, 'x'), rawLine('assistant', { uuid: 'a1', parentUuid: 'u1', message: {} })]);
  expect(graph.nodes.a1).toMatchObject({ kind: 'unknown', title: 'Unknown', parentId: 'u1' });
});

test('没有 uuid 的记录计为 malformed 类型', () => {
  const r = n.apply(rawLine('assistant', { message: {} }), 'p');
  expect(r).toEqual({ changes: [], unknownRecordType: 'assistant:malformed' });
});

test('非法 JSON 不抛出', () => {
  const ev = { ...userPrompt('u1', null, 'x'), line: '{not json' };
  expect(n.apply(ev, 'p')).toEqual({ changes: [], unknownRecordType: 'invalid-json' });
});

test('isMeta 的 user 记录不产生 prompt', () => {
  const { graph } = run(n, [userPrompt('u1', null, 'caveat', { isMeta: true })]);
  expect(graph.nodes).toEqual({});
});

test('摘要截断到 200 字符，完整内容在 detail', () => {
  const { changes } = run(n, [
    userPrompt('u1', null, 'x'),
    assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Write', input: { content: 'y'.repeat(5_000_000) } }),
  ]);
  const added = changes.find(
    (c): c is Extract<Change, { type: 'node_added' }> => c.type === 'node_added' && c.node.id === 'tool:tu1',
  )!;
  expect(added.node.summary.length).toBe(200);
  expect(added.node.summary.endsWith('…')).toBe(true);
  expect((added.detail.input as { content: string }).content).toHaveLength(5_000_000);
});

test('重复的 tool_result 不重复发状态变更', () => {
  const events = [
    userPrompt('u1', null, 'x'),
    assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Read', input: {} }),
    toolResult('u2', 'a1', 'tu1', 'ok'),
    toolResult('u3', 'u2', 'tu1', 'ok'),
  ];
  const { changes } = run(n, events);
  expect(changes.filter((c) => c.type === 'node_updated' && c.patch.status).length).toBe(1);
});

test('compact_boundary 产生 system 节点', () => {
  const { graph } = run(n, [
    userPrompt('u1', null, 'x'),
    rawLine('system', { uuid: 'sy1', parentUuid: 'u1', subtype: 'compact_boundary' }),
  ]);
  expect(graph.nodes.sy1).toMatchObject({ kind: 'system', systemSubtype: 'compact', title: 'Compact' });
});

test('hook 先到的 tool 节点被 JSONL 记录确认，不改 status', () => {
  run(n, [userPrompt('u1', null, 'x')]);
  // Hook events are not normalized yet (Task 6), so an already-existing node is simulated by a repeated tool_use id.
  const { changes } = run(n, [
    assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x.ts' } }),
    assistantBlock('a2', 'u1', { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x.ts' } }),
  ]);
  const updated = changes.find((c) => c.type === 'node_updated');
  expect(updated).toMatchObject({ patch: { confirmed: true } });
  expect(updated && updated.type === 'node_updated' && 'status' in updated.patch).toBe(false);
});

test('会话变更：每次实际变化发一次，无变化不发', () => {
  const r1 = n.apply(userPrompt('u1', null, 'x'), 'p1');
  const sessions1 = r1.changes.filter((c) => c.type === 'session_upserted');
  expect(sessions1).toHaveLength(2);
  expect(r1.changes.slice(0, 2).every((c) => c.type === 'session_upserted')).toBe(true);
  expect(n.hasSession('s1')).toBe(true);
  n.dropSession('s1');
  expect(n.hasSession('s1')).toBe(false);
});

test('projectId 为 unknown 时被参数值更新', () => {
  const first = n.apply(userPrompt('u1', null, 'x'), 'unknown');
  expect(first.changes[0]).toMatchObject({ type: 'session_upserted', session: { projectId: 'unknown' } });
  const second = n.apply(assistantBlock('a1', 'u1', { type: 'text', text: 'hi' }), 'real');
  expect(second.changes[0]).toMatchObject({ type: 'session_upserted', session: { projectId: 'real' } });
});

test('summarize 压缩空白并截断', () => {
  expect(summarize('a \n\t b')).toBe('a b');
  expect(summarize({ a: 1 })).toBe('{"a":1}');
  expect(summarize(undefined)).toBe('');
  expect(summarize('z'.repeat(300))).toBe('z'.repeat(199) + '…');
});

test('终态节点的 tool_result 仍补上 output，但不发状态变更', () => {
  const { changes } = run(n, [
    userPrompt('u1', null, 'x'),
    assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Read', input: {} }),
    toolResult('u2', 'a1', 'tu1', 'first'),
    toolResult('u3', 'u2', 'tu1', 'second'),
  ]);
  const updates = changes.filter(
    (c): c is Extract<Change, { type: 'node_updated' }> => c.type === 'node_updated',
  );
  expect(updates).toHaveLength(2);
  expect('status' in updates[1].patch).toBe(false);
  expect(updates[1].detail).toEqual({ output: 'second' });
});

test('未知类型但带 uuid 的记录不打断父链', () => {
  const { graph, unknown } = run(n, [
    userPrompt('u1', null, 'x'),
    rawLine('progress', { uuid: 'x1', parentUuid: 'u1' }),
    assistantBlock('a1', 'x1', { type: 'text', text: 'hi' }),
  ]);
  expect(graph.nodes.a1.parentId).toBe('u1');
  expect(graph.edges['u1->a1']).toBeDefined();
  expect(unknown).toEqual(['progress']);
});

test('数组内容的 user 记录（text/image）是 prompt', () => {
  const content = [{ type: 'text', text: '看这张图' }, { type: 'image', source: {} }];
  const { graph, changes } = run(n, [
    rawLine('user', { uuid: 'u1', parentUuid: null, message: { role: 'user', content } }),
  ]);
  expect(graph.nodes.u1).toMatchObject({ kind: 'prompt', summary: '看这张图 [image]' });
  const statuses = changes.flatMap((c) => (c.type === 'session_upserted' ? [c.session.status] : []));
  expect(statuses.at(-1)).toBe('running');
  const meta = run(new Normalizer(), [
    rawLine('user', { uuid: 'u1', parentUuid: null, isMeta: true, message: { role: 'user', content } }),
  ]);
  expect(meta.graph.nodes).toEqual({});
});

test('确认已有 tool 节点时不重复发边', () => {
  const { changes } = run(n, [
    userPrompt('u1', null, 'x'),
    assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Read', input: {} }),
    assistantBlock('a2', 'u1', { type: 'tool_use', id: 'tu1', name: 'Read', input: {} }),
  ]);
  const edges = changes.filter((c) => c.type === 'edge_added' && c.edge.id === 'u1->tool:tu1');
  expect(edges).toHaveLength(1);
});

test('lastActivityAt 不会倒退', () => {
  const r1 = n.apply(userPrompt('u1', null, 'x', { timestamp: '2026-02-01T00:00:10.000Z' }), 'p1');
  const r2 = n.apply(rawLine('attachment', { uuid: 'at1', parentUuid: 'u1', timestamp: '2026-02-01T00:00:05.000Z' }), 'p1');
  const last = r1.changes.filter((c) => c.type === 'session_upserted').at(-1);
  expect(last).toMatchObject({ session: { lastActivityAt: '2026-02-01T00:00:10.000Z' } });
  expect(r2.changes).toEqual([]);
});

// ---- final fix wave, group 1: session status truthfulness ----

const statusesOf = (changes: Change[]) => changes.flatMap((c) => (c.type === 'session_upserted' ? [c.session.status] : []));

test.each([
  ['字符串内容', '[Request interrupted by user]'],
  ['数组内容', [{ type: 'text', text: '  [Request interrupted by user for tool use]' }]],
])('中断标记产生 interrupt 系统节点并把会话置为 idle：%s', (_name, content) => {
  const { graph, changes } = run(n, [
    userPrompt('u1', null, 'x', { promptId: 'p1' }),
    assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }),
    rawLine('user', { uuid: 'i1', parentUuid: 'a1', message: { role: 'user', content } }),
  ]);
  const text = typeof content === 'string' ? content : content[0]!.text;
  expect(graph.nodes.i1).toMatchObject({ kind: 'system', systemSubtype: 'interrupt', title: 'Interrupted', summary: summarize(text.trimStart()), parentId: 'tool:tu1', turnId: 'p1' });
  expect(statusesOf(changes).at(-1)).toBe('idle');
});

test('中断标记不开启新一轮', () => {
  const { graph } = run(n, [
    userPrompt('u1', null, 'x', { promptId: 'p1' }),
    rawLine('user', { uuid: 'i1', parentUuid: 'u1', promptId: 'p2', message: { role: 'user', content: '[Request interrupted by user]' } }),
    assistantBlock('a1', 'i1', { type: 'text', text: 'hi' }),
  ]);
  expect(graph.nodes.a1).toMatchObject({ turnId: 'p1', parentId: 'i1' });
});

test('子代理里的中断标记产生节点但不改会话状态', () => {
  const { graph, changes } = run(n, [
    userPrompt('u1', null, 'x'),
    userPrompt('s1', null, '[Request interrupted by user]', { agentId: 'ag1' }),
  ]);
  expect(graph.nodes.s1).toMatchObject({ kind: 'system', systemSubtype: 'interrupt', agentId: 'ag1' });
  expect(statusesOf(changes).at(-1)).toBe('running');
});

test.each([
  '<local-command-stdout>ok</local-command-stdout>',
  '<local-command-stderr>err</local-command-stderr>',
  '<command-name>/clear</command-name>',
  '<command-message>clear</command-message>',
  '<command-args></command-args>',
  '<bash-input>ls</bash-input>',
  '<bash-stdout>a</bash-stdout>',
  '<bash-stderr>b</bash-stderr>',
  '<task-notification>done</task-notification>',
  '\n  <system-reminder>r</system-reminder>',
  '<ci-monitor-event>x</ci-monitor-event>',
  '<side-sessions-event>x</side-sessions-event>',
])('非提示的 user 记录静默：%s', (text) => {
  for (const content of [text, [{ type: 'text', text }]]) {
    const m = new Normalizer();
    run(m, [userPrompt('u1', null, 'x'), assistantBlock('a1', 'u1', { type: 'text', text: 'done' }, { stopReason: 'end_turn' })]);
    const { graph, changes } = run(m, [
      rawLine('user', { uuid: 'c1', parentUuid: 'a1', message: { role: 'user', content } }),
      assistantBlock('a2', 'c1', { type: 'text', text: 'more' }, { stopReason: 'end_turn' }),
    ]);
    expect(graph.nodes.c1).toBeUndefined();
    expect(graph.nodes.a2!.parentId).toBe('a1');
    expect(statusesOf(changes)).not.toContain('running');
  }
});

test('isCompactSummary 的 user 记录静默', () => {
  run(n, [userPrompt('u1', null, 'x'), assistantBlock('a1', 'u1', { type: 'text', text: 'done' }, { stopReason: 'end_turn' })]);
  const { graph, changes } = run(n, [
    userPrompt('c1', 'a1', 'This session is being continued...', { isCompactSummary: true }),
    assistantBlock('a2', 'c1', { type: 'text', text: 'more' }, { stopReason: 'end_turn' }),
  ]);
  expect(graph.nodes.c1).toBeUndefined();
  expect(graph.nodes.a2!.parentId).toBe('a1');
  expect(statusesOf(changes)).not.toContain('running');
});

test.each([[null], ['tool_use'], ['max_tokens']])('非 end_turn 的主线 assistant 记录意味着 running：%s', (stopReason) => {
  const { changes } = run(n, [
    userPrompt('u1', null, 'x'),
    assistantBlock('a1', 'u1', { type: 'text', text: 'done' }, { stopReason: 'end_turn' }),
    assistantBlock('a2', 'a1', { type: 'text', text: 'again' }, stopReason === null ? {} : { stopReason }),
  ]);
  expect(statusesOf(changes).at(-1)).toBe('running');
});

test('迟到的非 end_turn assistant 记录不覆盖较新的状态', () => {
  const { changes } = run(n, [
    userPrompt('u1', null, 'x', { timestamp: '2026-03-01T00:00:01.000Z' }),
    assistantBlock('a1', 'u1', { type: 'text', text: 'done' }, { stopReason: 'end_turn', timestamp: '2026-03-01T00:00:05.000Z' }),
    assistantBlock('a0', 'u1', { type: 'text', text: 'earlier' }, { timestamp: '2026-03-01T00:00:03.000Z' }),
  ]);
  expect(statusesOf(changes).at(-1)).toBe('idle');
});

// ---- final fix wave, group 3: every content block of an assistant record ----

const multi = (uuid: string, parentUuid: string | null, blocks: object[], over: { stopReason?: string; messageId?: string; thinkingDurationMs?: number } = {}) => {
  const ev = assistantBlock(uuid, parentUuid, blocks[0] ?? {}, over);
  if (ev.source !== 'transcript') throw new Error('unreachable');
  const record = JSON.parse(ev.line) as { message: { content: object[] } };
  record.message.content = blocks;
  return { ...ev, line: JSON.stringify(record) };
};

test('多个内容块按顺序各成节点并依次相连', () => {
  const { graph } = run(n, [
    userPrompt('u1', null, 'x'),
    multi('a1', 'u1', [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: '先看看' },
      { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x' } },
    ], { thinkingDurationMs: 300 }),
    toolResult('u2', 'a1', 'tu1', 'body'),
    assistantBlock('a2', 'u2', { type: 'text', text: 'ok' }),
  ]);
  expect(Object.keys(graph.nodes)).toEqual(['u1', 'a1', 'a1#1', 'tool:tu1', 'a2']);
  expect(graph.nodes.a1).toMatchObject({ kind: 'thinking', parentId: 'u1', durationMs: 300 });
  expect(graph.nodes['a1#1']).toMatchObject({ kind: 'text', parentId: 'a1', summary: '先看看' });
  expect(graph.nodes['tool:tu1']).toMatchObject({ kind: 'tool', parentId: 'a1#1', status: 'succeeded' });
  expect(graph.nodes.a2!.parentId).toBe('tool:tu1');
  expect(Object.keys(graph.edges)).toEqual(['u1->a1', 'a1->a1#1', 'a1#1->tool:tu1', 'tool:tu1->a2']);
});

test('同一记录里的多个 tool_use 按批次规则分叉', () => {
  const { graph } = run(n, [
    userPrompt('u1', null, 'x'),
    multi('a1', 'u1', [
      { type: 'text', text: '查两个' },
      { type: 'tool_use', id: 'tA', name: 'Read', input: {} },
      { type: 'tool_use', id: 'tB', name: 'Read', input: {} },
    ], { messageId: 'm1' }),
    toolResult('u2', 'a1', 'tA', 'a'),
    toolResult('u3', 'u2', 'tB', 'b'),
    assistantBlock('a2', 'u3', { type: 'text', text: 'done' }, { messageId: 'm2' }),
  ]);
  expect(graph.nodes['tool:tA']!.parentId).toBe('a1');
  expect(graph.nodes['tool:tB']!.parentId).toBe('a1');
  expect(graph.edges['a1->tool:tB']!.kind).toBe('fork');
  expect(graph.edges['a1->tool:tA:fork']!.kind).toBe('fork');
  expect(graph.nodes.a2!.parentId).toBe('tool:tB');
  expect(graph.edges['tool:tA->a2']).toBeDefined();
});

test('未知类型的内容块被跳过；块 id 用内容数组下标', () => {
  const { graph, unknown } = run(n, [
    userPrompt('u1', null, 'x'),
    multi('a1', 'u1', [{ type: 'server_tool_use', id: 'z' }, { type: 'text', text: 'hi' }, { type: 'redacted_thinking' }, { type: 'text', text: 'there' }]),
  ]);
  expect(Object.keys(graph.nodes)).toEqual(['u1', 'a1#1', 'a1#3']);
  expect(graph.nodes['a1#1']!.parentId).toBe('u1');
  expect(graph.nodes['a1#3']!.parentId).toBe('a1#1');
  expect(unknown).toEqual([]);
});

test('没有可识别内容块的 assistant 记录仍是 unknown 节点', () => {
  const { graph } = run(n, [userPrompt('u1', null, 'x'), multi('a1', 'u1', [{ type: 'server_tool_use' }, { type: 'thinking' }])]);
  expect(graph.nodes.a1).toMatchObject({ kind: 'unknown', parentId: 'u1' });
});

test('多块记录的 end_turn 把会话置为 idle', () => {
  const { changes } = run(n, [
    userPrompt('u1', null, 'x'),
    multi('a1', 'u1', [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'done' }], { stopReason: 'end_turn' }),
  ]);
  expect(statusesOf(changes).at(-1)).toBe('idle');
});
