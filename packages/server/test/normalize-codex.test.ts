import { beforeEach, describe, expect, test } from 'vitest';
import { applyChanges, emptyGraph, type Change, type GraphNode } from '@claude-canvas/shared';
import { CodexNormalizer } from '../src/normalize/codex.js';
import type { RawEvent } from '../src/store/store.js';
import { CodexThread, interleave, run, titleMeta, type RunResult } from './codex-fixtures.js';

let n: CodexNormalizer;
beforeEach(() => {
  n = new CodexNormalizer();
});

const timeOf = (ev: RawEvent): string => (JSON.parse((ev as Extract<RawEvent, { source: 'transcript' }>).line) as { timestamp: string }).timestamp;
const ids = (r: RunResult): string[] => Object.keys(r.graph.nodes);
const node = (r: RunResult, id: string): GraphNode => {
  const found = r.graph.nodes[id];
  if (!found) throw new Error(`no node ${id}; have ${ids(r).join(', ')}`);
  return found;
};
/** The detail a node ended up with: node_added detail merged with every later update's detail (as the store does). */
const detailOf = (changes: Change[], id: string): Record<string, unknown> => {
  let d: Record<string, unknown> = {};
  for (const c of changes) {
    if (c.type === 'node_added' && c.node.id === id) d = { ...c.detail };
    if (c.type === 'node_updated' && c.id === id && c.detail) d = { ...d, ...c.detail };
  }
  return d;
};
const edgeKinds = (r: RunResult): Record<string, string> =>
  Object.fromEntries(Object.values(r.graph.edges).map((e) => [e.id, e.kind]));
const spawnEdgesAdded = (changes: Change[]): string[] =>
  changes.flatMap((c) => (c.type === 'edge_added' && c.edge.kind === 'spawn' ? [c.edge.id] : []));

function simpleTurn(root = new CodexThread({ id: 'root1', cwd: '/work/app' })) {
  const head = [root.meta(), root.started('t1'), root.context('developer', 'sandbox rules'), root.context('user', 'environment'), root.user('u1', 'Fix   the\nbug please')];
  const thinking = root.reasoning('rs1', ['Looking at the code'], 1500);
  const call = root.exec('c1', 'run the tests');
  const cmd = root.command('e1', 'npm test', { durationMs: 1200 });
  const out = root.output('c1');
  const answer = root.assistant('m1', 'Fixed it');
  const done = root.complete();
  return { root, head, thinking, call, cmd, out, answer, done, all: [...head, ...thinking, call, cmd, out, ...answer, done] };
}

describe('一轮对话', () => {
  test('提示、思考、exec 调用（折入 CommandExecution）、最终回复；上下文注入不产生节点', () => {
    const t = simpleTurn();
    const r = run(n, t.all);
    expect(r.unknown).toEqual([]);
    expect(ids(r)).toEqual(['prompt:u1', 'thinking:rs1', 'tool:c1', 'text:m1']);
    expect(node(r, 'prompt:u1')).toMatchObject({ kind: 'prompt', parentId: null, turnId: 't1', agentId: null, summary: 'Fix the bug please', confirmed: true });
    expect(node(r, 'thinking:rs1')).toMatchObject({ kind: 'thinking', parentId: 'prompt:u1', summary: 'Looking at the code', durationMs: 1500 });
    expect(node(r, 'tool:c1')).toMatchObject({
      kind: 'tool',
      parentId: 'thinking:rs1',
      status: 'succeeded',
      title: 'exec',
      toolName: 'exec',
      toolUseId: 'c1',
      summary: 'npm test',
      timestamp: timeOf(t.call),
      endedAt: timeOf(t.out),
      durationMs: Date.parse(timeOf(t.out)) - Date.parse(timeOf(t.call)),
      usage: null,
    });
    expect(node(r, 'text:m1')).toMatchObject({ kind: 'text', parentId: 'tool:c1', summary: 'Fixed it', status: null });
    expect(edgeKinds(r)).toEqual({
      'prompt:u1->thinking:rs1': 'sequence',
      'thinking:rs1->tool:c1': 'sequence',
      'tool:c1->text:m1': 'sequence',
    });
    expect(detailOf(r.changes, 'tool:c1')).toMatchObject({
      input: 'run the tests',
      output: [{ type: 'input_text', text: 'Script completed' }],
      raw: { items: [{ type: 'CommandExecution', name: 'npm test', status: 'completed', exitCode: 0, durationMs: 1200 }] },
    });
    expect(detailOf(r.changes, 'text:m1')).toEqual({ text: 'Fixed it', raw: { phase: 'final_answer' } });
    expect(detailOf(r.changes, 'prompt:u1')).toMatchObject({ text: 'Fix   the\nbug please' });
    const s = r.sessions.get('root1')!;
    expect(s).toMatchObject({
      id: 'root1',
      origin: 'codex',
      projectId: 'p1',
      cwd: '/work/app',
      title: 'Fix the bug please',
      gitBranch: null,
      status: 'idle',
      sourceDeleted: false,
      startedAt: timeOf(t.head[0]!),
      lastActivityAt: timeOf(t.done),
    });
    for (const c of r.changes) expect(c.type === 'session_upserted' ? c.session.id : c.type === 'node_added' ? c.node.sessionId : c.type === 'edge_added' ? c.edge.sessionId : c.sessionId).toBe('root1');
  });

  test('轮次进行中：会话运行中，工具节点执行中，输入留在内存', () => {
    const t = simpleTurn();
    const r = run(n, [...t.head, ...t.thinking, t.call]);
    expect(r.sessions.get('root1')!.status).toBe('running');
    expect(node(r, 'tool:c1')).toMatchObject({ status: 'running', endedAt: null, durationMs: null, summary: 'run the tests' });
    expect(n.toolInputCount('root1')).toBe(1);
    run(n, [t.cmd, t.out]);
    expect(n.toolInputCount('root1')).toBe(0);
    expect(n.hasSession('root1')).toBe(true);
    expect(n.sessionCount()).toBe(1);
  });

  test('命令失败（status failed 或退出码非零）→ 工具节点失败', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = run(n, [
      root.meta(),
      root.started('t1'),
      root.exec('c1', 'a'),
      root.command('e1', 'false', { status: 'failed', exitCode: 1 }),
      root.output('c1'),
      root.exec('c2', 'b'),
      root.command('e2', 'grep x', { status: 'completed', exitCode: 2 }),
      root.output('c2'),
      root.exec('c3', 'c'),
      root.mcp('e3', 'docs', 'search', 'failed'),
      root.output('c3'),
    ]);
    expect(node(r, 'tool:c1').status).toBe('failed');
    expect(node(r, 'tool:c2').status).toBe('failed');
    expect(node(r, 'tool:c3')).toMatchObject({ status: 'failed', summary: 'docs.search' });
  });

  test('一次 exec 跑两条命令：摘要取第一条，详情逐条列出', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = run(n, [
      root.meta(),
      root.started('t1'),
      root.exec('c1', 'two commands'),
      root.command('e1', 'git status', { durationMs: 100 }),
      root.command('e2', 'git diff', { durationMs: 2500, exitCode: 0 }),
      root.output('c1'),
    ]);
    expect(node(r, 'tool:c1')).toMatchObject({ summary: 'git status', status: 'succeeded' });
    expect(detailOf(r.changes, 'tool:c1').raw).toEqual({
      items: [
        { type: 'CommandExecution', name: 'git status', status: 'completed', exitCode: 0, durationMs: 100 },
        { type: 'CommandExecution', name: 'git diff', status: 'completed', exitCode: 0, durationMs: 2500 },
      ],
    });
  });

  test('没有进行中的调用时到达的条目自成一个已结束的工具节点', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = run(n, [root.meta(), root.started('t1'), root.user('u1', 'hi'), root.command('e9', 'sleep 1', { exitCode: 0, durationMs: 1000 })]);
    expect(node(r, 'item:e9')).toMatchObject({ kind: 'tool', status: 'succeeded', toolName: 'CommandExecution', summary: 'sleep 1', durationMs: 1000, parentId: 'prompt:u1' });
    expect(node(r, 'item:e9').endedAt).not.toBeNull();
  });

  test('namespace 拼进工具名；function_call 的参数解析成对象', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = run(n, [root.meta(), root.started('t1'), root.call('c1', 'send_message', { target: 'a', message: 'hello' }, 'collaboration'), root.output('c1', 'ok', 'function')]);
    expect(node(r, 'tool:c1')).toMatchObject({ kind: 'tool', toolName: 'collaboration.send_message', title: 'collaboration.send_message', status: 'succeeded' });
    expect(detailOf(r.changes, 'tool:c1')).toMatchObject({ input: { target: 'a', message: 'hello' }, output: 'ok' });
  });
});

