import type { Graph, GraphEdge, GraphNode, Usage } from '@agent-canvas/shared';
import { formatDuration } from './format';

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

/** `ms` clamped to the range (unchanged without a range). */
export function clampToRange(ms: number, range: ReplayRange | null): number {
  return range === null ? ms : Math.min(range.endMs, Math.max(range.startMs, ms));
}

/**
 * One playback step: the time (clamped to the range) advanced by `elapsedMs × speed`, clamped again; `done` once it has
 * reached the range end. A negative or non-finite elapsed time or speed does not move the time. No range: done.
 */
export function advance(timeMs: number, elapsedMs: number, speed: number, range: ReplayRange | null): { timeMs: number; done: boolean } {
  if (range === null) return { timeMs, done: true };
  const step = Number.isFinite(elapsedMs) && elapsedMs > 0 && Number.isFinite(speed) && speed > 0 ? elapsedMs * speed : 0;
  const base = Number.isFinite(timeMs) ? timeMs : range.startMs;
  const next = clampToRange(base + step, range);
  return { timeMs: next, done: next >= range.endMs };
}

/** "第 N 轮": how many turn marks are at or before `timeMs` (0 before the first). */
export function turnIndexAt(marks: readonly { ms: number }[], timeMs: number): number {
  let n = 0;
  for (const m of marks) {
    if (m.ms <= timeMs) n++;
    else break;
  }
  return n;
}

/**
 * The turn mark a PageUp (`direction` -1) / PageDown (+1) on the slider jumps to: the latest mark strictly before
 * `timeMs`, or the earliest strictly after it; null when there is none.
 */
export function adjacentMark(marks: readonly { ms: number }[], timeMs: number, direction: -1 | 1): number | null {
  let best: number | null = null;
  for (const { ms } of marks) {
    if (direction < 0 ? ms < timeMs && (best === null || ms > best) : ms > timeMs && (best === null || ms < best)) best = ms;
  }
  return best;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const localDay = (d: Date): string => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/**
 * The timeline clock: the local time of day, or `MM-DD HH:mm:ss` when the replay range does not start and end on the
 * same local calendar day (a time alone would be ambiguous). '' for an invalid time.
 */
export function formatClock(ms: number, range: ReplayRange | null): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  if (range === null || localDay(new Date(range.startMs)) === localDay(new Date(range.endMs))) return d.toLocaleTimeString();
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * The extra row a node gets in the replay view: tool / subagent "耗时 3.4s · 输入 1.2k · 输出 340", text the two token
 * parts; missing parts are left out, "—" when none is left. null for the other kinds (no extra row).
 */
export function replayOverlay(node: Pick<GraphNode, 'kind' | 'durationMs' | 'usage'>): string | null {
  const timed = node.kind === 'tool' || node.kind === 'subagent';
  if (!timed && node.kind !== 'text') return null;
  const parts: string[] = [];
  if (timed && node.durationMs !== null) {
    const d = formatDuration(node.durationMs);
    if (d !== '') parts.push(`耗时 ${d}`);
  }
  if (node.usage) parts.push(`输入 ${formatTokens(node.usage.inputTokens)}`, `输出 ${formatTokens(node.usage.outputTokens)}`);
  return parts.length > 0 ? parts.join(' · ') : '—';
}
