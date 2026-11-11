import { expect, test } from 'vitest';
import type { Project } from '@claude-canvas/shared';
import { effectiveOriginFilter, heroTotals, matchesOrigin, ORIGIN_FILTER_KEY, ORIGIN_FILTER_OPTIONS, originLook, parseOriginFilter, pickProject, projectCountsExact, projectLook, projectName, relativeTime, shownProjectId, showOriginFilter, stripProjects, visibleProjects } from '../src/home';

const project = (id: string, sessionCount: number, activeSessionCount: number): Project => ({ id, cwd: null, sessionCount, activeSessionCount, origins: ['claude'] });

test('projectName is the last path segment, for either separator', () => {
  expect(projectName('D:\\Projects\\Enterprise')).toBe('Enterprise');
  expect(projectName('/home/me/app/')).toBe('app');
  expect(projectName('D--Projects-Enterprise')).toBe('D--Projects-Enterprise');
  expect(projectName('')).toBe('');
});

test('projectLook is stable for an id and differs between ids', () => {
  expect(projectLook('a')).toEqual(projectLook('a'));
  const looks = new Set(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map((id) => JSON.stringify(projectLook(id))));
  expect(looks.size).toBeGreaterThan(1);
});

test('pickProject prefers active sessions, then the number of sessions', () => {
  expect(pickProject([])).toBeNull();
  expect(pickProject([project('a', 9, 0), project('b', 2, 1), project('c', 5, 1)])?.id).toBe('c');
  expect(pickProject([project('a', 3, 0), project('b', 7, 0)])?.id).toBe('b');
});

test('relativeTime', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  const ago = (ms: number) => relativeTime(new Date(now - ms).toISOString(), now);
  expect(ago(5_000)).toBe('刚刚');
  expect(ago(5 * 60_000)).toBe('5 分钟前');
  expect(ago(3 * 3_600_000)).toBe('3 小时前');
  expect(ago(30 * 3_600_000)).toBe('昨天');
  expect(ago(4 * 86_400_000)).toBe('4 天前');
  expect(relativeTime('nope', now)).toBe('');
  expect(relativeTime(new Date(now + 60_000).toISOString(), now)).toBe('刚刚'); // a clock slightly ahead
});

// ---- origin filter ----
const mixed = (id: string, origins: Project['origins'], sessionCount = 1, activeSessionCount = 0): Project =>
  ({ id, cwd: null, sessionCount, activeSessionCount, origins });

test('parseOriginFilter：认得的值原样返回，其余（含 null）为 all', () => {
  expect(ORIGIN_FILTER_KEY).toBe('claude-canvas.origin');
  expect(parseOriginFilter('claude')).toBe('claude');
  expect(parseOriginFilter('codex')).toBe('codex');
  expect(parseOriginFilter('all')).toBe('all');
  expect(parseOriginFilter(null)).toBe('all');
  expect(parseOriginFilter('gemini')).toBe('all');
});

test('showOriginFilter 只在有项目含 codex 时为真；effectiveOriginFilter 此外一律是 all', () => {
  const claudeOnly = [mixed('a', ['claude']), mixed('b', ['claude'])];
  const withCodex = [mixed('a', ['claude']), mixed('b', ['codex'])];
  expect(showOriginFilter([])).toBe(false);
  expect(showOriginFilter(claudeOnly)).toBe(false);
  expect(showOriginFilter(withCodex)).toBe(true);
  expect(effectiveOriginFilter('codex', claudeOnly)).toBe('all');
  expect(effectiveOriginFilter('claude', claudeOnly)).toBe('all');
  expect(effectiveOriginFilter('codex', withCodex)).toBe('codex');
  expect(effectiveOriginFilter('all', withCodex)).toBe('all');
});

test('matchesOrigin', () => {
  expect(matchesOrigin('all', 'claude')).toBe(true);
  expect(matchesOrigin('all', 'codex')).toBe(true);
  expect(matchesOrigin('codex', 'codex')).toBe(true);
  expect(matchesOrigin('codex', 'claude')).toBe(false);
  expect(matchesOrigin('claude', 'codex')).toBe(false);
});

