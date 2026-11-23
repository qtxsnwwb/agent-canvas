import {
  applyChanges,
  type AnomalyCountsResponse,
  type AnomalyListResponse,
  type AttentionResponse,
  type ClientMessage,
  type ContentSearchResponse,
  type Diagnostics,
  type ExportOptions,
  type ExportPreview,
  type ExportSettingsResponse,
  type LearnedValue,
  type MaskCategory,
  type Graph,
  type GraphSnapshot,
  type NodeDetail,
  type NotificationSettings,
  type NotificationSettingsResponse,
  type NotificationTestResponse,
  type Origin,
  type Project,
  type ProjectFilesResponse,
  type SeqChange,
  type SearchHit,
  type ServerMessage,
  type Session,
  type SessionAnomaliesResponse,
  type SessionFilesResponse,
  type StatsResponse,
} from '@agent-canvas/shared';
import { attentionProblem, attentionRetryDelay } from './attention';

const RECONNECT_MS = 1000;

/** An Error carrying the HTTP status of a failed request. */
export type HttpError = Error & { status: number };

const isNotFound = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { status?: unknown }).status === 404;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw Object.assign(new Error(`${path}: HTTP ${res.status}`), { status: res.status }) as HttpError;
  return (await res.json()) as T;
}

/** Sends JSON; a non-2xx answer throws an Error whose message is the server's `error` text when it has one. */
async function sendJson<T>(method: 'PUT' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    let message = `${path}: HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: unknown; message?: unknown };
      if (typeof j.error === 'string' && j.error !== '') message = j.error;
      else if (typeof j.message === 'string' && j.message !== '') message = j.message;
    } catch { /* keep the generic text */ }
    throw Object.assign(new Error(message), { status: res.status }) as HttpError;
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export const api = {
  projects: () => getJson<Project[]>('/api/projects'),
  sessions: (projectId: string) => getJson<Session[]>(`/api/projects/${enc(projectId)}/sessions`),
  graph: (sessionId: string) => getJson<GraphSnapshot>(`/api/sessions/${enc(sessionId)}/graph`),
  nodeDetail: (sessionId: string, nodeId: string) =>
    getJson<NodeDetail>(`/api/sessions/${enc(sessionId)}/nodes/${enc(nodeId)}`),
  /** `mask` true: unknown-record samples masked by the server (`?mask=1`). */
  diagnostics: (mask?: true) => getJson<Diagnostics>(mask === true ? '/api/diagnostics?mask=1' : '/api/diagnostics'),
  notificationSettings: () => getJson<NotificationSettingsResponse>('/api/notifications/settings'),
  saveNotificationSettings: (settings: NotificationSettings) =>
    sendJson<NotificationSettingsResponse>('PUT', '/api/notifications/settings', settings),
  testNotification: () => sendJson<NotificationTestResponse>('POST', '/api/notifications/test'),
  /** `mask` true: snippets cut from the masked text (`mask=1`, each match `masked: true`). */
  search: (q: string, mask?: true) => getJson<SearchHit[]>(`/api/search?q=${enc(q)}${mask === true ? '&mask=1' : ''}`),
  /** Content hits inside sessions (GET /api/search/content). */
  searchContent: (q: string, origin: Origin | null = null, mask?: true) =>
    getJson<ContentSearchResponse>(`/api/search/content?q=${enc(q)}${origin === null ? '' : `&origin=${enc(origin)}`}${mask === true ? '&mask=1' : ''}`),
  /** `query` is built by stats.ts `statsQueryString`. */
  stats: (query: string) => getJson<StatsResponse>(`/api/stats?${query}`),
  sessionFiles: (sessionId: string) => getJson<SessionFilesResponse>(`/api/sessions/${enc(sessionId)}/files`),
  /** `query` is built by files.ts `filesQueryString`. */
  files: (query: string) => getJson<ProjectFilesResponse>(`/api/files?${query}`),
  sessionAnomalies: (sessionId: string) => getJson<SessionAnomaliesResponse>(`/api/sessions/${enc(sessionId)}/anomalies`),
  /** `query` is built by anomalies.ts `anomaliesQueryString`. */
  anomalies: (query: string) => getJson<AnomalyListResponse>(`/api/anomalies?${query}`),
  anomalyCounts: () => getJson<AnomalyCountsResponse>('/api/anomalies/counts'),
  exportSettings: () => getJson<ExportSettingsResponse>('/api/export/settings'),
  /** The attention state (GET /api/attention); `hidden` true adds the hidden list (`?hidden=1`). */
  attention: (hidden?: true) => getJson<AttentionResponse>(hidden === true ? '/api/attention?hidden=1' : '/api/attention'),
  /** "知道了": the answer is the new state without the hidden list. */
  dismissAttention: (key: string) => sendJson<AttentionResponse>('POST', '/api/attention/dismiss', { key }),
  /** Undo a "知道了". */
  restoreAttention: (key: string) => sendJson<AttentionResponse>('POST', '/api/attention/restore', { key }),
  saveAttentionSettings: (autoHideHours: number) => sendJson<AttentionResponse>('PUT', '/api/attention/settings', { autoHideHours }),
  /**
   * POST /api/sessions/:id/mask/learned: the secret values the server learned from the whole session, for the page's
   * masker (memory only; never logged or stored).
   */
  maskLearned: async (sessionId: string, categories: readonly MaskCategory[], signal?: AbortSignal): Promise<{ values: LearnedValue[]; capped: boolean }> =>
    (await postJson(`/api/sessions/${enc(sessionId)}/mask/learned`, { categories }, signal)).json() as Promise<{ values: LearnedValue[]; capped: boolean }>,
  saveExportSettings: (customTerms: string[]) =>
    sendJson<ExportSettingsResponse>('PUT', '/api/export/settings', { customTerms }),
  /** POST /api/sessions/:id/export/preview; a failure throws an HttpError (its text is not the server's). */
  exportPreview: async (sessionId: string, options: ExportOptions, signal?: AbortSignal): Promise<ExportPreview> =>
    (await postExport(`/api/sessions/${enc(sessionId)}/export/preview`, options, signal)).json() as Promise<ExportPreview>,
  /** POST /api/sessions/:id/export: the file as a Blob and the Content-Disposition header (the file name). */
  exportFile: async (sessionId: string, options: ExportOptions, signal?: AbortSignal): Promise<{ blob: Blob; disposition: string | null }> => {
    const res = await postExport(`/api/sessions/${enc(sessionId)}/export`, options, signal);
    return { blob: await res.blob(), disposition: res.headers.get('content-disposition') };
  },
};

/**
 * The export routes: same-origin POST (the browser sends Origin, which the server checks) with a JSON body. A non-2xx
 * answer throws an HttpError whose message names the status only: the dialog shows its own text per status, never the
 * server's.
 */
async function postExport(path: string, options: ExportOptions, signal: AbortSignal | undefined): Promise<Response> {
  return postJson(path, options, signal);
}

async function postJson(path: string, body: unknown, signal: AbortSignal | undefined): Promise<Response> {
  const res = await fetch(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal, credentials: 'same-origin',
  });
  if (!res.ok) {
    void res.body?.cancel().catch(() => {});
    throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status }) as HttpError;
  }
  return res;
}

/** What a failed request was: an HTTP status, aborted by the page, or no answer at all. */
export function failureOf(e: unknown): number | 'abort' | 'network' {
  if (typeof e === 'object' && e !== null) {
    const status = (e as { status?: unknown }).status;
    if (typeof status === 'number') return status;
    if ((e as { name?: unknown }).name === 'AbortError') return 'abort';
  }
  return 'network';
}

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
}

function createBrowserSocket(): WebSocketLike {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return new WebSocket(`${proto}://${location.host}/ws`) as unknown as WebSocketLike;
}

