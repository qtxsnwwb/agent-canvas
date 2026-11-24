import { expect, test } from 'vitest';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_LIMITS,
  projectDisplayName,
  validateNotificationSettings,
  type NotificationSettings,
} from '../src/index.js';

const valid: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true };

test('默认值：总开关关，四种都开，60 秒，15 分钟；两种异常默认关', () => {
  expect(DEFAULT_NOTIFICATION_SETTINGS).toEqual({
    enabled: false,
    permission: true,
    finished: true,
    finishedMinSeconds: 60,
    error: true,
    stuck: true,
    stuckMinutes: 15,
    loop: false,
    failures: false,
    usage: true,
    usageLineTokens: 0,
  });
});

test('合法的设置原样通过', () => {
  expect(validateNotificationSettings(valid)).toEqual({ ok: true, settings: valid });
  expect(validateNotificationSettings({ ...valid, finishedMinSeconds: 0, stuckMinutes: 1 }).ok).toBe(true);
});

test.each([
  ['不是对象', null],
  ['数组', []],
  ['缺字段', { ...valid, stuck: undefined }],
  ['缺异常开关', { ...valid, loop: undefined }],
  ['异常开关不是布尔', { ...valid, failures: 1 }],
  ['多余字段', { ...valid, extra: 1 }],
  ['开关不是布尔', { ...valid, enabled: 'true' }],
  ['最短时长为负', { ...valid, finishedMinSeconds: -1 }],
  ['最短时长不是整数', { ...valid, finishedMinSeconds: 1.5 }],
  ['最短时长过大', { ...valid, finishedMinSeconds: 86_401 }],
  ['卡住阈值小于 1 分钟', { ...valid, stuckMinutes: 0 }],
  ['卡住阈值过大', { ...valid, stuckMinutes: 1441 }],
  ['卡住阈值是字符串', { ...valid, stuckMinutes: '15' }],
  ['NaN', { ...valid, stuckMinutes: Number.NaN }],
  ['缺用量开关', { ...valid, usage: undefined }],
  ['用量开关不是布尔', { ...valid, usage: 'true' }],
  ['缺提醒线', { ...valid, usageLineTokens: undefined }],
  ['提醒线为负', { ...valid, usageLineTokens: -1 }],
  ['提醒线不是整数', { ...valid, usageLineTokens: 1.5 }],
  ['提醒线过大', { ...valid, usageLineTokens: 100_000_000_001 }],
  ['提醒线是字符串', { ...valid, usageLineTokens: '2000000' }],
])('不合法：%s', (_name, value) => {
  const r = validateNotificationSettings(value);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/\S/);
});

test('两种异常开关原样通过', () => {
  const on = { ...valid, loop: true, failures: true };
  expect(validateNotificationSettings(on)).toEqual({ ok: true, settings: on });
});

test('用量开关和提醒线：0（没有线）和上限都合法', () => {
  expect(NOTIFICATION_LIMITS.usageLineTokens).toEqual({ min: 0, max: 100_000_000_000 });
  for (const usageLineTokens of [0, 1, 2_000_000, 100_000_000_000]) {
    const v = { ...valid, usage: false, usageLineTokens };
    expect(validateNotificationSettings(v)).toEqual({ ok: true, settings: v });
  }
});

test('项目名：与页面相同的规则', () => {
  expect(projectDisplayName({ id: 'D--w-tea-shop', cwd: 'D:\\w\\tea-shop' })).toBe('tea-shop');
  expect(projectDisplayName({ id: '-home-u-app', cwd: '/home/u/app/' })).toBe('app');
  expect(projectDisplayName({ id: 'cursor-abc', cwd: null })).toBe('Cursor（未知目录）');
  expect(projectDisplayName({ id: 'some-id', cwd: null })).toBe('some-id');
});
