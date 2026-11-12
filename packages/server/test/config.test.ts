import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { defaultCursorDbPath, loadConfig } from '../src/config.js';

test('codexSessionsDir：未设置时默认 ~/.codex/sessions', () => {
  expect(loadConfig({}).codexSessionsDir).toBe(path.join(os.homedir(), '.codex', 'sessions'));
});

test('codexSessionsDir：AGENT_CANVAS_CODEX_DIR 指定目录；空字符串表示不接 Codex', () => {
  expect(loadConfig({ AGENT_CANVAS_CODEX_DIR: '/c/sessions' }).codexSessionsDir).toBe('/c/sessions');
  expect(loadConfig({ AGENT_CANVAS_CODEX_DIR: '' }).codexSessionsDir).toBeNull();
});

test('codexSessionsDir：显式覆盖优先于环境变量（包括 null）', () => {
  expect(loadConfig({ AGENT_CANVAS_CODEX_DIR: '/c' }, { codexSessionsDir: '/o' }).codexSessionsDir).toBe('/o');
  expect(loadConfig({ AGENT_CANVAS_CODEX_DIR: '/c' }, { codexSessionsDir: null }).codexSessionsDir).toBeNull();
});

test('defaultCursorDbPath：各平台的默认 Cursor 状态库路径（spec 5.1）', () => {
  expect(defaultCursorDbPath('win32', { APPDATA: String.raw`D:\Roaming` }, String.raw`C:\Users\u`)).toBe(
    String.raw`D:\Roaming\Cursor\User\globalStorage\state.vscdb`,
  );
  expect(defaultCursorDbPath('win32', {}, String.raw`C:\Users\u`)).toBe(String.raw`C:\Users\u\AppData\Roaming\Cursor\User\globalStorage\state.vscdb`);
  expect(defaultCursorDbPath('darwin', {}, '/Users/u')).toBe('/Users/u/Library/Application Support/Cursor/User/globalStorage/state.vscdb');
  expect(defaultCursorDbPath('linux', {}, '/home/u')).toBe('/home/u/.config/Cursor/User/globalStorage/state.vscdb');
});

test('cursorDbPath：未设置时为本平台默认；AGENT_CANVAS_CURSOR_DB 指定路径；空字符串表示不接 Cursor', () => {
  expect(loadConfig({}).cursorDbPath).toBe(defaultCursorDbPath(process.platform, {}, os.homedir()));
  const env = { APPDATA: String.raw`C:\Roaming` };
  expect(loadConfig(env).cursorDbPath).toBe(defaultCursorDbPath(process.platform, env, os.homedir()));
  expect(loadConfig({ AGENT_CANVAS_CURSOR_DB: '/c/state.vscdb' }).cursorDbPath).toBe('/c/state.vscdb');
  expect(loadConfig({ AGENT_CANVAS_CURSOR_DB: '' }).cursorDbPath).toBeNull();
});

test('cursorDbPath：显式覆盖优先于环境变量（包括 null）', () => {
  expect(loadConfig({ AGENT_CANVAS_CURSOR_DB: '/c' }, { cursorDbPath: '/o' }).cursorDbPath).toBe('/o');
  expect(loadConfig({ AGENT_CANVAS_CURSOR_DB: '/c' }, { cursorDbPath: null }).cursorDbPath).toBeNull();
});
