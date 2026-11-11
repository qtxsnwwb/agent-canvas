import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import type { Change, GraphNode, Session, SessionStatus } from '@claude-canvas/shared';
import { CHANGE_LOG_MAX_ROWS, HOOK_STAT_BACKFILL_NOTICE, HOOK_STAT_BACKFILL_SELECT, openStore, type Store } from '../src/store/store.js';
import { SCHEMA_SQL } from '../src/store/schema.js';

let store: Store;
beforeEach(() => {
  store = openStore(':memory:');
});
afterEach(() => {
  store.close();
  vi.useRealTimers();
});

function sessionUpsert(id: string, projectId: string, status: SessionStatus = 'idle', cwd: string | null = null): Change {
  const session: Session = {
    id,
    projectId,
    cwd,
    title: null,
    gitBranch: null,
    status,
    sourceDeleted: false,
    startedAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-01-01T00:00:00.000Z',
  };
  return { type: 'session_upserted', session };
}

function mkNode(id: string, sessionId: string): GraphNode {
  return {
    id,
    sessionId,
    turnId: null,
    agentId: null,
    parentId: null,
    kind: 'tool',
    status: 'running',
    timestamp: '2026-01-01T00:00:00.000Z',
    confirmed: true,
    title: 'Read',
    summary: '',
    toolName: 'Read',
    toolUseId: null,
    messageId: null,
    durationMs: null,
    usage: null,
    systemSubtype: null,
    childAgentId: null,
    endedAt: null,
  };
}

function nodeAdded(id: string, sessionId: string): Change {
  return { type: 'node_added', node: mkNode(id, sessionId), detail: {} };
}

function nodeUpdated(id: string, sessionId: string, patch: Partial<GraphNode>): Change {
  return { type: 'node_updated', sessionId, id, patch };
}

test('insertRaw 对相同文件的相同行去重', () => {
  const ev = { source: 'transcript', file: 'a.jsonl', offset: 0, line: '{"x":1}', recordType: 'user', sessionId: 's1', agentId: null } as const;
  expect(store.insertRaw(ev)).toBe(1);
  expect(store.insertRaw({ ...ev, offset: 99 })).toBeNull();
  expect(store.insertRaw({ ...ev, file: 'b.jsonl' })).toBe(2);
});

test('hook 事件不去重', () => {
  const ev = { source: 'hook', receivedAt: 't', eventName: 'Stop', sessionId: 's1', payload: '{}' } as const;
  expect(store.insertRaw(ev)).not.toBeNull();
  expect(store.insertRaw(ev)).not.toBeNull();
});

test('offset 默认 0，可更新', () => {
  expect(store.getOffset('a.jsonl')).toBe(0);
  store.setOffset('a.jsonl', 120, 120);
  expect(store.getOffset('a.jsonl')).toBe(120);
});

test('applyChanges 分配连续 seq 并可查询快照', () => {
  const out = store.applyChanges([sessionUpsert('s1', 'p1'), nodeAdded('n1', 's1'), nodeUpdated('n1', 's1', { status: 'succeeded' })]);
  expect(out.map((c) => c.seq)).toEqual([1, 2, 3]);
  const g = store.getGraph('s1')!;
  expect(g.nodes[0].status).toBe('succeeded');
  expect(g.seq).toBe(3);
});

test('changesSince 按会话过滤', () => {
  store.applyChanges([sessionUpsert('s1', 'p1'), sessionUpsert('s2', 'p1'), nodeAdded('n1', 's1'), nodeAdded('n2', 's2')]);
  expect(store.changesSince(0, 's2').map((c) => c.seq)).toEqual([2, 4]);
  expect(store.changesSince(3).map((c) => c.seq)).toEqual([4]);
});

test('节点 detail 不出现在快照里，但可单独取', () => {
  store.applyChanges([sessionUpsert('s1', 'p1'), { type: 'node_added', node: mkNode('n1', 's1'), detail: { output: 'x'.repeat(10_000) } }]);
  expect(JSON.stringify(store.getGraph('s1'))).not.toContain('xxxxxxxxxx');
  expect(store.getNodeDetail('s1', 'n1')!.output).toHaveLength(10_000);
});

test('node_updated 的 detail 与已有 detail 合并', () => {
  store.applyChanges([sessionUpsert('s1', 'p1'), { type: 'node_added', node: mkNode('n1', 's1'), detail: { input: { a: 1 } } }]);
  store.applyChanges([{ type: 'node_updated', sessionId: 's1', id: 'n1', patch: {}, detail: { output: 'ok' } }]);
  expect(store.getNodeDetail('s1', 'n1')).toMatchObject({ input: { a: 1 }, output: 'ok' });
});

