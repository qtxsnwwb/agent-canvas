import type { Graph, GraphNode } from '@claude-canvas/shared';
import { isNoise } from './compact';
import { turnNodes, type ViewNode } from './view';

/** What the waterfall panel lists: the main-thread steps of one turn, or the steps of one agent. */
export type WaterfallScope = { type: 'turn'; turnKey: string } | { type: 'agent'; agentId: string };

/**
 * One step. `startMs` / `endMs`: when it ran (equal for a step with no known duration, drawn as a marker). `open`: it
 * is still running or awaiting permission, and `endMs` is "now". `childAgentId`: set for a subagent dispatch whose
 * agent is known (the row can open that agent's steps).
 */
export interface WaterfallRow {
  id: string;
  node: GraphNode;
  startMs: number;
  endMs: number;
  open: boolean;
  childAgentId: string | null;
}
export interface Waterfall {
  rows: WaterfallRow[];
  /** The range of the rows (endMs > startMs; a one-millisecond range when there is nothing to measure). */
  startMs: number;
  endMs: number;
}

/** The scope a canvas selection stands for: a turn's summary node, or a subagent node whose agent is known. */
export function scopeOf(vn: ViewNode | undefined): WaterfallScope | null {
  if (vn === undefined) return null;
  if (vn.type === 'turn_summary') return { type: 'turn', turnKey: vn.turnKey };
  if (vn.type === 'node' && vn.node.kind === 'subagent' && vn.node.childAgentId !== null) {
    return { type: 'agent', agentId: vn.node.childAgentId };
  }
  return null;
}

function parseMs(ts: string | null): number | null {
  if (ts === null) return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

function isActive(node: GraphNode): boolean {
  return node.status === 'running' || node.status === 'awaiting_permission';
}

/**
 * The steps of `scope`, by start time then id. Tool and subagent steps run from their timestamp to `endedAt` (or to
 * timestamp + duration; to `nowMs` while still active). A thinking step's timestamp is when its message was recorded,
 * so it runs for its duration up to that time. Other steps are markers. `compact` leaves out thinking steps without
 * text and system steps other than compaction / interrupt (see isNoise).
 */
export function buildWaterfall(graph: Graph, scope: WaterfallScope, options: { compact: boolean; nowMs: number }): Waterfall {
  const nodes = scope.type === 'turn'
    ? turnNodes(graph, scope.turnKey)
    : Object.values(graph.nodes).filter((n) => n.agentId === scope.agentId);
  const rows: WaterfallRow[] = [];
  for (const node of nodes) {
    if (options.compact && isNoise(node)) continue;
    const at = parseMs(node.timestamp) ?? 0;
    let startMs = at;
    let endMs = at;
    const open = isActive(node);
    if (node.kind === 'thinking') {
      startMs = at - Math.max(0, node.durationMs ?? 0);
    } else if (open) {
      endMs = Math.max(at, options.nowMs);
    } else {
      endMs = Math.max(at, parseMs(node.endedAt) ?? at + Math.max(0, node.durationMs ?? 0));
    }
    rows.push({ id: node.id, node, startMs, endMs, open, childAgentId: node.kind === 'subagent' ? node.childAgentId : null });
  }
  rows.sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let startMs = Infinity;
  let endMs = -Infinity;
  for (const r of rows) {
    if (r.startMs < startMs) startMs = r.startMs;
    if (r.endMs > endMs) endMs = r.endMs;
  }
  if (rows.length === 0) return { rows, startMs: 0, endMs: 1 };
  return { rows, startMs, endMs: Math.max(endMs, startMs + 1) };
}

/** Where a row's bar sits on the track, as fractions of the range (0..1). */
export function barOf(w: Pick<Waterfall, 'startMs' | 'endMs'>, row: Pick<WaterfallRow, 'startMs' | 'endMs'>): { left: number; width: number } {
  const span = w.endMs - w.startMs;
  const left = Math.min(1, Math.max(0, (row.startMs - w.startMs) / span));
  const right = Math.min(1, Math.max(left, (row.endMs - w.startMs) / span));
  return { left, width: right - left };
}
