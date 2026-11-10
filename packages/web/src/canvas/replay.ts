import type { Graph, GraphEdge, GraphNode, Usage } from '@claude-canvas/shared';

export interface ReplayRange { startMs: number; endMs: number }

/** 所有节点（含子代理内部）的最早开始时间 .. 最晚的开始或结束时间；空图为 null；无法解析的时间忽略。 */
export function replayRange(graph: Graph): ReplayRange | null {
  let startMs = Infinity;
  let endMs = -Infinity;
  for (const id in graph.nodes) {
    const n = graph.nodes[id];
    const s = Date.parse(n.timestamp);
    if (!Number.isNaN(s)) {
      if (s < startMs) startMs = s;
      if (s > endMs) endMs = s;
    }
    if (n.endedAt) {
      const en = Date.parse(n.endedAt);
      if (!Number.isNaN(en) && en > endMs) endMs = en;
    }
  }
  return startMs === Infinity ? null : { startMs, endMs };
}

/**
 * t 时刻的图：保留开始时间 ≤ t 的节点（开始时间无法解析的始终保留）和两端都保留的边。
 * 有 endedAt 但 max(endedAt, 开始时间) > t 的节点显示为 running，durationMs 和 endedAt 置空。
 * 未变化的节点保持同一引用；整张图没有变化时返回传入的 graph 本身。
 */
export function graphAt(graph: Graph, tMs: number): Graph {
  const nodes: Record<string, GraphNode> = {};
  let dropped: Set<string> | null = null;
  let changed = false;
  for (const id in graph.nodes) {
    const n = graph.nodes[id];
    const s = Date.parse(n.timestamp);
    if (!Number.isNaN(s) && s > tMs) {
      (dropped ??= new Set()).add(id);
      continue;
    }
    let out = n;
    if (n.endedAt) {
      const en = Date.parse(n.endedAt);
      if (!Number.isNaN(en) && Math.max(en, Number.isNaN(s) ? en : s) > tMs) {
        out = { ...n, status: 'running', durationMs: null, endedAt: null };
        changed = true;
      }
    }
    nodes[id] = out;
  }
  let edges = graph.edges;
  if (dropped) {
    const kept: Record<string, GraphEdge> = {};
    for (const id in graph.edges) {
      const ed = graph.edges[id];
      if (!dropped.has(ed.from) && !dropped.has(ed.to)) kept[id] = ed;
    }
    edges = kept;
    changed = true;
  }
  return changed ? { nodes, edges } : graph;
}

/** 主线 prompt 节点的时间点，升序。 */
export function turnMarks(graph: Graph): { turnId: string; ms: number }[] {
  const marks: { turnId: string; ms: number }[] = [];
  for (const id in graph.nodes) {
    const n = graph.nodes[id];
    if (n.kind !== 'prompt' || n.agentId !== null || n.turnId === null) continue;
    const ms = Date.parse(n.timestamp);
    if (!Number.isNaN(ms)) marks.push({ turnId: n.turnId, ms });
  }
  return marks.sort((a, b) => a.ms - b.ms);
}

/** 按 messageId 去重求和；messageId 为空的节点各算一次；usage 为空的跳过。 */
export function usageTotal(nodes: Iterable<GraphNode>): Usage {
  const seen = new Set<string>();
  const total: Usage = { inputTokens: 0, outputTokens: 0 };
  for (const n of nodes) {
    if (!n.usage) continue;
    if (n.messageId) {
      if (seen.has(n.messageId)) continue;
      seen.add(n.messageId);
    }
    total.inputTokens += n.usage.inputTokens;
    total.outputTokens += n.usage.outputTokens;
  }
  return total;
}

const trim = (x: number) => x.toFixed(1).replace(/\.0$/, '');

/** 999 → "999"，1200 → "1.2k"，15000 → "15k"，1250000 → "1.3M"；负数或非有限数 → "0"。 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000 && Number(trim(n / 1000)) < 1000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}
