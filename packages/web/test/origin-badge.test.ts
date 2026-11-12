import { expect, test } from 'vitest';
import { ORIGINS } from '@agent-canvas/shared';
import { ORIGIN_MARKS } from '../src/OriginBadge';

test('每个来源都用产品自己的标志：三个都有路径数据，且互不相同', () => {
  const paths = new Set<string>();
  for (const origin of ORIGINS) {
    const mark = ORIGIN_MARKS[origin];
    expect(mark.viewBox).toBe('0 0 24 24');
    expect(mark.path.length).toBeGreaterThan(50);
    // Path data only: nothing but SVG path commands and numbers.
    expect(mark.path).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]+$/);
    paths.add(mark.path);
  }
  expect(paths.size).toBe(ORIGINS.length);
});
