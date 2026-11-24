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
  usage: '今天的用量超过提醒线',
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
  { key: 'loop', label: KIND_LABELS.loop, hint: anomalyHint('loop'), note: 'Claude Code、Codex、Cursor 都行；默认关着' },
  { key: 'failures', label: KIND_LABELS.failures, hint: anomalyHint('failures'), note: 'Claude Code、Codex、Cursor 都行；默认关着' },
  {
    key: 'usage',
    label: '今天的新输入 + 输出超过提醒线时提醒我',
    hint: '用量涨过提醒线时提醒一次，同一天同一条线只提醒一次；设线或改低线时已经超过的、服务刚启动或导入时的越线只变色，不补发。缓存读取不算在内。',
    note: '有 token 数据的都算；Cursor、豆包没有 token 数据，不算在内；Copilot CLI 要等会话退出才记总数',
  },
];

/** The two anomaly kinds: the shared one-line description, then when they fire (anomaly spec 5). */
function anomalyHint(kind: 'loop' | 'failures'): string {
  return `${ANOMALY_LABELS[kind].description}只看运行中的会话，同一轮只提醒一次。`;
}

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

/** The line is typed in 万 token: the stored value (tokens) is the typed number × LINE_UNIT. */
export const LINE_UNIT = 10_000;
/** The largest line that can be typed, in 万 token (NOTIFICATION_LIMITS.usageLineTokens.max ÷ LINE_UNIT). */
export const LINE_INPUT_MAX = NOTIFICATION_LIMITS.usageLineTokens.max / LINE_UNIT;

/**
 * The line's input text: empty for no line, else the line in 万 token. A line that is not a whole number of 万 (set by
 * an API client) is shown with its decimals, not rounded away.
 */
export function lineInputText(tokens: number): string {
  return tokens === 0 ? '' : String(tokens / LINE_UNIT);
}

/** Parses the line's input: empty (or 0) is no line (0); else an integer 1..LINE_INPUT_MAX 万 token, returned in tokens. */
export function parseLineInput(raw: string): { ok: true; value: number } | { ok: false; error: string } {
  const text = raw.trim();
  if (text === '') return { ok: true, value: 0 };
  const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(value) || value > LINE_INPUT_MAX) {
    return { ok: false, error: `请填 1 到 ${LINE_INPUT_MAX.toLocaleString('en-US')} 之间的整数（单位：万 token），空着就是不设提醒线` };
  }
  return { ok: true, value: value * LINE_UNIT };
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
