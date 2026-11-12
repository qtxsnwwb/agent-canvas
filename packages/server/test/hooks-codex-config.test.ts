import { expect, test } from 'vitest';
import {
  CODEX_HOOK_EVENTS,
  CODEX_HOOK_TIMEOUT_SECONDS,
  CODEX_SHORT_HOOK_TIMEOUT_SECONDS,
  SettingsShapeError,
  codexForwardCommands,
  codexHookTarget,
  planInstallFor,
  planUninstallFor,
  posixQuote,
  windowsQuote,
} from '../src/hooks-config.js';

const NODE = '/usr/local/bin/node';
const CLI = '/opt/agent canvas/packages/server/dist/cli.js';
const target = (port = 4317, cliPath = CLI, nodePath = NODE, platform: NodeJS.Platform = 'linux') => codexHookTarget({ nodePath, cliPath, port, platform });
const timeoutOf = (e: string): number => (e === 'SessionEnd' || e === 'Interrupt' ? 3 : 5);

test('十一个事件，顺序固定；超时 5 秒（SessionEnd、Interrupt 3 秒）', () => {
  expect([...CODEX_HOOK_EVENTS]).toEqual([
    'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse',
    'SubagentStart', 'SubagentStop', 'Stop', 'PostCompact', 'Interrupt',
  ]);
  expect(CODEX_HOOK_TIMEOUT_SECONDS).toBe(5);
  expect(CODEX_SHORT_HOOK_TIMEOUT_SECONDS).toBe(3);
});

test('POSIX 引用：单引号包住，内部单引号转义', () => {
  expect(posixQuote('/a b/c')).toBe("'/a b/c'");
  expect(posixQuote("/it's/x")).toBe("'/it'\\''s/x'");
});

test('Windows 引用：双引号包住，反斜杠原样', () => {
  expect(windowsQuote('C:\\Program Files\\nodejs\\node.exe')).toBe('"C:\\Program Files\\nodejs\\node.exe"');
  expect(windowsQuote('C:\\x\\')).toBe('"C:\\x\\\\"'); // a trailing backslash must not escape the closing quote
});

test('命令：当前 node 的绝对路径 + 本安装的 cli.js + hook-forward --origin codex --port <n>', () => {
  const c = codexForwardCommands({ nodePath: NODE, cliPath: CLI, port: 4400 });
  expect(c.command).toBe("'/usr/local/bin/node' '/opt/agent canvas/packages/server/dist/cli.js' hook-forward --origin codex --port 4400");
  const w = codexForwardCommands({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', cliPath: 'D:\\My Tools\\agent-canvas\\packages\\server\\dist\\cli.js', port: 4317 });
  expect(w.commandWindows).toBe('"C:\\Program Files\\nodejs\\node.exe" "D:\\My Tools\\agent-canvas\\packages\\server\\dist\\cli.js" hook-forward --origin codex --port 4317');
  expect(w.command).toBe("'C:\\Program Files\\nodejs\\node.exe' 'D:\\My Tools\\agent-canvas\\packages\\server\\dist\\cli.js' hook-forward --origin codex --port 4317");
});

test('空文件：每个事件一条 command hook，没有 matcher，async；timeout 5（SessionEnd、Interrupt 是 3：Codex 最多允许 3 秒）', () => {
  const p = planInstallFor(target(), {});
  expect(p.added).toEqual([...CODEX_HOOK_EVENTS]);
  const { command, commandWindows } = codexForwardCommands({ nodePath: NODE, cliPath: CLI, port: 4317 });
  for (const e of CODEX_HOOK_EVENTS) {
    expect((p.next.hooks as any)[e]).toEqual([{ hooks: [{ type: 'command', command, commandWindows, async: true, timeout: timeoutOf(e) }] }]);
  }
  expect(Object.keys(p.next)).toEqual(['hooks']);
});

test('只追加、幂等；已有的其他 hooks 原样保留', () => {
  const before = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] }, other: 1 };
  const once = planInstallFor(target(), before);
  expect((once.next.hooks as any).PreToolUse[0]).toEqual(before.hooks.PreToolUse[0]);
  expect((once.next.hooks as any).PreToolUse).toHaveLength(2);
  expect(once.next.other).toBe(1);
  expect(before.hooks.PreToolUse).toHaveLength(1);
  const twice = planInstallFor(target(), once.next);
  expect(twice.added).toEqual([]);
  expect(twice.alreadyPresent).toEqual([...CODEX_HOOK_EVENTS]);
  expect(twice.next).toEqual(once.next);
});

