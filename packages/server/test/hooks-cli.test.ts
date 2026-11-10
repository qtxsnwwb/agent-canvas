import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { main } from '../src/cli.js';
import { defaultSettingsFile, runHooksInstall, runHooksUninstall, type HooksCliIo } from '../src/hooks-cli.js';
import { HOOK_EVENTS } from '../src/hooks-config.js';

// Every test works inside a fresh temp directory; the real ~/.claude is never touched.
let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hooks-cli-'));
  file = path.join(dir, 'sub', 'settings.json');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

const NOW = new Date(2026, 10, 10, 9, 5, 7); // local time
const STAMP = '20261110-090507';

interface FakeIo extends HooksCliIo {
  outs: string[];
  errs: string[];
  questions: string[];
}
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
const opts = (extra: Partial<{ port: number; yes: boolean }> = {}) => ({ settingsFile: file, port: 4317, yes: true, ...extra });
const readJson = (f = file): any => JSON.parse(fs.readFileSync(f, 'utf8'));
const listDir = (): string[] => fs.readdirSync(path.dirname(file));
function seed(content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('defaultSettingsFile：环境变量优先，否则 ~/.claude/settings.json（只用假 env 断言）', () => {
  expect(defaultSettingsFile({ CLAUDE_CANVAS_SETTINGS_FILE: '/x/y.json' })).toBe('/x/y.json');
  expect(defaultSettingsFile({})).toBe(path.join(os.homedir(), '.claude', 'settings.json'));
});

test('文件不存在 + --yes：创建文件，含 14 个事件，返回 0，不产生备份', async () => {
  const io = fakeIo();
  expect(await runHooksInstall(opts(), io)).toBe(0);
  expect(Object.keys(readJson().hooks)).toEqual([...HOOK_EVENTS]);
  expect(listDir()).toEqual(['settings.json']);
  expect(fs.readFileSync(file, 'utf8').endsWith('}\n')).toBe(true);
  expect(io.outs.join('\n')).toContain('新开的 Claude Code 会话才会使用这些 hooks');
});

test('已有 settings + --yes：先备份（内容与原文件逐字节相同），再写入；其他键保留', async () => {
  const original = '{\n\t"theme": "dark",  "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "x"}]}]}\n}';
  seed(original);
  const io = fakeIo();
  expect(await runHooksInstall(opts(), io)).toBe(0);
  const backup = path.join(path.dirname(file), `settings.json.bak-claude-canvas-${STAMP}`);
  expect(fs.readFileSync(backup, 'utf8')).toBe(original);
  expect(Buffer.compare(fs.readFileSync(backup), Buffer.from(original))).toBe(0);
  const next = readJson();
  expect(next.theme).toBe('dark');
  expect(next.hooks.Stop[0]).toEqual({ hooks: [{ type: 'command', command: 'x' }] });
  expect(next.hooks.Stop).toHaveLength(2);
  expect(io.outs.join('\n')).toContain(backup);
});

test('交互确认为否：返回 0，文件未变，没有备份', async () => {
  seed('{"theme":"dark"}');
  const io = fakeIo({ interactive: true, answer: false });
  expect(await runHooksInstall(opts({ yes: false }), io)).toBe(0);
  expect(io.questions).toEqual(['写入以上改动？(y/N) ']);
  expect(fs.readFileSync(file, 'utf8')).toBe('{"theme":"dark"}');
  expect(listDir()).toEqual(['settings.json']);
  expect(io.outs.join('\n')).toContain('已取消，未做任何改动');
});

test('交互确认为是：写入', async () => {
  seed('{"theme":"dark"}');
  const io = fakeIo({ interactive: true, answer: true });
  expect(await runHooksInstall(opts({ yes: false }), io)).toBe(0);
  expect(Object.keys(readJson().hooks)).toEqual([...HOOK_EVENTS]);
});

test('展示将要做的事：路径、地址、事件、备份路径', async () => {
  seed('{}');
  const io = fakeIo({ interactive: true, answer: false });
  await runHooksInstall(opts({ yes: false }), io);
  const text = io.outs.join('\n');
  expect(text).toContain(file);
  expect(text).toContain('http://127.0.0.1:4317/hooks');
  for (const e of HOOK_EVENTS) expect(text).toContain(e);
  expect(text).toContain('不会改动已有的其他内容');
  expect(text).toContain(`.bak-claude-canvas-${STAMP}`);
});

test('非交互且没有 --yes：返回 1，文件未变，stderr 提到 --yes', async () => {
  seed('{"theme":"dark"}');
  const io = fakeIo({ interactive: false });
  expect(await runHooksInstall(opts({ yes: false }), io)).toBe(1);
  expect(io.errs.join('\n')).toContain('--yes');
  expect(io.questions).toEqual([]);
  expect(fs.readFileSync(file, 'utf8')).toBe('{"theme":"dark"}');
  expect(listDir()).toEqual(['settings.json']);
});

test('重复安装：第二次不写入、不备份，提示已全部安装', async () => {
  expect(await runHooksInstall(opts(), fakeIo())).toBe(0);
  const after = fs.readFileSync(file, 'utf8');
  const mtime = fs.statSync(file).mtimeMs;
  const io = fakeIo();
  expect(await runHooksInstall(opts(), io)).toBe(0);
  expect(io.outs.join('\n')).toContain('hooks 已全部安装，无需改动');
  expect(fs.readFileSync(file, 'utf8')).toBe(after);
  expect(fs.statSync(file).mtimeMs).toBe(mtime);
  expect(listDir()).toEqual(['settings.json']);
});

test('非法 JSON：返回 1，文件未变', async () => {
  seed('{ nope');
  const io = fakeIo();
  expect(await runHooksInstall(opts(), io)).toBe(1);
  expect(io.errs.join('\n')).toContain(`${file} 不是合法的 JSON：`);
  expect(fs.readFileSync(file, 'utf8')).toBe('{ nope');
  expect(listDir()).toEqual(['settings.json']);
});

test('hooks 形状异常：返回 1，文件未变，stderr 指出键名', async () => {
  seed('{"hooks":{"Stop":{}}}');
  const io = fakeIo();
  expect(await runHooksInstall(opts(), io)).toBe(1);
  expect(io.errs.join('\n')).toContain('hooks.Stop');
  expect(fs.readFileSync(file, 'utf8')).toBe('{"hooks":{"Stop":{}}}');
  expect(listDir()).toEqual(['settings.json']);
});

test('空白文件视为 {}，并备份原文件', async () => {
  seed('  \n');
  expect(await runHooksInstall(opts(), fakeIo())).toBe(0);
  expect(Object.keys(readJson().hooks)).toEqual([...HOOK_EVENTS]);
  expect(listDir()).toContain(`settings.json.bak-claude-canvas-${STAMP}`);
});

test('带 BOM、CRLF 的文件：能读；写回为 CRLF、无 BOM 亦可但必须是合法 JSON', async () => {
  seed('﻿{\r\n  "theme": "dark"\r\n}\r\n');
  expect(await runHooksInstall(opts(), fakeIo())).toBe(0);
  const text = fs.readFileSync(file, 'utf8');
  expect(text.charCodeAt(0)).not.toBe(0xfeff);
  expect(text).toContain('\r\n');
  expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  expect(JSON.parse(text).theme).toBe('dark');
  expect(Object.keys(JSON.parse(text).hooks)).toEqual([...HOOK_EVENTS]);
});

test('LF 文件写回仍是 LF', async () => {
  seed('{\n  "a": 1\n}\n');
  await runHooksInstall(opts(), fakeIo());
  expect(fs.readFileSync(file, 'utf8')).not.toContain('\r');
});

test('备份名冲突时加序号，不覆盖已有备份', async () => {
  seed('{"v":1}');
  const first = path.join(path.dirname(file), `settings.json.bak-claude-canvas-${STAMP}`);
  fs.writeFileSync(first, 'older backup');
  fs.writeFileSync(`${first}-2`, 'older backup 2');
  expect(await runHooksInstall(opts(), fakeIo())).toBe(0);
  expect(fs.readFileSync(first, 'utf8')).toBe('older backup');
  expect(fs.readFileSync(`${first}-2`, 'utf8')).toBe('older backup 2');
  expect(fs.readFileSync(`${first}-3`, 'utf8')).toBe('{"v":1}');
});

test('写入后目录里没有残留的 .tmp- 文件', async () => {
  seed('{}');
  await runHooksInstall(opts(), fakeIo());
  expect(listDir().filter((n) => n.includes('.tmp-'))).toEqual([]);
});

test('uninstall：只移除本端口的 hooks，备份后写入；没有可移除的时不写入', async () => {
  seed(JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } }));
  await runHooksInstall(opts({ port: 4400 }), fakeIo());
  await runHooksInstall(opts(), fakeIo());
  const beforeUninstall = fs.readFileSync(file, 'utf8');
  const io = fakeIo();
  expect(await runHooksUninstall(opts(), io)).toBe(0);
  const next = readJson();
  expect(next.theme).toBe('dark');
  expect(next.hooks.Stop).toHaveLength(2); // the command hook and the port 4400 hook remain
  expect(JSON.stringify(next)).not.toContain('4317');
  expect(JSON.stringify(next)).toContain('4400');
  const backups = listDir().filter((n) => n.includes('.bak-claude-canvas-'));
  expect(backups.some((n) => fs.readFileSync(path.join(path.dirname(file), n), 'utf8') === beforeUninstall)).toBe(true);

  const again = fakeIo();
  const content = fs.readFileSync(file, 'utf8');
  const count = listDir().length;
  expect(await runHooksUninstall(opts(), again)).toBe(0);
  expect(again.outs.join('\n')).toContain('没有找到指向 http://127.0.0.1:4317/hooks 的 hooks');
  expect(fs.readFileSync(file, 'utf8')).toBe(content);
  expect(listDir()).toHaveLength(count);
});

