import type Database from 'better-sqlite3';
import {
  CONTENT_MAX_HITS_PER_SESSION,
  CONTENT_MAX_SESSIONS,
  CONTENT_SHORT_QUERY_DAYS,
  SEARCH_MAX_CHARS,
  SUMMARY_MAX,
  type ContentHit,
  type GraphNode,
  type NodeDetail,
  type Origin,
  type SearchIndexStatus,
} from '@agent-canvas/shared';
import { decodeBody } from './codec.js';

/**
 * Full-text search over node contents (spec 2026-11-13 section 3): one index text per node, built by indexTextOf from
 * the node and its detail, kept in a contentless FTS5 trigram table (SEARCH_INDEX_SQL) whose rowid is the node row's
 * rowid. The store maintains it in the transaction that writes the node (store.ts, applyChanges); this module holds the
 * pure parts (index text, query handling, snippets) and the background build for databases without a complete index.
 */

/** Tool output is indexed up to this many UTF-8 bytes (its beginning: errors and paths are usually there). */
export const INDEX_OUTPUT_BYTES = 8 * 1024;
/** One node's whole index text is capped at this many UTF-8 bytes. */
export const INDEX_TEXT_MAX_BYTES = 64 * 1024;

/** Detail of the FTS5 index: decided by measurement (spec 3.2). */
export type SearchIndexDetail = 'full' | 'column' | 'none';

type IndexNode = Pick<GraphNode, 'kind' | 'title' | 'summary' | 'toolName'>;

/** UTF-8 length of a code point below U+10000 (surrogate pairs are counted by the caller: 4 bytes). */
function unitBytes(code: number): number {
  return code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
}

/** The longest prefix of `s` of at most `maxBytes` UTF-8 bytes, cut on a code-point boundary; and its size. */
export function cutUtf8(s: string, maxBytes: number): { text: string; bytes: number; cut: boolean } {
  let bytes = 0;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    let n: number;
    let w: number;
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n = 4;
      w = 2;
    } else {
      n = unitBytes(c); // a lone surrogate is written as U+FFFD: 3 bytes
      w = 1;
    }
    if (bytes + n > maxBytes) return { text: s.slice(0, i), bytes, cut: true };
    bytes += n;
    i += w;
  }
  return { text: s, bytes, cut: false };
}

/** Collects text parts (joined by '\n') up to a byte budget; stops taking anything once it is full. */
class Parts {
  readonly parts: string[] = [];
  bytes = 0;
  full = false;
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  add(s: string): void {
    if (this.full || s === '') return;
    const sep = this.parts.length > 0 ? 1 : 0;
    const room = this.max - this.bytes - sep;
    if (room <= 0) {
      this.full = true;
      return;
    }
    const { text, bytes, cut } = cutUtf8(s, room);
    if (text !== '') {
      this.parts.push(text);
      this.bytes += bytes + sep;
    }
    if (cut) this.full = true;
  }
  text(): string {
    return this.parts.join('\n');
  }
}

/** Long base64 payloads (images) carry no searchable text. */
const BASE64_RUN = /^[A-Za-z0-9+/=\r\n]+$/;

/**
 * The searchable values of a tool input / output: strings (a string holding a JSON object or array is parsed and
 * walked), numbers; keys, booleans and nulls are not text anyone searches for, and `type` values (content block kinds)
 * and long base64 `data` are noise. Depth-first, in key order.
 */
function addValues(value: unknown, into: Parts, depth = 0): void {
  if (into.full || depth > 32) return;
  if (typeof value === 'string') {
    const t = value.trimStart();
    if (depth === 0 && (t.startsWith('{') || t.startsWith('[')) && value.length <= 4 * INDEX_TEXT_MAX_BYTES) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (typeof parsed === 'object' && parsed !== null) {
          addValues(parsed, into, depth + 1);
          return;
        }
      } catch {
        // not JSON: the text itself
      }
    }
    into.add(value);
  } else if (typeof value === 'number' || typeof value === 'bigint') {
    into.add(String(value));
  } else if (Array.isArray(value)) {
    for (const v of value) {
      if (into.full) return;
      addValues(v, into, depth + 1);
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (into.full) return;
      if (k === 'type') continue;
      if (k === 'data' && typeof v === 'string' && v.length > 256 && BASE64_RUN.test(v)) continue;
      addValues(v, into, depth + 1);
    }
  }
}

