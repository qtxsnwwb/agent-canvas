import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import type { Change, GraphNode, Session, SessionStatus } from '@claude-canvas/shared';
import { CHANGE_LOG_MAX_ROWS, openStore, type Store } from '../src/store/store.js';

let store: Store;
beforeEach(() => {
  store = openStore(':memory:');
});
afterEach(() => {
  store.close();
  vi.useRealTimers();
});

function sessionUpsert(id: string, projectId: string, status: SessionStatus = 'idle'): Change {
  const session: Session = {
    id,
    projectId,
    cwd: null,
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
  expect(store.listProjects()).toEqual(expect.arrayContaining([
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
  expect(store.listProjects()[0]).toMatchObject({ sessionCount: 3, activeSessionCount: 3 });
  vi.setSystemTime(new Date('2026-01-01T00:15:01.000Z'));
  expect(store.listProjects()[0]).toMatchObject({ sessionCount: 3, activeSessionCount: 2 });
  vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
  expect(store.listProjects()[0]).toMatchObject({ activeSessionCount: 2 });
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
