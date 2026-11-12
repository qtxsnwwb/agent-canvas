import { expect, test } from 'vitest';
import type { Diagnostics } from '@claude-canvas/shared';
import { codexDirLine, EXPECTED_CODEX_HOOK_EVENTS, hooksByOrigin } from '../src/diagnostics';

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

test('hooksByOrigin：Codex 会话目录存在（即使还没有文件、也没收到 hook）就列出 codex', () => {
  const d = { ...base, codex: { sessionsDir: '/home/u/.codex/sessions', sessionsDirExists: true } };
  expect(hooksByOrigin(d).map((x) => x.origin)).toEqual(['claude', 'codex']);
  expect(hooksByOrigin(d)[1]!.missing).toEqual([...EXPECTED_CODEX_HOOK_EVENTS]);
  // Codex disabled and nothing from it: the page looks as before.
  expect(hooksByOrigin(base).map((x) => x.origin)).toEqual(['claude']);
});

test('hooksByOrigin：只装了 Claude Code 的机器（默认目录已配置但不存在，没有 Codex 文件和 hook）不出现 Codex', () => {
  const d = { ...base, codex: { sessionsDir: '/home/u/.codex/sessions', sessionsDirExists: false } };
  expect(hooksByOrigin(d).map((x) => x.origin)).toEqual(['claude']);
  // Codex data shows the block even when the directory is gone now.
  const withFile = { ...d, files: [{ path: 'codex:2026/11/11/rollout-x.jsonl' } as Diagnostics['files'][number]] };
  expect(hooksByOrigin(withFile).map((x) => x.origin)).toEqual(['claude', 'codex']);
  const withHook = { ...d, hookEvents: [{ origin: 'codex', eventName: 'Stop', count: 1, lastAt: '2026-11-11T03:00:00.000Z' } as Diagnostics['hookEvents'][number]] };
  expect(hooksByOrigin(withHook).map((x) => x.origin)).toEqual(['claude', 'codex']);
});

test('codexDirLine：目录存在 / 不存在 / 未启用', () => {
  expect(codexDirLine({ sessionsDir: '/h/.codex/sessions', sessionsDirExists: true })).toBe('Codex 会话目录：/h/.codex/sessions（存在）');
  expect(codexDirLine({ sessionsDir: '/h/.codex/sessions', sessionsDirExists: false })).toBe('Codex 会话目录：/h/.codex/sessions（不存在，Codex 似乎没有安装）');
  expect(codexDirLine({ sessionsDir: null, sessionsDirExists: false })).toBe('Codex 会话目录：未启用');
});
