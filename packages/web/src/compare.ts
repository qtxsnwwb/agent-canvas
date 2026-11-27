/**
 * The 对比 page's view logic (spec 2026-11-24-compare-design.md, sections 3 and 4): the rows the page shows from GET
 * /api/compare's answer (texts, the 「更好」 bold, the masked texts, the links), the refetch while a side is running, and
 * the picker's lists. Pure: no React, no DOM (the page is pages/Compare.tsx, the picker ComparePicker.tsx).
 */
import {
  COMPARE_TOOL_CATEGORIES, COMPARE_TURNS_MAX, SEARCH_MIN_CHARS, effectiveStatus, normalizeFilePath, sessionName,
  type CompareFileCounts, type CompareFileRow, type CompareResponse, type CompareSide, type CompareToolCounts, type CompareTurnSide,
  type Origin, type SearchHit, type Session,
} from '@agent-canvas/shared';
import { ORIGIN_LOOK, projectName, relativeTime } from './home';
import { SESSION_STATUS_LABEL } from './labels';
import type { PageMasker } from './masking';
import { compareHash, sessionFileHash, sessionHash, sessionNodeHash } from './route';
import type { SearchResult } from './search';
import { NONE, formatCount, formatSpan, formatTokenCount } from './stats';

export const COMPARE_BUTTON_TEXT = '对比…';
export const SWAP_TEXT = '交换左右';
export const CHANGE_TEXT = '换一个';
export const NOT_FOUND_TEXT = '找不到这个会话';
export const SAME_SESSION_TEXT = '两边是同一个会话';
export const NO_TURN_TEXT = '（无）';
export const NO_PROMPT_TEXT = '（没有提示）';
export const TURNS_TRUNCATED_TEXT = `只列出前 ${COMPARE_TURNS_MAX} 轮`;
export const CWDS_DIFFER_TEXT = '两边工作目录不同，按相对路径配对';
export const OTHER_TOOLS_TEXT = '其他';
/** Most tool names shown under a category; more: 「等 N 个」. */
export const CATEGORY_NAMES_MAX = 6;
export const REFRESH_FAILED_TEXT = '刷新失败，正在重试…';
export const LOAD_FAILED_TEXT = '对比没能加载出来，正在重试…';
export const ALL_PROJECTS_TEXT = '在所有项目里找';
/** After 「0 / 0」: the file was touched only by failed or denied attempts. */
export const FAILED_ONLY_TEXT = '（只有失败的尝试）';

export const moreText = (n: number): string => `还有 ${n} 个`;
export const turnLabel = (index: number): string => `第 ${index} 轮`;

/** How often the page refetches while a side is running or waiting for a permission. */
export const COMPARE_POLL_MS = 5_000;
/** How often it refetches while neither is (a session that resumes is picked up; the server answers from its caches). */
export const COMPARE_IDLE_POLL_MS = 60_000;
/** The longest wait before retrying a failed request (the waits double from COMPARE_POLL_MS up to this). */
export const COMPARE_RETRY_MAX_MS = 60_000;

/** The wait before retrying after `failures` failed requests in a row (1, 2, …): 5 s, 10 s, 20 s, 40 s, then 60 s. */
export function compareRetryDelay(failures: number, intervalMs = COMPARE_POLL_MS): number {
  const n = Math.max(1, Math.floor(failures));
  return Math.min(COMPARE_RETRY_MAX_MS, intervalMs * 2 ** Math.min(n - 1, 16));
}

// ---- the 「更好」 bold ----

export type Better = 'left' | 'right' | null;

/** The side with the smaller value (shorter, fewer); none when they are equal or either is missing. */
export function betterSide(left: number | null, right: number | null): Better {
  if (left === null || right === null || left === right) return null;
  return left < right ? 'left' : 'right';
}

/**
 * betterSide as the cells show it: none when the two values print the same (2 h 5 min 10 s and 2 h 5 min 50 s both
 * 「2 小时 5 分」 at that size, 1.21M and 1.24M both 「1.2M」), so a bold never sits beside an identical-looking number.
 */
export function shownBetterSide(left: number | null, right: number | null, format: (n: number | null) => string): Better {
  if (left === null || right === null || format(left) === format(right)) return null;
  return betterSide(left, right);
}

