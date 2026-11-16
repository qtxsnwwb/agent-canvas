import { expect, test } from 'vitest';
import type { Diagnostics } from '@agent-canvas/shared';
import {
  cursorUnknownRecords, fileSourceBlocks, fileSourceDirLine, foreignHooksLine, hooksByOrigin, originUnknownRecords,
} from '../src/diagnostics';
import { createPageMasker, maskDiagnostics } from '../src/masking';

const base: Diagnostics = {
  unknownRecords: [],
  lastHookAt: null,
  hookEvents: [],
  files: [],
  ingestFailures: [],
  importing: false,
  normalizerVersion: 1,
  dbEpoch: 'e',
  codex: { sessionsDir: null, sessionsDirExists: false },
  cursor: { dbPath: null, dbExists: false, lastPollAt: null, lastError: null },
};
const off = { dir: null, present: false, reading: false, sessionCount: 0 };
const rec = (recordType: string, count = 1) => ({ recordType, count, sample: '' });

test('originUnknownRecords：按来源前缀分开，互不混入，也不混入 Cursor 的', () => {
  const d: Diagnostics = {
    ...base,
    unknownRecords: [rec('gemini:part.video', 2), rec('grok:rewind_v2'), rec('copilot:session.snapshot_rewind', 3), rec('cursor:x'), rec('bubble:y'), rec('summary')],
  };
  expect(originUnknownRecords(d, 'gemini').map((r) => r.recordType)).toEqual(['gemini:part.video']);
  expect(originUnknownRecords(d, 'grok').map((r) => r.recordType)).toEqual(['grok:rewind_v2']);
  expect(originUnknownRecords(d, 'copilot').map((r) => [r.recordType, r.count])).toEqual([['copilot:session.snapshot_rewind', 3]]);
  expect(cursorUnknownRecords(d).map((r) => r.recordType)).toEqual(['cursor:x', 'bubble:y']);
  // A type that only starts like an origin name is not that origin's.
  expect(originUnknownRecords({ ...base, unknownRecords: [rec('geminiX:a'), rec('grokker')] }, 'gemini')).toEqual([]);
});

test('fileSourceBlocks：目录存在、有会话或有未识别记录时才显示；只配置了默认目录不显示', () => {
  expect(fileSourceBlocks(base)).toEqual([]);
  const configuredOnly: Diagnostics = { ...base, sources: { gemini: { dir: '/h/.gemini/tmp', present: false, reading: false, sessionCount: 0 }, grok: off, copilot: off } };
  expect(fileSourceBlocks(configuredOnly)).toEqual([]);
  const d: Diagnostics = {
    ...base,
    unknownRecords: [rec('copilot:x')],
    sources: {
      gemini: { dir: '/h/.gemini/tmp', present: true, reading: true, sessionCount: 0 },
      grok: { dir: '/h/.grok/sessions', present: false, reading: false, sessionCount: 2 },
      copilot: { dir: null, present: false, reading: false, sessionCount: 0 },
    },
  };
  expect(fileSourceBlocks(d).map((b) => [b.origin, b.sessionCount, b.unknown.length])).toEqual([['gemini', 0, 0], ['grok', 2, 0], ['copilot', 0, 1]]);
});

test('fileSourceDirLine：存在 / 不存在 / 未启用', () => {
  expect(fileSourceDirLine('gemini', { dir: '/h/.gemini/tmp', present: true, reading: true, sessionCount: 1 })).toBe('Gemini CLI 会话目录：/h/.gemini/tmp（存在）');
  expect(fileSourceDirLine('grok', { dir: '/h/.grok/sessions', present: false, reading: false, sessionCount: 3 }))
    .toBe('Grok 会话目录：/h/.grok/sessions（不存在。目录出现后要重启服务才会读取）');
  expect(fileSourceDirLine('copilot', off)).toBe('Copilot CLI 会话目录：未启用');
  // Final review M-2: the directory appeared after the service started, so its source does not exist yet.
  expect(fileSourceDirLine('copilot', { dir: '/h/.copilot/session-state', present: true, reading: false, sessionCount: 0 }))
    .toBe('Copilot CLI 会话目录：/h/.copilot/session-state（存在，但服务启动时还没有这个目录，尚未读取。重启服务后读取）');
  // A block appears for it (present), so the hint is seen.
  const appeared: Diagnostics = { ...base, sources: { gemini: off, grok: off, copilot: { dir: '/h/.copilot/session-state', present: true, reading: false, sessionCount: 0 } } };
  expect(fileSourceBlocks(appeared).map((b) => b.origin)).toEqual(['copilot']);
});

test('foreignHooksLine：旧服务端不显示；0 次和多次都说明是什么', () => {
  expect(foreignHooksLine(undefined)).toBeNull();
  expect(foreignHooksLine(0)).toEqual({ text: '被丢弃的外来 hook 调用：0 次', warn: false });
  const many = foreignHooksLine(4)!;
  expect(many.warn).toBe(true);
  expect(many.text).toContain('4 次');
  expect(many.text).toContain('Grok');
  expect(many.text).toContain('Copilot CLI');
});

test('新来源没有 hook，不进 hooks 一节', () => {
  const d: Diagnostics = { ...base, sources: { gemini: { dir: '/g', present: true, reading: true, sessionCount: 1 }, grok: { dir: '/k', present: true, reading: true, sessionCount: 1 }, copilot: { dir: '/c', present: true, reading: true, sessionCount: 1 } } };
  expect(hooksByOrigin(d).map((h) => h.origin)).toEqual(['claude']);
});

test('遮蔽开关打开时，来源目录也被遮蔽', () => {
  const m = createPageMasker({ customTerms: ['dev42'], numbered: true });
  const d: Diagnostics = { ...base, sources: { gemini: { dir: '/home/dev42/.gemini/tmp', present: true, reading: true, sessionCount: 1 }, grok: off, copilot: off } };
  const out = maskDiagnostics(d, m);
  expect(out.sources?.gemini.dir).not.toContain('dev42');
  expect(out.sources?.gemini).toMatchObject({ present: true, reading: true, sessionCount: 1 });
  expect(out.sources?.grok).toEqual(off);
});
