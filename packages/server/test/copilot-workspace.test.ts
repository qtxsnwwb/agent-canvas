import { describe, expect, test } from 'vitest';
import { parseWorkspaceYaml } from '../src/sources/copilot/workspace.js';
import { WORKSPACE_YAML } from './copilot-fixtures.js';

describe('parseWorkspaceYaml', () => {
  test('the example: name, summary, cwd; other keys ignored', () => {
    expect(parseWorkspaceYaml(WORKSPACE_YAML)).toEqual({ name: 'Fix README typo', summary: 'Fix the README', cwd: '/home/dev/demo' });
  });

  test('plain, double-quoted and single-quoted values; CRLF; BOM; a comment line', () => {
    expect(parseWorkspaceYaml('name: plain value  \n')).toEqual({ name: 'plain value' });
    expect(parseWorkspaceYaml('\uFEFFname: "quoted: value"\r\ncwd: \'C:\\work\\demo\'\r\n')).toEqual({ name: 'quoted: value', cwd: 'C:\\work\\demo' });
    expect(parseWorkspaceYaml('# a comment\nsummary: s\n')).toEqual({ summary: 's' });
  });

  test('block scalars take the first non-empty indented line', () => {
    expect(parseWorkspaceYaml('name: |\n  First line\n  second line\ncwd: /x\n')).toEqual({ name: 'First line', cwd: '/x' });
    expect(parseWorkspaceYaml('name: >-\n\n    Folded first\n    more\n')).toEqual({ name: 'Folded first' });
    // A block marker with nothing indented after it: no value.
    expect(parseWorkspaceYaml('name: |\ncwd: /x\n')).toEqual({ cwd: '/x' });
  });

  test('a multi-line plain value: its first line only', () => {
    expect(parseWorkspaceYaml('summary: first\n  continued\n')).toEqual({ summary: 'first' });
  });

  test('unknown and nested keys are ignored; an indented name is not top-level', () => {
    expect(parseWorkspaceYaml('repository: octo/demo\nbranch: main\n')).toEqual({});
    expect(parseWorkspaceYaml('meta:\n  name: nested\n  cwd: /nested\nname: top\n')).toEqual({ name: 'top' });
  });

  test('empty values, empty and garbage input → {} (never throws)', () => {
    expect(parseWorkspaceYaml('name:\ncwd: ""\n')).toEqual({});
    expect(parseWorkspaceYaml('')).toEqual({});
    expect(parseWorkspaceYaml('\u0000\u0001 not yaml at all {[')).toEqual({});
    expect(parseWorkspaceYaml('name: "unterminated\n')).toEqual({ name: '"unterminated' });
    expect(parseWorkspaceYaml(undefined as unknown as string)).toEqual({});
  });

  test('the first occurrence of a key wins', () => {
    expect(parseWorkspaceYaml('name: one\nname: two\n')).toEqual({ name: 'one' });
  });
});