test('listProjects 统计会话数和活跃数', () => {
  // Group 1c: activity counts use the effective status, so "now" must be close to lastActivityAt.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));
  store.applyChanges([sessionUpsert('s1', 'p1', 'running'), sessionUpsert('s2', 'p1', 'idle'), sessionUpsert('s3', 'p2', 'ended')]);
  expect(store.listProjects(Date.now())).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'p1', sessionCount: 2, activeSessionCount: 1 }),
    expect.objectContaining({ id: 'p2', sessionCount: 1, activeSessionCount: 0 }),
  ]));
});

test('clearDerived 保留原始记录和偏移', () => {
  store.insertRaw({ source: 'hook', receivedAt: 't', eventName: 'Stop', sessionId: 's1', payload: '{}' });
  store.setOffset('a.jsonl', 5, 5);
  store.applyChanges([sessionUpsert('s1', 'p1')]);
  store.clearDerived();
  expect(store.getSession('s1')).toBeNull();
  expect(store.rawForSession('s1')).toHaveLength(1);
  expect(store.getOffset('a.jsonl')).toBe(5);
  expect(store.changesSince(0)).toEqual([]);
});

test('bumpUnknown 计数并只保留首个样例', () => {
  store.bumpUnknown('atis-latch', 'first');
  store.bumpUnknown('atis-latch', 'second');
  expect(store.diagnostics().unknownRecords).toEqual([{ recordType: 'atis-latch', count: 2, sample: 'first' }]);
});

test('clearDerived 之后 seq 仍然单调递增', () => {
  const before = store.applyChanges([sessionUpsert('s1', 'p1'), nodeAdded('n1', 's1')]);
  const maxBefore = Math.max(...before.map((c) => c.seq));
  store.clearDerived();
  const after = store.applyChanges([sessionUpsert('s1', 'p1')]);
  expect(after[0].seq).toBeGreaterThan(maxBefore);
});

test('rawForSessionAfter pages by ingestId in ascending order', () => {
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) {
    ids.push(store.insertRaw({ source: 'hook', receivedAt: `t${i}`, eventName: 'Stop', sessionId: 's1', payload: `{"i":${i}}` })!);
    store.insertRaw({ source: 'hook', receivedAt: `o${i}`, eventName: 'Stop', sessionId: 'other', payload: '{}' });
  }
  const page1 = store.rawForSessionAfter('s1', 0, 2);
  expect(page1.map((e) => e.ingestId)).toEqual([ids[0], ids[1]]);
  const page2 = store.rawForSessionAfter('s1', page1[1]!.ingestId, 2);
  expect(page2.map((e) => e.ingestId)).toEqual([ids[2], ids[3]]);
  expect(store.rawForSessionAfter('s1', ids[3]!, 10).map((e) => e.ingestId)).toEqual([ids[4]]);
  expect(store.rawForSessionAfter('s1', ids[4]!, 10)).toEqual([]);
  expect(store.rawForSessionAfter('missing', 0, 10)).toEqual([]);
  expect(store.rawForSession('s1').map((e) => e.ingestId)).toEqual(ids);
});

test('latestMeta returns the newest meta payload of a file', () => {
  expect(store.latestMeta('m.json')).toBeNull();
  store.insertRaw({ source: 'meta', file: 'm.json', sessionId: 's1', agentId: null, payload: 'one' });
  store.insertRaw({ source: 'meta', file: 'other.json', sessionId: 's1', agentId: null, payload: 'x' });
  store.insertRaw({ source: 'meta', file: 'm.json', sessionId: 's1', agentId: null, payload: 'two' });
  expect(store.latestMeta('m.json')).toBe('two');
  expect(store.latestMeta('other.json')).toBe('x');
});

test('listProjects 不把长时间无活动的 running 会话计为活跃', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  store.applyChanges([
    sessionUpsert('s1', 'p1', 'running'),
    sessionUpsert('s2', 'p1', 'awaiting_input'),
    sessionUpsert('s3', 'p1', 'awaiting_permission'),
  ]);
  vi.setSystemTime(new Date('2026-01-01T00:14:00.000Z'));
  expect(store.listProjects(Date.now())[0]).toMatchObject({ sessionCount: 3, activeSessionCount: 3 });
  vi.setSystemTime(new Date('2026-01-01T00:15:01.000Z'));
  expect(store.listProjects(Date.now())[0]).toMatchObject({ sessionCount: 3, activeSessionCount: 2 });
  vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
  expect(store.listProjects(Date.now())[0]).toMatchObject({ activeSessionCount: 2 });
});

test('项目目录取编码后等于项目 id 的 cwd；子目录里启动的会话不影响', () => {
  const root = String.raw`D:\work\app`;
  const sub = String.raw`D:\work\app\packages\web`;
  store.applyChanges([
    sessionUpsert('a1', 'D--work-app', 'idle', root),
    sessionUpsert('a2', 'D--work-app', 'idle', root),
    sessionUpsert('a3', 'D--work-app', 'idle', sub),
    sessionUpsert('a4', 'D--work-app', 'idle', sub),
    sessionUpsert('a5', 'D--work-app', 'idle', sub),
  ]);
  expect(store.listProjects(Date.now())[0]).toMatchObject({ id: 'D--work-app', cwd: root, sessionCount: 5 });
});

