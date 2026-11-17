import { describe, expect, test } from 'vitest';
import { DOUBAO_DEMAND_MAX_BYTES, parseAssignment, stripReminders } from '../src/sources/doubao/assignment.js';
import { assignment, REMINDER, T1, T2, T3 } from './doubao-fixtures.js';

// assignment.md demand sections (format reference A1 "Sibling files"): header regex `^## \[([^\]\r\n]+)\] 需求\r?\n`,
// time = Date.parse of the bracket text, body = up to the next header, trimmed; empty, over 64 KiB or reminder-only
// sections are not demands. Everything before the first header is ignored.

describe('parseAssignment', () => {
  test('several demands: time and text of each, the administrative header ignored', () => {
    const text = assignment([
      { at: T1, text: 'Summarise the reports' },
      { at: T2, text: 'Now chart them\nwith two series' },
    ]);
    expect(parseAssignment(text)).toEqual([
      { at: Date.parse(T1), text: 'Summarise the reports' },
      { at: Date.parse(T2), text: 'Now chart them\nwith two series' },
    ]);
    expect(parseAssignment('# Assignment\n- Role: main\n')).toEqual([]);
    expect(parseAssignment('')).toEqual([]);
  });

  test('CRLF line ends; the header must be a whole line followed by a line break', () => {
    const text = `## [${T1}] 需求\r\nfirst\r\n\r\n## [${T2}] 需求\r\nsecond\r\n`;
    expect(parseAssignment(text)).toEqual([
      { at: Date.parse(T1), text: 'first' },
      { at: Date.parse(T2), text: 'second' },
    ]);
    // Not headers: another level, another word, inline, or a header line not yet ended.
    const not = `## [${T1}] 需求\nbody\n### [${T2}] 需求\nx\n## [${T2}] 任务\ny\ntext ## [${T2}] 需求\nz\n## [${T3}] 需求`;
    expect(parseAssignment(not)).toEqual([{ at: Date.parse(T1), text: `body\n### [${T2}] 需求\nx\n## [${T2}] 任务\ny\ntext ## [${T2}] 需求\nz\n## [${T3}] 需求` }]);
  });

  test('leading reminder blocks are removed from the text; a reminder-only section is not a demand', () => {
    const text = assignment([
      { at: T1, text: `${REMINDER}\n\n${REMINDER}\nDo the thing` },
      { at: T1, text: REMINDER },
      { at: T2, text: `${REMINDER}\n  ${REMINDER}  ` },
      { at: T3, text: 'Later <system-reminder>inline</system-reminder> stays' },
    ]);
    expect(parseAssignment(text)).toEqual([
      { at: Date.parse(T1), text: 'Do the thing' },
      { at: Date.parse(T3), text: 'Later <system-reminder>inline</system-reminder> stays' },
    ]);
    // An unclosed block is not a complete reminder: kept as text.
    expect(parseAssignment(assignment([{ at: T1, text: '<system-reminder>never closed' }]))).toEqual([{ at: Date.parse(T1), text: '<system-reminder>never closed' }]);
  });

  test('a time that does not parse gives at: null (the section is kept)', () => {
    const text = assignment([
      { at: 'yesterday afternoon', text: 'one' },
      { at: T2, text: 'two' },
      { at: '99999999-99-99', text: 'three' },
    ]);
    expect(parseAssignment(text)).toEqual([
      { at: null, text: 'one' },
      { at: Date.parse(T2), text: 'two' },
      { at: null, text: 'three' },
    ]);
  });

  test('an empty body, or a body over 64 KiB, is dropped', () => {
    const big = 'x'.repeat(DOUBAO_DEMAND_MAX_BYTES + 1);
    const justFits = '字'.repeat(Math.floor(DOUBAO_DEMAND_MAX_BYTES / 3));
    const text = assignment([
      { at: T1, text: '' },
      { at: T1, text: '   \n ' },
      { at: T2, text: big },
      { at: T3, text: justFits },
    ]);
    expect(DOUBAO_DEMAND_MAX_BYTES).toBe(64 * 1024);
    expect(parseAssignment(text)).toEqual([{ at: Date.parse(T3), text: justFits }]);
    // Bytes, not characters: 22 000 three-byte characters are over the limit.
    expect(parseAssignment(assignment([{ at: T1, text: '字'.repeat(22_000) }]))).toEqual([]);
  });
});

describe('stripReminders', () => {
  test('only complete leading blocks, whitespace between them', () => {
    expect(stripReminders(`${REMINDER}\nhello`)).toBe('hello');
    expect(stripReminders(` \n${REMINDER}${REMINDER}\n\nhello ${REMINDER}`)).toBe(`hello ${REMINDER}`);
    expect(stripReminders('hello')).toBe('hello');
    expect(stripReminders(REMINDER)).toBe('');
    expect(stripReminders('<system-reminder>open')).toBe('<system-reminder>open');
  });
});
