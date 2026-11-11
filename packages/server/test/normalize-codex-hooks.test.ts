import { beforeEach, describe, expect, test } from 'vitest';
import { applyChanges, emptyGraph, type Change, type GraphNode, type Session } from '@claude-canvas/shared';
import { CodexNormalizer } from '../src/normalize/codex.js';
import { parseCodexHook } from '../src/normalize/codex-hooks.js';
import { NORMALIZER_VERSION } from '../src/normalize/version.js';
import type { RawEvent } from '../src/store/store.js';
import { CodexThread, interleave, nextTime, run, type RunResult } from './codex-fixtures.js';

/*
 * Codex hooks v1 never create, confirm or settle nodes: the transcript alone makes the graph. Hooks contribute the
 * session status (a function of state: transcript turns + per-turn hook marks) and `awaiting_permission` on the latest
 * open call of the turn's thread while a permission request is pending.
 */

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
      cwd: '/hook/cwd',
      hook_event_name: eventName,
      model: 'gpt-x',
      ...body,
    }),
    projectId: opts.projectId ?? 'p-hook',
  };
}
const pre = (id: string, turn = 't1', extra: Record<string, unknown> = {}) =>
  hook('PreToolUse', { turn_id: turn, tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'ls' }, ...extra });
const post = (id: string, turn = 't1', extra: Record<string, unknown> = {}) =>
  hook('PostToolUse', { turn_id: turn, tool_name: 'Bash', tool_use_id: id, tool_input: {}, tool_response: { exit_code: 0 }, ...extra });
const permission = (turn = 't1', extra: Record<string, unknown> = {}) =>
  hook('PermissionRequest', { turn_id: turn, tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, ...extra });
const prompt = (turn: string) => hook('UserPromptSubmit', { turn_id: turn, prompt: 'x' });
const stop = (turn: string) => hook('Stop', { turn_id: turn, last_assistant_message: 'done' });

