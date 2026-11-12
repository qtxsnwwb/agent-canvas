import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { main } from '../src/cli.js';
import { defaultCursorHooksFile, runCursorHooksInstall, runCursorHooksUninstall, type HooksCliIo } from '../src/hooks-cli.js';
import { CURSOR_HOOK_EVENTS, cursorForwardCommand } from '../src/hooks-config.js';

// Every test works inside a fresh temp directory: the real ~/.cursor/hooks.json is never read or written. The guard at
// the bottom records every path the fs functions used by the install code were called with during this file.
const REAL_DEFAULT = path.join(os.homedir(), '.cursor', 'hooks.json');
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
  const real = [REAL_DEFAULT, path.join(os.homedir(), '.claude', 'settings.json'), path.join(os.homedir(), '.codex', 'hooks.json')].map((p) =>
    path.resolve(p).toLowerCase(),
  );
  expect(touched.filter((p) => real.some((r) => p.toLowerCase().startsWith(r)))).toEqual([]);
});

let dir: string;
let cursorDir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cursor-hooks-'));
  cursorDir = path.join(dir, '.cursor');
  fs.mkdirSync(cursorDir);
  file = path.join(cursorDir, 'hooks.json');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

const NOW = new Date(2026, 10, 12, 9, 5, 7);
const STAMP = '20261112-090507';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const CLI = 'D:\\agent canvas\\packages\\server\\dist\\cli.js';

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
const opts = (extra: Partial<{ port: number; yes: boolean; settingsFile: string; cliPath: string; nodePath: string; platform: NodeJS.Platform }> = {}) => ({
  settingsFile: file, port: 4317, yes: true, nodePath: NODE, cliPath: CLI, platform: 'win32' as NodeJS.Platform, ...extra,
});
const readJson = (f = file): any => JSON.parse(fs.readFileSync(f, 'utf8'));
const listDir = (): string[] => fs.readdirSync(cursorDir).sort();
const seed = (content: string): void => fs.writeFileSync(file, content);
const COMMAND = cursorForwardCommand({ nodePath: NODE, cliPath: CLI, port: 4317, platform: 'win32' });

test('defaultCursorHooksFile：环境变量优先，否则 ~/.cursor/hooks.json（只用假 env 断言，不读写）', () => {
  expect(defaultCursorHooksFile({ AGENT_CANVAS_CURSOR_HOOKS_FILE: '/x/hooks.json' })).toBe('/x/hooks.json');
  expect(defaultCursorHooksFile({ AGENT_CANVAS_CURSOR_HOOKS_FILE: '' })).toBe(REAL_DEFAULT);
  expect(defaultCursorHooksFile({})).toBe(REAL_DEFAULT);
});

test('文件不存在：说明会新建，写入 version 1 和 5 个事件，不备份；列出命令', async () => {
  const io = fakeIo();
  expect(await runCursorHooksInstall(opts(), io)).toBe(0);
  const text = io.outs.join('\n');
  expect(text).toContain(`将新建 ${file}`);
  expect(readJson()).toEqual({ version: 1, hooks: Object.fromEntries(CURSOR_HOOK_EVENTS.map((e) => [e, [{ command: COMMAND, timeout: 5 }]])) });
  expect(listDir()).toEqual(['hooks.json']);
  expect(text).toContain(COMMAND);
  expect(text).toContain('Cursor');
});

test('POSIX 平台：单引号的普通命令行', async () => {
  expect(await runCursorHooksInstall(opts({ platform: 'linux', nodePath: '/usr/bin/node', cliPath: '/opt/cc/cli.js' }), fakeIo())).toBe(0);
  expect(readJson().hooks.stop).toEqual([{ command: "'/usr/bin/node' '/opt/cc/cli.js' hook-forward --origin cursor --port 4317", timeout: 5 }]);
});

test('~/.cursor 目录不存在：说明 Cursor 似乎没有安装，返回 1，什么都不创建', async () => {
  const missing = path.join(dir, 'nope', 'hooks.json');
  const io = fakeIo();
  expect(await runCursorHooksInstall(opts({ settingsFile: missing }), io)).toBe(1);
  expect(io.errs.join('\n')).toContain('Cursor 似乎没有安装');
  expect(fs.existsSync(path.dirname(missing))).toBe(false);
});

