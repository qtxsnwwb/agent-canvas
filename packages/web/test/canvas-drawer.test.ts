import { expect, test } from 'vitest';
import { DETAIL_MAX_CHARS, detailSections } from '../src/canvas/Drawer';

test('只返回有内容的段，顺序固定', () => {
  expect(detailSections({ nodeId: 'n', input: { a: 1 }, output: 'ok', text: null, raw: null }).map((s) => s.label)).toEqual(['入参', '输出']);
  expect(detailSections({ nodeId: 'n', input: 1, output: 2, text: 't', raw: 3 }).map((s) => s.label)).toEqual(['文本', '入参', '输出', '原始记录']);
});
test('字符串原样，对象缩进两格', () => {
  const [i, o] = detailSections({ nodeId: 'n', input: { a: 1 }, output: 'line1\nline2', text: null, raw: null });
  expect(i!.body).toBe('{\n  "a": 1\n}');
  expect(o!.body).toBe('line1\nline2');
});
test('超长内容截断并标记', () => {
  const [t] = detailSections({ nodeId: 'n', input: null, output: null, text: 'x'.repeat(DETAIL_MAX_CHARS + 5), raw: null });
  expect(t).toMatchObject({ truncated: true });
  expect(t!.body.length).toBe(DETAIL_MAX_CHARS);
});
test('空字符串、null、undefined 都算没有内容', () => {
  expect(detailSections({ nodeId: 'n', input: undefined, output: '', text: null, raw: null })).toEqual([]);
});
