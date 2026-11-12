import { beforeEach, describe, expect, test } from 'vitest';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type Change,
  type GraphNode,
  type NotificationSettings,
  type Origin,
  type Session,
  type SessionStatus,
} from '@agent-canvas/shared';
import { NotificationEngine, formatDuration, type EngineNotification } from '../src/notify/engine.js';

const T0 = Date.parse('2026-11-12T10:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

let now: number;
let settings: NotificationSettings;
let suppressed: Set<Origin>;
let aborted: Set<string>;
let engine: NotificationEngine;

function session(id: string, status: SessionStatus, over: Partial<Session> = {}): Session {
  return {
    id,
    projectId: 'D--w-tea-shop',
    origin: 'claude',
    cwd: 'D:\\w\\tea-shop',
    title: '修一下登录页',
    gitBranch: null,
    status,
    sourceDeleted: false,
    startedAt: iso(T0 - 3_600_000),
    lastActivityAt: iso(now),
    ...over,
  };
}
const up = (s: Session): Change => ({ type: 'session_upserted', session: s });
function node(sessionId: string, id: string, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    sessionId,
    turnId: null,
    agentId: null,
    childAgentId: null,
    parentId: null,
    kind: 'text',
    status: null,
    timestamp: iso(now),
    confirmed: true,
    title: 'Text',
    summary: '',
    toolName: null,
    toolUseId: null,
    messageId: null,
    durationMs: null,
    endedAt: null,
    usage: null,
    systemSubtype: null,
    ...over,
  };
}
const added = (n: GraphNode): Change => ({ type: 'node_added', node: n, detail: {} });
const kinds = (out: EngineNotification[]): string[] => out.map((n) => n.kind);

/** Sends `s` as running (first seen: primed), then moves the clock. */
function primeRunning(id = 's1', over: Partial<Session> = {}): void {
  engine.handleChanges([up(session(id, 'idle', over))]);
  engine.handleChanges([up(session(id, 'running', over))]);
}

beforeEach(() => {
  now = T0;
  settings = { ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true };
  suppressed = new Set();
  aborted = new Set();
  engine = new NotificationEngine({
    now: () => now,
    settings: () => settings,
    suppressed: (origin) => suppressed.has(origin),
    projectName: (s) => (s.cwd ?? s.projectId).split(/[\\/]/).pop()!,
    sessionUrl: (id) => `http://127.0.0.1:4999/#/s/${encodeURIComponent(id)}`,
    isAbortedCall: (sessionId, nodeId) => aborted.has(`${sessionId}/${nodeId}`),
  });
});

describe('等待权限确认', () => {
  test('进入 awaiting_permission 时发一条；标题、正文、网址', () => {
    primeRunning();
    now += 5_000;
    const out = engine.handleChanges([up(session('s1', 'awaiting_permission'))]);
    expect(out).toEqual([
      {
        kind: 'permission',
        sessionId: 's1',
        title: '等你确认权限 · tea-shop',
        body: '修一下登录页\nClaude Code',
        url: 'http://127.0.0.1:4999/#/s/s1',
      },
    ]);
  });

  test('一直停在该状态不重复；离开后再进入算新的一次（30 秒之后）', () => {
    primeRunning();
    now += 1000;
    expect(kinds(engine.handleChanges([up(session('s1', 'awaiting_permission'))]))).toEqual(['permission']);
    now += 1000;
    expect(engine.handleChanges([up(session('s1', 'awaiting_permission', { title: '改名了' }))])).toEqual([]);
    now += 1000;
    engine.handleChanges([up(session('s1', 'running'))]);
    now += 1000;
    // 30 秒内再次进入：限流
    expect(engine.handleChanges([up(session('s1', 'awaiting_permission'))])).toEqual([]);
    now += 1000;
    engine.handleChanges([up(session('s1', 'running'))]);
    now += 30_000;
    expect(kinds(engine.handleChanges([up(session('s1', 'awaiting_permission'))]))).toEqual(['permission']);
  });

  test('第一次见到时已在等待：不发', () => {
    expect(engine.handleChanges([up(session('s1', 'awaiting_permission'))])).toEqual([]);
  });
});

