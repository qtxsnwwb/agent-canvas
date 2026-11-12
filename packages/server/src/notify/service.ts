import {
  projectDisplayName,
  validateNotificationSettings,
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
import { NotificationEngine, type EngineNotification } from './engine.js';
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
}

const realTimers: Timers = {
  setInterval: (fn, ms) => {
    const h = setInterval(fn, ms);
    h.unref();
    return h;
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface NotificationServiceDeps {
  store: Pick<Store, 'getMeta' | 'setMeta' | 'listProjects' | 'getNodeDetail'>;
  pipeline: Pick<Pipeline, 'onChanges' | 'importing' | 'pollSources' | 'pollStatus'>;
  notifier: ServiceNotifier;
  now?: () => number;
  timers?: Timers;
  /** Failure lines (stderr); never conversation content. */
  log?: (line: string) => void;
}

/**
 * Settings, engine and delivery together (spec 5): created by `start` only. start(baseUrl) subscribes the engine to
 * the change stream and starts the stuck check; close() stops both and waits for deliveries in flight (each bounded by
 * the notifier's timeout).
 */
export class NotificationService {
  private settings: NotificationSettings;
  private settingsError: string | null;
  private readonly engine: NotificationEngine;
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly log: (line: string) => void;
  private baseUrl = 'http://127.0.0.1';
  private unsubscribe: (() => void) | null = null;
  private timer: unknown = null;
  private closing: Promise<void> | null = null;
  private lastSentAt: string | null = null;
  private lastSentKind: NotificationKind | 'test' | null = null;

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
      isAbortedCall: (sessionId, nodeId) => deps.store.getNodeDetail(sessionId, nodeId)?.text === ABORTED_NOTE,
    });
  }

  /** Subscribes the engine and starts the stuck check; `baseUrl` is the page's address (`http://127.0.0.1:<port>`). */
  start(baseUrl: string): void {
    if (this.unsubscribe !== null || this.closing !== null) return;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.unsubscribe = this.deps.pipeline.onChanges((changes) => this.onChanges(changes));
    this.timer = this.timers.setInterval(() => this.guard(() => this.engine.tick()), TICK_MS);
  }

  /** A hook payload about to be ingested (Claude Code's StopFailure leaves no node; see NotificationEngine). */
  handleHook(origin: Origin, eventName: string, sessionId: string | null, agentId: string | null): void {
    if (this.unsubscribe === null) return;
    this.guard(() => this.engine.handleHook(origin, eventName, sessionId, agentId));
  }

  getSettings(): NotificationSettingsResponse {
    return { settings: { ...this.settings }, status: this.status() };
  }

  /** PUT: replaces the settings as a whole; invalid -> { ok: false, error } and nothing changes. */
  putSettings(value: unknown): { ok: true; response: NotificationSettingsResponse } | { ok: false; error: string } {
    const checked = validateNotificationSettings(value);
    if (!checked.ok) return checked;
    saveNotificationSettings(this.deps.store, checked.settings);
    this.settings = checked.settings;
    this.settingsError = null;
    return { ok: true, response: this.getSettings() };
  }

  /** Sends the test notification now, whatever the switches say. */
  async test(): Promise<NotificationTestResponse> {
    try {
      await this.deliver({ title: TEST_TITLE, body: TEST_BODY, url: `${this.baseUrl}/` }, 'test');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  status(): NotificationStatus {
    const d = this.deps.notifier.status();
    return {
      available: d.available,
      lastError: d.lastError,
      lastErrorAt: d.lastErrorAt,
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

  /** Unsubscribes, stops the timer, drops queued deliveries and waits for those in flight (bounded by their timeout). */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.unsubscribe?.();
      this.unsubscribe = null;
      if (this.timer !== null) this.timers.clearInterval(this.timer);
      this.timer = null;
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
  }

  private async deliver(message: NotificationMessage, kind: NotificationKind | 'test'): Promise<void> {
    await this.deps.notifier.notify(message);
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
