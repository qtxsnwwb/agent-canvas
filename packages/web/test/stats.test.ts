import { describe, expect, test } from 'vitest';
import type { Project, StatsResponse, StatsTool } from '@agent-canvas/shared';
import {
  DEFAULT_STATS_FILTER, STATS_FILTER_KEY, availableOrigins, columnLayout, dayIndexAt, dayLabel, dayLong, durationTicks,
  durationTickLabel, effectiveStatsFilter, formatAvg, formatCount, formatRate, formatSpan, formatTokenCount, formatTokenTriple, TOKEN_PARTS, tokenCells,
  isEmptyStats, labelEvery, labelIndices, parseStatsFilter, projectRowName, rangeLabel, roundedEndRect, serializeStatsFilter,
  sessionHref, shownNoTokenOrigins, splitTools, stackSegments, statsQueryString,
} from '../src/stats';

const H = 3_600_000;
const M = 60_000;

describe('formatting', () => {
  test('formatSpan: missing values are a dash, never 0', () => {
    expect(formatSpan(null)).toBe('—');
    expect(formatSpan(Number.NaN)).toBe('—');
    expect(formatSpan(-5)).toBe('—');
  });
  test('formatSpan picks the unit by size', () => {
    expect(formatSpan(0)).toBe('0 秒');
    expect(formatSpan(350)).toBe('350 毫秒');
    expect(formatSpan(4_230)).toBe('4.2 秒');
    expect(formatSpan(59_900)).toBe('59 秒');
    expect(formatSpan(3 * M)).toBe('3 分');
    expect(formatSpan(3 * M + 5_000)).toBe('3 分 5 秒');
    expect(formatSpan(H)).toBe('1 小时');
    expect(formatSpan(2 * H + 5 * M + 30_000)).toBe('2 小时 5 分');
    expect(formatSpan(1234 * H)).toBe('1,234 小时');
  });
  test('formatCount uses separators, then 万', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(12_345)).toBe('12,345');
    expect(formatCount(123_456)).toBe('12.3 万');
    expect(formatCount(null)).toBe('—');
  });
  test('formatRate', () => {
    expect(formatRate(null)).toBe('—');
    expect(formatRate(0)).toBe('0%');
    expect(formatRate(0.0004)).toBe('<0.1%');
    expect(formatRate(0.0345)).toBe('3.5%');
    expect(formatRate(0.25)).toBe('25%');
    expect(formatRate(1)).toBe('100%');
  });
  test('formatAvg', () => {
    expect(formatAvg(null)).toBe('—');
    expect(formatAvg(3)).toBe('3');
    expect(formatAvg(3.456)).toBe('3.5');
  });
  test('tokens: null is a dash, numbers as on the session page', () => {
    expect(formatTokenCount(null)).toBe('—');
    expect(formatTokenCount(950)).toBe('950');
    expect(formatTokenCount(12_300)).toBe('12.3k');
    expect(tokenCells(null)).toEqual(['—', '—', '—']);
    expect(tokenCells({ input: 1_500, cachedInput: 2_400_000, output: 200.4 })).toEqual(['1.5k', '2.4M', '200']);
    expect(TOKEN_PARTS.map((p) => p.label)).toEqual(['新输入', '缓存读取', '输出']);
    expect(formatTokenTriple(null)).toBe('—');
    expect(formatTokenTriple({ input: 1_500, cachedInput: 2_400_000, output: 200.4 })).toBe('新输入 1.5k · 缓存读取 2.4M · 输出 200');
  });
  test('day labels', () => {
    expect(dayLabel('2026-11-02')).toBe('11/2');
    expect(dayLong('2026-11-12')).toBe('2026-11-12 周四');
    expect(dayLong('2026-11-15')).toBe('2026-11-15 周日');
    expect(rangeLabel({ range: '7d', from: '2026-11-06', to: '2026-11-12' })).toBe('2026-11-06 至 2026-11-12');
    expect(rangeLabel({ range: 'all', from: null, to: '2026-11-12' })).toBe('截至 2026-11-12');
  });
});

