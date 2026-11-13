import { expect, test } from 'vitest';
import type { Diagnostics, NodeDetail, SearchIndexStatus } from '@agent-canvas/shared';
import { formatBytes, searchIndexLines, storageLines, vacuumSkipText, type DiagLine } from '../src/storageDiagnostics';
import { DETAIL_UNREADABLE_NOTE, detailNote } from '../src/canvas/detail';

type Storage = NonNullable<Diagnostics['storage']>;
const storage = (over: Partial<Storage> = {}): Storage => ({
  fileBytes: 1536 * 1024 * 1024, walBytes: 0, migrating: false, migrated: 10, total: 10, vacuum: 'done',
  vacuumSkipReason: null, lastError: null, unreadableDetails: 0, ...over,
});
const index = (over: Partial<SearchIndexStatus> = {}): SearchIndexStatus =>
  ({ indexing: false, indexed: 0, total: 0, skipped: 0, lastError: null, ...over });
/** A line as the page shows it (the command in <code>). */
const flat = (l: DiagLine): string => `${l.text}${l.command ?? ''}${l.tail ?? ''}`;

test('formatBytes：B / KB / MB / GB', () => {
  expect(formatBytes(0)).toBe('0 B');
  expect(formatBytes(1023)).toBe('1023 B');
  expect(formatBytes(1536)).toBe('1.5 KB');
  expect(formatBytes(12.34 * 1024 * 1024)).toBe('12.3 MB');
  expect(formatBytes(1536 * 1024 * 1024)).toBe('1.5 GB');
});

test('storageLines：旧服务器没有这一块时什么都不显示', () => {
  expect(storageLines(undefined)).toBeNull();
  expect(searchIndexLines(undefined)).toBeNull();
});

test('storageLines：整理完成、回收完成、无错误', () => {
  const lines = storageLines(storage({ walBytes: 2 * 1024 * 1024 }))!;
  expect(lines.map(flat)).toEqual([
    '数据库文件：1.5 GB（另有 WAL 2.0 MB）',
    '数据库整理：已完成',
    '回收空间：已完成',
  ]);
  expect(lines.every((l) => l.tone === 'plain')).toBe(true);
  expect(storageLines(storage())!.map(flat)[0]).toBe('数据库文件：1.5 GB');
});

test('storageLines：迁移中显示进度；回收空间等迁移做完', () => {
  const lines = storageLines(storage({ migrating: true, migrated: 1200, total: 350000, vacuum: 'pending' }))!.map(flat);
  expect(lines).toContain('正在整理数据库：已处理 1200 / 350000');
  expect(lines).toContain('回收空间：等数据库整理完再做');
  // Not running but not finished (stopped this run): resumes at the next start.
  expect(storageLines(storage({ migrated: 5, total: 9, vacuum: 'pending' }))!.map(flat))
    .toContain('数据库整理：停在 5 / 9，下次启动时接着做');
  expect(storageLines(storage({ vacuum: 'pending' }))!.map(flat)).toContain('回收空间：还没做');
});

test('storageLines：空间不够跳过回收——说明数据已压缩、文件暂未变小，可停服务后运行 compact', () => {
  const reason = 'low-space: database volume needs 3000 MB free, 100 MB available';
  const lines = storageLines(storage({ vacuum: 'skipped', vacuumSkipReason: reason }))!;
  const v = lines.find((l) => l.text.startsWith('回收空间'))!;
  expect(v.tone).toBe('warn');
  expect(v.command).toBe('agent-canvas compact');
  expect(flat(v)).toBe('回收空间：磁盘空间不够，跳过了。数据已经压缩好了，只是数据库文件暂时没变小；可以停止服务后运行 agent-canvas compact');
  expect(lines.map(flat)).toContain(`原因：${reason}`);
});

test('vacuumSkipText：各种跳过原因都有中文说明，未知原因也有', () => {
  expect(vacuumSkipText('busy: the service kept importing')).toBe('当时一直有新数据写入，跳过了');
  expect(vacuumSkipText('timeout: VACUUM did not finish within 120 s')).toBe('没能在限定时间内做完，放弃了');
  expect(vacuumSkipText('not-shrunk: 10 MB before, 10 MB after')).toBe('做完了但文件没有变小');
  expect(vacuumSkipText('free-space check failed: EPERM')).toBe('查不到磁盘剩余空间，跳过了');
  expect(vacuumSkipText('error: disk I/O error')).toBe('出错了');
  expect(vacuumSkipText('something new')).toBe('跳过了');
  expect(vacuumSkipText(null)).toBe('跳过了');
  const line = storageLines(storage({ vacuum: 'skipped', vacuumSkipReason: 'busy: the service kept importing' }))!
    .find((l) => l.text.startsWith('回收空间'))!;
  expect(flat(line)).toBe('回收空间：当时一直有新数据写入，跳过了。之后会再试，也可以停止服务后运行 agent-canvas compact');
});

test('storageLines：lastError 和损坏的详情数（非零才显示）', () => {
  const lines = storageLines(storage({ lastError: '3 stored rows could not be compressed (kept as they were)', unreadableDetails: 2 }))!;
  expect(lines.find((l) => l.tone === 'error')!.text).toBe('上次出错：3 stored rows could not be compressed (kept as they were)');
  expect(lines.find((l) => l.text.includes('损坏'))).toMatchObject({ tone: 'warn', text: '有 2 个步骤的详情已损坏，无法读取（本次启动以来）' });
  expect(storageLines(storage())!.some((l) => l.text.includes('损坏'))).toBe(false);
});

test('searchIndexLines：建立中、已建好、失败、跳过的行', () => {
  expect(searchIndexLines(index({ indexing: true, indexed: 500, total: 2000 }))!.map(flat))
    .toEqual(['检索索引：正在建立，已处理 500 / 2000（建好前内容搜索的结果可能不全）']);
  expect(searchIndexLines(index())!.map(flat)).toEqual(['检索索引：已建好']);
  const failed = searchIndexLines(index({ indexing: true, indexed: 500, total: 2000, lastError: 'database is locked' }))!;
  expect(failed[0]).toMatchObject({ tone: 'error', text: '检索索引：建立失败（已处理 500 / 2000），下次启动时重试：database is locked' });
  const skipped = searchIndexLines(index({ skipped: 3 }))!;
  expect(skipped.map(flat)).toEqual(['检索索引：已建好', '有 3 个步骤没能正常编入索引：读不出的步骤没有编入，详情损坏的只按摘要编入']);
  expect(skipped[1]!.tone).toBe('warn');
});

test('detailNote：详情损坏时给出说明，不显示空字段；没有内容时说无内容', () => {
  const d = (over: Partial<NodeDetail>): NodeDetail => ({ nodeId: 'n', input: null, output: null, text: null, raw: null, ...over });
  expect(DETAIL_UNREADABLE_NOTE).toBe('这一步的详情已损坏，无法读取');
  expect(detailNote(d({ unreadable: true }), 0)).toBe(DETAIL_UNREADABLE_NOTE);
  expect(detailNote(d({}), 0)).toBe('无内容');
  expect(detailNote(d({ text: 'hi' }), 1)).toBeNull();
});
