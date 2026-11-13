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
  type ContentSearchResponse,
  type Diagnostics,
  type NotificationSettingsResponse,
  type NotificationTestResponse,
  type Origin,
  type SearchHit,
  type SearchIndexStatus,
  type SeqChange,
  type ServerMessage,
} from '@agent-canvas/shared';
import type { Config } from '../config.js';
import { cursorHookConversationId, cursorHookWorkspaceRoot, sanitizeCursorHookPayload } from '../normalize/cursor-hooks.js';
import { NORMALIZER_VERSION } from '../normalize/version.js';
import type { NotificationService } from '../notify/service.js';
import type { Pipeline } from '../pipeline.js';
import { KEY_PREFIXES } from '../sources/source.js';
import { storageStatus, type StorageDiagnostics } from '../store/migrate-storage.js';
import type { Store } from '../store/store.js';
import { AnomaliesService, parseAnomalyListQuery } from '../anomalies/service.js';
import { FilesService, parseFilesQuery } from '../files/service.js';
import { parseStatsQuery, StatsService, storeStatsSource } from '../stats/service.js';

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

/**
 * `notifications`: the desktop notification service (`start` only). With it come the /api/notifications routes and the
 * diagnostics' `notifications` block, and hook events are shown to it before they are ingested.
 * `stats`: the service behind /api/stats (default: one reading `store`); it is told about every change the pipeline
 * reports.
 * `files`: the service behind /api/files and /api/sessions/:id/files (default: one reading `store`); told the same.
 * `anomalies`: the service behind /api/anomalies, /api/anomalies/counts and /api/sessions/:id/anomalies (default: one
 * reading `store`, its answers saying `computing` while the pipeline imports); told the same.
 */