describe('并行调用', () => {
  test('同一响应里连续的两个调用从同一父节点分叉，之后汇合；命令折入最近打开的调用', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = run(n, [
      root.meta(),
      root.started('t1'),
      root.user('u1', 'x'),
      root.exec('cA', 'a'),
      root.exec('cB', 'b'),
      root.usage(),
      root.command('eB', 'ls'),
      root.output('cA'),
      root.output('cB'),
      ...root.assistant('m1', 'done'),
    ]);
    expect(node(r, 'tool:cA').parentId).toBe('prompt:u1');
    expect(node(r, 'tool:cB').parentId).toBe('prompt:u1');
    expect(node(r, 'tool:cB').summary).toBe('ls');
    expect(node(r, 'tool:cA').summary).toBe('a');
    expect(node(r, 'text:m1').parentId).toBe('tool:cB');
    expect(edgeKinds(r)).toEqual({
      'prompt:u1->tool:cA': 'sequence',
      'prompt:u1->tool:cA:fork': 'fork',
      'prompt:u1->tool:cB': 'fork',
      'tool:cA->text:m1': 'sequence',
      'tool:cB->text:m1': 'sequence',
    });
  });

  test('中间隔着别的响应条目或用量记录的调用不算并行', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = run(n, [
      root.meta(),
      root.started('t1'),
      root.user('u1', 'x'),
      root.exec('cA', 'a'),
      root.usage(),
      root.exec('cB', 'b'),
      root.output('cA'),
      root.output('cB'),
      root.exec('cC', 'c'),
    ]);
    expect(node(r, 'tool:cB').parentId).toBe('tool:cA');
    expect(node(r, 'tool:cC').parentId).toBe('tool:cB');
    expect(Object.values(edgeKinds(r))).toEqual(['sequence', 'sequence', 'sequence']);
  });
});

describe('系统节点', () => {
  test('轮次失败：失败标记节点，摘要是错误信息；会话空闲', () => {
    const root = new CodexThread({ id: 'root1' });
    const evs = [root.meta(), root.started('t1'), root.user('u1', 'x'), root.complete('stream disconnected')];
    const r = run(n, evs);
    const sys = Object.values(r.graph.nodes).find((x) => x.kind === 'system')!;
    expect(sys).toMatchObject({ systemSubtype: 'interrupt', summary: 'stream disconnected', parentId: 'prompt:u1', turnId: 't1' });
    expect(r.sessions.get('root1')!.status).toBe('idle');
  });

  test('中断：interrupt 系统节点；会话空闲', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = run(n, [root.meta(), root.started('t1'), root.user('u1', 'x'), root.aborted()]);
    const sys = Object.values(r.graph.nodes).filter((x) => x.kind === 'system');
    expect(sys).toHaveLength(1);
    expect(sys[0]).toMatchObject({ systemSubtype: 'interrupt', title: 'Interrupted', summary: 'interrupted', parentId: 'prompt:u1' });
    expect(r.sessions.get('root1')!.status).toBe('idle');
  });

  test('压缩：一次压缩一个 compact 节点（compaction 与 compacted 相邻时也只一个）', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = run(n, [
      root.meta(),
      root.started('t1'),
      root.user('u1', 'x'),
      root.compacted(),
      root.started('t2'),
      root.user('u2', 'y'),
      root.compaction(),
      root.compacted(),
    ]);
    const compacts = Object.values(r.graph.nodes).filter((x) => x.systemSubtype === 'compact');
    expect(compacts).toHaveLength(2);
    expect(compacts[0]).toMatchObject({ kind: 'system', title: 'Compact', parentId: 'prompt:u1' });
    expect(compacts[1]!.parentId).toBe('prompt:u2');
    expect(r.unknown).toEqual([]);
  });
});

