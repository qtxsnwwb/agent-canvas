import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import type { Diagnostics } from '@claude-canvas/shared';
import { EXPECTED_HOOK_EVENTS, formatAge, summarizeDiagnostics, truncateSample, SAMPLE_DISPLAY_MAX } from '../src/diagnostics';

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const base: Diagnostics = {
  unknownRecords: [],
  lastHookAt: null,
  hookEvents: [],
  files: [],
  ingestFailures: [],
  importing: false,
  normalizerVersion: 1,
  dbEpoch: 'e',
};
const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

test('summarizeDiagnostics：从未收到 / 10 分钟内 / 更久', () => {
  expect(summarizeDiagnostics(base, NOW)).toMatchObject({ hooks: 'never', hookAgeMs: null });
  expect(summarizeDiagnostics({ ...base, lastHookAt: at(5_000) }, NOW)).toMatchObject({ hooks: 'recent', hookAgeMs: 5_000 });
  expect(summarizeDiagnostics({ ...base, lastHookAt: at(600_000) }, NOW)).toMatchObject({ hooks: 'recent' });
  expect(summarizeDiagnostics({ ...base, lastHookAt: at(600_001) }, NOW)).toMatchObject({ hooks: 'quiet', hookAgeMs: 600_001 });
  // A clock a little ahead of the server's never yields a negative age.
  expect(summarizeDiagnostics({ ...base, lastHookAt: at(-3_000) }, NOW).hookAgeMs).toBe(0);
});

test('missingHookEvents 是 14 个事件里没出现的，顺序同 EXPECTED_HOOK_EVENTS', () => {
  expect(EXPECTED_HOOK_EVENTS).toHaveLength(14);
  expect(summarizeDiagnostics(base, NOW).missingHookEvents).toEqual([...EXPECTED_HOOK_EVENTS]);
  const seen = [EXPECTED_HOOK_EVENTS[3]!, EXPECTED_HOOK_EVENTS[0]!, 'SomethingNew'];
  const d = { ...base, hookEvents: seen.map((eventName) => ({ eventName, count: 1, lastAt: at(1) })) };
  expect(summarizeDiagnostics(d, NOW).missingHookEvents).toEqual(EXPECTED_HOOK_EVENTS.filter((e) => !seen.includes(e)));
  const all = { ...base, hookEvents: EXPECTED_HOOK_EVENTS.map((eventName) => ({ eventName, count: 1, lastAt: at(1) })) };
  expect(summarizeDiagnostics(all, NOW).missingHookEvents).toEqual([]);
});

test('filesBehind 只含未读完的文件，最多 200 条；unknownTotal 是次数之和', () => {
  const files = [
    { path: 'a', offset: 10, size: 10 },
    { path: 'b', offset: 5, size: 10 },
    { path: 'c', offset: 0, size: 1 },
  ];
  const s = summarizeDiagnostics(
    { ...base, files, unknownRecords: [{ recordType: 'x', count: 3, sample: '' }, { recordType: 'y', count: 4, sample: '' }] },
    NOW,
  );
  expect(s.filesTotal).toBe(3);
  expect(s.filesBehind).toEqual([{ path: 'b', offset: 5, size: 10 }, { path: 'c', offset: 0, size: 1 }]);
  expect(s.unknownTotal).toBe(7);

  const many = Array.from({ length: 500 }, (_, i) => ({ path: `f${i}`, offset: 0, size: 1 }));
  const big = summarizeDiagnostics({ ...base, files: many }, NOW);
  expect(big.filesBehind).toHaveLength(200);
  expect(big.filesBehind[0]!.path).toBe('f0');
  expect(big.filesTotal).toBe(500);
});

test('EXPECTED_HOOK_EVENTS 与 docs/hooks-snippet.json 一致', () => {
  const file = fileURLToPath(new URL('../../../docs/hooks-snippet.json', import.meta.url));
  const snippet = JSON.parse(readFileSync(file, 'utf8')) as { hooks: Record<string, unknown> };
  expect([...EXPECTED_HOOK_EVENTS]).toEqual(Object.keys(snippet.hooks));
});

test('formatAge：秒 / 分钟 / 小时', () => {
  expect(formatAge(0)).toBe('0 秒前');
  expect(formatAge(59_999)).toBe('59 秒前');
  expect(formatAge(60_000)).toBe('1 分钟前');
  expect(formatAge(3_599_000)).toBe('59 分钟前');
  expect(formatAge(3_600_000)).toBe('1 小时前');
});

test('truncateSample 最多 2000 字符', () => {
  expect(SAMPLE_DISPLAY_MAX).toBe(2000);
  expect(truncateSample('x'.repeat(2000))).toBe('x'.repeat(2000));
  expect(truncateSample('x'.repeat(2001))).toBe('x'.repeat(2000) + '…');
});
