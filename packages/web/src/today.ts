/* Pure helpers for today's usage (spec 2026-11-24-today-usage-design.md 4): the header item and the stats page's 今天
   block. No React, no DOM. */
import type { Origin, TodayUsage } from '@agent-canvas/shared';
import { ORIGIN_LOOK } from './home';
import { formatCount, formatSpan, formatTokenCount, NONE } from './stats';

const grouped = (n: number): string => Math.round(n).toLocaleString('en-US');

/** The header item: `今天` and its number (null before the first result), the screen-reader label, the warning state. */
export interface HeaderToday {
  num: string | null;
  label: string;
  over: boolean;
}

export function headerToday(usage: TodayUsage | null): HeaderToday {
  if (usage === null) return { num: null, label: '今天的用量，还没算出来', over: false };
  if (usage.main === null) return { num: NONE, label: '今天，用过的来源都没有 token 数据', over: false };
  const over = usage.over && usage.lineTokens !== null;
  const label = `今天，新输入加输出 ${grouped(usage.main)} token${over ? `，已超过你设的 ${grouped(usage.lineTokens!)}` : ''}`;
  return { num: formatTokenCount(usage.main), label, over };
}

/** How much of the line is used, floored to a whole percent (the line is above 0). */
export function percentOfLine(main: number, line: number): number {
  return Math.floor((main * 100) / line);
}

/** `HH:MM` of an ISO time in the browser's local time; null when it cannot be read. */
export function clockOf(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Names joined with 、; a space before the Chinese that follows when the last one ends in a Latin letter or digit. */
function namesBefore(origins: readonly Origin[]): string {
  const text = origins.map((o) => ORIGIN_LOOK[o].label).join('、');
  return /[A-Za-z0-9]$/.test(text) ? `${text} ` : text;
}

/** The line's row: `none` no line, `ok` under it, `over` at or over it (the server's `over`), `na` no main number to compare. */
export interface TodayLine {
  text: string;
  tone: 'none' | 'ok' | 'over' | 'na';
}

function lineRow(u: TodayUsage): TodayLine {
  if (u.lineTokens === null) return { text: '没有设提醒线', tone: 'none' };
  const line = formatTokenCount(u.lineTokens);
  if (u.main === null) return { text: `提醒线：${line}（今天没有 token 数据，比不了）`, tone: 'na' };
  if (u.over) return { text: `已超过提醒线 ${line}`, tone: 'over' };
  return { text: `提醒线：${line}（已用 ${percentOfLine(u.main, u.lineTokens)}%）`, tone: 'ok' };
}

export interface TodayRow {
  origin: Origin;
  name: string;
  /** New input + output. */
  main: string;
  cached: string;
  turns: string;
  active: string;
}

/** What the stats page's 今天 block shows. */
export interface TodayBlockView {
  title: string;
  /** Nothing today: the block says so instead of the activity row and the table. */
  empty: boolean;
  main: string;
  /** 过去 7 天同一时刻平均; null: not shown. */
  usual: string | null;
  cached: string;
  /** `轮数 N · 工作时长 …`; null when nothing today. */
  activity: string | null;
  line: TodayLine;
  rows: TodayRow[];
  notes: string[];
}

export function todayBlock(u: TodayUsage): TodayBlockView {
  const clock = clockOf(u.asOf);
  const empty = u.byOrigin.length === 0;
  const notes: string[] = [];
  if (empty) notes.push('今天还没有用过');
  const noTokens = u.byOrigin.filter((o) => o.tokens === null).map((o) => o.origin);
  if (noTokens.length > 0) {
    notes.push(u.main === null
      ? `${namesBefore(noTokens)}没有 token 数据，所以今天没有这个数`
      : `${namesBefore(noTokens)}没有 token 数据，不在这个数里`);
  }
  if (u.byOrigin.some((o) => o.origin === 'copilot')) notes.push('Copilot CLI 只在会话退出时记总数');
  return {
    title: clock === null ? '今天（数字最多晚 30 秒）' : `今天（截至 ${clock}，数字最多晚 30 秒）`,
    empty,
    main: formatTokenCount(u.main),
    usual: u.usualMain === null ? null : formatTokenCount(u.usualMain),
    cached: u.tokens === null ? NONE : formatTokenCount(u.tokens.cachedInput),
    activity: empty ? null : `轮数 ${formatCount(u.turns)} · 工作时长 ${formatSpan(u.activeMs)}`,
    line: lineRow(u),
    rows: u.byOrigin.map((o) => ({
      origin: o.origin,
      name: ORIGIN_LOOK[o.origin].label,
      main: o.tokens === null ? NONE : formatTokenCount(o.tokens.input + o.tokens.output),
      cached: o.tokens === null ? NONE : formatTokenCount(o.tokens.cachedInput),
      turns: formatCount(o.turns),
      active: formatSpan(o.activeMs),
    })),
    notes,
  };
}