describe('未识别与忽略', () => {
  test('不认识的记录类型、事件类型、条目类型计入未识别；坏 JSON 记为 invalid-json', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = run(n, [
      root.meta(),
      root.started('t1'),
      root.record('mystery', { a: 1 }),
      root.record('event_msg', { type: 'brand_new_event' }),
      root.record('response_item', { type: 'hologram' }),
      root.item({ type: 'Teleport', id: 'x1' }),
      root.record('mystery2', 'not an object' as unknown as Record<string, unknown>),
      root.line('{"timestamp": "2026-11-11T03:00:00.000Z", "type": "event_msg", "payl'),
    ]);
    expect(r.unknown).toEqual(['mystery', 'event_msg/brand_new_event', 'response_item/hologram', 'item_completed/Teleport', 'mystery2', 'invalid-json']);
    expect(ids(r)).toEqual([]);
  });

  test('已知但不展示的类型：不产生节点，也不计入未识别', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = run(n, [
      root.meta(),
      root.started('t1'),
      root.record('turn_context', { turn_id: 't1', cwd: '/work/app' }),
      root.record('world_state', { full: true, state: {} }),
      root.usage(),
      root.record('inter_agent_communication_metadata', { trigger_turn: true }),
      root.record('event_msg', { type: 'token_count', info: null }),
      root.record('event_msg', { type: 'thread_settings_applied', thread_id: 'root1', thread_settings: {} }),
      root.record('response_item', { type: 'additional_tools', id: 'x', role: 'developer', tools: [] }),
      root.record('response_item', { type: 'agent_message', id: 'x', author: 'a', recipient: 'b', content: [] }),
      root.record('response_item', { type: 'configuration_update', reasoning: {} }),
      root.item({ type: 'AgentMessage', id: 'm', content: [], phase: 'commentary' }),
      root.item({ type: 'ContextCompaction', id: 'cc' }),
      root.item({ type: 'Reasoning', id: 'rsX', summary_text: [], raw_content: [] }),
      root.activity('nocall', 'thread-z', '/root/z', 'completed'),
      root.context('developer', 'more rules'),
      root.context('user', 'AGENTS.md contents'),
    ]);
    expect(r.unknown).toEqual([]);
    expect(ids(r)).toEqual([]);
  });

  test('畸形输入：每条有确定的结果（未识别标签、不产生节点或边、节点字段无 undefined），之后的正常记录照常处理', () => {
    const root = new CodexThread({ id: 'root1' });
    run(n, [root.meta(), root.started('t1')]);
    const meta = (payload: string): RawEvent => ({ source: 'meta', origin: 'codex', file: 'codex:index/root1', sessionId: 'root1', agentId: null, payload });
    const cases: [RawEvent, string | undefined][] = [
      [root.line('not json'), 'invalid-json'],
      [root.line('[]'), 'invalid-json'],
      [root.line('null'), 'invalid-json'],
      [root.line('{"type":5}'), 'missing-type'],
      [root.line('{"type":"event_msg","payload":null}'), 'event_msg'],
      [root.line('{"type":"event_msg","payload":{"type":"item_completed","item":7}}'), 'item_completed/?'],
      [root.line('{"type":"response_item","payload":{"type":"function_call"}}'), undefined], // no call_id: no node
      [root.line('{"type":"response_item","payload":{"type":"function_call_output","call_id":{}}}'), undefined],
      [root.line('{"type":"session_meta","payload":{"id":42}}'), undefined],
      [root.line('{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","exit_code":"x"},"started_at_ms":"y"}}'), undefined],
      [meta('{oops'), undefined],
      [meta('{"thread_name":7}'), undefined],
      [{ source: 'hook', origin: 'codex', receivedAt: 'x', eventName: 'PreToolUse', sessionId: 'root1', payload: 'nope' }, 'hook:invalid'],
    ];
    for (const [ev, unknown] of cases) {
      const res = n.apply(ev, 'p1');
      expect(res.unknownRecordType).toBe(unknown);
      const graphChanges = res.changes.filter((c) => c.type !== 'session_upserted' && !(c.type === 'node_added' && c.node.kind === 'tool'));
      expect(graphChanges).toEqual([]);
      for (const c of res.changes) if (c.type === 'node_added') expect(Object.values(c.node)).not.toContain(undefined);
    }
    // The malformed CommandExecution (no call open) became a finished tool node with sane fields.
    const after = run(n, [root.user('u1', 'still works'), ...root.assistant('m1', 'yes')]);
    expect(after.unknown).toEqual([]);
    expect(node(after, 'prompt:u1').kind).toBe('prompt');
    expect(node(after, 'text:m1').parentId).toBe('prompt:u1');
  });
});

