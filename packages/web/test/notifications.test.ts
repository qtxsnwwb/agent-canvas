import { expect, test } from 'vitest';
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationStatus } from '@agent-canvas/shared';
import {
  KIND_LABELS, NOTIFICATION_KINDS, deliveryLines, diagnosticsNotificationLines, mergeSettings, parseNumberField, sentKindLabel,
} from '../src/notifications';

const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const status = (over: Partial<NotificationStatus> = {}): NotificationStatus => ({
  available: true, lastError: null, lastErrorAt: null, lastSentAt: null, lastSentKind: null, settingsError: null, ...over,
});

test('四种通知都有名字、说明和各来源的提示', () => {
  expect(NOTIFICATION_KINDS.map((k) => k.key)).toEqual(['permission', 'finished', 'error', 'stuck']);
  expect(NOTIFICATION_KINDS.map((k) => k.label)).toEqual(['等你确认权限', '一轮跑完了', '出错中断', '卡住很久']);
  for (const k of NOTIFICATION_KINDS) { expect(k.hint).not.toBe(''); expect(k.note).not.toBe(''); }
  expect(NOTIFICATION_KINDS[0]!.note).toBe('需要装 hooks；Cursor 没有这个状态');
});

test('sentKindLabel 覆盖四种和测试', () => {
  expect(sentKindLabel('permission')).toBe('等你确认权限');
  expect(sentKindLabel('stuck')).toBe('卡住很久');
  expect(sentKindLabel('test')).toBe('测试通知');
  expect(KIND_LABELS.finished).toBe('一轮跑完了');
});

test('parseNumberField 校验整数和范围', () => {
  expect(parseNumberField('finishedMinSeconds', ' 90 ')).toEqual({ ok: true, value: 90 });
  expect(parseNumberField('finishedMinSeconds', '0')).toEqual({ ok: true, value: 0 });
  expect(parseNumberField('stuckMinutes', '0')).toEqual({ ok: false, error: expect.stringContaining('1') });
  expect(parseNumberField('stuckMinutes', '1441').ok).toBe(false);
  expect(parseNumberField('stuckMinutes', '1.5').ok).toBe(false);
  expect(parseNumberField('stuckMinutes', '').ok).toBe(false);
  expect(parseNumberField('stuckMinutes', 'abc').ok).toBe(false);
  expect(parseNumberField('stuckMinutes', '1e2').ok).toBe(false);
  expect(parseNumberField('stuckMinutes', '-3').ok).toBe(false);
});

test('mergeSettings 只改一处，保持完整设置；不合法则给出原因', () => {
  const r = mergeSettings(DEFAULT_NOTIFICATION_SETTINGS, { enabled: true });
  expect(r).toEqual({ ok: true, settings: { ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true } });
  expect(mergeSettings(DEFAULT_NOTIFICATION_SETTINGS, { stuckMinutes: 0 }).ok).toBe(false);
  expect(mergeSettings(DEFAULT_NOTIFICATION_SETTINGS, { stuckMinutes: 30 })).toMatchObject({ ok: true, settings: { stuckMinutes: 30 } });
  expect(DEFAULT_NOTIFICATION_SETTINGS.enabled).toBe(false);
});

test('deliveryLines 写出可用性、最近发出和最近错误', () => {
  const ok = deliveryLines(status(), NOW);
  expect(ok.availability).toBe('可用');
  expect(ok.lastSent).toBe('还没有发过');
  expect(ok.lastError).toBeNull();
  const full = deliveryLines(status({
    available: false, lastError: '找不到 notify-send', lastErrorAt: '2026-11-12T11:55:00.000Z',
    lastSentAt: '2026-11-12T11:59:30.000Z', lastSentKind: 'finished', settingsError: '设置损坏',
  }), NOW);
  expect(full.availability).toBe('不可用：找不到 notify-send');
  expect(full.lastSent).toBe('30 秒前 · 一轮跑完了');
  expect(full.lastError).toBe('找不到 notify-send（5 分钟前）');
  expect(full.settingsError).toBe('设置损坏');
});

test('不可用但没有原因时也不留空；无法识别的时间照原样给出', () => {
  expect(deliveryLines(status({ available: false }), NOW).availability).toBe('不可用');
  expect(deliveryLines(status({ lastSentAt: 'xx', lastSentKind: 'test' }), NOW).lastSent).toBe('xx · 测试通知');
});

test('diagnosticsNotificationLines：没有这个块就什么也不显示', () => {
  expect(diagnosticsNotificationLines(undefined, NOW)).toBeNull();
  const l = diagnosticsNotificationLines({ enabled: true, available: true, lastSentAt: '2026-11-12T11:58:00.000Z', lastSentKind: 'error', lastError: null, lastErrorAt: null, settingsError: null }, NOW);
  expect(l).toEqual({ state: '已开启', lastSent: '2 分钟前 · 出错中断', lastError: null, settingsError: null });
  const off = diagnosticsNotificationLines({ enabled: false, available: false, lastSentAt: null, lastSentKind: null, lastError: 'boom', lastErrorAt: '2026-11-12T11:59:00.000Z', settingsError: 'bad' }, NOW);
  expect(off).toEqual({ state: '未开启', lastSent: '还没有发过', lastError: 'boom（1 分钟前）', settingsError: 'bad' });
});

test('parseHash("#/notifications") 是通知设置页', async () => {
  const { parseHash } = await import('../src/App');
  expect(parseHash('#/notifications')).toEqual({ page: 'notifications' });
});
