import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { COST_EXCLUDED_ORIGINS, FILE_ONLY_ORIGINS, ORIGINS } from '@agent-canvas/shared';
import { defaultDoubaoDirs, loadConfig, type Config } from '../src/config.js';
import { KEY_PREFIXES, originOfKey } from '../src/sources/source.js';
import { sourceDirsOf } from '../src/sources/dirs.js';
import { removeTestPath } from './remove-test-path.js';

// Resolution of the four tool directories (DeepSeek Harness, WorkBuddy, CodeBuddy Code, Doubao Work). Only fake paths:
// nothing here is read or written except a temp dir checked to stay empty.

interface SingleCase {
  key: 'deepseekDir' | 'codebuddyDir';
  ownVar: string;
  toolVar: string;
  home: string;
}

const singles: SingleCase[] = [
  { key: 'deepseekDir', ownVar: 'AGENT_CANVAS_DSH_DIR', toolVar: 'DSH_HOME', home: '.dsh' },
  { key: 'codebuddyDir', ownVar: 'AGENT_CANVAS_CODEBUDDY_DIR', toolVar: 'CODEBUDDY_CONFIG_DIR', home: '.codebuddy' },
];

describe.each(singles)('$key', ({ key, ownVar, toolVar, home }) => {
  test('default: under the home directory', () => {
    expect(loadConfig({})[key]).toBe(path.join(os.homedir(), home));
  });

  test("the tool's own variable wins over the default; empty is treated as unset", () => {
    expect(loadConfig({ [toolVar]: '/fake/tool-home' })[key]).toBe('/fake/tool-home');
    expect(loadConfig({ [toolVar]: '' })[key]).toBe(path.join(os.homedir(), home));
  });

  test("our variable wins over the tool's; the empty string means not read", () => {
    expect(loadConfig({ [ownVar]: '/fake/own', [toolVar]: '/fake/tool-home' })[key]).toBe('/fake/own');
    expect(loadConfig({ [ownVar]: '', [toolVar]: '/fake/tool-home' })[key]).toBeNull();
    expect(loadConfig({ [ownVar]: '' })[key]).toBeNull();
  });

  test('an explicit override wins over everything (null included)', () => {
    const env = { [ownVar]: '/fake/own', [toolVar]: '/fake/tool-home' };
    expect(loadConfig(env, { [key]: '/fake/override' } as Partial<Config>)[key]).toBe('/fake/override');
    expect(loadConfig(env, { [key]: null } as Partial<Config>)[key]).toBeNull();
  });
});

describe('workbuddyDirs', () => {
  test('default: both ~/.workbuddy and ~/.workbuddy-ai', () => {
    expect(loadConfig({}).workbuddyDirs).toEqual([path.join(os.homedir(), '.workbuddy'), path.join(os.homedir(), '.workbuddy-ai')]);
  });

  test("the tool's own variable names one directory; empty is treated as unset", () => {
    expect(loadConfig({ WORKBUDDY_CONFIG_DIR: '/fake/wb' }).workbuddyDirs).toEqual(['/fake/wb']);
    expect(loadConfig({ WORKBUDDY_CONFIG_DIR: '' }).workbuddyDirs).toHaveLength(2);
  });

  test("our variable names one directory and wins over the tool's; the empty string means not read", () => {
    expect(loadConfig({ AGENT_CANVAS_WORKBUDDY_DIR: '/fake/own', WORKBUDDY_CONFIG_DIR: '/fake/wb' }).workbuddyDirs).toEqual(['/fake/own']);
    expect(loadConfig({ AGENT_CANVAS_WORKBUDDY_DIR: '', WORKBUDDY_CONFIG_DIR: '/fake/wb' }).workbuddyDirs).toEqual([]);
  });

  test('an explicit override wins over everything', () => {
    const env = { AGENT_CANVAS_WORKBUDDY_DIR: '/fake/own', WORKBUDDY_CONFIG_DIR: '/fake/wb' };
    expect(loadConfig(env, { workbuddyDirs: ['/fake/override'] }).workbuddyDirs).toEqual(['/fake/override']);
    expect(loadConfig(env, { workbuddyDirs: [] }).workbuddyDirs).toEqual([]);
  });
});

describe('doubaoDirs', () => {
  test('default: defaultDoubaoDirs for this platform', () => {
    expect(loadConfig({}).doubaoDirs).toEqual(defaultDoubaoDirs(process.platform, {}, os.homedir()));
  });

  test('our variable names one "User Data"-level directory; the empty string means not read', () => {
    expect(loadConfig({ AGENT_CANVAS_DOUBAO_DIR: '/fake/doubao' }).doubaoDirs).toEqual(['/fake/doubao']);
    expect(loadConfig({ AGENT_CANVAS_DOUBAO_DIR: '' }).doubaoDirs).toEqual([]);
  });

  test('an explicit override wins over everything', () => {
    expect(loadConfig({ AGENT_CANVAS_DOUBAO_DIR: '/fake/doubao' }, { doubaoDirs: ['/fake/override'] }).doubaoDirs).toEqual(['/fake/override']);
    expect(loadConfig({ AGENT_CANVAS_DOUBAO_DIR: '/fake/doubao' }, { doubaoDirs: [] }).doubaoDirs).toEqual([]);
  });
});