// ---- the page's rows ----

/** A piece of a totals cell; `better`: shown bold (this side's value is the better one). */
export interface CellPart { text: string; better: boolean }

export interface TotalRow { label: string; left: CellPart[]; right: CellPart[] }

export interface SideHead {
  label: '左' | '右';
  /** The session id the address names (shown, shortened, when it was not found). */
  id: string;
  found: boolean;
  /** The session's name (masked), or NOT_FOUND_TEXT. */
  title: string;
  origin: Origin | null;
  originLabel: string;
  statusLabel: string;
  /** The working directory (masked); null when unknown or not found. */
  cwd: string | null;
  /** The session page; null when not found. */
  href: string | null;
}

/** A cell that may open a session (null when there is nothing on that side). */
export interface LinkCell { text: string; href: string | null }

export interface ToolRowView { key: string; name: string; left: LinkCell; right: LinkCell }

/** A category row: its label and the tool names counted in it (masked; CATEGORY_NAMES_MAX, then 「等 N 个」). */
export interface CategoryRowView { key: string; label: string; names: string; left: LinkCell; right: LinkCell }

export interface TurnCellView {
  /** The prompt's head (masked); '' when the turn has no prompt. */
  head: string;
  /** Duration · calls · tokens of the turn (「—」 for an undated turn's duration and for no token data). */
  meta: string;
  /** The session at that turn's prompt (the session itself when the turn has none). */
  href: string;
}

export interface TurnRowView { index: number; label: string; left: TurnCellView | null; right: TurnCellView | null }

export interface FileRowView { key: string; path: string; left: LinkCell; right: LinkCell }

export interface FileGroupView { key: 'both' | 'onlyLeft' | 'onlyRight'; label: string; rows: FileRowView[]; moreText: string | null }

export interface CompareView {
  heads: [SideHead, SideHead];
  sameSession: boolean;
  /** A side is running or waiting for a permission: the numbers are refetched (shouldPoll). */
  live: boolean;
  totals: TotalRow[];
  categories: CategoryRowView[];
  tools: ToolRowView[];
  turns: TurnRowView[];
  turnsTruncated: boolean;
  files: { groups: FileGroupView[]; cwdsDiffer: boolean; empty: boolean };
}

const plain = (text: string): CellPart[] => [{ text, better: false }];

function head(s: CompareSide | null, label: '左' | '右', id: string, m: PageMasker, nowMs: number): SideHead {
  if (s === null) {
    return { label, id, found: false, title: NOT_FOUND_TEXT, origin: null, originLabel: '', statusLabel: '', cwd: null, href: null };
  }
  const status = effectiveStatus(s, nowMs);
  return {
    label, id, found: true, title: m.title(sessionName({ id: s.sessionId, title: s.title })), origin: s.origin,
    originLabel: ORIGIN_LOOK[s.origin]?.label ?? s.origin, statusLabel: SESSION_STATUS_LABEL[status] ?? status,
    cwd: s.cwd === null ? null : m.text(s.cwd), href: sessionHash(s.sessionId),
  };
}

const newAndOutput = (s: CompareSide | null): number | null => (s?.tokens == null ? null : s.tokens.input + s.tokens.output);

/** A row of one number per side; `judge`: bold the better side (smaller is better). */
function numberRow(
  label: string, l: CompareSide | null, r: CompareSide | null, value: (s: CompareSide) => number | null,
  format: (n: number | null) => string, judge: boolean,
): TotalRow {
  const lv = l === null ? null : value(l);
  const rv = r === null ? null : value(r);
  const better = judge ? shownBetterSide(lv, rv, format) : null;
  return {
    label,
    left: [{ text: l === null ? NONE : format(lv), better: better === 'left' }],
    right: [{ text: r === null ? NONE : format(rv), better: better === 'right' }],
  };
}

