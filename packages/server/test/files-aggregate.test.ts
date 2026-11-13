import { describe, expect, test } from 'vitest';
import { FILE_SESSIONS_MAX, type FileTouch, type GraphNode, type Session } from '@agent-canvas/shared';
import { aggregateProjectFiles, rangeStartMs, type ProjectFilesInput } from '../src/files/aggregate.js';
import { summarizeSessionFiles } from '../src/files/summary.js';

const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const DAY = 24 * 3600_000;
const iso = (ms: number): string => new Date(ms).toISOString();

function session(id: string, o: Partial<Session> = {}): Session {
  return {
    id, projectId: 'p1', origin: 'claude', cwd: 'D:\\w\\shop', title: `title ${id}`, gitBranch: null, status: 'idle',
    sourceDeleted: false, startedAt: iso(NOW), lastActivityAt: iso(NOW), ...o,
  };
}
let n = 0;
function tool(sessionId: string, ms: number, files: FileTouch[], o: Partial<GraphNode> = {}): GraphNode {
  return {
    id: `node${n++}`, sessionId, turnId: 'T', agentId: null, parentId: null, kind: 'tool', status: 'succeeded',
    timestamp: iso(ms), confirmed: true, title: 'Edit', summary: 'SECRET', toolName: 'Edit', toolUseId: null,
    messageId: null, durationMs: null, usage: null, systemSubtype: null, childAgentId: null, endedAt: null, files, ...o,
  };
}
const read = (path: string): FileTouch => ({ path, action: 'read' });
const edit = (path: string): FileTouch => ({ path, action: 'edit' });
const write = (path: string): FileTouch => ({ path, action: 'write' });
const del = (path: string): FileTouch => ({ path, action: 'delete' });

type Spec = [Session, Array<[number, FileTouch[], Partial<GraphNode>?]>];
function entries(specs: Spec[]): ProjectFilesInput['entries'] {
  return specs.map(([s, touches]) => ({
    session: s,
    summary: summarizeSessionFiles(s, touches.map(([ms, files, o]) => tool(s.id, ms, files, o))),
  }));
}
function run(specs: Spec[], o: Partial<ProjectFilesInput> = {}) {
  return aggregateProjectFiles({
    entries: entries(specs), projects: [{ id: 'p1', cwd: 'D:\\w\\shop' }], projectId: 'p1', origin: null, fromMs: null,
    changedOnly: false, q: null, sort: 'recent', limit: 200, failedSessions: 0, importing: false, ...o,
  });
}

describe('rangeStartMs', () => {
  test('all: null; 7d / 30d: local midnight 6 / 29 days before today', () => {
    expect(rangeStartMs('all', NOW)).toBeNull();
    const d = new Date(NOW);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - 6);
    expect(rangeStartMs('7d', NOW)).toBe(d.getTime());
    const e = new Date(NOW);
    e.setHours(0, 0, 0, 0);
    e.setDate(e.getDate() - 29);
    expect(rangeStartMs('30d', NOW)).toBe(e.getTime());
  });
});