/**
 * Keeps one socket open: sends `subscribe()` on every open (then calls `onOpen`, `reconnect` true after a drop), hands
 * each server message to `onMessage`, and reconnects 1 s after a drop until the returned function (close) is called.
 */
function connect(
  subscribe: () => ClientMessage,
  onMessage: (msg: ServerMessage) => void,
  createSocket: () => WebSocketLike,
  onOpen?: (reconnect: boolean) => void,
): () => void {
  let closed = false;
  let sock: WebSocketLike | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let reconnecting = false;

  const open = (): void => {
    const s = createSocket();
    sock = s;
    s.onopen = () => {
      if (closed || sock !== s) return;
      s.send(JSON.stringify(subscribe()));
      const again = reconnecting;
      reconnecting = false;
      onOpen?.(again);
    };
    s.onmessage = (ev) => {
      if (closed || sock !== s || typeof ev.data !== 'string') return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      onMessage(msg);
    };
    s.onclose = () => {
      if (closed || sock !== s) return;
      sock = null;
      reconnecting = true;
      timer = setTimeout(() => {
        timer = null;
        if (!closed) open();
      }, RECONNECT_MS);
    };
  };

  open();
  return () => {
    closed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const s = sock;
    sock = null;
    s?.close();
  };
}

export interface LiveSession {
  getGraph(): Graph;
  getSession(): Session;
  /** True once the server answered 404 to a resync: the session no longer exists and is not refetched. */
  isGone(): boolean;
  subscribe(fn: () => void): () => void;
  close(): void;
}

