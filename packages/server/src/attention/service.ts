import {
  ATTENTION_LIMITS,
  ATTENTION_UNDETERMINABLE_ORIGINS,
  DEFAULT_NOTIFICATION_SETTINGS,
  sortAttention,
  validateAutoHideHours,
  type AttentionHidden,
  type AttentionItem,
  type AttentionResponse,
  type Change,
  type GraphNode,
  type Origin,
  type Session,
  type SessionStatus,
} from '@agent-canvas/shared';
import { cursorHookConversationId } from '../normalize/cursor-hooks.js';
import { isErrorHook, isErrorMarkerNode } from '../notify/markers.js';
import type { Store } from '../store/store.js';
import { decideAttention, type SessionMarks } from './decide.js';

/** meta key of the page's stored state: JSON of { autoHideHours, dismissed: string[] } (spec 4.4). */
export const ATTENTION_META_KEY = 'attention';
/**
 * At start (and when a session is re-read) at most this many of a session's newest main-thread nodes since its latest
 * prompt are read. Error markers end a turn, so they are among them; a turn's longer head is never needed.
 */
export const TAIL_LIMIT = 500;
/** Changes arriving within this many ms are pushed as one update (onUpdate). */
export const COALESCE_MS = 100;

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const KEEP_MS = ATTENTION_LIMITS.keepDays * DAY_MS;
/** Origins whose hooks can mark a turn as failed (isErrorHook). */
const HOOK_ORIGINS: ReadonlySet<Origin> = new Set(['claude', 'codex', 'cursor']);
const IDLE: ReadonlySet<SessionStatus> = new Set(['idle', 'awaiting_input']);
const UNDETERMINABLE: ReadonlySet<Origin> = new Set(ATTENTION_UNDETERMINABLE_ORIGINS);
/** Patch fields after which a tracked node no longer fits what it was kept for (re-read the session). */
const PROMPT_FIELDS = ['timestamp', 'kind', 'agentId'] as const;
const LAST_FIELDS = ['timestamp', 'agentId'] as const;
const REPLY_FIELDS = ['timestamp', 'kind', 'agentId'] as const;
const ERROR_FIELDS = ['timestamp', 'kind', 'agentId', 'status', 'systemSubtype', 'endedAt'] as const;
/** Patch fields that may turn any node into a prompt, a reply or an error marker. */
const ROLE_FIELDS = ['kind', 'agentId', 'systemSubtype'] as const;

/**
 * When an error marker node marks its turn as failed, as the notification engine dates it (engine.ts handleChanges,
 * node_added: an interrupt node from its own time, an aborted Cursor call from its end). One difference: for a Cursor call
 * patched to `failed` without an `endedAt` the engine takes the time it sees the change; here the stored node's
 * `endedAt ?? timestamp` is taken, so the item's `since` (and key) is the same after a restart.
 */
export function errorMarkerAt(node: Pick<GraphNode, 'kind' | 'systemSubtype' | 'timestamp' | 'endedAt'>): string {
  return node.kind === 'system' && node.systemSubtype === 'interrupt' ? node.timestamp : (node.endedAt ?? node.timestamp);
}

const msOf = (iso: string | null | undefined): number => {
  const t = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
};

/** A node kept for the marks: its id, time and the fields its explanation is made of. */
interface Kept {
  id: string;
  timestamp: string;
  ms: number;
  title: string;
  summary: string;
  toolName: string | null;
}
const keep = (n: GraphNode): Kept => ({ id: n.id, timestamp: n.timestamp, ms: msOf(n.timestamp), title: n.title, summary: n.summary, toolName: n.toolName });

/** Per-session state (spec 4.2): the few nodes the decision needs, maintained from the change stream. */
interface Tracked {
  session: Session;
  /** Latest main-thread prompt; id null when not read (the tail was cut before it). */
  prompt: { id: string | null; at: string; ms: number } | null;
  last: Kept | null;
  reply: Kept | null;
  error: (Kept & { at: string; atMs: number }) | null;
  hookError: { at: string; ms: number } | null;
  /** receivedAt of the latest hook read (the next read starts there). */
  hooksReadTo: string | null;
  waiting: Map<string, Kept>;
  /** What the session last contributed to the response (change detection for onUpdate). */
  view: string;
}

