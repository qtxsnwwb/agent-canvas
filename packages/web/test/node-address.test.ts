import { expect, test } from 'vitest';
import { nodeAddressHash } from '@agent-canvas/shared';
import { parseHash, sessionFileHash, sessionNodeHash } from '../src/route';
import { nearestTurnNode, nextNodeTarget, nodeJumpAction } from '../src/nodeJump';
import { mkNode } from './helpers';

const ids = [
  'bubble:6f1c2a9e-0b1d-4c8e-9a77-1234567890ab:0a0b0c0d-1111-2222-3333-444455556666',
  'toolu_01AbCdEfGh',
  'item:call_9/x',
  'call_AbC123',
  'a#b',
  '100%',
  '%E4%ZZ',
  'with space',
  '中文:节点/一 #1',
  '/n/x',
  '/f/x',
  'emoji-😀',
];

test('sessionNodeHash 与 parseHash 往返', () => {
  for (const id of ids) {
    const hash = sessionNodeHash('s/1 #x', id);
    expect(hash.slice(1).split('/').length).toBe(5); // '', 's', id, 'n', nodeId: nothing unescaped inside
    expect(parseHash(hash)).toStrictEqual({ page: 'session', sessionId: 's/1 #x', nodeId: id });
  }
});

test('#/s/<id>/n/<node> 的具体写法', () => {
  expect(sessionNodeHash('abc', 'bubble:u1:u2')).toBe('#/s/abc/n/bubble%3Au1%3Au2');
  expect(parseHash('#/s/abc/n/toolu_01')).toStrictEqual({ page: 'session', sessionId: 'abc', nodeId: 'toolu_01' });
});

test('编码坏掉或为空的节点 id 退回普通会话页', () => {
  expect(parseHash('#/s/abc/n/%E4%ZZ')).toStrictEqual({ page: 'session', sessionId: 'abc' });
  expect(parseHash('#/s/abc/n/100%')).toStrictEqual({ page: 'session', sessionId: 'abc' });
  expect(parseHash('#/s/abc/n/')).toStrictEqual({ page: 'session', sessionId: 'abc' });
  expect(parseHash('#/s/%ZZ/n/a')).toEqual({ page: 'home', projectId: null });
});

test('一个会话地址最多带 /f/ 或 /n/ 之一：先出现的那个算，其余是它的值', () => {
  expect(parseHash('#/s/abc/f/D:/n/a.ts')).toStrictEqual({ page: 'session', sessionId: 'abc', filePath: 'D:/n/a.ts' });
  expect(parseHash('#/s/abc/n/x/f/y')).toStrictEqual({ page: 'session', sessionId: 'abc', nodeId: 'x/f/y' });
  const f = parseHash(sessionFileHash('abc', 'D:/a.ts'));
  expect(f).toStrictEqual({ page: 'session', sessionId: 'abc', filePath: 'D:/a.ts' });
  expect('nodeId' in f).toBe(false);
});

test('nextNodeTarget：新节点序号加一，同一个节点保持原对象，没有节点清空', () => {
  const a = nextNodeTarget(null, 'n1');
  expect(a).toEqual({ id: 'n1', seq: 1 });
  expect(nextNodeTarget(a, 'n1')).toBe(a);
  const b = nextNodeTarget(a, 'n2');
  expect(b).toEqual({ id: 'n2', seq: 2 });
  expect(nextNodeTarget(b, null)).toBeNull();
  expect(nextNodeTarget(b, 'n1')).toEqual({ id: 'n1', seq: 3 });
});

test('nodeJumpAction：没有目标或已处理过不动；没准备好等；没有这个节点提示；有就定位', () => {
  const has = (id: string): boolean => id === 'n1';
  expect(nodeJumpAction(null, 0, true, has)).toBe('idle');
  expect(nodeJumpAction({ id: 'n1', seq: 1 }, 1, true, has)).toBe('idle');
  expect(nodeJumpAction({ id: 'n1', seq: 1 }, 0, false, has)).toBe('wait');
  expect(nodeJumpAction({ id: 'zz', seq: 1 }, 0, true, has)).toBe('missing');
  expect(nodeJumpAction({ id: 'n1', seq: 1 }, 0, true, has)).toBe('show');
  expect(nodeJumpAction({ id: 'n1', seq: 2 }, 1, true, has)).toBe('show');
});

test('通知用的节点地址（shared nodeAddressHash）与 sessionNodeHash 一致', () => {
  for (const id of ids) expect(nodeAddressHash('s/1 #x', id)).toBe(sessionNodeHash('s/1 #x', id));
});

// ---- a bookmarked step that is gone: the turn nearest its time ----

test('nearestTurnNode：取时间之前（含）最后开始的主线程那一轮的第一个节点，早于所有轮时取第一轮；没有时间或没有轮为 null', () => {
  const node = (id: string, ts: string, turnId: string | null, agentId: string | null = null) => ({ ...mkNode(id, ts), turnId, agentId });
  const nodes = [
    node('t1-a', '2026-11-22T10:00:00.000Z', 't1'),
    node('t1-b', '2026-11-22T10:05:00.000Z', 't1'),
    node('t2-a', '2026-11-22T11:00:00.000Z', 't2'),
    node('t2-b', '2026-11-22T11:30:00.000Z', null), // belongs to t2 by time
    node('agent-x', '2026-11-22T10:30:00.000Z', 't9', 'agent-1'), // a subagent's step: not a main turn
    node('t3-a', '2026-11-22T12:00:00.000Z', 't3'),
  ];
  expect(nearestTurnNode(nodes, '2026-11-22T11:40:00.000Z')).toBe('t2-a');
  expect(nearestTurnNode(nodes, '2026-11-22T11:00:00.000Z')).toBe('t2-a'); // starting exactly then counts
  expect(nearestTurnNode(nodes, '2026-11-22T10:30:00.000Z')).toBe('t1-a');
  expect(nearestTurnNode(nodes, '2026-11-23T00:00:00.000Z')).toBe('t3-a');
  expect(nearestTurnNode(nodes, '2026-11-21T00:00:00.000Z')).toBe('t1-a'); // before every turn: the first
  expect(nearestTurnNode(nodes, null)).toBeNull();
  expect(nearestTurnNode(nodes, 'not a time')).toBeNull();
  expect(nearestTurnNode([], '2026-11-22T11:00:00.000Z')).toBeNull();
  expect(nearestTurnNode([node('agent-only', '2026-11-22T10:00:00.000Z', 't1', 'agent-1')], '2026-11-22T11:00:00.000Z')).toBeNull();
});