/** Applies events with each event's own projectId (hooks: the stored hook project). */
function apply(events: RawEvent[], normalizer: CodexNormalizer = n): RunResult {
  const changes: Change[] = [];
  const unknown: string[] = [];
  const sessions = new Map<string, Session>();
  for (const ev of events) {
    const r = normalizer.apply(ev, ev.source === 'meta' ? 'p1' : (ev.projectId ?? 'unknown'));
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
/** Session status after applying everything so far to `n` (incrementally, across apply calls). */
let lastSession: Session | undefined;
function step(events: RawEvent[]): RunResult {
  const r = apply(events);
  if (r.sessions.has('root1')) lastSession = r.sessions.get('root1');
  return r;
}
const statusNow = () => lastSession?.status;
beforeEach(() => {
  lastSession = undefined;
});
const nodeChanges = (r: RunResult) => r.changes.filter((c) => c.type !== 'session_upserted');

test('NORMALIZER_VERSION 已升级', () => {
  expect(NORMALIZER_VERSION).toBe(18);
});

describe('parseCodexHook', () => {
  test('已知事件、未知事件、坏载荷', () => {
    expect(parseCodexHook('Stop', JSON.stringify({ session_id: 's', cwd: '/w', turn_id: 't9' }))).toMatchObject({
      ok: true,
      hook: { eventName: 'Stop', sessionId: 's', cwd: '/w', turnId: 't9', agentId: null, createsSession: false },
    });
    expect(parseCodexHook('PreToolUse', JSON.stringify({ session_id: 's', agent_id: 'a1' }))).toMatchObject({ ok: true, hook: { agentId: 'a1', turnId: null, createsSession: true } });
    expect(parseCodexHook('Frobnicate', JSON.stringify({ session_id: 's' }))).toEqual({ ok: false, unknownRecordType: 'hook:Frobnicate' });
    expect(parseCodexHook('Stop', 'nope')).toEqual({ ok: false, unknownRecordType: 'hook:invalid' });
    expect(parseCodexHook('Stop', '{}')).toEqual({ ok: false, unknownRecordType: 'hook:invalid' });
  });

  test('会建会话的事件仍是这五个', () => {
    const creates = (e: string) => {
      const p = parseCodexHook(e, JSON.stringify({ session_id: 's' }));
      return p.ok && p.hook.createsSession;
    };
    expect(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse'].every(creates)).toBe(true);
    expect(['Stop', 'SessionEnd', 'Interrupt', 'SubagentStart', 'SubagentStop', 'PostCompact'].some(creates)).toBe(false);
  });
});

describe('hooks 不建、不确认、不结算节点', () => {
  test('转录之前的工具 hook：没有节点，只有会话', () => {
    const r = apply([pre('c1'), permission(), post('c1')]);
    expect(r.unknown).toEqual([]);
    expect(nodeChanges(r)).toEqual([]);
    expect(r.sessions.get('root1')).toMatchObject({ origin: 'codex', projectId: 'p-hook', cwd: '/hook/cwd' });
  });

  test('PreToolUse 先到：调用节点的 id、开始时间、父节点都来自转录', () => {
    const root = new CodexThread({ id: 'root1' });
    const call = root.exec('c1', 'ls');
    const r = apply([root.meta(), root.started('t1'), root.user('u1', 'go'), pre('c1'), call]);
    expect(node(r, 'tool:c1')).toMatchObject({ confirmed: true, status: 'running', parentId: 'prompt:u1', timestamp: JSON.parse((call as { line: string }).line).timestamp });
  });

  test('PostToolUse 不结算：节点等转录的输出', () => {
    const root = new CodexThread({ id: 'root1' });
    apply([root.meta(), root.started('t1'), root.exec('c1', 'ls')]);
    const r = apply([post('c1', 't1', { tool_response: { exit_code: 3 } })]);
    expect(nodeChanges(r)).toEqual([]);
  });

  test('id 对不上的 hook 也不产生任何节点（不再按名字配对）', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = apply([
      root.meta(), root.started('t1'), root.user('u1', 'go'),
      root.exec('call_1', 'x'), pre('exec-aaa'), post('exec-aaa'), pre('exec-bbb'),
      root.output('call_1'), root.complete(), stop('t1'),
    ]);
    expect(Object.keys(r.graph.nodes).sort()).toEqual(['prompt:u1', 'tool:call_1']);
    expect(node(r, 'tool:call_1').status).toBe('succeeded');
  });
});

describe('会话状态：状态的函数', () => {
  test('UserPromptSubmit → 运行中；Stop → 空闲；SessionEnd → 已结束；之后只有 SessionStart / UserPromptSubmit 能恢复', () => {
    const root = new CodexThread({ id: 'root1' });
    step([root.meta(), prompt('t1')]);
    expect(statusNow()).toBe('running');
    step([stop('t1')]);
    expect(statusNow()).toBe('idle');
    step([hook('SessionEnd', { reason: 'exit' })]);
    expect(statusNow()).toBe('ended');
    step([pre('zz', 't2')]);
    expect(statusNow()).toBe('ended');
    step([hook('SessionStart', { source: 'resume' })]);
    expect(statusNow()).toBe('running'); // t2 was started by its PreToolUse and nothing finished it
    step([stop('t2')]);
    expect(statusNow()).toBe('idle');
  });

  test('转录：主线程有未结束的轮次 → 运行中；结束 → 空闲；hook 收到的时间晚于记录时间也不影响', () => {
    const root = new CodexThread({ id: 'root1' });
    step([root.meta(), root.started('t1'), prompt('t1')]);
    expect(statusNow()).toBe('running');
    step([root.complete()]); // its record time is earlier than the hook's receive time
    expect(statusNow()).toBe('idle');
  });

  test('Stop 在 task_complete 之前或之后到都是空闲；Stop 早于该轮最后一个 PostToolUse 到达也是空闲', () => {
    const root = new CodexThread({ id: 'root1' });
    step([root.meta(), root.started('t1'), prompt('t1'), pre('c1'), stop('t1')]);
    expect(statusNow()).toBe('idle'); // the transcript's turn is still open, but Stop stopped it
    step([post('c1')]); // a late forwarder of the same turn
    expect(statusNow()).toBe('idle');
    step([root.complete()]);
    expect(statusNow()).toBe('idle');
  });

  test('Interrupt 结束该轮次', () => {
    const root = new CodexThread({ id: 'root1' });
    step([root.meta(), root.started('t1')]);
    expect(statusNow()).toBe('running');
    step([hook('Interrupt', { turn_id: 't1' })]);
    expect(statusNow()).toBe('idle');
  });

  test('子代理线程的 hook 在主轮次结束后到达：转录知道它属于子线程，不把会话改回运行中', () => {
    const root = new CodexThread({ id: 'root1' });
    const sub = new CodexThread({ id: 'sub1', sessionId: 'root1', parent: 'root1', nickname: 'H', agentPath: '/root/h' });
    step([root.meta(), root.started('t1'), sub.meta(), sub.started('st1'), root.complete(), stop('t1')]);
    expect(statusNow()).toBe('idle');
    step([pre('k1', 'st1', { agent_id: 'sub1' }), post('k1', 'st1', { agent_id: 'sub1' }), permission('st1', { agent_id: 'sub1' })]);
    expect(statusNow()).toBe('idle');
  });

  test('还不知道属于哪个线程的轮次：hook 开始它就算运行中，直到转录说它属于子线程', () => {
    const root = new CodexThread({ id: 'root1' });
    const sub = new CodexThread({ id: 'sub1', sessionId: 'root1', parent: 'root1', nickname: 'H', agentPath: '/root/h' });
    step([root.meta(), root.started('t1'), root.complete(), pre('k1', 'st1', { agent_id: 'sub1' })]);
    expect(statusNow()).toBe('running');
    step([sub.meta(), sub.started('st1')]);
    expect(statusNow()).toBe('idle');
  });

  test('主线程里已被更新的轮次取代的旧轮次，不再算进行中', () => {
    const root = new CodexThread({ id: 'root1' });
    step([root.meta(), prompt('t1'), root.started('t1'), root.started('t2'), root.complete()]);
    expect(statusNow()).toBe('idle');
  });

  test('权限请求：等待确认；同一轮次之后的任何 hook 清除；轮次结束也清除', () => {
    const root = new CodexThread({ id: 'root1' });
    step([root.meta(), root.started('t1'), root.exec('c1', 'rm'), permission()]);
    expect(statusNow()).toBe('awaiting_permission');
    step([post('c1')]);
    expect(statusNow()).toBe('running');
    step([permission()]);
    expect(statusNow()).toBe('awaiting_permission');
    step([root.output('c1'), root.complete()]);
    expect(statusNow()).toBe('idle');
  });

  test('权限请求：转录里该轮次的调用都已结束（且至少结束了一个）时清除；还没读到调用时保持', () => {
    const root = new CodexThread({ id: 'root1' });
    step([root.meta(), root.started('t1'), permission()]);
    expect(statusNow()).toBe('awaiting_permission');
    step([root.exec('c1', 'rm')]);
    expect(statusNow()).toBe('awaiting_permission');
    step([root.output('c1')]);
    expect(statusNow()).toBe('running');
  });

  test('没见过的会话：Stop 等不建会话，但它的标记在会话出现后照样生效', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = apply([stop('t1'), hook('SessionEnd', {}, { session: 'other' })]);
    expect(r.unknown).toEqual([]);
    expect(n.hasSession('root1')).toBe(false);
    expect(n.hasSession('other')).toBe(false);
    step([root.meta(), root.started('t1')]);
    expect(statusNow()).toBe('idle');
  });

  test('子代理的 SessionEnd / SessionStart 不改会话级标记', () => {
    const root = new CodexThread({ id: 'root1' });
    step([root.meta(), hook('SessionEnd', { agent_id: 'sub1' })]);
    expect(statusNow()).toBe('idle');
  });
});

describe('会话的项目和 cwd', () => {
  test('hook 建的会话先用 hook 的；第一条转录记录到了以后 hook 不再改', () => {
    let r = step([hook('SessionStart', { source: 'startup' }, { projectId: 'p-hook' })]);
    expect(r.sessions.get('root1')).toMatchObject({ origin: 'codex', projectId: 'p-hook', cwd: '/hook/cwd' });
    const root = new CodexThread({ id: 'root1', cwd: '/work/app', projectId: 'p-file' });
    r = step([root.meta(), root.started('t1')]);
    expect(lastSession).toMatchObject({ projectId: 'p-file', cwd: '/work/app' });
    step([prompt('t1'), hook('PreToolUse', { turn_id: 't1', cwd: '/elsewhere' }, { projectId: 'p-other' })]);
    expect(lastSession).toMatchObject({ projectId: 'p-file', cwd: '/work/app' });
  });

  test('先到的是子线程的记录：项目取那条记录的，cwd 等主线程的 session_meta', () => {
    const sub = new CodexThread({ id: 'sub1', sessionId: 'root1', parent: 'root1', projectId: 'p-sub' });
    step([prompt('t1'), sub.meta()]);
    expect(lastSession).toMatchObject({ projectId: 'p-sub', cwd: null });
  });
});

describe('节点上的等待确认', () => {
  test('该轮次所在线程里最新的未结束调用显示等待确认；清除后回到执行中；已结束的保持结束', () => {
    const root = new CodexThread({ id: 'root1' });
    let r = step([root.meta(), root.started('t1'), root.exec('c1', 'a'), root.exec('c2', 'b'), permission()]);
    const g1 = r.graph;
    expect(g1.nodes['tool:c2']!.status).toBe('awaiting_permission');
    expect(g1.nodes['tool:c1']!.status).toBe('running');
    r = step([pre('x')]);
    const g2 = applyChanges(g1, r.changes);
    expect(g2.nodes['tool:c2']!.status).toBe('running');
    r = step([permission()]);
    const g3 = applyChanges(g2, r.changes);
    expect(g3.nodes['tool:c2']!.status).toBe('awaiting_permission');
    r = step([root.output('c2')]);
    const g4 = applyChanges(g3, r.changes);
    expect(g4.nodes['tool:c2']!.status).toBe('succeeded');
    expect(g4.nodes['tool:c1']!.status).toBe('awaiting_permission'); // still pending: c1 is the latest open call now
  });

  test('子线程轮次的权限请求标记子线程的节点，不改会话状态', () => {
    const root = new CodexThread({ id: 'root1' });
    const sub = new CodexThread({ id: 'sub1', sessionId: 'root1', parent: 'root1' });
    const r = step([root.meta(), root.started('t1'), root.exec('c1', 'a'), sub.meta(), sub.started('st1'), sub.exec('k1', 'b'), permission('st1', { agent_id: 'sub1' })]);
    expect(node(r, 'tool:k1').status).toBe('awaiting_permission');
    expect(node(r, 'tool:c1').status).toBe('running');
    expect(statusNow()).toBe('running');
  });

  test('不知道属于哪个线程的轮次：主线程里最新的未结束调用', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = step([root.meta(), root.started('t1'), root.exec('c1', 'a'), permission('t-unknown')]);
    expect(node(r, 'tool:c1').status).toBe('awaiting_permission');
  });
});