test('visibleProjects 按 Project.origins 过滤，保持顺序', () => {
  const ps = [mixed('a', ['claude']), mixed('b', ['claude', 'codex']), mixed('c', ['codex']), mixed('d', [])];
  expect(visibleProjects(ps, 'all').map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
  expect(visibleProjects(ps, 'codex').map((p) => p.id)).toEqual(['b', 'c']);
  expect(visibleProjects(ps, 'claude').map((p) => p.id)).toEqual(['a', 'b']);
});

test('stripProjects：可见的项目，加上被筛掉但正被选中的那个（原顺序）', () => {
  const ps = [mixed('a', ['claude']), mixed('b', ['codex']), mixed('c', ['claude'])];
  expect(stripProjects(ps, 'codex', null).map((p) => p.id)).toEqual(['b']);
  expect(stripProjects(ps, 'codex', 'b').map((p) => p.id)).toEqual(['b']);
  expect(stripProjects(ps, 'codex', 'c').map((p) => p.id)).toEqual(['b', 'c']);
  expect(stripProjects(ps, 'codex', 'missing').map((p) => p.id)).toEqual(['b']);
  expect(stripProjects(ps, 'all', 'a').map((p) => p.id)).toEqual(['a', 'b', 'c']);
});

test('shownProjectId：地址里的项目优先（即使被筛掉），否则只在可见项目里挑', () => {
  const ps = [mixed('a', ['claude'], 9, 3), mixed('b', ['codex'], 1, 0)];
  expect(shownProjectId('a', ps, 'codex')).toBe('a');
  expect(shownProjectId(null, ps, 'codex')).toBe('b');
  expect(shownProjectId(null, ps, 'all')).toBe('a');
  expect(shownProjectId(null, ps, 'claude')).toBe('a');
  expect(shownProjectId(null, [mixed('a', ['claude'])], 'codex')).toBeNull();
});

test('projectCountsExact：全部时恒真；筛选时只有项目只含该来源才真', () => {
  expect(projectCountsExact(mixed('a', ['claude', 'codex']), 'all')).toBe(true);
  expect(projectCountsExact(mixed('a', ['claude', 'codex']), 'codex')).toBe(false);
  expect(projectCountsExact(mixed('a', ['codex']), 'codex')).toBe(true);
  expect(projectCountsExact(mixed('a', ['claude']), 'claude')).toBe(true);
});

test('heroTotals：项目数随筛选；会话数只在都准确时给出，否则为 null', () => {
  const ps = [mixed('a', ['claude'], 5, 1), mixed('b', ['claude', 'codex'], 4, 2), mixed('c', ['codex'], 3, 1)];
  expect(heroTotals(ps, 'all')).toEqual({ projects: 3, sessions: 12, active: 4 });
  expect(heroTotals(ps, 'codex')).toEqual({ projects: 2, sessions: null, active: null });
  expect(heroTotals(ps, 'claude')).toEqual({ projects: 2, sessions: null, active: null });
  expect(heroTotals([mixed('c', ['codex'], 3, 1), mixed('d', ['claude'], 7, 0)], 'codex')).toEqual({ projects: 1, sessions: 3, active: 1 });
  expect(heroTotals([], 'codex')).toEqual({ projects: 0, sessions: 0, active: 0 });
});

test('ORIGIN_LOOK：两个来源各有名字和不同的类名', () => {
  expect(originLook('claude')).toEqual({ label: 'Claude Code', className: 'origin-claude' });
  expect(originLook('codex')).toEqual({ label: 'Codex', className: 'origin-codex' });
  expect(ORIGIN_FILTER_OPTIONS.map((o) => [o.value, o.label])).toEqual([['all', '全部'], ['claude', 'Claude Code'], ['codex', 'Codex']]);
});
