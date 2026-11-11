import { beforeEach, expect, test } from 'vitest';
import { applyChange, emptyGraph, type Change, type Graph } from '@claude-canvas/shared';
import { Normalizer } from '../src/normalize/normalizer.js';
import type { RawEvent } from '../src/store/store.js';
import { agentMeta, assistantBlock, customTitle, hook, rawLine, run, toolResult, userPrompt } from './fixtures.js';

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

// A background Agent launch answers at once with `async_launched`; the dispatch node follows the agent, not the launch.
const ASYNC = { toolUseResult: { status: 'async_launched', isAsync: true, agentId: 'ag1', description: 'd' } };
const launch = () => [
  userPrompt('u1', null, 'x'),
  assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Agent', input: { description: 'd' } }),
  toolResult('u2', 'a1', 'tu1', 'Async agent launched', undefined, ASYNC),
];

test('后台派出的子代理：派出动作返回后派发节点仍在运行，子代理 end_turn 时才结算', () => {
  const started = run(n, launch());
  expect(started.graph.nodes['tool:tu1']).toMatchObject({ kind: 'subagent', status: 'running', endedAt: null, durationMs: null });
  const working = run(n, [
    userPrompt('s1', null, 'sub prompt', { agentId: 'ag1' }),
    assistantBlock('s2', 's1', { type: 'text', text: 'working' }, { agentId: 'ag1' }),
  ]);
  expect(working.changes.some((c) => c.type === 'node_updated' && c.id === 'tool:tu1' && 'status' in c.patch)).toBe(false);
  const end = n.apply(assistantBlock('s3', 's2', { type: 'text', text: 'done' }, { agentId: 'ag1', stopReason: 'end_turn', timestamp: '2026-01-01T01:00:00.000Z' }), 'p1');
  expect(end.changes.find((c) => c.type === 'node_updated' && c.id === 'tool:tu1')).toMatchObject({
    patch: { status: 'succeeded', endedAt: '2026-01-01T01:00:00.000Z' },
  });
});

test('后台派出：结算后的耗时是从派出到子代理结束', () => {
  const events = [
    userPrompt('u1', null, 'x'),
    assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Agent', input: {} }, { timestamp: '2026-01-01T00:10:00.000Z' }),
    toolResult('u2', 'a1', 'tu1', 'launched', undefined, ASYNC),
    assistantBlock('s1', null, { type: 'text', text: 'done' }, { agentId: 'ag1', stopReason: 'end_turn', timestamp: '2026-01-01T00:15:00.000Z' }),
  ];
  const { graph } = run(n, events);
  expect(graph.nodes['tool:tu1']).toMatchObject({ status: 'succeeded', endedAt: '2026-01-01T00:15:00.000Z', durationMs: 300_000 });
});

test('后台派出：PostToolUse hook 不结算派发节点，SubagentStop hook 结算', () => {
  const { graph: g1 } = run(n, [
    userPrompt('u1', null, 'x'),
    assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Agent', input: {} }),
    hook('PostToolUse', { tool_use_id: 'tu1', tool_name: 'Agent', duration_ms: 12, tool_response: ASYNC.toolUseResult }),
    toolResult('u2', 'a1', 'tu1', 'launched', undefined, ASYNC),
  ]);
  expect(g1.nodes['tool:tu1']).toMatchObject({ status: 'running', endedAt: null });
  const stop = n.apply(hook('SubagentStop', { agent_id: 'ag1' }, '2026-01-01T02:00:00.000Z'), 'p1');
  expect(stop.changes.find((c) => c.type === 'node_updated' && c.id === 'tool:tu1')).toMatchObject({
    patch: { status: 'succeeded', endedAt: '2026-01-01T02:00:00.000Z' },
  });
  // A later end_turn of the same agent is not a second end.
  const again = n.apply(assistantBlock('s9', null, { type: 'text', text: 'bye' }, { agentId: 'ag1', stopReason: 'end_turn', timestamp: '2026-01-01T03:00:00.000Z' }), 'p1');
  expect(again.changes.some((c) => c.type === 'node_updated' && c.id === 'tool:tu1')).toBe(false);
});

test('后台派出：子代理以交回工具调用结束时同样结算', () => {
  const { graph } = run(n, [
    ...launch(),
    assistantBlock('s1', null, { type: 'tool_use', id: 'hb', name: 'SubagentHandback', input: {} }, { agentId: 'ag1', stopReason: 'tool_use' }),
  ]);
  expect(graph.nodes['tool:tu1']!.status).toBe('succeeded');
});

test('后台派出：子代理先结束、派出记录后到，派发节点按子代理结束的时间结算', () => {
  const { graph } = run(n, [
    assistantBlock('s1', null, { type: 'text', text: 'done' }, { agentId: 'ag1', stopReason: 'end_turn', timestamp: '2026-01-01T00:20:00.000Z' }),
    ...launch(),
  ]);
  expect(graph.nodes['tool:tu1']).toMatchObject({ status: 'succeeded', endedAt: '2026-01-01T00:20:00.000Z' });
});

test('后台派出：已被 hook 结算的派发节点在派出记录到达时回到运行中', () => {
  const { graph } = run(n, [
    userPrompt('u1', null, 'x'),
    assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Agent', input: {} }),
    hook('PostToolUse', { tool_use_id: 'tu1', tool_name: 'Agent', duration_ms: 12, tool_response: 'ok' }),
    toolResult('u2', 'a1', 'tu1', 'launched', undefined, ASYNC),
  ]);
  expect(graph.nodes['tool:tu1']).toMatchObject({ status: 'running', endedAt: null, durationMs: null });
});

