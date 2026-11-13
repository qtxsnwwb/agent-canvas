import {
  ANOMALY_LABELS,
  ANOMALY_NOTIFY_MAX_AGE_MS,
  anomalyBasisText,
  type Anomaly,
  type Change,
  type NotificationKind,
  type NotificationSettings,
  type Origin,
  type Session,
  type SessionStatus,
} from '@agent-canvas/shared';

/** A notification the engine decided to send (spec 4). Delivery is the Notifier's job. */
export interface EngineNotification {
  kind: NotificationKind;
  sessionId: string;
  title: string;
  body: string;
  url: string;
}

export interface EngineDeps {
  /** Current time (ms). */
  now(): number;
  /** Current settings; read at every decision (a throw or a non-object means "send nothing"). */
  settings(): NotificationSettings;
  /**
   * True while nothing may be sent for sessions of `origin`: the start-up import, a rebuild, or that origin's poll
   * source before its first completed round. State is still recorded meanwhile.
   */
  suppressed(origin: Origin): boolean;
  /** The project's display name (as the web names it). */
  projectName(session: Session): string;
  /** The page of a session, e.g. `http://127.0.0.1:4317/#/s/<id>`. May throw: that one notification is skipped. */
  sessionUrl(sessionId: string): string;
  /**
   * The page of a node, e.g. `http://127.0.0.1:4317/#/s/<id>/n/<node>` (anomaly notifications). May throw, or be absent:
   * the session's page is used instead.
   */
  nodeUrl?(sessionId: string, nodeId: string): string;
  /**
   * Cursor only: whether a call node patched to `failed` was failed by the conversation being aborted (its note; node
   * notes are not on the change stream). Called only for main-thread Cursor calls that turn `failed`. Default: never.
   */
  isAbortedCall?(sessionId: string, nodeId: string): boolean;
  /** A notification that could not be built (skipped); the message names the cause, never content. */
  reportError?(message: string): void;
  /** How long a "finished" is held for a late error marker (default GRACE_MS); 0 = not held. */
  graceMs?: number;
}

/** Only events this recent (ms, against the injected clock) notify (spec 3.1). */
export const RECENT_MS = 2 * 60_000;
/** At most one notification of a kind per session in this window (spec 3.1). */
export const RATE_LIMIT_MS = 30_000;
/** A "finished" waits this long; an error marker of the same turn arriving meanwhile replaces it (spec 3). */
export const GRACE_MS = 3_000;
/** A session the engine saw no change of for this long, and not running or awaiting permission, is forgotten. */
export const FORGET_IDLE_MS = 60 * 60_000;
/** ... and any session after this long. */
export const FORGET_ANY_MS = 24 * 60 * 60_000;
/** The session title is cut to this many characters in a notification. */
export const TITLE_MAX = 100;

const RUNNING: ReadonlySet<SessionStatus> = new Set(['running', 'awaiting_permission']);
const FINISHED: ReadonlySet<SessionStatus> = new Set(['idle', 'awaiting_input']);
const ORIGIN_LABEL: Record<Origin, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };
const KIND_LABEL: Record<NotificationKind, string> = {
  permission: '等你确认权限',
  finished: '跑完了',
  error: '出错中断',
  stuck: '卡住了',
  loop: ANOMALY_LABELS.loop.name,
  failures: ANOMALY_LABELS.failures.name,
};
/** The anomaly kinds that notify (spec 5: churn and cost never do). */
const ANOMALY_NOTIFY_KINDS: ReadonlySet<Anomaly['kind']> = new Set(['loop', 'failures']);

/**
 * Hooks that by themselves say the current turn failed or was interrupted (main thread): Claude Code `StopFailure`,
 * Codex `Interrupt`, Cursor `stop` whose `status` is `error` or `aborted`. Codex `Stop` carries no failure field.
 */
export function isErrorHook(origin: Origin, eventName: string, payload: Readonly<Record<string, unknown>> | null): boolean {
  switch (origin) {
    case 'claude':
      return eventName === 'StopFailure';
    case 'codex':
      return eventName === 'Interrupt';
    case 'cursor':
      return eventName === 'stop' && (payload?.status === 'error' || payload?.status === 'aborted');
  }
}

interface Held {
  notification: EngineNotification;
  dueAt: number;
  /** lastSent.finished before this one was decided (restored when it is replaced by an error). */
  prevLastSent: number | undefined;
}

