import { expect, test } from 'vitest';
import type { GraphNode } from '@agent-canvas/shared';
import { CodexNormalizer } from '../src/normalize/codex.js';
import { CodexThread, interleave, run, type RunResult } from './codex-fixtures.js';

const patch = (...lines: string[]): string => ['*** Begin Patch', ...lines, '*** End Patch', ''].join('\n');
const heredoc = (body: string): string => `cd /work/app\napply_patch <<'EOF'\n${body}EOF\n`;
const node = (r: RunResult, id: string): GraphNode => {
  const found = r.graph.nodes[id];
  if (!found) throw new Error(`no node ${id}`);
  return found;
};
const fileChange = (t: CodexThread, id: string, changes: Record<string, unknown>) => t.item({ type: 'FileChange', id, changes, status: 'completed' });

test('Codex: apply_patch in an exec script names files, relative paths resolved against the thread cwd', () => {
  const root = new CodexThread({ id: 'cx1', cwd: 'D:\\work\\app' });
  const r = run(new CodexNormalizer(), [
    root.meta(),
    root.started('t1'),
    root.user('u1', 'x'),
    root.exec('c1', heredoc(patch('*** Update File: src/a.ts', '@@', '-a', '+b', '*** Add File: src/new.ts', '+x', '*** Delete File: D:\\work\\app\\old.ts', '*** Update File: src/m.ts', '*** Move to: src/n.ts'))),
    root.output('c1'),
    root.exec('c2', 'cat src/a.ts && sed -i s/a/b/ src/a.ts'),
    root.output('c2'),
    root.complete(),
  ]);
  expect(node(r, 'tool:c1').files).toEqual([
    { path: 'D:/work/app/src/a.ts', action: 'edit' },
    { path: 'D:/work/app/src/new.ts', action: 'write' },
    { path: 'D:/work/app/old.ts', action: 'delete' },
    { path: 'D:/work/app/src/m.ts', action: 'edit' },
    { path: 'D:/work/app/src/n.ts', action: 'write' },
  ]);
  expect(node(r, 'tool:c2')).not.toHaveProperty('files');
});

test('Codex: a function_call whose arguments carry a patch body', () => {
  const root = new CodexThread({ id: 'cx2', cwd: '/work/app' });
  const r = run(new CodexNormalizer(), [
    root.meta(),
    root.started('t1'),
    root.call('c1', 'shell', { command: ['bash', '-lc', heredoc(patch('*** Update File: a.ts'))], workdir: '/work/app' }),
    root.output('c1', 'ok', 'function'),
    root.complete(),
  ]);
  expect(node(r, 'tool:c1').files).toEqual([{ path: '/work/app/a.ts', action: 'edit' }]);
});

test('Codex: apply_patch and the FileChange of the same call are merged without double counting', () => {
  const root = new CodexThread({ id: 'cx3', cwd: '/work/app' });
  const r = run(new CodexNormalizer(), [
    root.meta(),
    root.started('t1'),
    root.exec('c1', heredoc(patch('*** Update File: a.ts', '*** Update File: b.ts', '*** Update File: a.ts'))),
    fileChange(root, 'fc1', {
      '/work/app/a.ts': { type: 'update', unified_diff: '@@' },
      '/work/app/b.ts': { type: 'add', content: 'x' },
      '/work/app/c.ts': { type: 'update', unified_diff: '@@' },
    }),
    root.output('c1'),
    root.complete(),
  ]);
  expect(node(r, 'tool:c1').files).toEqual([
    { path: '/work/app/a.ts', action: 'edit' },
    { path: '/work/app/b.ts', action: 'write' },
    { path: '/work/app/c.ts', action: 'edit' },
  ]);
});

test('Codex: the more specific action of the patch is kept over a FileChange edit', () => {
  const root = new CodexThread({ id: 'cx4', cwd: '/work/app' });
  const r = run(new CodexNormalizer(), [
    root.meta(),
    root.started('t1'),
    root.exec('c1', heredoc(patch('*** Add File: a.ts', '+x', '*** Delete File: b.ts'))),
    fileChange(root, 'fc1', { '/work/app/a.ts': { type: 'update' }, '/work/app/b.ts': { type: 'update' } }),
    root.output('c1'),
  ]);
  expect(node(r, 'tool:c1').files).toEqual([
    { path: '/work/app/a.ts', action: 'write' },
    { path: '/work/app/b.ts', action: 'delete' },
  ]);
});

