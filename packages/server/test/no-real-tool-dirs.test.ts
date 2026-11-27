import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';
import { removeTestPath } from './remove-test-path.js';

// Guard: no test may reach the real directories of Gemini CLI, Grok, Copilot CLI, DeepSeek Harness, WorkBuddy, CodeBuddy
// Code, Doubao Work or Qwen Code (plans more-sources, more-sources-cn and qwen-code, Global Constraints).

const TOOL_KEYS = ['geminiDir', 'grokDir', 'copilotDir', 'deepseekDir', 'workbuddyDirs', 'codebuddyDir', 'doubaoDirs', 'qwenDir'] as const;
/** Tests of the resolution rules themselves: they read the resolved paths, never the directories. */
const RESOLUTION_TESTS = new Set(['config.test.ts', 'config-more-sources.test.ts', 'config-more-sources-cn.test.ts', 'config-qwen.test.ts', 'service-core.test.ts', 'no-real-tool-dirs.test.ts']);
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

test('every loadConfig in the tests either reads process.env (guarded by the vitest env) or overrides all eight tool dirs', () => {
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

const repoRoot = path.resolve(testDir, '../../..');

test('the release scripts start the CLI with every tool directory off and a temp home (final review I-1)', async () => {
  const smoke = (await import(pathToFileURL(path.join(repoRoot, 'scripts/export-smoke.mjs')).href)) as {
    isolatedServerEnv: (tmp: string, extra?: Record<string, string>) => NodeJS.ProcessEnv;
  };
  expect(typeof smoke.isolatedServerEnv).toBe('function');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-guard-scripts-'));
  try {
    // As if the tools' own variables and a Windows %LOCALAPPDATA% named real directories.
    const before = { ...process.env };
    Object.assign(process.env, {
      DSH_HOME: path.join(tmp, 'x-dsh'), WORKBUDDY_CONFIG_DIR: path.join(tmp, 'x-wb'), CODEBUDDY_CONFIG_DIR: path.join(tmp, 'x-cb'),
      GEMINI_CLI_HOME: path.join(tmp, 'x-gem'), GROK_HOME: path.join(tmp, 'x-grok'), COPILOT_HOME: path.join(tmp, 'x-cop'),
      QWEN_RUNTIME_DIR: path.join(tmp, 'x-qwen-rt'), QWEN_HOME: path.join(tmp, 'x-qwen'),
      LOCALAPPDATA: path.join(tmp, 'x-local'),
    });
    // ...and the caller's environment did not turn any tool off (the Vitest env does).
    for (const k of Object.keys(process.env)) if (/^AGENT_CANVAS_.*_(?:DIR|DB)$/.test(k)) delete process.env[k];
    let env: NodeJS.ProcessEnv;
    try {
      env = smoke.isolatedServerEnv(tmp);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
      Object.assign(process.env, before);
    }
    const c = loadConfig(env);
    expect(c.codexSessionsDir).toBeNull();
    expect(c.cursorDbPath).toBeNull();
    for (const k of TOOL_KEYS) expect(Array.isArray(c[k]) ? c[k] : c[k] === null ? [] : [c[k]], k).toEqual([]);
    for (const p of [env.HOME, env.USERPROFILE, c.dataDir, c.projectsDir]) expect(path.resolve(p!).startsWith(path.resolve(tmp))).toBe(true);
  } finally {
    removeTestPath(tmp);
  }
  // Every script that starts the CLI builds its environment with that helper.
  const scripts = path.join(repoRoot, 'scripts');
  for (const f of fs.readdirSync(scripts).filter((n) => n.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join(scripts, f), 'utf8');
    const startsCli = /(?:spawn|execFileSync|execFile)\(process\.execPath/.test(src);
    if (startsCli) expect(src.includes('isolatedServerEnv('), f).toBe(true);
  }
});

test('configs built as tests build them resolve no tool dir under the real home', () => {
  const fromEnv = loadConfig(process.env);
  const fromTest = loadConfig({}, { projectsDir: path.join(os.tmpdir(), 'p'), dataDir: path.join(os.tmpdir(), 'd'), geminiDir: null, grokDir: null, copilotDir: null, deepseekDir: null, workbuddyDirs: [], codebuddyDir: null, doubaoDirs: [], qwenDir: null });
  for (const c of [fromEnv, fromTest]) for (const k of TOOL_KEYS) expect(underHome(c[k]), k).toBe(false);
  // Without the overrides they would: this is what the guard above prevents.
  expect(TOOL_KEYS.some((k) => underHome(loadConfig({})[k]))).toBe(true);
});