function totals(l: CompareSide | null, r: CompareSide | null): TotalRow[] {
  const calls = shownBetterSide(l?.toolCalls ?? null, r?.toolCalls ?? null, formatCount);
  const failed = shownBetterSide(l?.failed ?? null, r?.failed ?? null, formatCount);
  const callsCell = (s: CompareSide | null, me: Better): CellPart[] => (s === null ? plain(NONE) : [
    { text: formatCount(s.toolCalls), better: calls === me }, { text: ' / ', better: false }, { text: formatCount(s.failed), better: failed === me },
  ]);
  const origin = (s: CompareSide | null): CellPart[] => plain(s === null ? NONE : ORIGIN_LOOK[s.origin]?.label ?? s.origin);
  return [
    numberRow('总用时', l, r, (s) => s.activeMs, formatSpan, true),
    numberRow('轮数', l, r, (s) => s.turns, formatCount, false),
    numberRow('步骤', l, r, (s) => s.steps, formatCount, false),
    { label: '工具调用 / 失败', left: callsCell(l, 'left'), right: callsCell(r, 'right') },
    numberRow('子代理', l, r, (s) => s.subagents, formatCount, false),
    numberRow('新输入 + 输出', l, r, newAndOutput, formatTokenCount, true),
    numberRow('缓存读取', l, r, (s) => s.tokens?.cachedInput ?? null, formatTokenCount, false),
    { label: '来源', left: origin(l), right: origin(r) },
  ];
}

function toolText(c: CompareToolCounts | null): string {
  if (c === null) return NONE;
  return c.failed > 0 ? `${formatCount(c.calls)}（失败 ${formatCount(c.failed)}）` : formatCount(c.calls);
}

function toolCell(c: CompareToolCounts | null, s: CompareSide | null): LinkCell {
  return { text: toolText(c), href: c === null || s === null ? null : sessionHash(s.sessionId) };
}

function turnCell(t: CompareTurnSide | null, s: CompareSide | null, m: PageMasker): TurnCellView | null {
  if (t === null || s === null) return null;
  return {
    head: t.promptHead === '' ? '' : m.summary(t.promptHead),
    meta: `${formatSpan(t.activeMs)} · ${formatCount(t.toolCalls)} 次 · ${formatTokenCount(t.tokens)}`,
    href: t.promptNodeId === null ? sessionHash(s.sessionId) : sessionNodeHash(s.sessionId, t.promptNodeId),
  };
}

/**
 * The file panel's address for a compared file: the row's path is relative to the side's cwd (the file page's
 * relativePath), the panel finds files by their full path. With the switch on the address carries the path masked (as
 * the file page's links do; the session page then finds the file by the masked value).
 */
function fileCell(c: CompareFileCounts | null, path: string, s: CompareSide | null, m: PageMasker): LinkCell {
  if (c === null || s === null) return { text: NONE, href: null };
  const full = normalizeFilePath(path, s.cwd) || path;
  const failedOnly = c.reads + c.changes === 0 && (c.failed ?? 0) > 0;
  return { text: `${formatCount(c.reads)} / ${formatCount(c.changes)}${failedOnly ? FAILED_ONLY_TEXT : ''}`, href: sessionFileHash(s.sessionId, m.on ? m.text(full) : full) };
}

const FILE_GROUPS: readonly { key: FileGroupView['key']; label: string }[] = [
  { key: 'both', label: '两边都碰过' }, { key: 'onlyLeft', label: '只有左边' }, { key: 'onlyRight', label: '只有右边' },
];

/**
 * Whether the page refetches at `nowMs`: a side is running (as the pages show it: a `running` session quiet for longer
 * than the stale cut shows 长时间无活动 and does not count) or waiting for a permission.
 */
export function shouldPoll(r: CompareResponse, nowMs: number): boolean {
  return [r.left, r.right].some((s) => s !== null && (effectiveStatus(s, nowMs) === 'running' || s.status === 'awaiting_permission'));
}

/**
 * Everything the page shows for an answer. `ids`: the route's two ids (a side that was not found has no id in the
 * answer). `m`: the cross-session list masker (rules only): titles, prompt heads, file paths, cwds and tool names.
 */
