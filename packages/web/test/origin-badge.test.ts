import { expect, test } from 'vitest';
import { ORIGINS } from '@agent-canvas/shared';
import { ORIGIN_MARKS } from '../src/OriginBadge';

test('每个来源都有一个标记定义：Claude Code 和 Cursor 用产品自己的标志，Codex 用中性的图形', () => {
  for (const origin of ORIGINS) expect(origin in ORIGIN_MARKS).toBe(true);
  for (const origin of ['claude', 'cursor'] as const) {
    const mark = ORIGIN_MARKS[origin];
    expect(mark).not.toBeNull();
    expect(mark!.viewBox).toBe('0 0 24 24');
    expect(mark!.path.length).toBeGreaterThan(50);
    expect(mark!.path).toMatch(/^[Mm]/);
  }
  expect(ORIGIN_MARKS.claude!.path).not.toBe(ORIGIN_MARKS.cursor!.path);
  expect(ORIGIN_MARKS.codex).toBeNull();
});