interface SessionState {
  session: Session;
  /** Engine clock of the last change seen for the session. */
  seenAt: number;
  /** Start of the current run (running / awaiting_permission), ms; null while not running. */
  runStart: number | null;
  /** Timestamp (ms) of the latest main-thread prompt node seen. */
  lastPromptMs: number | null;
  /** An error / interrupt marker of the current turn (its event time, ms) not yet turned into a notification. */
  pendingError: number | null;
  /** The current (or just ended) run already had its error decided: no "finished", no second error for it. */
  errorHandled: boolean;
  /** lastActivityAt of the quiet stretch already considered for "stuck". */
  stuckFor: string | null;
  /** Primed from the store at start: "stuck" counts from max(lastActivityAt, this). */
  stuckBase: number | null;
  /** Kind -> engine clock of the last notification sent for this session. */
  lastSent: Partial<Record<NotificationKind, number>>;
  /** Cursor: ids of nodes belonging to a subagent thread (a node_updated does not carry agentId). */
  subagentNodes: Set<string> | null;
  /** A "finished" waiting out the grace period. */
  held: Held | null;
}

/** "5 秒", "3 分 20 秒", "3 分钟", "1 小时 5 分". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) {
    const s = total % 60;
    return s === 0 ? `${minutes} 分钟` : `${minutes} 分 ${s} 秒`;
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}

const ms = (isoTime: string | null | undefined): number => (typeof isoTime === 'string' ? Date.parse(isoTime) : Number.NaN);
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Decides which desktop notifications to send (spec 3, 4, 5.1). Pure: inputs are changes (pipeline.onChanges), hook
 * events (handleHook, before they are ingested), the sessions found running at start (seed), the injected clock and
 * settings; output is notifications. Nothing is stored. The state a session is first seen in is recorded without
 * notifying.
 *
 * Error / interrupt markers (spec 3, "出错中断"), main thread only:
 * - Claude Code: a `system` node with systemSubtype `interrupt`; the `StopFailure` hook.
 * - Codex: a `system` node with systemSubtype `interrupt` ("Turn failed" / "Interrupted"); the `Interrupt` hook.
 * - Cursor: a call node turning `failed` because the conversation was aborted (isAbortedCall); the `stop` hook with
 *   status `error` / `aborted`.
 * A "finished" is held for graceMs: a marker of the same session arriving meanwhile replaces it by one "出错中断".
 */
export class NotificationEngine {
  private readonly sessions = new Map<string, SessionState>();
  private readonly graceMs: number;
  /** When the engine (the service) started, engine clock: what a session's first anomaly summary may notify. */
  private readonly startedAt: number;
  /** Session id -> the `loop` / `failures` anomaly ids already seen (notified or not), for the life of the process. */
  private readonly anomaliesSeen = new Map<string, Set<string>>();

  constructor(private readonly deps: EngineDeps) {
    this.graceMs = Math.max(0, deps.graceMs ?? GRACE_MS);
    this.startedAt = deps.now();
  }

  /** Number of sessions the engine keeps state for. */
  sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Sessions found running or awaiting permission when the service starts (store), with the time of their latest
   * main-thread prompt: recorded as running since that prompt (else since their last activity), never notified for the
   * state found. "Stuck" for them counts from the later of their last activity and now. Known sessions are left alone.
   */
  seed(entries: readonly { session: Session; lastPromptAt: string | null }[]): void {
    const now = this.deps.now();
    for (const { session, lastPromptAt } of entries) {
      if (this.sessions.has(session.id) || session.sourceDeleted || !RUNNING.has(session.status)) continue;
      const prompt = ms(lastPromptAt);
      this.prime(session, Number.isFinite(prompt) ? prompt : null, now, null);
      this.sessions.get(session.id)!.stuckBase = now;
    }
  }