describe('duration axis', () => {
  test('ticks are clean steps from 0, at most 5 of them, covering the max', () => {
    expect(durationTicks(50 * M)).toEqual({ step: 15 * M, max: 60 * M, ticks: [0, 15 * M, 30 * M, 45 * M, 60 * M] });
    expect(durationTicks(5 * H)).toEqual({ step: 2 * H, max: 6 * H, ticks: [0, 2 * H, 4 * H, 6 * H] });
    expect(durationTicks(90_000).step).toBe(30_000);
    for (const v of [1, 999, 61_000, 7 * H, 30 * H, 400 * H]) {
      const t = durationTicks(v);
      expect(t.max).toBeGreaterThanOrEqual(v);
      expect(t.ticks.length).toBeLessThanOrEqual(5);
      expect(t.ticks[0]).toBe(0);
      expect(t.ticks[t.ticks.length - 1]).toBe(t.max);
    }
  });
  test('an empty axis still has a scale', () => {
    expect(durationTicks(0)).toEqual({ step: M, max: M, ticks: [0, M] });
  });
  test('tick labels: seconds, minutes, then hours', () => {
    expect(durationTickLabel(0, 30_000)).toBe('0');
    expect(durationTickLabel(90_000, 30_000)).toBe('90 秒');
    expect(durationTickLabel(45 * M, 15 * M)).toBe('45 分');
    expect(durationTickLabel(90 * M, 30 * M)).toBe('1.5 小时');
    expect(durationTickLabel(4 * H, 2 * H)).toBe('4 小时');
  });
});

