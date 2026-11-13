import { performance } from 'node:perf_hooks';
import {
  createMasker,
  EXPORT_MAX_BYTES,
  EXPORT_OUTPUT_HEAD_BYTES,
  exportMaskCategories,
  groupTurns,
  ORIGINS,
  SUMMARY_MAX,
  type EdgeKind,
  type ExportBundle,
  type ExportOptions,
  type ExportPreview,
  type FileAction,
  type GraphEdge,
  type GraphNode,
  type Masker,
  type MaskTextOptions,
  type NodeDetail,
  type NodeKind,
  type NodeStatus,
  type Session,
  type SessionStatus,
  type Usage,
} from '@agent-canvas/shared';
import { summarize } from '../normalize/summary.js';
import type { Store } from '../store/store.js';
import { buildStructure, readingOrder } from './structure.js';
import { truncateUtf8 } from './truncate.js';

/** What the export reads: the session, its nodes page by page, its edges and node details one by one. */
export type ExportSource = Pick<Store, 'getSession' | 'nodePage' | 'sessionEdges' | 'getNodeDetail'>;

/** Thrown when `stopped()` turns true (the client went away): the work stops at the next check. */
export class ExportAbortedError extends Error {
  constructor() {
    super('export aborted');
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// field whitelists (spec 4.3). Each stored field has a decision; a field added to a type without one fails to compile.

/**
 * - id: an identifier made by the agent or the normalizer (uuid, `toolu_…`, `prompt:<item>`, `agent-<hash>`, a turn
 *   id); exported as is unless the masker would change it, then replaced by an opaque alias (`masked-id-<n>`), the same
 *   alias everywhere in the bundle.
 * - masked: text through the masker (titles and summaries in truncated mode when they were cut, see cutOptions).
 * - enum / boolean / number / time / usage / files: re-built from a closed set or validated shape (no free text).
 * - drop: never exported.
 */
export type FieldPolicy = 'id' | 'masked' | 'enum' | 'boolean' | 'number' | 'time' | 'usage' | 'files' | 'drop';

export const NODE_FIELD_POLICY: { [K in keyof Required<GraphNode>]-?: FieldPolicy } = {
  id: 'id',
  sessionId: 'id',
  turnId: 'id',
  agentId: 'id',
  childAgentId: 'id',
  parentId: 'id',
  kind: 'enum',
  status: 'enum',
  timestamp: 'time',
  confirmed: 'boolean',
  title: 'masked',
  summary: 'masked',
  toolName: 'masked',
  toolUseId: 'id',
  messageId: 'id',
  durationMs: 'number',
  endedAt: 'time',
  usage: 'usage',
  systemSubtype: 'masked',
  files: 'files',
  filesTruncated: 'boolean',
  // An unsalted hash of the unmasked input: with the masked input it lets a reader test guesses of what was masked.
  inputKey: 'drop',
};

export const SESSION_FIELD_POLICY: { [K in keyof Required<Session>]-?: FieldPolicy } = {
  id: 'id',
  // The working directory encoded: re-derived from the masked working directory (see exportSession).
  projectId: 'masked',
  origin: 'enum',
  cwd: 'masked',
  title: 'masked',
  gitBranch: 'masked',
  status: 'enum',
  sourceDeleted: 'boolean',
  startedAt: 'time',
  lastActivityAt: 'time',
};

export const EDGE_FIELD_POLICY: { [K in keyof Required<GraphEdge>]-?: FieldPolicy } = {
  // Re-built from the (aliased) ends and the kind.
  id: 'id',
  sessionId: 'id',
  from: 'id',
  to: 'id',
  kind: 'enum',
};

export const DETAIL_FIELD_POLICY: { [K in keyof Required<NodeDetail>]-?: FieldPolicy } = {
  nodeId: 'id',
  input: 'masked',
  output: 'masked',
  text: 'masked',
  // The original record: anything can be in it.
  raw: 'drop',
  unreadable: 'boolean',
};

const NODE_KINDS: readonly NodeKind[] = ['prompt', 'thinking', 'text', 'tool', 'subagent', 'system', 'unknown'];
const NODE_STATUSES: readonly NodeStatus[] = ['running', 'awaiting_permission', 'succeeded', 'failed', 'denied'];
const SESSION_STATUSES: readonly SessionStatus[] = ['running', 'awaiting_input', 'awaiting_permission', 'idle', 'ended'];
const EDGE_KINDS: readonly EdgeKind[] = ['sequence', 'fork', 'spawn'];
const FILE_ACTION_SET: readonly FileAction[] = ['read', 'edit', 'write', 'delete'];

const oneOf = <T extends string>(list: readonly T[], v: unknown, fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);
/** A timestamp made only of date characters (no free text); else empty. */
const timeOf = (v: unknown): string => (typeof v === 'string' && /^[0-9T:.+\-Z ]{1,40}$/.test(v) ? v : '');
const numberOf = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
function usageOf(v: unknown): Usage | null {
  if (typeof v !== 'object' || v === null) return null;
  const u = v as Record<string, unknown>;
  const input = numberOf(u.inputTokens);
  const output = numberOf(u.outputTokens);
  if (input === null || output === null) return null;
  const cached = numberOf(u.cachedInputTokens);
  return cached === null ? { inputTokens: input, outputTokens: output } : { inputTokens: input, outputTokens: output, cachedInputTokens: cached };
}

/**
 * Ids as exported: unchanged unless the masker finds something in them (checked with wouldMask: nothing counted or
 * numbered), then an opaque alias `masked-id-<n>` (the same each time). `taken`: every real id in scope, so an alias
 * never equals a real id (n is skipped past such ids).
 */
class IdAliases {
  private readonly map = new Map<string, string>();
  private next = 1;
  constructor(
    private readonly masker: Masker,
    private readonly taken: Set<string>,
  ) {}
  of(id: string): string {
    let out = this.map.get(id);
    if (out === undefined) {
      if (typeof id === 'string' && !this.masker.wouldMask(id)) out = id;
      else {
        while (this.taken.has(`masked-id-${this.next}`)) this.next++;
        out = `masked-id-${this.next++}`;
      }
      this.map.set(id, out);
    }
    return out;
  }
  ofNullable(id: string | null): string | null {
    return id === null || id === undefined ? null : this.of(id);
  }
}

/**
 * Truncated-mode masking only for text that was actually cut: a summary at its length cap (SUMMARY_MAX) or any text
 * ending with an ellipsis (`…`, `...`).
 */
export function cutOptions(text: unknown): MaskTextOptions | undefined {
  if (typeof text !== 'string') return undefined;
  return text.length >= SUMMARY_MAX || text.endsWith('…') || text.endsWith('...') ? { truncated: true } : undefined;
}

/** A project id as derived from a working directory (every non-alphanumeric character becomes `-`). */
const encodeProjectId = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

function exportSession(session: Session, masker: Masker, ids: IdAliases): Session {
  const cwd = session.cwd === null ? null : masker.mask(session.cwd);
  return {
    id: ids.of(session.id),
    // Always the masked working directory encoded (whatever the stored id was derived from); `unknown` without one.
    projectId: cwd !== null ? encodeProjectId(cwd) : 'unknown',
    origin: oneOf(ORIGINS, session.origin, 'claude'),
    cwd,
    title: session.title === null ? null : masker.mask(session.title, cutOptions(session.title)),
    gitBranch: session.gitBranch === null ? null : masker.mask(session.gitBranch),
    status: oneOf(SESSION_STATUSES, session.status, 'ended'),
    sourceDeleted: session.sourceDeleted === true,
    startedAt: timeOf(session.startedAt),
    lastActivityAt: timeOf(session.lastActivityAt),
  };
}

function exportNode(node: GraphNode, summary: string, masker: Masker, ids: IdAliases): GraphNode {
  const out: GraphNode = {
    id: ids.of(node.id),
    sessionId: ids.of(node.sessionId),
    turnId: ids.ofNullable(node.turnId),
    agentId: ids.ofNullable(node.agentId),
    childAgentId: ids.ofNullable(node.childAgentId),
    parentId: ids.ofNullable(node.parentId),
    kind: oneOf(NODE_KINDS, node.kind, 'unknown'),
    status: NODE_STATUSES.includes(node.status as NodeStatus) ? node.status : null,
    timestamp: timeOf(node.timestamp),
    confirmed: node.confirmed === true,
    title: masker.mask(typeof node.title === 'string' ? node.title : '', cutOptions(node.title)),
    summary,
    toolName: typeof node.toolName === 'string' ? masker.mask(node.toolName) : null,
    toolUseId: ids.ofNullable(node.toolUseId),
    messageId: ids.ofNullable(node.messageId),
    durationMs: numberOf(node.durationMs),
    endedAt: timeOf(node.endedAt) || null,
    usage: usageOf(node.usage),
    systemSubtype: typeof node.systemSubtype === 'string' ? masker.mask(node.systemSubtype) : null,
  };
  if (Array.isArray(node.files)) {
    out.files = node.files.map((f) => ({ path: masker.mask(String(f?.path ?? '')), action: oneOf(FILE_ACTION_SET, f?.action, 'read') }));
  }
  if (node.filesTruncated === true) out.filesTruncated = true;
  return out;
}

function exportEdge(edge: GraphEdge, ids: IdAliases, used: Set<string>): GraphEdge {
  const from = ids.of(edge.from);
  const to = ids.of(edge.to);
  const kind = oneOf(EDGE_KINDS, edge.kind, 'sequence');
  let id = `${from}->${to}${kind === 'fork' ? ':fork' : ''}`;
  for (let i = 2; used.has(id); i++) id = `${from}->${to}#${i}`;
  used.add(id);
  return { id, sessionId: ids.of(edge.sessionId), from, to, kind };
}

// ---------------------------------------------------------------------------------------------------------------------

export interface AssembleContext {
  /** Custom terms (used when options.mask.custom). */
  customTerms: string[];
  /** User names for `personal` (see homeUsersOf). */
  homeUsers: string[];
  /** Agent Canvas's version, for ExportBundle.tool. */
  version: string;
  now: Date;
  /** preview: count and estimate only (nothing kept); bundle: keep the masked data and return it. */
  mode: 'preview' | 'bundle';
  /** Bytes the file will have besides the bundle (the HTML template); counted against EXPORT_MAX_BYTES. */
  extraBytes: number;
  /** Checked between pages and batches; once true the work stops with ExportAbortedError. */
  stopped?: () => boolean;
  /** Give the event loop a turn once this long has passed since the last one (default 15 ms). */
  yieldAfterMs?: number;
  /** Nodes per page read (default 2000). */
  pageSize?: number;
  /** The size limit (default EXPORT_MAX_BYTES; tests lower it). */
  maxBytes?: number;
}

export type AssembleResult =
  | { kind: 'not-found' }
  | { kind: 'unknown-turn' }
  /** bundle: null in preview mode and when the export is too large (preview.tooLarge). */
  | { kind: 'done'; preview: ExportPreview; bundle: ExportBundle | null };

/**
 * The user name in a home-directory working directory: `C:\Users\<name>\…` (either slash, any case), `/Users/<name>/…`,
 * `/home/<name>/…`.
 */
export function homeUsersOf(cwd: string | null): string[] {
  if (cwd === null) return [];
  const m = /^[A-Za-z]:[\\/]+users[\\/]+([^\\/]+)/i.exec(cwd) ?? /^\/Users\/([^/]+)/.exec(cwd) ?? /^\/home\/([^/]+)/.exec(cwd);
  return m ? [m[1]!] : [];
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
/** The bundle's fixed part (keys, tool, options, report, separators), a generous estimate. */
const BUNDLE_OVERHEAD_BYTES = 4096;
/**
 * The first pass stops once the unmasked text in scope passes this multiple of the limit: masking cannot shrink it
 * enough to fit (placeholders replace values of about their own size).
 */
const LEARN_PASS_FACTOR = 2;

function readDetail(source: ExportSource, sessionId: string, nodeId: string): NodeDetail | null | 'unreadable' {
  let d: NodeDetail | null;
  try {
    d = source.getNodeDetail(sessionId, nodeId);
  } catch {
    return 'unreadable';
  }
  if (d === null) return null;
  return d.unreadable ? 'unreadable' : d;
}

/**
 * Assembles one session's export (spec 4.3) or its preview, in a streaming way:
 * - the session's nodes are read page by page, then the scope and content options pick the nodes;
 * - first pass (when credential or assignment masking is on): every text in scope is scanned in reading order and the
 *   secret values found are learned (Masker.learn), so that a value masked in one place is masked wherever it occurs;
 *   it stops (tooLarge) once the unmasked text passes LEARN_PASS_FACTOR × the limit;
 * - second pass: everything is masked in reading order (structure.ts) and exported through the field whitelists: the
 *   session's fields, then each node's detail (read one at a time, masked at once, the output cut after masking) and the
 *   node; a summary derived from the input or text is re-derived from the masked one, any other summary and every title
 *   is masked as text (in truncated mode when it was cut); edges between kept nodes last;
 * - a running estimate (UTF-8 bytes of the JSON added, plus extraBytes) stops the second pass as soon as it passes the
 *   limit (preview.tooLarge, no bundle);
 * - the event loop gets a turn every yieldAfterMs; `stopped()` is checked at the same points.
 */
export async function assembleExport(
  source: ExportSource,
  sessionId: string,
  options: ExportOptions,
  ctx: AssembleContext,
): Promise<AssembleResult> {
  const yieldAfterMs = ctx.yieldAfterMs ?? 15;
  const pageSize = ctx.pageSize ?? 2000;
  const maxBytes = ctx.maxBytes ?? EXPORT_MAX_BYTES;
  const keep = ctx.mode === 'bundle';
  let lastYield = performance.now();
  const pause = async (): Promise<void> => {
    if (performance.now() - lastYield >= yieldAfterMs) {
      await turn();
      lastYield = performance.now();
    }
    if (ctx.stopped?.()) throw new ExportAbortedError();
  };

  const session = source.getSession(sessionId);
  if (session === null) return { kind: 'not-found' };

  // ---- read every node (paged), in snapshot (rowid) order
  const rows: { rowid: number; node: GraphNode }[] = [];
  for (let after: string | null = null; ; ) {
    const page = source.nodePage(sessionId, after, pageSize);
    for (const r of page) rows.push(r);
    if (page.length < pageSize) break;
    after = page[page.length - 1]!.node.id;
    await pause();
  }
  rows.sort((a, b) => a.rowid - b.rowid);
  const all = rows.map((r) => r.node);
  rows.length = 0;
  await pause();

  // ---- scope
  let scoped: GraphNode[] = all;
  let turnNumber: number | undefined;
  if (options.scope.kind === 'turn') {
    const turnKey = options.scope.turnKey;
    const turns = groupTurns(all);
    const index = turns.findIndex((t) => t.key === turnKey);
    if (index < 0) return { kind: 'unknown-turn' };
    turnNumber = index + 1;
    const byAgent = new Map<string, GraphNode[]>();
    for (const n of all) {
      if (n.agentId === null) continue;
      let list = byAgent.get(n.agentId);
      if (!list) byAgent.set(n.agentId, (list = []));
      list.push(n);
    }
    const included = new Set<GraphNode>(turns[index]!.nodes);
    const queue = [...turns[index]!.nodes];
    const agents = new Set<string>();
    while (queue.length > 0) {
      const n = queue.pop()!;
      if (n.kind !== 'subagent' || n.childAgentId === null || agents.has(n.childAgentId)) continue;
      agents.add(n.childAgentId);
      for (const inner of byAgent.get(n.childAgentId) ?? []) {
        if (included.has(inner)) continue;
        included.add(inner);
        queue.push(inner);
      }
    }
    scoped = all.filter((n) => included.has(n));
  }
  // ---- content options (dropped nodes leave gaps; nothing is rewired)
  const inScope = scoped.filter((n) => (options.thinking || n.kind !== 'thinking') && (options.subagents || n.agentId === null));
  const order = [...readingOrder(buildStructure(inScope))];
  await pause();

  const masker = createMasker({
    categories: exportMaskCategories(options.mask),
    customTerms: options.mask.custom ? ctx.customTerms : [],
    homeUsers: ctx.homeUsers,
    numbered: true,
  });
  const result = (bytes: number, large: boolean, bundle: ExportBundle | null): AssembleResult => ({
    kind: 'done',
    preview: { report: masker.report(), estimatedBytes: bytes, nodeCount: inScope.length, tooLarge: large },
    bundle,
  });

  // ---- pass 1: learn the secret values of the whole scope
  if (options.mask.credential || options.mask.assignment) {
    let raw = ctx.extraBytes + BUNDLE_OVERHEAD_BYTES;
    for (const s of [session.title, session.cwd, session.gitBranch]) if (typeof s === 'string') masker.learn(s, cutOptions(s));
    for (const node of order) {
      masker.learn(node.title, cutOptions(node.title));
      masker.learn(node.summary, cutOptions(node.summary));
      if (node.toolName !== null) masker.learn(node.toolName);
      for (const f of node.files ?? []) masker.learn(f.path);
      raw += jsonBytes(node);
      const d = readDetail(source, sessionId, node.id);
      if (d !== null && d !== 'unreadable') {
        masker.learnValue(d.input);
        if (typeof d.text === 'string') masker.learn(d.text);
        if (options.output !== 'none') masker.learnValue(d.output);
        raw += jsonBytes(d.input ?? null) + (typeof d.text === 'string' ? d.text.length : 0);
        if (options.output !== 'none' && d.output !== null && d.output !== undefined) {
          const out = jsonBytes(d.output);
          raw += options.output === 'head' ? Math.min(out, EXPORT_OUTPUT_HEAD_BYTES) : out;
        }
      }
      if (raw > maxBytes * LEARN_PASS_FACTOR) return result(raw, true, null);
      await pause();
    }
  }

  // ---- pass 2: mask and export through the whitelists, in reading order
  const taken = new Set<string>([session.id]);
  for (const n of inScope) {
    for (const v of [n.id, n.sessionId, n.turnId, n.agentId, n.childAgentId, n.parentId, n.toolUseId, n.messageId]) if (typeof v === 'string') taken.add(v);
  }
  const ids = new IdAliases(masker, taken);
  const maskedSession = exportSession(session, masker, ids);
  const exportedOptions: ExportOptions =
    options.scope.kind === 'turn' ? { ...options, scope: { kind: 'turn', turnKey: ids.of(options.scope.turnKey) } } : options;
  let bytes = ctx.extraBytes + BUNDLE_OVERHEAD_BYTES + jsonBytes(maskedSession) + jsonBytes(exportedOptions);
  const maskedNodes = new Map<string, GraphNode>();
  const details: Record<string, NodeDetail> = {};
  const truncations: Record<string, { originalBytes: number }> = {};
  const unreadable: string[] = [];
  for (const node of order) {
    const d = readDetail(source, sessionId, node.id);
    const id = ids.of(node.id);
    let detail: NodeDetail | null = null;
    let summary: string | null = null;
    if (d === 'unreadable') {
      detail = { nodeId: id, input: null, output: null, text: null, raw: null, unreadable: true };
      unreadable.push(id);
    } else if (d !== null) {
      const input = d.input === null || d.input === undefined ? null : masker.maskValue(d.input);
      const text = typeof d.text === 'string' ? masker.mask(d.text) : null;
      let output: unknown = null;
      if (options.output !== 'none' && d.output !== null && d.output !== undefined) {
        output = masker.maskValue(d.output);
        if (options.output === 'head') {
          const asText = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
          const cut = truncateUtf8(asText, EXPORT_OUTPUT_HEAD_BYTES);
          if (cut !== null) {
            output = cut.text;
            truncations[id] = { originalBytes: cut.originalBytes };
          }
        }
      }
      if (input !== null || output !== null || text !== null) detail = { nodeId: id, input, output, text, raw: null };
      // A summary the normalizer derived from the input or text: derived again from the masked one.
      if (input !== null && summarize(d.input) === node.summary) summary = summarize(input);
      else if (text !== null && summarize(d.text) === node.summary) summary = summarize(text);
    }
    const exported = exportNode(node, summary ?? masker.mask(typeof node.summary === 'string' ? node.summary : '', cutOptions(node.summary)), masker, ids);
    bytes += jsonBytes(exported) + 1;
    if (keep) maskedNodes.set(node.id, exported);
    if (detail !== null) {
      bytes += jsonBytes(id) + 2 + jsonBytes(detail);
      if (keep) details[id] = detail;
    }
    if (bytes > maxBytes) return result(bytes, true, null);
    await pause();
  }

  // ---- edges between kept nodes
  const kept = new Set(inScope.map((n) => n.id));
  const usedEdgeIds = new Set<string>();
  const edges: GraphEdge[] = source
    .sessionEdges(sessionId)
    .filter((e) => kept.has(e.from) && kept.has(e.to))
    .map((e) => exportEdge(e, ids, usedEdgeIds));
  bytes += jsonBytes(edges) + jsonBytes(truncations) + jsonBytes(unreadable);
  if (bytes > maxBytes) return result(bytes, true, null);
  if (!keep) return result(bytes, false, null);

  const bundle: ExportBundle = {
    version: 1,
    tool: { name: 'Agent Canvas', version: ctx.version },
    exportedAt: ctx.now.toISOString(),
    options: exportedOptions,
    report: masker.report(),
    session: maskedSession,
    nodes: inScope.map((n) => maskedNodes.get(n.id)!),
    edges,
    details,
    truncations,
    unreadable,
    ...(turnNumber !== undefined ? { turnNumber } : {}),
  };
  return result(bytes, false, bundle);
}