export interface AttentionServiceDeps {
  store: Pick<Store, 'getMeta' | 'setMeta' | 'getSession' | 'sessionsActiveSince' | 'latestMainPromptAt' | 'mainTailNodes' | 'awaitingPermissionNodes' | 'hookEventsSince'>;
  /** Current time (ms). */
  now(): number;
  /** The notification settings' stuckMinutes (read at every decision, also while notifications are off). */
  stuckMinutes(): number;
  /** Cursor: whether a failed call was failed by the conversation being aborted (as notify/service.ts answers it). */
  isAbortedCall(sessionId: string, nodeId: string): boolean;
  /** Coalescing window of onUpdate (default COALESCE_MS). */
  coalesceMs?: number;
}

type Result = { ok: true } | { ok: false; error: string };

/**
 * Which sessions wait for the user (attention spec 3, 4): per-session marks kept in memory, loaded at construction for
 * the sessions active within ATTENTION_LIMITS.keepDays and maintained from the change stream (noteChanges), each change
 * costing O(1) store work except the rare ones that make a session be re-read (a tracked node removed or moved; one
 * session's batch larger than TAIL_LIMIT, as a rebuild's; a Cursor call aborted). Re-reading a session is a handful of
 * indexed reads, never its whole graph. Dismissals and the auto-hide limit are kept in meta (ATTENTION_META_KEY).
 */