const nonEmptyString = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * The text a node is found by (spec 3.1), parts joined by '\n', at most INDEX_TEXT_MAX_BYTES:
 * - prompt, text, thinking: the full text (detail.text, as every normalizer stores it), else the summary;
 * - tool, subagent: the tool name, the title when it differs (an MCP tool's short name, a subagent's type), the input's
 *   values (else the summary, for steps stored without an input), the output's values up to INDEX_OUTPUT_BYTES;
 * - system: the full text when the detail has one (an error message, a notice), else the summary;
 * - unknown: nothing. '' means the node gets no index row.
 */
export function indexTextOf(node: IndexNode, detail: Partial<NodeDetail> | null | undefined): string {
  const d = detail ?? {};
  const parts = new Parts(INDEX_TEXT_MAX_BYTES);
  switch (node.kind) {
    case 'prompt':
    case 'text':
    case 'thinking':
      parts.add(nonEmptyString(d.text) ?? node.summary);
      break;
    case 'system':
      parts.add(nonEmptyString(d.text) ?? node.summary);
      break;
    case 'tool':
    case 'subagent': {
      const name = node.toolName ?? node.title;
      parts.add(name);
      if (node.title !== name) parts.add(node.title);
      if (d.input === undefined || d.input === null) parts.add(node.summary);
      else addValues(d.input, parts);
      if (d.output !== undefined && d.output !== null && !parts.full) {
        const out = new Parts(INDEX_OUTPUT_BYTES);
        addValues(d.output, out);
        parts.add(out.text());
      }
      break;
    }
    default:
      break;
  }
  return parts.text();
}

/**
 * How a query is searched: trimmed, cut to SEARCH_MAX_CHARS code points; under 2 code points nothing ('none'), exactly
 * 2 the bounded scan of recent prompts and replies ('short': a trigram index cannot answer it), 3 or more the index.
 */
export function contentQuery(raw: string): { text: string; mode: 'none' | 'short' | 'index' } {
  const text = Array.from(raw.trim()).slice(0, SEARCH_MAX_CHARS).join('').trim();
  const n = Array.from(text).length;
  return { text, mode: n < 2 ? 'none' : n === 2 ? 'short' : 'index' };
}

/** A string as one FTS5 string literal: double quotes doubled, wrapped in double quotes. */
const ftsString = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/**
 * The FTS5 MATCH expression for a literal query of 3+ code points: only quoted strings joined by AND, so nothing the
 * user typed is ever FTS syntax. NUL ends an FTS5 string, so the query is split at NULs and only runs of 3+ code points
 * are used (null when none is: such a query cannot be looked up). detail=full: each run is a phrase (its trigrams in
 * sequence); detail=column / none support no phrases of several tokens: each distinct trigram of each run. Either way
 * the result is a superset of the literal matches (Unicode case folding, trigrams out of order): candidates are
 * verified against the real text.
 */
export function ftsMatchExpression(query: string, detail: SearchIndexDetail): string | null {
  const terms: string[] = [];
  for (const run of query.split('\u0000')) {
    const cps = Array.from(run);
    if (cps.length < 3) continue;
    if (detail === 'full') terms.push(run);
    else for (let i = 0; i + 3 <= cps.length; i++) terms.push(cps.slice(i, i + 3).join(''));
  }
  const unique = [...new Set(terms)];
  return unique.length === 0 ? null : unique.map(ftsString).join(' AND ');
}

/** Lower-cases ASCII letters only (like SQLite LIKE), so string indexes stay aligned with the original. */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Code points shown on each side of a match in a content snippet. */
export const SNIPPET_SIDE_CHARS = 40;
/** A match longer than this many code points is cut in the snippet. */
export const SNIPPET_MATCH_MAX_CHARS = 120;
/** Code units looked at on each side before collapsing whitespace (a longer whitespace run only shortens a side). */
const SNIPPET_WINDOW_UNITS = 2048;

