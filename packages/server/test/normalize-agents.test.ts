import { beforeEach, expect, test } from 'vitest';
import { applyChange, emptyGraph, type Change, type Graph } from '@claude-canvas/shared';
import { Normalizer } from '../src/normalize/normalizer.js';
import type { RawEvent } from '../src/store/store.js';
import { agentMeta, assistantBlock, customTitle, hook, run, toolResult, userPrompt } from './fixtures.js';

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
  expect(graph.nodes['tool:tu1']).toMatchObject({ agentId: null, childAgentId: 'ag1', title: 'Explore', summary: '找入口' });
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

/** Pre-creates unconfirmed hook placeholders for the tools, then replays the transcript events. */
function runWithPlaceholders(
  tools: { id: string; name?: string; agentId?: string | null }[],
  events: RawEvent[],
): { graph: Graph; changes: Change[] } {
  const pre = tools.flatMap((t) =>
    n
      .apply(
        hook('PreToolUse', {
          tool_name: t.name ?? 'Read',
          tool_input: {},
          tool_use_id: t.id,
          ...(t.agentId ? { agent_id: t.agentId } : {}),
        }),
        'p1',
      )
      .changes,
  );
  const r = run(n, events);
  const graph = [...pre, ...r.changes].reduce(applyChange, emptyGraph());
  return { graph, changes: [...pre, ...r.changes] };
}

const parallelEvents = (): RawEvent[] => [
  userPrompt('u1', null, 'x'),
  assistantBlock('a1', 'u1', { type: 'text', text: '查两个文件' }, { messageId: 'm1' }),
  assistantBlock('a2', 'a1', { type: 'tool_use', id: 'tA', name: 'Read', input: {} }, { messageId: 'm1' }),
  assistantBlock('a3', 'a2', { type: 'tool_use', id: 'tB', name: 'Read', input: {} }, { messageId: 'm1' }),
  toolResult('u2', 'a3', 'tA', 'a'),
  toolResult('u3', 'u2', 'tB', 'b'),
  assistantBlock('a4', 'u3', { type: 'text', text: '完成' }, { messageId: 'm2' }),
];

const edgeSummary = (g: Graph) => Object.values(g.edges).map((e) => `${e.id}:${e.kind}`).sort();
const nodeSummary = (g: Graph) =>
  Object.values(g.nodes).map((x) => `${x.id}|${x.parentId}|${x.agentId}|${x.childAgentId}|${x.title}|${x.summary}`).sort();

test('已存在的占位工具节点：并行批次结果与新建一致', () => {
  const direct = run(new Normalizer(), parallelEvents()).graph;
  const { graph, changes } = runWithPlaceholders([{ id: 'tA' }, { id: 'tB' }], parallelEvents());
  expect(edgeSummary(graph)).toEqual(edgeSummary(direct));
  expect(graph.nodes['tool:tA']).toMatchObject({ parentId: 'a1', confirmed: true });
  expect(graph.nodes['tool:tB']).toMatchObject({ parentId: 'a1', confirmed: true });
  expect(graph.nodes.a4!.parentId).toBe('tool:tB');
  const ids = changes.flatMap((c) => (c.type === 'edge_added' ? [c.edge.id] : []));
  expect(new Set(ids).size).toBe(ids.length);
});

test('混合批次：第一个成员已存在，第二个新建', () => {
  const direct = run(new Normalizer(), parallelEvents()).graph;
  const { graph } = runWithPlaceholders([{ id: 'tA' }], parallelEvents());
  expect(edgeSummary(graph)).toEqual(edgeSummary(direct));
  expect(graph.nodes['tool:tB']!.parentId).toBe('a1');
});

test.each([
  ['meta 先到', (e: Evs): RawEvent[] => [...e.main, e.meta, ...e.agent]],
  ['子代理记录先到', (e: Evs): RawEvent[] => [...e.main, ...e.agent, e.meta]],
  ['子代理记录早于主线', (e: Evs): RawEvent[] => [...e.agent, e.meta, ...e.main]],
])('已存在的派发节点：派发边只发一次：%s', (_name, order) => {
  const { graph, changes } = runWithPlaceholders([{ id: 'tu1', name: 'Agent' }], order(spawnEvents()));
  expect(graph.edges['tool:tu1->s1']).toMatchObject({ kind: 'spawn' });
  expect(graph.nodes.s1).toMatchObject({ agentId: 'ag1', parentId: 'tool:tu1' });
  expect(graph.nodes['tool:tu1']).toMatchObject({ agentId: null, childAgentId: 'ag1', title: 'Explore', summary: '找入口' });
  expect(changes.filter((c) => c.type === 'edge_added' && c.edge.kind === 'spawn')).toHaveLength(1);
});