  /** One batch of the change stream. */
  handleChanges(changes: readonly Change[]): EngineNotification[] {
    const now = this.deps.now();
    /** Session id -> latest error marker time in this batch. */
    const markers = new Map<string, number>();
    /** Session id -> its last upsert in this batch. */
    const upserts = new Map<string, Session>();
    /** Main-thread prompt times and subagent node ids of sessions not known yet (created by this batch's upsert). */
    const prompts = new Map<string, number>();
    const subagentsOfNew = new Map<string, Set<string>>();
    const mark = (sessionId: string, at: number): void => {
      if (!Number.isFinite(at)) at = now;
      markers.set(sessionId, Math.max(markers.get(sessionId) ?? at, at));
    };
    for (const c of changes) {
      switch (c.type) {
        case 'session_upserted':
          upserts.set(c.session.id, c.session);
          break;
        case 'node_added': {
          const n = c.node;
          const state = this.sessions.get(n.sessionId);
          if (n.agentId !== null) {
            if (state === undefined) {
              const set = subagentsOfNew.get(n.sessionId) ?? new Set<string>();
              set.add(n.id);
              subagentsOfNew.set(n.sessionId, set);
            } else if (state.session.origin === 'cursor') (state.subagentNodes ??= new Set()).add(n.id);
            break;
          }
          if (n.kind === 'prompt') {
            const t = ms(n.timestamp);
            if (Number.isFinite(t)) {
              if (state !== undefined) state.lastPromptMs = Math.max(state.lastPromptMs ?? t, t);
              else prompts.set(n.sessionId, Math.max(prompts.get(n.sessionId) ?? t, t));
            }
          } else if (n.kind === 'system' && n.systemSubtype === 'interrupt') {
            mark(n.sessionId, ms(n.timestamp));
          } else if (n.status === 'failed' && state?.session.origin === 'cursor' && this.abortedCall(n.sessionId, n.id)) {
            mark(n.sessionId, ms(n.endedAt ?? n.timestamp));
          }
          break;
        }
        case 'node_updated': {
          if (c.patch.status !== 'failed') break;
          const state = this.sessions.get(c.sessionId);
          if (state?.session.origin !== 'cursor' || state.subagentNodes?.has(c.id) === true) break;
          if (this.abortedCall(c.sessionId, c.id)) mark(c.sessionId, c.patch.endedAt != null ? ms(c.patch.endedAt) : now);
          break;
        }
        default:
          break;
      }
    }
    const out: EngineNotification[] = [];
    for (const [id, at] of markers) {
      const state = this.sessions.get(id);
      if (state !== undefined) state.pendingError = Math.max(state.pendingError ?? at, at);
    }
    for (const session of upserts.values()) {
      const state = this.sessions.get(session.id);
      if (state === undefined) {
        this.prime(session, prompts.get(session.id) ?? null, now, subagentsOfNew.get(session.id) ?? null);
        continue;
      }
      this.transition(state, session, now, out);
    }
    // Markers of sessions that were not running before this batch and are not now (their turn already ended, possibly
    // with a "finished" held): a leave-running transition above has consumed its own.
    for (const id of markers.keys()) {
      const state = this.sessions.get(id);
      if (state !== undefined && state.pendingError !== null && !RUNNING.has(state.session.status)) this.lateError(state, now, out);
    }
    return out;
  }

  /**
   * A hook event, given before it is ingested (`payload`: the parsed body). An error hook (isErrorHook) of a known
   * session's main thread marks its current turn as failed: notified when the session leaves running, or at once when
   * it already has (replacing a held "finished"). Other hooks are ignored.
   */
  handleHook(
    origin: Origin,
    eventName: string,
    sessionId: string | null,
    agentId: string | null,
    payload: Readonly<Record<string, unknown>> | null = null,
  ): EngineNotification[] {
    if (sessionId === null || agentId !== null || !isErrorHook(origin, eventName, payload)) return [];
    const state = this.sessions.get(sessionId);
    if (state === undefined || state.session.origin !== origin) return [];
    const now = this.deps.now();
    state.pendingError = now;
    const out: EngineNotification[] = [];
    if (!RUNNING.has(state.session.status)) this.lateError(state, now, out);
    return out;
  }

  /**
   * A session's anomaly summary was (re)computed (AnomaliesService.onSummary); `running`: the session runs or left
   * running moments ago. Notifies each `loop` / `failures` anomaly (by id: one per session, turn and kind) the first
   * time it is seen, when it is at most ANOMALY_NOTIFY_MAX_AGE_MS old, the session is running and the kind's switch is on
   * (the master switch, the import suppression and a deleted source as for every kind). Every id is remembered once
   * seen, whether it notified or not, so it never notifies later. The first summary of a session in this process only
   * notifies anomalies reached after the engine started: what it finds from before (imported history, a restart in the
   * middle of a loop) is only remembered; a rebuild re-derives the same ids, already remembered.
   */
  handleAnomalies(session: Session, anomalies: readonly Anomaly[], running: boolean): EngineNotification[] {
    const now = this.deps.now();
    let seen = this.anomaliesSeen.get(session.id);
    const first = seen === undefined;
    if (seen === undefined) this.anomaliesSeen.set(session.id, (seen = new Set()));
    const out: EngineNotification[] = [];
    for (const a of anomalies) {
      if (!ANOMALY_NOTIFY_KINDS.has(a.kind) || seen.has(a.id)) continue;
      seen.add(a.id);
      const at = ms(a.at);
      if (!Number.isFinite(at) || (first && at < this.startedAt)) continue;
      if (!running || now - at > ANOMALY_NOTIFY_MAX_AGE_MS) continue;
      const kind = a.kind as 'loop' | 'failures';
      const settings = this.readSettings();
      if (settings === null || settings.enabled !== true || settings[kind] !== true) continue;
      if (this.deps.suppressed(session.origin) || session.sourceDeleted) continue;
      try {
        const n = this.build(kind, session, anomalyBasisText(a));
        out.push({ ...n, url: this.anomalyUrl(session.id, a.lastNodeId, n.url) });
      } catch (err) {
        try {
          this.deps.reportError?.(`通知未能生成（${KIND_LABEL[kind]}）：${errorMessage(err)}`);
        } catch {
          // nothing more to do
        }
      }
    }
    return out;
  }

