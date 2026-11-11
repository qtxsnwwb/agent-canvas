import { expect, test } from 'vitest';
import { STALE_AFTER_MS, type Session } from '@claude-canvas/shared';
import { SESSION_STATUS_LABEL, sessionStatusView } from '../src/labels';

const session = (over: Partial<Session>): Session => ({
  id: 's1', projectId: 'p1', origin: 'claude', cwd: null, title: null, gitBranch: null, status: 'running',
  sourceDeleted: false, startedAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z', ...over,
});

test('stale 的标签是 长时间无活动', () => {
  expect(SESSION_STATUS_LABEL.stale).toBe('长时间无活动');
});

test('sessionStatusView 按当前时间给出有效状态和标签', () => {
  const t = Date.parse('2026-01-01T00:00:00.000Z');
  expect(sessionStatusView(session({}), t + 1000)).toEqual({ status: 'running', label: '运行中' });
  expect(sessionStatusView(session({}), t + STALE_AFTER_MS + 1)).toEqual({ status: 'stale', label: '长时间无活动' });
  expect(sessionStatusView(session({ status: 'awaiting_input' }), t + 10 * STALE_AFTER_MS)).toEqual({ status: 'awaiting_input', label: '等待输入' });
});
