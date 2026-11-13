import { describe, expect, test } from 'vitest';
import { CorruptBodyError, decodeBody, encodeBody, PLAIN_BELOW_BYTES } from '../src/store/codec.js';

const roundTrip = (text: string): string => {
  const { data, enc } = encodeBody(text);
  return decodeBody(data, enc);
};

describe('codec', () => {
  test('空串、短串原样存为文本', () => {
    expect(encodeBody('')).toEqual({ data: '', enc: 0 });
    expect(encodeBody('{"type":"user"}')).toEqual({ data: '{"type":"user"}', enc: 0 });
    expect(roundTrip('')).toBe('');
  });

  test('长文本压缩存放，往返逐字一致', () => {
    const text = JSON.stringify({ type: 'assistant', text: 'hello world '.repeat(500) });
    const { data, enc } = encodeBody(text);
    expect(enc).toBe(1);
    expect(Buffer.isBuffer(data)).toBe(true);
    expect((data as Buffer).length).toBeLessThan(text.length / 4);
    expect(decodeBody(data, enc)).toBe(text);
  });

  test('多字节字符与代理对', () => {
    const text = `中文内容🙂${'混合 text 😀 \u0000 � '.repeat(100)}`;
    expect(roundTrip(text)).toBe(text);
    expect(encodeBody(text).enc).toBe(1);
  });

  test('看起来像二进制的文本（控制字符、全部 0-255 码位）', () => {
    let text = '';
    for (let i = 0; i < 2048; i++) text += String.fromCharCode(i % 256);
    expect(roundTrip(text)).toBe(text);
    const lone = `a\uD800b${'x'.repeat(300)}`; // a lone surrogate is not valid UTF-16: stored as UTF-8 it becomes U+FFFD
    expect(roundTrip(lone)).toBe(Buffer.from(lone, 'utf8').toString('utf8'));
  });

  test('200 字节的分界（按 UTF-8 字节，不按字符数）', () => {
    expect(PLAIN_BELOW_BYTES).toBe(200);
    const below = 'a'.repeat(199);
    const at = 'a'.repeat(200);
    expect(encodeBody(below).enc).toBe(0);
    expect(encodeBody(at).enc).toBe(1);
    // 67 three-byte characters = 201 bytes though only 67 characters
    const cjk = '中'.repeat(67);
    expect(Buffer.byteLength(cjk)).toBe(201);
    expect(encodeBody(cjk).enc).toBe(1);
    expect(encodeBody('中'.repeat(66)).enc).toBe(0); // 198 bytes
    for (const t of [below, at, cjk]) expect(roundTrip(t)).toBe(t);
  });

  test('压缩后不变小的文本仍按原文存放', () => {
    // pseudo-random printable text: deflate cannot shrink it below its own size + overhead
    let x = 12345;
    let text = '';
    for (let i = 0; i < 300; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      text += String.fromCharCode(33 + (x % 94));
    }
    const { data, enc } = encodeBody(text);
    if (enc === 0) expect(data).toBe(text);
    expect(decodeBody(data, enc)).toBe(text);
  });

  test('旧行：enc 0 的文本原样返回；enc 0 却是 Buffer 时按 UTF-8 读', () => {
    expect(decodeBody('{"a":1}', 0)).toBe('{"a":1}');
    expect(decodeBody(Buffer.from('{"a":1}'), 0)).toBe('{"a":1}');
  });

  test('损坏的行抛出可识别的 CorruptBodyError', () => {
    expect(() => decodeBody(Buffer.from([1, 2, 3, 4, 5, 6, 7]), 1)).toThrow(CorruptBodyError);
    expect(() => decodeBody('text where a blob belongs', 1)).toThrow(CorruptBodyError);
    expect(() => decodeBody('x', 7)).toThrow(CorruptBodyError);
    expect(() => decodeBody(null, 0)).toThrow(CorruptBodyError);
    const { data } = encodeBody('y'.repeat(5000));
    const truncated = (data as Buffer).subarray(0, (data as Buffer).length - 3);
    expect(() => decodeBody(truncated, 1)).toThrow(CorruptBodyError);
  });
});
