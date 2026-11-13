import type { Project } from './model.js';

/**
 * The occasions a desktop notification is sent for (spec 3; `loop` and `failures`: anomaly spec 5); `test` is the
 * settings panel's test notification.
 */
export type NotificationKind = 'permission' | 'finished' | 'error' | 'stuck' | 'loop' | 'failures';

/** Stored in the `meta` table under `notifications` (JSON). Replaced as a whole by PUT /api/notifications/settings. */
export interface NotificationSettings {
  /** Master switch; off by default (an npm install must not start notifying unasked). */
  enabled: boolean;
  /** A session starts waiting for a permission decision. */
  permission: boolean;
  /** A turn finished that ran for at least finishedMinSeconds. */
  finished: boolean;
  /** Integer, 0..NOTIFICATION_LIMITS.finishedMinSeconds.max; 0 = every turn. */
  finishedMinSeconds: number;
  /** A turn ended in an error or was interrupted. */
  error: boolean;
  /** A running session has had no activity for stuckMinutes. */
  stuck: boolean;
  /** Integer, 1..NOTIFICATION_LIMITS.stuckMinutes.max. */
  stuckMinutes: number;
  /** A running session's turn starts going round in circles (anomaly `loop`). Off by default. */
  loop: boolean;
  /** A running session's turn has a streak of failed calls (anomaly `failures`). Off by default. */
  failures: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: Readonly<NotificationSettings> = Object.freeze({
  enabled: false,
  permission: true,
  finished: true,
  finishedMinSeconds: 60,
  error: true,
  stuck: true,
  stuckMinutes: 15,
  loop: false,
  failures: false,
});

/** Inclusive integer ranges of the two thresholds. */
export const NOTIFICATION_LIMITS = Object.freeze({
  finishedMinSeconds: { min: 0, max: 86_400 },
  stuckMinutes: { min: 1, max: 1440 },
});

const BOOLEAN_FIELDS = ['enabled', 'permission', 'finished', 'error', 'stuck', 'loop', 'failures'] as const;
const NUMBER_FIELDS = ['finishedMinSeconds', 'stuckMinutes'] as const;
const FIELDS: readonly string[] = [...BOOLEAN_FIELDS, ...NUMBER_FIELDS];

/**
 * Checks a complete settings object: every field present with its type, the thresholds integers in range, no other
 * field. The error is a short Chinese sentence naming the field.
 */
export function validateNotificationSettings(value: unknown): { ok: true; settings: NotificationSettings } | { ok: false; error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, error: '设置必须是一个对象' };
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(o)) if (!FIELDS.includes(key)) return { ok: false, error: `未知字段：${key}` };
  for (const key of BOOLEAN_FIELDS) if (typeof o[key] !== 'boolean') return { ok: false, error: `${key} 必须是 true 或 false` };
  for (const key of NUMBER_FIELDS) {
    const v = o[key];
    const { min, max } = NOTIFICATION_LIMITS[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      return { ok: false, error: `${key} 必须是 ${min} 到 ${max} 之间的整数` };
    }
  }
  const settings: NotificationSettings = {
    enabled: o.enabled as boolean,
    permission: o.permission as boolean,
    finished: o.finished as boolean,
    finishedMinSeconds: o.finishedMinSeconds as number,
    error: o.error as boolean,
    stuck: o.stuck as boolean,
    stuckMinutes: o.stuckMinutes as number,
    loop: o.loop as boolean,
    failures: o.failures as boolean,
  };
  return { ok: true, settings };
}

/** Delivery state of desktop notifications (GET /api/notifications/settings, Diagnostics.notifications). */
export interface NotificationStatus {
  /**
   * False once delivery failed because the platform is unsupported or the system command is missing (lastError says
   * why); delivery is retried at most every 10 minutes after that. True before any attempt.
   */
  available: boolean;
  /** Last delivery failure (any cause) and when (ISO 8601); null when none. */
  lastError: string | null;
  lastErrorAt: string | null;
  /** Last successful delivery (ISO 8601) and its kind; null when none since the service started. */
  lastSentAt: string | null;
  lastSentKind: NotificationKind | 'test' | null;
  /** Why the stored settings could not be used (defaults, i.e. off, apply then); null when they were fine or absent. */
  settingsError: string | null;
}

/** GET /api/notifications/settings and the 200 answer of PUT. */
export interface NotificationSettingsResponse {
  settings: NotificationSettings;
  status: NotificationStatus;
}

/** POST /api/notifications/test (always HTTP 200: a delivery failure is not a client error). */
export type NotificationTestResponse = { ok: true } | { ok: false; error: string };

/** Display name of a Cursor project whose working directory could not be found (same text as the web's). */
export const CURSOR_UNKNOWN_PROJECT_NAME = 'Cursor（未知目录）';

/**
 * A project's display name, by the web's rule (home.ts projectTitle): the last segment of its directory (either
 * separator), else of its id; a Cursor project without a directory is "Cursor（未知目录）".
 */
export function projectDisplayName(project: Pick<Project, 'id' | 'cwd'>): string {
  if (project.cwd === null && project.id.startsWith('cursor-')) return CURSOR_UNKNOWN_PROJECT_NAME;
  const pathOrId = project.cwd ?? project.id;
  const parts = pathOrId.split(/[\\/]+/).filter((x) => x !== '');
  return parts[parts.length - 1] ?? pathOrId;
}
