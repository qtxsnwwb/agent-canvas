import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { Change, ClientMessage, SeqChange, ServerMessage } from '@claude-canvas/shared';
import type { Config } from '../config.js';
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
 * and (when present) a loopback Origin. A missing Origin (Claude Code's hook client, curl) is allowed.
 */
export function isAllowedRequest(headers: { host?: string | undefined; origin?: string | undefined }): boolean {
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
  app.addHook('onClose', async () => {
    unsubscribe();
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

  app.get('/api/projects', async () => store.listProjects());
  app.get<{ Params: { id: string } }>('/api/projects/:id/sessions', async (req) => store.listSessions(req.params.id));
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
  app.get('/api/diagnostics', async () => ({ ...store.diagnostics(), lastHookAt: pipeline.lastHookAt() }));

  // Encapsulated so its catch-all parser and error handler only affect /hooks: whatever arrives, the answer is an empty 200.
  void app.register(async (instance) => {
    instance.removeAllContentTypeParsers();
    instance.addContentTypeParser('*', { parseAs: 'string', bodyLimit: HOOK_BODY_LIMIT }, (_req, body, done) => done(null, body));
    instance.setErrorHandler((_err, _req, reply) => {
      void reply.code(200).send();
    });
    instance.post('/hooks', { bodyLimit: HOOK_BODY_LIMIT }, (req, reply) => {
      const text = typeof req.body === 'string' ? req.body : '';
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
          pipeline.ingestHook(eventName, sessionId, text, transcriptPath);
        } catch {
          // best effort: the hook has already been answered
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