export function compareView(r: CompareResponse, ids: { a: string; b: string }, m: PageMasker, nowMs: number): CompareView {
  const { left: l, right: rt } = r;
  const tools: ToolRowView[] = r.tools.map((t, i) => ({
    key: `t${i}`, name: m.text(t.toolName), left: toolCell(t.left, l), right: toolCell(t.right, rt),
  }));
  if (r.otherTools !== null) {
    tools.push({
      key: 'other', name: OTHER_TOOLS_TEXT,
      left: { text: l === null ? NONE : formatCount(r.otherTools.left), href: null },
      right: { text: rt === null ? NONE : formatCount(r.otherTools.right), href: null },
    });
  }
  const categories = r.categories.map((c): CategoryRowView => {
    const shown = c.toolNames.slice(0, CATEGORY_NAMES_MAX).map((name) => m.text(name)).join('、');
    return {
      key: c.category,
      label: COMPARE_TOOL_CATEGORIES.find((x) => x.key === c.category)?.label ?? c.category,
      names: c.toolNames.length > CATEGORY_NAMES_MAX ? `${shown} 等 ${c.toolNames.length} 个` : shown,
      left: toolCell(c.left, l),
      right: toolCell(c.right, rt),
    };
  });
  const fileRow = (f: CompareFileRow, i: number): FileRowView => ({
    key: `f${i}`, path: m.text(f.path), left: fileCell(f.left, f.path, l, m), right: fileCell(f.right, f.path, rt, m),
  });
  const groups = FILE_GROUPS.map(({ key, label }): FileGroupView => ({
    key, label, rows: r.files[key].map(fileRow), moreText: r.files.more[key] > 0 ? moreText(r.files.more[key]) : null,
  }));
  return {
    heads: [head(l, '左', ids.a, m, nowMs), head(rt, '右', ids.b, m, nowMs)],
    sameSession: r.sameSession,
    live: shouldPoll(r, nowMs),
    totals: totals(l, rt),
    categories,
    tools,
    turns: r.turns.map((t) => ({ index: t.index, label: turnLabel(t.index), left: turnCell(t.left, l, m), right: turnCell(t.right, rt, m) })),
    turnsTruncated: r.turnsTruncated,
    files: { groups, cwdsDiffer: r.files.cwdsDiffer, empty: groups.every((g) => g.rows.length === 0 && g.moreText === null) },
  };
}

// ---- the refetch ----

/** What the page shows: the last answer (null before the first one) and whether the last request failed. */
export interface CompareState { response: CompareResponse | null; failed: boolean }

/**
 * Loads the comparison now, then again for as long as the page is open: every `intervalMs` (COMPARE_POLL_MS) while
 * shouldPoll says a side is running or waiting for a permission (judged at answer time, `now`), otherwise every
 * `idleMs` (COMPARE_IDLE_POLL_MS), so a session that resumes is picked up. A failed request keeps the last answer,
 * reports `failed` and is retried after compareRetryDelay (doubling up to COMPARE_RETRY_MAX_MS; a success starts over).
 * Answers arriving after close are dropped.
 */
