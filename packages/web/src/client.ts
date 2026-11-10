import {
  applyChange,
  emptyGraph,
  type ClientMessage,
  type Graph,
  type GraphNode,
  type GraphSnapshot,
  type NodeDetail,
  type Project,
  type SeqChange,
  type ServerMessage,
  type Session,
} from '@claude-canvas/shared';

const RECONNECT_MS = 1000;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export const api = {
  projects: () => getJson<Project[]>('/api/projects'),
  sessions: (projectId: string) => getJson<Session[]>(`/api/projects/${enc(projectId)}/sessions`),
  graph: (sessionId: string) => getJson<GraphSnapshot>(`/api/sessions/${enc(sessionId)}/graph`),
  nodeDetail: (sessionId: string, nodeId: string) =>
    getJson<NodeDetail>(`/api/sessions/${enc(sessionId)}/nodes/${enc(nodeId)}`),
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
 * Keeps one socket open: sends `subscribe()` on every open, hands each batch of changes to `onChanges`,
 * and reconnects 1 s after a drop until the returned function (close) is called.
 */
function connect(
  subscribe: () => ClientMessage,
  onChanges: (changes: SeqChange[]) => void,
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
      if (msg.type === 'changes') onChanges(msg.changes);
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
  subscribe(fn: () => void): () => void;
  close(): void;
}

export async function openLiveSession(
  sessionId: string,
  deps: { fetchGraph?: typeof api.graph; createSocket?: () => WebSocketLike } = {},
): Promise<LiveSession> {
  const fetchGraph = deps.fetchGraph ?? api.graph;
  const snap = await fetchGraph(sessionId);
  let graph = emptyGraph();
  for (const n of snap.nodes) graph = applyChange(graph, { type: 'node_added', node: n, detail: {} });
  for (const e of snap.edges) graph = applyChange(graph, { type: 'edge_added', edge: e });
  let session = snap.session;
  let seq = snap.seq;
  const listeners = new Set<() => void>();

  const close = connect(
    () => ({ type: 'subscribe', scope: 'session', sessionId, sinceSeq: seq }),
    (changes) => {
      let touched = false;
      for (const c of changes) {
        if (c.seq <= seq) continue;
        seq = c.seq;
        if (c.type === 'session_upserted') session = c.session;
        else graph = applyChange(graph, c);
        touched = true;
      }
      if (touched) for (const fn of [...listeners]) fn();
    },
    deps.createSocket ?? createBrowserSocket,
  );

  return {
    getGraph: () => graph,
    getSession: () => session,
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    close,
  };
}

/** Live feed of every session upsert. Missed upserts are not replayed: `onReconnect` lets the caller refetch. */
export function openLiveSessions(
  onSession: (s: Session) => void,
  deps: { createSocket?: () => WebSocketLike; onReconnect?: () => void } = {},
): { close(): void } {
  const close = connect(
    () => ({ type: 'subscribe', scope: 'sessions' }),
    (changes) => {
      for (const c of changes) if (c.type === 'session_upserted') onSession(c.session);
    },
    deps.createSocket ?? createBrowserSocket,
    deps.onReconnect,
  );
  return { close };
}

/** Ascending by timestamp, ties broken by id. */
export function orderNodes(graph: Graph): GraphNode[] {
  return Object.values(graph.nodes).sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}