test('多种写法都能对上项目 id 时取出现次数最多的，并列取字典序最小的', () => {
  store.applyChanges([
    sessionUpsert('b1', 'a-b', 'idle', 'a b'),
    sessionUpsert('b2', 'a-b', 'idle', 'a_b'),
    sessionUpsert('b3', 'a-b', 'idle', 'a_b'),
    sessionUpsert('c1', 'c-d', 'idle', 'c_d'),
    sessionUpsert('c2', 'c-d', 'idle', 'c d'),
  ]);
  const by = Object.fromEntries(store.listProjects(Date.now()).map((p) => [p.id, p.cwd]));
  expect(by).toEqual({ 'a-b': 'a_b', 'c-d': 'c d' });
});

test('cwd 大小写不同或带结尾分隔符时对不上项目 id，项目目录为 null', () => {
  store.applyChanges([
    sessionUpsert('k1', 'D--work-app', 'idle', 'd:/work/app'),
    sessionUpsert('k2', 'D--work-app', 'idle', 'D:/work/app/'),
  ]);
  expect(store.listProjects(Date.now())[0]).toMatchObject({ id: 'D--work-app', cwd: null, sessionCount: 2 });
});

test('没有任何 cwd 能对上项目 id 时为 null', () => {
  store.applyChanges([sessionUpsert('n1', 'proj', 'idle', '/somewhere/else'), sessionUpsert('n2', 'proj', 'idle', null)]);
  expect(store.listProjects(Date.now())[0]).toMatchObject({ id: 'proj', cwd: null, sessionCount: 2 });
});

test('运行中但 15 分钟无活动的会话不计入 activeSessionCount；等待输入、等待权限确认的照常计入', () => {
  store.applyChanges([
    sessionUpsert('r1', 'p1', 'running'),
    sessionUpsert('r2', 'p1', 'awaiting_input'),
    sessionUpsert('r3', 'p1', 'awaiting_permission'),
  ]);
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  expect(store.listProjects(t0 + 14 * 60_000)[0]).toMatchObject({ activeSessionCount: 3 });
  expect(store.listProjects(t0 + 16 * 60_000)[0]).toMatchObject({ sessionCount: 3, activeSessionCount: 2 });
});

// ---- final fix wave, group 6: storage integrity ----

test('transaction 全部提交或全部回滚', () => {
  const hookEv = { source: 'hook', receivedAt: 't', eventName: 'Stop', sessionId: 's1', payload: '{}' } as const;
  expect(store.transaction(() => store.insertRaw(hookEv))).toBe(1);
  expect(() =>
    store.transaction(() => {
      store.insertRaw(hookEv);
      store.applyChanges([sessionUpsert('s1', 'p1')]);
      store.setOffset('a.jsonl', 5, 5);
      throw new Error('boom');
    }),
  ).toThrow('boom');
  expect(store.rawForSession('s1')).toHaveLength(1);
  expect(store.getSession('s1')).toBeNull();
  expect(store.getOffset('a.jsonl')).toBe(0);
  expect(store.changesSince(0)).toEqual([]);
});

test('不带 detail 的 node_updated 不读写 node_detail', () => {
  const sql: string[] = [];
  const s = openStore(':memory:', { verbose: (q) => sql.push(String(q)) });
  try {
    s.applyChanges([sessionUpsert('s1', 'p1'), { type: 'node_added', node: mkNode('n1', 's1'), detail: { input: 1 } }]);
    sql.length = 0;
    s.applyChanges([nodeUpdated('n1', 's1', { status: 'succeeded' })]);
    expect(sql.filter((q) => q.includes('node_detail'))).toEqual([]);
    expect(sql.length).toBeGreaterThan(0);
    expect(s.getNodeDetail('s1', 'n1')).toMatchObject({ input: 1 });
    expect(s.getGraph('s1')!.nodes[0]!.status).toBe('succeeded');
  } finally {
    s.close();
  }
});

test('getGraphJson 直接返回序列化好的快照', () => {
  store.applyChanges([
    sessionUpsert('s1', 'p1'),
    { type: 'node_added', node: mkNode('n1', 's1'), detail: { output: 'big' } },
    nodeAdded('n2', 's1'),
    { type: 'edge_added', edge: { id: 'n1->n2', sessionId: 's1', from: 'n1', to: 'n2', kind: 'sequence' } },
  ]);
  const json = store.getGraphJson('s1')!;
  expect(typeof json).toBe('string');
  expect(JSON.parse(json)).toEqual(store.getGraph('s1'));
  expect(json).not.toContain('big');
  expect(store.getGraphJson('nope')).toBeNull();
});

