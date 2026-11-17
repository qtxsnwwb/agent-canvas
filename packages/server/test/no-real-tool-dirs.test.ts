import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';

// Guard: no test may reach the real directories of Gemini CLI, Grok, Copilot CLI, DeepSeek Harness, WorkBuddy, CodeBuddy
// Code or Doubao Work (plans more-sources and more-sources-cn, Global Constraints).

const TOOL_KEYS = ['geminiDir', 'grokDir', 'copilotDir', 'deepseekDir', 'workbuddyDirs', 'codebuddyDir', 'doubaoDirs'] as const;
/** Tests of the resolution rules themselves: they read the resolved paths, never the directories. */
const RESOLUTION_TESTS = new Set(['config.test.ts', 'config-more-sources.test.ts', 'config-more-sources-cn.test.ts', 'no-real-tool-dirs.test.ts']);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const home = path.resolve(os.homedir()).toLowerCase();
const underHome = (p: string | null | readonly string[]): boolean =>
  Array.isArray(p) ? p.some((one: string) => underHome(one)) : p !== null && path.resolve(p as string).toLowerCase().startsWith(home);

/** The argument text of every `loadConfig(...)` call in `src` (balanced parentheses). */
function loadConfigCalls(src: string): string[] {
  const out: string[] = [];
  let at = src.indexOf('loadConfig(');
  while (at !== -1) {
    let depth = 0;
    let i = at + 'loadConfig'.length;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) break;
    }
    out.push(src.slice(at + 'loadConfig('.length, i));
    at = src.indexOf('loadConfig(', i);
  }
  return out;
}

test('every loadConfig in the tests either reads process.env (guarded by the vitest env) or overrides all seven tool dirs', () => {
  const offenders: string[] = [];
  for (const file of fs.readdirSync(testDir).filter((f) => f.endsWith('.ts') && !RESOLUTION_TESTS.has(f))) {
    for (const args of loadConfigCalls(fs.readFileSync(path.join(testDir, file), 'utf8'))) {
      if (args.trim().startsWith('process.env')) continue;
      if (TOOL_KEYS.every((k) => args.includes(k))) continue;
      offenders.push(`${file}: loadConfig(${args.replace(/\s+/g, ' ').slice(0, 120)})`);
    }
  }
  expect(offenders).toEqual([]);
});

test('the scanner finds a call that leaves a tool dir to its default', () => {
  expect(loadConfigCalls("loadConfig({}, { projectsDir: 'x', geminiDir: null })")).toEqual(["{}, { projectsDir: 'x', geminiDir: null }"]);
  const call = loadConfigCalls("loadConfig({}, { projectsDir: 'x', geminiDir: null })")[0]!;
  expect(TOOL_KEYS.every((k) => call.includes(k))).toBe(false);
});

test('configs built as tests build them resolve no tool dir under the real home', () => {
  const fromEnv = loadConfig(process.env);
  const fromTest = loadConfig({}, { projectsDir: path.join(os.tmpdir(), 'p'), dataDir: path.join(os.tmpdir(), 'd'), geminiDir: null, grokDir: null, copilotDir: null, deepseekDir: null, workbuddyDirs: [], codebuddyDir: null, doubaoDirs: [] });
  for (const c of [fromEnv, fromTest]) for (const k of TOOL_KEYS) expect(underHome(c[k]), k).toBe(false);
  // Without the overrides they would: this is what the guard above prevents.
  expect(TOOL_KEYS.some((k) => underHome(loadConfig({})[k]))).toBe(true);
});
