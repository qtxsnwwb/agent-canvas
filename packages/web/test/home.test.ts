import { expect, test } from 'vitest';
import type { Project } from '@claude-canvas/shared';
import { pickProject, projectLook, projectName, relativeTime } from '../src/home';

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