test('别的端口、别的安装路径的条目不算已安装，也不被动；安装加在旁边', () => {
  const other = planInstallFor(target(4400), {}).next;
  const moved = planInstallFor(target(4317, '/elsewhere/cli.js'), other).next;
  const p = planInstallFor(target(), moved);
  expect(p.added).toEqual([...CODEX_HOOK_EVENTS]);
  expect((p.next.hooks as any).Stop).toHaveLength(3);
  const u = planUninstallFor(target(), p.next);
  expect(u.removed).toEqual([...CODEX_HOOK_EVENTS]);
  expect(u.next).toEqual(moved);
});

test('识别：命令里同时有本安装的 cli.js、hook-forward 和同一端口才算我们的', () => {
  const t = target();
  const ours = { type: 'command', command: `x '${CLI}' hook-forward --origin codex --port 4317` };
  expect(t.isOurs(ours)).toBe(true);
  expect(t.isOurs({ ...ours, command: `x '${CLI}' hook-forward --port 43170` })).toBe(false);
  expect(t.isOurs({ ...ours, command: `x '${CLI}' start --port 4317` })).toBe(false);
  expect(t.isOurs({ ...ours, command: `x /other/cli.js hook-forward --port 4317` })).toBe(false);
  expect(t.isOurs({ type: 'command', commandWindows: `"${CLI}" hook-forward --origin codex --port 4317` })).toBe(true);
  expect(t.isOurs({ type: 'mcp_tool', command: ours.command })).toBe(false);
  expect(t.isOurs('x')).toBe(false);
});

test('卸载：只删我们的 hook；删空的条目、事件键、hooks 键一并移除；其余原样', () => {
  const mine = planInstallFor(target(), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] }, keep: true }).next;
  const u = planUninstallFor(target(), mine);
  expect(u.next).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] }, keep: true });
  expect(planUninstallFor(target(), planInstallFor(target(), {}).next).next).toEqual({});
  expect(planUninstallFor(target(), {})).toEqual({ next: {}, removed: [] });
});

test.each([[[], 'settings'], [{ hooks: [] }, 'hooks'], [{ hooks: { PreToolUse: {} } }, 'hooks.PreToolUse'], [{ hooks: { Interrupt: 3 } }, 'hooks.Interrupt']])(
  '形状异常 %j 抛 SettingsShapeError 并指出 %s',
  (s, key) => {
    expect(() => planInstallFor(target(), s)).toThrow(SettingsShapeError);
    expect(() => planInstallFor(target(), s)).toThrow(key);
    expect(() => planUninstallFor(target(), s)).toThrow(SettingsShapeError);
  },
);

test('识别：从命令里解析出路径再比较，不按子串；--port=n 和缺省端口（4317）也认', () => {
  const t = target(4317, '/opt/cc/cli.js');
  expect(t.isOurs({ type: 'command', command: `'${NODE}' '/home/u/opt/cc/cli.js' hook-forward --port 4317` })).toBe(false);
  expect(t.isOurs({ type: 'command', command: `'${NODE}' '/opt/cc/cli.js.bak' hook-forward --port 4317` })).toBe(false);
  expect(t.isOurs({ type: 'command', command: `${NODE} /opt/cc/cli.js hook-forward --origin=codex --port=4317` })).toBe(true);
  expect(t.isOurs({ type: 'command', command: `${NODE} "/opt/cc/cli.js" hook-forward` })).toBe(true);
  expect(target(4400, '/opt/cc/cli.js').isOurs({ type: 'command', command: `${NODE} /opt/cc/cli.js hook-forward` })).toBe(false);
  expect(t.isOurs({ type: 'command', commandWindows: `"C:\\n\\node.exe" "/opt/cc/cli.js" hook-forward --port 4317` })).toBe(true);
});