  /** Earliest time a held "finished" is due (ms), or null when none is held. */
  nextDueAt(): number | null {
    let due: number | null = null;
    for (const state of this.sessions.values()) if (state.held !== null && (due === null || state.held.dueAt < due)) due = state.held.dueAt;
    return due;
  }

  /** The held "finished" notifications whose grace period is over. */
  flushDue(): EngineNotification[] {
    const now = this.deps.now();
    const out: EngineNotification[] = [];
    for (const state of this.sessions.values()) {
      if (state.held !== null && now >= state.held.dueAt) this.release(state, out);
    }
    return out;
  }

  /** The periodic check (every 30 s): due held notifications, stuck sessions; forgets sessions gone quiet. */
  tick(): EngineNotification[] {
    const out = this.flushDue();
    const now = this.deps.now();
    for (const [id, state] of this.sessions) {
      const { session } = state;
      const quietFor = now - state.seenAt;
      if (quietFor > FORGET_ANY_MS || (quietFor > FORGET_IDLE_MS && !RUNNING.has(session.status))) {
        this.sessions.delete(id);
        continue;
      }
      if (session.status !== 'running' || state.stuckFor === session.lastActivityAt) continue;
      const settings = this.readSettings();
      if (settings === null) continue;
      const thresholdMs = settings.stuckMinutes * 60_000;
      const last = ms(session.lastActivityAt);
      const base = state.stuckBase !== null ? Math.max(last, state.stuckBase) : last;
      if (!(now - base > thresholdMs)) continue;
      state.stuckFor = session.lastActivityAt;
      const minutes = Math.floor((now - last) / 60_000);
      const n = this.emit(state, 'stuck', base + thresholdMs, now, `已 ${minutes} 分钟没有动静`);
      if (n !== null) out.push(n);
    }
    return out;
  }

  // ---------------------------------------------------------------- internals

  private abortedCall(sessionId: string, nodeId: string): boolean {
    try {
      return this.deps.isAbortedCall?.(sessionId, nodeId) === true;
    } catch {
      return false;
    }
  }

  /** First sight of a session: its state is recorded, nothing is notified for it. */
  private prime(session: Session, promptMs: number | null, now: number, subagentNodes: Set<string> | null): void {
    const running = RUNNING.has(session.status);
    const last = ms(session.lastActivityAt);
    this.sessions.set(session.id, {
      session,
      seenAt: now,
      runStart: running ? (promptMs ?? (Number.isFinite(last) ? last : now)) : null,
      lastPromptMs: promptMs,
      pendingError: null,
      errorHandled: false,
      // A stretch already quiet past the threshold at first sight is skipped by the recency rule (emit).
      stuckFor: null,
      stuckBase: null,
      lastSent: {},
      subagentNodes: session.origin === 'cursor' ? subagentNodes : null,
      held: null,
    });
  }

