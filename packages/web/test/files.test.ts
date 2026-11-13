import { expect, test } from 'vitest';
import type { Project, SessionFile, SessionFileTouch } from '@agent-canvas/shared';
import {
  ACTION_LABEL, DEFAULT_FILES_FILTER, failedLabel, readOnlyNote, DEFAULT_SESSION_FILE_VIEW, effectiveFilesFilter, filesQueryString, findSessionFile,
  groupTouches, parseFilesFilter, parseSessionFileView, serializeFilesFilter, serializeSessionFileView,
  sessionFilesEmpty, splitPath, viewSessionFiles,
} from '../src/files';

function file(path: string, o: Partial<SessionFile> = {}): SessionFile {
  const counts = o.counts ?? { read: 0, edit: 0, write: 0, delete: 0 };
  const changes = counts.edit + counts.write + counts.delete;
  return {
    path, relativePath: o.relativePath ?? path, counts, reads: counts.read, changes, changed: changes > 0,
    created: counts.write > 0, deleted: counts.delete > 0, firstAt: o.lastAt ?? null, lastAt: o.lastAt ?? null,
    touches: [], touchesTruncated: false, ...o,
  };
}
const c = (read: number, edit = 0, write = 0, del = 0) => ({ read, edit, write, delete: del });

test('splitPath：目录部分和文件名，两种分隔符', () => {
  expect(splitPath('src/canvas/FilePanel.tsx')).toEqual({ dir: 'src/canvas/', name: 'FilePanel.tsx' });
  expect(splitPath('README.md')).toEqual({ dir: '', name: 'README.md' });
  expect(splitPath('D:\\a\\b.ts')).toEqual({ dir: 'D:\\a\\', name: 'b.ts' });
  expect(splitPath('/a/b/')).toEqual({ dir: '/a/', name: 'b/' });
  expect(splitPath('')).toEqual({ dir: '', name: '' });
});

test('四种动作的名字', () => {
  expect(ACTION_LABEL).toEqual({ read: '读', edit: '改', write: '写入', delete: '删除' });
});

test('只看改过的、过滤框（不分大小写，反斜杠当斜杠）', () => {
  const files = [
    file('D:/p/src/a.ts', { relativePath: 'src/a.ts', counts: c(2, 2) }),
    file('D:/p/src/B.ts', { relativePath: 'src/B.ts', counts: c(3) }),
    file('D:/p/docs/c.md', { relativePath: 'docs/c.md', counts: c(0, 0, 1) }),
  ];
  expect(viewSessionFiles(files, { changedOnly: true, q: '', sort: 'changes' }).map((f) => f.relativePath)).toEqual(['src/a.ts', 'docs/c.md']);
  expect(viewSessionFiles(files, { changedOnly: false, q: 'SRC\\b', sort: 'changes' }).map((f) => f.relativePath)).toEqual(['src/B.ts']);
  // the full path matches too (a fragment of the session directory)
  expect(viewSessionFiles(files, { changedOnly: false, q: 'd:/p/docs', sort: 'changes' })).toHaveLength(1);
  expect(viewSessionFiles(files, { changedOnly: false, q: '   ', sort: 'path' })).toHaveLength(3);
});

test('排序：改动最多（再按最近）、最近（无时间的排最后）、路径', () => {
  const files = [
    file('/p/b', { relativePath: 'b', counts: c(0, 1), lastAt: '2026-01-02T00:00:00Z' }),
    file('/p/a', { relativePath: 'a', counts: c(0, 1), lastAt: '2026-01-03T00:00:00Z' }),
    file('/p/C', { relativePath: 'C', counts: c(0, 5), lastAt: null }),
    file('/p/d', { relativePath: 'd', counts: c(1), lastAt: '2026-01-04T00:00:00Z' }),
  ];
  const order = (sort: 'changes' | 'recent' | 'path') =>
    viewSessionFiles(files, { changedOnly: false, q: '', sort }).map((f) => f.relativePath);
  expect(order('changes')).toEqual(['C', 'a', 'b', 'd']);
  expect(order('recent')).toEqual(['d', 'a', 'b', 'C']);
  expect(order('path')).toEqual(['a', 'b', 'C', 'd']);
  // input not mutated
  expect(files.map((f) => f.relativePath)).toEqual(['b', 'a', 'C', 'd']);
});

test('空状态：没有文件 / 只有读过的 / 过滤后没有', () => {
  const read = file('/p/r', { counts: c(1) });
  const changed = file('/p/w', { counts: c(0, 1) });
  const v = { ...DEFAULT_SESSION_FILE_VIEW };
  expect(sessionFilesEmpty([], v)).toBe('none');
  expect(sessionFilesEmpty([read], v)).toBe('readOnly');
  expect(sessionFilesEmpty([read], { ...v, changedOnly: false })).toBeNull();
  expect(sessionFilesEmpty([read, changed], v)).toBeNull();
  expect(sessionFilesEmpty([read, changed], { ...v, q: 'zzz' })).toBe('noMatch');
});

test('findSessionFile 按同一文件找（Windows 不分大小写、分隔符不同）', () => {
  const files = [file('D:/Proj/src/A.ts'), file('/home/u/x.ts')];
  expect(findSessionFile(files, 'd:\\proj\\src\\a.ts')?.path).toBe('D:/Proj/src/A.ts');
  expect(findSessionFile(files, '/home/u/X.ts')).toBeUndefined();
  expect(findSessionFile(files, '/home/u/./x.ts')?.path).toBe('/home/u/x.ts');
});

