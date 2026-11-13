import { describe, expect, test } from 'vitest';
import type { GraphNode, NodeDetail } from '@agent-canvas/shared';
import {
  INDEX_OUTPUT_BYTES,
  INDEX_TEXT_MAX_BYTES,
  contentQuery,
  cutSnippet,
  ftsMatchExpression,
  indexTextOf,
} from '../src/store/search-index.js';

type N = Pick<GraphNode, 'kind' | 'title' | 'summary' | 'toolName'>;
const node = (kind: GraphNode['kind'], over: Partial<N> = {}): N => ({ kind, title: 'T', summary: '', toolName: null, ...over });
const utf8 = (s: string): number => Buffer.byteLength(s, 'utf8');

describe('indexTextOf', () => {
  test('prompt, text, thinking: the full text (Claude, Codex, Cursor store it in detail.text)', () => {
    const long = 'x'.repeat(500) + ' needle';
    expect(indexTextOf(node('prompt', { summary: 'cut…' }), { text: long })).toBe(long);
    expect(indexTextOf(node('text'), { text: 'reply body', raw: { phase: 'final' } })).toBe('reply body'); // Codex
    expect(indexTextOf(node('thinking'), { input: null, output: null, text: 'thought', raw: null })).toBe('thought'); // Cursor
    // no text in the detail (or none stored): the summary
    expect(indexTextOf(node('prompt', { summary: 'from summary' }), {})).toBe('from summary');
    expect(indexTextOf(node('text', { summary: 'from summary' }), null)).toBe('from summary');
    expect(indexTextOf(node('thinking'), { text: '' })).toBe('');
  });

  test('tool: tool name, title when different, input values, output values (Claude)', () => {
    const text = indexTextOf(node('tool', { title: 'Bash', toolName: 'Bash', summary: 'git status' }), {
      input: { command: 'git status --short', description: 'Show status' },
      output: [{ type: 'text', text: 'M src/a.ts' }],
    });
    // `type` values (content block types) are not indexed
    expect(text.split('\n')).toEqual(['Bash', 'git status --short', 'Show status', 'M src/a.ts']);
  });

  test('tool: Cursor (title is the MCP tool part, params JSON parsed by the normalizer, note text ignored)', () => {
    const text = indexTextOf(node('tool', { title: 'get_page', toolName: 'mcp-browser-get_page' }), {
      input: { url: 'https://example.test/a' },
      output: { contents: 'Page body' },
      text: 'aborted note',
      raw: { status: 'completed', toolCallId: 'c1', truncated: [] },
    });
    expect(text.split('\n')).toEqual(['mcp-browser-get_page', 'get_page', 'https://example.test/a', 'Page body']);
  });

  test('tool: Codex (string input kept verbatim; JSON text input flattened; item steps without input use the summary)', () => {
    expect(indexTextOf(node('tool', { title: 'apply_patch', toolName: 'apply_patch' }), { input: '*** Begin Patch\n+x', output: 'Done' })).toBe(
      'apply_patch\n*** Begin Patch\n+x\nDone',
    );
    expect(indexTextOf(node('tool', { title: 'shell', toolName: 'shell' }), { input: '{"cmd":["rg","-n","needle"]}' })).toBe('shell\nrg\n-n\nneedle');
    expect(indexTextOf(node('tool', { title: 'WebSearch', toolName: 'WebSearch', summary: 'query text' }), { raw: { items: [] } })).toBe(
      'WebSearch\nquery text',
    );
  });

  test('subagent: name, agent type, input (the task prompt), output', () => {
    const text = indexTextOf(node('subagent', { title: 'Explore', toolName: 'Task' }), {
      input: { description: 'find it', prompt: 'Look for the parser', subagent_type: 'Explore' },
      output: 'found in a.ts',
    });
    expect(text.split('\n')).toEqual(['Task', 'Explore', 'find it', 'Look for the parser', 'Explore', 'found in a.ts']);
  });

  test('system: the full text when the detail has one, else the summary; unknown: nothing', () => {
    expect(indexTextOf(node('system', { title: 'Interrupted', summary: 'short' }), { text: 'Turn failed: full error message' })).toBe(
      'Turn failed: full error message',
    );
    expect(indexTextOf(node('system', { title: 'Compact', summary: '' }), { raw: { type: 'summary' } })).toBe('');
    expect(indexTextOf(node('system', { summary: 'notice summary' }), {})).toBe('notice summary');
    expect(indexTextOf(node('unknown', { summary: 'malformed' }), { raw: {} })).toBe('');
  });

  test('output: only its first 8 KB (UTF-8 bytes, cut on a character boundary)', () => {
    const output = '中'.repeat(4000) + 'TAIL'; // 12,000 bytes
    const text = indexTextOf(node('tool', { toolName: 'Read', title: 'Read' }), { input: { file_path: '/a' }, output });
    const out = text.split('\n')[2]!;
    expect(utf8(out)).toBeLessThanOrEqual(INDEX_OUTPUT_BYTES);
    expect(utf8(out)).toBeGreaterThan(INDEX_OUTPUT_BYTES - 3);
    expect(out).not.toContain('TAIL');
    expect(out.endsWith('中')).toBe(true);
    // a surrogate pair is never split
    const emoji = indexTextOf(node('tool', { toolName: 'X', title: 'X' }), { output: 'a' + '😀'.repeat(3000) });
    expect(emoji.split('\n')[1]!.endsWith('😀')).toBe(true);
    // output spread over several values: the budget covers them together
    const parts = indexTextOf(node('tool', { toolName: 'X', title: 'X' }), { output: ['a'.repeat(6000), 'b'.repeat(6000), 'c'] });
    expect(utf8(parts)).toBeLessThanOrEqual(2 + INDEX_OUTPUT_BYTES);
    expect(parts).not.toContain('c');
  });

  test('whole text capped at 64 KB; base64 image data skipped', () => {
    const text = indexTextOf(node('prompt'), { text: 'é'.repeat(40_000) });
    expect(utf8(text)).toBeLessThanOrEqual(INDEX_TEXT_MAX_BYTES);
    expect(utf8(text)).toBeGreaterThan(INDEX_TEXT_MAX_BYTES - 2);
    const big = indexTextOf(node('tool', { toolName: 'Write', title: 'Write' }), { input: { content: 'w'.repeat(200_000) } });
    expect(utf8(big)).toBeLessThanOrEqual(INDEX_TEXT_MAX_BYTES);
    const img = indexTextOf(node('tool', { toolName: 'Read', title: 'Read' }), {
      output: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo'.repeat(200) } }],
    });
    expect(img).not.toContain('iVBORw0KGgo');
    expect(img).toContain('image/png');
  });

  test('booleans and nulls are not indexed; numbers are', () => {
    expect(indexTextOf(node('tool', { toolName: 'Bash', title: 'Bash' }), { input: { command: 'ls', timeout: 5000, background: false, x: null } })).toBe(
      'Bash\nls\n5000',
    );
  });
});

