import { expect, test } from 'vitest';
import { canonicalInput, inputKeyOf, INPUT_KEY_CAP } from '../src/normalize/input-key.js';

test('inputKeyOf: 16 hex chars; insensitive to key order, nested included', () => {
  const a = inputKeyOf('Edit', { file_path: '/a.ts', opts: { x: 1, y: [1, { b: 2, a: 1 }] } });
  const b = inputKeyOf('Edit', { opts: { y: [1, { a: 1, b: 2 }], x: 1 }, file_path: '/a.ts' });
  expect(a).toMatch(/^[0-9a-f]{16}$/);
  expect(b).toBe(a);
});

test('inputKeyOf: sensitive to values, array order, numbers vs strings and the tool name', () => {
  const base = inputKeyOf('Bash', { command: 'ls', n: 1, list: [1, 2] });
  expect(inputKeyOf('Bash', { command: 'ls -a', n: 1, list: [1, 2] })).not.toBe(base);
  expect(inputKeyOf('Bash', { command: 'ls', n: '1', list: [1, 2] })).not.toBe(base);
  expect(inputKeyOf('Bash', { command: 'ls', n: 1, list: [2, 1] })).not.toBe(base);
  expect(inputKeyOf('Shell', { command: 'ls', n: 1, list: [1, 2] })).not.toBe(base);
  expect(inputKeyOf('Bash', { command: 'ls', n: 1, list: [1, 2], extra: null })).not.toBe(base);
});

test('inputKeyOf: undefined members dropped as JSON does; missing input gives no key', () => {
  expect(inputKeyOf('Bash', { command: 'ls', x: undefined })).toBe(inputKeyOf('Bash', { command: 'ls' }));
  expect(inputKeyOf('Bash', undefined)).toBeUndefined();
  expect(inputKeyOf('Bash', null)).toBeUndefined();
  expect(inputKeyOf(null, { command: 'ls' })).toMatch(/^[0-9a-f]{16}$/);
  expect(inputKeyOf(null, { command: 'ls' })).not.toBe(inputKeyOf('Bash', { command: 'ls' }));
});

test('inputKeyOf: a string input is hashed as that string', () => {
  expect(canonicalInput('git status')).toBe('git status');
  expect(inputKeyOf('shell', 'git status')).toBe(inputKeyOf('shell', 'git status'));
  expect(inputKeyOf('shell', 'git status')).not.toBe(inputKeyOf('shell', 'git diff'));
  expect(canonicalInput({ b: [1, 'x', null, true], a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":[1,"x",null,true]}');
});

test('inputKeyOf: never throws (cycles, BigInt, deep nesting): no key', () => {
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  expect(inputKeyOf('x', cyclic)).toBeUndefined();
  expect(inputKeyOf('x', { n: 10n })).toBeUndefined();
  let deep: unknown = 0;
  for (let i = 0; i < 100_000; i++) deep = [deep];
  expect(() => inputKeyOf('x', deep)).not.toThrow();
  // A repeated (not cyclic) reference is fine.
  const shared = { v: 1 };
  expect(inputKeyOf('x', { a: shared, b: shared })).toBe(inputKeyOf('x', { a: { v: 1 }, b: { v: 1 } }));
});

test('inputKeyOf: a huge input is hashed over its capped text plus its full length; cost per node measured', () => {
  const big = 'x'.repeat(1024 * 1024);
  const k1 = inputKeyOf('Write', { file_path: '/a', content: big });
  const k2 = inputKeyOf('Write', { file_path: '/a', content: `${big}y` });
  // Differs past the cap only by length: still a different key.
  expect(k1).not.toBe(k2);
  expect(INPUT_KEY_CAP).toBe(256 * 1024);
  const rounds = 20;
  const t0 = performance.now();
  for (let i = 0; i < rounds; i++) inputKeyOf('Write', { file_path: '/a', content: big, i });
  const perBig = (performance.now() - t0) / rounds;
  const small = { command: 'npx vitest run packages/server/test/input-key.test.ts', description: 'run tests', timeout: 120000 };
  const n = 20_000;
  const t1 = performance.now();
  for (let i = 0; i < n; i++) inputKeyOf('Bash', small);
  const perSmallUs = ((performance.now() - t1) / n) * 1000;
  console.log(`inputKeyOf cost: 1 MB input ${perBig.toFixed(2)} ms; typical small input ${perSmallUs.toFixed(1)} µs`);
  expect(perBig).toBeLessThan(100);
  expect(perSmallUs).toBeLessThan(500);
});
