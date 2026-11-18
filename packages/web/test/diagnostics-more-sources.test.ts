import { expect, test } from 'vitest';
import type { Diagnostics } from '@agent-canvas/shared';
import {
  cursorUnknownRecords, fileSourceBlocks, fileSourceDetailLines, fileSourceDirLine, foreignHooksLine, hooksByOrigin, originUnknownRecords,
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
/** The four origins of plan more-sources-cn, not configured. */
const newOff = { deepseek: off, workbuddy: off, codebuddy: off, doubao: off, qwen: off };
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
  const configuredOnly: Diagnostics = { ...base, sources: { gemini: { dir: '/h/.gemini/tmp', present: false, reading: false, sessionCount: 0 }, grok: off, copilot: off, ...newOff } };
  expect(fileSourceBlocks(configuredOnly)).toEqual([]);
  const d: Diagnostics = {
    ...base,
    unknownRecords: [rec('copilot:x')],
    sources: {
      gemini: { dir: '/h/.gemini/tmp', present: true, reading: true, sessionCount: 0 },
      grok: { dir: '/h/.grok/sessions', present: false, reading: false, sessionCount: 2 },
      copilot: { dir: null, present: false, reading: false, sessionCount: 0 },
      ...newOff,
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
  const appeared: Diagnostics = { ...base, sources: { gemini: off, grok: off, copilot: { dir: '/h/.copilot/session-state', present: true, reading: false, sessionCount: 0 }, ...newOff } };
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
  const d: Diagnostics = { ...base, sources: { gemini: { dir: '/g', present: true, reading: true, sessionCount: 1 }, grok: { dir: '/k', present: true, reading: true, sessionCount: 1 }, copilot: { dir: '/c', present: true, reading: true, sessionCount: 1 }, ...newOff } };
  expect(hooksByOrigin(d).map((h) => h.origin)).toEqual(['claude']);
});

test('遮蔽开关打开时，来源目录也被遮蔽', () => {
  const m = createPageMasker({ customTerms: ['dev42'], numbered: true });
  const d: Diagnostics = { ...base, sources: { gemini: { dir: '/home/dev42/.gemini/tmp', present: true, reading: true, sessionCount: 1 }, grok: off, copilot: off, ...newOff } };
  const out = maskDiagnostics(d, m);
  expect(out.sources?.gemini.dir).not.toContain('dev42');
  expect(out.sources?.gemini).toMatchObject({ present: true, reading: true, sessionCount: 1 });
  expect(out.sources?.grok).toEqual(off);
});

test('四个新来源（DeepSeek、WorkBuddy、CodeBuddy、豆包）：没有 hook；有会话才显示块；名称', () => {
  const d: Diagnostics = { ...base, sources: { gemini: off, grok: off, copilot: off, ...newOff, workbuddy: { dir: '/h/.workbuddy/projects', present: true, reading: true, sessionCount: 2 } } };
  expect(hooksByOrigin(d).map((h) => h.origin)).toEqual(['claude']);
  expect(fileSourceBlocks(d).map((b) => b.origin)).toEqual(['workbuddy']);
  expect(fileSourceDirLine('doubao', off)).toBe('豆包 会话目录：未启用');
  expect(fileSourceDirLine('deepseek', { dir: '/h/.dsh/sessions', present: true, reading: true, sessionCount: 1 })).toBe('DeepSeek 会话目录：/h/.dsh/sessions（存在）');
});

test('遮蔽：多个根的目录也被遮蔽；旧服务端没有的来源不补出来', () => {
  const m = createPageMasker({ customTerms: ['dev42'], numbered: true });
  const roots = [{ dir: '/home/dev42/.workbuddy/projects', present: true }, { dir: '/home/dev42/.workbuddy-ai/projects', present: false }];
  const d: Diagnostics = { ...base, sources: { gemini: off, grok: off, copilot: off, ...newOff, workbuddy: { dir: roots[0]!.dir, present: true, reading: true, sessionCount: 1, dirs: roots } } };
  const out = maskDiagnostics(d, m);
  expect(out.sources?.workbuddy.dir).not.toContain('dev42');
  expect(out.sources?.workbuddy.dirs?.map((r) => r.dir.includes('dev42'))).toEqual([false, false]);
  expect(out.sources?.workbuddy.dirs?.map((r) => r.present)).toEqual([true, false]);
  const old = { ...base, sources: { gemini: off, grok: off, copilot: off } } as unknown as Diagnostics;
  expect(Object.keys(maskDiagnostics(old, m).sources ?? {})).toEqual(['gemini', 'grok', 'copilot']);
});

test('四个新来源的附加行：每个读取的目录、运行环境不支持、旧格式、重复会话、按修改时间、没有主代理；没有的字段不出行', () => {
  // The three older sources send none of the new fields: no extra line, as before.
  expect(fileSourceDetailLines({ dir: '/h/.gemini/tmp', present: true, reading: true, sessionCount: 1 })).toEqual([]);
  // WorkBuddy with its two default roots, one present; two sessions found in both.
  const wb = { dir: '/h/.workbuddy/projects', present: true, reading: true, sessionCount: 3, duplicateSessions: 2, dirs: [{ dir: '/h/.workbuddy/projects', present: true }, { dir: '/h/.workbuddy-ai/projects', present: false }] };
  expect(fileSourceDetailLines(wb)).toEqual([
    { text: '读取的目录 1：/h/.workbuddy/projects（存在）', warn: false },
    { text: '读取的目录 2：/h/.workbuddy-ai/projects（不存在）', warn: false },
    { text: '在另一个目录或配置里重复出现、只读了一份的会话：2 个', warn: false },
  ]);
  // DeepSeek: directories with only an unsupported format version; zero is shown too (the source reports it).
  expect(fileSourceDetailLines({ dir: '/h/.dsh/sessions', present: true, reading: true, sessionCount: 1, legacyFiles: 3 })).toEqual([
    { text: '有其他格式版本文件（不读）的会话目录：3 个。只读第 4 版的 session.v4.jsonl.zstd', warn: true },
  ]);
  expect(fileSourceDetailLines({ dir: '/h/.dsh/sessions', present: true, reading: true, sessionCount: 1, legacyFiles: 0 })).toEqual([
    { text: '有其他格式版本文件（不读）的会话目录：0 个。只读第 4 版的 session.v4.jsonl.zstd', warn: false },
  ]);
  // DeepSeek on a Node without zstd: the reason, as a warning.
  expect(fileSourceDetailLines({ dir: '/h/.dsh/sessions', present: true, reading: false, sessionCount: 0, unavailable: '需要 Node 22.15 或更高' })).toEqual([
    { text: '无法读取：需要 Node 22.15 或更高', warn: true },
  ]);
  // Doubao: every count it reports.
  const db = { dir: '/h/AppData/Local/DoubaoWork/User Data', present: true, reading: true, sessionCount: 4, duplicateSessions: 0, unknownSessions: 1, mtimeFallbacks: 2 };
  expect(fileSourceDetailLines(db)).toEqual([
    { text: '在另一个目录或配置里重复出现、只读了一份的会话：0 个', warn: false },
    { text: '时间只能取自文件修改时间的线程：2 个', warn: true },
    { text: '没有主代理或有多个主代理、没有读取的对话：1 个', warn: true },
  ]);
});

test('Qwen Code：托管会话（不读）的个数有时出一行警告；为 0 或服务端没发时不出行', () => {
  const q = { dir: '/h/.qwen/projects', present: true, reading: true, sessionCount: 5 };
  expect(fileSourceDetailLines({ ...q, unsupportedSessions: 2 })).toEqual([
    { text: '托管会话（格式不支持，没有读取）：2 个', warn: true },
  ]);
  expect(fileSourceDetailLines({ ...q, unsupportedSessions: 0 })).toEqual([]);
  expect(fileSourceDetailLines(q)).toEqual([]);
  expect(fileSourceDirLine('qwen', q)).toBe('Qwen Code 会话目录：/h/.qwen/projects（存在）');
  // The block is shown once the directory exists, after 豆包 (ORIGINS order).
  const d: Diagnostics = { ...base, sources: { gemini: off, grok: off, copilot: off, ...newOff, doubao: { ...off, present: true, dir: '/h/d' }, qwen: { ...q, unsupportedSessions: 1 } } };
  expect(fileSourceBlocks(d).map((b) => b.origin)).toEqual(['doubao', 'qwen']);
  expect(fileSourceBlocks(d)[1]).toMatchObject({ unsupportedSessions: 1, sessionCount: 5 });
});

test('DeepSeek 在不支持解压的 Node 上：目录行说明原因，不说“启动后才出现”', () => {
  const s = { dir: '/h/.dsh/sessions', present: true, reading: false, sessionCount: 0, unavailable: '需要 Node 22.15 或更高' };
  // The reason is said once, in the warning line below it (Task 8 review M4).
  expect(fileSourceDirLine('deepseek', s)).toBe('DeepSeek 会话目录：/h/.dsh/sessions（存在，但无法读取，原因见下）');
  const all = [fileSourceDirLine('deepseek', s), ...fileSourceDetailLines(s).map((l) => l.text)].join(' | ');
  expect(all.split('需要 Node 22.15 或更高')).toHaveLength(2);
  const d: Diagnostics = { ...base, sources: { gemini: off, grok: off, copilot: off, ...newOff, deepseek: s } };
  expect(fileSourceBlocks(d).map((b) => b.origin)).toEqual(['deepseek']);
});

test('遮蔽：四个新来源的目录、每个根和不可用原因都被遮蔽，计数不变', () => {
  const m = createPageMasker({ customTerms: ['dev42'], numbered: true });
  const d: Diagnostics = {
    ...base,
    sources: {
      gemini: off, grok: off, copilot: off,
      deepseek: { dir: '/home/dev42/.dsh/sessions', present: true, reading: false, sessionCount: 0, legacyFiles: 1, unavailable: 'dev42 needs Node 22.15' },
      workbuddy: { dir: '/home/dev42/.workbuddy/projects', present: true, reading: true, sessionCount: 1, duplicateSessions: 1, dirs: [{ dir: '/home/dev42/.workbuddy/projects', present: true }, { dir: '/home/dev42/.workbuddy-ai/projects', present: true }] },
      codebuddy: { dir: '/home/dev42/.codebuddy/projects', present: true, reading: true, sessionCount: 2 },
      doubao: { dir: '/home/dev42/Library/Application Support/DoubaoWork', present: true, reading: true, sessionCount: 3, mtimeFallbacks: 1, unknownSessions: 2, duplicateSessions: 0 },
      qwen: { dir: '/home/dev42/.qwen/projects', present: true, reading: true, sessionCount: 4, unsupportedSessions: 1 },
    },
  };
  const out = maskDiagnostics(d, m);
  expect(JSON.stringify(out.sources)).not.toContain('dev42');
  expect(out.sources?.qwen.dir).toContain('.qwen');
  expect(out.sources?.deepseek).toMatchObject({ legacyFiles: 1, present: true, reading: false });
  expect(out.sources?.workbuddy).toMatchObject({ duplicateSessions: 1, sessionCount: 1 });
  expect(out.sources?.codebuddy.sessionCount).toBe(2);
  expect(out.sources?.doubao).toMatchObject({ mtimeFallbacks: 1, unknownSessions: 2, duplicateSessions: 0 });
  expect(out.sources?.qwen).toMatchObject({ unsupportedSessions: 1, sessionCount: 4, present: true, reading: true });
});
