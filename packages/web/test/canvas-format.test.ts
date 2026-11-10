import { expect, test } from 'vitest';
import { chainAriaLabel, formatDuration, isActivationKey, nodeAriaLabel } from '../src/canvas/format';

test.each([[850, '850ms'], [3400, '3.4s'], [59999, '60.0s'], [125000, '2分05秒'], [-1, ''], [Number.NaN, '']])('formatDuration(%s)', (ms, s) => {
  expect(formatDuration(ms)).toBe(s);
});

test('isActivationKey：只有 Enter 和空格', () => {
  expect(isActivationKey('Enter')).toBe(true);
  expect(isActivationKey(' ')).toBe(true);
  expect(isActivationKey('Spacebar')).toBe(true);
  expect(isActivationKey('Escape')).toBe(false);
  expect(isActivationKey('a')).toBe(false);
});

test('nodeAriaLabel：类型、标题、状态，跳过空的部分', () => {
  expect(nodeAriaLabel(['工具', 'Bash', '执行中'])).toBe('工具：Bash，执行中');
  expect(nodeAriaLabel(['回复', '', null])).toBe('回复');
  expect(nodeAriaLabel(['提示', '  ', '成功'])).toBe('提示：成功');
});

test('chainAriaLabel：在推理链上的节点追加说明，其余不变', () => {
  expect(chainAriaLabel('工具：Bash', true)).toBe('工具：Bash，在推理链上');
  expect(chainAriaLabel('工具：Bash', false)).toBe('工具：Bash');
});
