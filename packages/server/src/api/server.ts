import fs from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import {
  FILE_ONLY_ORIGINS,
  ORIGINS,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  type AttentionResponse,
  type Change,
  type ClientMessage,
  type ContentSearchResponse,
  type Diagnostics,
  type FileOnlyOrigin,
  type FileSourceStatus,
  type NotificationSettings,
  type NotificationSettingsResponse,
  type NotificationTestResponse,
  type Origin,
  type SearchHit,
  type SearchIndexStatus,
  type SeqChange,
  type ServerMessage,
} from '@agent-canvas/shared';
import { AttentionService } from '../attention/service.js';
import { BookmarksService, type BookmarkResult } from '../bookmarks/service.js';
import type { Config } from '../config.js';
import { isForeignHookPayload } from '../hook-guard.js';
import { ABORTED_NOTE } from '../normalize/cursor.js';
import { cursorHookConversationId, cursorHookWorkspaceRoot, sanitizeCursorHookPayload } from '../normalize/cursor-hooks.js';
import { NORMALIZER_VERSION } from '../normalize/version.js';
import type { NotificationService } from '../notify/service.js';
import { loadNotificationSettings } from '../notify/settings.js';
import type { Pipeline } from '../pipeline.js';
import { isExistingDir, sourceDirsOf } from '../sources/dirs.js';
import { DSH_UNAVAILABLE, zstdAvailable } from '../sources/deepseek/zstd-frames.js';
import { KEY_PREFIXES } from '../sources/source.js';
import { storageStatus, type StorageDiagnostics } from '../store/migrate-storage.js';
import { SAMPLE_MAX, type Store } from '../store/store.js';
import { AnomaliesService, parseAnomalyListQuery } from '../anomalies/service.js';
import { ExportService, type ExportAnswer } from '../export/service.js';
import { LearnedValuesService, parseLearnedBody } from '../export/learned.js';
import { maskedContentSnippet, maskedDiagnostics, maskedSessionMatch, snippetMasker } from '../export/masked-search.js';
import { FilesService, parseFilesQuery } from '../files/service.js';
import { parseStatsQuery, StatsService, storeStatsSource } from '../stats/service.js';
import { TodayService, type TodayServiceDeps } from '../stats/today-service.js';

const HOOK_BODY_LIMIT = 64 * 1024 * 1024;
/** The origins `/hooks?origin=` accepts (the others install no hooks); anything else is Claude Code. */
const HOOK_ORIGINS = ['claude', 'codex', 'cursor'] as const;
type HookOrigin = (typeof HOOK_ORIGINS)[number];
/** More changes than this to catch up on: tell the client to refetch the snapshot instead. */
export const CATCHUP_MAX = 5000;
/** Changes per catch-up message. */
export const CATCHUP_CHUNK = 1000;
/** A socket whose unsent data exceeds this is too slow to keep up and is terminated. */
export const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const RESERVED_PREFIXES = ['/api', '/ws', '/hooks'];
/** Longest path parameter the router accepts (session ids, project ids, node ids). */
const MAX_PARAM_LENGTH = 8192;
/** Period of the attention page's time-driven re-evaluation (stuck, auto-hide): within a minute (attention spec 4.2). */
export const ATTENTION_TICK_MS = 30_000;
/** The /api/attention routes' 503 before the service exists (start() creates it once the server listens). */
export const ATTENTION_NOT_READY = '待处理列表正在准备，稍后再试';
/** The write routes' 503 while the database is being compacted (VACUUM holds writes). */
const WRITES_HELD = '数据库正在整理，稍后再试';

/**
 * The attention service as the server runs it (attention spec 4): `stuckMinutes` is the notification settings' value,
 * read at every use (also while notifications are off); a Cursor call counts as aborted when its stored note says so,
 * as the notification service tells it. Construction reads the store: about 1 s with 1,500 sessions active in 30 days.
 */
