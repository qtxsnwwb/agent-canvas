import { expect, test } from 'vitest';
import { applyPatchTouches, claudeTouches, codexCallTouches, cursorTouches, fileChangeTouches, mergeFiles, nodeFiles } from '../src/normalize/files.js';

const patch = (...lines: string[]): string => ['*** Begin Patch', ...lines, '*** End Patch', ''].join('\n');

test('nodeFiles: normalized, unique (path, action) in first-seen order, empty paths dropped, {} when nothing', () => {
  expect(
    nodeFiles(
      [
        { path: 'D:\\a\\b.ts', action: 'read' },
        { path: 'd:/a/./b.ts', action: 'read' },
        { path: 'D:/A/B.ts', action: 'read' },
        { path: 'src/c.ts', action: 'edit' },
        { path: '  ', action: 'edit' },
        { path: 'D:/a/b.ts', action: 'edit' },
      ],
      'D:\\proj',
    ),
  ).toEqual({ files: [{ path: 'D:/a/b.ts', action: 'read' }, { path: 'D:/proj/src/c.ts', action: 'edit' }, { path: 'D:/a/b.ts', action: 'edit' }] });
  expect(nodeFiles([], null)).toEqual({});
  expect(nodeFiles([{ path: '', action: 'read' }], null)).toEqual({});
  // POSIX paths keep case: two files.
  expect(nodeFiles([{ path: '/a/B', action: 'read' }, { path: '/a/b', action: 'read' }], null).files).toHaveLength(2);
});

test('nodeFiles: capped at 50 with the truncation flag', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ path: `/w/f${i}.ts`, action: 'edit' as const }));
  const r = nodeFiles(many, null);
  expect(r.files).toHaveLength(50);
  expect(r.files![49]!.path).toBe('/w/f49.ts');
  expect(r.filesTruncated).toBe(true);
  expect(nodeFiles(many.slice(0, 50), null).filesTruncated).toBeUndefined();
});

test('claudeTouches: the tools of the table and their fields; anything else nothing', () => {
  expect(claudeTouches('Read', { file_path: '/a.ts' })).toEqual([{ path: '/a.ts', action: 'read' }]);
  expect(claudeTouches('Edit', { file_path: '/a.ts', old_string: 'x' })).toEqual([{ path: '/a.ts', action: 'edit' }]);
  expect(claudeTouches('MultiEdit', { file_path: '/a.ts', edits: [] })).toEqual([{ path: '/a.ts', action: 'edit' }]);
  expect(claudeTouches('Write', { file_path: '/a.ts', content: '' })).toEqual([{ path: '/a.ts', action: 'write' }]);
  expect(claudeTouches('NotebookEdit', { notebook_path: '/n.ipynb' })).toEqual([{ path: '/n.ipynb', action: 'edit' }]);
  expect(claudeTouches('Bash', { command: 'cat /a.ts' })).toEqual([]);
  expect(claudeTouches('Grep', { pattern: 'x', path: '/w' })).toEqual([]);
  expect(claudeTouches('Glob', { pattern: '*.ts', path: '/w' })).toEqual([]);
  expect(claudeTouches('Read', { file_path: 42 })).toEqual([]);
  expect(claudeTouches('Read', { file_path: '' })).toEqual([]);
  expect(claudeTouches('Read', {})).toEqual([]);
  expect(claudeTouches('Read', 'x')).toEqual([]);
  expect(claudeTouches('Read', null)).toEqual([]);
  expect(claudeTouches('toString', {})).toEqual([]);
});