describe('标题', () => {
  test('首个主线程提示作标题：空白折叠，取前 60 个码点；之后的提示和子代理的提示不改', () => {
    const root = new CodexThread({ id: 'root1' });
    const sub = new CodexThread({ id: 'sub1', sessionId: 'root1', parent: 'root1', agentPath: '/root/x' });
    const long = `  ${'长'.repeat(70)}  `;
    const r = run(n, [sub.meta(), sub.started('s1'), sub.user('su', 'sub prompt'), root.meta(), root.started('t1'), root.user('u1', long), root.started('t2'), root.user('u2', 'second')]);
    expect(r.sessions.get('root1')!.title).toBe('长'.repeat(60));
  });

  test('索引里的标题优先于提示：会话出现之前到达的标题保留下来，会话出现时生效', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = run(n, [titleMeta('root1', 'Named thread'), root.meta(), root.started('t1'), root.user('u1', 'prompt text')]);
    expect(r.sessions.get('root1')!.title).toBe('Named thread');
  });

  test('索引标题在会话之后到达：覆盖提示标题；后来的索引行再改', () => {
    const root = new CodexThread({ id: 'root1' });
    const r1 = run(n, [root.meta(), root.started('t1'), root.user('u1', 'prompt text')]);
    expect(r1.sessions.get('root1')!.title).toBe('prompt text');
    const r2 = run(n, [titleMeta('root1', 'Renamed')]);
    expect(r2.sessions.get('root1')!.title).toBe('Renamed');
    expect(run(n, [titleMeta('root1', 'Again')]).sessions.get('root1')!.title).toBe('Again');
  });

  test('会话前的状态：restorePreSession 恢复标题；dropSession 之后需要重新恢复', () => {
    const root = new CodexThread({ id: 'root1' });
    expect(n.needsPreSessionReplay('root1')).toBe(true);
    n.restorePreSession('root1', [titleMeta('root1', 'Restored'), titleMeta('other', 'Not mine')]);
    expect(n.needsPreSessionReplay('root1')).toBe(false);
    expect(n.hasSession('root1')).toBe(false);
    const r = run(n, [root.meta()]);
    expect(r.sessions.get('root1')!.title).toBe('Restored');
    expect(n.needsPreSessionReplay('root1')).toBe(false);
    n.dropSession('root1');
    expect(n.hasSession('root1')).toBe(false);
    expect(n.needsPreSessionReplay('root1')).toBe(true);
    expect(n.sessionCount()).toBe(0);
  });
});

