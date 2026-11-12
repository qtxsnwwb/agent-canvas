import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { HOOK_EVENTS, HOOK_TIMEOUT_SECONDS, SettingsShapeError, hookUrl, planInstall, planUninstall } from '../src/hooks-config.js';

const ours = (port: number) => ({ type: 'http', url: `http://127.0.0.1:${port}/hooks`, timeout: 2 });

test('hookUrl 与超时常量', () => {
  expect(hookUrl(4317)).toBe('http://127.0.0.1:4317/hooks');
  expect(HOOK_TIMEOUT_SECONDS).toBe(2);
});

test('空 settings：加上全部 14 个事件', () => {
  const p = planInstall({}, 4317);
  expect(HOOK_EVENTS).toHaveLength(14);
  expect(p.added).toEqual([...HOOK_EVENTS]);
  expect((p.next.hooks as any).PreToolUse).toEqual([{ hooks: [{ type: 'http', url: 'http://127.0.0.1:4317/hooks', timeout: 2 }] }]);
  expect(Object.keys(p.next.hooks as object)).toEqual([...HOOK_EVENTS]);
});
test('undefined / null 视为空 settings', () => {
  expect(planInstall(undefined, 4317).added).toEqual([...HOOK_EVENTS]);
  expect(planInstall(null, 4317).added).toEqual([...HOOK_EVENTS]);
  expect(planUninstall(undefined, 4317)).toEqual({ next: {}, removed: [] });
});
test('保留其他键和已有 hooks，只在事件数组末尾追加', () => {
  const before = { theme: 'dark', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] } };
  const p = planInstall(before, 4317);
  expect(p.next.theme).toBe('dark');
  expect((p.next.hooks as any).PreToolUse[0]).toEqual(before.hooks.PreToolUse[0]);
  expect((p.next.hooks as any).PreToolUse).toHaveLength(2);
  expect((p.next.hooks as any).PreToolUse[1]).toEqual({ hooks: [ours(4317)] });
  expect(before.hooks.PreToolUse).toHaveLength(1); // 入参未被修改
  expect(Object.keys(before.hooks)).toEqual(['PreToolUse']);
});
test('重复安装不产生重复项', () => {
  const once = planInstall({}, 4317).next;
  const twice = planInstall(once, 4317);
  expect(twice.added).toEqual([]);
  expect(twice.alreadyPresent).toEqual([...HOOK_EVENTS]);
  expect(twice.next).toEqual(once);
});
test('部分已存在：只补缺的事件', () => {
  const before = { hooks: { Stop: [{ hooks: [ours(4317)] }] } };
  const p = planInstall(before, 4317);
  expect(p.alreadyPresent).toEqual(['Stop']);
  expect(p.added).toEqual(HOOK_EVENTS.filter((e) => e !== 'Stop'));
  expect((p.next.hooks as any).Stop).toHaveLength(1);
});
test('另一个端口的 agent-canvas hook 不算已存在，也不被改动', () => {
  const other = planInstall({}, 4400).next;
  const p = planInstall(other, 4317);
  expect(p.added).toEqual([...HOOK_EVENTS]);
  expect(p.alreadyPresent).toEqual([]);
  expect((p.next.hooks as any).Stop).toEqual([{ hooks: [ours(4400)] }, { hooks: [ours(4317)] }]);
});
test('HOOK_EVENTS 与 docs/hooks-snippet.json 的事件一致', () => {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'hooks-snippet.json');
  const snippet = JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks: Record<string, unknown> };
  expect([...HOOK_EVENTS]).toEqual(Object.keys(snippet.hooks));
});
test.each([[[], 'settings'], ['x', 'settings'], [{ hooks: [] }, 'hooks'], [{ hooks: { Stop: {} } }, 'hooks.Stop']])('形状异常 %j 抛 SettingsShapeError 并指出 %s', (s, key) => {
  expect(() => planInstall(s, 4317)).toThrow(SettingsShapeError);
  expect(() => planInstall(s, 4317)).toThrow(key);
  expect(() => planUninstall(s, 4317)).toThrow(SettingsShapeError);
});
test('无关事件的值不被检查；卸载时我们的事件值非数组仍报错', () => {
  expect(() => planInstall({ hooks: { Custom: 5 } }, 4317)).not.toThrow();
  expect(() => planUninstall({ hooks: { Custom: 5 } }, 4317)).not.toThrow();
  expect(() => planUninstall({ hooks: { Stop: 'x' } }, 4317)).toThrow('hooks.Stop');
});
test('卸载只删本端口的 http hook；删空的条目、事件键、hooks 键一并移除；其余原样', () => {
  const s = planInstall({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } }, 4317).next;
  const u = planUninstall(s, 4317);
  expect(u.next).toEqual({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } });
  expect(u.removed).toEqual([...HOOK_EVENTS]);
  expect(planUninstall(planInstall({}, 4317).next, 4317).next).toEqual({});
});
test('卸载不动别的端口的 hook；没有可删的时 removed 为空且 next 与入参深相等', () => {
  const s = planInstall({ theme: 'dark' }, 4400).next;
  const before = structuredClone(s);
  const u = planUninstall(s, 4317);
  expect(u.removed).toEqual([]);
  expect(u.next).toEqual(before);
  expect(s).toEqual(before);
});
test('同一条目里既有我们的 hook 又有别的 hook：只删我们的那个', () => {
  const other = { type: 'command', command: 'echo' };
  const s = { hooks: { Stop: [{ matcher: 'm', hooks: [other, ours(4317)] }] } };
  const u = planUninstall(s, 4317);
  expect(u.removed).toEqual(['Stop']);
  expect(u.next).toEqual({ hooks: { Stop: [{ matcher: 'm', hooks: [other] }] } });
  expect(s.hooks.Stop[0]!.hooks).toHaveLength(2);
});
