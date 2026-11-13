import {
  ANOMALY_LABELS, NOTIFICATION_LIMITS, validateNotificationSettings,
  type Diagnostics, type NotificationKind, type NotificationSettings, type NotificationStatus,
} from '@agent-canvas/shared';
import { formatAge } from './diagnostics';

export type SentKind = NotificationKind | 'test';

export const KIND_LABELS: Record<SentKind, string> = {
  permission: '等你确认权限',
  finished: '一轮跑完了',
  error: '出错中断',
  stuck: '卡住很久',
  loop: ANOMALY_LABELS.loop.name,
  failures: ANOMALY_LABELS.failures.name,
  test: '测试通知',
};

export interface KindInfo {
  key: NotificationKind;
  label: string;
  /** One line: when it fires. */
  hint: string;
  /** What each origin can give (spec 3.2). */
  note: string;
}

export const NOTIFICATION_KINDS: readonly KindInfo[] = [
  { key: 'permission', label: KIND_LABELS.permission, hint: '会话停下来等你批准或拒绝时提醒。', note: '需要装 hooks；Cursor 没有这个状态' },
  { key: 'finished', label: KIND_LABELS.finished, hint: '一轮对话跑完、轮到你时提醒，太短的轮次不打扰。', note: 'Claude Code、Codex、Cursor 都行（Cursor 不装 hooks 会晚几秒）' },
  { key: 'error', label: KIND_LABELS.error, hint: '一轮因为出错或被中断而结束时提醒。', note: 'Claude Code、Codex 可以；Cursor 只在会话被中止时能看出来' },
  { key: 'stuck', label: KIND_LABELS.stuck, hint: '会话显示运行中，却很久没有任何动静时提醒。', note: 'Claude Code、Codex、Cursor 都行' },
];

export function sentKindLabel(kind: SentKind): string {
  return KIND_LABELS[kind] ?? kind;
}

export type NumberField = 'finishedMinSeconds' | 'stuckMinutes';

/** Parses the text of a number field: digits only, an integer within the allowed range. */
export function parseNumberField(field: NumberField, raw: string): { ok: true; value: number } | { ok: false; error: string } {
  const { min, max } = NOTIFICATION_LIMITS[field];
  const text = raw.trim();
  const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(value) || value < min || value > max) return { ok: false, error: `请填 ${min} 到 ${max} 之间的整数` };
  return { ok: true, value };
}

/** The complete settings with `patch` applied, checked by the shared validator (the server checks the same). */
export function mergeSettings(
  current: NotificationSettings,
  patch: Partial<NotificationSettings>,
): { ok: true; settings: NotificationSettings } | { ok: false; error: string } {
  return validateNotificationSettings({ ...current, ...patch });
}

function timeText(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : formatAge(nowMs - t);
}

function sentText(at: string | null, kind: SentKind | null, nowMs: number): string {
  if (at === null) return '还没有发过';
  return kind === null ? timeText(at, nowMs) : `${timeText(at, nowMs)} · ${sentKindLabel(kind)}`;
}

function errorText(error: string | null, at: string | null, nowMs: number): string | null {
  if (error === null) return null;
  return at === null ? error : `${error}（${timeText(at, nowMs)}）`;
}

export interface DeliveryLines {
  availability: string;
  lastSent: string;
  lastError: string | null;
  settingsError: string | null;
}

/** The settings page's delivery status. */
export function deliveryLines(s: NotificationStatus, nowMs: number): DeliveryLines {
  return {
    availability: s.available ? '可用' : s.lastError !== null ? `不可用：${s.lastError}` : '不可用',
    lastSent: sentText(s.lastSentAt, s.lastSentKind, nowMs),
    lastError: errorText(s.lastError, s.lastErrorAt, nowMs),
    settingsError: s.settingsError,
  };
}

/** The diagnostics page's notifications block; null when the server has none. */
export function diagnosticsNotificationLines(
  n: Diagnostics['notifications'],
  nowMs: number,
): { state: string; lastSent: string; lastError: string | null; settingsError: string | null } | null {
  if (n === undefined || n === null) return null;
  return {
    state: n.enabled ? '已开启' : '未开启',
    lastSent: sentText(n.lastSentAt, n.lastSentKind, nowMs),
    lastError: errorText(n.lastError, n.lastErrorAt, nowMs),
    settingsError: n.settingsError,
  };
}