test('change_log 不含 detail，返回的变更也不含', () => {
  const out = store.applyChanges([
    sessionUpsert('s1', 'p1'),
    { type: 'node_added', node: mkNode('n1', 's1'), detail: { input: 'x'.repeat(1000) } },
    { type: 'node_updated', sessionId: 's1', id: 'n1', patch: { status: 'succeeded' }, detail: { output: 'y' } },
  ]);
  for (const list of [out, store.changesSince(0)]) {
    expect(list[1]).toMatchObject({ type: 'node_added', detail: {} });
    expect('detail' in list[2]!).toBe(false);
  }
  expect(store.getNodeDetail('s1', 'n1')).toMatchObject({ input: 'x'.repeat(1000), output: 'y' });
});

test('同一次 applyChanges 里每个会话只记录最后一次 session_upserted', () => {
  const a = sessionUpsert('s1', 'p1', 'idle');
  const c = sessionUpsert('s1', 'p1', 'ended');
  const out = store.applyChanges([a, nodeAdded('n1', 's1'), sessionUpsert('s1', 'p1', 'running'), sessionUpsert('s2', 'p1'), c]);
  expect(out.map((x) => [x.type, x.type === 'session_upserted' ? x.session.id : '', x.seq])).toEqual([
    ['node_added', '', 1],
    ['session_upserted', 's2', 2],
    ['session_upserted', 's1', 3],
  ]);
  expect(store.changesSince(0)).toEqual(out);
  expect(store.getSession('s1')!.status).toBe('ended');
});

test('change_log 超过上限时裁剪到 90%，minSeq 随之前移', () => {
  const s = openStore(':memory:', { changeLogMaxRows: 100, pruneCheckEvery: 10 });
  try {
    expect(s.minSeq()).toBe(1);
    s.applyChanges([sessionUpsert('s1', 'p1')]);
    for (let i = 0; i < 250; i++) s.applyChanges([nodeUpdated('n', 's1', { summary: String(i) })]);
    const kept = s.changesSince(0);
    expect(kept.length).toBeLessThanOrEqual(100);
    expect(kept.length).toBeGreaterThanOrEqual(90);
    expect(s.minSeq()).toBe(kept[0]!.seq);
    expect(kept.at(-1)!.seq).toBe(251);
    s.clearDerived();
    expect(s.minSeq()).toBe(252);
  } finally {
    s.close();
  }
});

test('CHANGE_LOG_MAX_ROWS 默认 20 万', () => {
  expect(CHANGE_LOG_MAX_ROWS).toBe(200_000);
});

test('diagnostics 不扫描 raw_event，仍给出最近 hook 时间', () => {
  const sql: string[] = [];
  const s = openStore(':memory:', { verbose: (q) => sql.push(String(q)) });
  try {
    s.insertRaw({ source: 'hook', receivedAt: '2026-01-01T00:00:02.000Z', eventName: 'Stop', sessionId: 's1', payload: '{}' });
    s.insertRaw({ source: 'hook', receivedAt: '2026-01-01T00:00:01.000Z', eventName: 'Stop', sessionId: 's1', payload: '{}' });
    sql.length = 0;
    expect(s.diagnostics().lastHookAt).toBe('2026-01-01T00:00:02.000Z');
    expect(s.lastHookAt()).toBe('2026-01-01T00:00:02.000Z');
    expect(sql.filter((q) => q.includes('raw_event'))).toEqual([]);
  } finally {
    s.close();
  }
});

test('hookEventStats 按事件名聚合次数和最近时间，不含 transcript 行', () => {
  expect(store.hookEventStats()).toEqual([]);
  const hook = (eventName: string, receivedAt: string) =>
    store.insertRaw({ source: 'hook', receivedAt, eventName, sessionId: 's1', payload: '{}' });
  hook('Stop', '2026-01-01T00:00:02.000Z');
  hook('PreToolUse', '2026-01-01T00:00:01.000Z');
  hook('Stop', '2026-01-01T00:00:05.000Z');
  hook('Stop', '2026-01-01T00:00:03.000Z');
  store.insertRaw({ source: 'transcript', file: 'p/a.jsonl', offset: 0, line: '{"type":"user"}', recordType: 'user', sessionId: 's1', agentId: null });
  expect(store.hookEventStats()).toEqual([
    { eventName: 'PreToolUse', count: 1, lastAt: '2026-01-01T00:00:01.000Z' },
    { eventName: 'Stop', count: 3, lastAt: '2026-01-01T00:00:05.000Z' },
  ]);
});

const hookAt = (s: Store, eventName: string, receivedAt: string) =>
  s.insertRaw({ source: 'hook', receivedAt, eventName, sessionId: 's1', payload: '{}' });