test('cursorTouches: read_file_v2, edit_file_v2, delete_file; params that did not parse: nothing', () => {
  expect(cursorTouches('read_file_v2', { targetFile: 'D:\\p\\a.ts' })).toEqual([{ path: 'D:\\p\\a.ts', action: 'read' }]);
  expect(cursorTouches('edit_file_v2', { relativeWorkspacePath: 'D:\\p\\a.ts' })).toEqual([{ path: 'D:\\p\\a.ts', action: 'edit' }]);
  expect(cursorTouches('delete_file', { relativeWorkspacePath: 'src/x.ts' })).toEqual([{ path: 'src/x.ts', action: 'delete' }]);
  expect(cursorTouches('edit_file_v2', '{"relativeWorkspacePath":"D:\\\\p\\\\a.ts","cont')).toEqual([]);
  expect(cursorTouches('ripgrep_raw_search', { pattern: 'x', path: 'D:/p' })).toEqual([]);
  expect(cursorTouches('glob_file_search', { globPattern: '*.ts', targetDirectory: 'D:/p' })).toEqual([]);
  expect(cursorTouches('run_terminal_command_v2', { command: 'rm a.ts' })).toEqual([]);
  expect(cursorTouches('read_file_v2', { targetFile: null })).toEqual([]);
  expect(cursorTouches(null, { targetFile: 'a' })).toEqual([]);
});

test('applyPatchTouches: Update / Add / Delete / Move to headers', () => {
  const body = patch(
    '*** Update File: src/a.ts',
    '@@',
    '-old',
    '+new',
    '*** Add File: src/b.ts',
    '+*** Update File: not/a/header.ts',
    '+content',
    '*** Delete File: src/c.ts',
    '*** Update File: src/d.ts',
    '*** Move to: src/e.ts',
    '@@',
    ' *** Update File: context/line.ts',
    '-x',
    '+y',
    '*** End of File',
  );
  expect(applyPatchTouches(body)).toEqual([
    { path: 'src/a.ts', action: 'edit' },
    { path: 'src/b.ts', action: 'write' },
    { path: 'src/c.ts', action: 'delete' },
    { path: 'src/d.ts', action: 'edit' },
    { path: 'src/e.ts', action: 'write' },
  ]);
});

test('applyPatchTouches: embedded in a larger script, CRLF, several bodies; headers outside a body ignored', () => {
  const script = [
    "cd /w && apply_patch <<'EOF'",
    '*** Begin Patch',
    '*** Update File: one.ts',
    '+x',
    '*** End Patch',
    'EOF',
    '*** Update File: outside.ts',
    'apply_patch <<EOF',
    '*** Begin Patch\r',
    '*** Add File: two.ts\r',
    '+y\r',
    '*** End Patch\r',
    'EOF',
  ].join('\n');
  expect(applyPatchTouches(script)).toEqual([
    { path: 'one.ts', action: 'edit' },
    { path: 'two.ts', action: 'write' },
  ]);
  expect(applyPatchTouches('echo "*** Begin Patch"')).toEqual([]);
  expect(applyPatchTouches('no patch here')).toEqual([]);
  expect(applyPatchTouches('')).toEqual([]);
});

test('applyPatchTouches: a cut body keeps only the complete header lines', () => {
  const cut = ['*** Begin Patch', '*** Update File: a.ts', '+x', '*** Add File: b.ts', '+y', '*** Update File: src/par'].join('\n');
  expect(applyPatchTouches(cut)).toEqual([
    { path: 'a.ts', action: 'edit' },
    { path: 'b.ts', action: 'write' },
  ]);
  // Cut right after a complete header line.
  expect(applyPatchTouches('*** Begin Patch\n*** Delete File: z.ts\n')).toEqual([{ path: 'z.ts', action: 'delete' }]);
  // Empty header path: nothing.
  expect(applyPatchTouches(patch('*** Update File: ', '*** Add File:    '))).toEqual([]);
});

