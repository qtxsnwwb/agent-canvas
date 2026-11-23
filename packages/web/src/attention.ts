/**
 * The attention page's view logic (spec 5): rows from the API's items (labels, order, project, relative time, the
 * explanation line, the link), the hidden list, the footer and empty-state texts, the header count, the auto-hide input
 * and the live state's retry delay and problem texts. Pure; the page is pages/Attention.tsx, the live state client.ts
 * openLiveAttention.
 */
import {
  sortAttention, validateAutoHideHours, type AttentionHidden, type AttentionItem, type AttentionKind, type AttentionResponse,
  type EffectiveSessionStatus, type Origin,
} from '@agent-canvas/shared';
import { ORIGIN_LOOK, projectTitle, relativeTime } from './home';
import { maskAttentionItem, type PageMasker } from './masking';
import { sessionHash, sessionNodeHash } from './route';

export const ATTENTION_KIND_LABEL: Record<AttentionKind, string> = {
  permission: '等你批准',
  error: '出错中断',
  stuck: '卡住了',
  finished: '跑完了',
};

/** What the explanation line says it is (spec 5 sketch; spec 4.3 says where each comes from). */
export const ATTENTION_EXPLANATION_PREFIX: Record<AttentionKind, string> = {
  permission: '要执行：',
  error: '一轮以错误结束：',
  stuck: '最后一步：',
  finished: '最后的回复：',
};

/** The session status pill each kind is drawn with (the existing status styles, `status-<this>`). */
export const ATTENTION_STATUS_CLASS: Record<AttentionKind, EffectiveSessionStatus | 'failed'> = {
  permission: 'awaiting_permission',
  error: 'failed',
  stuck: 'stale',
  finished: 'idle',
};

export interface AttentionRowView {
  key: string;
  sessionId: string;
  kind: AttentionKind;
  kindLabel: string;
  statusClass: string;
  origin: Origin;
  /** The session title (masked with the switch on), else the start of its id. */
  title: string;
  /** The project's name (masked with the switch on). */
  project: string;
  /** `since`, for the tooltip. */
  at: string;
  /** `since` relative to now. */
  time: string;
  /** The prefixed explanation (masked with the switch on); null without one. */
  explanation: string | null;
  /** The session, at the item's node when it has one. */
  href: string;
}

function rowOf(raw: AttentionItem, m: PageMasker, nowMs: number): AttentionRowView {
  const item = maskAttentionItem(raw, m);
  return {
    key: raw.key,
    sessionId: raw.sessionId,
    kind: raw.kind,
    kindLabel: ATTENTION_KIND_LABEL[raw.kind],
    statusClass: ATTENTION_STATUS_CLASS[raw.kind],
    origin: raw.origin,
    title: item.title ?? raw.sessionId.slice(0, 8),
    // The name comes from the raw directory (or the project id, the encoded directory) and is masked as a whole, as
    // maskProject does.
    project: m.text(projectTitle({ id: raw.projectId, cwd: raw.cwd })),
    at: raw.since,
    time: relativeTime(raw.since, nowMs),
    explanation: item.explanation === null ? null : `${ATTENTION_EXPLANATION_PREFIX[raw.kind]}${item.explanation}`,
    href: raw.nodeId === null ? sessionHash(raw.sessionId) : sessionNodeHash(raw.sessionId, raw.nodeId),
  };
}

/** The main list's rows: same kinds together in ATTENTION_KIND_ORDER, newest first within a kind (sortAttention). */
export function attentionRows(items: readonly AttentionItem[], m: PageMasker, nowMs: number): AttentionRowView[] {
  return sortAttention(items).map((i) => rowOf(i, m, nowMs));
}

export interface HiddenRowView extends AttentionRowView {
  reason: AttentionHidden['reason'];
  reasonText: string;
  /** Only a "知道了" can be undone; an expired item comes back only as a new stretch. */
  canRestore: boolean;
}

/** The hidden list's rows, in the server's order (newest first), each with why it is out of the main list. */
export function hiddenRows(hidden: readonly AttentionHidden[], autoHideHours: number, m: PageMasker, nowMs: number): HiddenRowView[] {
  return hidden.map((h) => ({
    ...rowOf(h.item, m, nowMs),
    reason: h.reason,
    reasonText: h.reason === 'dismissed' ? '你点了知道了' : `超过 ${autoHideHours} 小时没处理`,
    canRestore: h.reason === 'dismissed',
  }));
}

/** The header's number next to “待处理”: the main list's length; null (no number) while unknown or zero. */
export function headerCount(r: AttentionResponse | null): number | null {
  return r === null || r.items.length === 0 ? null : r.items.length;
}

/**
 * The line under the list: "运行中 N 个 · 无法判断状态的 M 个（豆包、Grok）". `withRunning` false (the empty state says the
 * running count itself): only the undeterminable part, null when there is none.
 */
export function footerText(r: AttentionResponse, withRunning: boolean): string | null {
  const parts: string[] = [];
  if (withRunning) parts.push(`运行中 ${r.runningCount} 个`);
  if (r.undeterminable.length > 0) {
    const origins = [...new Set(r.undeterminable.map((u) => u.origin))].map((o) => ORIGIN_LOOK[o].label);
    parts.push(`无法判断状态的 ${r.undeterminable.length} 个（${origins.join('、')}）`);
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

/** The empty main list: one sentence and the running count. */
export function emptyText(r: AttentionResponse): { title: string; sub: string } {
  return {
    title: '此刻没有需要你处理的会话',
    sub: r.runningCount > 0 ? `运行中 ${r.runningCount} 个` : '也没有正在运行的会话',
  };
}

/** The auto-hide limit as typed: digits only, then the shared range check (1..720). */
export function parseAutoHideInput(text: string): { ok: true; value: number } | { ok: false; error: string } {
  const t = text.trim();
  return validateAutoHideHours(/^\d+$/.test(t) ? Number(t) : Number.NaN);
}

/** The wait before fetching the state again after `failures` failed attempts in a row: 0.5 s doubling, at most 5 s. */
export function attentionRetryDelay(failures: number): number {
  return Math.min(500 * 2 ** Math.max(0, failures - 1), 5_000);
}

/** Why the state could not be fetched: the server is still preparing the list (503), or another failure. */
export function attentionProblem(e: unknown): { kind: 'preparing' | 'failed'; text: string } {
  const status = typeof e === 'object' && e !== null ? (e as { status?: unknown }).status : undefined;
  if (status === 503) return { kind: 'preparing', text: '待处理列表正在准备…' };
  if (typeof status === 'number') return { kind: 'failed', text: `服务出错了（HTTP ${status}），正在重试…` };
  return { kind: 'failed', text: '连不上 Agent Canvas 服务，正在重试…' };
}

/** A write's failure as shown next to the list: the server's text (sendJson puts it in the message), else a generic one. */
export function writeErrorText(e: unknown): string {
  if (e instanceof Error && e.message !== '' && typeof (e as { status?: unknown }).status === 'number') return e.message;
  return '连不上 Agent Canvas 服务，请确认它还在运行';
}
