import type { Diagnostics, SearchIndexStatus } from '@agent-canvas/shared';

/**
 * One line of the diagnostics page's 数据库 block: text, then an optional command (shown as <code>) and the text after
 * it. tone: plain, warn (diag-warn), error, muted.
 */
export interface DiagLine { text: string; command?: string; tail?: string; tone: 'plain' | 'warn' | 'error' | 'muted' }

const COMPACT_COMMAND = 'agent-canvas compact';

/** 1024-based sizes: "0 B", "1.5 KB", "12.3 MB", "1.5 GB". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1024) return `${Math.max(0, Math.round(Number.isFinite(n) ? n : 0))} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(1)} ${units[i]}`;
}

/**
 * Why VACUUM was skipped, in plain words, from Diagnostics.storage.vacuumSkipReason (`low-space: …`, `busy: …`,
 * `timeout: …`, `not-shrunk: …`, `free-space check failed: …`, `error: …`); anything else is just "跳过了".
 */
export function vacuumSkipText(reason: string | null): string {
  const r = reason ?? '';
  if (r.startsWith('low-space')) return '磁盘空间不够，跳过了';
  if (r.startsWith('busy')) return '当时一直有新数据写入，跳过了';
  if (r.startsWith('timeout')) return '没能在限定时间内做完，放弃了';
  if (r.startsWith('not-shrunk')) return '做完了但文件没有变小';
  if (r.startsWith('free-space check failed')) return '查不到磁盘剩余空间，跳过了';
  if (r.startsWith('error')) return '出错了';
  return '跳过了';
}

/** The storage rows (database size, compression, VACUUM, errors); null when the server sends no storage block. */
export function storageLines(s: Diagnostics['storage']): DiagLine[] | null {
  if (s === undefined) return null;
  const lines: DiagLine[] = [];
  lines.push({
    tone: 'plain',
    text: `数据库文件：${formatBytes(s.fileBytes)}${s.walBytes > 0 ? `（另有 WAL ${formatBytes(s.walBytes)}）` : ''}`,
  });
  if (s.migrating) lines.push({ tone: 'plain', text: `正在整理数据库：已处理 ${s.migrated} / ${s.total}` });
  else if (s.migrated < s.total) lines.push({ tone: 'warn', text: `数据库整理：停在 ${s.migrated} / ${s.total}，下次启动时接着做` });
  else lines.push({ tone: 'plain', text: '数据库整理：已完成' });

  if (s.vacuum === 'done') lines.push({ tone: 'plain', text: '回收空间：已完成' });
  else if (s.vacuum === 'pending') {
    lines.push({ tone: 'plain', text: s.migrating ? '回收空间：等数据库整理完再做' : '回收空间：还没做' });
  } else {
    const lowSpace = (s.vacuumSkipReason ?? '').startsWith('low-space');
    lines.push({
      tone: 'warn',
      text: lowSpace
        ? `回收空间：${vacuumSkipText(s.vacuumSkipReason)}。数据已经压缩好了，只是数据库文件暂时没变小；可以停止服务后运行 `
        : `回收空间：${vacuumSkipText(s.vacuumSkipReason)}。之后会再试，也可以停止服务后运行 `,
      command: COMPACT_COMMAND,
    });
    if (s.vacuumSkipReason !== null && s.vacuumSkipReason !== '') lines.push({ tone: 'muted', text: `原因：${s.vacuumSkipReason}` });
  }
  if (s.lastError !== null) lines.push({ tone: 'error', text: `上次出错：${s.lastError}` });
  if (s.unreadableDetails > 0) {
    lines.push({ tone: 'warn', text: `有 ${s.unreadableDetails} 个步骤的详情已损坏，无法读取（本次启动以来）` });
  }
  return lines;
}

/** The content search index rows; null when the server sends no search block. */
export function searchIndexLines(s: SearchIndexStatus | undefined): DiagLine[] | null {
  if (s === undefined) return null;
  const lines: DiagLine[] = [];
  if (s.indexing && s.lastError !== null) {
    lines.push({ tone: 'error', text: `检索索引：建立失败（已处理 ${s.indexed} / ${s.total}），下次启动时重试：${s.lastError}` });
  } else if (s.indexing) {
    lines.push({ tone: 'plain', text: `检索索引：正在建立，已处理 ${s.indexed} / ${s.total}（建好前内容搜索的结果可能不全）` });
  } else {
    lines.push({ tone: 'plain', text: '检索索引：已建好' });
    if (s.lastError !== null) lines.push({ tone: 'error', text: `上次出错：${s.lastError}` });
  }
  if (s.skipped > 0) {
    lines.push({ tone: 'warn', text: `有 ${s.skipped} 个步骤没能正常编入索引：读不出的步骤没有编入，详情损坏的只按摘要编入` });
  }
  return lines;
}