test('codexCallTouches: patch bodies in a text input or in any string of parsed arguments', () => {
  expect(codexCallTouches(patch('*** Update File: a.ts'))).toEqual([{ path: 'a.ts', action: 'edit' }]);
  expect(codexCallTouches({ command: ['bash', '-lc', `apply_patch <<'EOF'\n${patch('*** Add File: b.ts')}EOF`], workdir: '/w' })).toEqual([
    { path: 'b.ts', action: 'write' },
  ]);
  expect(codexCallTouches({ input: patch('*** Delete File: c.ts') })).toEqual([{ path: 'c.ts', action: 'delete' }]);
  expect(codexCallTouches({ command: 'cat a.ts && sed -i s/x/y/ b.ts' })).toEqual([]);
  expect(codexCallTouches(null)).toEqual([]);
  expect(codexCallTouches(42)).toEqual([]);
});

test('fileChangeTouches: the keys of changes; add / delete / update kinds; a move destination', () => {
  expect(
    fileChangeTouches({
      type: 'FileChange',
      changes: {
        '/w/a.ts': { type: 'update', unified_diff: '@@', move_path: null },
        '/w/b.ts': { type: 'add', content: 'x' },
        '/w/c.ts': { type: 'delete', content: 'x' },
        '/w/d.ts': { type: 'update', unified_diff: '@@', move_path: '/w/e.ts' },
        '/w/f.ts': { add: { content: 'x' } },
        '/w/g.ts': 'delete',
        '/w/h.ts': { kind: { type: 'add' } },
        '/w/i.ts': {},
        '': { type: 'add' },
      },
    }),
  ).toEqual([
    { path: '/w/a.ts', action: 'edit' },
    { path: '/w/b.ts', action: 'write' },
    { path: '/w/c.ts', action: 'delete' },
    { path: '/w/d.ts', action: 'edit' },
    { path: '/w/e.ts', action: 'write' },
    { path: '/w/f.ts', action: 'write' },
    { path: '/w/g.ts', action: 'delete' },
    { path: '/w/h.ts', action: 'write' },
    { path: '/w/i.ts', action: 'edit' },
  ]);
  expect(fileChangeTouches({ type: 'FileChange' })).toEqual([]);
  expect(fileChangeTouches({ type: 'FileChange', changes: [] })).toEqual([]);
});

test('mergeFiles: same pair once; the more specific action wins for a path both sources name', () => {
  const base = nodeFiles(
    [
      { path: '/w/a.ts', action: 'edit' },
      { path: '/w/b.ts', action: 'write' },
      { path: '/w/c.ts', action: 'edit' },
    ],
    null,
  );
  const other = nodeFiles(
    [
      { path: '/w/a.ts', action: 'edit' },
      { path: '/w/b.ts', action: 'edit' },
      { path: '/w/c.ts', action: 'delete' },
      { path: '/w/d.ts', action: 'edit' },
    ],
    null,
  );
  expect(mergeFiles(base, other)).toEqual({
    files: [
      { path: '/w/a.ts', action: 'edit' },
      { path: '/w/b.ts', action: 'write' },
      { path: '/w/c.ts', action: 'delete' },
      { path: '/w/d.ts', action: 'edit' },
    ],
  });
  expect(mergeFiles({}, {})).toEqual({});
  expect(mergeFiles({}, other)).toEqual(other);
  // Windows paths match case-insensitively.
  expect(mergeFiles(nodeFiles([{ path: 'D:/w/A.ts', action: 'write' }], null), nodeFiles([{ path: 'd:/w/a.ts', action: 'edit' }], null))).toEqual({
    files: [{ path: 'D:/w/A.ts', action: 'write' }],
  });
});

test('mergeFiles: capped at 50, flag set', () => {
  const a = nodeFiles(Array.from({ length: 45 }, (_, i) => ({ path: `/w/a${i}`, action: 'edit' as const })), null);
  const b = nodeFiles(Array.from({ length: 10 }, (_, i) => ({ path: `/w/b${i}`, action: 'edit' as const })), null);
  const m = mergeFiles(a, b);
  expect(m.files).toHaveLength(50);
  expect(m.filesTruncated).toBe(true);
});
