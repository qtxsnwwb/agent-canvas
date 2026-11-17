import { expect, test } from 'vitest';
import type { Project } from '@agent-canvas/shared';
import { effectiveOriginFilter, originFilterOptions, presentOrigins, showOriginFilter } from '../src/home';

// Final review M-1: the home page's origin switch offers only origins that have sessions.

const p = (id: string, origins: Project['origins']): Project => ({ id, cwd: null, sessionCount: 1, activeSessionCount: 0, origins });
const values = (projects: Project[]) => originFilterOptions(projects).map((o) => o.value);

test('只有 Claude Code：不显示筛选，和以前一样', () => {
  const claudeOnly = [p('a', ['claude']), p('b', ['claude'])];
  expect(showOriginFilter(claudeOnly)).toBe(false);
  expect(effectiveOriginFilter('codex', claudeOnly)).toBe('all');
  expect(presentOrigins([])).toEqual([]);
});

test('原有三种来源的安装：只出现这三种，不出现没有数据的 Gemini CLI / Grok / Copilot CLI', () => {
  const old = [p('a', ['claude', 'codex']), p('b', ['cursor'])];
  expect(values(old)).toEqual(['all', 'claude', 'codex', 'cursor']);
  expect(values([p('a', ['claude']), p('b', ['codex'])])).toEqual(['all', 'claude', 'codex']);
});

test('新来源有会话才出现，按 ORIGINS 顺序', () => {
  expect(values([p('a', ['copilot', 'claude']), p('b', ['gemini'])])).toEqual(['all', 'claude', 'gemini', 'copilot']);
  expect(values([p('a', ['doubao', 'claude']), p('b', ['deepseek', 'codex'])])).toEqual(['all', 'claude', 'codex', 'deepseek', 'doubao']);
});

test('记住的来源在这里没有会话时按“全部”算；有会话时照常生效', () => {
  const old = [p('a', ['claude', 'codex'])];
  expect(effectiveOriginFilter('grok', old)).toBe('all');
  expect(effectiveOriginFilter('codex', old)).toBe('codex');
  expect(effectiveOriginFilter('grok', [...old, p('g', ['grok'])])).toBe('grok');
});
