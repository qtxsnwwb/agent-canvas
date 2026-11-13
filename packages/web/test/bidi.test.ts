import { expect, test } from 'vitest';
import { bidiMarker, neutralizeBidi, neutralizeBidiValue } from '../src/bidi';

const RLO = String.fromCharCode(0x202e);
const LRI = String.fromCharCode(0x2066);
const RLM = String.fromCharCode(0x200f);

test('双向控制字符换成可见的标记，没有时原样返回同一个字符串', () => {
  expect(neutralizeBidi(`report${RLO}gnp.exe`)).toBe('report⟦U+202E⟧gnp.exe');
  expect(neutralizeBidi(`a${LRI}b${RLM}c`)).toBe('a⟦U+2066⟧b⟦U+200F⟧c');
  const plain = 'plain text 中文';
  expect(neutralizeBidi(plain)).toBe(plain);
  expect(bidiMarker(String.fromCharCode(0x200e))).toBe('⟦U+200E⟧');
  for (const c of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f]) {
    expect(neutralizeBidi(String.fromCharCode(c))).not.toContain(String.fromCharCode(c));
  }
  // Other format characters (zero-width joiner in emoji) are left alone.
  expect(neutralizeBidi('a\u200db')).toBe('a\u200db');
});

test('结构化的值：字符串和键都处理，没有变化时返回同一个对象，__proto__ 仍是普通的键', () => {
  const same = { a: ['x', { b: 1 }], c: null };
  expect(neutralizeBidiValue(same)).toBe(same);
  const v = neutralizeBidiValue({ [`k${RLO}`]: [`v${RLO}`, 2], n: { m: `x${RLO}` } }) as Record<string, unknown>;
  expect(JSON.stringify(v)).not.toContain(RLO);
  expect(Object.keys(v)).toEqual(['k⟦U+202E⟧', 'n']);
  const proto = neutralizeBidiValue(JSON.parse(`{"__proto__":"x${RLO}"}`)) as Record<string, unknown>;
  expect(Object.keys(proto)).toEqual(['__proto__']);
});