describe('aggregateProjectFiles', () => {
  test('one file across sessions: counts summed, session count, last touch and its origin, per-session rows', () => {
    const r = run([
      [session('a'), [[NOW - 5000, [read('D:/w/shop/x.ts')]], [NOW - 4000, [edit('D:/w/shop/x.ts')]]]],
      [session('b', { origin: 'cursor' }), [[NOW - 1000, [edit('d:/W/shop/X.ts'), write('D:/w/shop/x.ts')]]]],
    ]);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]).toEqual({
      path: 'D:/w/shop/x.ts', relativePath: 'x.ts', sessionCount: 2, reads: 1, changes: 3, created: true, deleted: false,
      lastAt: iso(NOW - 1000), lastOrigin: 'cursor', sessionsTruncated: false, failed: 0,
      sessions: [
        { sessionId: 'b', origin: 'cursor', title: 'title b', reads: 0, changes: 2, failed: 0, lastAt: iso(NOW - 1000) },
        { sessionId: 'a', origin: 'claude', title: 'title a', reads: 1, changes: 1, failed: 0, lastAt: iso(NOW - 4000) },
      ],
    });
    expect(r).toMatchObject({ projectId: 'p1', projectName: 'shop', projectDir: 'D:\\w\\shop', totalFiles: 1, truncated: false });
  });

  test('project membership: by the touching session\'s project; a file touched from two projects appears under each', () => {
    const specs: Spec[] = [
      [session('a'), [[NOW - 1000, [edit('D:/shared/lib.ts')]]]],
      [session('b', { projectId: 'p2', cwd: 'D:\\w\\other' }), [[NOW - 1000, [edit('D:/shared/lib.ts')], {}], [NOW, [edit('D:/w/other/o.ts')]]]],
    ];
    expect(run(specs).files.map((f) => f.path)).toEqual(['D:/shared/lib.ts']);
    const p2 = run(specs, { projectId: 'p2', projects: [{ id: 'p2', cwd: 'D:\\w\\other' }] });
    expect(p2.files.map((f) => f.relativePath).sort()).toEqual(['D:/shared/lib.ts', 'o.ts']);
  });

  test('unknown project: empty, named after its id', () => {
    const r = run([[session('a'), [[NOW, [edit('D:/w/shop/x.ts')]]]]], { projectId: 'nope' });
    expect(r).toMatchObject({ projectId: 'nope', projectName: 'nope', projectDir: null, files: [], totalFiles: 0, truncated: false });
  });

  test('origin filter', () => {
    const specs: Spec[] = [
      [session('a'), [[NOW, [edit('D:/w/shop/a.ts')]]]],
      [session('b', { origin: 'codex' }), [[NOW, [edit('D:/w/shop/b.ts')]]]],
    ];
    expect(run(specs, { origin: 'codex' }).files.map((f) => f.relativePath)).toEqual(['b.ts']);
  });

  test('range: a file is in when it has a touch in range; counts are of touches in range; undated only in all', () => {
    const from = rangeStartMs('7d', NOW)!;
    const specs: Spec[] = [
      [session('a'), [
        [from - DAY, [edit('D:/w/shop/old.ts'), edit('D:/w/shop/mixed.ts')]],
        [from + 1000, [read('D:/w/shop/mixed.ts')]],
        [0, [edit('D:/w/shop/undated.ts')], { timestamp: 'garbage' }],
      ]],
    ];
    const r7 = run(specs, { fromMs: from });
    expect(r7.files.map((f) => f.relativePath)).toEqual(['mixed.ts']);
    expect(r7.files[0]).toMatchObject({ reads: 1, changes: 0, lastAt: iso(from + 1000) });
    expect(r7.files[0]!.sessions[0]).toMatchObject({ reads: 1, changes: 0 });
    const all = run(specs);
    expect(all.files.map((f) => f.relativePath).sort()).toEqual(['mixed.ts', 'old.ts', 'undated.ts']);
    expect(all.files.find((f) => f.relativePath === 'undated.ts')).toMatchObject({ changes: 1, lastAt: null, lastOrigin: null });
  });

  test('created / deleted flags are of touches in range', () => {
    const from = rangeStartMs('7d', NOW)!;
    const specs: Spec[] = [[session('a'), [[from - DAY, [write('D:/w/shop/a.ts')]], [from + 1, [del('D:/w/shop/a.ts')]]]]];
    expect(run(specs, { fromMs: from }).files[0]).toMatchObject({ created: false, deleted: true, changes: 1 });
    expect(run(specs).files[0]).toMatchObject({ created: true, deleted: true, changes: 2 });
  });

  test('changedOnly drops files only read (in range)', () => {
    const specs: Spec[] = [[session('a'), [[NOW, [read('D:/w/shop/r.ts'), edit('D:/w/shop/e.ts')]]]]];
    expect(run(specs, { changedOnly: true }).files.map((f) => f.relativePath)).toEqual(['e.ts']);
    expect(run(specs).files).toHaveLength(2);
  });

  test('q: case-insensitive substring of the relative path, either separator, trimmed', () => {
    const specs: Spec[] = [[session('a'), [[NOW, [edit('D:/w/shop/src/Cart.ts'), edit('D:/w/shop/lib/x.ts')]]]]];
    expect(run(specs, { q: 'cart' }).files.map((f) => f.relativePath)).toEqual(['src/Cart.ts']);
    expect(run(specs, { q: 'SRC\\CA' }).files.map((f) => f.relativePath)).toEqual(['src/Cart.ts']);
    expect(run(specs, { q: 'nothing' }).files).toEqual([]);
    // what is shown: the project directory is not part of it; surrounding spaces are ignored
    expect(run(specs, { q: 'shop' }).files).toEqual([]);
    expect(run(specs, { q: '  cart ' }).files.map((f) => f.relativePath)).toEqual(['src/Cart.ts']);
    expect(run(specs, { q: '   ' }).files).toHaveLength(2);
  });

  test('sort: recent (default), changes, path', () => {
    const specs: Spec[] = [[session('a'), [
      [NOW - 3000, [edit('D:/w/shop/b.ts')]],
      [NOW - 2000, [edit('D:/w/shop/b.ts')]],
      [NOW - 1000, [edit('D:/w/shop/C.ts')]],
      [NOW - 5000, [read('D:/w/shop/a.ts')]],
    ]]];
    expect(run(specs).files.map((f) => f.relativePath)).toEqual(['C.ts', 'b.ts', 'a.ts']);
    expect(run(specs, { sort: 'changes' }).files.map((f) => f.relativePath)).toEqual(['b.ts', 'C.ts', 'a.ts']);
    expect(run(specs, { sort: 'path' }).files.map((f) => f.relativePath)).toEqual(['a.ts', 'b.ts', 'C.ts']);
  });

  test('limit: at most `limit` files; totalFiles counts all matches; truncated', () => {
    const touches: Spec[1] = Array.from({ length: 5 }, (_, i) => [NOW - i * 1000, [edit(`D:/w/shop/f${i}.ts`)]] as [number, FileTouch[]]);
    const r = run([[session('a'), touches]], { limit: 3 });
    expect(r.files.map((f) => f.relativePath)).toEqual(['f0.ts', 'f1.ts', 'f2.ts']);
    expect(r).toMatchObject({ totalFiles: 5, truncated: true });
  });

  test('sessions per file: at most FILE_SESSIONS_MAX, most recent first, flag; sessionCount complete', () => {
    const specs: Spec[] = Array.from({ length: FILE_SESSIONS_MAX + 2 }, (_, i): Spec => [
      session(`s${String(i).padStart(3, '0')}`), [[NOW - i * 1000, [edit('D:/w/shop/hot.ts')]]],
    ]);
    const f = run(specs).files[0]!;
    expect(f.sessionCount).toBe(FILE_SESSIONS_MAX + 2);
    expect(f.sessions).toHaveLength(FILE_SESSIONS_MAX);
    expect(f.sessionsTruncated).toBe(true);
    expect(f.sessions[0]!.sessionId).toBe('s000');
    expect(f.changes).toBe(FILE_SESSIONS_MAX + 2);
  });

  test('Windows paths group case-insensitively across sessions, POSIX ones do not; spelling of the earliest touch', () => {
    const r = run([
      [session('a'), [[NOW - 1000, [edit('d:/w/SHOP/z.ts')]]]],
      [session('b'), [[NOW - 9000, [edit('D:/w/shop/z.ts')]]]],
      [session('c', { cwd: '/srv/app' }), [[NOW, [edit('/srv/app/Q.ts')], {}], [NOW, [edit('/srv/app/q.ts')]]]],
    ]);
    const paths = r.files.map((f) => f.path).sort();
    expect(paths).toEqual(['/srv/app/Q.ts', '/srv/app/q.ts', 'D:/w/shop/z.ts']);
  });

  test('subagent-internal touches count for their session; counts agree with the nodes', () => {
    const r = run([[session('a'), [
      [NOW - 2000, [edit('D:/w/shop/a.ts')], { agentId: 'ag1', turnId: null }],
      [NOW - 1000, [edit('D:/w/shop/a.ts'), read('D:/w/shop/a.ts')]],
    ]]]);
    expect(r.files[0]).toMatchObject({ reads: 1, changes: 2, sessionCount: 1 });
  });

  test('failedSessions, importing and truncatedNodes are passed through / summed', () => {
    const r = run(
      [[session('a'), [[NOW, [edit('D:/w/shop/a.ts')], { filesTruncated: true }]]], [session('b', { projectId: 'p2' }), [[NOW, [edit('D:/x.ts')], { filesTruncated: true }]]]],
      { failedSessions: 2, importing: true },
    );
    expect(r).toMatchObject({ failedSessions: 2, importing: true, truncatedNodes: 1 });
  });

  test('no conversation content', () => {
    const r = run([[session('a', { title: 'a title' }), [[NOW, [edit('D:/w/shop/a.ts')]]]]]);
    expect(JSON.stringify(r)).not.toMatch(/SECRET/);
  });
  test('ties: equal last times give the smaller session id’s origin; equal first times its spelling (any input order)', () => {
    const a: Spec = [session('a', { origin: 'codex' }), [[NOW - 1000, [edit('D:/w/shop/X.ts')]]]];
    const b: Spec = [session('b', { origin: 'cursor' }), [[NOW - 1000, [edit('d:/w/shop/x.ts')]]]];
    for (const order of [[a, b], [b, a]]) {
      const f = run(order).files[0]!;
      expect(f).toMatchObject({ lastOrigin: 'codex', path: 'D:/w/shop/X.ts' });
    }
  });
  test('failed / denied touches: not counted, no times; a session that only failed is a row with its failed count', () => {
    const r = run([
      [session('a'), [[NOW - 5000, [edit('D:/w/shop/x.ts')]]]],
      [session('b', { origin: 'cursor' }), [[NOW - 1000, [edit('D:/w/shop/x.ts'), write('D:/w/shop/x.ts')], { status: 'failed' }]]],
    ]);
    expect(r.files[0]).toMatchObject({
      reads: 0, changes: 1, failed: 2, created: false, sessionCount: 2, lastAt: iso(NOW - 5000), lastOrigin: 'claude',
    });
    expect(r.files[0]!.sessions).toEqual([
      { sessionId: 'b', origin: 'cursor', title: 'title b', reads: 0, changes: 0, failed: 2, lastAt: iso(NOW - 1000) },
      { sessionId: 'a', origin: 'claude', title: 'title a', reads: 0, changes: 1, failed: 0, lastAt: iso(NOW - 5000) },
    ]);
  });

  test('a file touched only by failed calls: listed with zero counts (not with changedOnly), times from the failures', () => {
    const specs: Spec[] = [[session('a'), [
      [NOW - 3000, [edit('D:/w/shop/bad.ts')], { status: 'failed' }],
      [NOW - 2000, [edit('D:/w/shop/bad.ts')], { status: 'denied' }],
      [NOW - 9000, [edit('D:/w/shop/good.ts')]],
    ]]];
    const all = run(specs);
    expect(all.files.find((f) => f.relativePath === 'bad.ts')).toMatchObject({
      reads: 0, changes: 0, failed: 2, created: false, deleted: false, sessionCount: 1, lastAt: iso(NOW - 2000), lastOrigin: 'claude',
    });
    expect(all.files.map((f) => f.relativePath)).toEqual(['bad.ts', 'good.ts']);
    expect(run(specs, { changedOnly: true }).files.map((f) => f.relativePath)).toEqual(['good.ts']);
    expect(run(specs, { sort: 'changes' }).files.map((f) => f.relativePath)).toEqual(['good.ts', 'bad.ts']);
  });

  test('range membership: failed touches count only for a file without any successful touch', () => {
    const from = rangeStartMs('7d', NOW)!;
    const specs: Spec[] = [[session('a'), [
      [from - DAY, [edit('D:/w/shop/old-ok.ts')]],
      [from + 1000, [edit('D:/w/shop/old-ok.ts')], { status: 'failed' }],
      [from + 2000, [edit('D:/w/shop/new-bad.ts')], { status: 'failed' }],
      [from - DAY, [edit('D:/w/shop/old-bad.ts')], { status: 'failed' }],
    ]]];
    const r = run(specs, { fromMs: from });
    expect(r.files.map((f) => [f.relativePath, f.changes, f.failed])).toEqual([['new-bad.ts', 0, 1]]);
    expect(run(specs).files.map((f) => f.relativePath).sort()).toEqual(['new-bad.ts', 'old-bad.ts', 'old-ok.ts']);
  });

  test('sorting: a failed late touch does not lift a file in recent order', () => {
    const r = run([[session('a'), [
      [NOW - 5000, [edit('D:/w/shop/a.ts')]],
      [NOW - 3000, [edit('D:/w/shop/b.ts')]],
      [NOW - 1000, [edit('D:/w/shop/a.ts')], { status: 'failed' }],
    ]]]);
    expect(r.files.map((f) => f.relativePath)).toEqual(['b.ts', 'a.ts']);
  });
});