export function buildServer(deps: {
  store: Store;
  pipeline: Pipeline;
  config: Config;
  notifications?: NotificationService;
  stats?: StatsService;
  files?: FilesService;
  anomalies?: AnomaliesService;
  /** The storage job (start()); without one, Diagnostics.storage is read from the database alone. */
  storage?: { status(): StorageDiagnostics };
  /** The search index build (start(), when the index was incomplete): Diagnostics.search with its lastError. */
  search?: { status(): SearchIndexStatus };
}): FastifyInstance {
  const { store, pipeline, config, notifications } = deps;
  const stats = deps.stats ?? new StatsService(storeStatsSource(store));
  const files = deps.files ?? new FilesService(storeStatsSource(store));
  const anomalies = deps.anomalies ?? new AnomaliesService(storeStatsSource(store), { importing: () => pipeline.importing() });
  // One read of a session builds both its stats and its file summary. The anomaly service reads on its own: sharing would
  // put three summaries of a large session in one synchronous stretch (measured: 450 ms instead of 250 ms for a
  // 100,000-node session) and make every background recompute of a running session rebuild its stats too.
  files.shareReadsWith(stats);
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
  // Stats summaries of changed sessions are dropped here and recomputed only when /api/stats next needs them.
  const unsubscribeStats = pipeline.onChanges((changes) => stats.noteChanges(changes));
  // Likewise the file summaries.
  const unsubscribeFiles = pipeline.onChanges((changes) => files.noteChanges(changes));
  // Likewise the anomaly summaries (running sessions may be recomputed at once for the notifications, see the service).
  const unsubscribeAnomalies = pipeline.onChanges((changes) => anomalies.noteChanges(changes));
  app.addHook('onClose', async () => {
    unsubscribe();
    unsubscribeResync();
    unsubscribeStats();
    unsubscribeFiles();
    unsubscribeAnomalies();
    if (deps.files === undefined) files.close(); // the default one is ours
    if (deps.anomalies === undefined) anomalies.close();
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
  // Search inside sessions: conversation text by design (the snippets). `q` other than one string: no hits. 400 for an
  // unknown origin. indexing: the index is still being built (results may be incomplete).
  app.get<{ Querystring: { q?: unknown; origin?: unknown; projectId?: unknown } }>(
    '/api/search/content',
    async (req, reply): Promise<ContentSearchResponse | undefined> => {
      const { q, origin, projectId } = req.query;
      if (origin !== undefined && (typeof origin !== 'string' || !(ORIGINS as readonly string[]).includes(origin))) {
        return reply.code(400).send({ error: 'unknown origin' });
      }
      if (projectId !== undefined && typeof projectId !== 'string') return reply.code(400).send({ error: 'bad projectId' });
      const indexing = store.searchIndexStatus().indexing;
      if (typeof q !== 'string') return { hits: [], truncated: false, shortQuery: false, indexing };
      const result = store.searchContent(q, {
        origin: (origin as Origin | undefined) ?? null,
        projectId: projectId === undefined || projectId === '' ? null : projectId,
      });
      return { ...result, indexing };
    },
  );
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
  // Counts, durations, names and ids only (no conversation content). 400 for an unknown range / origin.
  // coverage.importing: pipeline.importing() at answer time.
  app.get<{ Querystring: Record<string, unknown> }>('/api/stats', async (req, reply) => {
    const query = parseStatsQuery(req.query);
    if ('error' in query) return reply.code(400).send({ error: query.error });
    const result = await stats.get(query);
    // Read at answer time: the numbers may still be filling in while the pipeline imports.
    return { ...result, coverage: { ...result.coverage, importing: pipeline.importing() } };
  });
  // Paths, counts, times, tool names and ids only (no conversation content).
  app.get<{ Params: { id: string } }>('/api/sessions/:id/files', async (req, reply) => {
    const result = await files.session(req.params.id);
    if (result === null) return reply.code(404).send({ error: 'session not found' });
    return result;
  });
  // Paths, counts, times, session titles and ids only. 400 for a missing projectId or a bad parameter; an unknown
  // project is an empty result. importing: pipeline.importing() at answer time.
  app.get<{ Querystring: Record<string, unknown> }>('/api/files', async (req, reply) => {
    const query = parseFilesQuery(req.query);
    if ('error' in query) return reply.code(400).send({ error: query.error });
    return files.project(query, pipeline.importing());
  });
  // Kinds, counts, numbers, times, ids, paths and the session title only (no conversation content or tool input).
  app.get<{ Params: { id: string } }>('/api/sessions/:id/anomalies', async (req, reply) => {
    const result = await anomalies.session(req.params.id);
    if (result === null) return reply.code(404).send({ error: 'session not found' });
    return result;
  });
  // 400 for an unknown range / origin / kind or a repeated parameter; an unknown project is an empty result.
  app.get<{ Querystring: Record<string, unknown> }>('/api/anomalies', async (req, reply) => {
    const query = parseAnomalyListQuery(req.query);
    if ('error' in query) return reply.code(400).send({ error: query.error });
    return anomalies.list(query);
  });
  app.get('/api/anomalies/counts', async () => anomalies.counts());
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
          hasData: store.transcriptKeys(KEY_PREFIXES.cursor).length > 0,
        },
        ...(notifications !== undefined ? { notifications: notifications.diagnostics() } : {}),
        storage: deps.storage?.status() ?? storageStatus(store),
        search: deps.search?.status() ?? store.searchIndexStatus(),
      };
    },
  );

  if (notifications !== undefined) {
    app.get('/api/notifications/settings', async (): Promise<NotificationSettingsResponse> => notifications.getSettings());
    app.put('/api/notifications/settings', async (req, reply) => {
      // While the database is being compacted (VACUUM) writes are held; a settings change would only live in memory.
      if (pipeline.writesHeld()) return reply.code(503).send({ error: '数据库正在整理，稍后再试' });
      const result = notifications.putSettings(req.body);
      if (!result.ok) return reply.code(400).send({ error: result.error });
      return result.response;
    });
    // Always 200: a delivery failure is not a client error.
    app.post('/api/notifications/test', async (): Promise<NotificationTestResponse> => notifications.test());
  }

  // Encapsulated so its catch-all parser and error handler only affect /hooks: whatever arrives, the answer is an empty 200.
  void app.register(async (instance) => {
    instance.removeAllContentTypeParsers();
    instance.addContentTypeParser('*', { parseAs: 'string', bodyLimit: HOOK_BODY_LIMIT }, (_req, body, done) => done(null, body));
    instance.setErrorHandler((_err, _req, reply) => {
      void reply.code(200).send();
    });
    instance.post<{ Querystring: { origin?: unknown } }>('/hooks', { bodyLimit: HOOK_BODY_LIMIT }, (req, reply) => {
      const text = typeof req.body === 'string' ? req.body : '';
      // `?origin=codex|cursor` comes from `agent-canvas hook-forward`; anything else (none: Claude Code's http hooks) is
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
          if (notifications !== undefined) {
            // Before ingesting: Claude Code's StopFailure must be known when the status change it causes arrives.
            const agentId = typeof obj.agent_id === 'string' && obj.agent_id !== '' ? obj.agent_id : null;
            // Cursor's session id is the conversation id (as ingested below).
            const hookSession = origin === 'cursor' ? cursorHookConversationId(obj) : sessionId;
            notifications.handleHook(origin, eventName, hookSession, agentId, obj);
          }
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
