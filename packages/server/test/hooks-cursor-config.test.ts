import { expect, test } from 'vitest';
import {
  CURSOR_HOOK_EVENTS,
  CURSOR_HOOK_TIMEOUT_SECONDS,
  SettingsShapeError,
  cursorForwardCommand,
  cursorHookTarget,
  planCursorInstall,
  planCursorUninstall,
  powershellQuote,
  splitPowerShell,
} from '../src/hooks-config.js';

const NODE = '/usr/local/bin/node';
const CLI = '/opt/agent canvas/packages/server/dist/cli.js';
const WNODE = 'C:\\Program Files\\nodejs\\node.exe';
const WCLI = 'D:\\My Tools\\agent-canvas\\packages\\server\\dist\\cli.js';
const posix = (port = 4317, cliPath = CLI, nodePath = NODE) => ({ nodePath, cliPath, port, platform: 'linux' as const });
const win = (port = 4317, cliPath = WCLI, nodePath = WNODE) => ({ nodePath, cliPath, port, platform: 'win32' as const });

test('五个事件，顺序固定；超时 5 秒', () => {
  expect([...CURSOR_HOOK_EVENTS]).toEqual(['sessionStart', 'beforeSubmitPrompt', 'stop', 'subagentStop', 'sessionEnd']);
  expect(CURSOR_HOOK_TIMEOUT_SECONDS).toBe(5);
});

test('命令：Windows 是 PowerShell 的调用形式 & "<node>" "<cli.js>"；其他平台是单引号的普通命令行', () => {
  expect(cursorForwardCommand(win())).toBe(
    '& "C:\\Program Files\\nodejs\\node.exe" "D:\\My Tools\\agent-canvas\\packages\\server\\dist\\cli.js" hook-forward --origin cursor --port 4317',
  );
  expect(cursorForwardCommand(posix(4400))).toBe("'/usr/local/bin/node' '/opt/agent canvas/packages/server/dist/cli.js' hook-forward --origin cursor --port 4400");
});

test('PowerShell 引用：双引号内 ` $ " 用反引号转义；拆分能还原', () => {
  expect(powershellQuote('C:\\a$b`c"d')).toBe('"C:\\a`$b``c`"d"');
  expect(splitPowerShell('& "C:\\a`$b``c`"d" \'x\'\'y\' plain "q""r"')).toEqual(['&', 'C:\\a$b`c"d', "x'y", 'plain', 'q"r']);
  const odd = 'C:\\Users\\$me\\`tick\\cli.js';
  const words = splitPowerShell(cursorForwardCommand(win(4317, odd)));
  expect(words.slice(0, 5)).toEqual(['&', WNODE, odd, 'hook-forward', '--origin']);
});

test('空文件：version 1，每个事件一条 { command, timeout: 5 }（没有 matcher 组）', () => {
  const p = planCursorInstall(cursorHookTarget(win()), {});
  expect(p.added).toEqual([...CURSOR_HOOK_EVENTS]);
  const command = cursorForwardCommand(win());
  for (const e of CURSOR_HOOK_EVENTS) expect((p.next.hooks as any)[e]).toEqual([{ command, timeout: 5 }]);
  expect(p.next).toEqual({ version: 1, hooks: expect.any(Object) });
  expect(Object.keys(p.next)).toEqual(['version', 'hooks']);
});

test('已有文件：其他键和条目原样保留，只追加；幂等；没有 version 时补 version: 1', () => {
  const before = { hooks: { stop: [{ command: 'notify-send done' }], afterFileEdit: [{ command: 'fmt' }] }, other: { a: 1 } };
  const once = planCursorInstall(cursorHookTarget(posix()), before);
  expect(once.next.version).toBe(1);
  expect(once.next.other).toEqual({ a: 1 });
  expect((once.next.hooks as any).afterFileEdit).toEqual([{ command: 'fmt' }]);
  expect((once.next.hooks as any).stop).toEqual([{ command: 'notify-send done' }, { command: cursorForwardCommand(posix()), timeout: 5 }]);
  expect(before.hooks.stop).toHaveLength(1); // input untouched
  const twice = planCursorInstall(cursorHookTarget(posix()), once.next);
  expect(twice.added).toEqual([]);
  expect(twice.alreadyPresent).toEqual([...CURSOR_HOOK_EVENTS]);
  expect(twice.next).toEqual(once.next);
});

test('version 已是 1：不改；不是 1（或不是数字 1）：拒绝', () => {
  const p = planCursorInstall(cursorHookTarget(posix()), { version: 1, hooks: {} });
  expect(p.next.version).toBe(1);
  for (const version of [2, '1', null, 0]) {
    expect(() => planCursorInstall(cursorHookTarget(posix()), { version, hooks: {} })).toThrow(SettingsShapeError);
    expect(() => planCursorUninstall(cursorHookTarget(posix()), { version, hooks: {} })).toThrow(SettingsShapeError);
  }
});

