import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { main } from '../src/cli.js';
import { defaultCodexHooksFile, runCodexHooksInstall, runCodexHooksUninstall, type HooksCliIo } from '../src/hooks-cli.js';
import { CODEX_HOOK_EVENTS, codexForwardCommands } from '../src/hooks-config.js';

// Every test works inside a fresh temp directory: the real ~/.codex/hooks.json is never read or written. The guard at
// the bottom records every path the fs functions used by the install code were called with during this file.
const REAL_DEFAULT = path.join(os.homedir(), '.codex', 'hooks.json');
const touched: string[] = [];
const WATCHED = ['readFileSync', 'writeFileSync', 'renameSync', 'copyFileSync', 'realpathSync', 'statSync', 'lstatSync', 'existsSync', 'mkdirSync', 'rmSync', 'chmodSync'] as const;
beforeAll(() => {
  for (const name of WATCHED) {
    const original = (fs as any)[name].bind(fs);
    vi.spyOn(fs as any, name).mockImplementation((...args: unknown[]) => {
      for (const a of args.slice(0, 2)) if (typeof a === 'string') touched.push(path.resolve(a));
      return original(...args);
    });
  }
});
afterAll(() => {
  vi.restoreAllMocks();
  // Neither Codex's real hooks file nor Claude Code's real settings file (one test also runs the Claude install).
  const real = [REAL_DEFAULT, path.join(os.homedir(), '.claude', 'settings.json')].map((p) => path.resolve(p).toLowerCase());
  expect(touched.filter((p) => real.some((r) => p.toLowerCase().startsWith(r)))).toEqual([]);
});

let dir: string;
let codexDir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-codex-hooks-'));
  codexDir = path.join(dir, '.codex');
  fs.mkdirSync(codexDir);
  file = path.join(codexDir, 'hooks.json');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

const NOW = new Date(2026, 10, 11, 9, 5, 7);
const STAMP = '20261111-090507';
const NODE = '/usr/bin/node';
const CLI = '/opt/claude canvas/dist/cli.js';

interface FakeIo extends HooksCliIo { outs: string[]; errs: string[]; questions: string[] }
function fakeIo(over: { interactive?: boolean; answer?: boolean } = {}): FakeIo {
  const io: FakeIo = {
    outs: [],
    errs: [],
    questions: [],
    out: (l) => io.outs.push(l),
    err: (l) => io.errs.push(l),
    confirm: async (q) => {
      io.questions.push(q);
      return over.answer ?? true;
    },
    isInteractive: over.interactive ?? false,
    now: () => NOW,
  };
  return io;
}
const opts = (extra: Partial<{ port: number; yes: boolean; settingsFile: string; cliPath: string }> = {}) => ({
  settingsFile: file, port: 4317, yes: true, nodePath: NODE, cliPath: CLI, ...extra,
});
const readJson = (f = file): any => JSON.parse(fs.readFileSync(f, 'utf8'));
const listDir = (): string[] => fs.readdirSync(codexDir).sort();
const seed = (content: string): void => fs.writeFileSync(file, content);

test('defaultCodexHooksFile：环境变量优先，否则 ~/.codex/hooks.json（只用假 env 断言，不读写）', () => {
  expect(defaultCodexHooksFile({ CLAUDE_CANVAS_CODEX_HOOKS_FILE: '/x/hooks.json' })).toBe('/x/hooks.json');
  expect(defaultCodexHooksFile({ CLAUDE_CANVAS_CODEX_HOOKS_FILE: '' })).toBe(REAL_DEFAULT);
  expect(defaultCodexHooksFile({})).toBe(REAL_DEFAULT);
  expect(REAL_DEFAULT.startsWith(os.homedir())).toBe(true);
});

test('文件不存在：说明会新建，写入 11 个事件，不备份，提示需要在 Codex 里确认信任', async () => {
  const io = fakeIo();
  expect(await runCodexHooksInstall(opts(), io)).toBe(0);
  const text = io.outs.join('\n');
  expect(text).toContain(`将新建 ${file}`);
  expect(Object.keys(readJson().hooks)).toEqual([...CODEX_HOOK_EVENTS]);
  expect(listDir()).toEqual(['hooks.json']);
  expect(text).toContain('需要在 Codex 里确认信任');
  expect(text).toContain('设置 → Hooks');
  expect(text).toContain('/hooks');
  expect(text).toContain('重新安装');
  const { command, commandWindows } = codexForwardCommands({ nodePath: NODE, cliPath: CLI, port: 4317 });
  expect(readJson().hooks.PreToolUse).toEqual([{ hooks: [{ type: 'command', command, commandWindows, async: true, timeout: 5 }] }]);
  expect(text).toContain(command);
  expect(text).toContain(commandWindows);
});