describe('派发节点的子线程未知（B5）', () => {
  test('派发所在轮次进行中 → 执行中；轮次结束 → 失败（结束时间 = 轮次结束）；之后子线程出现 → 跟着子线程', () => {
    const root = new CodexThread({ id: 'root1' });
    const sub = new CodexThread({ id: 'sub1', sessionId: 'root1', parent: 'root1', nickname: 'H', agentPath: '/root/helper' });
    const head = [root.meta(), root.started('t1'), root.spawn('sp1', 'helper'), root.output('sp1', 'failed to start', 'function')];
    const end = root.complete();
    const subEvs = [sub.meta(), sub.started('st1')];
    const open = step(head);
    expect(node(open, 'tool:sp1')).toMatchObject({ status: 'running', endedAt: null, childAgentId: null });
    const endTime = JSON.parse((end as { line: string }).line).timestamp as string;
    const ended = run(new CodexNormalizer(), [...head, end]);
    expect(node(ended, 'tool:sp1')).toMatchObject({ status: 'failed', endedAt: endTime, childAgentId: null });
    // Both arrival orders: the child thread known before / after the turn end.
    const childFirst = run(new CodexNormalizer(), [...head, ...subEvs, end]);
    const childLast = run(new CodexNormalizer(), [...head, end, ...subEvs]);
    expect(node(childFirst, 'tool:sp1')).toMatchObject({ status: 'running', endedAt: null, childAgentId: 'sub1' });
    expect(childLast.graph).toEqual(childFirst.graph);
  });
});