describe('子代理', () => {
  const ROOT = 'root1';
  const SUB = 'sub1';
  function scenario(opts: { activity?: boolean; spawnSourceOnly?: boolean } = {}) {
    const root = new CodexThread({ id: ROOT, cwd: '/work/app' });
    const sub = new CodexThread({ id: SUB, sessionId: ROOT, parent: ROOT, cwd: '/work/app/.worktrees/helper', nickname: 'Hubble', agentPath: '/root/helper', spawnSourceOnly: opts.spawnSourceOnly });
    const rootEvs = [
      root.meta(),
      root.started('t1'),
      root.user('u1', 'delegate it'),
      root.spawn('c9', 'helper', 'please do the sub task'),
      ...(opts.activity === false ? [] : [root.activity('c9', SUB, '/root/helper')]),
      root.usage(),
      root.output('c9', JSON.stringify({ task_name: '/root/helper' }), 'function'),
      ...root.assistant('m1', 'spawned'),
      root.complete(),
    ];
    const subStart = [sub.meta(), sub.started('s-t1'), sub.context('developer', 'rules'), sub.context('user', 'please do the sub task', 'task1')];
    const subWork = [...sub.reasoning('srs1', []), sub.exec('sc1', 'work'), sub.command('se1', 'make'), sub.output('sc1'), ...sub.assistant('sm1', 'sub done')];
    const subDone = sub.complete();
    return { root, sub, rootEvs, subStart, subWork, subDone, subEvs: [...subStart, ...subWork, subDone] };
  }

  test('spawn_agent + SubAgentActivity → 子代理节点；子线程的节点挂在它下面；两种到达顺序结果相同，派发边只有一条', () => {
    const a = scenario();
    const r1 = run(n, [...a.rootEvs, ...a.subEvs]);
    const b = scenario();
    const r2 = run(new CodexNormalizer(), [...b.subEvs, ...b.rootEvs]);
    for (const r of [r1, r2]) {
      expect(r.unknown).toEqual([]);
      expect(node(r, 'tool:c9')).toMatchObject({ kind: 'subagent', agentId: null, childAgentId: SUB, title: 'Hubble', summary: 'helper', toolName: 'collaboration.spawn_agent', toolUseId: 'c9', status: 'succeeded' });
      // The child's task (its role-user message) is its first node, hanging off the dispatch node.
      expect(node(r, 'prompt:task1')).toMatchObject({ kind: 'prompt', agentId: SUB, parentId: 'tool:c9', turnId: 's-t1', summary: 'please do the sub task' });
      expect(node(r, 'thinking:srs1')).toMatchObject({ agentId: SUB, parentId: 'prompt:task1', turnId: 's-t1' });
      expect(node(r, 'tool:sc1')).toMatchObject({ agentId: SUB, parentId: 'thinking:srs1', summary: 'make' });
      expect(edgeKinds(r)['tool:c9->prompt:task1']).toBe('spawn');
      expect(spawnEdgesAdded(r.changes)).toEqual(['tool:c9->prompt:task1']);
      expect(node(r, 'text:m1').parentId).toBe('tool:c9');
    }
    // Same records, either order: same graph (times differ between the two builds, so compare the shape).
    const shape = (r: RunResult) => ({
      nodes: Object.values(r.graph.nodes).map((x) => [x.id, x.kind, x.parentId, x.agentId, x.childAgentId, x.status, x.title, x.summary, x.turnId]).sort(),
      edges: Object.keys(r.graph.edges).sort(),
    });
    expect(shape(r2)).toEqual(shape(r1));
    expect(node(r1, 'tool:c9').endedAt).toBe(timeOf(a.subDone));
    expect(node(r2, 'tool:c9').endedAt).toBe(timeOf(b.subDone));
  });

  test('派发节点的状态跟着子线程的轮次：子线程没有记录或轮次进行中 → 执行中；结束 → 成功；追加任务 → 回到执行中', () => {
    const s = scenario();
    let r = run(n, s.rootEvs);
    expect(node(r, 'tool:c9')).toMatchObject({ status: 'running', endedAt: null }); // its own output does not settle it
    r = run(n, s.subStart);
    // The child's meta brings its nickname; its open turn keeps the dispatch running.
    expect(r.changes.filter((c) => c.type === 'node_updated' && c.id === 'tool:c9').map((c) => (c as { patch: object }).patch)).toEqual([{ title: 'Hubble' }]);
    const all: Change[] = [];
    const collect = (evs: RawEvent[]) => {
      const out = run(n, evs);
      all.push(...out.changes);
      return out;
    };
    collect(s.subWork);
    const doneRes = collect([s.subDone]);
    const patchOf = (res: RunResult) =>
      res.changes.filter((c): c is Extract<Change, { type: 'node_updated' }> => c.type === 'node_updated' && c.id === 'tool:c9').map((c) => c.patch);
    expect(patchOf(doneRes)).toEqual([{ status: 'succeeded', endedAt: timeOf(s.subDone), durationMs: Date.parse(timeOf(s.subDone)) - Date.parse(timeOf(s.rootEvs[3]!)) }]);

    // A follow-up task: the parent sends a message, the child starts a new turn.
    const followCall = s.root.call('c10', 'followup_task', { target: '/root/helper', message: 'and more' }, 'collaboration');
    collect([s.root.started('t2'), s.root.user('u2', 'more'), followCall, s.root.output('c10', 'ok', 'function')]);
    const reopened = collect([s.sub.started('s-t2')]);
    expect(patchOf(reopened)).toEqual([{ status: 'running', endedAt: null, durationMs: null }]);
    const prompt = collect([s.sub.user('su2', 'and more')]);
    expect(prompt.graph.nodes['prompt:su2']).toMatchObject({ agentId: SUB, parentId: 'text:sm1', turnId: 's-t2' });
    const failed = s.sub.complete('quota exceeded');
    const end = collect([failed]);
    expect(patchOf(end)).toEqual([{ status: 'failed', endedAt: timeOf(failed), durationMs: Date.parse(timeOf(failed)) - Date.parse(timeOf(s.rootEvs[3]!)) }]);
    const again = collect([s.sub.started('s-t3')]);
    expect(patchOf(again)).toEqual([{ status: 'running', endedAt: null, durationMs: null }]);
    const aborted = s.sub.aborted();
    expect(patchOf(collect([aborted]))).toEqual([{ status: 'failed', endedAt: timeOf(aborted), durationMs: Date.parse(timeOf(aborted)) - Date.parse(timeOf(s.rootEvs[3]!)) }]);
  });

  test('子代理的记录不改变会话的状态、cwd 和标题', () => {
    const s = scenario();
    const subEvs = [s.sub.meta(), s.sub.started('s-t1'), s.sub.user('su', 'sub prompt')];
    const last = subEvs[2]!;
    const r = run(n, [...s.rootEvs, ...subEvs]);
    const session = r.sessions.get(ROOT)!;
    // The sub thread only moves the activity time.
    expect(session).toMatchObject({ status: 'idle', cwd: '/work/app', title: 'delegate it', lastActivityAt: timeOf(last) });
  });

  test('子线程先到：会话先没有 cwd，主线程 session_meta 到达后用它的 cwd 和状态', () => {
    const s = scenario();
    const r1 = run(n, [s.subStart[0]!, s.subStart[1]!]);
    expect(r1.sessions.get(ROOT)).toMatchObject({ cwd: null, status: 'idle', origin: 'codex' });
    const r2 = run(n, [s.rootEvs[0]!, s.rootEvs[1]!]);
    expect(r2.sessions.get(ROOT)).toMatchObject({ cwd: '/work/app', status: 'running' });
  });

  test('没有 SubAgentActivity 时靠子线程自己的 session_meta 连上（顶层字段，或只有 source.subagent.thread_spawn）', () => {
    for (const spawnSourceOnly of [false, true]) {
      for (const subFirst of [false, true]) {
        const s = scenario({ activity: false, spawnSourceOnly });
        const norm = new CodexNormalizer();
        const r = run(norm, subFirst ? [...s.subEvs, ...s.rootEvs] : [...s.rootEvs, ...s.subEvs]);
        expect(node(r, 'tool:c9')).toMatchObject({ kind: 'subagent', childAgentId: SUB, title: 'Hubble', status: 'succeeded' });
        expect(spawnEdgesAdded(r.changes)).toEqual(['tool:c9->prompt:task1']);
      }
    }
  });

  test('嵌套：子代理再派出孙代理，派发节点在子线程里，状态跟着孙线程', () => {
    const root = new CodexThread({ id: ROOT });
    const sub = new CodexThread({ id: SUB, sessionId: ROOT, parent: ROOT, nickname: 'Child', agentPath: '/root/child' });
    const grand = new CodexThread({ id: 'grand1', sessionId: ROOT, parent: SUB, nickname: 'Grand', agentPath: '/root/child/grand' });
    const rootEvs = [root.meta(), root.started('t1'), root.user('u1', 'go'), root.spawn('c1', 'child'), root.activity('c1', SUB, '/root/child'), root.output('c1', '{}', 'function')];
    const subEvs = [sub.meta(), sub.started('st1'), ...sub.assistant('sm0', 'on it', 'commentary'), sub.spawn('c2', 'grand'), sub.activity('c2', 'grand1', '/root/child/grand'), sub.output('c2', '{}', 'function')];
    const grandEvs = [grand.meta(), grand.started('gt1'), ...grand.assistant('gm1', 'grand done')];
    const r = run(n, [...grandEvs, ...subEvs, ...rootEvs]);
    expect(node(r, 'tool:c2')).toMatchObject({ kind: 'subagent', agentId: SUB, childAgentId: 'grand1', title: 'Grand', status: 'running', parentId: 'text:sm0' });
    expect(node(r, 'text:gm1')).toMatchObject({ agentId: 'grand1', parentId: 'tool:c2' });
    expect(node(r, 'text:sm0').parentId).toBe('tool:c1');
    expect(node(r, 'tool:c1')).toMatchObject({ childAgentId: SUB, status: 'running' });
    const end = grand.complete();
    const r2 = run(n, [end]);
    expect(r2.changes).toContainEqual({ type: 'node_updated', sessionId: ROOT, id: 'tool:c2', patch: expect.objectContaining({ status: 'succeeded', endedAt: timeOf(end) }) });
    expect(spawnEdgesAdded([...r.changes, ...r2.changes]).sort()).toEqual(['tool:c1->text:sm0', 'tool:c2->text:gm1']);
  });

  test('分叉出的子线程文件里抄来的父线程历史（序号小于 subagent_history_start_ordinal）不产生节点', () => {
    const root = new CodexThread({ id: ROOT });
    const rootEvs = [root.meta(), root.started('t1'), root.user('u1', 'go'), root.exec('c1', 'x'), root.output('c1'), root.spawn('c9', 'forked'), root.activity('c9', SUB, '/root/forked')];
    // ordinals: 0 own meta, 1 parent's meta, 2..6 copied records, 7 thread_settings_applied, 8 own task_started
    const sub = new CodexThread({ id: SUB, sessionId: ROOT, parent: ROOT, agentPath: '/root/forked', nickname: 'Fork', historyStart: 7 });
    const subEvs = [
      sub.meta(),
      sub.record('session_meta', { id: ROOT, session_id: ROOT, cwd: '/elsewhere' }),
      sub.started('t1'),
      sub.user('u1', 'go'),
      sub.exec('c1', 'x'),
      sub.output('c1'),
      sub.aborted(),
      sub.record('event_msg', { type: 'thread_settings_applied', thread_id: SUB, thread_settings: {} }),
      sub.started('s-t1'),
      ...sub.assistant('sm1', 'forked work'),
      sub.complete(),
    ];
    for (const order of [[...rootEvs, ...subEvs], [...subEvs, ...rootEvs]]) {
      const r = run(new CodexNormalizer(), order);
      expect(r.unknown).toEqual([]);
      expect(Object.values(r.graph.nodes).filter((x) => x.agentId === SUB).map((x) => x.id)).toEqual(['text:sm1']);
      expect(node(r, 'tool:c1').agentId).toBeNull();
      expect(node(r, 'prompt:u1').agentId).toBeNull();
      expect(node(r, 'tool:c9')).toMatchObject({ childAgentId: SUB, status: 'succeeded' });
      expect(r.sessions.get(ROOT)!.cwd).toBe('/work/app');
    }
  });

  test('重放确定性：两个线程的记录任意交错（各自保持顺序），图和会话都相同', () => {
    const s = scenario();
    const follow = [s.sub.started('s-t2'), s.sub.user('su2', 'again'), s.sub.exec('sc2', 'more'), s.sub.exec('sc3', 'more2'), s.sub.output('sc2'), s.sub.output('sc3'), s.sub.complete()];
    const threads = [s.rootEvs, [...s.subEvs, ...follow]];
    const base = run(new CodexNormalizer(), [...threads[0]!, ...threads[1]!]);
    for (let seed = 1; seed <= 25; seed++) {
      const r = run(new CodexNormalizer(), interleave(threads, seed));
      expect(r.graph).toEqual(base.graph);
      expect(r.sessions.get(ROOT)).toEqual(base.sessions.get(ROOT));
      expect(spawnEdgesAdded(r.changes)).toHaveLength(1);
    }
  });
});