test('~/.codex 目录不存在：说明 Codex 似乎没有安装，返回 1，什么都不创建', async () => {
  const missing = path.join(dir, 'nope', 'hooks.json');
  const io = fakeIo();
  expect(await runCodexHooksInstall(opts({ settingsFile: missing }), io)).toBe(1);
  expect(io.errs.join('\n')).toContain('Codex 似乎没有安装');
  expect(fs.existsSync(path.dirname(missing))).toBe(false);
});

test('已有 hooks.json：备份（逐字节相同）后写入，已有内容保留', async () => {
  const original = '{\n  "hooks": {\n    "Stop": [{ "hooks": [{ "type": "command", "command": "notify" }] }]\n  }\n}\n';
  seed(original);
  const io = fakeIo();
  expect(await runCodexHooksInstall(opts(), io)).toBe(0);
  const backup = path.join(codexDir, `hooks.json.bak-claude-canvas-${STAMP}`);
  expect(fs.readFileSync(backup, 'utf8')).toBe(original);
  expect(readJson().hooks.Stop[0]).toEqual({ hooks: [{ type: 'command', command: 'notify' }] });
  expect(readJson().hooks.Stop).toHaveLength(2);
  expect(io.outs.join('\n')).toContain(backup);
});

test('重复安装：不写入、不备份', async () => {
  expect(await runCodexHooksInstall(opts(), fakeIo())).toBe(0);
  const after = fs.readFileSync(file, 'utf8');
  const io = fakeIo();
  expect(await runCodexHooksInstall(opts(), io)).toBe(0);
  expect(io.outs.join('\n')).toContain('hooks 已全部安装，无需改动');
  expect(fs.readFileSync(file, 'utf8')).toBe(after);
  expect(listDir()).toEqual(['hooks.json']);
});

test('已安装但 node 路径过期：说明是过期条目、将替换，备份后在一次写入里换成当前 node 的命令', async () => {
  seed('{}');
  expect(await runCodexHooksInstall({ ...opts(), nodePath: '/old/nvm/node' }, fakeIo())).toBe(0);
  const io = fakeIo();
  expect(await runCodexHooksInstall(opts(), io)).toBe(0);
  const text = io.outs.join('\n');
  expect(text).not.toContain('无需改动');
  expect(text).toContain('过期');
  expect(text).toContain(`将替换的事件（${CODEX_HOOK_EVENTS.length}）`);
  expect(text).toContain(`备份：`);
  const { command, commandWindows } = codexForwardCommands({ nodePath: NODE, cliPath: CLI, port: 4317 });
  expect(readJson().hooks.Stop).toEqual([{ hooks: [{ type: 'command', command, commandWindows, async: true, timeout: 5 }] }]);
  expect(readJson().hooks.SessionEnd).toEqual([{ hooks: [{ type: 'command', command, commandWindows, async: true, timeout: 3 }] }]);
  expect(fs.readFileSync(file, 'utf8')).not.toContain('/old/nvm/node');
});

test('确认：非交互且没有 --yes 返回 1；交互回答否不写；回答是写入', async () => {
  seed('{}');
  const noTty = fakeIo();
  expect(await runCodexHooksInstall(opts({ yes: false }), noTty)).toBe(1);
  expect(noTty.errs.join('\n')).toContain('--yes');
  const no = fakeIo({ interactive: true, answer: false });
  expect(await runCodexHooksInstall(opts({ yes: false }), no)).toBe(0);
  expect(fs.readFileSync(file, 'utf8')).toBe('{}');
  expect(listDir()).toEqual(['hooks.json']);
  const yes = fakeIo({ interactive: true, answer: true });
  expect(await runCodexHooksInstall(opts({ yes: false }), yes)).toBe(0);
  expect(yes.questions).toEqual(['写入以上改动？(y/N) ']);
  expect(Object.keys(readJson().hooks)).toEqual([...CODEX_HOOK_EVENTS]);
});

test('确认期间文件被改：不写、不备份，返回 1', async () => {
  seed('{}');
  const io = fakeIo({ interactive: true });
  io.confirm = async () => {
    fs.writeFileSync(file, '{"x":1}');
    return true;
  };
  expect(await runCodexHooksInstall(opts({ yes: false }), io)).toBe(1);
  expect(io.errs.join('\n')).toContain('设置文件在确认期间被修改');
  expect(fs.readFileSync(file, 'utf8')).toBe('{"x":1}');
  expect(listDir()).toEqual(['hooks.json']);
});