test('uninstall 文件不存在：不创建文件', async () => {
  const io = fakeIo();
  expect(await runHooksUninstall(opts(), io)).toBe(0);
  expect(fs.existsSync(file)).toBe(false);
  expect(fs.existsSync(path.dirname(file))).toBe(false);
});

test('uninstall 需要确认：非交互且没有 --yes 返回 1 且文件未变', async () => {
  await runHooksInstall(opts(), fakeIo());
  const content = fs.readFileSync(file, 'utf8');
  const io = fakeIo();
  expect(await runHooksUninstall(opts({ yes: false }), io)).toBe(1);
  expect(io.errs.join('\n')).toContain('--yes');
  expect(fs.readFileSync(file, 'utf8')).toBe(content);
});

test('--port 4400 安装的是 4400 端口的地址', async () => {
  const code = await main(['hooks', 'install', '--yes', '--port', '4400', '--settings', file], { hooksIo: fakeIo() });
  expect(code).toBe(0);
  expect(readJson().hooks.Stop[0].hooks[0].url).toBe('http://127.0.0.1:4400/hooks');
});

test('cli：hooks install / uninstall 经 --settings 走通', async () => {
  expect(await main(['hooks', 'install', '--yes', '--settings', file], { hooksIo: fakeIo() })).toBe(0);
  expect(readJson().hooks.Stop[0].hooks[0].url).toBe('http://127.0.0.1:4317/hooks');
  expect(await main(['hooks', 'uninstall', '--yes', '--settings', file], { hooksIo: fakeIo() })).toBe(0);
  expect(readJson()).toEqual({});
});

test('cli：CLAUDE_CANVAS_SETTINGS_FILE 指定的路径被使用（假 env）', async () => {
  expect(await main(['hooks', 'install', '--yes'], { hooksIo: fakeIo(), env: { CLAUDE_CANVAS_SETTINGS_FILE: file } })).toBe(0);
  expect(fs.existsSync(file)).toBe(true);
});

test('cli：非法 --port 返回 1，不写', async () => {
  const io = fakeIo();
  expect(await main(['hooks', 'install', '--yes', '--port', 'abc', '--settings', file], { hooksIo: io })).toBe(1);
  expect(io.errs.join('\n')).toContain('--port');
  expect(fs.existsSync(file)).toBe(false);
});

test('cli：`hooks` 后跟未知子命令时返回 1 并打印用法', async () => {
  for (const argv of [['hooks', 'frobnicate'], ['hooks']]) {
    const io = fakeIo();
    expect(await main(argv, { hooksIo: io, env: { CLAUDE_CANVAS_SETTINGS_FILE: file } })).toBe(1);
    expect(io.errs.join('\n')).toContain('hooks install');
    expect(io.errs.join('\n')).toContain('hooks uninstall');
  }
  expect(fs.existsSync(file)).toBe(false);
});