const collapse = (s: string): string => s.replace(/\s+/g, ' ');

export interface Snippet { before: string; match: string; after: string; clippedStart: boolean; clippedEnd: boolean }

/**
 * The text around the match at [at, at + length) (UTF-16 offsets on a code-point boundary): about SNIPPET_SIDE_CHARS
 * code points on each side, whitespace runs collapsed to one space (none at the text's own start or end), cut on
 * code-point boundaries. clippedStart / clippedEnd: text was left out before / after (the page shows an ellipsis).
 */
export function cutSnippet(text: string, at: number, length: number): Snippet {
  const from = Math.max(0, at - SNIPPET_WINDOW_UNITS);
  let head = text.slice(from, at);
  if (from > 0 && (head.charCodeAt(0) & 0xfc00) === 0xdc00) head = head.slice(1); // window cut a pair
  let beforeAll = collapse(head);
  if (from === 0 || !/\S/.test(text.slice(0, from))) beforeAll = beforeAll.trimStart();
  const beforeCps = Array.from(beforeAll);
  const before = beforeCps.slice(-SNIPPET_SIDE_CHARS).join('');
  const clippedStart = beforeCps.length > SNIPPET_SIDE_CHARS || (from > 0 && /\S/.test(text.slice(0, from)));

  const matchCps = Array.from(collapse(text.slice(at, at + length)));
  const matchCut = matchCps.length > SNIPPET_MATCH_MAX_CHARS;
  const match = matchCps.slice(0, SNIPPET_MATCH_MAX_CHARS).join('');

  const end = at + length;
  const to = Math.min(text.length, end + SNIPPET_WINDOW_UNITS);
  let tail = text.slice(end, to);
  if (to < text.length && (tail.charCodeAt(tail.length - 1) & 0xfc00) === 0xd800) tail = tail.slice(0, -1);
  let afterAll = matchCut ? '' : collapse(tail);
  const restHasText = to < text.length && /\S/.test(text.slice(to));
  if (!restHasText) afterAll = afterAll.trimEnd();
  const afterCps = Array.from(afterAll);
  const after = afterCps.slice(0, SNIPPET_SIDE_CHARS).join('');
  const clippedEnd = matchCut || afterCps.length > SNIPPET_SIDE_CHARS || restHasText;
  return { before, match, after, clippedStart, clippedEnd };
}

// ---- the background build

/** Nodes per build batch, and the stored bytes (node bodies + compressed details) after which a batch ends early. */
export const SEARCH_BUILD_BATCH_ROWS = 100;
export const SEARCH_BUILD_BATCH_BYTES = 256 * 1024;
/** The build checks `startupDone` / `importing` / held writes this often, and starts anyway after this long. */
export const SEARCH_BUILD_POLL_MS = 1000;
export const SEARCH_BUILD_MAX_WAIT_MS = 120_000;

/** What the build needs from the pipeline. */
export interface SearchIndexHost {
  startupDone(): boolean;
  importing(): boolean;
  /** Pipeline.writesHeld: the storage job's VACUUM holds the database's write lock on another connection. */
  writesHeld(): boolean;
}

export interface SearchIndexBuildOptions {
  pollMs?: number;
  maxWaitMs?: number;
  batchRows?: number;
  batchBytes?: number;
  log?: (line: string) => void;
}

export interface SearchIndexBuild {
  /** Settles when the build ended (complete, stopped, or failed: see lastError). */
  done: Promise<void>;
  stop(): Promise<void>;
  lastError(): string | null;
}

/**
 * Builds the content index of a database that does not have a complete one (from before the index existed, or found
 * inconsistent at open), in the background: waits for the start-up work (host.startupDone, or maxWaitMs), then indexes
 * the nodes batch by batch (each batch its own transaction, SearchIndex.buildBatch), yielding to the event loop
 * between batches, pausing while the pipeline imports or its writes are held (checked synchronously right before each
 * batch). Search answers from what is indexed meanwhile (Store.searchIndexStatus().indexing). A failing batch stops the
 * build until the next start. Its timers never keep the process alive.
 */
