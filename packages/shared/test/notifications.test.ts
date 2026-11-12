import { expect, test } from 'vitest';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  projectDisplayName,
  validateNotificationSettings,
  type NotificationSettings,
} from '../src/index.js';

const valid: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true };

test('默认值：总开关关，四种都开，60 秒，15 分钟', () => {
  expect(DEFAULT_NOTIFICATION_SETTINGS).toEqual({
    enabled: false,
    permission: true,
    finished: true,
    finishedMinSeconds: 60,
    error: true,
    stuck: true,
    stuckMinutes: 15,
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
  ['多余字段', { ...valid, extra: 1 }],
  ['开关不是布尔', { ...valid, enabled: 'true' }],
  ['最短时长为负', { ...valid, finishedMinSeconds: -1 }],
  ['最短时长不是整数', { ...valid, finishedMinSeconds: 1.5 }],
  ['最短时长过大', { ...valid, finishedMinSeconds: 86_401 }],
  ['卡住阈值小于 1 分钟', { ...valid, stuckMinutes: 0 }],
  ['卡住阈值过大', { ...valid, stuckMinutes: 1441 }],
  ['卡住阈值是字符串', { ...valid, stuckMinutes: '15' }],
  ['NaN', { ...valid, stuckMinutes: Number.NaN }],
])('不合法：%s', (_name, value) => {
  const r = validateNotificationSettings(value);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/\S/);
});

test('项目名：与页面相同的规则', () => {
  expect(projectDisplayName({ id: 'D--w-tea-shop', cwd: 'D:\\w\\tea-shop' })).toBe('tea-shop');
  expect(projectDisplayName({ id: '-home-u-app', cwd: '/home/u/app/' })).toBe('app');
  expect(projectDisplayName({ id: 'cursor-abc', cwd: null })).toBe('Cursor（未知目录）');
  expect(projectDisplayName({ id: 'some-id', cwd: null })).toBe('some-id');
});
