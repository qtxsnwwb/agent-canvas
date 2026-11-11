import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';

test('codexSessionsDir：未设置时默认 ~/.codex/sessions', () => {
  expect(loadConfig({}).codexSessionsDir).toBe(path.join(os.homedir(), '.codex', 'sessions'));
});

test('codexSessionsDir：CLAUDE_CANVAS_CODEX_DIR 指定目录；空字符串表示不接 Codex', () => {
  expect(loadConfig({ CLAUDE_CANVAS_CODEX_DIR: '/c/sessions' }).codexSessionsDir).toBe('/c/sessions');
  expect(loadConfig({ CLAUDE_CANVAS_CODEX_DIR: '' }).codexSessionsDir).toBeNull();
});

test('codexSessionsDir：显式覆盖优先于环境变量（包括 null）', () => {
  expect(loadConfig({ CLAUDE_CANVAS_CODEX_DIR: '/c' }, { codexSessionsDir: '/o' }).codexSessionsDir).toBe('/o');
  expect(loadConfig({ CLAUDE_CANVAS_CODEX_DIR: '/c' }, { codexSessionsDir: null }).codexSessionsDir).toBeNull();
});