export function startSearchIndexBuild(
  store: { searchIndexStatus(): SearchIndexStatus; searchIndexBatch(maxRows: number, maxBytes: number): { more: boolean } },
  host: SearchIndexHost,
  options: SearchIndexBuildOptions = {},
): SearchIndexBuild {
  const pollMs = Math.max(1, options.pollMs ?? SEARCH_BUILD_POLL_MS);
  const maxWaitMs = options.maxWaitMs ?? SEARCH_BUILD_MAX_WAIT_MS;
  const log = options.log ?? (() => {});
  let stopped = false;
  let lastError: string | null = null;
  let wake: (() => void) | null = null;
  const nap = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      timer.unref?.();
      function done(): void {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = done;
    });
  const ask = (f: () => boolean, fallback: boolean): boolean => {
    try {
      return f();
    } catch {
      return fallback;
    }
  };

  const run = async (): Promise<void> => {
    if (!store.searchIndexStatus().indexing) return;
    const since = Date.now();
    while (!stopped && !ask(() => host.startupDone(), false) && Date.now() - since < maxWaitMs) await nap(pollMs);
    if (stopped || !store.searchIndexStatus().indexing) return; // e.g. a rebuild made it complete meanwhile
    log('agent-canvas: building the search index (one-time, in the background)…');
    for (;;) {
      while (!stopped && (ask(() => host.importing(), false) || ask(() => host.writesHeld(), true))) await nap(pollMs);
      if (stopped) return;
      let more: boolean;
      try {
        more = store.searchIndexBatch(options.batchRows ?? SEARCH_BUILD_BATCH_ROWS, options.batchBytes ?? SEARCH_BUILD_BATCH_BYTES).more;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        log(`agent-canvas: building the search index failed (retried at the next start): ${lastError}`);
        return;
      }
      if (!more) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    log('agent-canvas: search index built');
  };
  const done = run().catch((err: unknown) => {
    lastError = err instanceof Error ? err.message : String(err);
  });
  return {
    done,
    async stop() {
      stopped = true;
      wake?.();
      await done;
    },
    lastError: () => lastError,
  };
}

// ---- the index table and its maintenance

/**
 * Version of the index (indexTextOf and the table layout). `meta.search_index` holds it once the index covers every node;
 * any other value (or none) makes start-up build the index again in the background.
 */
export const SEARCH_INDEX_VERSION = '1';
/** meta keys: the completeness marker, and the background build's position and range end (node rowids). */
export const SEARCH_META = { complete: 'search_index', after: 'search_index:after', end: 'search_index:end' } as const;
/** The detail level chosen by measurement (spec 3.2). */
export const DEFAULT_SEARCH_DETAIL: SearchIndexDetail = 'none';

/**
 * The index: one row per node with a non-empty index text, rowid = the node row's rowid. Contentless (the text is not
 * stored; it is recomputed from the node and its detail to verify a candidate and cut its snippet), rows deletable by
 * rowid (contentless_delete), trigram tokens folded to lower case.
 */
