import {
  applyChanges,
  type ClientMessage,
  type Diagnostics,
  type Graph,
  type GraphSnapshot,
  type NodeDetail,
  type Project,
  type SeqChange,
  type SearchHit,
  type ServerMessage,
  type Session,
} from '@claude-canvas/shared';

const RECONNECT_MS = 1000;

/** An Error carrying the HTTP status of a failed request. */
export type HttpError = Error & { status: number };

const isNotFound = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { status?: unknown }).status === 404;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw Object.assign(new Error(`${path}: HTTP ${res.status}`), { status: res.status }) as HttpError;
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export const api = {
  projects: () => getJson<Project[]>('/api/projects'),
  sessions: (projectId: string) => getJson<Session[]>(`/api/projects/${enc(projectId)}/sessions`),
  graph: (sessionId: string) => getJson<GraphSnapshot>(`/api/sessions/${enc(sessionId)}/graph`),
  nodeDetail: (sessionId: string, nodeId: string) =>
    getJson<NodeDetail>(`/api/sessions/${enc(sessionId)}/nodes/${enc(nodeId)}`),
  diagnostics: () => getJson<Diagnostics>('/api/diagnostics'),
  search: (q: string) => getJson<SearchHit[]>(`/api/search?q=${enc(q)}`),
};

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
 * Keeps one socket open: sends `subscribe()` on every open, hands each server message to `onMessage`,
 * and reconnects 1 s after a drop until the returned function (close) is called.
 */
function connect(
  subscribe: () => ClientMessage,
  onMessage: (msg: ServerMessage) => void,
  createSocket: () => WebSocketLike,
  onReconnect?: () => void,
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
      if (reconnecting) onReconnect?.();
      reconnecting = false;
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
    if (buffered !== null || closed) return; // already refetching
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
          gone = true; // the session was deleted: stop refetching
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

/** Live feed of every session upsert. Missed upserts are not replayed: `onReconnect` lets the caller refetch. */
export function openLiveSessions(
  onSession: (s: Session) => void,
  deps: { createSocket?: () => WebSocketLike; onReconnect?: () => void } = {},
): { close(): void } {
  const close = connect(
    () => ({ type: 'subscribe', scope: 'sessions' }),
    (msg) => {
      if (msg.type !== 'changes') return;
      for (const c of msg.changes) if (c.type === 'session_upserted') onSession(c.session);
    },
    deps.createSocket ?? createBrowserSocket,
    deps.onReconnect,
  );
  return { close };
}