test('已存在的占位工具节点会关闭未完成的批次', () => {
  const { graph } = runWithPlaceholders([{ id: 'tB' }], [
    userPrompt('u1', null, 'x'),
    assistantBlock('a1', 'u1', { type: 'text', text: 't' }, { messageId: 'm1' }),
    assistantBlock('a2', 'a1', { type: 'tool_use', id: 'tA', name: 'Read', input: {} }, { messageId: 'm1' }),
    toolResult('u2', 'a2', 'tA', 'a'),
    assistantBlock('a3', 'u2', { type: 'tool_use', id: 'tB', name: 'Read', input: {} }, { messageId: 'm2' }),
  ]);
  expect(graph.nodes['tool:tB']!.parentId).toBe('tool:tA');
  expect(graph.edges['tool:tA->tool:tB']!.kind).toBe('sequence');
});

test('子代理记录不改会话 cwd 与 gitBranch', () => {
  const { changes } = run(n, [
    userPrompt('u1', null, 'x', { cwd: '/main', gitBranch: 'main' }),
    userPrompt('s1', null, 'y', { agentId: 'ag1', cwd: '/wt', gitBranch: 'wt' }),
  ]);
  expect(lastSession(changes)).toMatchObject({ cwd: '/main', gitBranch: 'main' });
});

const agentTool = (uuid: string, parent: string | null, id: string, over: { agentId?: string; input?: object } = {}): RawEvent =>
  assistantBlock(uuid, parent, { type: 'tool_use', id, name: 'Agent', input: over.input ?? { description: 'd' } }, {
    ...(over.agentId !== undefined ? { agentId: over.agentId } : {}),
  });
const meta = (agentId: string, toolUseId: string): RawEvent => agentMeta(agentId, { toolUseId, agentType: 'Explore', description: 'd' });

test('派发节点保留自己所属的线程，派出的代理记在 childAgentId', () => {
  const { graph } = run(n, [
    userPrompt('u1', null, 'x'),
    agentTool('a1', 'u1', 'tu1'),
    meta('ag1', 'tu1'),
    userPrompt('r1', null, 'sub', { agentId: 'ag1' }),
  ]);
  expect(graph.nodes['tool:tu1']).toMatchObject({ kind: 'subagent', agentId: null, childAgentId: 'ag1' });
  expect(graph.nodes.r1).toMatchObject({ agentId: 'ag1', childAgentId: null });
  expect(Object.values(graph.edges).filter((e) => e.kind === 'spawn')).toEqual([
    expect.objectContaining({ from: 'tool:tu1', to: 'r1' }),
  ]);
});

test('代理内部再派发：内层派发节点的 agentId 是外层代理', () => {
  const { graph } = run(n, [
    userPrompt('u1', null, 'x'),
    agentTool('a1', 'u1', 'tu1'),
    meta('ag1', 'tu1'),
    agentTool('b1', null, 'tu2', { agentId: 'ag1' }),
    meta('ag2', 'tu2'),
  ]);
  expect(graph.nodes['tool:tu2']).toMatchObject({ agentId: 'ag1', childAgentId: 'ag2' });
});

test('元数据到达后，主线对 Agent 工具的 PermissionRequest 仍能匹配到派发节点', () => {
  const { graph } = run(n, [
    userPrompt('u1', null, 'x'),
    agentTool('a1', 'u1', 'tu1', { input: { prompt: 'p' } }),
    meta('ag1', 'tu1'),
    hook('PermissionRequest', { tool_name: 'Agent', tool_input: { prompt: 'p' } }),
  ]);
  expect(graph.nodes['tool:tu1']!.status).toBe('awaiting_permission');
});

test('除派发边外，没有边连接不同线程的节点', () => {
  const { graph } = run(n, [
    userPrompt('u1', null, 'x'),
    agentTool('a1', 'u1', 'tu1'),
    meta('ag1', 'tu1'),
    userPrompt('r1', null, 'sub', { agentId: 'ag1' }),
    toolResult('u2', 'a1', 'tu1', 'done'),
    assistantBlock('a2', 'u2', { type: 'text', text: 't2' }),
  ]);
  for (const e of Object.values(graph.edges)) {
    if (e.kind !== 'spawn') expect(graph.nodes[e.from]!.agentId).toBe(graph.nodes[e.to]!.agentId);
  }
});
