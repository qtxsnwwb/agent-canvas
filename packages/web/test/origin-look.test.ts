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
  expect(ORIGIN_LOOK.qwen.label).toBe('Qwen Code');
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

test('十一个来源的颜色互不相同：系列颜色、徽章底色、边线和文字色各十一种；新来源不再是占位', () => {
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
  // Qwen Code's provisional teal (plan qwen-code, Task 1) is gone: as a chart colour it read as grey to the validator
  // and was within normal-vision reach of Gemini CLI's cyan.
  expect(token('series-qwen')).not.toBe('#2a8f86');
  expect(token('qwen-soft')).not.toBe('#dff1ee');
  expect(token('qwen-ink')).not.toBe('#11615a');
});

/**
 * The computable checks of the dataviz palette validator (scripts/validate_palette.js of the dataviz skill), ported
 * for the chart colours: OKLab distance x100, plain and under Machado 2009 protan / deutan simulation (severity 1.0).
 */
const SIM = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
} as const;
const linear = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
const oklab = ([r, g, b]: number[]): number[] => {
  const l = Math.cbrt(0.4122214708 * r! + 0.5363325363 * g! + 0.0514459929 * b!);
  const m = Math.cbrt(0.2119034982 * r! + 0.6806995451 * g! + 0.1073969566 * b!);
  const s = Math.cbrt(0.0883024619 * r! + 0.2817188376 * g! + 0.6299787005 * b!);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
};
const simulate = (rgb: number[], kind: keyof typeof SIM): number[] => SIM[kind].map((row) => Math.max(0, Math.min(1, row[0] * rgb[0]! + row[1] * rgb[1]! + row[2] * rgb[2]!)));
const deltaE = (a: string, b: string, kind?: keyof typeof SIM): number => {
  const [x, y] = [a, b].map((h) => oklab(kind === undefined ? linear(h) : simulate(linear(h), kind)));
  return 100 * Math.hypot(x![0]! - y![0]!, x![1]! - y![1]!, x![2]! - y![2]!);
};

test('统计图的系列颜色：Qwen Code 的颜色过调色板校验（亮度带、彩度、与相邻的豆包色盲可分、与每个来源正常视力可分）', () => {
  const q = token('series-qwen');
  const [L, a, b] = oklab(linear(q));
  expect(L).toBeGreaterThanOrEqual(0.43);
  expect(L).toBeLessThanOrEqual(0.77);
  expect(Math.hypot(a!, b!)).toBeGreaterThanOrEqual(0.1);
  // Stacking order is ORIGINS order: its neighbour is 豆包. Colour-blind separation at the target (8).
  for (const kind of ['protan', 'deutan'] as const) expect(deltaE(q, token('series-doubao'), kind), kind).toBeGreaterThanOrEqual(8);
  // Normal vision (the validator's hard gate, 15) against every other origin: with origins hidden the stack can put
  // any two next to each other.
  for (const origin of ORIGINS.filter((o) => o !== 'qwen')) expect(deltaE(q, token(`series-${origin}`)), origin).toBeGreaterThanOrEqual(15);
});

test('徽章文字在自己的底色上对比度不低于 4.5:1（十一个来源）', () => {
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

test('后加来源的标志也是圆角方块里的字母（自造，不是厂商标志），十一个互不相同', () => {
  for (const origin of ['deepseek', 'workbuddy', 'codebuddy', 'doubao', 'qwen'] as const) {
    const mark = ORIGIN_MARKS[origin];
    expect(mark.fillRule, origin).toBe('evenodd');
    expect(mark.path.startsWith('M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5z'), origin).toBe(true);
  }
  expect(new Set(ORIGINS.map((o) => ORIGIN_MARKS[o].path)).size).toBe(ORIGINS.length);
});
