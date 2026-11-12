import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { isNpxPath, main, packageVersion, webDistCandidates } from '../src/cli-commands.js';
import type { HooksCliIo } from '../src/hooks-cli.js';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-pkg-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fakeIo(): HooksCliIo & { out: string[]; errs: string[] } {
  const out: string[] = [];
  const errs: string[] = [];
  return { out, errs, log: (l) => out.push(l), err: (l) => errs.push(l), confirm: async () => true, isInteractive: false, now: () => new Date('2026-11-12T00:00:00Z') };
}

test('isNpxPath：npx 缓存里的路径（两种分隔符）算，全局安装和源码目录不算', () => {
  expect(isNpxPath('C:\\Users\\x\\AppData\\Local\\npm-cache\\_npx\\1a2b3c\\node_modules\\@qtxsnwwb\\agent-canvas\\dist\\cli.js')).toBe(true);
  expect(isNpxPath('/home/x/.npm/_npx/1a2b3c/node_modules/@qtxsnwwb/agent-canvas/dist/cli.js')).toBe(true);
  expect(isNpxPath('C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@qtxsnwwb\\agent-canvas\\dist\\cli.js')).toBe(false);
  expect(isNpxPath('/usr/local/lib/node_modules/@qtxsnwwb/agent-canvas/dist/cli.js')).toBe(false);
  expect(isNpxPath('D:\\Projects\\my_npx_tools\\agent-canvas\\packages\\server\\dist\\cli.js')).toBe(false);
});

test('webDistCandidates：先找发布包布局（dist 旁边的 web），再找仓库布局（packages/web/dist）', () => {
  const here = path.join('X', 'pkg', 'dist');
  expect(webDistCandidates(here)).toEqual([path.resolve('X', 'pkg', 'web'), path.resolve('X', 'web', 'dist')]);
});

test('packageVersion：取离程序最近的 package.json 的版本号', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '9.8.7' }));
  expect(packageVersion(path.join(root, 'dist'))).toBe('9.8.7');
  expect(packageVersion(path.join(tmp(), 'nowhere', 'dist'))).toBe('unknown');
});

test('--version 和 -v 打印版本号并以 0 结束；--help 打印用法并以 0 结束', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await main(['--version'])).toBe(0);
  expect(await main(['-v'])).toBe(0);
  expect(log.mock.calls.map((c) => String(c[0]))).toEqual([packageVersion(), packageVersion()]);
  expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  log.mockClear();
  expect(await main(['--help'])).toBe(0);
  expect(String(log.mock.calls[0]?.[0])).toContain('agent-canvas start');
});

test('未知命令仍然打印用法并以 1 结束', async () => {
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  expect(await main(['nonsense'])).toBe(1);
  expect(String(write.mock.calls[0]?.[0])).toContain('Usage:');
});

test('从 npx 缓存运行时拒绝安装 Codex / Cursor 的 hooks（路径不稳定），不写文件；卸载和 Claude Code 的安装不受影响', async () => {
  const dir = tmp();
  const npxCli = path.join(dir, '_npx', 'abc123', 'node_modules', '@qtxsnwwb', 'agent-canvas', 'dist', 'cli.js');
  for (const flag of ['--codex', '--cursor']) {
    const file = path.join(dir, `hooks${flag}.json`);
    const io = fakeIo();
    expect(await main(['hooks', 'install', flag, '--yes', '--settings', file], { hooksIo: io, cliPath: npxCli })).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
    expect(io.errs.join('\n')).toContain('npm install -g @qtxsnwwb/agent-canvas');
    // Uninstall is never refused for this reason (here it just finds nothing to remove).
    const un = fakeIo();
    await main(['hooks', 'uninstall', flag, '--yes', '--settings', file], { hooksIo: un, cliPath: npxCli });
    expect([...un.errs, ...un.out].join('\n')).not.toContain('npx');
  }
  const settings = path.join(dir, 'settings.json');
  fs.writeFileSync(settings, '{}\n');
  expect(await main(['hooks', 'install', '--yes', '--settings', settings], { hooksIo: fakeIo(), cliPath: npxCli })).toBe(0);
  expect(fs.readFileSync(settings, 'utf8')).toContain('/hooks');
});