// ---- fix round 1 ----

const ms = (ev: RawEvent): number => Date.parse(timeOf(ev));

describe('折叠按条目开始的时间归到调用', () => {
  test('调用结束之后才写下的条目仍归到它开始时所在的调用；失败的条目让已成功的调用变为失败', () => {
    const root = new CodexThread({ id: 'root1' });
    const head = [root.meta(), root.started('t1'), root.user('u1', 'x')];
    const call = root.exec('c1', 'a');
    const out = root.output('c1');
    const late = root.command('late1', 'make', { status: 'failed', exitCode: 2, startedAtMs: ms(call) + 400 });
    const r = run(n, [...head, call, out, late]);
    expect(r.graph.nodes['tool:late1']).toBeUndefined();
    expect(node(r, 'tool:c1')).toMatchObject({ status: 'failed', summary: 'make', endedAt: timeOf(out), durationMs: ms(out) - ms(call) });
    expect(detailOf(r.changes, 'tool:c1').raw).toEqual({ items: [{ type: 'CommandExecution', name: 'make', status: 'failed', exitCode: 2, durationMs: 250 }] });
  });

  test('条目开始于较早调用的时间窗内、而最近打开的是另一个调用：归到较早的那个', () => {
    const root = new CodexThread({ id: 'root1' });
    const head = [root.meta(), root.started('t1'), root.user('u1', 'x')];
    const c1 = root.exec('c1', 'a');
    const c2 = root.exec('c2', 'b');
    const item = root.command('e1', 'ls', { startedAtMs: ms(c1) + 300 });
    const r = run(n, [...head, c1, c2, item, root.output('c1'), root.output('c2')]);
    expect(ms(c2)).toBeGreaterThan(ms(c1) + 300);
    expect(node(r, 'tool:c1').summary).toBe('ls');
    expect(node(r, 'tool:c2').summary).toBe('b');
    expect(detailOf(r.changes, 'tool:c2').raw).toBeUndefined();
  });

  test('不落在任何调用时间窗内的条目自成节点；没有开始时间的条目归到最近打开的进行中调用，没有则自成节点', () => {
    const root = new CodexThread({ id: 'root1' });
    const head = [root.meta(), root.started('t1'), root.user('u1', 'x'), root.exec('c1', 'a')];
    const out = root.output('c1');
    const r = run(n, [...head, out, root.command('e9', 'sleep 1', { startedAtMs: ms(out) + 500 })]);
    expect(node(r, 'item:e9')).toMatchObject({ status: 'succeeded', parentId: 'tool:c1', timestamp: new Date(ms(out) + 500).toISOString() });
    const r2 = run(n, [root.exec('c2', 'b'), root.exec('c3', 'c'), root.command('e10', 'pwd', { startedAtMs: null })]);
    expect(node(r2, 'tool:c3').summary).toBe('pwd');
    const r3 = run(n, [root.output('c2'), root.output('c3'), root.command('e11', 'id', { startedAtMs: null })]);
    expect(node(r3, 'item:e11').kind).toBe('tool');
  });

  test('摘要取第一条命令：调用里 MCP 条目在命令之前时也一样', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = run(n, [root.meta(), root.started('t1'), root.exec('c1', 'script'), root.mcp('m1', 'docs', 'search'), root.command('e1', 'npm test'), root.output('c1')]);
    expect(node(r, 'tool:c1').summary).toBe('npm test');
  });

  test('超出范围的开始时间（1e20、-1e20）不出错：时间退回记录自己的时间', () => {
    const root = new CodexThread({ id: 'root1' });
    run(n, [root.meta(), root.started('t1')]);
    for (const [id, start] of [['big', 1e20], ['neg', -1e20]] as const) {
      const ev = root.command(id, 'x', { startedAtMs: start });
      const res = n.apply(ev, 'p1');
      expect(res.unknownRecordType).toBeUndefined();
      const added = res.changes.find((c): c is Extract<Change, { type: 'node_added' }> => c.type === 'node_added');
      expect(added?.node).toMatchObject({ id: `item:${id}`, timestamp: timeOf(ev) });
    }
  });

  test('自成节点的条目 id 和调用 id 相同也不冲突（条目用自己的前缀）', () => {
    const root = new CodexThread({ id: 'root1' });
    const call = root.exec('c1', 'a');
    const out = root.output('c1');
    // The item started after its call's window closed (clock skew): it becomes its own node, under its own prefix.
    const late = root.command('c1', 'make', { status: 'failed', exitCode: 2, startedAtMs: ms(out) + 500 });
    const r = run(n, [root.meta(), root.started('t1'), call, out, late]);
    expect(r.unknown).toEqual([]);
    expect(node(r, 'tool:c1')).toMatchObject({ status: 'succeeded' });
    expect(node(r, 'item:c1')).toMatchObject({ kind: 'tool', status: 'failed', parentId: 'tool:c1' });
  });

  test('解析不了的记录时间：不当作会话活动时间，也不进节点时间；退回此前的有效时间', () => {
    const root = new CodexThread({ id: 'root1' });
    const meta = root.meta();
    const started = root.started('t1');
    const r = run(n, [meta, started, root.record('event_msg', { type: 'task_complete', turn_id: 't1' }, { timestamp: 'zzz' })]);
    const session = r.sessions.get('root1')!;
    expect(session.lastActivityAt).toBe(timeOf(started));
    expect(session.status).toBe('idle');
    const r2 = run(n, [root.user('u9', 'hi'), root.record('response_item', { type: 'message', id: 'mz', role: 'assistant', content: [{ type: 'output_text', text: 'x' }] }, { timestamp: 'not a time' })]);
    const prev = r2.graph.nodes['prompt:u9']!.timestamp;
    expect(r2.graph.nodes['text:mz']!.timestamp).toBe(prev);
    expect(Number.isNaN(Date.parse(r2.sessions.get('root1')!.lastActivityAt))).toBe(false);
  });

  test('会话的第一条记录时间就解析不了：之后第一条有效时间同时成为开始和最近活动时间', () => {
    const root = new CodexThread({ id: 'root1' });
    const meta = root.meta() as Extract<RawEvent, { source: 'transcript' }>;
    const bad = root.line(JSON.stringify({ ...JSON.parse(meta.line), timestamp: 'bad' }), 'session_meta');
    const later = root.started('t1');
    const r = run(n, [bad, later]);
    expect(r.sessions.get('root1')).toMatchObject({ startedAt: timeOf(later), lastActivityAt: timeOf(later) });
  });
});

