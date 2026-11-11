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
};

test('hooksByOrigin：配置了 Codex 会话目录（即使还没有文件、也没收到 hook）就列出 codex', () => {
  const d = { ...base, codex: { sessionsDir: '/home/u/.codex/sessions', sessionsDirExists: false } };
  expect(hooksByOrigin(d).map((x) => x.origin)).toEqual(['claude', 'codex']);
  expect(hooksByOrigin(d)[1]!.missing).toEqual([...EXPECTED_CODEX_HOOK_EVENTS]);
  // Codex disabled and nothing from it: the page looks as before.
  expect(hooksByOrigin(base).map((x) => x.origin)).toEqual(['claude']);
});

test('codexDirLine：目录存在 / 不存在 / 未启用', () => {
  expect(codexDirLine({ sessionsDir: '/h/.codex/sessions', sessionsDirExists: true })).toBe('Codex 会话目录：/h/.codex/sessions（存在）');
  expect(codexDirLine({ sessionsDir: '/h/.codex/sessions', sessionsDirExists: false })).toBe('Codex 会话目录：/h/.codex/sessions（不存在，Codex 似乎没有安装）');
  expect(codexDirLine({ sessionsDir: null, sessionsDirExists: false })).toBe('Codex 会话目录：未启用');
});