describe('一轮跑完', () => {
  test('运行至少最短时长后变为空闲：发，正文带用时与来源', () => {
    primeRunning('s1', { origin: 'codex' });
    now += 200_000;
    const out = engine.handleChanges([up(session('s1', 'idle', { origin: 'codex' }))]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'finished', title: '跑完了 · tea-shop', body: '修一下登录页\n用时 3 分 20 秒 · Codex' });
  });

  test('awaiting_input 也算跑完；awaiting_permission 期间仍算在运行', () => {
    primeRunning();
    now += 30_000;
    engine.handleChanges([up(session('s1', 'awaiting_permission'))]);
    now += 40_000;
    expect(kinds(engine.handleChanges([up(session('s1', 'awaiting_input'))]))).toEqual(['finished']);
  });

  test('最短时长的边界：59.999 秒不发，60 秒发；0 表示每一轮都发', () => {
    primeRunning();
    now += 59_999;
    expect(engine.handleChanges([up(session('s1', 'idle'))])).toEqual([]);
    now += 60_000;
    engine.handleChanges([up(session('s1', 'running'))]);
    now += 60_000;
    expect(kinds(engine.handleChanges([up(session('s1', 'idle'))]))).toEqual(['finished']);
    settings = { ...settings, finishedMinSeconds: 0 };
    now += 40_000;
    engine.handleChanges([up(session('s1', 'running'))]);
    now += 1;
    expect(kinds(engine.handleChanges([up(session('s1', 'idle'))]))).toEqual(['finished']);
  });

  test('变为 ended 不算跑完', () => {
    primeRunning();
    now += 120_000;
    expect(engine.handleChanges([up(session('s1', 'ended'))])).toEqual([]);
  });

  test('第一次见到时已在运行：从最近一条主线提示的时间算起', () => {
    const s = session('s1', 'running');
    engine.handleChanges([added(node('s1', 'p1', { kind: 'prompt', timestamp: iso(now - 300_000) })), up(s)]);
    now += 10_000;
    const out = engine.handleChanges([up(session('s1', 'idle'))]);
    expect(out.map((n) => n.body)).toEqual(['修一下登录页\n用时 5 分 10 秒 · Claude Code']);
  });

  test('状态抖动：30 秒内同一会话最多一条', () => {
    settings = { ...settings, finishedMinSeconds: 0 };
    primeRunning();
    const sent: string[] = [];
    for (let i = 0; i < 6; i++) {
      now += 2_000;
      sent.push(...kinds(engine.handleChanges([up(session('s1', i % 2 === 0 ? 'idle' : 'running'))])));
    }
    expect(sent).toEqual(['finished']);
  });
});