describe('重复的节点 id', () => {
  test('同一会话里已有的 id（本线程或别的线程）：不放节点，报告 duplicate-node-id', () => {
    const root = new CodexThread({ id: 'root1' });
    const sub = new CodexThread({ id: 'sub1', sessionId: 'root1', parent: 'root1', agentPath: '/root/x' });
    const first = run(n, [root.meta(), root.started('t1'), root.exec('c1', 'a'), ...root.assistant('m1', 'one')]);
    expect(first.unknown).toEqual([]);
    const again = run(n, [...root.assistant('m1', 'one again'), sub.meta(), sub.started('s1'), sub.exec('c1', 'copied')]);
    expect(again.unknown).toEqual(['duplicate-node-id', 'duplicate-node-id']);
    expect(again.changes.filter((c) => c.type === 'node_added' || c.type === 'edge_added')).toEqual([]);
  });
});

describe('子代理线程的任务作为提示节点', () => {
  const subThread = () => new CodexThread({ id: 'sub1', sessionId: 'root1', parent: 'root1', agentPath: '/root/helper' });

  test('一轮里没有 UserMessage：首个模型输出之前的最后一条 role user 消息成为提示节点，时间和 id 取那条消息；追加任务的轮次各有自己的提示', () => {
    const s = subThread();
    const head = [s.meta(), s.started('s-t1'), s.context('user', 'environment', 'task-a'), s.context('developer', 'rules')];
    const second = s.context('user', 'the real task', 'task-b');
    const r = run(n, [...head, second, ...s.reasoning('rs1'), s.context('user', 'after output', 'task-c'), ...s.assistant('m1', 'done')]);
    expect(ids(r)).toEqual(['prompt:task-b', 'thinking:rs1', 'text:m1']);
    expect(node(r, 'prompt:task-b')).toMatchObject({ kind: 'prompt', agentId: 'sub1', turnId: 's-t1', timestamp: timeOf(second), summary: 'the real task', parentId: null });
    expect(node(r, 'thinking:rs1').parentId).toBe('prompt:task-b');
    expect(detailOf(r.changes, 'prompt:task-b')).toEqual({ text: 'the real task' });

    const r2 = run(n, [s.started('s-t2'), s.context('user', 'more work', 'task-d'), s.exec('c1', 'x')]);
    expect(node(r2, 'prompt:task-d')).toMatchObject({ parentId: 'text:m1', turnId: 's-t2' });
    expect(node(r2, 'tool:c1').parentId).toBe('prompt:task-d');
    // A turn with a UserMessage item uses that, not the role-user message.
    const r3 = run(n, [s.started('s-t3'), s.context('user', 'ctx', 'task-e'), s.user('um1', 'typed'), ...s.assistant('m3', 'ok')]);
    expect(ids(r3)).toEqual(['prompt:um1', 'text:m3']);
  });

  test('主线程的 role user 消息仍不产生节点', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = run(n, [root.meta(), root.started('t1'), root.context('user', 'env', 'ctx1'), ...root.assistant('m1', 'hi')]);
    expect(ids(r)).toEqual(['text:m1']);
  });
});

