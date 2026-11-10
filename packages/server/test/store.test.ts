import { beforeEach, afterEach, expect, test } from 'vitest';
import type { Change, GraphNode, Session, SessionStatus } from '@claude-canvas/shared';
import { openStore, type Store } from '../src/store/store.js';

let store: Store;
beforeEach(() => {
  store = openStore(':memory:');
});
afterEach(() => {
  store.close();
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
