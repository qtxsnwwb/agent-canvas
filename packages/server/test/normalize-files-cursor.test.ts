import { expect, test } from 'vitest';
import type { GraphNode } from '@agent-canvas/shared';
import { CursorNormalizer } from '../src/normalize/cursor.js';
import type { RawEvent } from '../src/store/store.js';
import { interleave, run, type RunResult } from './codex-fixtures.js';
import { CursorConv } from './cursor-records.js';

const ROOT = 'c-root';
const nodeOf = (r: RunResult, id: string): GraphNode => {
  const n = r.graph.nodes[id];
  if (n === undefined) throw new Error(`no node ${id}`);
  return n;
};

test('Cursor: read_file_v2 / edit_file_v2 / delete_file carry files; searches and terminal none', () => {
  const c = new CursorConv({ id: ROOT });
  const r = run(new CursorNormalizer(), [
    c.composer({ cwd: 'D:\\work\\app' }),
    c.user('u1', 'go', 0),
    c.tool('t1', 'read_file_v2', 'completed', 1, { params: { targetFile: 'd:\\work\\app\\src\\a.ts' } }),
    c.tool('t2', 'edit_file_v2', 'completed', 3, { params: { relativeWorkspacePath: 'D:\\work\\app\\src\\a.ts' } }),
    c.tool('t3', 'delete_file', 'completed', 5, { params: { relativeWorkspacePath: 'src/old.ts' } }),
    c.tool('t4', 'ripgrep_raw_search', 'completed', 7, { params: { pattern: 'x', path: 'D:\\work\\app' } }),
    c.tool('t5', 'glob_file_search', 'completed', 9, { params: { globPattern: '*.ts', targetDirectory: 'D:\\work\\app' } }),
    c.tool('t6', 'run_terminal_command_v2', 'completed', 11, { params: { command: 'cat src/a.ts' } }),
    c.tool('t7', 'read_file_v2', 'completed', 13, { params: { targetFile: 12 } }),
  ]);
  expect(nodeOf(r, c.node('t1')).files).toEqual([{ path: 'D:/work/app/src/a.ts', action: 'read' }]);
  expect(nodeOf(r, c.node('t2')).files).toEqual([{ path: 'D:/work/app/src/a.ts', action: 'edit' }]);
  // Relative: resolved against the composer's cwd.
  expect(nodeOf(r, c.node('t3')).files).toEqual([{ path: 'D:/work/app/src/old.ts', action: 'delete' }]);
  for (const id of ['t4', 't5', 't6', 't7', 'u1']) expect(nodeOf(r, c.node(id))).not.toHaveProperty('files');
});

test('Cursor: params cut at the cap (unparsable): the path taken by its key when its value is complete', () => {
  const c = new CursorConv({ id: ROOT });
  const r = run(new CursorNormalizer(), [
    c.composer(),
    c.user('u1', 'go', 0),
    c.tool('t1', 'edit_file_v2', 'completed', 1, { params: '{"relativeWorkspacePath":"/work/app/a.ts","code', over: { truncated: ['params'] } }),
    c.tool('t2', 'edit_file_v2', 'completed', 3, { params: '{"code":"x","relativeWorkspacePath":"/work/app/b', over: { truncated: ['params'] } }),
  ]);
  expect(nodeOf(r, c.node('t1')).files).toEqual([{ path: '/work/app/a.ts', action: 'edit' }]);
  expect(nodeOf(r, c.node('t2'))).not.toHaveProperty('files');
});

test('Cursor: files follow the latest version of a bubble', () => {
  const c = new CursorConv({ id: ROOT });
  const n = new CursorNormalizer();
  const first = run(n, [c.composer(), c.user('u1', 'go', 0), c.tool('t1', 'edit_file_v2', 'loading', 1, { params: '{"relativeWorkspacePath":"/work/app/a.t', over: { truncated: ['params'] } })]);
  expect(nodeOf(first, c.node('t1'))).not.toHaveProperty('files');
  const later = run(n, [c.update('t1', { toolFormerData: { status: 'completed', params: JSON.stringify({ relativeWorkspacePath: '/work/app/a.ts' }) }, truncated: [] })]);
  const patch = later.changes.find((ch) => ch.type === 'node_updated' && ch.id === c.node('t1'));
  expect(patch).toMatchObject({ patch: { files: [{ path: '/work/app/a.ts', action: 'edit' }] } });
  // A later version naming no file clears them with an explicit empty list (never undefined on the wire).
  const gone = run(n, [c.update('t1', { toolFormerData: { params: JSON.stringify({ relativeWorkspacePath: '' }) } })]);
  const cleared = gone.changes.find((ch) => ch.type === 'node_updated' && ch.id === c.node('t1'));
  expect(cleared).toMatchObject({ patch: { files: [] } });
  expect(JSON.parse(JSON.stringify(cleared))).toEqual(cleared);
});