test('已有 hooks.json：备份（逐字节相同）后写入，已有内容保留，没有 version 时补上', async () => {
  const original = '{\n  "hooks": {\n    "stop": [{ "command": "notify" }],\n    "afterFileEdit": [{ "command": "fmt", "timeout": 9 }]\n  },\n  "x": [1, 2]\n}\n';
  seed(original);
  const io = fakeIo();
  expect(await runCursorHooksInstall(opts(), io)).toBe(0);
  const backup = path.join(cursorDir, `hooks.json.bak-agent-canvas-${STAMP}`);
  expect(fs.readFileSync(backup, 'utf8')).toBe(original);
  const j = readJson();
  expect(j.version).toBe(1);
  expect(j.x).toEqual([1, 2]);
  expect(j.hooks.afterFileEdit).toEqual([{ command: 'fmt', timeout: 9 }]);
  expect(j.hooks.stop).toEqual([{ command: 'notify' }, { command: COMMAND, timeout: 5 }]);
  expect(io.outs.join('\n')).toContain(backup);
});

test('重复安装：不写入、不备份', async () => {
  expect(await runCursorHooksInstall(opts(), fakeIo())).toBe(0);
  const after = fs.readFileSync(file, 'utf8');
  const io = fakeIo();
  expect(await runCursorHooksInstall(opts(), io)).toBe(0);
  expect(io.outs.join('\n')).toContain('hooks 已全部安装，无需改动');
  expect(fs.readFileSync(file, 'utf8')).toBe(after);
  expect(listDir()).toEqual(['hooks.json']);
});

test('已安装但 node 路径过期：同一次写入里替换', async () => {
  seed('{"version": 1}');
  expect(await runCursorHooksInstall(opts({ nodePath: 'C:\\old\\node.exe' }), fakeIo())).toBe(0);
  const io = fakeIo();
  expect(await runCursorHooksInstall(opts(), io)).toBe(0);
  const text = io.outs.join('\n');
  expect(text).toContain('过期');
  expect(text).toContain(`将替换的事件（${CURSOR_HOOK_EVENTS.length}）`);
  expect(readJson().hooks.stop).toEqual([{ command: COMMAND, timeout: 5 }]);
  expect(fs.readFileSync(file, 'utf8')).not.toContain('old');
});

test('确认：非交互且没有 --yes 返回 1；交互回答否不写', async () => {
  seed('{}');
  const noTty = fakeIo();
  expect(await runCursorHooksInstall(opts({ yes: false }), noTty)).toBe(1);
  expect(noTty.errs.join('\n')).toContain('--yes');
  const no = fakeIo({ interactive: true, answer: false });
  expect(await runCursorHooksInstall(opts({ yes: false }), no)).toBe(0);
  expect(fs.readFileSync(file, 'utf8')).toBe('{}');
  expect(listDir()).toEqual(['hooks.json']);
});

test.each([
  ['{ nope', '不是合法的 JSON'],
  ['[]', 'settings'],
  ['{"version": 2, "hooks": {}}', 'version'],
  ['{"version": "1"}', 'version'],
  ['{"hooks":{"stop":{}}}', 'hooks.stop'],
  ['{"n": 9007199254740993}', '无法无损读写的数字'],
  ['{"a": 1, "a": 2}', '重复的键'],
])('不寻常的文件 %s：拒绝写入，返回 1，文件未变', async (content, message) => {
  seed(content);
  for (const run of [runCursorHooksInstall, runCursorHooksUninstall]) {
    const io = fakeIo();
    const code = await run(opts(), io);
    // Uninstall of a valid-JSON file without our entries has nothing to remove (and so writes nothing).
    if (run === runCursorHooksUninstall && code === 0) continue;
    expect(code).toBe(1);
    expect(io.errs.join('\n')).toContain(message);
  }
  expect(fs.readFileSync(file, 'utf8')).toBe(content);
  expect(listDir()).toEqual(['hooks.json']);
});