test.each([[[], 'settings'], [{ hooks: [] }, 'hooks'], [{ hooks: { stop: {} } }, 'hooks.stop'], [{ hooks: { sessionEnd: 3 } }, 'hooks.sessionEnd']])(
  '形状不对时拒绝：%j',
  (settings, key) => {
    expect(() => planCursorInstall(cursorHookTarget(posix()), settings)).toThrow(SettingsShapeError);
    expect(() => planCursorInstall(cursorHookTarget(posix()), settings)).toThrow(key);
  },
);

test('识别：两种命令形式都认；同一 cli.js、hook-forward、--origin cursor、同一端口（--port n、--port=n、缺省 4317）', () => {
  const t = cursorHookTarget(win());
  const ps = cursorForwardCommand(win());
  expect(t.isOurs({ command: ps })).toBe(true);
  expect(t.isOurs({ command: `"${WNODE}" "${WCLI}" hook-forward --origin cursor --port=4317` })).toBe(true);
  expect(t.isOurs({ command: `& "${WNODE}" "${WCLI}" hook-forward --origin cursor` })).toBe(true);
  expect(t.isOurs({ command: `'${WNODE}' '${WCLI}' hook-forward --origin cursor --port 4317` })).toBe(true); // POSIX form
  expect(t.isOurs({ command: ps.replace('4317', '4400') })).toBe(false);
  expect(t.isOurs({ command: ps.replace('--origin cursor', '--origin codex') })).toBe(false);
  expect(t.isOurs({ command: ps.replace('hook-forward', 'start') })).toBe(false);
  expect(t.isOurs({ command: `& "${WNODE}" "D:\\other\\cli.js" hook-forward --origin cursor --port 4317` })).toBe(false);
  expect(t.isOurs({ command: `echo ${WCLI} hook-forward --origin cursor` })).toBe(false); // substring is not enough
  expect(t.isOurs({ command: 42 })).toBe(false);
  expect(t.isOurs('x')).toBe(false);
});

test('Windows 上路径比较不分大小写；其他平台区分', () => {
  expect(cursorHookTarget(win()).isOurs({ command: cursorForwardCommand(win(4317, WCLI.toLowerCase().replace(/\\/g, '/'))) })).toBe(true);
  expect(cursorHookTarget(posix()).isOurs({ command: cursorForwardCommand(posix(4317, CLI.toUpperCase())) })).toBe(false);
});

test('卸载：只删本安装本端口的；删空的事件键和 hooks 键；version 和其他内容保留', () => {
  const ours = { command: cursorForwardCommand(posix()), timeout: 5 };
  const otherPort = { command: cursorForwardCommand(posix(4400)), timeout: 5 };
  const before = { version: 1, hooks: { stop: [{ command: 'notify' }, ours, otherPort], sessionEnd: [ours] }, extra: true };
  const p = planCursorUninstall(cursorHookTarget(posix()), before);
  expect(p.removed).toEqual(['stop', 'sessionEnd']);
  expect(p.next).toEqual({ version: 1, hooks: { stop: [{ command: 'notify' }, otherPort] }, extra: true });
  const all = planCursorUninstall(cursorHookTarget(posix()), { version: 1, hooks: { stop: [ours] } });
  expect(all.next).toEqual({ version: 1 });
  expect(planCursorUninstall(cursorHookTarget(posix()), {}).removed).toEqual([]);
});

test('卸载不补 version', () => {
  const ours = { command: cursorForwardCommand(posix()), timeout: 5 };
  expect(planCursorUninstall(cursorHookTarget(posix()), { hooks: { stop: [ours, { command: 'x' }] } }).next).toEqual({ hooks: { stop: [{ command: 'x' }] } });
});

test('node 路径变了（或命令形式不是本平台的）：报告为过期，安装在同一次写入里替换', () => {
  const stale = { command: cursorForwardCommand(win(4317, WCLI, 'C:\\old\\node.exe')), timeout: 5 };
  const p = planCursorInstall(cursorHookTarget(win()), { version: 1, hooks: { stop: [{ command: 'keep' }, stale] } });
  expect(p.replaced).toEqual(['stop']);
  expect((p.next.hooks as any).stop).toEqual([{ command: 'keep' }, { command: cursorForwardCommand(win()), timeout: 5 }]);
  const posixFormOnWindows = { command: `'${WNODE}' '${WCLI}' hook-forward --origin cursor --port 4317`, timeout: 5 };
  expect(planCursorInstall(cursorHookTarget(win()), { hooks: { stop: [posixFormOnWindows] } }).replaced).toEqual(['stop']);
  // Uninstall removes stale entries of this install too.
  expect(planCursorUninstall(cursorHookTarget(win()), { hooks: { stop: [stale] } }).removed).toEqual(['stop']);
});