test('hookEventStats 只读 hook_stat 计数表，不扫描 raw_event；计数与从头聚合一致', () => {
  const sql: string[] = [];
  const s = openStore(':memory:', { verbose: (q) => sql.push(String(q)) });
  try {
    const times = ['2026-01-01T00:00:04.000Z', '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:09.000Z', '2026-01-01T00:00:02.000Z'];
    const names = ['Stop', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification', 'PreToolUse', 'Stop'];
    names.forEach((name, i) => hookAt(s, name, times[i % times.length]!));
    s.insertRaw({ source: 'transcript', file: 'p/a.jsonl', offset: 0, line: '{"type":"user"}', recordType: 'user', sessionId: 's1', agentId: null });
    s.insertRaw({ source: 'meta', file: 'p/s1/custom-title.json', sessionId: 's1', agentId: null, payload: '{}' });
    const expected = new Map<string, { count: number; lastAt: string }>();
    names.forEach((name, i) => {
      const at = times[i % times.length]!;
      const prev = expected.get(name);
      expected.set(name, { count: (prev?.count ?? 0) + 1, lastAt: prev && prev.lastAt > at ? prev.lastAt : at });
    });
    const fromScratch = [...expected.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([eventName, v]) => ({ eventName, ...v }));
    sql.length = 0;
    expect(s.hookEventStats()).toEqual(fromScratch);
    expect(sql.filter((q) => q.includes('raw_event'))).toEqual([]);
  } finally {
    s.close();
  }
});

test('回滚的 hook 插入不增加计数', () => {
  hookAt(store, 'Stop', '2026-01-01T00:00:01.000Z');
  expect(() =>
    store.transaction(() => {
      hookAt(store, 'Stop', '2026-01-01T00:00:05.000Z');
      hookAt(store, 'PreToolUse', '2026-01-01T00:00:06.000Z');
      throw new Error('boom');
    }),
  ).toThrow('boom');
  expect(store.hookEventStats()).toEqual([{ eventName: 'Stop', count: 1, lastAt: '2026-01-01T00:00:01.000Z' }]);
});

test('清空派生数据（重建）不重置 hook 计数', () => {
  hookAt(store, 'Stop', '2026-01-01T00:00:01.000Z');
  store.clearDerived();
  expect(store.hookEventStats()).toEqual([{ eventName: 'Stop', count: 1, lastAt: '2026-01-01T00:00:01.000Z' }]);
});

test('升级：已有数据库打开时从 raw_event 回填一次 hook_stat，并删掉不再使用的 raw_event_hook 索引', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { default: Database } = await import('better-sqlite3');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cc-hook-stat-'));
  const file = path.join(dir, 'a.db');
  try {
    const old = openStore(file);
    hookAt(old, 'Stop', '2026-01-01T00:00:02.000Z');
    hookAt(old, 'Stop', '2026-01-01T00:00:07.000Z');
    hookAt(old, 'PreToolUse', '2026-01-01T00:00:03.000Z');
    old.close();
    // Simulate a database written before hook_stat existed (it carried the old index).
    const raw = new Database(file);
    raw.exec(`DROP TABLE hook_stat`);
    raw.exec(`DELETE FROM meta WHERE key = 'hook_stat_ready'`);
    raw.exec(`CREATE INDEX raw_event_hook ON raw_event (event_name, received_at) WHERE source = 'hook'`);
    raw.exec(`CREATE TABLE IF NOT EXISTS hook_stat (event_name TEXT PRIMARY KEY, count INTEGER NOT NULL, last_at TEXT NOT NULL)`);
    // With the old index the backfill query reads only that index, never the raw_event table (and its bodies).
    const plan = (raw.prepare(`EXPLAIN QUERY PLAN ${HOOK_STAT_BACKFILL_SELECT}`).all() as { detail: string }[]).map((r) => r.detail);
    expect(plan.join(' | ')).toContain('raw_event_hook');
    expect(plan.filter((l) => /SCAN raw_event(?! USING)/.test(l))).toEqual([]);
    raw.exec(`DROP TABLE hook_stat`);
    raw.close();
    const sql: string[] = [];
    const logs: string[] = [];
    const s = openStore(file, { verbose: (q) => sql.push(String(q)), log: (l) => logs.push(l) });
    // The backfill ran while the index still existed: the index is dropped only after it.
    const backfillAt = sql.findIndex((q) => q.includes('INSERT INTO hook_stat') && q.includes('GROUP BY event_name'));
    const dropAt = sql.findIndex((q) => /DROP INDEX IF EXISTS raw_event_hook/.test(q));
    expect(backfillAt).toBeGreaterThanOrEqual(0);
    expect(dropAt).toBeGreaterThan(backfillAt);
    expect(logs).toEqual([HOOK_STAT_BACKFILL_NOTICE]);
    try {
      expect(s.hookEventStats()).toEqual([
        { eventName: 'PreToolUse', count: 1, lastAt: '2026-01-01T00:00:03.000Z' },
        { eventName: 'Stop', count: 2, lastAt: '2026-01-01T00:00:07.000Z' },
      ]);
      hookAt(s, 'Stop', '2026-01-01T00:00:01.000Z');
      expect(s.hookEventStats()).toContainEqual({ eventName: 'Stop', count: 3, lastAt: '2026-01-01T00:00:07.000Z' });
    } finally {
      s.close();
    }
    // Reopening does not backfill again (the table is no longer empty), and prints nothing.
    const againLogs: string[] = [];
    const again = openStore(file, { log: (l) => againLogs.push(l) });
    expect(againLogs).toEqual([]);
    try {
      expect(again.hookEventStats()).toContainEqual({ eventName: 'Stop', count: 3, lastAt: '2026-01-01T00:00:07.000Z' });
    } finally {
      again.close();
    }
    const check = new Database(file, { readonly: true });
    const names = (check.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as { name: string }[]).map((r) => r.name);
    check.close();
    expect(names).not.toContain('raw_event_hook');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 10 });
  }
});

