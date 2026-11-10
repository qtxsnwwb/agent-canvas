import { beforeEach, expect, test } from 'vitest';
import type { Change } from '@claude-canvas/shared';
import { Normalizer } from '../src/normalize/normalizer.js';
import type { RawEvent } from '../src/store/store.js';
import { agentMeta, assistantBlock, customTitle, run, toolResult, userPrompt } from './fixtures.js';

let n: Normalizer;
beforeEach(() => {
  n = new Normalizer();
});

const lastSession = (changes: Change[]) => {
  const sessions = changes.flatMap((c) => (c.type === 'session_upserted' ? [c.session] : []));
  return sessions[sessions.length - 1]!;
};

test('并行工具从同一父节点分叉并汇合', () => {
  const { graph } = run(n, [
    userPrompt('u1', null, 'x'),
    assistantBlock('a1', 'u1', { type: 'text', text: '查两个文件' }, { messageId: 'm1' }),
    assistantBlock('a2', 'a1', { type: 'tool_use', id: 'tA', name: 'Read', input: {} }, { messageId: 'm1' }),
    assistantBlock('a3', 'a2', { type: 'tool_use', id: 'tB', name: 'Read', input: {} }, { messageId: 'm1' }),
    toolResult('u2', 'a3', 'tA', 'a'),
    toolResult('u3', 'u2', 'tB', 'b'),
    assistantBlock('a4', 'u3', { type: 'text', text: '完成' }, { messageId: 'm2' }),
  ]);
  expect(graph.nodes['tool:tA']!.parentId).toBe('a1');
  expect(graph.nodes['tool:tB']!.parentId).toBe('a1');
  expect(graph.edges['a1->tool:tB']!.kind).toBe('fork');
  expect(graph.edges['a1->tool:tA:fork']!.kind).toBe('fork');
  expect(graph.edges['a1->tool:tA']!.kind).toBe('sequence');
  expect(graph.nodes.a4!.parentId).toBe('tool:tB');
  expect(graph.edges['tool:tA->a4']!.kind).toBe('sequence');
  expect(graph.edges['tool:tB->a4']!.kind).toBe('sequence');
});

test('不同 messageId 的连续工具不算并行', () => {
  const { graph } = run(n, [
    userPrompt('u1', null, 'x'),
    assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tA', name: 'Read', input: {} }, { messageId: 'm1' }),
    toolResult('u2', 'a1', 'tA', 'a'),
    assistantBlock('a2', 'u2', { type: 'tool_use', id: 'tB', name: 'Read', input: {} }, { messageId: 'm2' }),
  ]);
  expect(graph.nodes['tool:tB']!.parentId).toBe('tool:tA');
  expect(graph.edges['tool:tA->tool:tB']!.kind).toBe('sequence');
});

test('三个并行工具都从共同父节点分叉', () => {
  const { graph } = run(n, [
    userPrompt('u1', null, 'x'),
    assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tA', name: 'Read', input: {} }, { messageId: 'm1' }),
    assistantBlock('a2', 'a1', { type: 'tool_use', id: 'tB', name: 'Read', input: {} }, { messageId: 'm1' }),
    assistantBlock('a3', 'a2', { type: 'tool_use', id: 'tC', name: 'Read', input: {} }, { messageId: 'm1' }),
    assistantBlock('a4', 'a3', { type: 'text', text: 'done' }, { messageId: 'm2' }),
  ]);
  for (const t of ['tA', 'tB', 'tC']) expect(graph.nodes[`tool:${t}`]!.parentId).toBe('u1');
  expect(graph.edges['u1->tool:tC']!.kind).toBe('fork');
  expect(graph.nodes.a4!.parentId).toBe('tool:tC');
  expect(Object.keys(graph.edges).filter((id) => id.endsWith('->a4'))).toHaveLength(3);
});

const spawnEvents = () => ({
  main: [
    userPrompt('u1', null, 'x'),
    assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Agent', input: { description: 'd' } }),
  ],
  meta: agentMeta('ag1', { toolUseId: 'tu1', agentType: 'Explore', description: '找入口' }),
  agent: [
    userPrompt('s1', null, 'sub prompt', { agentId: 'ag1' }),
    assistantBlock('s2', 's1', { type: 'text', text: 'found' }, { agentId: 'ag1' }),
  ],
});
type Evs = ReturnType<typeof spawnEvents>;

test.each([
  ['meta 先到', (e: Evs): RawEvent[] => [...e.main, e.meta, ...e.agent]],
  ['子代理记录先到', (e: Evs): RawEvent[] => [...e.main, ...e.agent, e.meta]],
  ['子代理记录早于主线', (e: Evs): RawEvent[] => [...e.agent, e.meta, ...e.main]],
])('派发边只发一次：%s', (_name, order) => {
  const { graph, changes } = run(n, order(spawnEvents()));
  expect(graph.edges['tool:tu1->s1']).toMatchObject({ kind: 'spawn' });
  expect(graph.nodes.s1).toMatchObject({ agentId: 'ag1', parentId: 'tool:tu1', turnId: null });
  expect(graph.nodes['tool:tu1']).toMatchObject({ agentId: 'ag1', title: 'Explore', summary: '找入口' });
  expect(changes.filter((c) => c.type === 'edge_added' && c.edge.kind === 'spawn')).toHaveLength(1);
});

test('子代理的 end_turn 不把会话置为 idle', () => {
  const { changes } = run(n, [
    userPrompt('u1', null, 'x'),
    assistantBlock('s2', null, { type: 'text', text: 'done' }, { agentId: 'ag1', stopReason: 'end_turn' }),
  ]);
  expect(lastSession(changes).status).toBe('running');
});

test.each([
  ['标题先到', true],
  ['会话先到', false],
])('自定义标题写入会话：%s', (_name, titleFirst) => {
  const ev = [customTitle('登录修复'), userPrompt('u1', null, 'x')];
  const { changes } = run(n, titleFirst ? ev : ev.reverse());
  expect(lastSession(changes).title).toBe('登录修复');
});

test('损坏的 meta 被忽略', () => {
  const broken = { ...agentMeta('ag1', { toolUseId: 't', agentType: 'x', description: '' }), payload: '{' };
  expect(n.apply(broken, 'p').changes).toEqual([]);
});

test('缺字段的 meta 被忽略', () => {
  const missing = { ...agentMeta('ag1', { toolUseId: 't', agentType: 'x', description: '' }), payload: '{"agentType":"x"}' };
  expect(n.apply(missing, 'p').changes).toEqual([]);
});
