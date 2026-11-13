import { expect, test } from 'vitest';
import { DETAIL_NO_STORED_NOTE, DETAIL_UNREADABLE_NOTE, exportCutNote, stepDetailNote } from '../src/canvas/detail';
import { snapshotClock, waterfallClock } from '../src/canvas/waterfall';

test('snapshotClock：快照里什么都不在进行，开着的步骤停在最后活动的时间', () => {
  const last = '2026-11-13T08:00:00.000Z';
  for (const status of ['running', 'awaiting_permission', 'awaiting_input', 'idle', 'ended'] as const) {
    const c = snapshotClock({ status, lastActivityAt: last });
    expect(c).toEqual({ nowMs: Date.parse(last), ticking: false, backgroundNowMs: Date.parse(last), backgroundTicking: false });
  }
  // The live clock of a running session ticks (for contrast).
  expect(waterfallClock({ status: 'running', lastActivityAt: last }, Date.parse(last) + 1000).ticking).toBe(true);
});

test('snapshotClock：最后活动时间无法解析时用 0', () => {
  expect(snapshotClock({ status: 'running', lastActivityAt: 'x' }).nowMs).toBe(0);
});

test('stepDetailNote：没有保存详情、详情已损坏、无内容', () => {
  expect(stepDetailNote(null, 0)).toBe(DETAIL_NO_STORED_NOTE);
  expect(stepDetailNote({ nodeId: 'a', input: null, output: null, text: null, raw: null, unreadable: true }, 0)).toBe(DETAIL_UNREADABLE_NOTE);
  expect(stepDetailNote({ nodeId: 'a', input: null, output: null, text: null, raw: null }, 0)).toBe('无内容');
  expect(stepDetailNote({ nodeId: 'a', input: null, output: 'x', text: null, raw: null }, 1)).toBeNull();
});

test('exportCutNote：导出时截断的输出标明原始大小（KB 向上取整）', () => {
  expect(exportCutNote(null)).toBeNull();
  expect(exportCutNote(8193)).toBe('（导出时已截断，原始 9 KB）');
  expect(exportCutNote(1024)).toBe('（导出时已截断，原始 1 KB）');
  expect(exportCutNote(1)).toBe('（导出时已截断，原始 1 KB）');
});