export class AttentionService {
  private readonly tracked = new Map<string, Tracked>();
  private readonly listeners = new Set<(r: AttentionResponse) => void>();
  private readonly coalesceMs: number;
  private autoHideHours: number = ATTENTION_LIMITS.autoHideHours.default;
  private dismissed = new Set<string>();
  private lastJson: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly deps: AttentionServiceDeps) {
    this.coalesceMs = Math.max(0, deps.coalesceMs ?? COALESCE_MS);
    this.loadStored();
    const now = deps.now();
    let sessions: Session[] = [];
    try {
      sessions = deps.store.sessionsActiveSince(new Date(now - KEEP_MS).toISOString());
    } catch {
      // nothing at start; changes fill it in
    }
    for (const s of sessions) {
      try {
        this.load(s.id, s);
      } catch {
        this.tracked.delete(s.id);
      }
    }
    for (const id of this.tracked.keys()) this.refreshView(id);
    this.lastJson = JSON.stringify(this.snapshot());
  }

  /** One batch of the change stream (pipeline.onChanges); already applied to the store. */
  noteChanges(changes: readonly Change[]): void {
    if (this.closed) return;
    const bySession = new Map<string, Change[]>();
    for (const c of changes) {
      const id = sessionIdOf(c);
      const list = bySession.get(id);
      if (list === undefined) bySession.set(id, [c]);
      else list.push(c);
    }
    let changed = false;
    for (const [id, list] of bySession) {
      const before = this.tracked.get(id)?.view ?? '';
      try {
        this.applySession(id, list);
      } catch {
        this.tracked.delete(id); // re-read on its next change
      }
      if (this.refreshView(id) !== before) changed = true;
    }
    if (changed) this.scheduleFlush();
  }

  /**
   * A session re-derived from its raw events behind the change stream (pipeline.onResync: only its session row is
   * announced): read again from the store.
   */
  noteResync(sessionId: string): void {
    if (this.closed) return;
    const before = this.tracked.get(sessionId)?.view ?? '';
    try {
      this.load(sessionId);
    } catch {
      this.tracked.delete(sessionId);
    }
    if (this.refreshView(sessionId) !== before) this.scheduleFlush();
  }

  snapshot(): AttentionResponse {
    const now = this.deps.now();
    const keepFrom = now - KEEP_MS;
    const hideFrom = now - this.autoHideHours * HOUR_MS;
    const stuck = this.stuckMinutes();
    const items: AttentionItem[] = [];
    const hidden: AttentionHidden[] = [];
    const undeterminable: (AttentionResponse['undeterminable'][number] & { at: number })[] = [];
    let runningCount = 0;
    for (const t of this.tracked.values()) {
      if (!isCandidate(t, keepFrom)) continue;
      const s = t.session;
      if (UNDETERMINABLE.has(s.origin)) {
        undeterminable.push({ sessionId: s.id, title: s.title, origin: s.origin, at: t.last!.ms });
        continue;
      }
      const item = decideAttention(this.marks(t), now, stuck);
      if (item === null) {
        if (s.status === 'running') runningCount += 1;
        continue;
      }
      const since = msOf(item.since);
      if (this.dismissed.has(item.key)) {
        if (since >= keepFrom) hidden.push({ item, reason: 'dismissed' });
      } else if (!(since >= hideFrom)) {
        if (since >= keepFrom) hidden.push({ item, reason: 'expired' });
      } else items.push(item);
    }
    hidden.sort((a, b) => msOf(b.item.since) - msOf(a.item.since) || (a.item.key < b.item.key ? -1 : a.item.key > b.item.key ? 1 : 0));
    undeterminable.sort((a, b) => b.at - a.at || (a.sessionId < b.sessionId ? -1 : 1));
    return {
      items: sortAttention(items),
      hidden,
      undeterminable: undeterminable.map(({ sessionId, title, origin }) => ({ sessionId, title, origin })),
      runningCount,
      autoHideHours: this.autoHideHours,
    };
  }

  /** "知道了": only the current item of a session (main list or hidden) can be dismissed. */
  dismiss(key: string): Result {
    if (typeof key !== 'string' || this.currentItem(key) === null) return { ok: false, error: '这一项已不在列表里' };
    if (this.dismissed.has(key)) return { ok: true };
    const error = this.save(this.autoHideHours, new Set([...this.dismissed, key]));
    if (error !== null) return { ok: false, error };
    this.scheduleFlush();
    return { ok: true };
  }

  restore(key: string): Result {
    if (typeof key !== 'string' || !this.dismissed.has(key)) return { ok: false, error: '这一项没有被移出' };
    const next = new Set(this.dismissed);
    next.delete(key);
    const error = this.save(this.autoHideHours, next);
    if (error !== null) return { ok: false, error };
    this.scheduleFlush();
    return { ok: true };
  }

  setAutoHideHours(v: unknown): { ok: true; value: number } | { ok: false; error: string } {
    const checked = validateAutoHideHours(v);
    if (!checked.ok) return checked;
    const error = this.save(checked.value, this.dismissed);
    if (error !== null) return { ok: false, error };
    this.scheduleFlush();
    return checked;
  }

  /** Called (coalesced) after a change that alters the response; returns the unsubscribe. */
  onUpdate(listener: (r: AttentionResponse) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Time-driven re-evaluation (stuck, auto-hide, the 30-day window); the caller runs it every 30 s. */
  tick(): void {
    if (this.closed) return;
    const keepFrom = this.deps.now() - KEEP_MS;
    for (const [id, t] of this.tracked) {
      // Out of the window for good: forgotten (a later change of the session reads it again).
      if (!isCandidate(t, keepFrom) && msOf(t.session.lastActivityAt) < keepFrom) this.tracked.delete(id);
      else this.refreshView(id);
    }
    this.emitIfChanged();
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  // ---------------------------------------------------------------- internals

  private applySession(id: string, changes: readonly Change[]): void {
    const t = this.tracked.get(id);
    // Unknown, or a batch as large as a rebuild's or a first import's: read it (the store already holds the batch).
    if (t === undefined || changes.length > TAIL_LIMIT) {
      this.load(id);
      return;
    }
    let reload = false;
    let waiting = false;
    let upserted = false;
    const origin = (): Origin => t.session.origin;
    for (const c of changes) {
      if (reload) break;
      switch (c.type) {
        case 'session_upserted':
          t.session = c.session;
          upserted = true;
          break;
        case 'node_added': {
          const n = c.node;
          if (n.status === 'awaiting_permission' || t.waiting.has(n.id)) waiting = true;
          if (n.agentId === null && !this.noteMainNode(t, n)) reload = true;
          break;
        }
        case 'node_updated': {
          const p = c.patch;
          const has = (fields: readonly string[]): boolean => fields.some((f) => f in p);
          if (p.status === 'awaiting_permission' || t.waiting.has(c.id)) waiting = true;
          if (
            (t.prompt?.id === c.id && has(PROMPT_FIELDS)) ||
            (t.last?.id === c.id && has(LAST_FIELDS)) ||
            (t.reply?.id === c.id && has(REPLY_FIELDS)) ||
            (t.error?.id === c.id && has(ERROR_FIELDS))
          ) {
            reload = true;
            break;
          }
          for (const k of [t.last, t.reply, t.error]) if (k?.id === c.id) Object.assign(k, pickText(p));
          const tracked = t.prompt?.id === c.id || t.last?.id === c.id || t.reply?.id === c.id || t.error?.id === c.id;
          // A node moving after the last one (thread unknown), or changing role: re-read.
          if (!tracked && has(ROLE_FIELDS)) reload = true;
          else if (p.timestamp !== undefined && t.last !== null && msOf(p.timestamp) > t.last.ms) reload = true;
          else if (origin() === 'cursor' && p.status === 'failed' && t.error?.id !== c.id && this.aborted(id, c.id)) reload = true;
          break;
        }
        case 'node_removed':
          if (t.waiting.has(c.id)) waiting = true;
          if ([t.prompt?.id, t.last?.id, t.reply?.id, t.error?.id].includes(c.id) || (t.prompt !== null && t.prompt.id === null)) reload = true;
          break;
        default:
          break; // edges
      }
    }
    if (reload) {
      this.load(id);
      return;
    }
    if (waiting) t.waiting = this.readWaiting(id);
    if (upserted && HOOK_ORIGINS.has(t.session.origin) && IDLE.has(t.session.status)) this.readHooks(t);
  }

  /**
   * A main-thread node seen (live, or read oldest first at load). False when the session must be re-read instead: a
   * tracked node stored again in a way that may no longer fit, or a prompt older than nodes already seen.
   */
  private noteMainNode(t: Tracked, n: GraphNode): boolean {
    const ms = msOf(n.timestamp);
    if (t.prompt?.id === n.id && (n.kind !== 'prompt' || ms !== t.prompt.ms)) return false;
    if (t.last?.id === n.id && ms < t.last.ms) return false;
    if (t.reply?.id === n.id && (n.kind !== 'text' || ms < t.reply.ms)) return false;
    if (t.error?.id === n.id) return false;
    if (n.kind === 'prompt') {
      if (t.prompt === null || ms > t.prompt.ms) {
        // Nodes newer than this prompt arrived before it: which of them belong to its turn is read from the store.
        if (t.last !== null && t.last.ms > ms) return false;
        t.prompt = { id: n.id, at: n.timestamp, ms };
        if (t.error !== null && t.error.atMs < ms) t.error = null;
        if (t.hookError !== null && t.hookError.ms < ms) t.hookError = null;
        if (t.reply !== null && t.reply.ms < ms) t.reply = null;
      } else if (ms === t.prompt.ms) t.prompt = { id: n.id, at: n.timestamp, ms };
    }
    if (t.last === null || ms >= t.last.ms) t.last = keep(n);
    if (t.prompt !== null && ms >= t.prompt.ms) {
      if (n.kind === 'text' && (t.reply === null || ms >= t.reply.ms)) t.reply = keep(n);
      if (isErrorMarkerNode(t.session.origin, n, () => this.aborted(n.sessionId, n.id))) {
        const at = errorMarkerAt(n);
        const atMs = msOf(at);
        if (atMs >= t.prompt.ms && (t.error === null || atMs >= t.error.atMs)) t.error = { ...keep(n), at, atMs };
      }
    }
    return true;
  }

  /** (Re)reads a session's marks from the store: a few indexed reads, never its whole graph. */
  private load(id: string, known?: Session): void {
    const { store } = this.deps;
    const session = known ?? store.getSession(id);
    if (session === null) {
      this.tracked.delete(id);
      return;
    }
    const t: Tracked = {
      session,
      prompt: null,
      last: null,
      reply: null,
      error: null,
      hookError: null,
      hooksReadTo: null,
      waiting: new Map(),
      view: this.tracked.get(id)?.view ?? '',
    };
    const promptAt = store.latestMainPromptAt(id);
    if (promptAt !== null) {
      t.prompt = { id: null, at: promptAt, ms: msOf(promptAt) };
      const tail = store.mainTailNodes(id, promptAt, TAIL_LIMIT);
      for (let i = tail.length - 1; i >= 0; i--) this.noteMainNode(t, tail[i]!);
    } else {
      const [lastNode] = store.mainTailNodes(id, null, 1);
      if (lastNode !== undefined) t.last = keep(lastNode);
    }
    t.waiting = this.readWaiting(id);
    if (HOOK_ORIGINS.has(session.origin)) this.readHooks(t);
    this.tracked.set(id, t);
  }

  private readWaiting(id: string): Map<string, Kept> {
    return new Map(this.deps.store.awaitingPermissionNodes(id).map((n) => [n.id, keep(n)]));
  }

  /**
   * The session's hooks since its latest prompt not read yet (isErrorHook, main thread only, as the notification engine
   * takes them): a hook's raw row is committed in the transaction whose changes announce it (pipeline.applyHook).
   */
  private readHooks(t: Tracked): void {
    if (t.prompt === null) return;
    const from = t.hooksReadTo !== null && msOf(t.hooksReadTo) > t.prompt.ms ? t.hooksReadTo : t.prompt.at;
    const id = t.session.id;
    for (const h of this.deps.store.hookEventsSince(id, from)) {
      if (t.hooksReadTo === null || msOf(h.receivedAt) > msOf(t.hooksReadTo)) t.hooksReadTo = h.receivedAt;
      const ms = msOf(h.receivedAt);
      if (ms < t.prompt.ms || !isMainThreadHook(t.session.origin, id, h.payload)) continue;
      if (!isErrorHook(t.session.origin, h.eventName, h.payload)) continue;
      if (t.hookError === null || ms >= t.hookError.ms) t.hookError = { at: h.receivedAt, ms };
    }
  }

  private marks(t: Tracked): SessionMarks {
    const promptMs = t.prompt?.ms ?? Number.POSITIVE_INFINITY;
    let waiting: Kept | null = null;
    for (const w of t.waiting.values()) if (w.ms >= promptMs && (waiting === null || w.ms >= waiting.ms)) waiting = w;
    const errorAt = t.error !== null && (t.hookError === null || t.error.atMs >= t.hookError.ms) ? t.error.at : (t.hookError?.at ?? null);
    return {
      session: t.session,
      lastPromptAt: t.prompt?.at ?? null,
      errorAt,
      errorNode: t.error !== null ? { id: t.error.id, text: t.error.summary || t.error.title } : null,
      waitingNode: waiting !== null ? { id: waiting.id, timestamp: waiting.timestamp, text: [waiting.toolName ?? waiting.title, waiting.summary].filter((x) => x !== '').join(' · ') } : null,
      lastMainNode: t.last !== null ? { id: t.last.id, timestamp: t.last.timestamp, text: t.last.title } : null,
      lastReply: t.reply !== null ? { id: t.reply.id, text: t.reply.summary || t.reply.title } : null,
    };
  }

  /** Recomputes what the session contributes to the response; returns it ('' for none). */
  private refreshView(id: string): string {
    const t = this.tracked.get(id);
    if (t === undefined) return '';
    const now = this.deps.now();
    let view = '';
    if (isCandidate(t, now - KEEP_MS)) {
      const s = t.session;
      if (UNDETERMINABLE.has(s.origin)) view = JSON.stringify(['u', s.title, s.origin, t.last!.ms]);
      else view = JSON.stringify(['i', decideAttention(this.marks(t), now, this.stuckMinutes()), s.status === 'running']);
    }
    t.view = view;
    return view;
  }

  /** The current item with this key (main list or hidden), or null. */
  private currentItem(key: string): AttentionItem | null {
    const parts = key.split('|');
    if (parts.length < 3) return null;
    const t = this.tracked.get(parts.slice(0, -2).join('|'));
    const now = this.deps.now();
    if (t === undefined || !isCandidate(t, now - KEEP_MS) || UNDETERMINABLE.has(t.session.origin)) return null;
    const item = decideAttention(this.marks(t), now, this.stuckMinutes());
    return item !== null && item.key === key && msOf(item.since) >= now - KEEP_MS ? item : null;
  }

  /** Writes the stored state, keeping only dismissals within the 30 days of sessions still candidates. Error or null. */
  private save(autoHideHours: number, dismissed: ReadonlySet<string>): string | null {
    const keepFrom = this.deps.now() - KEEP_MS;
    const kept = [...dismissed].filter((key) => {
      const parts = key.split('|');
      if (parts.length < 3 || !(msOf(parts[parts.length - 1]) >= keepFrom)) return false;
      const t = this.tracked.get(parts.slice(0, -2).join('|'));
      return t !== undefined && isCandidate(t, keepFrom);
    });
    try {
      this.deps.store.setMeta(ATTENTION_META_KEY, JSON.stringify({ autoHideHours, dismissed: kept }));
    } catch (err) {
      return `保存失败：${err instanceof Error ? err.message : String(err)}`;
    }
    this.autoHideHours = autoHideHours;
    this.dismissed = new Set(kept);
    return null;
  }

  /** The stored state; the defaults for whatever is missing or not valid. */
  private loadStored(): void {
    let parsed: unknown;
    try {
      const raw = this.deps.store.getMeta(ATTENTION_META_KEY);
      if (raw === null) return;
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const o = parsed as Record<string, unknown>;
    const hours = validateAutoHideHours(o.autoHideHours);
    if (hours.ok) this.autoHideHours = hours.value;
    if (Array.isArray(o.dismissed)) this.dismissed = new Set(o.dismissed.filter((k): k is string => typeof k === 'string'));
  }

  private stuckMinutes(): number {
    try {
      const v = this.deps.stuckMinutes();
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    } catch {
      // the default below
    }
    return DEFAULT_NOTIFICATION_SETTINGS.stuckMinutes;
  }

  private aborted(sessionId: string, nodeId: string): boolean {
    try {
      return this.deps.isAbortedCall(sessionId, nodeId) === true;
    } catch {
      return false;
    }
  }

  private scheduleFlush(): void {
    if (this.closed || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.emitIfChanged();
    }, this.coalesceMs);
    this.timer.unref?.();
  }

  private emitIfChanged(): void {
    if (this.closed) return;
    const response = this.snapshot();
    const json = JSON.stringify(response);
    if (json === this.lastJson) return;
    this.lastJson = json;
    for (const listener of [...this.listeners]) {
      try {
        listener(response);
      } catch {
        // a failing listener must not affect the others
      }
    }
  }
}

/** A session that may have an item: not ended or deleted, asked something, its last main-thread node within the window. */
function isCandidate(t: Tracked, keepFrom: number): boolean {
  const s = t.session;
  return s.status !== 'ended' && !s.sourceDeleted && t.prompt !== null && t.last !== null && t.last.ms >= keepFrom;
}

/** A hook of the session's own main thread (not a subagent's; for Cursor, not a subagent conversation filed under it). */
function isMainThreadHook(origin: Origin, sessionId: string, payload: Record<string, unknown> | null): boolean {
  if (payload === null) return true;
  if (typeof payload.agent_id === 'string' && payload.agent_id !== '') return false;
  return origin !== 'cursor' || cursorHookConversationId(payload) === sessionId;
}

const pickText = (p: Partial<GraphNode>): Partial<Kept> => {
  const out: Partial<Kept> = {};
  if (p.title !== undefined) out.title = p.title;
  if (p.summary !== undefined) out.summary = p.summary;
  if (p.toolName !== undefined) out.toolName = p.toolName;
  return out;
};

function sessionIdOf(c: Change): string {
  switch (c.type) {
    case 'session_upserted':
      return c.session.id;
    case 'node_added':
      return c.node.sessionId;
    case 'edge_added':
      return c.edge.sessionId;
    default:
      return c.sessionId;
  }
}
