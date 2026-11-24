import fs from 'node:fs';
import { expect, test } from 'vitest';

// The header at every width (the layout itself needs a browser; this pins the rules it rests on): the title and the
// links never shrink or wrap; the masking switch's notes give way instead, shortened with an ellipsis, and the switch
// button itself keeps its size.
const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
/** The declarations of the first rule whose selector is exactly `selector`, outside any @media block. */
function baseRule(selector: string): string {
  const top = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const m = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(top);
  return m?.[1] ?? '';
}

test('header: the title and the links keep their width and one line at every width', () => {
  for (const selector of ['header .header-link', 'header a:first-child']) {
    expect(baseRule(selector), selector).toMatch(/flex: none;/);
    expect(baseRule(selector), selector).toMatch(/white-space: nowrap;/);
  }
});

test('header: the masking switch may shrink; its notes end in an ellipsis, its button does not shrink', () => {
  expect(baseRule('.mask-switch')).toMatch(/flex: 0 1 auto;/);
  expect(baseRule('.mask-switch')).toMatch(/min-width: 0;/);
  expect(baseRule('.mask-toggle')).toMatch(/flex: none;/);
  for (const selector of ['.mask-note', '.mask-warn']) {
    expect(baseRule(selector), selector).toMatch(/min-width: 0;/);
    expect(baseRule(selector), selector).toMatch(/overflow: hidden;/);
    expect(baseRule(selector), selector).toMatch(/text-overflow: ellipsis;/);
    expect(baseRule(selector), selector).toMatch(/white-space: nowrap;/);
  }
});

test('header: the session page subtracts the measured header height (a third row on a phone), else --header-h', () => {
  expect(baseRule('.session-page')).toMatch(/height: calc\(100vh - var\(--header-real, var\(--header-h\)\)\);/);
  expect(css).toMatch(/@media \(max-width: 900px\) \{\r?\n {2}:root \{ --header-h: 80px; \}/);
});