export function searchIndexSql(detail: SearchIndexDetail): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(text, tokenize = 'trigram case_sensitive 0', content = '', contentless_delete = 1, detail = ${detail})`;
}

/** At most this many node details are decoded (to verify a candidate and cut its snippet) per content search. */
export const CONTENT_MAX_DECODES = 250;
/** A content search stops verifying after this long (from its start) and reports `truncated`. */
export const CONTENT_TIME_BUDGET_MS = 250;
/** The 2-character scan looks at no more than this many prompt and reply nodes (newest sessions first). */
export const SHORT_QUERY_NODE_BUDGET = 20_000;
/** Up to this many candidates are placed in their sessions one by one; more: the sessions are walked instead. */
const LOOKUP_MAX_CANDIDATES = 2000;

export interface ContentSearchOptions {
  origin?: Origin | null;
  projectId?: string | null;
  /** "Now" for the 2-character scan's recent-sessions cutoff (default Date.now()). */
  nowMs?: number;
  /** Overrides CONTENT_TIME_BUDGET_MS (tests). */
  timeBudgetMs?: number;
}
export interface ContentSearchResult { hits: ContentHit[]; truncated: boolean; shortQuery: boolean }

interface SessionRow { id: string; projectId: string; origin: Origin; title: string | null }
interface NodeRow { rowid: number; node: GraphNode }

/** A stored node detail as an object, or null when it cannot be decoded or parsed. */
function parseDetail(data: unknown, enc: number): Partial<NodeDetail> | null {
  try {
    const parsed: unknown = JSON.parse(decodeBody(data, enc));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Partial<NodeDetail>) : null;
  } catch {
    return null;
  }
}

/** Newest first; ties by rowid, newest first. */
const byTimeDesc = (a: NodeRow, b: NodeRow): number =>
  a.node.timestamp < b.node.timestamp ? 1 : a.node.timestamp > b.node.timestamp ? -1 : b.rowid - a.rowid;

const now = (): number => performance.now();

/** Fields of a node's body the index text depends on: a patch touching none of them leaves the index row as it is. */
export const INDEXED_NODE_FIELDS: readonly string[] = ['kind', 'title', 'summary', 'toolName'];

/**
 * The index table's statements, on the store's connection. Writes happen in the caller's transaction (the store's
 * applyChanges, deletes and clears); the background build's batches open their own.
 */
export class SearchIndex {
  private readonly insertRow: Database.Statement;
  private readonly deleteRow: Database.Statement;
  private readonly deleteAllRows: Database.Statement;
  private readonly countRows: Database.Statement;
  private readonly countNodes: Database.Statement;
  private readonly maxNodeRowid: Database.Statement;
  private readonly selectMeta: Database.Statement;
  private readonly upsertMeta: Database.Statement;
  private readonly deleteMeta: Database.Statement;
  private readonly sessionRowids: Database.Statement;
  private readonly match: Database.Statement;
  private readonly nodeByRowid: Database.Statement;
  private readonly detailOf: Database.Statement;
  private readonly sessionsStmt: Database.Statement;
  private readonly shortNodes: Database.Statement;
  private readonly batchRows: Database.Statement;

  private readonly db: Database.Database;
  readonly detail: SearchIndexDetail;
  /** False only for the benchmark's baseline (detail 'off'): no row is written. */
  private readonly maintained: boolean;

  // No parameter properties: the store is also loaded by Node's type stripping (test/child), which does not support them.
  constructor(db: Database.Database, detail: SearchIndexDetail | 'off' = DEFAULT_SEARCH_DETAIL) {
    this.db = db;
    this.detail = detail === 'off' ? 'none' : detail;
    this.maintained = detail !== 'off';
    const existed = db.prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'search_fts'`).get() !== undefined;
    db.exec(searchIndexSql(this.detail));
    this.insertRow = db.prepare(`INSERT INTO search_fts (rowid, text) VALUES (?, ?)`);
    this.deleteRow = db.prepare(`DELETE FROM search_fts WHERE rowid = ?`);
    this.deleteAllRows = db.prepare(`INSERT INTO search_fts (search_fts) VALUES ('delete-all')`);
    this.countRows = db.prepare(`SELECT COUNT(*) FROM search_fts_docsize`).pluck();
    this.countNodes = db.prepare(`SELECT COUNT(*) FROM node`).pluck();
    this.maxNodeRowid = db.prepare(`SELECT MAX(rowid) FROM node`).pluck();
    this.selectMeta = db.prepare(`SELECT value FROM meta WHERE key = ?`).pluck();
    this.upsertMeta = db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    this.deleteMeta = db.prepare(`DELETE FROM meta WHERE key = ?`);
    // Served by the node primary key's index (it holds the rowid): no node body is read.
    this.sessionRowids = db.prepare(`SELECT rowid FROM node WHERE session_id = ?`).pluck();
    this.match = db.prepare(`SELECT rowid FROM search_fts WHERE search_fts MATCH ?`).pluck();
    this.nodeByRowid = db.prepare(`SELECT session_id AS sessionId, body FROM node WHERE rowid = ?`);
    this.detailOf = db.prepare(`SELECT data, enc FROM node_detail WHERE session_id = ? AND node_id = ?`);
    this.sessionsStmt = db.prepare(
      `SELECT id, project_id AS projectId, COALESCE(json_extract(body, '$.origin'), 'claude') AS origin,
              json_extract(body, '$.title') AS title
       FROM session
       WHERE (@projectId IS NULL OR project_id = @projectId)
         AND (@origin IS NULL OR COALESCE(json_extract(body, '$.origin'), 'claude') = @origin)
         AND (@cutoff IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', last_activity_at) >= @cutoff)
       ORDER BY last_activity_at DESC, id`,
    );
    this.shortNodes = db.prepare(`SELECT rowid, body FROM node WHERE session_id = ? AND json_extract(body, '$.kind') IN ('prompt', 'text')`);
    this.batchRows = db.prepare(
      `SELECT n.rowid AS rowid, n.body AS body, d.data AS data, d.enc AS enc FROM node n
       LEFT JOIN node_detail d ON d.session_id = n.session_id AND d.node_id = n.id
       WHERE n.rowid > ? AND n.rowid <= ? ORDER BY n.rowid LIMIT ?`,
    );
    db.transaction(() => {
      if (!existed) {
        // A new table: complete when there are no nodes yet (a new database); otherwise it is built in the background.
        if (this.maxNodeRowid.get() === null) this.markComplete();
        else this.markIncomplete();
      } else if (this.complete() && (this.countRows.get() as number) > (this.countNodes.get() as number)) {
        // More index rows than nodes: rows outlived their nodes (written by a build that did not maintain the index).
        this.markIncomplete();
      }
    })();
  }

  private meta(key: string): string | null {
    return (this.selectMeta.get(key) as string | undefined) ?? null;
  }

  private markComplete(): void {
    this.upsertMeta.run(SEARCH_META.complete, SEARCH_INDEX_VERSION);
    this.deleteMeta.run(SEARCH_META.after);
    this.deleteMeta.run(SEARCH_META.end);
  }

  private markIncomplete(): void {
    this.deleteMeta.run(SEARCH_META.complete);
    this.deleteMeta.run(SEARCH_META.after);
    this.deleteMeta.run(SEARCH_META.end);
  }

  /** True when every node is indexed (and the index is maintained with every write since). */
  complete(): boolean {
    return this.meta(SEARCH_META.complete) === SEARCH_INDEX_VERSION;
  }

  /** Progress of the build in node row positions (zeros when complete). */
  status(): SearchIndexStatus {
    if (this.complete()) return { indexing: false, indexed: 0, total: 0 };
    const end = Number(this.meta(SEARCH_META.end) ?? NaN);
    const total = Number.isFinite(end) ? end : ((this.maxNodeRowid.get() as number | null) ?? 0);
    return { indexing: true, indexed: Math.min(total, Number(this.meta(SEARCH_META.after) ?? 0) || 0), total };
  }

  /** Replaces a node's row: removes the one under `stale` (the node's previous rowid, if it had one), adds `text`. */
  write(stale: number | null, rowid: number, text: string): void {
    if (!this.maintained) return;
    if (stale !== null) this.deleteRow.run(stale);
    if (text !== '') this.insertRow.run(rowid, text);
  }

  /** Removes the rows of one session's nodes (before the nodes themselves are deleted). */
  deleteForSession(sessionId: string): void {
    if (!this.maintained) return;
    for (const rowid of this.sessionRowids.all(sessionId) as number[]) this.deleteRow.run(rowid);
  }

  /** Empties the index along with every node (clearDerived): an empty index of no nodes is complete. */
  clear(): void {
    this.deleteAllRows.run();
    this.markComplete();
  }

  /**
   * One batch of the background build, in one transaction: starts the build on first use (empties the index and records
   * the node rowid range to cover; nodes written afterwards are indexed by their own writes), then (re)indexes the next
   * nodes of the range, at most `maxRows` and stopping once their stored bodies and details reach `maxBytes`. Marks the
   * index complete after the last batch. Returns whether nodes are left; does nothing when the index is complete.
   */
  buildBatch(maxRows: number, maxBytes: number): { more: boolean; indexed: number } {
    return this.db.transaction(() => {
      if (this.complete()) return { more: false, indexed: 0 };
      if (this.meta(SEARCH_META.end) === null) {
        this.deleteAllRows.run();
        this.upsertMeta.run(SEARCH_META.end, String((this.maxNodeRowid.get() as number | null) ?? 0));
        this.upsertMeta.run(SEARCH_META.after, '0');
      }
      const end = Number(this.meta(SEARCH_META.end)) || 0;
      const after = Number(this.meta(SEARCH_META.after)) || 0;
      const rows: { rowid: number; body: string; data: unknown; enc: number | null }[] = [];
      let bytes = 0;
      for (const row of this.batchRows.iterate(after, end, Math.max(1, maxRows)) as IterableIterator<(typeof rows)[number]>) {
        rows.push(row);
        bytes += row.body.length + (typeof row.data === 'string' || row.data instanceof Uint8Array ? row.data.length : 0);
        if (bytes >= maxBytes) break; // ends the iteration (and the statement) before the writes below
      }
      for (const row of rows) {
        const node = JSON.parse(row.body) as GraphNode;
        // A detail that cannot be decoded: the node is found by what its own row holds (the summary).
        const detail = row.data === null ? {} : parseDetail(row.data, row.enc ?? 0);
        this.write(row.rowid, row.rowid, indexTextOf(node, detail));
      }
      const last = rows.length === 0 ? end : rows[rows.length - 1]!.rowid;
      if (last >= end) {
        this.markComplete();
        return { more: false, indexed: rows.length };
      }
      this.upsertMeta.run(SEARCH_META.after, String(last));
      return { more: true, indexed: rows.length };
    })();
  }

  // ---- search

  private sessions(options: ContentSearchOptions, cutoff: string | null): SessionRow[] {
    return this.sessionsStmt.all({ projectId: options.projectId ?? null, origin: options.origin ?? null, cutoff }) as SessionRow[];
  }

  private nodeRow(rowid: number): (NodeRow & { sessionId: string }) | null {
    const row = this.nodeByRowid.get(rowid) as { sessionId: string; body: string } | undefined;
    return row === undefined ? null : { rowid, sessionId: row.sessionId, node: JSON.parse(row.body) as GraphNode };
  }

  /** The node's index text from its stored detail; null when the detail cannot be decoded. */
  private textOf(node: GraphNode): string | null {
    const row = this.detailOf.get(node.sessionId, node.id) as { data: unknown; enc: number } | undefined;
    const detail = row === undefined ? {} : parseDetail(row.data, row.enc);
    return detail === null ? null : indexTextOf(node, detail);
  }

  /**
   * Content search (spec 3.3); see ContentSearchResponse. Literal, ASCII-case-insensitive. 3+ code points: index
   * candidates, verified against the real text in rank order (sessions by last activity, nodes by time, newest first)
   * until the limits are full, CONTENT_MAX_DECODES details were decoded or CONTENT_TIME_BUDGET_MS passed. Exactly 2: a
   * scan of the prompt and reply nodes of sessions active in the last CONTENT_SHORT_QUERY_DAYS days, newest first, at
   * most SHORT_QUERY_NODE_BUDGET nodes (and the same time budget).
   */
  search(rawQuery: string, options: ContentSearchOptions = {}): ContentSearchResult {
    const deadline = now() + (options.timeBudgetMs ?? CONTENT_TIME_BUDGET_MS);
    const { text, mode } = contentQuery(rawQuery);
    const result: ContentSearchResult = { hits: [], truncated: false, shortQuery: mode === 'short' };
    if (mode === 'none') return result;
    const needle = asciiLower(text);
    let sessionsWithHits = 0;
    let decodes = 0;
    let stopped = false;
    const stop = (): void => {
      stopped = true;
      result.truncated = true;
    };
    const hitOf = (session: SessionRow, node: GraphNode, indexText: string, at: number): ContentHit => ({
      sessionId: session.id,
      projectId: session.projectId,
      origin: session.origin,
      sessionTitle: session.title,
      nodeId: node.id,
      kind: node.kind,
      toolName: node.toolName,
      at: node.timestamp,
      agentId: node.agentId,
      snippet: cutSnippet(indexText, at, text.length),
    });

    if (mode === 'index') {
      const expr = ftsMatchExpression(text, this.detail);
      if (expr === null) return result;
      const candidates = this.match.all(expr) as number[];
      if (candidates.length === 0) return result;
      const sessions = this.sessions(options, null);

      /** Verifies one session's candidates, newest first, and adds its hits. */
      const visit = (session: SessionRow, nodes: NodeRow[]): void => {
        if (sessionsWithHits >= CONTENT_MAX_SESSIONS) return stop(); // one more session has candidates
        nodes.sort(byTimeDesc);
        let found = 0;
        for (const { node } of nodes) {
          if (found >= CONTENT_MAX_HITS_PER_SESSION) {
            result.truncated = true; // more candidates in this session
            return;
          }
          if (decodes >= CONTENT_MAX_DECODES || now() > deadline) return stop();
          decodes += 1;
          const indexText = this.textOf(node);
          if (indexText === null) continue;
          const at = asciiLower(indexText).indexOf(needle);
          if (at < 0) continue;
          if (found === 0) sessionsWithHits += 1;
          found += 1;
          result.hits.push(hitOf(session, node, indexText, at));
        }
      };

      if (candidates.length <= LOOKUP_MAX_CANDIDATES) {
        // Few candidates: each is placed in its session.
        const bySession = new Map<string, NodeRow[]>();
        for (const rowid of candidates) {
          const row = this.nodeRow(rowid);
          if (row === null) continue;
          const list = bySession.get(row.sessionId);
          if (list === undefined) bySession.set(row.sessionId, [row]);
          else list.push(row);
        }
        for (const session of sessions) {
          if (stopped) break;
          const nodes = bySession.get(session.id);
          if (nodes !== undefined) visit(session, nodes);
        }
      } else {
        // Many: the sessions are walked newest first and their candidates picked by rowid (primary-key index only).
        const set = new Set(candidates);
        for (const session of sessions) {
          if (stopped) break;
          const mine = (this.sessionRowids.all(session.id) as number[]).filter((r) => set.has(r));
          if (mine.length === 0) continue;
          const nodes: NodeRow[] = [];
          for (const rowid of mine) {
            const row = this.nodeRow(rowid);
            if (row !== null) nodes.push(row);
          }
          visit(session, nodes);
        }
      }
      return result;
    }

    // Exactly two code points: a bounded scan of recent prompts and replies.
    const cutoff = new Date((options.nowMs ?? Date.now()) - CONTENT_SHORT_QUERY_DAYS * 24 * 60 * 60 * 1000).toISOString();
    let scanned = 0;
    for (const session of this.sessions(options, cutoff)) {
      if (stopped) break;
      const nodes = (this.shortNodes.all(session.id) as { rowid: number; body: string }[]).map((r) => ({
        rowid: r.rowid,
        node: JSON.parse(r.body) as GraphNode,
      }));
      nodes.sort(byTimeDesc);
      let found = 0;
      for (const { node } of nodes) {
        if (scanned >= SHORT_QUERY_NODE_BUDGET || now() > deadline) {
          stop();
          break;
        }
        scanned += 1;
        // The summary is the text's beginning with whitespace runs collapsed; a 2-code-point query has no whitespace
        // inside (it is trimmed), so a match there is a match in the text: only a cut summary needs the full text.
        const summary = node.summary ?? '';
        const cut = summary.endsWith('…') && summary.length >= SUMMARY_MAX; // summarize() counts UTF-16 units
        if (!cut && !asciiLower(summary).includes(needle)) continue;
        const indexText = this.textOf(node);
        if (indexText === null) continue;
        const at = asciiLower(indexText).indexOf(needle);
        if (at < 0) continue;
        if (found === 0 && sessionsWithHits >= CONTENT_MAX_SESSIONS) {
          stop(); // a 51st session has a match
          break;
        }
        if (found >= CONTENT_MAX_HITS_PER_SESSION) {
          result.truncated = true; // a 6th match in this session
          break;
        }
        if (found === 0) sessionsWithHits += 1;
        found += 1;
        result.hits.push(hitOf(session, node, indexText, at));
      }
    }
    return result;
  }
}