  private transition(state: SessionState, next: Session, now: number, out: EngineNotification[]): void {
    const prev = state.session.status;
    state.session = next;
    state.seenAt = now;
    const status = next.status;
    const wasRunning = RUNNING.has(prev);
    const isRunning = RUNNING.has(status);
    if (!wasRunning && isRunning) {
      // A new run: a "finished" of the previous one still held is sent now (it already passed the rate limit).
      if (state.held !== null) this.release(state, out);
      // A suppressed stretch (import) counts from the latest prompt, as at start-up.
      state.runStart = this.deps.suppressed(next.origin) && state.lastPromptMs !== null ? state.lastPromptMs : now;
      state.errorHandled = false;
      // A marker of the previous turn that never settled is not about this run.
      state.pendingError = null;
    }
    const trigger = ms(next.lastActivityAt);
    if (status === 'awaiting_permission' && prev !== 'awaiting_permission') {
      const n = this.emit(state, 'permission', trigger, now, null);
      if (n !== null) out.push(n);
    }
    if (wasRunning && !isRunning) {
      // A turn with a marker is an error turn: "出错中断" (when recent), never "finished".
      if (state.pendingError !== null) this.settleError(state, now, out);
      else if (!state.errorHandled && FINISHED.has(status) && state.runStart !== null) {
        const duration = Math.max(0, now - state.runStart);
        const settings = this.readSettings();
        if (settings !== null && duration >= settings.finishedMinSeconds * 1000) {
          const prevLastSent = state.lastSent.finished;
          const n = this.emit(state, 'finished', trigger, now, `用时 ${formatDuration(duration)}`);
          if (n !== null) {
            if (this.graceMs === 0) out.push(n);
            else state.held = { notification: n, dueAt: now + this.graceMs, prevLastSent };
          }
        }
      }
      state.pendingError = null;
      state.runStart = null;
    }
  }

  /** A marker after the turn already ended: replaces a held "finished"; nothing if this turn's error was decided. */
  private lateError(state: SessionState, now: number, out: EngineNotification[]): void {
    if (state.errorHandled) {
      state.pendingError = null;
      return;
    }
    if (state.held !== null) {
      if (state.held.prevLastSent === undefined) delete state.lastSent.finished;
      else state.lastSent.finished = state.held.prevLastSent;
      state.held = null;
    }
    this.settleError(state, now, out);
  }

  /** The turn ended with an error marker: one "出错中断" (when recent), never also a "finished". */
  private settleError(state: SessionState, now: number, out: EngineNotification[]): void {
    const at = state.pendingError;
    state.pendingError = null;
    if (at === null) return;
    state.errorHandled = true;
    const n = this.emit(state, 'error', at, now, null);
    if (n !== null) out.push(n);
  }

  private anomalyUrl(sessionId: string, nodeId: string, fallback: string): string {
    if (this.deps.nodeUrl === undefined) return fallback;
    try {
      return this.deps.nodeUrl(sessionId, nodeId);
    } catch {
      return fallback;
    }
  }

  private release(state: SessionState, out: EngineNotification[]): void {
    const held = state.held;
    state.held = null;
    if (held !== null) out.push(held.notification);
  }

  private readSettings(): NotificationSettings | null {
    try {
      const s = this.deps.settings();
      return typeof s === 'object' && s !== null ? s : null;
    } catch {
      return null;
    }
  }

  /** Applies every "do not send" rule of spec 3.1 / section 2, then builds the notification (null: not sent). */
  private emit(state: SessionState, kind: NotificationKind, triggerMs: number, now: number, extra: string | null): EngineNotification | null {
    const { session } = state;
    const settings = this.readSettings();
    if (settings === null || settings.enabled !== true || settings[kind] !== true) return null;
    if (this.deps.suppressed(session.origin) || session.sourceDeleted) return null;
    if (!Number.isFinite(triggerMs) || now - triggerMs > RECENT_MS) return null;
    const last = state.lastSent[kind];
    // A clock that went backwards does not stretch the rate limit.
    if (last !== undefined && last <= now && now - last < RATE_LIMIT_MS) return null;
    let n: EngineNotification;
    try {
      n = this.build(kind, session, extra);
    } catch (err) {
      try {
        this.deps.reportError?.(`通知未能生成（${KIND_LABEL[kind]}）：${errorMessage(err)}`);
      } catch {
        // nothing more to do
      }
      return null;
    }
    state.lastSent[kind] = now;
    return n;
  }

  private build(kind: NotificationKind, session: Session, extra: string | null): EngineNotification {
    let project: string;
    try {
      project = this.deps.projectName(session);
    } catch {
      project = session.projectId;
    }
    const raw = session.title !== null && session.title.trim() !== '' ? session.title.trim() : '未命名会话';
    const chars = [...raw];
    const title = chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join('')}…` : raw;
    const tail = extra !== null ? `${extra} · ${ORIGIN_LABEL[session.origin]}` : ORIGIN_LABEL[session.origin];
    return {
      kind,
      sessionId: session.id,
      title: `${KIND_LABEL[kind]} · ${project}`,
      body: `${title}\n${tail}`,
      url: this.deps.sessionUrl(session.id),
    };
  }
}