describe('contentQuery', () => {
  test('trim, cap at 200 code points, mode by code points', () => {
    expect(contentQuery('  a ')).toEqual({ text: 'a', mode: 'none' });
    expect(contentQuery('')).toEqual({ text: '', mode: 'none' });
    expect(contentQuery(' ab ')).toEqual({ text: 'ab', mode: 'short' });
    expect(contentQuery('中文')).toEqual({ text: '中文', mode: 'short' });
    expect(contentQuery('😀😀')).toEqual({ text: '😀😀', mode: 'short' }); // 4 UTF-16 units, 2 code points
    expect(contentQuery('a😀')).toEqual({ text: 'a😀', mode: 'short' });
    expect(contentQuery('😀')).toEqual({ text: '😀', mode: 'none' });
    expect(contentQuery('abc').mode).toBe('index');
    expect(contentQuery('中文字').mode).toBe('index');
    expect(contentQuery('😀😀😀').mode).toBe('index');
    const long = contentQuery('x'.repeat(150) + '😀'.repeat(100));
    expect(Array.from(long.text)).toHaveLength(200);
    expect(long.text.endsWith('😀')).toBe(true);
  });
});

describe('ftsMatchExpression', () => {
  test('every part quoted with quotes doubled: user text is never FTS syntax', () => {
    for (const detail of ['full', 'column', 'none'] as const) {
      for (const q of ['a"b"c', 'x*y', '(a)', 'a:b', '-abc', '^abc', 'a AND b', 'OR NOT', 'NEAR(a b)', '%_\\']) {
        const expr = ftsMatchExpression(q, detail)!;
        expect(expr, q).not.toBeNull();
        // the expression is a sequence of quoted strings joined by AND
        expect(expr.replace(/"(?:[^"]|"")*"/g, '').replace(/ AND /g, ''), `${detail} ${q}`).toBe('');
      }
    }
  });

  test('full: one phrase per NUL-free run of 3+ code points; none/column: its distinct trigrams', () => {
    expect(ftsMatchExpression('hello', 'full')).toBe('"hello"');
    expect(ftsMatchExpression('say "hi"', 'full')).toBe('"say ""hi"""');
    expect(ftsMatchExpression('abcd', 'none')).toBe('"abc" AND "bcd"');
    expect(ftsMatchExpression('aaaa', 'column')).toBe('"aaa"');
    expect(ftsMatchExpression('😀😀😀😀', 'none')).toBe('"😀😀😀"');
    expect(ftsMatchExpression('abc\u0000de\u0000fgh', 'full')).toBe('"abc" AND "fgh"');
    expect(ftsMatchExpression('ab\u0000cd', 'full')).toBeNull();
    expect(ftsMatchExpression('ab\u0000cd', 'none')).toBeNull();
  });
});

describe('cutSnippet', () => {
  test('about 40 code points each side, whitespace collapsed, flags at clipped ends', () => {
    const text = `${'a'.repeat(100)} \n\t needle   ${'b'.repeat(100)}`;
    const at = text.indexOf('needle');
    const s = cutSnippet(text, at, 'needle'.length);
    expect(s.match).toBe('needle');
    expect(s.before).toBe(`${'a'.repeat(39)} `);
    expect(s.after).toBe(` ${'b'.repeat(39)}`);
    expect(s.clippedStart).toBe(true);
    expect(s.clippedEnd).toBe(true);
  });

  test('short text: nothing clipped; leading/trailing whitespace dropped', () => {
    const s = cutSnippet('  say NEEDLE now \n', 6, 6);
    expect(s).toEqual({ before: 'say ', match: 'NEEDLE', after: ' now', clippedStart: false, clippedEnd: false });
  });

  test('never splits a surrogate pair; CJK counted per code point', () => {
    const text = '😀'.repeat(60) + '中文检索' + '😀'.repeat(60);
    const at = text.indexOf('中文检索');
    const s = cutSnippet(text, at, '中文检索'.length);
    expect(Array.from(s.before)).toHaveLength(40);
    expect(s.before).toBe('😀'.repeat(40));
    expect(s.after).toBe('😀'.repeat(40));
    expect(s.match).toBe('中文检索');
  });

  test('a match containing whitespace runs is collapsed too; a very long match is cut', () => {
    expect(cutSnippet('x a \n\n b y', 2, 6).match).toBe('a b');
    const long = cutSnippet('q'.repeat(300), 0, 300);
    expect(Array.from(long.match).length).toBeLessThanOrEqual(200);
    expect(long.clippedEnd).toBe(true);
  });
});