describe('出错中断', () => {
  test('Claude interrupt 系统节点：只发出错中断，不发跑完', () => {
    primeRunning();
    now += 120_000;
    const out = engine.handleChanges([
      up(session('s1', 'idle')),
      added(node('s1', 'i1', { kind: 'system', systemSubtype: 'interrupt', title: 'Interrupted' })),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'error', title: '出错中断 · tea-shop', body: '修一下登录页\nClaude Code' });
  });

  test('Codex 失败 / 中止的轮次（interrupt 系统节点）', () => {
    primeRunning('c1', { origin: 'codex' });
    now += 5_000;
    const out = engine.handleChanges([
      added(node('c1', 'system:c1@9', { kind: 'system', systemSubtype: 'interrupt', title: 'Turn failed' })),
      up(session('c1', 'idle', { origin: 'codex' })),
    ]);
    expect(kinds(out)).toEqual(['error']);
  });

  test('子代理里的中断不算', () => {
    primeRunning();
    now += 120_000;
    const out = engine.handleChanges([
      added(node('s1', 'i1', { kind: 'system', systemSubtype: 'interrupt', agentId: 'ag1' })),
      up(session('s1', 'idle')),
    ]);
    expect(kinds(out)).toEqual(['finished']);
  });

  test('Claude StopFailure hook，随后变为空闲：出错中断', () => {
    primeRunning();
    now += 120_000;
    expect(engine.handleHook('claude', 'StopFailure', 's1', null)).toEqual([]);
    expect(kinds(engine.handleChanges([up(session('s1', 'idle'))]))).toEqual(['error']);
  });

  test('StopFailure 时会话已不在运行：立即发出；之后的空闲不再发跑完', () => {
    settings = { ...settings, finishedMinSeconds: 0 };
    primeRunning();
    now += 10_000;
    engine.handleChanges([up(session('s1', 'awaiting_input'))]);
    now += 31_000;
    expect(kinds(engine.handleHook('claude', 'StopFailure', 's1', null))).toEqual(['error']);
    expect(engine.handleChanges([up(session('s1', 'idle'))])).toEqual([]);
    expect(engine.tick()).toEqual([]);
  });

  test('StopFailure 属于未见过的会话：忽略', () => {
    expect(engine.handleHook('claude', 'StopFailure', 'nope', null)).toEqual([]);
    expect(engine.sessionCount()).toBe(0);
  });

  test('其它 hook、子代理的 StopFailure、其它来源：不算', () => {
    primeRunning();
    now += 120_000;
    engine.handleHook('claude', 'Stop', 's1', null);
    engine.handleHook('claude', 'StopFailure', 's1', 'ag1');
    engine.handleHook('codex', 'StopFailure', 's1', null);
    expect(kinds(engine.handleChanges([up(session('s1', 'idle'))]))).toEqual(['finished']);
  });

  test('Cursor：工具因会话中止而失败（查询节点说明）', () => {
    primeRunning('k1', { origin: 'cursor' });
    now += 5_000;
    aborted.add('k1/tool:a');
    const out = engine.handleChanges([
      { type: 'node_updated', sessionId: 'k1', id: 'tool:a', patch: { status: 'failed', endedAt: iso(now) } },
      { type: 'node_updated', sessionId: 'k1', id: 'tool:b', patch: { status: 'failed', endedAt: iso(now) } },
      up(session('k1', 'idle', { origin: 'cursor' })),
    ]);
    expect(kinds(out)).toEqual(['error']);
    expect(out[0]!.body).toBe('修一下登录页\nCursor');
  });

  test('Cursor：普通的工具失败、子代理里的中止，不算；其它来源不查询', () => {
    primeRunning('k1', { origin: 'cursor' });
    engine.handleChanges([added(node('k1', 'tool:sub', { kind: 'tool', status: 'running', agentId: 'sub1' }))]);
    now += 120_000;
    aborted.add('k1/tool:sub');
    aborted.add('s1/tool:x');
    expect(
      kinds(
        engine.handleChanges([
          { type: 'node_updated', sessionId: 'k1', id: 'tool:sub', patch: { status: 'failed' } },
          { type: 'node_updated', sessionId: 'k1', id: 'tool:c', patch: { status: 'failed' } },
          up(session('k1', 'idle', { origin: 'cursor' })),
        ]),
      ),
    ).toEqual(['finished']);
    primeRunning('s1');
    now += 120_000;
    expect(
      kinds(engine.handleChanges([{ type: 'node_updated', sessionId: 's1', id: 'tool:x', patch: { status: 'failed' } }, up(session('s1', 'idle'))])),
    ).toEqual(['finished']);
  });

  test('出错之后在 30 秒后又跑完一轮：这一轮照常算', () => {
    primeRunning();
    now += 5_000;
    engine.handleChanges([up(session('s1', 'idle')), added(node('s1', 'i1', { kind: 'system', systemSubtype: 'interrupt' }))]);
    now += 1_000;
    engine.handleChanges([up(session('s1', 'running'))]);
    now += 90_000;
    expect(kinds(engine.handleChanges([up(session('s1', 'idle'))]))).toEqual(['finished']);
  });
});

describe('卡住很久', () => {
  test('运行中且超过阈值没有活动：定时检查发一条；同一次不再发；新活动后再卡住算新的一次', () => {
    primeRunning();
    now += 15 * 60_000;
    expect(engine.tick()).toEqual([]); // 正好等于阈值：还不算
    now += 30_000;
    const out = engine.tick();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'stuck', title: '卡住了 · tea-shop', body: '修一下登录页\n已 15 分钟没有动静 · Claude Code' });
    now += 30_000;
    expect(engine.tick()).toEqual([]);
    engine.handleChanges([up(session('s1', 'running'))]); // 新活动
    now += 16 * 60_000;
    expect(kinds(engine.tick())).toEqual(['stuck']);
  });

  test('阈值可调；越过阈值很久之后才看到（例如重启前就卡住了）：不发', () => {
    settings = { ...settings, stuckMinutes: 1 };
    primeRunning();
    now += 61_000;
    expect(kinds(engine.tick())).toEqual(['stuck']);
    engine.handleChanges([up(session('s2', 'running', { lastActivityAt: iso(now - 3_600_000) }))]);
    expect(engine.tick()).toEqual([]);
  });

  test('等待用户的会话不算卡住', () => {
    primeRunning();
    now += 1000;
    engine.handleChanges([up(session('s1', 'awaiting_permission'))]);
    now += 20 * 60_000;
    expect(engine.tick()).toEqual([]);
  });
});