test('文件数据库的 WAL 由后台线程检查点，主连接不做自动检查点', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cc-wal-'));
  const file = path.join(dir, 'data.db');
  const s = openStore(file);
  try {
    const big = 'z'.repeat(4000);
    const write = (round: number) => {
      for (let i = 0; i < 3000; i++) s.applyChanges([{ type: 'node_added', node: mkNode(`n${round}-${i}`, 's1'), detail: { output: big } }]);
    };
    write(0);
    const walAfterFirst = (await fsp.stat(`${file}-wal`)).size;
    // No automatic checkpoint on the main connection: the WAL holds all ~12 MB (SQLite's default would cap it near 4 MB).
    expect(walAfterFirst).toBeGreaterThan(8_000_000);
    // The worker checkpoints within a second or two; the WAL is then reused from its start instead of growing.
    await new Promise((r) => setTimeout(r, 2500));
    write(1);
    expect((await fsp.stat(`${file}-wal`)).size).toBeLessThan(walAfterFirst * 1.5);
  } finally {
    s.close();
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 10 });
  }
}, 30_000);

test('WAL 在检查点后被截断到上限，不保留导入时的峰值大小', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cc-wal-limit-'));
  const file = path.join(dir, 'data.db');
  const s = openStore(file, { walSizeLimitBytes: 1_000_000 });
  try {
    const big = 'z'.repeat(4000);
    for (let i = 0; i < 3000; i++) s.applyChanges([{ type: 'node_added', node: mkNode(`n${i}`, 's1'), detail: { output: big } }]);
    expect((await fsp.stat(`${file}-wal`)).size).toBeGreaterThan(8_000_000);
    await new Promise((r) => setTimeout(r, 2500)); // the worker checkpoints
    s.applyChanges([{ type: 'node_added', node: mkNode('last', 's1'), detail: {} }]);
    expect((await fsp.stat(`${file}-wal`)).size).toBeLessThanOrEqual(1_100_000);
  } finally {
    s.close();
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 10 });
  }
}, 30_000);

test('epoch 在建库时生成，重开和 clearDerived 后不变，新库不同', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cc-epoch-'));
  try {
    const s1 = openStore(path.join(dir, 'a.db'));
    const e = s1.epoch();
    expect(e).toMatch(/^[0-9a-f-]{20,}$/);
    s1.clearDerived();
    expect(s1.epoch()).toBe(e);
    s1.close();
    const again = openStore(path.join(dir, 'a.db'));
    expect(again.epoch()).toBe(e);
    again.close();
    const other = openStore(path.join(dir, 'b.db'));
    expect(other.epoch()).not.toBe(e);
    other.close();
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 10 });
  }
});

// ---- searchSessions ----

function seedSession(id: string, over: Partial<Session> = {}): void {
  const base = sessionUpsert(id, 'p1');
  if (base.type !== 'session_upserted') throw new Error('unreachable');
  store.applyChanges([{ type: 'session_upserted', session: { ...base.session, ...over } }]);
}

function seedPrompt(sessionId: string, id: string, summary: string, timestamp: string, agentId: string | null = null): void {
  const node: GraphNode = { ...mkNode(id, sessionId), kind: 'prompt', status: null, toolName: null, summary, timestamp, agentId };
  store.applyChanges([{ type: 'node_added', node, detail: {} }]);
}

test('按标题、分支、目录、会话 id、提示摘要匹配，不区分大小写', () => {
  seedSession('sess-alpha', { title: 'Fix Login Bug', gitBranch: 'feature/Payments', cwd: '/work/Demo-App' });
  seedPrompt('sess-alpha', 'u1', 'please Refactor the cache layer', '2026-01-01T00:00:01.000Z');
  seedSession('other', { title: 'unrelated' });
  const fieldsOf = (q: string) => store.searchSessions(q, 10).map((h) => h.matches.map((m) => m.field));
  expect(fieldsOf('LOGIN')).toEqual([['title']]);
  expect(fieldsOf('payments')).toEqual([['branch']]);
  expect(fieldsOf('demo-app')).toEqual([['cwd']]);
  expect(fieldsOf('SESS-ALPHA')).toEqual([['id']]);
  expect(fieldsOf('refactor')).toEqual([['prompt']]);
  const hit = store.searchSessions('refactor', 10)[0]!;
  expect(hit.session.id).toBe('sess-alpha');
  expect(hit.matches[0]).toEqual({ field: 'prompt', nodeId: 'u1', snippet: 'please Refactor the cache layer' });
  expect(fieldsOf('zzzz')).toEqual([]);
});