describe('与转录的等价性、与到达顺序无关', () => {
  /**
   * A root turn with a permission prompt and a subagent whose tool hooks arrive after the root turn ended; a second
   * root turn; SessionEnd then a resumed third turn. Hooks keep their own order, records theirs.
   */
  function scenario() {
    const root = new CodexThread({ id: 'root1', projectId: 'p-file' });
    const sub = new CodexThread({ id: 'sub1', sessionId: 'root1', parent: 'root1', nickname: 'Helper', agentPath: '/root/helper', projectId: 'p-file' });
    const transcriptRoot = [
      root.meta(), root.started('t1'), root.user('u1', 'build it'),
      ...root.reasoning('rs1'),
      root.exec('c1', 'ls'), root.command('cmd1', 'ls'), root.output('c1'), root.usage(),
      root.exec('c2', 'rm build'), root.command('cmd2', 'rm build', { exitCode: 2 }), root.output('c2'), root.usage(),
      root.spawn('sp1', 'helper'), root.activity('sp1', 'sub1', '/root/helper'), root.output('sp1', 'started', 'function'), root.usage(),
      ...root.assistant('m1', 'done'), root.complete(),
      root.started('t2'), root.user('u2', 'again'), root.exec('c3', 'make'), root.output('c3'), root.usage(), root.complete(),
      root.started('t3'), root.user('u3', 'resumed'), ...root.assistant('m3', 'ok'), root.complete(),
    ];
    const transcriptSub = [
      sub.meta(), sub.started('st1'), sub.context('user', 'do the sub task', 'task1'),
      sub.exec('k1', 'pwd'), sub.output('k1'), sub.usage(), ...sub.assistant('sm1', 'sub done'), sub.complete(),
    ];
    const hooks = [
      hook('SessionStart', { source: 'startup' }),
      prompt('t1'),
      pre('c1'), post('c1'),
      pre('c2'), permission(), post('c2'),
      hook('PreToolUse', { turn_id: 't1', tool_name: 'spawn_agent', tool_use_id: 'sp1', tool_input: { task_name: 'helper' } }),
      hook('PostToolUse', { turn_id: 't1', tool_name: 'spawn_agent', tool_use_id: 'sp1', tool_response: 'started' }),
      hook('SubagentStart', { agent_id: 'sub1', agent_type: 'worker' }),
      stop('t1'),
      pre('k1', 'st1', { agent_id: 'sub1' }), permission('st1', { agent_id: 'sub1' }), post('k1', 'st1', { agent_id: 'sub1' }),
      hook('SubagentStop', { agent_id: 'sub1', agent_type: 'worker' }),
      prompt('t2'), pre('c3', 't2'), post('c3', 't2'), stop('t2'),
      hook('SessionEnd', { reason: 'exit' }),
      hook('SessionStart', { source: 'resume' }), prompt('t3'), stop('t3'),
    ];
    return { transcriptRoot, transcriptSub, hooks };
  }
  const isTranscript = (e: RawEvent) => e.source === 'transcript';

  test('任意穿插：节点集合（id、类型、父节点、边、时间、终态）与没有 hooks 时完全相同；同一顺序重放相同', () => {
    const { transcriptRoot, transcriptSub, hooks } = scenario();
    for (let seed = 1; seed <= 40; seed++) {
      const order = interleave([transcriptRoot, transcriptSub, hooks], seed);
      const plain = apply(order.filter(isTranscript), new CodexNormalizer());
      expect(plain.unknown).toEqual([]);
      const withHooks = apply(order, new CodexNormalizer());
      expect(withHooks.unknown).toEqual([]);
      expect(withHooks.graph).toEqual(plain.graph);
      expect(withHooks.sessions.get('root1')!.status).toBe('idle');
      expect(apply(order, new CodexNormalizer()).graph).toEqual(withHooks.graph);
    }
  });

  test('每一步：会话和图只取决于已读的转录前缀和已收的 hook 前缀，与两者如何穿插无关（定种子）', () => {
    const { transcriptRoot, transcriptSub, hooks } = scenario();
    const seen = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) {
      const order = interleave([transcriptRoot, transcriptSub, hooks], seed * 977);
      const live = new CodexNormalizer();
      let graph = emptyGraph();
      let session: Session | undefined;
      const ts: RawEvent[] = [];
      const hs: RawEvent[] = [];
      for (const ev of order) {
        (isTranscript(ev) ? ts : hs).push(ev);
        const r = apply([ev], live);
        graph = applyChanges(graph, r.changes);
        session = r.sessions.get('root1') ?? session;
        const tFirst = apply([...ts, ...hs], new CodexNormalizer());
        const hFirst = apply([...hs, ...ts], new CodexNormalizer());
        const at = { seed, t: ts.length, h: hs.length };
        expect({ at, session: tFirst.sessions.get('root1') }).toEqual({ at, session });
        expect({ at, session: hFirst.sessions.get('root1') }).toEqual({ at, session });
        expect({ at, graph: tFirst.graph }).toEqual({ at, graph });
        expect({ at, graph: hFirst.graph }).toEqual({ at, graph });
        if (session) seen.add(session.status);
      }
      // A rebuild (the same stored order replayed) ends in the same place.
      const rebuilt = apply(order, new CodexNormalizer());
      expect(rebuilt.graph).toEqual(graph);
      expect(rebuilt.sessions.get('root1')).toEqual(session);
    }
    // The run went through every status the hooks can cause.
    expect([...seen].sort()).toEqual(['awaiting_permission', 'ended', 'idle', 'running']);
  });
});