describe('columns and x labels', () => {
  test('bars are thin: at most 24 px, never wider than the band minus a 2 px gap', () => {
    const wide = columnLayout(7, 700);
    expect(wide.band).toBe(100);
    expect(wide.barWidth).toBe(24);
    expect(wide.x(0)).toBe(38);
    const narrow = columnLayout(30, 300);
    expect(narrow.barWidth).toBe(7);
    const tiny = columnLayout(366, 700);
    expect(tiny.barWidth).toBeGreaterThanOrEqual(1);
    expect(tiny.band - tiny.barWidth).toBeGreaterThanOrEqual(0.9);
  });
  test('labelEvery keeps labels apart', () => {
    expect(labelEvery(7, 700, 40)).toBe(1);
    expect(labelEvery(30, 800, 40)).toBe(2);
    expect(labelEvery(30, 450, 40)).toBe(3);
    expect(labelEvery(366, 800, 40)).toBe(28);
    for (const [n, w] of [[30, 600], [366, 1000], [366, 500], [92, 700]] as const) {
      const k = labelEvery(n, w, 40);
      expect(k * (w / n)).toBeGreaterThanOrEqual(40);
    }
  });
  test('labelIndices always include the last day', () => {
    expect(labelIndices(7, 1)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(labelIndices(7, 3)).toEqual([0, 3, 6]);
    expect(labelIndices(6, 2)).toEqual([1, 3, 5]);
    expect(labelIndices(0, 2)).toEqual([]);
  });
  test('dayIndexAt snaps a pointer x to its day, clamped', () => {
    const l = columnLayout(10, 500);
    expect(dayIndexAt(-5, l)).toBe(0);
    expect(dayIndexAt(49, l)).toBe(0);
    expect(dayIndexAt(50, l)).toBe(1);
    expect(dayIndexAt(9999, l)).toBe(9);
  });
});

describe('stacking', () => {
  test('stacks bottom-up in the given order, a 2 px gap under each upper segment, zeros skipped', () => {
    // 1 px per unit, baseline at y=100.
    const segs = stackSegments([10, 0, 20], 1, 100, 2);
    expect(segs).toEqual([
      { index: 0, y: 92, height: 8, top: false, y0: 90, y1: 100 },
      { index: 2, y: 70, height: 20, top: true, y0: 70, y1: 90 },
    ]);
  });
  test('a single segment is the top and keeps its full height', () => {
    expect(stackSegments([0, 5, 0], 2, 50, 2)).toEqual([{ index: 1, y: 40, height: 10, top: true, y0: 40, y1: 50 }]);
  });
  test('a segment smaller than the gap does not go negative', () => {
    const segs = stackSegments([1, 10], 1, 100, 2);
    expect(segs[0]!.height).toBe(0);
    expect(stackSegments([0, 0], 1, 100, 2)).toEqual([]);
  });
  test('roundedEndRect rounds only the data end', () => {
    expect(roundedEndRect(0, 0, 10, 20, 4)).toBe('M0 20V4A4 4 0 0 1 4 0H6A4 4 0 0 1 10 4V20Z');
    // Radius never exceeds half the width or the height.
    expect(roundedEndRect(0, 0, 2, 20, 4)).toBe('M0 20V1A1 1 0 0 1 1 0H1A1 1 0 0 1 2 1V20Z');
    expect(roundedEndRect(0, 0, 0, 20, 4)).toBe('');
  });
});

describe('filter state', () => {
  test('parse falls back to the defaults on anything odd', () => {
    expect(STATS_FILTER_KEY).toBe('agent-canvas.stats');
    expect(parseStatsFilter(null)).toEqual(DEFAULT_STATS_FILTER);
    expect(DEFAULT_STATS_FILTER).toEqual({ range: '7d', origin: 'all', projectId: null });
    expect(parseStatsFilter('{oops')).toEqual(DEFAULT_STATS_FILTER);
    expect(parseStatsFilter('[]')).toEqual(DEFAULT_STATS_FILTER);
    expect(parseStatsFilter('{"range":"1y","origin":"vim","projectId":3}')).toEqual(DEFAULT_STATS_FILTER);
    expect(parseStatsFilter('{"range":"30d","origin":"codex","projectId":"p1"}')).toEqual({ range: '30d', origin: 'codex', projectId: 'p1' });
  });
  test('serialise round-trips', () => {
    const f = { range: 'all', origin: 'cursor', projectId: 'D:\\x' } as const;
    expect(parseStatsFilter(serializeStatsFilter(f))).toEqual(f);
  });
  test('query string omits the unfiltered parts and encodes ids', () => {
    expect(statsQueryString(DEFAULT_STATS_FILTER)).toBe('range=7d');
    expect(statsQueryString({ range: 'all', origin: 'codex', projectId: 'a b/c' })).toBe('range=all&origin=codex&projectId=a%20b%2Fc');
  });
  const projects: Project[] = [
    { id: 'p1', cwd: '/x/one', sessionCount: 1, activeSessionCount: 0, origins: ['claude'] },
    { id: 'p2', cwd: '/x/two', sessionCount: 1, activeSessionCount: 0, origins: ['cursor', 'claude'] },
  ];
  test('availableOrigins: those that exist, in the fixed order', () => {
    expect(availableOrigins(projects)).toEqual(['claude', 'cursor']);
    expect(availableOrigins([])).toEqual([]);
  });
  test('effective filter drops an origin or project that no longer exists', () => {
    expect(effectiveStatsFilter({ range: '30d', origin: 'codex', projectId: 'p1' }, projects)).toEqual({ range: '30d', origin: 'all', projectId: 'p1' });
    expect(effectiveStatsFilter({ range: '30d', origin: 'cursor', projectId: 'gone' }, projects)).toEqual({ range: '30d', origin: 'cursor', projectId: null });
    // Before the project list has loaded the stored choice is kept as is.
    expect(effectiveStatsFilter({ range: '7d', origin: 'codex', projectId: 'gone' }, null)).toEqual({ range: '7d', origin: 'codex', projectId: 'gone' });
  });
});

const tool = (origin: StatsTool['origin'], toolName: string, totalMs: number, calls: number): StatsTool => ({
  origin, toolName, calls, finished: calls, failed: 0, failureRate: 0, timedCalls: calls, totalMs, medianMs: 1, p95Ms: 1,
});

describe('response helpers', () => {
  test('splitTools keeps the top n and summarises the rest from the totals', () => {
    const tools = [tool('claude', 'Bash', 500, 5), tool('codex', 'exec', 300, 3), tool('claude', 'Read', 100, 10)];
    expect(splitTools(tools, 2, { toolMs: 1000, toolCalls: 30 })).toEqual({ shown: tools.slice(0, 2), rest: { ms: 200, calls: 22 } });
    expect(splitTools(tools, 5, { toolMs: 900, toolCalls: 18 })).toEqual({ shown: tools, rest: null });
  });
  test('shownNoTokenOrigins intersects the dataset-wide list with the origins shown', () => {
    const r = { coverage: { noTokenData: ['cursor', 'codex'] }, byOrigin: [{ origin: 'claude' }, { origin: 'cursor' }] } as unknown as StatsResponse;
    expect(shownNoTokenOrigins(r)).toEqual(['cursor']);
  });
  test('isEmptyStats: no sessions, turns or calls', () => {
    const r = (sessions: number, turns: number, toolCalls: number) => ({ totals: { sessions, turns, toolCalls } }) as unknown as StatsResponse;
    expect(isEmptyStats(r(0, 0, 0))).toBe(true);
    expect(isEmptyStats(r(1, 0, 2))).toBe(false);
  });
  test('projectRowName names the merged row', () => {
    expect(projectRowName({ projectId: 'p', name: 'app', projectCount: 1 })).toBe('app');
    expect(projectRowName({ projectId: null, name: '其他', projectCount: 7 })).toBe('其他（7 个项目）');
  });
  test('sessionHref', () => {
    expect(sessionHref('a b')).toBe('#/s/a%20b');
  });
});
