import type { Change, NotificationKind, NotificationSettings, Origin, Session, SessionStatus } from '@agent-canvas/shared';

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
  /** The page of a session, e.g. `http://127.0.0.1:4317/#/s/<id>`. */
  sessionUrl(sessionId: string): string;
  /**
   * Cursor only: whether a call node patched to `failed` was failed by the conversation being aborted (its note; node
   * notes are not on the change stream). Called only for main-thread Cursor calls that turn `failed`. Default: never.
   */
  isAbortedCall?(sessionId: string, nodeId: string): boolean;
}

/** Only events this recent (ms, against the injected clock) notify (spec 3.1). */
export const RECENT_MS = 2 * 60_000;
/** At most one notification of a kind per session in this window (spec 3.1). */
export const RATE_LIMIT_MS = 30_000;
/** A session the engine saw no change of for this long, and not running, is forgotten. */
export const FORGET_IDLE_MS = 60 * 60_000;
/** ... and a running one (it cannot become stuck again without a change) after this long. */
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
};

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
  /** The current (or just ended) run already produced an error notification decision: no "finished" for it. */
  errorHandled: boolean;
  /** lastActivityAt of the quiet stretch already considered for "stuck". */
  stuckFor: string | null;
  /** Kind -> engine clock of the last notification sent for this session. */
  lastSent: Partial<Record<NotificationKind, number>>;
  /** Cursor: ids of nodes belonging to a subagent thread (a node_updated does not carry agentId). */
  subagentNodes: Set<string> | null;
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

const ms = (isoTime: string): number => Date.parse(isoTime);

/**
 * Decides which desktop notifications to send (spec 3, 4, 5.1). Pure: inputs are changes (pipeline.onChanges), hook
 * events (for Claude's StopFailure, which leaves no node), the injected clock and settings; output is notifications.
 * Nothing is stored: after a restart it starts from what it sees next. The state a session is first seen in is
 * recorded without notifying.
 *
 * Error / interrupt markers (spec 3, "出错中断"), main thread only:
 * - Claude Code: a `system` node with systemSubtype `interrupt` (the "[Request interrupted by user" record); the
 *   `StopFailure` hook (handleHook).
 * - Codex: a `system` node with systemSubtype `interrupt` ("Turn failed": task_complete with an error;
 *   "Interrupted": turn_aborted).
 * - Cursor: a call node turning `failed` because the conversation was aborted (isAbortedCall: its note). An abort
 *   with no call running leaves no marker and reads as a finished turn.
 */
export class NotificationEngine {
  private readonly sessions = new Map<string, SessionState>();

  constructor(private readonly deps: EngineDeps) {}

  /** Number of sessions the engine keeps state for. */
  sessionCount(): number {
    return this.sessions.size;
  }

