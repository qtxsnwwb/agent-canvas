import { DEFAULT_NOTIFICATION_SETTINGS, validateNotificationSettings, type NotificationSettings } from '@agent-canvas/shared';
import type { Store } from '../store/store.js';

/** meta key of the notification settings (JSON of NotificationSettings). */
export const NOTIFICATIONS_META_KEY = 'notifications';

/**
 * The stored settings; the defaults (off) when none are stored, and also when the stored value is not valid JSON or
 * not valid settings (then `error` says why). Never throws for what is stored; a failing read counts as unreadable.
 */
export function loadNotificationSettings(store: Pick<Store, 'getMeta'>): { settings: NotificationSettings; error: string | null } {
  let raw: string | null;
  try {
    raw = store.getMeta(NOTIFICATIONS_META_KEY);
  } catch (err) {
    return { settings: { ...DEFAULT_NOTIFICATION_SETTINGS }, error: `读取通知设置失败：${err instanceof Error ? err.message : String(err)}` };
  }
  if (raw === null) return { settings: { ...DEFAULT_NOTIFICATION_SETTINGS }, error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { settings: { ...DEFAULT_NOTIFICATION_SETTINGS }, error: '保存的通知设置已损坏（不是合法的 JSON），已按默认值（关闭）处理' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { settings: { ...DEFAULT_NOTIFICATION_SETTINGS }, error: '保存的通知设置不合法（设置必须是一个对象），已按默认值（关闭）处理' };
  }
  // Written by another version: unknown fields are ignored, missing ones take their default; wrong types or ranges
  // still make the whole object unusable.
  const known: Record<string, unknown> = { ...DEFAULT_NOTIFICATION_SETTINGS };
  for (const key of Object.keys(DEFAULT_NOTIFICATION_SETTINGS)) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) known[key] = (parsed as Record<string, unknown>)[key];
  }
  const checked = validateNotificationSettings(known);
  if (!checked.ok) return { settings: { ...DEFAULT_NOTIFICATION_SETTINGS }, error: `保存的通知设置不合法（${checked.error}），已按默认值（关闭）处理` };
  return { settings: checked.settings, error: null };
}

/** Replaces the stored settings (already validated). Throws when the database write fails. */
export function saveNotificationSettings(store: Pick<Store, 'setMeta'>, settings: NotificationSettings): void {
  store.setMeta(NOTIFICATIONS_META_KEY, JSON.stringify(settings));
}
