import { describe, expect, test } from 'vitest';
import { SUMMARY_MAX } from '@agent-canvas/shared';
import { hookErrorText, permissionText } from '../src/attention/explain.js';
import { summarize } from '../src/normalize/summary.js';
import { errorMarkerAt } from '../src/notify/markers.js';

// The summaries are made as the normalizers make them (summarize: JSON of the input, cut at SUMMARY_MAX with `…`).

describe('permissionText: the command or the file path, not the input JSON', () => {
  test('Claude Code Bash', () => {
    const summary = summarize({ command: 'npm publish ./release', description: 'Publish the package' });
    expect(permissionText('Bash', 'Bash', summary)).toBe('Bash · npm publish ./release');
  });

  test('Codex: a command given as an array is joined with spaces', () => {
    expect(permissionText('shell', 'shell', summarize({ command: ['bash', '-lc', 'npm test'], workdir: '/work/app' }))).toBe('shell · bash -lc npm test');
    expect(permissionText('exec_command', 'exec_command', summarize({ cmd: 'git push', yield_time_ms: 1000 }))).toBe('exec_command · git push');
  });

  test('a file-path tool, with a Windows path unescaped', () => {
    const summary = summarize({ file_path: 'C:\\work\\demo\\src\\a.ts', old_string: 'a', new_string: 'b' });
    expect(summary).toContain('C:\\\\work'); // as stored: JSON-escaped
    expect(permissionText('Edit', 'Edit', summary)).toBe('Edit · C:\\work\\demo\\src\\a.ts');
    expect(permissionText('Write', 'Write', summarize({ path: '/work/app/README.md', content: 'x' }))).toBe('Write · /work/app/README.md');
    expect(permissionText('NotebookEdit', 'NotebookEdit', summarize({ notebook_path: '/w/n.ipynb' }))).toBe('NotebookEdit · /w/n.ipynb');
  });

  test('a summary cut at SUMMARY_MAX: the field is still found, cut inside it too', () => {
    const before = summarize({ description: 'd'.repeat(150), command: 'npm publish ./release' });
    expect(before.endsWith('…')).toBe(true);
    expect(() => JSON.parse(before)).toThrow();
    // The command starts before the cut and ends after it: what is there, marked as cut.
    const long = summarize({ command: `echo ${'x'.repeat(300)}`, description: 'long' });
    expect(long).toHaveLength(SUMMARY_MAX);
    const text = permissionText('Bash', 'Bash', long);
    expect(text.startsWith('Bash · echo xxx')).toBe(true);
    expect(text.endsWith('…')).toBe(true);
    expect(text).not.toContain('"');
    // The field complete before the cut.
    const cut = summarize({ command: 'npm publish ./release', description: 'd'.repeat(300) });
    expect(permissionText('Bash', 'Bash', cut)).toBe('Bash · npm publish ./release');
  });

  test('a key inside another string value is not taken; nothing matching keeps the summary', () => {
    const summary = summarize({ description: 'see "command": "rm -rf /"', url: 'https://example.com/a' });
    expect(permissionText('WebFetch', 'WebFetch', summary)).toBe('WebFetch · https://example.com/a');
    expect(permissionText('Task', 'Task', summarize({ subagent_type: 'Explore', prompt: 'look' }))).toBe(`Task · ${summarize({ subagent_type: 'Explore', prompt: 'look' })}`);
    // The same in a cut summary: a quoted key inside a string is escaped there and skipped.
    const cut = summarize({ description: `see "command": "rm -rf /" ${'d'.repeat(200)}`, url: 'https://example.com/a' });
    expect(cut.endsWith('…')).toBe(true);
    expect(permissionText('WebFetch', 'WebFetch', cut)).toBe(`WebFetch · ${cut}`);
    expect(permissionText('Bash', 'Bash', 'not json at all')).toBe('Bash · not json at all');
    expect(permissionText(null, 'run_shell', '')).toBe('run_shell');
  });
});

describe('hookErrorText: a short reason, never payload content beyond a short error token', () => {
  test('Claude Code StopFailure: the error token when there is one', () => {
    expect(hookErrorText('claude', 'StopFailure', { error: 'rate_limit' })).toBe('接口报错（rate_limit）');
    expect(hookErrorText('claude', 'StopFailure', {})).toBe('接口报错');
    // Not a token (long, spaces, not a string): left out.
    expect(hookErrorText('claude', 'StopFailure', { error: 'the server said: secret project text' })).toBe('接口报错');
    expect(hookErrorText('claude', 'StopFailure', { error: 'x'.repeat(41) })).toBe('接口报错');
    expect(hookErrorText('claude', 'StopFailure', { error: { type: 'overloaded' } })).toBe('接口报错');
    expect(hookErrorText('claude', 'StopFailure', null)).toBe('接口报错');
  });

  test('Codex Interrupt', () => {
    expect(hookErrorText('codex', 'Interrupt', {})).toBe('被中断');
  });

  test('Cursor stop: aborted / error', () => {
    expect(hookErrorText('cursor', 'stop', { status: 'aborted' })).toBe('对话被中止');
    expect(hookErrorText('cursor', 'stop', { status: 'error' })).toBe('出错');
  });
});

describe('errorMarkerAt (notify/markers.ts, shared with the notification engine)', () => {
  const at = (over: object) => errorMarkerAt({ kind: 'tool', systemSubtype: null, timestamp: 'T', endedAt: null, ...over });
  test('an interrupt node from its own time; an aborted call from its end, else its start', () => {
    expect(at({ kind: 'system', systemSubtype: 'interrupt', endedAt: 'E' })).toBe('T');
    expect(at({ endedAt: 'E' })).toBe('E');
    expect(at({})).toBe('T');
  });
});