test.each([
  ['{ nope', '不是合法的 JSON'],
  ['[]', 'settings'],
  ['{"hooks":{"PreToolUse":{}}}', 'hooks.PreToolUse'],
  ['{"n": 9007199254740993}', '无法无损读写的数字'],
  ['{"a": 1, "a": 2}', '重复的键'],
  ['{"a": 1, "2": 2}', '会被重新排序的键'],
])('不寻常的文件 %s：拒绝写入，返回 1，文件未变', async (content, message) => {
  seed(content);
  const io = fakeIo();
  expect(await runCodexHooksInstall(opts(), io)).toBe(1);
  expect(io.errs.join('\n')).toContain(message);
  expect(fs.readFileSync(file, 'utf8')).toBe(content);
  expect(listDir()).toEqual(['hooks.json']);
});

test('保留 BOM、CRLF 和缩进', async () => {
  seed('﻿{\r\n\t"hooks": {}\r\n}\r\n');
  expect(await runCodexHooksInstall(opts(), fakeIo())).toBe(0);
  const text = fs.readFileSync(file, 'utf8');
  expect(text.charCodeAt(0)).toBe(0xfeff);
  expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  expect(text).toContain('\r\n\t"hooks"');
  expect(Object.keys(JSON.parse(text.slice(1)).hooks)).toEqual([...CODEX_HOOK_EVENTS]);
});

test('卸载：只删本安装本端口的；别的端口 / 别的路径保留；没有可删的时不写', async () => {
  seed(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }] } }));
  await runCodexHooksInstall(opts({ port: 4400 }), fakeIo());
  await runCodexHooksInstall(opts({ cliPath: '/elsewhere/cli.js' }), fakeIo());
  await runCodexHooksInstall(opts(), fakeIo());
  expect(readJson().hooks.Stop).toHaveLength(4);
  const io = fakeIo();
  expect(await runCodexHooksUninstall(opts(), io)).toBe(0);
  const stop = readJson().hooks.Stop.map((e: any) => e.hooks[0].command);
  expect(stop).toHaveLength(3);
  expect(stop[0]).toBe('notify');
  expect(stop[1]).toContain('--port 4400');
  expect(stop[2]).toContain('/elsewhere/cli.js');
  const again = fakeIo();
  const content = fs.readFileSync(file, 'utf8');
  expect(await runCodexHooksUninstall(opts(), again)).toBe(0);
  expect(again.outs.join('\n')).toContain('没有找到');
  expect(fs.readFileSync(file, 'utf8')).toBe(content);
});

test('卸载：文件不存在时不创建', async () => {
  expect(await runCodexHooksUninstall(opts(), fakeIo())).toBe(0);
  expect(fs.existsSync(file)).toBe(false);
});

test('cli：hooks install / uninstall --codex 经 --settings 走通；命令指向当前 node', async () => {
  expect(await main(['hooks', 'install', '--codex', '--yes', '--port', '4400', '--settings', file], { hooksIo: fakeIo() })).toBe(0);
  const hook = readJson().hooks.Interrupt[0].hooks[0];
  expect(hook.command).toContain(process.execPath.includes("'") ? 'node' : `'${process.execPath}'`);
  expect(hook.command).toContain('hook-forward --origin codex --port 4400');
  expect(hook.commandWindows).toContain(`"${process.execPath}"`);
  expect(hook.command).toMatch(/cli\.js' hook-forward/);
  expect(await main(['hooks', 'uninstall', '--codex', '--yes', '--port', '4400', '--settings', file], { hooksIo: fakeIo() })).toBe(0);
  expect(readJson()).toEqual({});
});

test('cli：CLAUDE_CANVAS_CODEX_HOOKS_FILE 指定的路径被使用（假 env）；不加 --codex 时仍是 Claude 的文件', async () => {
  const claudeFile = path.join(dir, 'claude', 'settings.json');
  const env = { CLAUDE_CANVAS_CODEX_HOOKS_FILE: file, CLAUDE_CANVAS_SETTINGS_FILE: claudeFile };
  expect(await main(['hooks', 'install', '--codex', '--yes'], { hooksIo: fakeIo(), env })).toBe(0);
  expect(Object.keys(readJson().hooks)).toEqual([...CODEX_HOOK_EVENTS]);
  expect(fs.existsSync(claudeFile)).toBe(false);
  expect(await main(['hooks', 'install', '--yes'], { hooksIo: fakeIo(), env })).toBe(0);
  expect(readJson(claudeFile).hooks.Stop[0].hooks[0].url).toBe('http://127.0.0.1:4317/hooks');
});

test('cli：用法里列出 --codex 和 hook-forward', async () => {
  const io = fakeIo();
  expect(await main(['hooks', 'nope'], { hooksIo: io, env: { CLAUDE_CANVAS_CODEX_HOOKS_FILE: file } })).toBe(1);
  expect(io.errs.join('\n')).toContain('--codex');
  expect(io.errs.join('\n')).toContain('hook-forward');
});