test('会话面板的视图设置：读回、坏值退回默认', () => {
  expect(DEFAULT_SESSION_FILE_VIEW).toEqual({ changedOnly: true, q: '', sort: 'changes' });
  // only the sort is remembered: the switch starts on and the filter empty on every visit
  const v = { changedOnly: false, q: 'abc', sort: 'path' as const };
  expect(parseSessionFileView(serializeSessionFileView(v))).toEqual({ changedOnly: true, q: '', sort: 'path' });
  expect(parseSessionFileView(null)).toEqual(DEFAULT_SESSION_FILE_VIEW);
  expect(parseSessionFileView('{bad')).toEqual(DEFAULT_SESSION_FILE_VIEW);
  expect(parseSessionFileView('{"changedOnly":"yes","sort":"zzz"}')).toEqual(DEFAULT_SESSION_FILE_VIEW);
});

test('groupTouches：同一步的几个动作合成一行，按时间顺序', () => {
  const t = (nodeId: string, action: SessionFileTouch['action'], at: string, extra: Partial<SessionFileTouch> = {}): SessionFileTouch =>
    ({ nodeId, action, toolName: 'Edit', at, status: 'succeeded', agentId: null, ...extra });
  const rows = groupTouches([
    t('n1', 'read', '2026-01-01T00:00:01Z', { toolName: 'Read' }),
    t('n2', 'read', '2026-01-01T00:00:02Z', { toolName: 'apply_patch' }),
    t('n2', 'edit', '2026-01-01T00:00:02Z', { toolName: 'apply_patch' }),
    t('n3', 'write', '2026-01-01T00:00:03Z', { agentId: 'a1', status: 'failed' }),
  ]);
  expect(rows.map((r) => [r.nodeId, r.actions])).toEqual([['n1', ['read']], ['n2', ['read', 'edit']], ['n3', ['write']]]);
  expect(rows[2]).toMatchObject({ agentId: 'a1', status: 'failed', toolName: 'Edit' });
});

// ---- the files page ----

const proj = (id: string, o: Partial<Project> = {}): Project =>
  ({ id, cwd: `D:/${id}`, sessionCount: 1, activeSessionCount: 0, origins: ['claude'], ...o });

test('文件页筛选：读回、坏值退回默认；过滤框不记', () => {
  expect(DEFAULT_FILES_FILTER).toEqual({ projectId: null, origin: 'all', range: 'all', changedOnly: true, q: '', sort: 'recent' });
  const f = { projectId: 'p', origin: 'codex' as const, range: '7d' as const, changedOnly: false, q: 'x', sort: 'path' as const };
  expect(parseFilesFilter(serializeFilesFilter(f))).toEqual({ ...f, q: '' });
  expect(parseFilesFilter(null)).toEqual(DEFAULT_FILES_FILTER);
  expect(parseFilesFilter('[]')).toEqual(DEFAULT_FILES_FILTER);
  expect(parseFilesFilter('{"projectId":"","origin":"x","range":"1y","changedOnly":1,"sort":"size"}')).toEqual(DEFAULT_FILES_FILTER);
});

test('effectiveFilesFilter：记住的项目还在就用它，否则最忙的；来源只能是这个项目有的', () => {
  const projects = [proj('a', { sessionCount: 3 }), proj('b', { activeSessionCount: 1, origins: ['claude', 'codex'] })];
  expect(effectiveFilesFilter({ ...DEFAULT_FILES_FILTER, projectId: 'a' }, projects).projectId).toBe('a');
  expect(effectiveFilesFilter({ ...DEFAULT_FILES_FILTER, projectId: 'gone' }, projects).projectId).toBe('b');
  expect(effectiveFilesFilter(DEFAULT_FILES_FILTER, projects).projectId).toBe('b');
  expect(effectiveFilesFilter({ ...DEFAULT_FILES_FILTER, projectId: 'b', origin: 'codex' }, projects).origin).toBe('codex');
  expect(effectiveFilesFilter({ ...DEFAULT_FILES_FILTER, projectId: 'a', origin: 'codex' }, projects).origin).toBe('all');
  expect(effectiveFilesFilter(DEFAULT_FILES_FILTER, []).projectId).toBeNull();
  expect(effectiveFilesFilter({ ...DEFAULT_FILES_FILTER, projectId: 'x' }, null).projectId).toBe('x');
});

test('filesQueryString：每个参数只出现一次，按接口的写法', () => {
  const q = filesQueryString({ projectId: 'D--a b', origin: 'all', range: '30d', changedOnly: false, q: ' src/中 ', sort: 'changes' });
  expect(q).toBe('projectId=D--a%20b&range=30d&changedOnly=0&sort=changes&q=src%2F%E4%B8%AD');
  expect(filesQueryString({ ...DEFAULT_FILES_FILTER, projectId: 'p', origin: 'cursor' }))
    .toBe('projectId=p&range=all&changedOnly=1&sort=recent&origin=cursor');
  expect(filesQueryString({ ...DEFAULT_FILES_FILTER, projectId: 'p', q: 'x'.repeat(300) })).toContain(`q=${'x'.repeat(200)}`);
  expect(filesQueryString({ ...DEFAULT_FILES_FILTER, projectId: 'p', q: 'x'.repeat(300) })).not.toContain('x'.repeat(201));
});

test('failedLabel：失败次数大于 0 才显示；旧服务没有 failed 字段时不显示', () => {
  expect(failedLabel({ failed: 3 })).toBe('失败 3');
  expect(failedLabel({ failed: 0 })).toBeNull();
  expect(failedLabel({})).toBeNull();
});

test('readOnlyNote：只读过的文件；有改动全部失败的文件时一并说明', () => {
  expect(readOnlyNote([file('a', { counts: c(2) }), file('b', { counts: c(1) })])).toBe('只读过 2 个文件。');
  expect(readOnlyNote([file('a', { counts: c(2) }), file('b', { failed: 2 })])).toBe('2 个文件只读过，或改动没有成功。');
});