export function createComparePoller(o: {
  load: () => Promise<CompareResponse>; onState: (s: CompareState) => void; intervalMs?: number; idleMs?: number; now?: () => number;
}): { close(): void } {
  const interval = o.intervalMs ?? COMPARE_POLL_MS;
  const idle = o.idleMs ?? COMPARE_IDLE_POLL_MS;
  const now = o.now ?? Date.now;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let response: CompareResponse | null = null;
  let failures = 0;
  const later = (ms: number): void => { timer = setTimeout(() => { timer = null; run(); }, ms); };
  const run = (): void => {
    if (closed) return;
    o.load().then(
      (r) => {
        if (closed) return;
        failures = 0;
        response = r;
        o.onState({ response, failed: false });
        later(shouldPoll(r, now()) ? interval : idle);
      },
      () => {
        if (closed) return;
        failures += 1;
        o.onState({ response, failed: true });
        later(compareRetryDelay(failures, interval));
      },
    );
  };
  run();
  return {
    close() {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

// ---- the picker ----

export interface PickerRow {
  id: string;
  /** The session's name (masked). */
  title: string;
  origin: Origin;
  originLabel: string;
  /** Last activity, relative ("5 分钟前"). */
  time: string;
  at: string;
  /** The project's name (masked) in the all-projects list; null in the same-project list. */
  project: string | null;
  /** The compare page with the current session on the left and this one on the right. */
  href: string;
}

/** The parts of a click that say whether it opens a link here (a plain left click) or elsewhere. */
export interface ClickLike { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }

/** A plain left click (the picker closes; a click that opens the link in another tab or window leaves it open). */
export const isPlainClick = (e: ClickLike): boolean => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

const byActivityDesc = (a: Session, b: Session): number =>
  a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function pickerRow(s: Session, currentId: string, m: PageMasker, nowMs: number, withProject: boolean): PickerRow {
  return {
    id: s.id, title: m.title(sessionName(s)), origin: s.origin, originLabel: ORIGIN_LOOK[s.origin]?.label ?? s.origin,
    time: relativeTime(s.lastActivityAt, nowMs), at: s.lastActivityAt,
    project: withProject ? m.text(projectName(s.cwd ?? s.projectId)) : null, href: compareHash(currentId, s.id),
  };
}

/**
 * The same project's sessions (the home page's list), newest activity first, without the current one and without
 * `otherId` (the right side the compare page's 换一个 replaces; null from the session page).
 */
export function pickerRows(
  sessions: readonly Session[], currentId: string, m: PageMasker, nowMs: number, otherId: string | null = null,
): PickerRow[] {
  return sessions.filter((s) => s.id !== currentId && s.id !== otherId).sort(byActivityDesc)
    .map((s) => pickerRow(s, currentId, m, nowMs, false));
}

/** The search endpoint's session hits (all projects), in its order, without the current one and without `otherId`. */
export function searchPickerRows(
  hits: readonly SearchHit[], currentId: string, m: PageMasker, nowMs: number, otherId: string | null = null,
): PickerRow[] {
  return hits.filter((h) => h.session.id !== currentId && h.session.id !== otherId).map((h) => pickerRow(h.session, currentId, m, nowMs, true));
}

const lowerAscii = (s: string): string => s.replace(/[A-Z]+/g, (c) => c.toLowerCase());

/** The rows whose title (as shown) contains `query` literally, ASCII letters without case; a blank query keeps all. */
export function filterPickerRows(rows: readonly PickerRow[], query: string): PickerRow[] {
  const q = lowerAscii(query.trim());
  return q === '' ? [...rows] : rows.filter((r) => lowerAscii(r.title).includes(q));
}

export type PickerList = { state: 'loading' } | { state: 'message'; text: string } | { state: 'rows'; rows: PickerRow[] };

/**
 * What the picker lists. Same project: its sessions (null while loading, 'failed'), filtered by the box. All projects:
 * the search's session hits for the box's text (at least SEARCH_MIN_CHARS characters; an answer for another text is
 * still loading).
 */
export function pickerList(o: {
  allProjects: boolean; query: string; currentId: string; projectId: string | null;
  /** The session already on the right (from the compare page's 换一个): not offered again. */
  otherId?: string | null;
  sessions: readonly Session[] | null | 'failed'; search: SearchResult | null; m: PageMasker; nowMs: number;
}): PickerList {
  const q = o.query.trim();
  if (o.allProjects) {
    if (Array.from(q).length < SEARCH_MIN_CHARS) return { state: 'message', text: `至少输入 ${SEARCH_MIN_CHARS} 个字` };
    if (o.search === null || o.search.q !== q) return { state: 'loading' };
    if (o.search.error !== null) return { state: 'message', text: `检索失败：${o.m.text(o.search.error)}` };
    const rows = searchPickerRows(o.search.hits ?? [], o.currentId, o.m, o.nowMs, o.otherId ?? null);
    return rows.length === 0 ? { state: 'message', text: '没有匹配的会话' } : { state: 'rows', rows };
  }
  if (o.projectId === null) return { state: 'message', text: `不知道是哪个项目，请勾选「${ALL_PROJECTS_TEXT}」` };
  if (o.sessions === null) return { state: 'loading' };
  if (o.sessions === 'failed') return { state: 'message', text: '这个项目的会话没能加载出来' };
  const all = pickerRows(o.sessions, o.currentId, o.m, o.nowMs, o.otherId ?? null);
  if (all.length === 0) return { state: 'message', text: '这个项目没有别的会话' };
  const rows = filterPickerRows(all, q);
  return rows.length === 0 ? { state: 'message', text: '没有符合筛选的会话' } : { state: 'rows', rows };
}
