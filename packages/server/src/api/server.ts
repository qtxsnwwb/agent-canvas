import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import {
  ORIGINS,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  type Change,
  type ClientMessage,
  type Diagnostics,
  type Origin,
  type SearchHit,
  type SeqChange,
  type ServerMessage,
} from '@claude-canvas/shared';
import type { Config } from '../config.js';
import { cursorHookConversationId, cursorHookWorkspaceRoot, sanitizeCursorHookPayload } from '../normalize/cursor-hooks.js';
import { NORMALIZER_VERSION } from '../normalize/version.js';
import type { Pipeline } from '../pipeline.js';
import type { Store } from '../store/store.js';

const HOOK_BODY_LIMIT = 64 * 1024 * 1024;
/** More changes than this to catch up on: tell the client to refetch the snapshot instead. */
export const CATCHUP_MAX = 5000;
/** Changes per catch-up message. */
export const CATCHUP_CHUNK = 1000;
/** A socket whose unsent data exceeds this is too slow to keep up and is terminated. */
export const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const RESERVED_PREFIXES = ['/api', '/ws', '/hooks'];

interface Connection {
  send(message: ServerMessage): void;
  sessionsScope: boolean;
  sessionId: string | null;
}

function sessionIdOf(c: Change): string {
  switch (c.type) {
    case 'session_upserted':
      return c.session.id;
    case 'node_added':
      return c.node.sessionId;
    case 'node_updated':
      return c.sessionId;
    case 'edge_added':
      return c.edge.sessionId;
    case 'edge_removed':
      return c.sessionId;
  }
}

/** Node detail can be megabytes; clients fetch it on demand over REST. */
function stripDetail(c: SeqChange): SeqChange {
  if (c.type === 'node_added') return { ...c, detail: {} };
  if (c.type === 'node_updated') {
    const { detail: _detail, ...rest } = c;
    return rest;
  }
  return c;
}

