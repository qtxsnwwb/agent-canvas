import { describe, expect, test } from 'vitest';
import { FILE_TOUCHES_MAX, type FileTouch, type GraphNode, type Session } from '@agent-canvas/shared';
import { pathKey, sessionFilesResponse, summarizeSessionFiles } from '../src/files/summary.js';

const T0 = Date.parse('2026-11-10T10:00:00.000Z');
const at = (sec: number): string => new Date(T0 + sec * 1000).toISOString();

function session(o: Partial<Session> = {}): Session {
  return {
    id: 's1', projectId: 'p1', origin: 'claude', cwd: 'D:\\w\\shop', title: 'SECRET TITLE', gitBranch: null, status: 'idle',
    sourceDeleted: false, startedAt: at(0), lastActivityAt: at(0), ...o,
  };
}
function tool(id: string, sec: number, files: FileTouch[] | undefined, o: Partial<GraphNode> = {}): GraphNode {
  return {
    id, sessionId: 's1', turnId: 'T1', agentId: null, parentId: null, kind: 'tool', status: 'succeeded', timestamp: at(sec),
    confirmed: true, title: 'Edit', summary: 'SECRET SUMMARY', toolName: 'Edit', toolUseId: null, messageId: null,
    durationMs: null, usage: null, systemSubtype: null, childAgentId: null, endedAt: null,
    ...(files !== undefined ? { files } : {}), ...o,
  };
}
const read = (path: string): FileTouch => ({ path, action: 'read' });
const edit = (path: string): FileTouch => ({ path, action: 'edit' });
const write = (path: string): FileTouch => ({ path, action: 'write' });
const del = (path: string): FileTouch => ({ path, action: 'delete' });

const respond = (s: Session, nodes: GraphNode[]) => sessionFilesResponse(s, summarizeSessionFiles(s, nodes));

describe('pathKey', () => {
  test('Windows-style paths (drive, UNC) are lower-cased; POSIX paths are kept', () => {
    expect(pathKey('D:/A/b.ts')).toBe(pathKey('d:/a/B.ts'));
    expect(pathKey('//Srv/Share/X.ts')).toBe(pathKey('//srv/share/x.ts'));
    expect(pathKey('/home/A.ts')).not.toBe(pathKey('/home/a.ts'));
  });
});

