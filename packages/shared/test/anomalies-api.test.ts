import { expect, test } from 'vitest';
import {
  ANOMALY_DEFAULT_RANGE,
  ANOMALY_LIST_MAX,
  ANOMALY_NOTIFY_MAX_AGE_MS,
  ANOMALY_RANGES,
  nodeAddressHash,
} from '../src/index.js';

test('route constants: list cap 200, ranges as the stats page, default 30d, notify window 2 minutes', () => {
  expect(ANOMALY_LIST_MAX).toBe(200);
  expect(ANOMALY_RANGES).toEqual(['7d', '30d', 'all']);
  expect(ANOMALY_DEFAULT_RANGE).toBe('30d');
  expect(ANOMALY_NOTIFY_MAX_AGE_MS).toBe(120_000);
});

test('nodeAddressHash: the web node address, both parts encoded', () => {
  expect(nodeAddressHash('s1', 'n1')).toBe('#/s/s1/n/n1');
  expect(nodeAddressHash('a/b c', 'tool:x/y#1')).toBe('#/s/a%2Fb%20c/n/tool%3Ax%2Fy%231');
});