export function createAttentionService(
  store: Store,
  options: { now?: () => number; coalesceMs?: number; log?: (line: string) => void } = {},
): AttentionService {
  return new AttentionService({
    store,
    now: options.now ?? Date.now,
    stuckMinutes: () => loadNotificationSettings(store).settings.stuckMinutes,
    isAbortedCall: (sessionId, nodeId) => store.getNodeDetail(sessionId, nodeId)?.text === ABORTED_NOTE,
    ...(options.coalesceMs !== undefined ? { coalesceMs: options.coalesceMs } : {}),
    ...(options.log !== undefined ? { log: options.log } : {}),
  });
}

/**
 * The today service as the server runs it (spec 2026-11-24-today-usage-design.md 5, 6): the line is the notification
 * settings' usageLineTokens (0: none), read at every computation from the notification service when there is one, else
 * from the store; ready while the start-up work is done and nothing is importing; a crossing goes to the notification
 * service, which decides by its switches.
 */
export function createTodayService(deps: {
  store: Store;
  pipeline: Pick<Pipeline, 'importing'> & { startupDone?(): boolean };
  cache: TodayServiceDeps['cache'];
  notifications?: NotificationService;
  now?: () => number;
  dayKey?: (ms: number) => string;
  timers?: TodayServiceDeps['timers'];
}): TodayService {
  const { store, pipeline, notifications } = deps;
  return new TodayService({
    cache: deps.cache,
    store,
    line: () => {
      const tokens = (notifications?.getSettings().settings ?? loadNotificationSettings(store).settings).usageLineTokens;
      return tokens > 0 ? tokens : null;
    },
    ready: () => (pipeline.startupDone?.() ?? true) && !pipeline.importing(),
    ...(notifications !== undefined ? { onCross: (usage) => notifications.notifyUsage(usage) } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.dayKey !== undefined ? { dayKey: deps.dayKey } : {}),
    ...(deps.timers !== undefined ? { timers: deps.timers } : {}),
  });
}

/**
 * Whether a notification settings change concerns today's usage: the line moved (recolour now), or the usage
 * notification was turned on (master and `usage`; a crossing since the last computation must not be caught up on).
 */
export function todaySettingsChanged(before: NotificationSettings, after: NotificationSettings): boolean {
  const on = (s: NotificationSettings): boolean => s.enabled && s.usage;
  return before.usageLineTokens !== after.usageLineTokens || (!on(before) && on(after));
}

/**
 * The attention service of a server that is built before it (start(): its construction would delay listening). The
 * server wires the service when set() is called; until then the /api/attention routes answer 503 ATTENTION_NOT_READY.
 * One slot serves one server.
 */
export class AttentionSlot {
  private service: AttentionService | null = null;
  private onSet: ((service: AttentionService) => void) | null = null;

  get(): AttentionService | null {
    return this.service;
  }

  /** Once only; the caller keeps owning (and closes) the service. */
  set(service: AttentionService): void {
    if (this.service !== null) throw new Error('attention service already set');
    this.service = service;
    this.onSet?.(service);
  }

  /** buildServer's hook: called with the service when it is set, at once when it already is; null unbinds. */
  bind(listener: ((service: AttentionService) => void) | null): void {
    this.onSet = listener;
    if (listener !== null && this.service !== null) listener(this.service);
  }
}

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
    case 'node_removed':
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

/**
 * The export routes (and the export settings' PUT) send a session's whole text, or change what masking does: on top of
 * isAllowedRequest they require an `Origin` that is this very service (an http loopback origin whose host:port is the
 * request's Host), so a request without Origin (another program, a link) or from another page is refused.
 */
export function isSameOriginRequest(headers: { host?: string | undefined; origin?: string | undefined }): boolean {
  const { host, origin } = headers;
  if (typeof host !== 'string' || typeof origin !== 'string') return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' || !LOOPBACK_HOSTNAMES.has(u.hostname.toLowerCase())) return false;
  return u.host.toLowerCase() === host.toLowerCase();
}

