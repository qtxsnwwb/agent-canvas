import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { main } from '../src/cli.js';
import { runHooksInstall, runHooksUninstall, type HooksCliIo } from '../src/hooks-cli.js';
import { HOOK_EVENTS } from '../src/hooks-config.js';

// Every test works inside a fresh temp directory; the real ~/.claude is never touched.
let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hooks-safety-'));
  file = path.join(dir, 'sub', 'settings.json');
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

interface FakeIo extends HooksCliIo {
  outs: string[];
  errs: string[];
}
function fakeIo(interactive = false): FakeIo {
  const io: FakeIo = {
    outs: [],
    errs: [],
    out: (l) => io.outs.push(l),
    err: (l) => io.errs.push(l),
    confirm: async () => true,
    isInteractive: interactive,
    now: () => new Date(2026, 10, 10, 9, 5, 7),
  };
  return io;
}
const opts = (extra: Partial<{ port: number; yes: boolean }> = {}) => ({ settingsFile: file, port: 4317, yes: true, ...extra });
const readJson = (f = file): any => JSON.parse(fs.readFileSync(f, 'utf8'));
const listDir = (): string[] => fs.readdirSync(path.dirname(file));
function seed(content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const canSymlink = (() => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-symlink-probe-'));
  try {
    fs.writeFileSync(path.join(t, 'a'), '');
    fs.symlinkSync(path.join(t, 'a'), path.join(t, 'b'));
    return true;
  } catch {
    return false; // e.g. EPERM on Windows without privilege
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
})();

test.skipIf(!canSymlink)('符号链接的 settings 文件：链接保留，目标写入新内容，备份的是目标', async () => {
  const real = path.join(dir, 'dotfiles', 'settings.json');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, '{"theme":"dark"}');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.symlinkSync(real, file);
  expect(await runHooksInstall(opts(), fakeIo())).toBe(0);
  expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
  expect(readJson(real).theme).toBe('dark');
  expect(Object.keys(readJson(real).hooks)).toEqual([...HOOK_EVENTS]);
  expect(fs.readdirSync(path.dirname(real)).some((n) => n.startsWith('settings.json.bak-claude-canvas-'))).toBe(true);
});

test.skipIf(process.platform === 'win32')('保留原文件的权限位', async () => {
  seed('{}');
  fs.chmodSync(file, 0o600);
  await runHooksInstall(opts(), fakeIo());
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
});

test('确认期间文件被修改：不写入、不备份，返回 1', async () => {
  seed('{"theme":"dark"}');
  const io = fakeIo(true);
  io.confirm = async () => {
    fs.writeFileSync(file, '{"theme":"light"}');
    return true;
  };
  expect(await runHooksInstall(opts({ yes: false }), io)).toBe(1);
  expect(io.errs.join('\n')).toContain('设置文件在确认期间被修改，未做任何改动，请重新运行');
  expect(fs.readFileSync(file, 'utf8')).toBe('{"theme":"light"}');
  expect(listDir()).toEqual(['settings.json']);
});

test('确认期间文件出现 / 消失也算被修改', async () => {
  const io = fakeIo(true);
  io.confirm = async () => {
    seed('{"x":1}');
    return true;
  };
  expect(await runHooksInstall(opts({ yes: false }), io)).toBe(1);
  expect(fs.readFileSync(file, 'utf8')).toBe('{"x":1}');
  expect(listDir()).toEqual(['settings.json']);

  fs.rmSync(file);
  await runHooksInstall(opts(), fakeIo());
  const io2 = fakeIo(true);
  io2.confirm = async () => {
    fs.rmSync(file);
    return true;
  };
  expect(await runHooksUninstall(opts({ yes: false }), io2)).toBe(1);
  expect(fs.existsSync(file)).toBe(false);
});

test.each([['null'], ['[]'], ['"x"'], ['42']])('顶层不是对象的文件 %s：返回 1，文件未变', async (content) => {
  seed(content);
  const io = fakeIo();
  expect(await runHooksInstall(opts(), io)).toBe(1);
  expect(io.errs.join('\n')).toContain('settings');
  expect(fs.readFileSync(file, 'utf8')).toBe(content);
  expect(listDir()).toEqual(['settings.json']);
  expect(await runHooksUninstall(opts(), fakeIo())).toBe(1);
});

test('rename 失败：临时文件被清理，原文件不变，返回 1', async () => {
  seed('{"theme":"dark"}');
  vi.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw new Error('boom');
  });
  const io = fakeIo();
  expect(await runHooksInstall(opts(), io)).toBe(1);
  expect(io.errs.join('\n')).toContain('boom');
  expect(listDir().filter((n) => n.includes('.tmp-'))).toEqual([]);
  expect(fs.readFileSync(file, 'utf8')).toBe('{"theme":"dark"}');
});

test('备份失败：settings 文件不变，返回 1', async () => {
  seed('{"theme":"dark"}');
  vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
    throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
  });
  const io = fakeIo();
  expect(await runHooksInstall(opts(), io)).toBe(1);
  expect(fs.readFileSync(file, 'utf8')).toBe('{"theme":"dark"}');
  expect(listDir()).toEqual(['settings.json']);
});

test('安装后顶层键顺序不变，已有的 hooks 留在原位', async () => {
  seed('{"b":1,"hooks":{"Custom":[]},"a":2}');
  await runHooksInstall(opts(), fakeIo());
  expect(Object.keys(readJson())).toEqual(['b', 'hooks', 'a']);
});

test.each([['1e3'], ['0x10'], ['+80'], ['4317.5'], ['0'], ['65536'], [' 80'], ['']])('非法端口 %j：返回 1，不写', async (port) => {
  const io = fakeIo();
  expect(await main(['hooks', 'install', '--yes', '--port', port, '--settings', file], { hooksIo: io })).toBe(1);
  expect(fs.existsSync(file)).toBe(false);
});