describe('summarizeSessionFiles / sessionFilesResponse', () => {
  test('counts per action, flags, first / last time, totals', () => {
    const r = respond(session(), [
      tool('n1', 1, [read('D:/w/shop/a.ts')], { toolName: 'Read' }),
      tool('n2', 2, [edit('D:/w/shop/a.ts')]),
      tool('n3', 3, [write('D:/w/shop/new.ts')], { toolName: 'Write' }),
      tool('n4', 4, [del('D:/w/shop/old.ts')], { toolName: 'delete_file' }),
      tool('n5', 5, [read('D:/w/shop/r.ts')]),
    ]);
    const byRel = Object.fromEntries(r.files.map((f) => [f.relativePath, f]));
    expect(byRel['a.ts']).toMatchObject({
      path: 'D:/w/shop/a.ts', counts: { read: 1, edit: 1, write: 0, delete: 0 }, reads: 1, changes: 1,
      changed: true, created: false, deleted: false, firstAt: at(1), lastAt: at(2), touchesTruncated: false,
    });
    expect(byRel['new.ts']).toMatchObject({ changed: true, created: true, deleted: false, changes: 1 });
    expect(byRel['old.ts']).toMatchObject({ changed: true, created: false, deleted: true, changes: 1 });
    expect(byRel['r.ts']).toMatchObject({ changed: false, reads: 1, changes: 0 });
    expect(r.totals).toEqual({ files: 4, changedFiles: 3, reads: 2, changes: 3 });
    expect(r).toMatchObject({ sessionId: 's1', origin: 'claude', cwd: 'D:\\w\\shop', truncatedNodes: 0 });
  });

  test('touch list: node id, action, tool name, time, status, agent; in time order', () => {
    const r = respond(session(), [
      tool('late', 9, [edit('D:/w/shop/a.ts')], { status: 'failed' }),
      tool('early', 1, [read('D:/w/shop/a.ts')], { toolName: 'Read', agentId: 'ag1' }),
    ]);
    expect(r.files[0]!.touches).toEqual([
      { nodeId: 'early', action: 'read', toolName: 'Read', at: at(1), status: 'succeeded', agentId: 'ag1' },
      { nodeId: 'late', action: 'edit', toolName: 'Edit', at: at(9), status: 'failed', agentId: null },
    ]);
  });

  test('path identity: drive case, separators, dot segments and relative paths are one file (first spelling shown)', () => {
    const r = respond(session(), [
      tool('n1', 1, [edit('D:/w/shop/src/b.ts')]),
      tool('n2', 2, [edit('d:/W/Shop/src/B.ts')]),
      tool('n3', 3, [edit('D:\\w\\shop\\src\\b.ts')]),
      tool('n4', 4, [edit('D:/w/shop/./x/../src/b.ts')]),
      tool('n5', 5, [edit('src/b.ts')]),
    ]);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]).toMatchObject({ path: 'D:/w/shop/src/b.ts', relativePath: 'src/b.ts', changes: 5 });
  });

  test('POSIX paths compare case-sensitively', () => {
    const r = respond(session({ cwd: '/home/u/shop' }), [
      tool('n1', 1, [edit('/home/u/shop/A.ts')]),
      tool('n2', 2, [edit('/home/u/shop/a.ts')]),
    ]);
    expect(r.files.map((f) => f.relativePath).sort()).toEqual(['A.ts', 'a.ts']);
  });

  test('a file outside the working directory is shown in full; no cwd: full paths', () => {
    expect(respond(session(), [tool('n1', 1, [read('D:/other/z.ts')])]).files[0]!.relativePath).toBe('D:/other/z.ts');
    expect(respond(session({ cwd: null }), [tool('n1', 1, [read('D:/w/shop/z.ts')])]).files[0]!.relativePath).toBe('D:/w/shop/z.ts');
  });

  test('a (path, action) named twice on one node counts once; read + edit on one node count one each', () => {
    const r = respond(session(), [
      tool('n1', 1, [edit('D:/w/shop/a.ts'), edit('d:\\w\\shop\\a.ts'), read('D:/w/shop/a.ts')]),
    ]);
    expect(r.files[0]).toMatchObject({ counts: { read: 1, edit: 1, write: 0, delete: 0 } });
    expect(r.files[0]!.touches).toHaveLength(2);
  });

  test('subagent-internal touches belong to the session', () => {
    const r = respond(session(), [tool('in1', 1, [edit('D:/w/shop/a.ts')], { agentId: 'ag', turnId: null })]);
    expect(r.files[0]!.changes).toBe(1);
    expect(r.files[0]!.touches[0]!.agentId).toBe('ag');
  });

  test('nodes without files, with empty / malformed entries: ignored, nothing invented', () => {
    const bad = [
      { path: '', action: 'edit' },
      { path: 42, action: 'edit' },
      { path: 'D:/w/shop/a.ts', action: 'chmod' },
      null,
    ] as unknown as FileTouch[];
    const r = respond(session(), [
      tool('n0', 0, undefined, { kind: 'text', toolName: null }),
      tool('n1', 1, bad),
      tool('n2', 2, 'nope' as unknown as FileTouch[]),
    ]);
    expect(r.files).toEqual([]);
    expect(r.totals).toEqual({ files: 0, changedFiles: 0, reads: 0, changes: 0 });
  });

  test('truncatedNodes counts nodes flagged filesTruncated', () => {
    const r = respond(session(), [
      tool('n1', 1, [edit('D:/w/shop/a.ts')], { filesTruncated: true }),
      tool('n2', 2, [edit('D:/w/shop/b.ts')], { filesTruncated: true }),
      tool('n3', 3, [edit('D:/w/shop/c.ts')]),
    ]);
    expect(r.truncatedNodes).toBe(2);
  });

  test('more touches than FILE_TOUCHES_MAX: the latest are listed, counts stay complete', () => {
    const nodes = Array.from({ length: FILE_TOUCHES_MAX + 3 }, (_, i) => tool(`n${i}`, i, [read('D:/w/shop/a.ts')]));
    const f = respond(session(), nodes).files[0]!;
    expect(f.reads).toBe(FILE_TOUCHES_MAX + 3);
    expect(f.touches).toHaveLength(FILE_TOUCHES_MAX);
    expect(f.touchesTruncated).toBe(true);
    expect(f.touches[0]!.nodeId).toBe('n3');
    expect(f.touches.at(-1)!.nodeId).toBe(`n${FILE_TOUCHES_MAX + 2}`);
  });

  test('undated touches: counted, never a first / last time, listed first', () => {
    const r = respond(session(), [
      tool('d1', 5, [edit('D:/w/shop/a.ts')]),
      tool('u1', 0, [edit('D:/w/shop/a.ts')], { timestamp: 'garbage' }),
      tool('u2', 0, [read('D:/w/shop/b.ts')], { timestamp: '1970-01-01T00:00:00.000Z' }),
    ]);
    const a = r.files.find((f) => f.relativePath === 'a.ts')!;
    expect(a).toMatchObject({ changes: 2, firstAt: at(5), lastAt: at(5) });
    expect(a.touches.map((t) => t.nodeId)).toEqual(['u1', 'd1']);
    expect(r.files.find((f) => f.relativePath === 'b.ts')).toMatchObject({ reads: 1, firstAt: null, lastAt: null });
  });

  test('order: changes desc, then lastAt desc, then path', () => {
    const r = respond(session(), [
      tool('n1', 1, [edit('D:/w/shop/one.ts')]),
      tool('n2', 2, [edit('D:/w/shop/two.ts')]),
      tool('n3', 3, [edit('D:/w/shop/two.ts')]),
      tool('n4', 4, [read('D:/w/shop/read.ts')]),
      tool('n5', 1, [edit('D:/w/shop/aaa.ts')]),
    ]);
    expect(r.files.map((f) => f.relativePath)).toEqual(['two.ts', 'aaa.ts', 'one.ts', 'read.ts']);
  });

  test('no conversation content in the response', () => {
    const r = respond(session(), [tool('n1', 1, [edit('D:/w/shop/a.ts')])]);
    expect(JSON.stringify(r)).not.toMatch(/SECRET/);
  });
});