describe('defaultDoubaoDirs', () => {
  test('win32: the two clients under LOCALAPPDATA', () => {
    expect(defaultDoubaoDirs('win32', { LOCALAPPDATA: 'D:\\Local' }, 'C:\\Users\\dev')).toEqual([
      'D:\\Local\\DoubaoWork\\User Data',
      'D:\\Local\\Doubao\\User Data',
    ]);
  });

  test('win32 without LOCALAPPDATA (unset or empty): <home>\\AppData\\Local', () => {
    const expected = ['C:\\Users\\dev\\AppData\\Local\\DoubaoWork\\User Data', 'C:\\Users\\dev\\AppData\\Local\\Doubao\\User Data'];
    expect(defaultDoubaoDirs('win32', {}, 'C:\\Users\\dev')).toEqual(expected);
    expect(defaultDoubaoDirs('win32', { LOCALAPPDATA: '' }, 'C:\\Users\\dev')).toEqual(expected);
  });

  test('darwin: under Application Support', () => {
    expect(defaultDoubaoDirs('darwin', {}, '/Users/dev')).toEqual([
      '/Users/dev/Library/Application Support/DoubaoWork',
      '/Users/dev/Library/Application Support/Doubao',
    ]);
  });

  test('linux and others: none (no client)', () => {
    expect(defaultDoubaoDirs('linux', {}, '/home/dev')).toEqual([]);
    expect(defaultDoubaoDirs('freebsd', {}, '/home/dev')).toEqual([]);
  });
});

describe('sourceDirsOf', () => {
  test('the directories each source reads; none when disabled', () => {
    const c = loadConfig({}, {
      geminiDir: '/g', grokDir: null, copilotDir: '/c',
      deepseekDir: '/d', workbuddyDirs: ['/w1', '/w2'], codebuddyDir: '/cb', doubaoDirs: ['/u1', '/u2'],
    });
    expect(sourceDirsOf(c, 'gemini')).toEqual([path.join('/g', 'tmp')]);
    expect(sourceDirsOf(c, 'grok')).toEqual([]);
    expect(sourceDirsOf(c, 'copilot')).toEqual([path.join('/c', 'session-state')]);
    expect(sourceDirsOf(c, 'deepseek')).toEqual([path.join('/d', 'sessions')]);
    expect(sourceDirsOf(c, 'workbuddy')).toEqual([path.join('/w1', 'projects'), path.join('/w2', 'projects')]);
    expect(sourceDirsOf(c, 'codebuddy')).toEqual([path.join('/cb', 'projects')]);
    expect(sourceDirsOf(c, 'doubao')).toEqual(['/u1', '/u2']);
    const off = loadConfig({}, { deepseekDir: null, workbuddyDirs: [], codebuddyDir: null, doubaoDirs: [], geminiDir: null, grokDir: null, copilotDir: null });
    for (const o of ['deepseek', 'workbuddy', 'codebuddy', 'doubao'] as const) expect(sourceDirsOf(off, o)).toEqual([]);
  });
});

describe('nothing is created on disk', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-config-cn-'));
  });
  afterEach(() => removeTestPath(tmp));

  test('resolving every variable leaves the named directories absent', () => {
    const at = (n: string): string => path.join(tmp, n);
    loadConfig({
      AGENT_CANVAS_DSH_DIR: at('dsh'), WORKBUDDY_CONFIG_DIR: at('wb'), AGENT_CANVAS_CODEBUDDY_DIR: at('cb'), AGENT_CANVAS_DOUBAO_DIR: at('db'),
      LOCALAPPDATA: at('local'),
    }, { dataDir: at('data'), projectsDir: at('projects'), geminiDir: null, grokDir: null, copilotDir: null });
    loadConfig({ DSH_HOME: at('dsh2'), CODEBUDDY_CONFIG_DIR: at('cb2') }, { dataDir: at('data'), projectsDir: at('projects') });
    expect(fs.readdirSync(tmp)).toEqual([]);
  });
});

describe('the shared lists', () => {
  test('the four origins, their key prefixes, file-only and cost exclusion (Doubao Work has no usage)', () => {
    expect(ORIGINS.slice(6)).toEqual(['deepseek', 'workbuddy', 'codebuddy', 'doubao', 'qwen']);
    expect(FILE_ONLY_ORIGINS).toEqual(['gemini', 'grok', 'copilot', 'deepseek', 'workbuddy', 'codebuddy', 'doubao', 'qwen']);
    expect(COST_EXCLUDED_ORIGINS).toEqual(['copilot', 'doubao']);
    for (const o of ['deepseek', 'workbuddy', 'codebuddy', 'doubao'] as const) {
      expect(KEY_PREFIXES[o]).toBe(`${o}:`);
      expect(originOfKey(`${o}:a/b.jsonl`)).toBe(o);
    }
  });
});