export async function openLiveSession(
  sessionId: string,
  deps: { fetchGraph?: typeof api.graph; createSocket?: () => WebSocketLike } = {},
): Promise<LiveSession> {
  const fetchGraph = deps.fetchGraph ?? api.graph;
  // Build the records directly: applyChange copies the whole map per call, which is quadratic here.
  const fromSnapshot = (snap: GraphSnapshot): Graph => ({
    nodes: Object.fromEntries(snap.nodes.map((n) => [n.id, n])),
    edges: Object.fromEntries(snap.edges.map((e) => [e.id, e])),
  });
  const snap = await fetchGraph(sessionId);
  let graph = fromSnapshot(snap);
  let session = snap.session;
  let seq = snap.seq;
  let epoch: string | null = null;
  let closed = false;
  let gone = false;
  /** Non-null while a snapshot refetch is in flight: changes received meanwhile, applied once it lands. */
  let buffered: SeqChange[] | null = null;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const fn of [...listeners]) fn();
  };

  /** Applies the changes newer than `seq` (one copy of each map, one notification). */
  const apply = (changes: SeqChange[]): boolean => {
    const fresh = changes.filter((c) => c.seq > seq);
    if (fresh.length === 0) return false;
    seq = fresh[fresh.length - 1]!.seq;
    for (const c of fresh) if (c.type === 'session_upserted') session = c.session;
    graph = applyChanges(graph, fresh);
    return true;
  };

  /** Replaces the graph with a fresh snapshot; changes arriving meanwhile are kept and replayed on top of it. */
  const resync = (): void => {
    if (buffered !== null || closed || gone) return; // already refetching, or the session no longer exists
    buffered = [];
    fetchGraph(sessionId).then(
      (fresh) => {
        const pending = buffered ?? [];
        buffered = null;
        if (closed) return;
        graph = fromSnapshot(fresh);
        session = fresh.session;
        seq = fresh.seq;
        apply(pending);
        notify();
      },
      (err: unknown) => {
        const pending = buffered ?? [];
        buffered = null;
        if (closed) return;
        if (isNotFound(err)) {
          gone = true; // the session was deleted: stop refetching and stop listening
          close();
          notify();
          return;
        }
        if (apply(pending)) notify();
        setTimeout(resync, RECONNECT_MS); // the server still expects us to refetch
      },
    );
  };

  const close = connect(
    () => ({ type: 'subscribe', scope: 'session', sessionId, sinceSeq: seq }),
    (msg) => {
      if (msg.type === 'hello') {
        // A different database (deleted and recreated): seqs are not comparable any more.
        if (epoch !== null && msg.epoch !== epoch) resync();
        epoch = msg.epoch;
      } else if (msg.type === 'resync') {
        if (msg.sessionId === sessionId) resync();
      } else if (msg.type !== 'changes') {
        // not for a session's graph
      } else if (buffered !== null) {
        buffered.push(...msg.changes);
      } else if (apply(msg.changes)) {
        notify();
      }
    },
    deps.createSocket ?? createBrowserSocket,
  );

  return {
    getGraph: () => graph,
    getSession: () => session,
    isGone: () => gone,
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    close() {
      closed = true;
      close();
    },
  };
}

/** One listener of a SessionsFeed. */
export interface SessionsListener {
  message(msg: ServerMessage): void;
  /**
   * The subscription is in place: after the socket opened (`reconnect` true after a drop, when messages may have been
   * missed), or at once (false) for a listener joining a feed that is already subscribed.
   */
  open?(reconnect: boolean): void;
}

/** A sessions-scope subscription shared by its listeners: one socket while at least one listens. */
export interface SessionsFeed {
  listen(listener: SessionsListener): () => void;
}

/**
 * A feed over one sessions-scope socket: opened with the first listener, closed when the last one leaves (a later
 * listener opens a new one). Every listener gets every message.
 */