test('前台子代理不受影响：派出动作的结果到达即结算', () => {
  const { graph } = run(n, [
    userPrompt('u1', null, 'x'),
    assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Agent', input: {} }),
    toolResult('u2', 'a1', 'tu1', 'result'),
  ]);
  expect(graph.nodes['tool:tu1']!.status).toBe('succeeded');
  // An ordinary tool whose result happens to say isAsync is not an agent launch.
  const { graph: g2 } = run(new Normalizer(), [
    userPrompt('u1', null, 'x'),
    assistantBlock('a1', 'u1', { type: 'tool_use', id: 't1', name: 'Bash', input: {} }),
    toolResult('u2', 'a1', 't1', 'started', undefined, { toolUseResult: { isAsync: true } }),
  ]);
  expect(g2.nodes['tool:t1']!.status).toBe('succeeded');
});

const notification = (toolUseId: string, status: string, timestamp: string) => rawLine('queue-operation', {
  operation: 'enqueue', timestamp,
  content: `<task-notification>\n<task-id>x</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n</task-notification>`,
});

test('后台派出：没有任何线程内结束信号时，任务通知结算派发节点，并带上成功或失败', () => {
  const ok = run(n, [...launch(), notification('tu1', 'completed', '2026-01-01T03:00:00.000Z')]);
  expect(ok.unknown).toEqual([]);
  expect(ok.graph.nodes['tool:tu1']).toMatchObject({ status: 'succeeded', endedAt: '2026-01-01T03:00:00.000Z' });
  const failed = run(new Normalizer(), [...launch(), notification('tu1', 'failed', '2026-01-01T03:00:00.000Z')]);
  expect(failed.graph.nodes['tool:tu1']!.status).toBe('failed');
});

test('后台派出：线程先以 end_turn 结束、通知随后报告失败，状态改为失败，结束时间仍是较早的那个', () => {
  const { graph } = run(n, [
    ...launch(),
    assistantBlock('s1', null, { type: 'text', text: 'done' }, { agentId: 'ag1', stopReason: 'end_turn', timestamp: '2026-01-01T00:20:00.000Z' }),
    notification('tu1', 'failed', '2026-01-01T00:21:00.000Z'),
  ]);
  expect(graph.nodes['tool:tu1']).toMatchObject({ status: 'failed', endedAt: '2026-01-01T00:20:00.000Z' });
});

test('后台派出：end_turn 与 SubagentStop 谁先到，结束时间都一样（取较早的）', () => {
  const endTurn = () => assistantBlock('s1', null, { type: 'text', text: 'done' }, { agentId: 'ag1', stopReason: 'end_turn', timestamp: '2026-01-01T00:20:00.000Z' });
  const stop = () => hook('SubagentStop', { agent_id: 'ag1' }, '2026-01-01T00:20:05.000Z');
  const a = run(n, [...launch(), endTurn(), stop()]).graph.nodes['tool:tu1']!;
  const b = run(new Normalizer(), [...launch(), stop(), endTurn()]).graph.nodes['tool:tu1']!;
  expect(a.endedAt).toBe('2026-01-01T00:20:00.000Z');
  expect(b.endedAt).toBe('2026-01-01T00:20:00.000Z');
  for (const node of [a, b]) expect(node.durationMs).toBe(Date.parse(node.endedAt!) - Date.parse(node.timestamp));
  expect([a.status, b.status]).toEqual(['succeeded', 'succeeded']);
});

test('后台派出：子代理线程里的中断记录把派发节点结算为失败', () => {
  const { graph } = run(n, [
    ...launch(),
    userPrompt('s1', null, '[Request interrupted by user]', { agentId: 'ag1' }),
  ]);
  expect(graph.nodes['tool:tu1']!.status).toBe('failed');
});

test('后台派出：会话结束时还没结束的派发节点结算为失败', () => {
  const { graph } = run(n, [...launch(), hook('SessionEnd', {}, '2026-01-01T05:00:00.000Z')]);
  expect(graph.nodes['tool:tu1']).toMatchObject({ status: 'failed', endedAt: '2026-01-01T05:00:00.000Z' });
});

test('后台派出：晚到的、不带后台标记的 PostToolUse 不结算派发节点', () => {
  const { graph } = run(n, [
    ...launch(),
    hook('PostToolUse', { tool_use_id: 'tu1', tool_name: 'Agent', duration_ms: 12, tool_response: 'ok' }),
  ]);
  expect(graph.nodes['tool:tu1']).toMatchObject({ status: 'running', endedAt: null });
});

test('前台子代理：线程里的 end_turn 不提前结算派发节点，结果到达时才结算', () => {
  const { graph } = run(n, [
    userPrompt('u1', null, 'x'),
    assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Agent', input: {} }),
    agentMeta('ag1', { toolUseId: 'tu1', agentType: 'Explore', description: 'd' }),
    assistantBlock('s1', null, { type: 'text', text: 'done' }, { agentId: 'ag1', stopReason: 'end_turn', timestamp: '2026-01-01T00:20:00.000Z' }),
  ]);
  expect(graph.nodes['tool:tu1']).toMatchObject({ status: 'running', endedAt: null });
  const done = n.apply(toolResult('u2', 'a1', 'tu1', 'boom', true, { timestamp: '2026-01-01T00:20:10.000Z' }), 'p1');
  expect(done.changes.find((c) => c.type === 'node_updated' && c.id === 'tool:tu1')).toMatchObject({
    patch: { status: 'failed', endedAt: '2026-01-01T00:20:10.000Z' },
  });
});