test('中文查询可以匹配标题和提示', () => {
  seedSession('c1', { title: '修复登录问题' });
  seedPrompt('c1', 'u1', '请重构缓存层', '2026-01-01T00:00:01.000Z');
  seedSession('c2', { title: '别的会话' });
  expect(store.searchSessions('登录', 10).map((h) => h.session.id)).toEqual(['c1']);
  expect(store.searchSessions('缓存', 10)[0]!.matches).toEqual([{ field: 'prompt', nodeId: 'u1', snippet: '请重构缓存层' }]);
});

test('每个会话最多 3 条匹配，会话字段在前、提示按时间在后', () => {
  seedSession('x-needle', { title: 'needle title', gitBranch: 'needle-branch', cwd: '/needle' });
  seedPrompt('x-needle', 'late', 'needle late', '2026-01-01T00:00:09.000Z');
  expect(store.searchSessions('needle', 10)[0]!.matches.map((m) => m.field)).toEqual(['title', 'id', 'branch']);

  seedSession('y', { title: 'plain' });
  seedPrompt('y', 'p-late', 'needle late', '2026-01-01T00:00:09.000Z');
  seedPrompt('y', 'p-early', 'needle early', '2026-01-01T00:00:02.000Z');
  seedPrompt('y', 'p-mid', 'needle mid', '2026-01-01T00:00:05.000Z');
  seedPrompt('y', 'p-extra', 'needle extra', '2026-01-01T00:00:06.000Z');
  const y = store.searchSessions('needle', 10).find((h) => h.session.id === 'y')!;
  expect(y.matches.map((m) => m.nodeId)).toEqual(['p-early', 'p-mid', 'p-extra']);

  seedSession('z', { title: 'needle z' });
  seedPrompt('z', 'z1', 'needle z prompt', '2026-01-01T00:00:03.000Z');
  seedPrompt('z', 'z0', 'needle z prompt 0', '2026-01-01T00:00:01.000Z');
  seedPrompt('z', 'z2', 'needle z prompt 2', '2026-01-01T00:00:04.000Z');
  const z = store.searchSessions('needle', 10).find((h) => h.session.id === 'z')!;
  expect(z.matches.map((m) => (m.field === 'prompt' ? m.nodeId : m.field))).toEqual(['title', 'z0', 'z1']);
});

test('结果按最近活动时间降序，受 limit 限制', () => {
  seedSession('old', { title: 'topic old', lastActivityAt: '2026-01-01T00:00:00.000Z' });
  seedSession('new', { title: 'topic new', lastActivityAt: '2026-03-01T00:00:00.000Z' });
  seedSession('mid', { title: 'topic mid', lastActivityAt: '2026-02-01T00:00:00.000Z' });
  expect(store.searchSessions('topic', 10).map((h) => h.session.id)).toEqual(['new', 'mid', 'old']);
  expect(store.searchSessions('topic', 2).map((h) => h.session.id)).toEqual(['new', 'mid']);
  expect(store.searchSessions('topic', 0).map((h) => h.session.id)).toEqual(['new']);
  expect(store.searchSessions('topic', 1000)).toHaveLength(3);
});

test.each(['%', '_', '\\', "'", '"', '%_%'])('特殊字符 %s 按字面匹配，不匹配无关会话', (c) => {
  seedSession('s-special', { title: `100%_done\\'"` });
  seedSession('s-plain', { title: 'plain' });
  // The doubled character occurs in neither title; as wildcards or unescaped SQL it would match (or break) both.
  expect(store.searchSessions(c + c, 10)).toEqual([]);
});

test('特殊字符作为字面子串匹配，通配符不当通配符用', () => {
  seedSession('s-special', { title: `100%_done\\'"` });
  seedSession('s-plain', { title: 'plain' });
  for (const q of ['0%', '%_', '_d', 'e\\', "\\'", `'"`, '%_d', `100%_done\\'"`]) {
    expect(store.searchSessions(q, 10).map((h) => h.session.id), q).toEqual(['s-special']);
  }
  for (const q of ['%%', '__', '1%e', '1_0', 'p%n', 'p_ain%']) expect(store.searchSessions(q, 10), q).toEqual([]);
});

test('少于 2 个非空白字符返回空数组；超长查询被截断而不报错', () => {
  seedSession('s1', { title: 'ab title' });
  expect(store.searchSessions('', 10)).toEqual([]);
  expect(store.searchSessions('a', 10)).toEqual([]);
  expect(store.searchSessions('   a   ', 10)).toEqual([]);
  expect(store.searchSessions('登', 10)).toEqual([]);
  expect(store.searchSessions('  ab  ', 10)).toHaveLength(1);
  expect(store.searchSessions('x'.repeat(5000), 10)).toEqual([]);
  // cut to 200 characters: the 200-character prefix matches, the untruncated query would not
  seedSession('s2', { title: 'y'.repeat(200) });
  expect(store.searchSessions('y'.repeat(200) + 'ZZZ', 10).map((h) => h.session.id)).toEqual(['s2']);
});

