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
  expect([ORIGIN_LOOK.deepseek.label, ORIGIN_LOOK.workbuddy.label, ORIGIN_LOOK.codebuddy.label, ORIGIN_LOOK.doubao.label]).toEqual(['DeepSeek', 'WorkBuddy', 'CodeBuddy', '豆包']);
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

test('来源筛选列出全部十一个来源（加“全部”）', () => {
  expect(ORIGIN_FILTER_OPTIONS.map((o) => o.value)).toEqual(['all', 'claude', 'codex', 'cursor', 'gemini', 'grok', 'copilot', 'deepseek', 'workbuddy', 'codebuddy', 'doubao', 'qwen']);
  for (const origin of ORIGINS) expect(parseOriginFilter(origin)).toBe(origin);
});

/** The value of a CSS custom property declared in :root. */
const token = (name: string): string => {
  const m = new RegExp(`--${name}: (#[0-9a-f]{6});`).exec(css);
  if (m === null) throw new Error(`no --${name}`);
  return m[1]!;
};

test('十个来源的颜色互不相同：系列颜色、徽章底色、边线和文字色各十种；新来源不再是中性占位', () => {
  for (const part of ['series', 'soft', 'edge', 'ink'] as const) {
    const values = ORIGINS.map((o) => token(part === 'series' ? `series-${o}` : `${o}-${part}`));
    expect(new Set(values).size, part).toBe(ORIGINS.length);
  }
  // Task 1's placeholders (the page's own lavender grey and soft ink) are gone.
  for (const origin of ['deepseek', 'workbuddy', 'codebuddy', 'doubao']) {
    expect(token(`series-${origin}`), origin).not.toBe('#7b7694');
    expect(token(`${origin}-soft`), origin).not.toBe('#f5ecff');
    expect(token(`${origin}-ink`), origin).not.toBe('#3f3a5a');
  }
});

test('徽章文字在自己的底色上对比度不低于 4.5:1（十个来源）', () => {
  const lum = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  for (const origin of ORIGINS) expect(contrast(token(`${origin}-ink`), token(`${origin}-soft`)), origin).toBeGreaterThanOrEqual(4.5);
  // Chart marks against the white card: at least 3:1.
  for (const origin of ORIGINS) expect(contrast(token(`series-${origin}`), '#ffffff'), origin).toBeGreaterThanOrEqual(3);
});

test('四个新来源的标志也是圆角方块里的字母（自造，不是厂商标志），十个互不相同', () => {
  for (const origin of ['deepseek', 'workbuddy', 'codebuddy', 'doubao'] as const) {
    const mark = ORIGIN_MARKS[origin];
    expect(mark.fillRule, origin).toBe('evenodd');
    expect(mark.path.startsWith('M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5z'), origin).toBe(true);
  }
  expect(new Set(ORIGINS.map((o) => ORIGIN_MARKS[o].path)).size).toBe(ORIGINS.length);
});
