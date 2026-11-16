import { expect, test } from 'vitest';
import { unknownTypeName } from '../src/normalize/unknown-type.js';

test('origin prefix, allowed characters only, cut to 60', () => {
  expect(unknownTypeName('gemini', 'info')).toBe('gemini:info');
  expect(unknownTypeName('grok', '$rewindTo')).toBe('grok:$rewindTo');
  expect(unknownTypeName('copilot', 'session.model_change/v2-x')).toBe('copilot:session.model_change/v2-x');
  expect(unknownTypeName('copilot', 'a b<c>"d\'\n')).toBe('copilot:abcd');
  expect(unknownTypeName('gemini', 'x'.repeat(100))).toBe(`gemini:${'x'.repeat(60)}`);
});

test('not a string, or nothing left: <origin>:?', () => {
  expect(unknownTypeName('gemini', undefined)).toBe('gemini:?');
  expect(unknownTypeName('grok', 42)).toBe('grok:?');
  expect(unknownTypeName('copilot', { type: 'x' })).toBe('copilot:?');
  expect(unknownTypeName('gemini', '')).toBe('gemini:?');
  expect(unknownTypeName('gemini', '中文 !')).toBe('gemini:?');
});
