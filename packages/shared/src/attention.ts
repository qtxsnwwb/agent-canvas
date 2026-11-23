import type { Origin } from './model.js';

/**
 * Why a session is waiting for the user (attention spec 3), one at a time, in this priority. There is no "input" kind:
 * `awaiting_input` counts as `idle` (finished or error).
 */
export type AttentionKind = 'permission' | 'error' | 'stuck' | 'finished';

/** The kinds in priority order; also the order of the main list (spec 5). */
export const ATTENTION_KIND_ORDER: readonly AttentionKind[] = ['permission', 'error', 'stuck', 'finished'];

/**
 * Origins that cannot tell "finished" from "running" (manual, "通知" table): counted, never in the main list (spec 3.1).
 */
export const ATTENTION_UNDETERMINABLE_ORIGINS: readonly Origin[] = ['grok', 'copilot', 'doubao'];

/**
 * autoHideHours: inclusive integer range and default of the auto-hide limit (spec 4.4). keepDays: the hidden list and
 * the stored dismissals only keep items whose `since` is this recent. explanationChars: an explanation is cut to this.
 */
export const ATTENTION_LIMITS = { autoHideHours: { min: 1, max: 720, default: 24 }, keepDays: 30, explanationChars: 200 } as const;

/** One stretch of a session waiting for the user (spec 3.2), identified by its key. */
export interface AttentionItem {
  /** attentionKey(sessionId, kind, since). */
  key: string;
  sessionId: string;
  kind: AttentionKind;
  /** When this stretch started (ISO 8601). */
  since: string;
  title: string | null;
  origin: Origin;
  projectId: string;
  cwd: string | null;
  /** Node title / summary only, at most ATTENTION_LIMITS.explanationChars; conversation content (the web masks it). */
  explanation: string | null;
  /** The node the item is about (click target), when there is one. */
  nodeId: string | null;
}

/** An item out of the main list: dismissed ("知道了") or older than the auto-hide limit. */
export interface AttentionHidden {
  item: AttentionItem;
  reason: 'dismissed' | 'expired';
}

/** The attention page's whole state (GET, and the `attention` WebSocket message). */
export interface AttentionResponse {
  /** The main list, sorted by sortAttention. */
  items: AttentionItem[];
  /**
   * Items out of the main list whose `since` is within ATTENTION_LIMITS.keepDays, newest first. Only when asked for
   * (it can be long); empty in the live push and the default answer, where hiddenCount gives their number.
   */
  hidden: AttentionHidden[];
  /** Number of such items (whether or not `hidden` lists them). */
  hiddenCount: number;
  /** Sessions of ATTENTION_UNDETERMINABLE_ORIGINS that would otherwise be candidates. */
  undeterminable: { sessionId: string; title: string | null; origin: Origin }[];
  /** Sessions running and not stuck. */
  runningCount: number;
  /** The auto-hide limit in effect (hours). */
  autoHideHours: number;
}

/** The key of a stretch: `${sessionId}|${kind}|${since}` (spec 3.2). */
export function attentionKey(sessionId: string, kind: AttentionKind, since: string): string {
  return `${sessionId}|${kind}|${since}`;
}

const sinceMs = (item: AttentionItem): number => {
  const t = Date.parse(item.since);
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
};

/** A sorted copy: by kind (ATTENTION_KIND_ORDER), then `since` newest first (spec 5). */
export function sortAttention(items: readonly AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => {
    const k = ATTENTION_KIND_ORDER.indexOf(a.kind) - ATTENTION_KIND_ORDER.indexOf(b.kind);
    if (k !== 0) return k;
    const d = sinceMs(b) - sinceMs(a);
    return d > 0 ? 1 : d < 0 ? -1 : 0;
  });
}

/** Checks an auto-hide limit: an integer number of hours in ATTENTION_LIMITS.autoHideHours. */
export function validateAutoHideHours(v: unknown): { ok: true; value: number } | { ok: false; error: string } {
  const { min, max } = ATTENTION_LIMITS.autoHideHours;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    return { ok: false, error: `时限必须是 ${min} 到 ${max} 之间的整数（小时）` };
  }
  return { ok: true, value: v };
}