/** `Content-Type: application/json` (parameters such as charset allowed). */
export function isJsonContentType(type: string | undefined): boolean {
  return typeof type === 'string' && /^application\/json\s*(;|$)/i.test(type);
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

/**
 * Diagnostics.sources: each file-only origin's directory (stat only, never read) and its stored session count. `dir` is
 * the first directory the source reads (null when disabled), `present` whether any of them exists now; `dirs` lists
 * each of them when there are several (WorkBuddy, Doubao Work). What a running source reports through `status()` is
 * merged over that.
 */
function fileOnlySources(config: Config, store: Store, pipeline: Pipeline): Record<FileOnlyOrigin, FileSourceStatus> {
  const counts = store.sessionCountsByOrigin();
  const running = new Map(pipeline.fileSources().map((s) => [s.origin, s] as const));
  const out = {} as Record<FileOnlyOrigin, FileSourceStatus>;
  for (const origin of FILE_ONLY_ORIGINS) {
    const dirs = sourceDirsOf(config, origin).map((dir) => ({ dir, present: isExistingDir(dir) }));
    const source = running.get(origin);
    out[origin] = {
      dir: dirs[0]?.dir ?? null,
      present: dirs.some((d) => d.present),
      reading: source !== undefined,
      sessionCount: counts[origin] ?? 0,
      ...(dirs.length > 1 ? { dirs } : {}),
      ...(source?.status?.() ?? {}),
      // DeepSeek on a Node without zstd: the directory is there but the source was not created (fileSources).
      ...(origin === 'deepseek' && source === undefined && dirs.some((d) => d.present) && !zstdAvailable() ? { unavailable: DSH_UNAVAILABLE } : {}),
    };
  }
  return out;
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
 * reading `store`, its answers saying `computing` until pipeline.startupDone()); told the same.
 * `attention`: the service behind /api/attention (default: one made by createAttentionService, closed with the server);
 * an AttentionSlot when it is created after the server (start()). Whichever it is, it is fed the change stream, the
 * re-derived sessions and the stored hooks, ticked every ATTENTION_TICK_MS, and its updates are pushed to every
 * sessions-scope WebSocket connection as `attention` messages; all of it stops when the server closes.
 * `today`: the service behind /api/today (default: one made by createTodayService over the stats summary cache, closed
 * with the server); fed the change stream, told when the notification settings change, its updates pushed to every
 * sessions-scope connection as `today` messages.
 * `bookmarks`: the service behind /api/bookmarks (default: one reading `store`); after each of its writes the sessions
 * whose bookmarks changed are pushed to every sessions-scope connection as a `bookmarks` message.
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
  /** Export and its settings (default: one reading `store`, settings in config.dataDir). */
  exports?: ExportService;
  attention?: AttentionService | AttentionSlot;
  today?: TodayService;
  bookmarks?: BookmarksService;
}): FastifyInstance {
  const { store, pipeline, config, notifications } = deps;
  const stats = deps.stats ?? new StatsService(storeStatsSource(store));
  const files = deps.files ?? new FilesService(storeStatsSource(store));
  const anomalies = deps.anomalies ?? new AnomaliesService(storeStatsSource(store), { startupDone: () => pipeline.startupDone() });
  // One read of a session builds both its stats and its file summary. The anomaly service reads on its own: sharing would
  // put three summaries of a large session in one synchronous stretch (measured: 450 ms instead of 250 ms for a
  // 100,000-node session) and make every background recompute of a running session rebuild its stats too.
  files.shareReadsWith(stats);
  const exports = deps.exports ?? new ExportService({ store, dataDir: config.dataDir });
  const learned = new LearnedValuesService(store);
  const bookmarks = deps.bookmarks ?? new BookmarksService({ store });
  // Built here, computed on the first request or change (not now: that would delay listening).
  const today =
    deps.today ?? createTodayService({ store, pipeline, cache: stats.summaryCache(), ...(notifications !== undefined ? { notifications } : {}) });
  // The router refuses a path parameter longer than maxParamLength (default 100) as if the route did not exist. Node
  // ids are built from the tools' own ids — a subagent's node carries two session ids and a call id — and are often
  // longer, so their details answered 404 (or 414). Node's own limit on the request line still bounds the length.
  const app = Fastify({ routerOptions: { maxParamLength: MAX_PARAM_LENGTH } });
  const connections = new Set<Connection>();
  /** Hook calls dropped by the foreign-payload guard since the server was built (Diagnostics.foreignHooksDropped). */
  let foreignHooksDropped = 0;

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
  // Learned values of a changed session are computed again on the next request.
  const unsubscribeLearned = pipeline.onChanges((changes) => learned.noteChanges(changes));
  /** A message for every sessions-scope connection (the app's shared feed). */
  const pushToSessionsScope = (message: ServerMessage): void => {
    for (const conn of [...connections]) {
      if (!conn.sessionsScope) continue;
      try {
        conn.send(message);
      } catch {
        connections.delete(conn);
      }
    }
  };
  // Today's usage (header, stats block): recomputed at most every 30 s while sessions change, pushed when it changes.
  const unwireToday = [
    pipeline.onChanges((changes) => today.noteChanges(changes)),
    today.onUpdate((usage) => pushToSessionsScope({ type: 'today', usage })),
  ];
  const unwireBookmarks = bookmarks.onUpdate((sessionIds) => pushToSessionsScope({ type: 'bookmarks', sessionIds }));
  // The attention page (spec 4.2): not tied to the notifications (they exist in start() only).
  const wireAttention = (service: AttentionService): (() => void) => {
    const offs = [
      pipeline.onChanges((changes) => service.noteChanges(changes)),
      pipeline.onResync((sessionId) => service.noteResync(sessionId)),
      pipeline.onHookStored((sessionId) => service.noteHook(sessionId)),
      service.onUpdate((response) => pushToSessionsScope({ type: 'attention', response })),
    ];
    // Changes caused by time alone: a running session becoming stuck, an item passing the auto-hide limit.
    const timer = setInterval(() => {
      try {
        service.tick();
      } catch {
        // the next tick tries again
      }
    }, ATTENTION_TICK_MS);
    timer.unref();
    return () => {
      for (const off of offs) off();
      clearInterval(timer);
    };
  };
  let attentionSlot: AttentionSlot;
  if (deps.attention instanceof AttentionSlot) attentionSlot = deps.attention;
  else {
    attentionSlot = new AttentionSlot();
    attentionSlot.set(deps.attention ?? createAttentionService(store));
  }
  const ownAttention = deps.attention === undefined ? attentionSlot.get() : null;
  let unwireAttention = (): void => {};
  attentionSlot.bind((service) => {
    unwireAttention = wireAttention(service);
  });
  app.addHook('onClose', async () => {
    unsubscribe();
    unsubscribeResync();
    unsubscribeStats();
    unsubscribeFiles();
    unsubscribeAnomalies();
    unsubscribeLearned();
    for (const off of unwireToday) off();
    unwireBookmarks();
    if (deps.today === undefined) today.close(); // the default one is ours
    attentionSlot.bind(null);
    unwireAttention();
    ownAttention?.close();
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
  // `mask=1` (the page's masking switch): every snippet is cut from the masked full source (masked-search.ts), with
  // `masked: true` on each match; without it the answer is unchanged.
  app.get<{ Querystring: { q?: unknown; limit?: unknown; mask?: unknown } }>('/api/search', async (req, reply): Promise<SearchHit[]> => {
    const { q, limit } = req.query;
    if (typeof q !== 'string') return [];
    // An unparseable limit falls back to the default; an out-of-range one is clamped.
    const parsed = typeof limit === 'string' && /^\s*-?\d+\s*$/.test(limit) ? Number(limit) : SEARCH_DEFAULT_LIMIT;
    const hits = store.searchSessions(q, Math.min(SEARCH_MAX_LIMIT, Math.max(1, parsed)));
    if (req.query.mask !== '1') return hits;
    reply.header('cache-control', 'no-store');
    const masker = snippetMasker(config.dataDir);
    return hits.map((hit) => ({ ...hit, matches: hit.matches.map((m) => maskedSessionMatch(masker, store, hit, m, q)) }));
  });
  // Search inside sessions: conversation text by design (the snippets). `q` other than one string: no hits. 400 for an
  // unknown origin. indexing: the index is still being built (results may be incomplete).
  // `mask=1`: snippets cut from the masked part holding the match, `masked: true` on each hit.
  app.get<{ Querystring: { q?: unknown; origin?: unknown; projectId?: unknown; mask?: unknown } }>(
    '/api/search/content',
    async (req, reply): Promise<ContentSearchResponse | undefined> => {
      const { q, origin, projectId } = req.query;
      if (origin !== undefined && (typeof origin !== 'string' || !(ORIGINS as readonly string[]).includes(origin))) {
        return reply.code(400).send({ error: 'unknown origin' });
      }
      if (projectId !== undefined && typeof projectId !== 'string') return reply.code(400).send({ error: 'bad projectId' });
      const indexing = store.searchIndexStatus().indexing;
      if (typeof q !== 'string') return { hits: [], truncated: false, shortQuery: false, indexing };
      const masked = req.query.mask === '1';
      const masker = masked ? snippetMasker(config.dataDir) : null;
      if (masked) reply.header('cache-control', 'no-store');
      const result = store.searchContent(q, {
        origin: (origin as Origin | undefined) ?? null,
        projectId: projectId === undefined || projectId === '' ? null : projectId,
        ...(masked ? { snippet: (it, at, length, part) => maskedContentSnippet(masker, it, at, length, part) } : {}),
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
    if (result === 'failed') return reply.code(500).send({ error: 'anomaly detection failed for this session' });
    return result;
  });
  // 400 for an unknown range / origin / kind or a repeated parameter; an unknown project is an empty result.
  app.get<{ Querystring: Record<string, unknown> }>('/api/anomalies', async (req, reply) => {
    const query = parseAnomalyListQuery(req.query);
    if ('error' in query) return reply.code(400).send({ error: query.error });
    return anomalies.list(query);
  });
  app.get('/api/anomalies/counts', async () => anomalies.counts());
  // Today's usage: counts and durations only (no conversation content); at most 30 s behind (TODAY_THROTTLE_MS).
  app.get('/api/today', async () => today.get());
  // `mask=1`: unknown-record samples (cut raw records) masked.
  app.get<{ Querystring: { mask?: unknown } }>(
    '/api/diagnostics',
    async (req, reply): Promise<Diagnostics> => {
      const cursorPoll = pipeline.pollStatus('cursor');
      const d: Diagnostics = {
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
        foreignHooksDropped,
        sources: fileOnlySources(config, store, pipeline),
      };
      if (req.query.mask !== '1') return d;
      reply.header('cache-control', 'no-store');
      return maskedDiagnostics(snippetMasker(config.dataDir), d, SAMPLE_MAX);
    },
  );

  // ---- export (spec 2026-11-13-export-and-masking-design.md 4.2): POST with a JSON body from this service's own page.
  const sameOriginJson = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    if (isSameOriginRequest(req.headers) && isJsonContentType(req.headers['content-type'])) return undefined;
    return reply.code(403).header('cache-control', 'no-store').send({ error: '只接受来自本页面的 JSON 请求' });
  };
  const answer = (reply: FastifyReply, a: ExportAnswer): FastifyReply => {
    reply.header('cache-control', 'no-store');
    if ('file' in a) return reply.code(200).headers(a.headers).send(a.file);
    return reply.code(a.status).send(a.json);
  };
  /** True once the client has gone away before the answer was sent. */
  const goneFlag = (reply: FastifyReply): (() => boolean) => {
    let gone = false;
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) gone = true;
    });
    return () => gone || reply.raw.destroyed;
  };
  app.post<{ Params: { id: string } }>('/api/sessions/:id/export/preview', { onRequest: sameOriginJson }, async (req, reply) =>
    answer(reply, await exports.preview(req.params.id, req.body, goneFlag(reply))),
  );
  app.post<{ Params: { id: string } }>('/api/sessions/:id/export', { onRequest: sameOriginJson }, async (req, reply) =>
    answer(reply, await exports.export(req.params.id, req.body, goneFlag(reply))),
  );
  app.get('/api/export/settings', async (_req, reply) => reply.header('cache-control', 'no-store').send(exports.getSettings()));
  app.put('/api/export/settings', { onRequest: sameOriginJson }, async (req, reply) => answer(reply, exports.putSettings(req.body)));
  // The session's learned secret values for the page's masking switch (export/learned.ts explains why it exists).
  // Guarded like the export routes; secret values: no-store, never logged. 200 { values, capped }, 400, 403, 404.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/mask/learned', { onRequest: sameOriginJson }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const body = parseLearnedBody(req.body);
    if (!body.ok) return reply.code(400).send({ error: body.error });
    const result = await learned.get(req.params.id, body.categories);
    if (result === null) return reply.code(404).send({ error: 'session not found' });
    return result;
  });

  // ---- attention page (spec 4.5). Explanations are conversation text (the page masks them); answers are not cached.
  // GET: the state without the hidden list (hiddenCount gives its length); `hidden=1` adds it.
  app.get<{ Querystring: { hidden?: unknown } }>('/api/attention', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const service = attentionSlot.get();
    if (service === null) return reply.code(503).send({ error: ATTENTION_NOT_READY });
    return service.snapshot({ includeHidden: req.query.hidden === '1' });
  });
  /** A write route's answer: 503 (no service yet, writes held), 400 (refused), or the state without the hidden list. */
  const attentionWrite = (
    reply: FastifyReply,
    act: (service: AttentionService) => { ok: true } | { ok: false; error: string },
  ): FastifyReply | AttentionResponse => {
    reply.header('cache-control', 'no-store');
    const service = attentionSlot.get();
    if (service === null) return reply.code(503).send({ error: ATTENTION_NOT_READY });
    // While the database is being compacted (VACUUM) writes are held; a change would only live in memory.
    if (pipeline.writesHeld()) return reply.code(503).send({ error: WRITES_HELD });
    const result = act(service);
    if (!result.ok) return reply.code(400).send({ error: result.error });
    return service.snapshot();
  };
  const field = (body: unknown, name: string): unknown =>
    typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>)[name] : undefined;
  const withKey = (body: unknown, act: (key: string) => { ok: true } | { ok: false; error: string }) => {
    const key = field(body, 'key');
    return typeof key === 'string' && key !== '' ? act(key) : { ok: false as const, error: 'key 必须是非空的字符串' };
  };
  app.post('/api/attention/dismiss', { onRequest: sameOriginJson }, async (req, reply) =>
    attentionWrite(reply, (service) => withKey(req.body, (key) => service.dismiss(key))),
  );
  app.post('/api/attention/restore', { onRequest: sameOriginJson }, async (req, reply) =>
    attentionWrite(reply, (service) => withKey(req.body, (key) => service.restore(key))),
  );
  app.put('/api/attention/settings', { onRequest: sameOriginJson }, async (req, reply) =>
    attentionWrite(reply, (service) => service.setAutoHideHours(field(req.body, 'autoHideHours'))),
  );

  // ---- bookmarks (spec 2026-11-24-bookmarks-design.md 7). Writes guarded like the export routes (sameOriginJson: the
  // DELETE and the restore send a JSON body too, `{}`); 503 while writes are held. Answers are not cached.
  /** A path id: a positive decimal integer, else null (answered 404, as an unknown id). */
  const bookmarkId = (raw: string): number | null => {
    if (!/^[1-9]\d{0,15}$/.test(raw)) return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : null;
  };
  const bookmarkAnswer = (reply: FastifyReply, result: BookmarkResult): FastifyReply => {
    if (result.ok) return reply.code(result.status).send(result.bookmark);
    const { ok: _ok, status, ...json } = result;
    return reply.code(status).send(json);
  };
  /** The write routes' common start: no-store; 503 while the database is being compacted (writes held). */
  const bookmarkWrite = (reply: FastifyReply): FastifyReply | null => {
    reply.header('cache-control', 'no-store');
    return pipeline.writesHeld() ? reply.code(503).send({ error: WRITES_HELD }) : null;
  };
  const NO_BOOKMARK = { error: '找不到这个书签' };
  app.get<{ Querystring: { sessionId?: unknown } }>('/api/bookmarks', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const { sessionId } = req.query;
    if (sessionId !== undefined && typeof sessionId !== 'string') return reply.code(400).send({ error: 'sessionId 只能给一个' });
    return { bookmarks: bookmarks.list(sessionId === undefined || sessionId === '' ? undefined : sessionId) };
  });
  app.post('/api/bookmarks', { onRequest: sameOriginJson }, async (req, reply) => {
    return bookmarkWrite(reply) ?? bookmarkAnswer(reply, bookmarks.create(req.body));
  });
  app.patch<{ Params: { id: string } }>('/api/bookmarks/:id', { onRequest: sameOriginJson }, async (req, reply) => {
    const held = bookmarkWrite(reply);
    if (held !== null) return held;
    const id = bookmarkId(req.params.id);
    return id === null ? reply.code(404).send(NO_BOOKMARK) : bookmarkAnswer(reply, bookmarks.updateNote(id, req.body));
  });
  app.delete<{ Params: { id: string } }>('/api/bookmarks/:id', { onRequest: sameOriginJson }, async (req, reply) => {
    const held = bookmarkWrite(reply);
    if (held !== null) return held;
    const id = bookmarkId(req.params.id);
    const result = id === null ? null : bookmarks.remove(id);
    if (result === null || !result.ok) return reply.code(404).send(NO_BOOKMARK);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/bookmarks/:id/restore', { onRequest: sameOriginJson }, async (req, reply) => {
    const held = bookmarkWrite(reply);
    if (held !== null) return held;
    const id = bookmarkId(req.params.id);
    return id === null ? reply.code(404).send(NO_BOOKMARK) : bookmarkAnswer(reply, bookmarks.restore(id));
  });

  if (notifications !== undefined) {
    app.get('/api/notifications/settings', async (): Promise<NotificationSettingsResponse> => notifications.getSettings());
    app.put('/api/notifications/settings', async (req, reply) => {
      // While the database is being compacted (VACUUM) writes are held; a settings change would only live in memory.
      if (pipeline.writesHeld()) return reply.code(503).send({ error: '数据库正在整理，稍后再试' });
      const before = notifications.getSettings().settings;
      const result = notifications.putSettings(req.body);
      if (!result.ok) return reply.code(400).send({ error: result.error });
      if (todaySettingsChanged(before, result.response.settings)) today.settingsChanged();
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
      const origin: HookOrigin = typeof q === 'string' && (HOOK_ORIGINS as readonly string[]).includes(q) ? (q as HookOrigin) : 'claude';
      void reply.code(200).send();
      setImmediate(() => {
        try {
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            // not JSON: the raw text is stored as the payload
          }
          // Another tool calling our Claude Code / Cursor hook (spec section 7): answered as usual, nothing stored.
          if (isForeignHookPayload(origin, parsed)) {
            foreignHooksDropped += 1;
            return;
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
