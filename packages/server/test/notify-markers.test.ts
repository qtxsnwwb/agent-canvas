/**
 * The error / interrupt markers the notification engine relies on, as the real normalizers emit them: each raw event is
 * one batch of the change stream, the clock follows the records' times.
 */
import { expect, test } from 'vitest';
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationKind } from '@agent-canvas/shared';
import { CodexNormalizer } from '../src/normalize/codex.js';
import { Normalizer } from '../src/normalize/normalizer.js';
import type { AgentNormalizer } from '../src/normalize/types.js';
import { NotificationEngine } from '../src/notify/engine.js';
import type { RawEvent } from '../src/store/store.js';
import { CodexThread } from './codex-fixtures.js';
import { assistantBlock, userPrompt } from './fixtures.js';

function feed(n: AgentNormalizer, events: RawEvent[]): NotificationKind[] {
  let now = 0;
  const engine = new NotificationEngine({
    now: () => now,
    // Every turn counts: without a marker a turn would come out as "finished".
    settings: () => ({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true, finishedMinSeconds: 0 }),
    suppressed: () => false,
    projectName: () => 'p',
    sessionUrl: (id) => id,
  });
  const kinds: NotificationKind[] = [];
  for (const ev of events) {
    if (ev.source === 'transcript') now = Date.parse((JSON.parse(ev.line) as { timestamp: string }).timestamp) + 500;
    kinds.push(...engine.handleChanges(n.apply(ev, 'p1').changes).map((x) => x.kind));
  }
  return kinds;
}

test('Claude Code：用户中断一轮（interrupt 系统节点）→ 出错中断', () => {
  const kinds = feed(new Normalizer(), [
    userPrompt('u1', null, 'go'),
    assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'sleep 100' } }),
    userPrompt('u2', 'a1', '[Request interrupted by user for tool use]'),
  ]);
  expect(kinds).toEqual(['error']);
});

test('Claude Code：正常结束的一轮 → 跑完了（对照）', () => {
  const kinds = feed(new Normalizer(), [
    userPrompt('u1', null, 'go'),
    assistantBlock('a1', 'u1', { type: 'text', text: 'done' }, { stopReason: 'end_turn' }),
    userPrompt('u2', 'a1', 'next'),
  ]);
  expect(kinds).toEqual(['finished']);
});

test('Codex：失败的轮次（task_complete 带 error）→ 出错中断', () => {
  const root = new CodexThread({ id: 'c-fail' });
  const kinds = feed(new CodexNormalizer(), [root.meta(), root.started('t1'), root.user('u1', 'x'), root.complete('boom')]);
  expect(kinds).toEqual(['error']);
});

test('Codex：被中止的轮次（turn_aborted）→ 出错中断', () => {
  const root = new CodexThread({ id: 'c-abort' });
  const kinds = feed(new CodexNormalizer(), [root.meta(), root.started('t1'), root.user('u1', 'x'), root.aborted()]);
  expect(kinds).toEqual(['error']);
});

test('Codex：正常完成 → 跑完了（对照）', () => {
  const root = new CodexThread({ id: 'c-ok' });
  const kinds = feed(new CodexNormalizer(), [root.meta(), root.started('t1'), root.user('u1', 'x'), root.complete()]);
  expect(kinds).toEqual(['finished']);
});
