import { expect, test } from 'vitest';
import { planInstall, planUninstall } from '../src/hooks-config.js';

test('hooks 下名为 __proto__ 的自有键在安装与卸载中原样保留', () => {
  const settings = JSON.parse('{"hooks":{"__proto__":{"x":1},"Stop":[]}}');
  const check = (next: Record<string, unknown>) => {
    const h = next.hooks as object;
    expect(Object.getPrototypeOf(h)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(h, '__proto__')?.value).toEqual({ x: 1 });
  };
  const installed = planInstall(settings, 4317);
  check(installed.next);
  check(planUninstall(installed.next, 4317).next);
});

test('__proto__ 事件是数组且含我们的 hook 时，卸载后仍是自有键', () => {
  const ours = '{"type":"http","url":"http://127.0.0.1:4317/hooks"}';
  const settings = JSON.parse(`{"hooks":{"__proto__":[{"hooks":[${ours},{"type":"command","command":"x"}]}]}}`);
  const u = planUninstall(settings, 4317);
  const h = u.next.hooks as object;
  expect(Object.getPrototypeOf(h)).toBe(Object.prototype);
  expect(Object.getOwnPropertyDescriptor(h, '__proto__')?.value).toEqual([{ hooks: [{ type: 'command', command: 'x' }] }]);
});

test('constructor 键同样保留', () => {
  const settings = JSON.parse('{"hooks":{"constructor":[1]}}');
  const next = planInstall(settings, 4317).next.hooks as Record<string, unknown>;
  expect(Object.getOwnPropertyDescriptor(next, 'constructor')?.value).toEqual([1]);
});