test('卸载：只删本安装本端口的；别的端口 / 别的路径 / 别的条目保留', async () => {
  seed(JSON.stringify({ version: 1, hooks: { stop: [{ command: 'notify' }] } }));
  await runCursorHooksInstall(opts({ port: 4400 }), fakeIo());
  await runCursorHooksInstall(opts({ cliPath: 'D:\\elsewhere\\cli.js' }), fakeIo());
  await runCursorHooksInstall(opts(), fakeIo());
  expect(readJson().hooks.stop).toHaveLength(4);
  const io = fakeIo();
  expect(await runCursorHooksUninstall(opts(), io)).toBe(0);
  const stop = readJson().hooks.stop.map((e: any) => e.command);
  expect(stop).toHaveLength(3);
  expect(stop[0]).toBe('notify');
  expect(stop[1]).toContain('--port 4400');
  expect(stop[2]).toContain('elsewhere');
  expect(readJson().version).toBe(1);
  const again = fakeIo();
  const content = fs.readFileSync(file, 'utf8');
  expect(await runCursorHooksUninstall(opts(), again)).toBe(0);
  expect(again.outs.join('\n')).toContain('没有找到');
  expect(fs.readFileSync(file, 'utf8')).toBe(content);
});

test('卸载：文件不存在时不创建；~/.cursor 不存在时也不报错', async () => {
  expect(await runCursorHooksUninstall(opts(), fakeIo())).toBe(0);
  expect(fs.existsSync(file)).toBe(false);
  expect(await runCursorHooksUninstall(opts({ settingsFile: path.join(dir, 'nope', 'hooks.json') }), fakeIo())).toBe(0);
  expect(fs.existsSync(path.join(dir, 'nope'))).toBe(false);
});

test('cli：hooks install / uninstall --cursor 经 --settings 走通；命令指向当前 node 和 cli.js', async () => {
  const cliPath = path.join(dir, 'pkg', 'cli.js');
  expect(await main(['hooks', 'install', '--cursor', '--yes', '--port', '4400', '--settings', file], { hooksIo: fakeIo(), cliPath })).toBe(0);
  const hook = readJson().hooks.sessionEnd[0];
  expect(hook).toEqual({ command: cursorForwardCommand({ nodePath: process.execPath, cliPath, port: 4400 }), timeout: 5 });
  expect(await main(['hooks', 'uninstall', '--cursor', '--yes', '--port=4400', '--settings', file], { hooksIo: fakeIo(), cliPath })).toBe(0);
  expect(readJson()).toEqual({ version: 1 });
});

test('cli：AGENT_CANVAS_CURSOR_HOOKS_FILE 指定的路径被使用（假 env）；--codex 和 --cursor 不能同时用', async () => {
  const codexFile = path.join(dir, 'codex', 'hooks.json');
  const claudeFile = path.join(dir, 'claude', 'settings.json');
  const env = { AGENT_CANVAS_CURSOR_HOOKS_FILE: file, AGENT_CANVAS_CODEX_HOOKS_FILE: codexFile, AGENT_CANVAS_SETTINGS_FILE: claudeFile };
  expect(await main(['hooks', 'install', '--cursor', '--yes'], { hooksIo: fakeIo(), env })).toBe(0);
  expect(Object.keys(readJson().hooks)).toEqual([...CURSOR_HOOK_EVENTS]);
  const io = fakeIo();
  expect(await main(['hooks', 'install', '--cursor', '--codex', '--yes'], { hooksIo: io, env })).toBe(1);
  expect(io.errs.join('\n')).toContain('--cursor');
  expect(fs.existsSync(codexFile)).toBe(false);
  expect(fs.existsSync(claudeFile)).toBe(false);
});

test('cli：用法里列出 --cursor 和 hook-forward 的 cursor 来源', async () => {
  const io = fakeIo();
  expect(await main(['hooks', 'nope'], { hooksIo: io, env: { AGENT_CANVAS_CURSOR_HOOKS_FILE: file } })).toBe(1);
  expect(io.errs.join('\n')).toContain('--cursor');
  expect(io.errs.join('\n')).toContain('claude|codex|cursor');
});
