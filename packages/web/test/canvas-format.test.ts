import { expect, test } from 'vitest';
import { formatDuration } from '../src/canvas/format';

test.each([[850, '850ms'], [3400, '3.4s'], [59999, '60.0s'], [125000, '2分05秒'], [-1, ''], [Number.NaN, '']])('formatDuration(%s)', (ms, s) => {
  expect(formatDuration(ms)).toBe(s);
});
