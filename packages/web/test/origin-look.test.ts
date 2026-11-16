import fs from 'node:fs';
import { expect, test } from 'vitest';
import { ORIGINS } from '@agent-canvas/shared';
import { ORIGIN_FILTER_OPTIONS, ORIGIN_LOOK, parseOriginFilter } from '../src/home';
import { ORIGIN_MARKS } from '../src/OriginBadge';

const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test('每个来源都有自己的名字和颜色类（不再用中性占位）', () => {
  const labels = new Set<string>();
  const classes = new Set<string>();
  for (const origin of ORIGINS) {
    const look = ORIGIN_LOOK[origin];
    expect(look.className).toBe(`origin-${origin}`);
    labels.add(look.label);
    classes.add(look.className);
  }
  expect(labels.size).toBe(ORIGINS.length);
  expect(classes.size).toBe(ORIGINS.length);
  expect([ORIGIN_LOOK.gemini.label, ORIGIN_LOOK.grok.label, ORIGIN_LOOK.copilot.label]).toEqual(['Gemini CLI', 'Grok', 'Copilot CLI']);
});

test('样式表给每个来源定义了徽章颜色、筛选按下的颜色和统计图的系列颜色', () => {
  for (const origin of ORIGINS) {
    expect(css, origin).toMatch(new RegExp(`\\.origin-${origin} \\{ --origin-bg: var\\(--${origin}-soft\\); --origin-edge: var\\(--${origin}-edge\\); --origin-fg: var\\(--${origin}-ink\\); \\}`));
    for (const token of ['soft', 'edge', 'ink']) expect(css, `${origin}-${token}`).toMatch(new RegExp(`--${origin}-${token}: #[0-9a-f]{6};`));
    expect(css, `series ${origin}`).toMatch(new RegExp(`--series-${origin}: #[0-9a-f]{6};`));
    expect(css, `filter ${origin}`).toContain(`button[aria-pressed="true"][data-origin="${origin}"] { background: var(--${origin}-soft); color: var(--${origin}-ink); }`);
  }
});

test('新来源的标志：自造的简单图形（圆角方块里一个字母），不是厂商标志', () => {
  for (const origin of ['gemini', 'grok', 'copilot'] as const) {
    const mark = ORIGIN_MARKS[origin];
    expect(mark.viewBox).toBe('0 0 24 24');
    // A rounded square outline (even-odd hole) drawn first: starts with a move and the first arc of the corner.
    expect(mark.path.startsWith('M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5z'), origin).toBe(true);
  }
  expect(new Set(['gemini', 'grok', 'copilot'].map((o) => ORIGIN_MARKS[o as 'gemini'].path)).size).toBe(3);
});

test('来源筛选列出全部六个来源（加“全部”）', () => {
  expect(ORIGIN_FILTER_OPTIONS.map((o) => o.value)).toEqual(['all', 'claude', 'codex', 'cursor', 'gemini', 'grok', 'copilot']);
  for (const origin of ORIGINS) expect(parseOriginFilter(origin)).toBe(origin);
});