/** Content-Security-Policy of the HTML page. */
export const CSP =
  "default-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function hostnameOf(urlLike: string): string | null {
  try {
    return new URL(urlLike).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The service has no auth; loopback binding alone does not stop browsers, so every request must carry a loopback Host
 * and (when present) a loopback Origin, and must not be marked `Sec-Fetch-Site: cross-site`. A missing Origin (Claude
 * Code's hook client, curl) is allowed.
 */
export function isAllowedRequest(headers: {
  host?: string | undefined;
  origin?: string | undefined;
  'sec-fetch-site'?: string | undefined;
}): boolean {
  // Browsers mark requests initiated by another site; same rule as a foreign Origin.
  if (headers['sec-fetch-site'] === 'cross-site') return false;
  if (headers.host !== undefined) {
    const h = hostnameOf(`http://${headers.host}`);
    if (h === null || !LOOPBACK_HOSTNAMES.has(h)) return false;
  }
  if (headers.origin !== undefined) {
    try {
      const u = new URL(headers.origin);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      if (!LOOPBACK_HOSTNAMES.has(u.hostname.toLowerCase())) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Whether the path names an existing file (only stat'ed, never opened). */
function isFile(file: string | null): boolean {
  if (file === null || file === '') return false;
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Whether the path names an existing directory (only stat'ed, never read). */
function isDirectory(dir: string | null): boolean {
  if (dir === null || dir === '') return false;
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function parseClientMessage(raw: string): ClientMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m !== 'object' || m === null) return null;
  const o = m as Record<string, unknown>;
  if (o.type !== 'subscribe') return null;
  if (o.scope === 'sessions') return { type: 'subscribe', scope: 'sessions' };
  if (o.scope === 'session' && typeof o.sessionId === 'string') {
    return {
      type: 'subscribe',
      scope: 'session',
      sessionId: o.sessionId,
      sinceSeq: typeof o.sinceSeq === 'number' && Number.isFinite(o.sinceSeq) ? o.sinceSeq : 0,
    };
  }
  return null;
}

export function buildServer(deps: { store: Store; pipeline: Pipeline; config: Config }): FastifyInstance {
  const { store, pipeline, config } = deps;
  const app = Fastify();
  const connections = new Set<Connection>();

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    const type = reply.getHeader('content-type');
    if (typeof type === 'string' && type.startsWith('text/html')) reply.header('Content-Security-Policy', CSP);
    return payload;
  });

  // Runs before body parsing and the WebSocket upgrade handler.
  app.addHook('onRequest', async (req, reply) => {
    if (isAllowedRequest(req.headers)) return;
    // /hooks keeps its "always an empty 200" contract, but the payload is never ingested.
    // A rejected WebSocket upgrade leaves a detached socket that nothing else closes; end it once the 403 is flushed.
    if (req.headers.upgrade !== undefined) reply.raw.once('finish', () => req.raw.socket.end());
    await reply.code(req.url.split('?')[0] === '/hooks' ? 200 : 403).send();
    return reply;
  });

  const unsubscribe = pipeline.onChanges((changes) => {
    for (const conn of [...connections]) {
      try {
        const out = changes.filter(
          (c) => (conn.sessionsScope && c.type === 'session_upserted') || (conn.sessionId !== null && sessionIdOf(c) === conn.sessionId),
        );
        if (out.length > 0) conn.send({ type: 'changes', changes: out.map(stripDetail) });
      } catch {
        connections.delete(conn); // a failing connection must not affect the others or the pipeline
      }
    }
  });
  // A session re-derived from its raw events (after a failed hook): its open pages refetch the snapshot.
  const unsubscribeResync = pipeline.onResync((sessionId) => {
    for (const conn of [...connections]) {
      try {
        if (conn.sessionId === sessionId) conn.send({ type: 'resync', sessionId });
      } catch {
        connections.delete(conn);
      }
    }
  });
  app.addHook('onClose', async () => {
    unsubscribe();
    unsubscribeResync();
    connections.clear();
  });

  void app.register(fastifyWebsocket);
  void app.register(async (instance) => {
    instance.get('/ws', { websocket: true }, (socket) => {
      const conn: Connection = {
        sessionsScope: false,
        sessionId: null,
        send: (message) => {
          if (socket.readyState !== socket.OPEN) return;
          socket.send(JSON.stringify(message));
          if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
            // Backpressure: a client this far behind cannot catch up live; it reconnects and resyncs.
            connections.delete(conn);
            socket.terminate();
          }
        },
      };
      connections.add(conn);
      socket.on('close', () => connections.delete(conn));
      socket.on('error', () => connections.delete(conn));
      conn.send({ type: 'hello', epoch: store.epoch() });
      socket.on('message', (data) => {
        const msg = parseClientMessage(data.toString());
        if (msg === null) return;
        if (msg.scope === 'sessions') {
          conn.sessionsScope = true;
          return;
        }
        conn.sessionId = msg.sessionId;
        try {
          // Pruned past the client's position, or too far behind: the snapshot is cheaper than the backlog.
          const backlog =
            msg.sinceSeq < store.minSeq() - 1 ? null : store.changesSince(msg.sinceSeq, msg.sessionId, CATCHUP_MAX + 1);
          if (backlog === null || backlog.length > CATCHUP_MAX) {
            conn.send({ type: 'resync', sessionId: msg.sessionId });
            return;
          }
          for (let i = 0; i < backlog.length; i += CATCHUP_CHUNK) {
            conn.send({ type: 'changes', changes: backlog.slice(i, i + CATCHUP_CHUNK).map(stripDetail) });
          }
        } catch {
          socket.terminate();
        }
      });
    });
  });

  app.get('/api/projects', async () => store.listProjects(Date.now()));
  app.get<{ Params: { id: string } }>('/api/projects/:id/sessions', async (req) => store.listSessions(req.params.id));
  app.get<{ Querystring: { q?: unknown; limit?: unknown } }>('/api/search', async (req): Promise<SearchHit[]> => {
    const { q, limit } = req.query;
    if (typeof q !== 'string') return [];
    // An unparseable limit falls back to the default; an out-of-range one is clamped.
    const parsed = typeof limit === 'string' && /^\s*-?\d+\s*$/.test(limit) ? Number(limit) : SEARCH_DEFAULT_LIMIT;
    return store.searchSessions(q, Math.min(SEARCH_MAX_LIMIT, Math.max(1, parsed)));
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/graph', async (req, reply) => {
    // Built from the stored bodies and sent as-is: no parse/re-serialize of every node.
    const json = store.getGraphJson(req.params.id);
    if (json === null) return reply.code(404).send({ error: 'session not found' });
    return reply.header('content-type', 'application/json; charset=utf-8').send(json);
  });
  app.get<{ Params: { id: string; nodeId: string } }>('/api/sessions/:id/nodes/:nodeId', async (req, reply) => {
    const detail = store.getNodeDetail(req.params.id, req.params.nodeId);
    if (detail === null) return reply.code(404).send({ error: 'node not found' });
    return detail;
  });
  app.get(
    '/api/diagnostics',
    async (): Promise<Diagnostics> => {
      const cursorPoll = pipeline.pollStatus('cursor');
      return {
        ...store.diagnostics(),
        hookEvents: store.allHookEventStats(),
        lastHookAt: pipeline.lastHookAt(),
        ingestFailures: pipeline.ingestFailures(),
        importing: pipeline.importing(),
        normalizerVersion: NORMALIZER_VERSION,
        dbEpoch: store.epoch(),
        codex: { sessionsDir: config.codexSessionsDir, sessionsDirExists: isDirectory(config.codexSessionsDir) },
        cursor: {
          dbPath: config.cursorDbPath,
          dbExists: isFile(config.cursorDbPath),
          lastPollAt: cursorPoll?.lastPollAt ?? null,
          lastError: cursorPoll?.lastError ?? null,
        },
      };
    },
  );

  // Encapsulated so its catch-all parser and error handler only affect /hooks: whatever arrives, the answer is an empty 200.
  void app.register(async (instance) => {
    instance.removeAllContentTypeParsers();
    instance.addContentTypeParser('*', { parseAs: 'string', bodyLimit: HOOK_BODY_LIMIT }, (_req, body, done) => done(null, body));
    instance.setErrorHandler((_err, _req, reply) => {
      void reply.code(200).send();
    });
    instance.post<{ Querystring: { origin?: unknown } }>('/hooks', { bodyLimit: HOOK_BODY_LIMIT }, (req, reply) => {
      const text = typeof req.body === 'string' ? req.body : '';
      // `?origin=codex|cursor` comes from `claude-canvas hook-forward`; anything else (none: Claude Code's http hooks) is
      // Claude.
      const q = req.query.origin;
      const origin: Origin = typeof q === 'string' && (ORIGINS as readonly string[]).includes(q) ? (q as Origin) : 'claude';
      void reply.code(200).send();
      setImmediate(() => {
        try {
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            // not JSON: the raw text is stored as the payload
          }
          const obj = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
          const eventName = typeof obj.hook_event_name === 'string' ? obj.hook_event_name : 'unknown';
          const sessionId = typeof obj.session_id === 'string' ? obj.session_id : null;
          const transcriptPath = typeof obj.transcript_path === 'string' ? obj.transcript_path : null;
          if (origin === 'claude') pipeline.ingestHook(eventName, sessionId, text, transcriptPath);
          else if (origin === 'cursor') {
            // Cursor: the conversation id is the session id; the payload is stored without the user's e-mail address.
            pipeline.ingestHook(eventName, cursorHookConversationId(obj), sanitizeCursorHookPayload(text), null, origin, {
              cwd: cursorHookWorkspaceRoot(obj),
              agentId: null,
            });
          } else {
            const cwd = typeof obj.cwd === 'string' && obj.cwd !== '' ? obj.cwd : null;
            const agentId = typeof obj.agent_id === 'string' && obj.agent_id !== '' ? obj.agent_id : null;
            pipeline.ingestHook(eventName, sessionId, text, transcriptPath, origin, { cwd, agentId });
          }
        } catch (err) {
          // best effort: the hook has already been answered
          pipeline.reportFailure('hook', err);
        }
      });
    });
  });

  if (config.webDist !== null && fs.existsSync(config.webDist) && fs.statSync(config.webDist).isDirectory()) {
    void app.register(fastifyStatic, { root: config.webDist });
    app.setNotFoundHandler((req, reply) => {
      const url = req.url;
      if (req.method === 'GET' && !RESERVED_PREFIXES.some((p) => url === p || url.startsWith(p + '/') || url.startsWith(p + '?'))) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  }

  return app;
}