test('Codex: a FileChange with no call it ran in is its own node with files', () => {
  const root = new CodexThread({ id: 'cx5', cwd: '/work/app' });
  const r = run(new CodexNormalizer(), [
    root.meta(),
    root.started('t1'),
    fileChange(root, 'fc1', { 'src/x.ts': { type: 'delete' } }),
    root.complete(),
  ]);
  expect(node(r, 'item:fc1').files).toEqual([{ path: '/work/app/src/x.ts', action: 'delete' }]);
});

test('Codex: a FileChange record applied twice changes nothing', () => {
  const root = new CodexThread({ id: 'cx6', cwd: '/work/app' });
  const n = new CodexNormalizer();
  const head = [root.meta(), root.started('t1'), root.exec('c1', heredoc(patch('*** Update File: a.ts')))];
  const fc = fileChange(root, 'fc1', { '/work/app/z.ts': { type: 'update' } });
  const first = run(n, [...head, fc]);
  const files = node(first, 'tool:c1').files;
  expect(files).toEqual([{ path: '/work/app/a.ts', action: 'edit' }, { path: '/work/app/z.ts', action: 'edit' }]);
  const again = n.apply(fc, 'p1');
  for (const c of again.changes) if (c.type === 'node_updated') expect(c.patch).not.toHaveProperty('files');
});

test('Codex: a cut patch body keeps the complete header lines; no body, no files', () => {
  const root = new CodexThread({ id: 'cx7', cwd: '/work/app' });
  const r = run(new CodexNormalizer(), [
    root.meta(),
    root.started('t1'),
    root.exec('c1', '*** Begin Patch\n*** Update File: a.ts\n+x\n*** Add File: b.t'),
    root.exec('c2', '*** Begin Patch\n*** Update File: '),
    root.complete(),
  ]);
  expect(node(r, 'tool:c1').files).toEqual([{ path: '/work/app/a.ts', action: 'edit' }]);
  expect(node(r, 'tool:c2')).not.toHaveProperty('files');
});

test('Codex: more than 50 files in one call are capped and flagged', () => {
  const root = new CodexThread({ id: 'cx8', cwd: '/work/app' });
  const lines = Array.from({ length: 55 }, (_, i) => `*** Update File: f${i}.ts`);
  const r = run(new CodexNormalizer(), [root.meta(), root.started('t1'), root.exec('c1', patch(...lines))]);
  expect(node(r, 'tool:c1').files).toHaveLength(50);
  expect(node(r, 'tool:c1').filesTruncated).toBe(true);
});

test('Codex: a subagent thread resolves against its own cwd; the order threads are read in does not matter', () => {
  const root = new CodexThread({ id: 'cx9', cwd: '/work/app' });
  const sub = new CodexThread({ id: 'cx9s', sessionId: 'cx9', parent: 'cx9', cwd: '/work/wt', nickname: 'n', agentPath: 'root/n' });
  const a = [root.meta(), root.started('t1'), root.exec('c1', patch('*** Update File: a.ts')), root.output('c1'), root.complete()];
  const b = [sub.meta(), sub.started('ts'), sub.exec('s1', patch('*** Add File: b.ts', '+x')), fileChange(sub, 'sfc', { '/work/wt/b.ts': { type: 'add' } }), sub.output('s1'), sub.complete()];
  const base = run(new CodexNormalizer(), [...a, ...b]);
  expect(node(base, 'tool:c1').files).toEqual([{ path: '/work/app/a.ts', action: 'edit' }]);
  expect(node(base, 'tool:s1').files).toEqual([{ path: '/work/wt/b.ts', action: 'write' }]);
  for (const seed of [1, 7, 42]) {
    const r = run(new CodexNormalizer(), interleave([a, b], seed));
    expect(node(r, 'tool:c1').files).toEqual(node(base, 'tool:c1').files);
    expect(node(r, 'tool:s1').files).toEqual(node(base, 'tool:s1').files);
  }
});