describe('不该弹的情况', () => {
  test('导入期间：状态照常记录，但不发；导入结束后不补发', () => {
    suppressed.add('claude');
    primeRunning();
    now += 120_000;
    engine.handleChanges([up(session('s1', 'awaiting_permission'))]);
    expect(engine.handleChanges([up(session('s1', 'idle'))])).toEqual([]);
    suppressed.clear();
    expect(engine.tick()).toEqual([]);
    now += 1000;
    engine.handleChanges([up(session('s1', 'running'))]);
    now += 61_000;
    expect(kinds(engine.handleChanges([up(session('s1', 'idle'))]))).toEqual(['finished']);
  });

  test('按来源抑制：Cursor 首轮轮询期间 Claude 照常', () => {
    suppressed.add('cursor');
    primeRunning('k1', { origin: 'cursor' });
    primeRunning('s1');
    now += 61_000;
    expect(engine.handleChanges([up(session('k1', 'idle', { origin: 'cursor' }))])).toEqual([]);
    expect(kinds(engine.handleChanges([up(session('s1', 'idle'))]))).toEqual(['finished']);
  });

  test('旧事件：触发它的变化距现在超过 2 分钟，不发', () => {
    primeRunning();
    now += 300_000;
    expect(engine.handleChanges([up(session('s1', 'idle', { lastActivityAt: iso(now - 120_001) }))])).toEqual([]);
    engine.handleChanges([up(session('s1', 'running'))]);
    now += 300_000;
    expect(kinds(engine.handleChanges([up(session('s1', 'idle', { lastActivityAt: iso(now - 120_000) }))]))).toEqual(['finished']);
    engine.handleChanges([up(session('s1', 'running'))]);
    now += 100_000;
    const old = added(node('s1', 'i9', { kind: 'system', systemSubtype: 'interrupt', timestamp: iso(now - 600_000) }));
    expect(kinds(engine.handleChanges([old, up(session('s1', 'idle'))]))).toEqual(['finished']);
  });

  test('源文件已删除的会话不发', () => {
    primeRunning('s1', { sourceDeleted: true });
    now += 61_000;
    expect(engine.handleChanges([up(session('s1', 'idle', { sourceDeleted: true }))])).toEqual([]);
  });

  test('关掉的种类、关掉总开关：不发', () => {
    settings = { ...settings, finished: false };
    primeRunning();
    now += 61_000;
    expect(engine.handleChanges([up(session('s1', 'idle'))])).toEqual([]);
    settings = { ...settings, enabled: false, finished: true };
    engine.handleChanges([up(session('s1', 'running'))]);
    now += 61_000;
    engine.handleChanges([up(session('s1', 'awaiting_permission'))]);
    expect(engine.handleChanges([up(session('s1', 'idle'))])).toEqual([]);
  });

  test('第一次见到的状态不通知（旧会话被发现）', () => {
    expect(engine.handleChanges([up(session('old', 'idle'))])).toEqual([]);
    expect(engine.handleChanges([up(session('new', 'running'))])).toEqual([]);
  });
});

describe('内容', () => {
  test('没有标题用“未命名会话”；标题里的特殊字符原样保留；过长截断', () => {
    primeRunning('s1', { title: null });
    now += 1000;
    expect(engine.handleChanges([up(session('s1', 'awaiting_permission', { title: null }))])[0]!.body).toBe('未命名会话\nClaude Code');
    const weird = `a"b'c\n$x \`y\` <z> & ; | %PATH%`;
    primeRunning('s2', { title: weird });
    now += 1000;
    expect(engine.handleChanges([up(session('s2', 'awaiting_permission', { title: weird }))])[0]!.body).toBe(`${weird}\nClaude Code`);
    const long = 'x'.repeat(500);
    primeRunning('s3', { title: long });
    now += 1000;
    const body = engine.handleChanges([up(session('s3', 'awaiting_permission', { title: long }))])[0]!.body;
    expect(body.split('\n')[0]!.length).toBeLessThanOrEqual(120);
  });

  test('网址里的会话 id 被编码', () => {
    primeRunning('a/b?c');
    now += 1000;
    expect(engine.handleChanges([up(session('a/b?c', 'awaiting_permission'))])[0]!.url).toBe('http://127.0.0.1:4999/#/s/a%2Fb%3Fc');
  });

  test('用时格式', () => {
    expect(formatDuration(5_000)).toBe('5 秒');
    expect(formatDuration(200_000)).toBe('3 分 20 秒');
    expect(formatDuration(180_000)).toBe('3 分钟');
    expect(formatDuration(3_900_000)).toBe('1 小时 5 分');
  });
});

describe('健壮性', () => {
  test('设置读取抛错：不发也不抛', () => {
    primeRunning();
    settings = null as unknown as NotificationSettings;
    now += 61_000;
    expect(() => engine.handleChanges([up(session('s1', 'idle'))])).not.toThrow();
  });

  test('不再活跃的会话会被遗忘', () => {
    primeRunning();
    now += 1000;
    engine.handleChanges([up(session('s1', 'idle'))]);
    expect(engine.sessionCount()).toBe(1);
    now += 2 * 3_600_000;
    engine.tick();
    expect(engine.sessionCount()).toBe(0);
  });
});