test("路径里有单引号：安装幂等，卸载能找到", () => {
  const cli = "/opt/it's here/cli.js";
  const once = planInstallFor(target(4317, cli), {});
  const again = planInstallFor(target(4317, cli), once.next);
  expect(again.added).toEqual([]);
  expect(again.alreadyPresent).toEqual([...CODEX_HOOK_EVENTS]);
  expect(planUninstallFor(target(4317, cli), once.next).removed).toEqual([...CODEX_HOOK_EVENTS]);
});

test('Windows 上路径比较不分大小写（盘符、目录）；其他平台区分', () => {
  const win = (cli: string) => target(4317, cli, 'C:\\Program Files\\nodejs\\node.exe', 'win32');
  const installed = planInstallFor(win('D:\\Tools\\cc\\cli.js'), {}).next;
  const again = planInstallFor(win('d:\\tools\\CC\\cli.js'), installed);
  expect(again.added).toEqual([]);
  expect(again.alreadyPresent).toEqual([...CODEX_HOOK_EVENTS]);
  expect(planUninstallFor(win('d:\\tools\\CC\\cli.js'), installed).next).toEqual({});
  const posix = planInstallFor(target(4317, '/opt/cc/cli.js'), {}).next;
  expect(planInstallFor(target(4317, '/opt/CC/cli.js'), posix).added).toEqual([...CODEX_HOOK_EVENTS]);
});

test('我们的条目但 node 路径变了（升级 node 之后）：报告为过期；安装在同一次写入里替换它，卸载照样删除', () => {
  const old = planInstallFor(target(4317, CLI, '/old/node'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep me' }] }] } }).next;
  // One group holding our old handler next to someone else's: only ours goes.
  (old.hooks as any).PreToolUse[0].hooks.push({ type: 'command', command: 'neighbour' });
  const t = target();
  expect(t.isOurs((old.hooks as any).SessionEnd[0].hooks[0])).toBe(true);
  expect(t.isOutdated?.((old.hooks as any).SessionEnd[0].hooks[0])).toBe(true);
  const p = planInstallFor(t, old);
  expect(p.added).toEqual([]);
  expect(p.alreadyPresent).toEqual([]);
  expect(p.replaced).toEqual([...CODEX_HOOK_EVENTS]);
  const fresh = planInstallFor(t, {}).next;
  const { command } = codexForwardCommands({ nodePath: NODE, cliPath: CLI, port: 4317 });
  expect((p.next.hooks as any).SessionEnd).toEqual((fresh.hooks as any).SessionEnd);
  expect((p.next.hooks as any).Stop).toEqual([{ hooks: [{ type: 'command', command: 'keep me' }] }, ...(fresh.hooks as any).Stop]);
  expect((p.next.hooks as any).PreToolUse).toEqual([{ hooks: [{ type: 'command', command: 'neighbour' }] }, ...(fresh.hooks as any).PreToolUse]);
  expect(JSON.stringify(p.next)).not.toContain('/old/node');
  expect((p.next.hooks as any).Stop[1].hooks[0].command).toBe(command);
  // Installing again is now a no-op; uninstall removes the outdated entries just like current ones.
  expect(planInstallFor(t, p.next).replaced).toEqual([]);
  expect(planUninstallFor(t, old).removed).toEqual([...CODEX_HOOK_EVENTS]);
});
