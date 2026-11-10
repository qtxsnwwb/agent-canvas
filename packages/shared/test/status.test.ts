import { expect, test } from 'vitest';
import { STALE_AFTER_MS, effectiveStatus, type SessionStatus } from '../src/index.js';

const at = Date.parse('2026-05-01T12:00:00.000Z');
const s = (status: SessionStatus, agoMs: number) => ({ status, lastActivityAt: new Date(at - agoMs).toISOString() });

test('STALE_AFTER_MS 是 15 分钟', () => {
  expect(STALE_AFTER_MS).toBe(15 * 60_000);
});

test('长时间无活动的 running 显示为 stale', () => {
  expect(effectiveStatus(s('running', STALE_AFTER_MS + 1), at)).toBe('stale');
  expect(effectiveStatus(s('running', STALE_AFTER_MS), at)).toBe('running');
  expect(effectiveStatus(s('running', 1000), at)).toBe('running');
});

test.each<SessionStatus>(['awaiting_permission', 'awaiting_input', 'idle', 'ended'])('%s 不会被降级', (status) => {
  expect(effectiveStatus(s(status, 10 * STALE_AFTER_MS), at)).toBe(status);
});
