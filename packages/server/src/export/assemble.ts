import { performance } from 'node:perf_hooks';
import {
  createMasker,
  EXPORT_MAX_BYTES,
  EXPORT_OUTPUT_HEAD_BYTES,
  exportMaskCategories,
  groupTurns,
  type ExportBundle,
  type ExportOptions,
  type ExportPreview,
  type GraphEdge,
  type GraphNode,
  type NodeDetail,
  type Session,
} from '@agent-canvas/shared';
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

/** A project id as derived from a working directory (every non-alphanumeric character becomes `-`). */
const encodeProjectId = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
/** The bundle's fixed part (keys, tool, options, report, separators), a generous estimate. */
const BUNDLE_OVERHEAD_BYTES = 4096;

/**
 * Assembles one session's export (spec 4.3) or its preview, in a streaming way:
 * - the session's nodes are read page by page, then the scope and content options pick the nodes;
 * - everything is masked in reading order (structure.ts): the session's fields, then each node with its detail (read
 *   one at a time, masked at once, the output cut after masking); edges between kept nodes last;
 * - a running estimate (UTF-8 bytes of the JSON added, plus extraBytes) stops the work as soon as it passes the limit
 *   (preview.tooLarge, no bundle);
 * - the event loop gets a turn every yieldAfterMs; `stopped()` is checked at the same points.
 * In preview mode nothing masked is kept; in bundle mode the masked nodes and details are (at most the size limit).
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

  // ---- mask in reading order
  const masker = createMasker({
    categories: exportMaskCategories(options.mask),
    customTerms: options.mask.custom ? ctx.customTerms : [],
    homeUsers: ctx.homeUsers,
    numbered: true,
  });
  const maskOrNull = (s: string | null): string | null => (s === null ? null : masker.mask(s));
  const title = maskOrNull(session.title);
  const cwd = maskOrNull(session.cwd);
  const maskedSession: Session = {
    ...session,
    title,
    cwd,
    gitBranch: maskOrNull(session.gitBranch),
    // The project id is the working directory encoded (non-alphanumerics → `-`), which the rules may not recognize in
    // that form: encode the masked working directory instead; any other id is masked as text.
    projectId:
      session.cwd !== null && cwd !== null && session.projectId === encodeProjectId(session.cwd)
        ? encodeProjectId(cwd)
        : masker.mask(session.projectId),
  };
  let bytes = ctx.extraBytes + BUNDLE_OVERHEAD_BYTES + jsonBytes(maskedSession) + jsonBytes(options);
  const tooLarge = (): boolean => bytes > maxBytes;
  const result = (large: boolean, bundle: ExportBundle | null): AssembleResult => ({
    kind: 'done',
    preview: { report: masker.report(), estimatedBytes: bytes, nodeCount: inScope.length, tooLarge: large },
    bundle,
  });

  const maskedNodes = new Map<string, GraphNode>();
  const details: Record<string, NodeDetail> = {};
  const truncations: Record<string, { originalBytes: number }> = {};
  const unreadable: string[] = [];
  for (const node of order) {
    const masked: GraphNode = { ...node, title: masker.mask(node.title), summary: masker.mask(node.summary) };
    if (node.toolName !== null) masked.toolName = masker.mask(node.toolName);
    if (node.files !== undefined) masked.files = node.files.map((f) => ({ ...f, path: masker.mask(f.path) }));
    bytes += jsonBytes(masked) + 1;
    if (keep) maskedNodes.set(node.id, masked);

    const detail = exportDetail(source, sessionId, node.id, options, masker, truncations);
    if (detail !== null) {
      if (detail.unreadable) unreadable.push(node.id);
      bytes += jsonBytes(node.id) + 2 + jsonBytes(detail);
      if (keep) details[node.id] = detail;
    }
    if (tooLarge()) return result(true, null);
    await pause();
  }

  // ---- edges between kept nodes
  const ids = new Set(inScope.map((n) => n.id));
  const edges: GraphEdge[] = source.sessionEdges(sessionId).filter((e) => ids.has(e.from) && ids.has(e.to));
  bytes += jsonBytes(edges) + jsonBytes(truncations) + jsonBytes(unreadable);
  if (tooLarge()) return result(true, null);
  if (!keep) return result(false, null);

  const bundle: ExportBundle = {
    version: 1,
    tool: { name: 'Agent Canvas', version: ctx.version },
    exportedAt: ctx.now.toISOString(),
    options,
    report: masker.report(),
    session: maskedSession,
    nodes: inScope.map((n) => maskedNodes.get(n.id)!),
    edges,
    details,
    truncations,
    unreadable,
    ...(turnNumber !== undefined ? { turnNumber } : {}),
  };
  return result(false, bundle);
}

/**
 * One node's exported detail: input and text masked; output masked, then cut (`head`) or left out (`none`); raw never.
 * An undecodable detail (or one that cannot be read) is empty with unreadable: true. null when there is nothing.
 */
function exportDetail(
  source: ExportSource,
  sessionId: string,
  nodeId: string,
  options: ExportOptions,
  masker: ReturnType<typeof createMasker>,
  truncations: Record<string, { originalBytes: number }>,
): NodeDetail | null {
  const empty: NodeDetail = { nodeId, input: null, output: null, text: null, raw: null };
  let d: NodeDetail | null;
  try {
    d = source.getNodeDetail(sessionId, nodeId);
  } catch {
    return { ...empty, unreadable: true };
  }
  if (d === null) return null;
  if (d.unreadable) return { ...empty, unreadable: true };
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
        truncations[nodeId] = { originalBytes: cut.originalBytes };
      }
    }
  }
  if (input === null && output === null && text === null) return null;
  return { ...empty, input, output, text };
}