describe('SubAgentActivity 只有 started 建立派发关系', () => {
  test('interacted / completed 不连，也不计入未识别', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = run(n, [root.meta(), root.started('t1'), root.spawn('c9', 'nobody'), root.activity('c9', 'sub1', '/root/x', 'interacted'), root.activity('c9', 'sub2', '/root/y', 'completed')]);
    expect(r.unknown).toEqual([]);
    expect(node(r, 'tool:c9')).toMatchObject({ childAgentId: null, status: 'running', title: 'collaboration.spawn_agent' });
  });
});

describe('重放回归', () => {
  /** Root (two turns) spawning A (activity) and B (meta only); A spawns grandchild G; B aborts. */
  function world() {
    const root = new CodexThread({ id: 'root1' });
    const a = new CodexThread({ id: 'thA', sessionId: 'root1', parent: 'root1', nickname: 'Ada', agentPath: '/root/a' });
    const b = new CodexThread({ id: 'thB', sessionId: 'root1', parent: 'root1', nickname: 'Bo', agentPath: '/root/b' });
    const g = new CodexThread({ id: 'thG', sessionId: 'root1', parent: 'thA', nickname: 'Gus', agentPath: '/root/a/g' });
    const rootEvs = [
      root.meta(), root.started('t1'), root.user('u1', 'start'), root.spawn('cA', 'a'), root.activity('cA', 'thA', '/root/a'),
      root.output('cA', '{}', 'function'), root.spawn('cB', 'b'), root.output('cB', '{}', 'function'), root.exec('cx', 'x'),
      root.command('ex', 'echo'), root.output('cx'), ...root.assistant('m1', 'waiting'), root.complete(),
      root.started('t2'), root.user('u2', 'more'), root.call('cf', 'followup_task', { target: '/root/a' }, 'collaboration'),
      root.output('cf', 'ok', 'function'), root.complete(),
    ];
    const aEvs = [
      a.meta(), a.started('a1'), a.context('user', 'task a', 'ta1'), ...a.reasoning('ar1'), a.spawn('cG', 'g'), a.activity('cG', 'thG', '/root/a/g'),
      a.output('cG', '{}', 'function'), ...a.assistant('am1', 'a done'), a.complete(),
      a.started('a2'), a.context('user', 'more a', 'ta2'), ...a.assistant('am2', 'a again'), a.complete(),
    ];
    const bEvs = [b.meta(), b.started('b1'), b.context('user', 'task b', 'tb1'), b.exec('bx', 'y'), b.aborted()];
    const gEvs = [g.meta(), g.started('g1'), g.context('user', 'task g', 'tg1'), ...g.assistant('gm1', 'g done'), g.complete()];
    return { threads: [rootEvs, aEvs, bEvs, gEvs], meta: titleMeta('root1', 'Named') };
  }

  test('四个线程任意交错、标题 meta 在任意位置（定种子）：图和会话都与顺序导入相同', () => {
    const w = world();
    const base = run(new CodexNormalizer(), [w.meta, ...w.threads.flat()]);
    expect(base.unknown).toEqual([]);
    expect(node(base, 'tool:cA')).toMatchObject({ childAgentId: 'thA', status: 'succeeded' });
    expect(node(base, 'tool:cB')).toMatchObject({ childAgentId: 'thB', status: 'failed' });
    expect(node(base, 'tool:cG')).toMatchObject({ childAgentId: 'thG', status: 'succeeded', agentId: 'thA' });
    expect(base.sessions.get('root1')!.title).toBe('Named');
    for (let seed = 1; seed <= 60; seed++) {
      const mixed = interleave(w.threads, seed);
      mixed.splice((seed * 7919) % (mixed.length + 1), 0, w.meta);
      const r = run(new CodexNormalizer(), mixed);
      expect(r.unknown).toEqual([]);
      expect(r.graph).toEqual(base.graph);
      expect(r.sessions.get('root1')).toEqual(base.sessions.get('root1'));
    }
  });

  test('在任意位置重启并按管线的方式补回状态（会话前恢复或整段重放），结果与一次导入相同', () => {
    const w = world();
    const events = [titleMeta('root1', 'Early'), ...interleave(w.threads, 3)];
    events.splice(6, 0, w.meta);
    const once = run(new CodexNormalizer(), events);
    for (let k = 0; k <= events.length; k++) {
      const before = run(new CodexNormalizer(), events.slice(0, k));
      const fresh = new CodexNormalizer();
      if (before.sessions.has('root1')) {
        for (const ev of events.slice(0, k)) fresh.apply(ev, 'p1'); // hydrate: replay, changes already stored
      } else if (fresh.needsPreSessionReplay('root1')) {
        fresh.restorePreSession('root1', events.slice(0, k)); // no session row yet
      }
      const rest = run(fresh, events.slice(k));
      const merged = [...before.changes, ...rest.changes];
      const sessions = merged.flatMap((c) => (c.type === 'session_upserted' ? [c.session] : []));
      expect({ k, session: sessions[sessions.length - 1] }).toEqual({ k, session: once.sessions.get('root1') });
      expect({ k, graph: applyChanges(emptyGraph(), merged) }).toEqual({ k, graph: once.graph });
    }
  });
});