export function createSessionsFeed(createSocket: () => WebSocketLike): SessionsFeed {
  const listeners = new Set<SessionsListener>();
  let close: (() => void) | null = null;
  let subscribed = false;
  return {
    listen(listener) {
      listeners.add(listener);
      if (close === null) {
        close = connect(
          () => ({ type: 'subscribe', scope: 'sessions' }),
          (msg) => { for (const l of [...listeners]) l.message(msg); },
          createSocket,
          (reconnect) => {
            subscribed = true;
            for (const l of [...listeners]) l.open?.(reconnect);
          },
        );
      } else if (subscribed) {
        listener.open?.(false);
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return;
        const c = close;
        close = null;
        subscribed = false;
        c?.();
      };
    },
  };
}

let browserFeed: SessionsFeed | null = null;
/** The app's one sessions-scope socket (the home page's session list and the attention state share it). */
function sharedSessionsFeed(): SessionsFeed {
  browserFeed ??= createSessionsFeed(createBrowserSocket);
  return browserFeed;
}

const feedOf = (deps: { feed?: SessionsFeed; createSocket?: () => WebSocketLike }): SessionsFeed =>
  deps.feed ?? (deps.createSocket !== undefined ? createSessionsFeed(deps.createSocket) : sharedSessionsFeed());

/**
 * Live feed of every session upsert. Missed upserts are not replayed: `onReconnect` lets the caller refetch. `feed`: the
 * subscription to use (default: the app's shared one; `createSocket` alone: a feed of its own).
 */
export function openLiveSessions(
  onSession: (s: Session) => void,
  deps: { createSocket?: () => WebSocketLike; feed?: SessionsFeed; onReconnect?: () => void } = {},
): { close(): void } {
  const close = feedOf(deps).listen({
    message(msg) {
      if (msg.type !== 'changes') return;
      for (const c of msg.changes) if (c.type === 'session_upserted') onSession(c.session);
    },
    open(reconnect) { if (reconnect) deps.onReconnect?.(); },
  });
  return { close };
}

/** The attention state as the app shows it: the last state received, and why it may be missing or old. */
export interface AttentionLiveState {
  response: AttentionResponse | null;
  /** null: up to date. `preparing`: the server's list is not ready yet (503). `failed`: the last fetch failed. */
  problem: { kind: 'preparing' | 'failed'; text: string } | null;
}

/**
 * The attention state, live (spec 5): fetched once the sessions-scope subscription is in place and again after every
 * reconnect (nothing is pushed on subscribe), then replaced by each `attention` message. A failed fetch (503 while the
 * server prepares the list, or any other failure) keeps the last state and is retried after attentionRetryDelay; a push
 * cancels the retry. `accept` takes a write route's answer as the current state.
 */
export function openLiveAttention(
  onState: (s: AttentionLiveState) => void,
  deps: { fetchAttention?: () => Promise<AttentionResponse>; feed?: SessionsFeed; createSocket?: () => WebSocketLike } = {},
): { accept(r: AttentionResponse): void; close(): void } {
  const fetchAttention = deps.fetchAttention ?? (() => api.attention());
  let closed = false;
  let response: AttentionResponse | null = null;
  let failures = 0;
  let inFlight = false;
  let again = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const cancelRetry = (): void => {
    if (retry !== null) clearTimeout(retry);
    retry = null;
  };
  const show = (r: AttentionResponse): void => {
    cancelRetry();
    failures = 0;
    response = r;
    onState({ response, problem: null });
  };
  const load = (): void => {
    if (closed) return;
    if (inFlight) { again = true; return; }
    cancelRetry();
    inFlight = true;
    fetchAttention().then(
      (r) => { if (!closed) show(r); },
      (e: unknown) => {
        if (closed) return;
        failures += 1;
        onState({ response, problem: attentionProblem(e) });
        retry = setTimeout(() => { retry = null; load(); }, attentionRetryDelay(failures));
      },
    ).finally(() => {
      inFlight = false;
      if (again && !closed) { again = false; load(); }
    });
  };
  const unlisten = feedOf(deps).listen({
    message(msg) { if (msg.type === 'attention' && !closed) show(msg.response); },
    open: () => load(),
  });
  return {
    accept(r) { if (!closed) show(r); },
    close() {
      closed = true;
      cancelRetry();
      unlisten();
    },
  };
}
