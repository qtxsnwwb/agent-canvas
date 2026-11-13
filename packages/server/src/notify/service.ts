import {
  nodeAddressHash,
  projectDisplayName,
  validateNotificationSettings,
  type Anomaly,
  type Diagnostics,
  type NotificationKind,
  type NotificationSettings,
  type NotificationSettingsResponse,
  type NotificationStatus,
  type NotificationTestResponse,
  type Origin,
  type SeqChange,
  type Session,
} from '@agent-canvas/shared';
import { ABORTED_NOTE } from '../normalize/cursor.js';
import type { Pipeline } from '../pipeline.js';
import type { Store } from '../store/store.js';
import type { DeliveryStatus, NotificationMessage, Notifier } from './desktop.js';
import { FORGET_ANY_MS, NotificationEngine, type EngineNotification } from './engine.js';
import { loadNotificationSettings, saveNotificationSettings } from './settings.js';

/** Period of the engine's stuck check (spec 5.1). */
export const TICK_MS = 30_000;
export const TEST_TITLE = 'Agent Canvas 测试通知';
export const TEST_BODY = '通知工作正常。';

/** What the service needs of a notifier: delivery, its state, and a bounded shutdown. */
export type ServiceNotifier = Notifier & { status(): DeliveryStatus; close(): Promise<void> };

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  setInterval: (fn, ms) => {
    const h = setInterval(fn, ms);
    h.unref();
    return h;
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface NotificationServiceDeps {
  store: Pick<Store, 'getMeta' | 'setMeta' | 'listProjects' | 'getNodeDetail' | 'liveSessions' | 'latestMainPromptAt'>;
  /** startupDone (optional for fakes; absent = done): anomaly notifications wait for it. */
  pipeline: Pick<Pipeline, 'onChanges' | 'importing' | 'pollSources' | 'pollStatus'> & { startupDone?(): boolean };
  notifier: ServiceNotifier;
  now?: () => number;
  timers?: Timers;
  /** Grace period of "finished" (engine GRACE_MS when absent). */
  graceMs?: number;
  /** Failure lines (stderr); never conversation content. */
  log?: (line: string) => void;
}

/**
 * Settings, engine and delivery together (spec 5): created by `start` only. start(baseUrl) seeds the engine with the
 * sessions the store has running, subscribes it to the change stream and starts the stuck check; close() stops all of
 * it and waits for deliveries in flight (each bounded by the notifier's timeout).
 */
export class NotificationService {
  private settings: NotificationSettings;
  private settingsError: string | null;
  private readonly engine: NotificationEngine;
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly log: (line: string) => void;
  private baseUrl = 'http://127.0.0.1';
  /** The only URLs handed to the system as a click target: this server's page (spec 4). */
  private allowedUrl: RegExp | null = null;
  private unsubscribe: (() => void) | null = null;
  private timer: unknown = null;
  /** The pending grace-period flush and when it fires. */
  private flushTimer: unknown = null;
  private flushAt: number | null = null;
  private closing: Promise<void> | null = null;
  private lastSentAt: string | null = null;
  private lastSentKind: NotificationKind | 'test' | null = null;
  /** Failures of the service itself (a notification not built, a URL refused), shown with the delivery errors. */
  private ownError: { message: string; at: string } | null = null;

  constructor(private readonly deps: NotificationServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? realTimers;
    this.log = deps.log ?? (() => {});
    const loaded = loadNotificationSettings(deps.store);
    this.settings = loaded.settings;
    this.settingsError = loaded.error;
    this.engine = new NotificationEngine({
      now: this.now,
      settings: () => this.settings,
      suppressed: (origin) => this.suppressed(origin),
      projectName: (session) => this.projectName(session),
      sessionUrl: (id) => `${this.baseUrl}/#/s/${encodeURIComponent(id)}`,
      nodeUrl: (id, nodeId) => `${this.baseUrl}/${nodeAddressHash(id, nodeId)}`,
      anomaliesReady: () => deps.pipeline.startupDone?.() ?? true,
      isAbortedCall: (sessionId, nodeId) => deps.store.getNodeDetail(sessionId, nodeId)?.text === ABORTED_NOTE,
      reportError: (message) => this.recordError(message),
      ...(deps.graceMs !== undefined ? { graceMs: deps.graceMs } : {}),
    });
  }

  /**
   * Seeds the engine with the store's running / awaiting-permission sessions (active within a day; one indexed
   * prompt lookup each, once), subscribes it and starts the stuck check. `baseUrl`: `http://127.0.0.1:<port>`.
   */
  start(baseUrl: string): void {
    if (this.unsubscribe !== null || this.closing !== null) return;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    const port = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(this.baseUrl)?.[1];
    this.allowedUrl = port !== undefined ? new RegExp(`^http://127\\.0\\.0\\.1:${port}/(#/[^\\s]*)?$`) : null;
    try {
      const since = this.now() - FORGET_ANY_MS;
      const live = this.deps.store.liveSessions().filter((s) => !s.sourceDeleted && Date.parse(s.lastActivityAt) >= since);
      this.engine.seed(live.map((session) => ({ session, lastPromptAt: this.deps.store.latestMainPromptAt(session.id) })));
    } catch (err) {
      this.log(`agent-canvas: notification start-up state unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.unsubscribe = this.deps.pipeline.onChanges((changes) => this.onChanges(changes));
    this.timer = this.timers.setInterval(() => this.guard(() => this.engine.tick()), TICK_MS);
  }

  /**
   * A hook payload about to be ingested (`payload`: its parsed JSON body). Hooks that say a turn failed or was
   * interrupted are error markers (NotificationEngine.handleHook).
   */
  handleHook(origin: Origin, eventName: string, sessionId: string | null, agentId: string | null, payload: Record<string, unknown> | null = null): void {
    if (this.unsubscribe === null) return;
    this.guard(() => this.engine.handleHook(origin, eventName, sessionId, agentId, payload));
  }

  /**
   * A session's anomaly summary was (re)computed (AnomaliesService.onSummary): new `loop` / `failures` anomalies may
   * notify (NotificationEngine.handleAnomalies). Seen anomalies are remembered from construction on, also before start().
   */
  handleAnomalies(event: { session: Session; anomalies: readonly Anomaly[]; runningUntil: number | null }): void {
    if (this.closing !== null) return;
    this.guard(() => this.engine.handleAnomalies(event.session, event.anomalies, event.runningUntil));
  }

  /** Whether a `loop` / `failures` notification could be sent now (master switch and one of the two on). */
  wantsAnomalies(): boolean {
    return this.settings.enabled && (this.settings.loop || this.settings.failures);
  }

  getSettings(): NotificationSettingsResponse {
    return { settings: { ...this.settings }, status: this.status() };
  }

  /** PUT: replaces the settings as a whole; invalid -> { ok: false, error } and nothing changes. */
  putSettings(value: unknown): { ok: true; response: NotificationSettingsResponse } | { ok: false; error: string } {
    // A page loaded before the anomaly switches existed sends no `loop` / `failures`: they keep their current values.
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const o = value as Record<string, unknown>;
      value = { ...o, ...(!('loop' in o) ? { loop: this.settings.loop } : {}), ...(!('failures' in o) ? { failures: this.settings.failures } : {}) };
    }
    const checked = validateNotificationSettings(value);
    if (!checked.ok) return checked;
    saveNotificationSettings(this.deps.store, checked.settings);
    const before = this.settings;
    this.settings = checked.settings;
    // A switch turned on (master and kind) never sends an anomaly from before it.
    const on = (s: NotificationSettings, kind: 'loop' | 'failures'): boolean => s.enabled && s[kind];
    for (const kind of ['loop', 'failures'] as const) {
      if (!on(before, kind) && on(checked.settings, kind)) this.engine.anomalySwitchedOn(kind, this.now());
    }
    this.settingsError = null;
    return { ok: true, response: this.getSettings() };
  }

  /** Sends the test notification now, whatever the switches say, also while delivery is marked unavailable. */
  async test(): Promise<NotificationTestResponse> {
    try {
      await this.deliver({ title: TEST_TITLE, body: TEST_BODY, url: `${this.baseUrl}/` }, 'test', true);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  status(): NotificationStatus {
    const d = this.deps.notifier.status();
    const own = this.ownError;
    const ownIsLater = own !== null && (d.lastErrorAt === null || own.at > d.lastErrorAt);
    return {
      available: d.available,
      lastError: ownIsLater ? own.message : d.lastError,
      lastErrorAt: ownIsLater ? own.at : d.lastErrorAt,
      lastSentAt: this.lastSentAt,
      lastSentKind: this.lastSentKind,
      settingsError: this.settingsError,
    };
  }

  diagnostics(): NonNullable<Diagnostics['notifications']> {
    const s = this.status();
    return {
      enabled: this.settings.enabled,
      available: s.available,
      lastSentAt: s.lastSentAt,
      lastSentKind: s.lastSentKind,
      lastError: s.lastError,
      lastErrorAt: s.lastErrorAt,
      settingsError: s.settingsError,
    };
  }

  /** Unsubscribes, stops the timers, drops queued deliveries and waits for those in flight (bounded by their timeout). */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.unsubscribe?.();
      this.unsubscribe = null;
      if (this.timer !== null) this.timers.clearInterval(this.timer);
      this.timer = null;
      if (this.flushTimer !== null) this.timers.clearTimeout(this.flushTimer);
      this.flushTimer = null;
      this.flushAt = null;
      await this.deps.notifier.close();
    })();
    return this.closing;
  }

  // ---------------------------------------------------------------- internals

  private onChanges(changes: SeqChange[]): void {
    this.guard(() => this.engine.handleChanges(changes));
  }

  /** Runs an engine step and delivers what it decided; an engine exception is logged, never thrown (spec 6). */
  private guard(step: () => EngineNotification[]): void {
    let out: EngineNotification[];
    try {
      out = step();
    } catch (err) {
      this.log(`agent-canvas: notification engine failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const n of out) {
      // A failure is recorded by the notifier (status); nothing else to do, no retry.
      this.deliver({ title: n.title, body: n.body, url: n.url }, n.kind).catch(() => undefined);
    }
    this.scheduleFlush();
  }

  /** Arms one timer for the earliest held "finished" (the 30 s tick also flushes, as a fallback). */
  private scheduleFlush(): void {
    if (this.closing !== null) return;
    let due: number | null;
    try {
      due = this.engine.nextDueAt();
    } catch {
      return;
    }
    if (due === null || (this.flushAt !== null && this.flushAt <= due)) return;
    if (this.flushTimer !== null) this.timers.clearTimeout(this.flushTimer);
    this.flushAt = due;
    this.flushTimer = this.timers.setTimeout(
      () => {
        this.flushTimer = null;
        this.flushAt = null;
        this.guard(() => this.engine.flushDue());
      },
      Math.max(0, due - this.now()),
    );
  }

  private recordError(message: string): void {
    this.ownError = { message, at: new Date(this.now()).toISOString() };
  }

  private async deliver(message: NotificationMessage, kind: NotificationKind | 'test', force = false): Promise<void> {
    let url = message.url;
    if (this.allowedUrl === null || !this.allowedUrl.test(url)) {
      // Never a click target that is not this server's own page; the notification still goes out.
      this.recordError('通知的网址不是本服务的页面，已去掉点击打开');
      url = '';
    }
    await this.deps.notifier.notify({ ...message, url }, force ? { force: true } : {});
    this.lastSentAt = new Date(this.now()).toISOString();
    this.lastSentKind = kind;
  }

  /** Import, rebuild, or the origin's poll source before its first completed round. */
  private suppressed(origin: Origin): boolean {
    if (this.deps.pipeline.importing()) return true;
    if (!this.deps.pipeline.pollSources().some((p) => p.origin === origin)) return false;
    return this.deps.pipeline.pollStatus(origin)?.lastPollAt == null;
  }

  /** The name the API's project list gives (store.listProjects + the web's naming rule). */
  private projectName(session: Session): string {
    const project = this.deps.store.listProjects(this.now()).find((p) => p.id === session.projectId);
    return projectDisplayName(project ?? { id: session.projectId, cwd: session.cwd });
  }
}