  /** One batch of the change stream. */
  handleChanges(changes: readonly Change[]): EngineNotification[] {
    const now = this.deps.now();
    /** Session id -> latest error marker time in this batch. */
    const markers = new Map<string, number>();
    /** Session id -> its last upsert in this batch. */
    const upserts = new Map<string, Session>();
    /** Main-thread prompt times of sessions not known yet (they are created by this batch's upsert). */
    const prompts = new Map<string, number>();
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
            if (state?.session.origin === 'cursor') (state.subagentNodes ??= new Set()).add(n.id);
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
        this.prime(session, prompts.get(session.id) ?? null, now);
        continue;
      }
      this.transition(state, session, now, out);
    }
    // Markers of sessions whose status did not change in this batch (already not running): the turn has ended.
    for (const id of markers.keys()) {
      if (upserts.has(id)) continue;
      const state = this.sessions.get(id);
      if (state !== undefined && !RUNNING.has(state.session.status)) this.settleError(state, now, out);
    }
    return out;
  }

  /**
   * A hook event, given before it is ingested. Claude Code's `StopFailure` (main thread) marks the current turn as
   * failed: notified when the session leaves running, or at once when it is not running. Others are ignored.
   */
  handleHook(origin: Origin, eventName: string, sessionId: string | null, agentId: string | null): EngineNotification[] {
    if (origin !== 'claude' || eventName !== 'StopFailure' || sessionId === null || agentId !== null) return [];
    const state = this.sessions.get(sessionId);
    if (state === undefined) return [];
    const now = this.deps.now();
    state.pendingError = now;
    const out: EngineNotification[] = [];
    if (!RUNNING.has(state.session.status)) this.settleError(state, now, out);
    return out;
  }

  /** The periodic check (every 30 s): stuck sessions; forgets sessions gone quiet. */
  tick(): EngineNotification[] {
    const now = this.deps.now();
    const out: EngineNotification[] = [];
    for (const [id, state] of this.sessions) {
      const { session } = state;
      const quietFor = now - state.seenAt;
      if (quietFor > FORGET_ANY_MS || (quietFor > FORGET_IDLE_MS && session.status !== 'running')) {
        this.sessions.delete(id);
        continue;
      }
      if (session.status !== 'running' || state.stuckFor === session.lastActivityAt) continue;
      const settings = this.readSettings();
      if (settings === null) continue;
      const thresholdMs = settings.stuckMinutes * 60_000;
      const last = ms(session.lastActivityAt);
      if (!(now - last > thresholdMs)) continue;
      state.stuckFor = session.lastActivityAt;
      const minutes = Math.floor((now - last) / 60_000);
      this.emit(state, 'stuck', last + thresholdMs, now, `已 ${minutes} 分钟没有动静`, out);
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
  private prime(session: Session, promptMs: number | null, now: number): void {
    const running = RUNNING.has(session.status);
    const last = ms(session.lastActivityAt);
    const state: SessionState = {
      session,
      seenAt: now,
      runStart: running ? (promptMs ?? (Number.isFinite(last) ? last : now)) : null,
      lastPromptMs: promptMs,
      pendingError: null,
      errorHandled: false,
      // A stretch already quiet past the threshold at first sight is skipped by the recency rule (emit).
      stuckFor: null,
      lastSent: {},
      subagentNodes: null,
    };
    this.sessions.set(session.id, state);
  }

  private transition(state: SessionState, next: Session, now: number, out: EngineNotification[]): void {
    const prev = state.session.status;
    state.session = next;
    state.seenAt = now;
    const status = next.status;
    const wasRunning = RUNNING.has(prev);
    const isRunning = RUNNING.has(status);
    if (!wasRunning && isRunning) {
      // A new run. A suppressed stretch (import) counts from the latest prompt, as at start-up.
      state.runStart = this.deps.suppressed(next.origin) && state.lastPromptMs !== null ? state.lastPromptMs : now;
      state.errorHandled = false;
      // A marker of the previous turn that never settled is not about this run.
      state.pendingError = null;
    }
    const trigger = ms(next.lastActivityAt);
    if (status === 'awaiting_permission' && prev !== 'awaiting_permission') {
      this.emit(state, 'permission', trigger, now, null, out);
    }
    if (wasRunning && !isRunning) {
      if (state.pendingError !== null && now - state.pendingError <= RECENT_MS) this.settleError(state, now, out);
      else if (!state.errorHandled && FINISHED.has(status) && state.runStart !== null) {
        const duration = now - state.runStart;
        const settings = this.readSettings();
        if (settings !== null && duration >= settings.finishedMinSeconds * 1000) {
          this.emit(state, 'finished', trigger, now, `用时 ${formatDuration(duration)}`, out);
        }
      }
      state.pendingError = null;
      state.runStart = null;
    }
  }

  /** The turn ended with an error marker: one "出错中断" (when recent), never also a "finished". */
  private settleError(state: SessionState, now: number, out: EngineNotification[]): void {
    const at = state.pendingError;
    state.pendingError = null;
    if (at === null) return;
    state.errorHandled = true;
    this.emit(state, 'error', at, now, null, out);
  }

  private readSettings(): NotificationSettings | null {
    try {
      const s = this.deps.settings();
      return typeof s === 'object' && s !== null ? s : null;
    } catch {
      return null;
    }
  }

  /** Applies every "do not send" rule of spec 3.1 / section 2, then builds the notification. */
  private emit(state: SessionState, kind: NotificationKind, triggerMs: number, now: number, extra: string | null, out: EngineNotification[]): void {
    const { session } = state;
    const settings = this.readSettings();
    if (settings === null || settings.enabled !== true || settings[kind] !== true) return;
    if (this.deps.suppressed(session.origin) || session.sourceDeleted) return;
    if (!Number.isFinite(triggerMs) || now - triggerMs > RECENT_MS) return;
    const last = state.lastSent[kind];
    if (last !== undefined && now - last < RATE_LIMIT_MS) return;
    state.lastSent[kind] = now;
    out.push(this.build(kind, session, extra));
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
