import { sessionName, type ExportBundle, type Graph, type GraphEdge, type GraphNode, type NodeDetail } from '@agent-canvas/shared';
import { neutralizeBidi } from '../bidi';
import type { LayoutClient } from '../canvas/layoutClient';
import { parseHash } from '../route';
import type { SessionSource, StepDetail } from '../sessionSource';

/**
 * The exported file's data: reading and checking it (the full-page messages when it cannot be shown), and the session
 * page's embedded source built from it. Pure: no DOM, no network.
 */

export const EXPORT_DATA_MISSING = '这个文件里没有导出的数据，无法显示。请重新导出。';
export const EXPORT_DATA_DAMAGED = '导出的数据已损坏，无法读取。请重新导出。';
export const EXPORT_DATA_BAD = '导出的数据格式不正确，无法显示。请重新导出。';
export const exportDataNewer = (version: unknown): string =>
  `这个文件由更新版本的 Agent Canvas 导出（数据版本 ${String(version)}），当前的查看器无法显示。`;

export type ParsedExport = { ok: true; bundle: ExportBundle } | { ok: false; message: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrOrNull = (v: unknown): boolean => v === null || typeof v === 'string';

function goodSession(s: unknown): boolean {
  return isObject(s) && isStr(s.id) && isStr(s.projectId) && isStr(s.origin) && isStrOrNull(s.cwd) && isStrOrNull(s.title)
    && isStrOrNull(s.gitBranch) && isStr(s.status) && isStr(s.startedAt) && isStr(s.lastActivityAt);
}
function goodNode(n: unknown): boolean {
  return isObject(n) && isStr(n.id) && isStr(n.kind) && isStr(n.timestamp) && isStr(n.title) && isStr(n.summary)
    && isStrOrNull(n.turnId) && isStrOrNull(n.agentId) && isStrOrNull(n.childAgentId) && isStrOrNull(n.parentId);
}
function goodEdge(e: unknown): boolean {
  return isObject(e) && isStr(e.id) && isStr(e.from) && isStr(e.to) && isStr(e.kind);
}
function goodOptions(o: unknown): boolean {
  return isObject(o) && isObject(o.scope) && isStr(o.scope.kind) && isObject(o.mask) && isStr(o.output);
}

/**
 * The text of the file's `#agent-canvas-export` element (null when there is none) → the bundle, or the message the page
 * shows instead. Only version 1 is read; the shape is checked as far as the page relies on it.
 */
export function parseExportData(text: string | null): ParsedExport {
  // The template's placeholder (never filled: the file was not made by an export) is a run of capitals and `_`. It is not
  // named here, so the exported file holds the placeholder text nowhere but where the server replaced it.
  if (text === null || text.trim() === '' || /^[A-Z_]+$/.test(text.trim())) return { ok: false, message: EXPORT_DATA_MISSING };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, message: EXPORT_DATA_DAMAGED };
  }
  if (!isObject(data)) return { ok: false, message: EXPORT_DATA_BAD };
  if (typeof data.version === 'number' && data.version > 1) return { ok: false, message: exportDataNewer(data.version) };
  if (data.version !== 1) return { ok: false, message: EXPORT_DATA_BAD };
  const good = isStr(data.exportedAt) && goodOptions(data.options) && isObject(data.report) && isObject(data.report.byType)
    && goodSession(data.session)
    && Array.isArray(data.nodes) && data.nodes.every(goodNode)
    && Array.isArray(data.edges) && data.edges.every(goodEdge)
    && isObject(data.details) && isObject(data.truncations)
    && Array.isArray(data.unreadable) && data.unreadable.every(isStr);
  return good ? { ok: true, bundle: data as unknown as ExportBundle } : { ok: false, message: EXPORT_DATA_BAD };
}

const own = <T>(record: Record<string, T>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;

/**
 * The session page's source for an exported file. No subscription (nothing changes), details from the bundle (none for
 * a step without an entry; the damaged line for an unreadable one; `raw` never shown), the original size of an output
 * cut at export time. No files summary (there is no shared function computing it in the browser) and no anomalies (not
 * exported): their buttons are hidden. Edges whose ends are not both in the file are dropped.
 */
export function embeddedSource(bundle: ExportBundle, createLayoutClient: () => LayoutClient): SessionSource {
  // fromEntries defines own properties (an id like `__proto__` stays an entry).
  const nodes: Record<string, GraphNode> = Object.fromEntries(bundle.nodes.map((n) => [n.id, n]));
  const has = (id: string): boolean => Object.prototype.hasOwnProperty.call(nodes, id);
  const edges: Record<string, GraphEdge> = Object.fromEntries(
    bundle.edges.filter((e) => has(e.from) && has(e.to)).map((e) => [e.id, e]),
  );
  const graph: Graph = { nodes, edges };
  const unreadable = new Set(bundle.unreadable);
  const session = bundle.session;
  const detailOf = (nodeId: string): StepDetail => {
    const entry = own(bundle.details, nodeId);
    const cut = own(bundle.truncations, nodeId);
    const bytes = isObject(cut) && typeof cut.originalBytes === 'number' && Number.isFinite(cut.originalBytes) ? cut.originalBytes : null;
    if (isObject(entry)) {
      const d = entry as unknown as NodeDetail;
      return { detail: { ...d, raw: null }, outputOriginalBytes: bytes };
    }
    if (unreadable.has(nodeId)) {
      return { detail: { nodeId, input: null, output: null, text: null, raw: null, unreadable: true }, outputOriginalBytes: null };
    }
    return { detail: null, outputOriginalBytes: null };
  };
  return {
    getSession: () => session,
    getGraph: () => graph,
    subscribe: () => () => {},
    live: false,
    nodeDetail: (nodeId) => Promise.resolve(detailOf(nodeId)),
    files: null,
    anomalies: null,
    createLayoutClient,
  };
}

export function exportDocumentTitle(bundle: ExportBundle): string {
  return neutralizeBidi(`${sessionName(bundle.session)} · Agent Canvas 导出`);
}

/**
 * The node a location hash names inside the file: `#n/<id>` (or `#/n/<id>`), or the node part of a session address
 * (`#/s/<session>/n/<id>`, as the app writes it). Null for anything else or an id that cannot be decoded.
 */
export function viewerNodeId(hash: string): string | null {
  const h = hash.replace(/^#/, '');
  const short = /^\/?n\/(.*)$/.exec(h);
  if (short !== null) {
    try {
      const id = decodeURIComponent(short[1]!);
      return id === '' ? null : id;
    } catch {
      return null;
    }
  }
  const route = parseHash(hash);
  return route.page === 'session' ? route.nodeId ?? null : null;
}
