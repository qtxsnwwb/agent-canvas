import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { FILE_ONLY_ORIGINS, ORIGINS } from '@agent-canvas/shared';
import { loadConfig, userPath } from '../src/config.js';
import { KEY_PREFIXES, originOfKey } from '../src/sources/source.js';
import { sourceDirsOf } from '../src/sources/dirs.js';
import { removeTestPath } from './remove-test-path.js';

// Resolution of Qwen Code's runtime base (spec qwen-code 2). Only fake paths: nothing here is read or written except a
// temp dir checked to stay empty.

const home = os.homedir();
const abs = (p: string): string => path.resolve(p);

describe('qwenDir', () => {
  test('default: ~/.qwen', () => {
    expect(loadConfig({}).qwenDir).toBe(path.join(home, '.qwen'));
  });

  test('QWEN_HOME wins over the default; empty is treated as unset', () => {
    expect(loadConfig({ QWEN_HOME: abs('/fake/qwen-home') }).qwenDir).toBe(abs('/fake/qwen-home'));
    expect(loadConfig({ QWEN_HOME: '' }).qwenDir).toBe(path.join(home, '.qwen'));
  });

  test('QWEN_RUNTIME_DIR wins over QWEN_HOME; empty is treated as unset', () => {
    expect(loadConfig({ QWEN_RUNTIME_DIR: abs('/fake/runtime'), QWEN_HOME: abs('/fake/qwen-home') }).qwenDir).toBe(abs('/fake/runtime'));
    expect(loadConfig({ QWEN_RUNTIME_DIR: '', QWEN_HOME: abs('/fake/qwen-home') }).qwenDir).toBe(abs('/fake/qwen-home'));
    expect(loadConfig({ QWEN_RUNTIME_DIR: '' }).qwenDir).toBe(path.join(home, '.qwen'));
  });

  test("our variable wins over both of Qwen Code's; the empty string means not read", () => {
    const tool = { QWEN_RUNTIME_DIR: abs('/fake/runtime'), QWEN_HOME: abs('/fake/qwen-home') };
    expect(loadConfig({ AGENT_CANVAS_QWEN_DIR: abs('/fake/own'), ...tool }).qwenDir).toBe(abs('/fake/own'));
    expect(loadConfig({ AGENT_CANVAS_QWEN_DIR: '', ...tool }).qwenDir).toBeNull();
    expect(loadConfig({ AGENT_CANVAS_QWEN_DIR: '' }).qwenDir).toBeNull();
  });

  test('an explicit override wins over everything (null included)', () => {
    const env = { AGENT_CANVAS_QWEN_DIR: abs('/fake/own'), QWEN_RUNTIME_DIR: abs('/fake/runtime'), QWEN_HOME: abs('/fake/qwen-home') };
    expect(loadConfig(env, { qwenDir: '/fake/override' }).qwenDir).toBe('/fake/override');
    expect(loadConfig(env, { qwenDir: null }).qwenDir).toBeNull();
  });

  test.each(['AGENT_CANVAS_QWEN_DIR', 'QWEN_RUNTIME_DIR', 'QWEN_HOME'])('%s: a leading ~ is the home directory', (name) => {
    expect(loadConfig({ [name]: '~' }).qwenDir).toBe(home);
    expect(loadConfig({ [name]: '~/qwen-data' }).qwenDir).toBe(path.join(home, 'qwen-data'));
    expect(loadConfig({ [name]: '~/a/b' }).qwenDir).toBe(path.join(home, 'a', 'b'));
    // A ~ that is not followed by a separator names a directory of that name, resolved like any relative path.
    expect(loadConfig({ [name]: '~other' }).qwenDir).toBe(path.resolve('~other'));
  });

  test('~\\ is the home directory on Windows only; elsewhere it is a relative path like any other (review Minor)', () => {
    expect(userPath('~\\qwen-data', 'C:\\Users\\dev', 'win32')).toBe(path.join('C:\\Users\\dev', 'qwen-data'));
    expect(userPath('~\\qwen-data', '/home/dev', 'linux')).toBe(path.resolve('~\\qwen-data'));
    expect(userPath('~\\qwen-data', '/home/dev', 'darwin')).toBe(path.resolve('~\\qwen-data'));
    // ~/ and a bare ~ on every platform.
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      expect(userPath('~', '/home/dev', platform), platform).toBe('/home/dev');
      expect(userPath('~/q', '/home/dev', platform), platform).toBe(path.join('/home/dev', 'q'));
    }
    // Through loadConfig, on the platform the tests run on.
    expect(loadConfig({ QWEN_HOME: '~\\q' }).qwenDir).toBe(process.platform === 'win32' ? path.join(home, 'q') : path.resolve('~\\q'));
  });

  test.each(['AGENT_CANVAS_QWEN_DIR', 'QWEN_RUNTIME_DIR', 'QWEN_HOME'])('%s: a relative path resolves against the working directory', (name) => {
    expect(loadConfig({ [name]: 'rel/qwen' }).qwenDir).toBe(path.resolve(process.cwd(), 'rel/qwen'));
    expect(loadConfig({ [name]: './q' }).qwenDir).toBe(path.resolve(process.cwd(), 'q'));
  });

  test('an absolute value is kept as given', () => {
    const p = path.join(os.tmpdir(), 'some-qwen');
    expect(loadConfig({ QWEN_HOME: p }).qwenDir).toBe(p);
  });
});

describe('the tool variables of the other origins are unchanged (no ~ expansion, no resolution)', () => {
  test('a ~ or relative value is passed through as before', () => {
    expect(loadConfig({ CODEBUDDY_CONFIG_DIR: '~/cb' }).codebuddyDir).toBe('~/cb');
    expect(loadConfig({ AGENT_CANVAS_DSH_DIR: 'rel/dsh' }).deepseekDir).toBe('rel/dsh');
    expect(loadConfig({ GROK_HOME: '~' }).grokDir).toBe('~');
  });
});

describe('sourceDirsOf qwen', () => {
  test('<qwenDir>/projects; none when disabled', () => {
    expect(sourceDirsOf(loadConfig({}, { qwenDir: '/q' }), 'qwen')).toEqual([path.join('/q', 'projects')]);
    expect(sourceDirsOf(loadConfig({}, { qwenDir: null }), 'qwen')).toEqual([]);
  });
});

describe('nothing is created on disk', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-config-qwen-'));
  });
  afterEach(() => removeTestPath(tmp));

  test('resolving every variable leaves the named directories absent', () => {
    const at = (n: string): string => path.join(tmp, n);
    const fixed = { dataDir: at('data'), projectsDir: at('projects') };
    loadConfig({ AGENT_CANVAS_QWEN_DIR: at('own') }, fixed);
    loadConfig({ QWEN_RUNTIME_DIR: at('runtime') }, fixed);
    loadConfig({ QWEN_HOME: at('home') }, fixed);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });
});

describe('the shared lists', () => {
  test('qwen is the last origin, file-only, with its key prefix', () => {
    expect(ORIGINS[ORIGINS.length - 1]).toBe('qwen');
    expect(ORIGINS).toHaveLength(11);
    expect(FILE_ONLY_ORIGINS[FILE_ONLY_ORIGINS.length - 1]).toBe('qwen');
    expect(KEY_PREFIXES.qwen).toBe('qwen:');
    expect(originOfKey('qwen:p/chats/0123456789abcdef0123456789abcdef.jsonl')).toBe('qwen');
  });
});
