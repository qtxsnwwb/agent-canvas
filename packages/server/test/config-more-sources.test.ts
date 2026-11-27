import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { isExistingDir } from '../src/sources/dirs.js';
import { removeTestPath } from './remove-test-path.js';

// Only fake paths: nothing here is read or written except a temp dir for isExistingDir.
interface Case {
  key: 'geminiDir' | 'grokDir' | 'copilotDir';
  ownVar: string;
  toolVar: string;
  /** What the tool variable's value resolves to. */
  fromToolVar: (v: string) => string;
  home: string[];
}

const cases: Case[] = [
  { key: 'geminiDir', ownVar: 'AGENT_CANVAS_GEMINI_DIR', toolVar: 'GEMINI_CLI_HOME', fromToolVar: (v) => path.join(v, '.gemini'), home: ['.gemini'] },
  { key: 'grokDir', ownVar: 'AGENT_CANVAS_GROK_DIR', toolVar: 'GROK_HOME', fromToolVar: (v) => v, home: ['.grok'] },
  { key: 'copilotDir', ownVar: 'AGENT_CANVAS_COPILOT_DIR', toolVar: 'COPILOT_HOME', fromToolVar: (v) => v, home: ['.copilot'] },
];

describe.each(cases)('$key', ({ key, ownVar, toolVar, fromToolVar, home }) => {
  test('default: under the home directory', () => {
    expect(loadConfig({})[key]).toBe(path.join(os.homedir(), ...home));
  });

  test("the tool's own variable wins over the default", () => {
    expect(loadConfig({ [toolVar]: '/fake/tool-home' })[key]).toBe(fromToolVar('/fake/tool-home'));
  });

  test(`${'AGENT_CANVAS_*_DIR'} wins over the tool's variable; the empty string means not read`, () => {
    expect(loadConfig({ [ownVar]: '/fake/own', [toolVar]: '/fake/tool-home' })[key]).toBe('/fake/own');
    expect(loadConfig({ [ownVar]: '', [toolVar]: '/fake/tool-home' })[key]).toBeNull();
    expect(loadConfig({ [ownVar]: '' })[key]).toBeNull();
  });

  test('an explicit override wins over everything (null included)', () => {
    const env = { [ownVar]: '/fake/own', [toolVar]: '/fake/tool-home' };
    expect(loadConfig(env, { [key]: '/fake/override' } as Partial<Config>)[key]).toBe('/fake/override');
    expect(loadConfig(env, { [key]: null } as Partial<Config>)[key]).toBeNull();
  });

  test('an empty tool variable is treated as unset', () => {
    expect(loadConfig({ [toolVar]: '' })[key]).toBe(path.join(os.homedir(), ...home));
  });
});

describe('isExistingDir', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dirs-'));
  });
  afterEach(() => removeTestPath(tmp));

  test('true only for an existing directory', () => {
    const file = path.join(tmp, 'f.txt');
    fs.writeFileSync(file, 'x');
    expect(isExistingDir(tmp)).toBe(true);
    expect(isExistingDir(file)).toBe(false);
    expect(isExistingDir(path.join(tmp, 'missing'))).toBe(false);
    expect(isExistingDir(null)).toBe(false);
    expect(isExistingDir('')).toBe(false);
  });
});
