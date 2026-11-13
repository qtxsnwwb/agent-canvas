import { expect, test } from 'vitest';
import { nodeAddressHash } from '@agent-canvas/shared';
import { parseHash, sessionFileHash, sessionNodeHash } from '../src/route';
import { nextNodeTarget, nodeJumpAction } from '../src/nodeJump';

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