test('片段不超过 80 字符，截断的一侧带省略号，且包含匹配文本', () => {
  const long = (pre: number, post: number) => `${'a'.repeat(pre)}NEEDLE${'b'.repeat(post)}`;
  seedSession('snip', { title: 'plain' });
  seedPrompt('snip', 'mid', long(60, 60), '2026-01-01T00:00:01.000Z');
  seedPrompt('snip', 'head', long(0, 120), '2026-01-01T00:00:02.000Z');
  seedPrompt('snip', 'tail', long(120, 0), '2026-01-01T00:00:03.000Z');
  const snips: Record<string, string> = Object.fromEntries(store.searchSessions('needle', 10)[0]!.matches.map((m) => [m.nodeId ?? '', m.snippet]));
  for (const s of Object.values(snips)) {
    expect(s.length).toBeLessThanOrEqual(80);
    expect(s).toContain('NEEDLE');
  }
  expect(snips.mid!.startsWith('…') && snips.mid!.endsWith('…')).toBe(true);
  expect(snips.head!.startsWith('…')).toBe(false);
  expect(snips.head!.endsWith('…')).toBe(true);
  expect(snips.tail!.startsWith('…')).toBe(true);
  expect(snips.tail!.endsWith('…')).toBe(false);
  seedSession('short', { title: 'short NEEDLE title' });
  const shortHit = store.searchSessions('needle', 10).find((h) => h.session.id === 'short')!;
  expect(shortHit.matches[0]!.snippet).toBe('short NEEDLE title');
});

test('子代理内部的 prompt 节点不参与检索', () => {
  seedSession('s1', { title: 'plain' });
  seedPrompt('s1', 'sub', 'secret subagent words', '2026-01-01T00:00:01.000Z', 'ag1');
  expect(store.searchSessions('secret', 10)).toEqual([]);
  seedPrompt('s1', 'main', 'secret main words', '2026-01-01T00:00:02.000Z');
  expect(store.searchSessions('secret', 10)[0]!.matches.map((m) => m.nodeId)).toEqual(['main']);
});

test('两条检索语句都走 node_main_prompt 部分索引，不全表扫描 node', () => {
  const plans = store.searchPlans();
  for (const [name, lines] of Object.entries(plans)) {
    const text = lines.join('\n');
    expect(text, name).toContain('node_main_prompt');
    expect(text, name).not.toMatch(/SCAN (node|n)\b/);
  }
});

test('升级：旧的 node_prompt 索引被删除', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { default: Database } = await import('better-sqlite3');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cc-search-idx-'));
  const file = path.join(dir, 'a.db');
  try {
    openStore(file).close();
    const raw = new Database(file);
    raw.exec(`CREATE INDEX node_prompt ON node (session_id) WHERE json_extract(body, '$.kind') = 'prompt'`);
    raw.close();
    openStore(file).close();
    const check = new Database(file, { readonly: true });
    const names = (check.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as { name: string }[]).map((r) => r.name);
    check.close();
    expect(names).toContain('node_main_prompt');
    expect(names).not.toContain('node_prompt');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 10 });
  }
});

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const EMOJI = '\u{1F600}';

test('查询按码点截断：200 字符的切口不会劈开代理对', () => {
  // 199 ASCII + emoji = exactly 200 code points (201 UTF-16 units): a unit-based cut would split the pair
  const title = 'a'.repeat(199) + EMOJI;
  seedSession('emo', { title });
  const hits = store.searchSessions(title + 'ZZZ', 10);
  expect(hits.map((h) => h.session.id)).toEqual(['emo']);
  for (const m of hits[0]!.matches) expect(m.snippet).not.toMatch(LONE_SURROGATE);
  expect(() => store.searchSessions(EMOJI.repeat(150), 10)).not.toThrow();
});

test('片段窗口不劈开代理对', () => {
  seedSession('emo2', { title: 'plain' });
  [60, 61, 62].forEach((pre, i) => {
    seedPrompt('emo2', `p${i}`, `${EMOJI.repeat(pre)}NEEDLE${EMOJI.repeat(60)}`.slice(0, 200), `2026-01-01T00:00:0${i}.000Z`);
  });
  const matches = store.searchSessions('needle', 10)[0]!.matches;
  expect(matches).toHaveLength(3);
  for (const m of matches) {
    expect(m.snippet).not.toMatch(LONE_SURROGATE);
    expect(m.snippet).toContain('NEEDLE');
    expect(Array.from(m.snippet).length).toBeLessThanOrEqual(80);
  }
});

test('新建的数据库打开时不回填、不打印', () => {
  const logs: string[] = [];
  const s = openStore(':memory:', { log: (l) => logs.push(l) });
  s.close();
  expect(logs).toEqual([]);
});