test('Cursor: params parseable, then cut at the cap while the call streams: the file stays', () => {
  const c = new CursorConv({ id: ROOT });
  const n = new CursorNormalizer();
  const v1 = run(n, [
    c.composer({ cwd: 'D:/w' }),
    c.user('u1', 'go', 0),
    c.tool('t1', 'edit_file_v2', 'loading', 1, { params: '{"relativeWorkspacePath":"D:/w/a.ts","contents":"x"}' }),
  ]);
  expect(nodeOf(v1, c.node('t1')).files).toEqual([{ path: 'D:/w/a.ts', action: 'edit' }]);
  const cut = `{"relativeWorkspacePath":"D:/w/a.ts","contents":"${'y'.repeat(200)}`;
  const v2 = run(n, [c.update('t1', { toolFormerData: { status: 'completed', params: cut }, truncated: ['params'] })]);
  for (const ch of v2.changes) if (ch.type === 'node_updated') expect(ch.patch).not.toHaveProperty('files');
  // Rebuild (only the cut version, or both) gives the same node files.
  const fresh = run(new CursorNormalizer(), [c.composer({ cwd: 'D:/w' }), c.user('u1', 'go', 0), c.update('t1', {})]);
  expect(nodeOf(fresh, c.node('t1')).files).toEqual([{ path: 'D:/w/a.ts', action: 'edit' }]);
});

test('Cursor: params cut before the path key: no files', () => {
  const c = new CursorConv({ id: ROOT });
  const r = run(new CursorNormalizer(), [
    c.composer(),
    c.user('u1', 'go', 0),
    c.tool('t1', 'edit_file_v2', 'completed', 1, { params: `{"contents":"${'z'.repeat(100)}`, over: { truncated: ['params'] } }),
  ]);
  expect(nodeOf(r, c.node('t1'))).not.toHaveProperty('files');
});

test('Cursor: a cwd arriving later (composer record) re-resolves relative paths; replay equals live in any order', () => {
  const c = new CursorConv({ id: ROOT });
  const events: RawEvent[] = [
    c.user('u1', 'go', 0),
    c.tool('t1', 'read_file_v2', 'completed', 1, { params: { targetFile: 'src/a.ts' } }),
    c.composer({ cwd: '/work/app' }),
  ];
  const early = run(new CursorNormalizer(), events.slice(0, 2));
  expect(nodeOf(early, c.node('t1')).files).toEqual([{ path: 'src/a.ts', action: 'read' }]);
  const live = new CursorNormalizer();
  for (const ev of events) live.apply(ev, 'p1');
  const all = run(new CursorNormalizer(), events);
  expect(nodeOf(all, c.node('t1')).files).toEqual([{ path: '/work/app/src/a.ts', action: 'read' }]);
  for (const seed of [1, 5, 9]) {
    const r = run(new CursorNormalizer(), interleave([events.slice(0, 2), events.slice(2)], seed));
    expect(r.graph.nodes).toEqual(all.graph.nodes);
  }
  // The checkpointed / memoized derivation equals the reference one.
  const ref = run(new CursorNormalizer({ checkpointEvery: Number.POSITIVE_INFINITY }), events);
  expect(ref.graph.nodes).toEqual(all.graph.nodes);
});

test('Cursor: a record applied twice changes nothing about files', () => {
  const c = new CursorConv({ id: ROOT });
  const n = new CursorNormalizer();
  const rec = c.tool('t1', 'read_file_v2', 'completed', 1, { params: { targetFile: '/work/app/a.ts' } });
  run(n, [c.composer(), c.user('u1', 'go', 0), rec]);
  const again = run(n, [rec]);
  for (const ch of again.changes) if (ch.type === 'node_updated') expect(ch.patch).not.toHaveProperty('files');
});
