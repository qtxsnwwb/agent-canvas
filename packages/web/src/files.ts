/* Pure helpers for the file views: the session page's file panel (canvas/FilePanel.tsx) and the files page
   (pages/Files.tsx). No React, no DOM. */
import {
  FILES_DEFAULT_RANGE, FILES_DEFAULT_SORT, FILES_QUERY_MAX, FILES_RANGES, FILES_SORTS, ORIGINS, samePath,
  type FileAction, type FilesRange, type FilesSort, type NodeStatus, type Origin, type Project, type SessionFile,
  type SessionFileTouch,
} from '@agent-canvas/shared';
import { pickProject } from './home';

/** The four actions as the pages name them. */
export const ACTION_LABEL: Record<FileAction, string> = { read: '读', edit: '改', write: '写入', delete: '删除' };

/** What is and is not counted (spec 7), one line under both views. */
export const FILES_SCOPE_NOTE = '只统计读写文件的专用工具，命令行里的文件操作不在内。';
export const CODEX_NOTE = 'Codex 只记录改动，没有“读”。';

/** A path as a directory part (with its trailing separator, either kind) and the name after it. */
export function splitPath(p: string): { dir: string; name: string } {
  const body = p.endsWith('/') || p.endsWith('\\') ? p.slice(0, -1) : p;
  const cut = Math.max(body.lastIndexOf('/'), body.lastIndexOf('\\'));
  return cut < 0 ? { dir: '', name: p } : { dir: p.slice(0, cut + 1), name: p.slice(cut + 1) };
}

/** Case-insensitive, `\` read as `/`; also used for the server's `q` (same rule). */
function norm(s: string): string {
  return s.replace(/\\/g, '/').toLowerCase();
}

// ---- the session panel ----

export type SessionFileSort = 'changes' | 'recent' | 'path';
export const SESSION_FILE_SORTS: readonly { value: SessionFileSort; label: string }[] = [
  { value: 'changes', label: '改动最多' },
  { value: 'recent', label: '最近' },
  { value: 'path', label: '路径' },
];

export interface SessionFileView {
  changedOnly: boolean;
  q: string;
  sort: SessionFileSort;
}
export const DEFAULT_SESSION_FILE_VIEW: SessionFileView = { changedOnly: true, q: '', sort: 'changes' };
/** Only the sort is remembered: the switch starts on and the filter empty on every visit. */
export const SESSION_FILE_VIEW_KEY = 'agent-canvas.sessionFiles';

export function parseSessionFileView(raw: string | null): SessionFileView {
  if (raw === null) return { ...DEFAULT_SESSION_FILE_VIEW };
  try {
    const v = JSON.parse(raw) as unknown;
    const sort = typeof v === 'object' && v !== null ? (v as { sort?: unknown }).sort : undefined;
    return { ...DEFAULT_SESSION_FILE_VIEW, sort: SESSION_FILE_SORTS.some((o) => o.value === sort) ? (sort as SessionFileSort) : 'changes' };
  } catch {
    return { ...DEFAULT_SESSION_FILE_VIEW };
  }
}
export function serializeSessionFileView(v: SessionFileView): string {
  return JSON.stringify({ sort: v.sort });
}

const ms = (iso: string | null): number | null => {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};
/** Later first, undated last. */
function byRecent(a: string | null, b: string | null): number {
  const x = ms(a);
  const y = ms(b);
  if (x === y) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return y - x;
}
function byPath(a: { relativePath: string; path: string }, b: { relativePath: string; path: string }): number {
  const x = a.relativePath.toLowerCase();
  const y = b.relativePath.toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  if (a.relativePath !== b.relativePath) return a.relativePath < b.relativePath ? -1 : 1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** The panel's list: filtered by the switch and the filter box (relative or full path), then sorted. A new array. */
export function viewSessionFiles(files: readonly SessionFile[], v: SessionFileView): SessionFile[] {
  const q = norm(v.q.trim());
  const out = files.filter((f) => (!v.changedOnly || f.changed)
    && (q === '' || norm(f.relativePath).includes(q) || norm(f.path).includes(q)));
  const cmp = v.sort === 'path'
    ? byPath
    : v.sort === 'recent'
      ? (a: SessionFile, b: SessionFile) => byRecent(a.lastAt, b.lastAt) || byPath(a, b)
      : (a: SessionFile, b: SessionFile) => b.changes - a.changes || byRecent(a.lastAt, b.lastAt) || byPath(a, b);
  return out.sort(cmp);
}

/**
 * Why the panel's list is empty: 'none' — the session touched no file; 'readOnly' — nothing changed but some files were
 * read (the switch hides them); 'noMatch' — the filter box leaves nothing. Null when the list is not empty.
 */
export function sessionFilesEmpty(files: readonly SessionFile[], v: SessionFileView): 'none' | 'readOnly' | 'noMatch' | null {
  if (files.length === 0) return 'none';
  if (viewSessionFiles(files, v).length > 0) return null;
  if (v.changedOnly && !files.some((f) => f.changed) && v.q.trim() === '') return 'readOnly';
  return 'noMatch';
}

/** The muted "失败 N" marker of a file or session row; null when nothing failed (or the server sends no count). */
export function failedLabel(x: { failed?: number }): string | null {
  return (x.failed ?? 0) > 0 ? `失败 ${x.failed}` : null;
}

/** The line under "没有改过的文件": what the switch hides (files only read, or whose changes all failed). */
export function readOnlyNote(files: readonly SessionFile[]): string {
  return files.some((f) => !f.changed && (f.failed ?? 0) > 0)
    ? `${files.length} 个文件只读过，或改动没有成功。`
    : `只读过 ${files.length} 个文件。`;
}

/** The file of the list that is the same file as `path` (spelling, separators and, on Windows, case aside). */
export function findSessionFile<T extends { path: string }>(files: readonly T[], path: string): T | undefined {
  return files.find((f) => f.path === path) ?? files.find((f) => samePath(f.path, path));
}

/** One step of a file: one node, with every action it did on the file. */
export interface FileStep {
  nodeId: string;
  actions: FileAction[];
  toolName: string | null;
  at: string;
  status: NodeStatus | null;
  agentId: string | null;
}

/** The touches of one file as steps, one per node, in the touches' (time) order. */
export function groupTouches(touches: readonly SessionFileTouch[]): FileStep[] {
  const byNode = new Map<string, FileStep>();
  for (const t of touches) {
    const step = byNode.get(t.nodeId);
    if (step === undefined) {
      byNode.set(t.nodeId, { nodeId: t.nodeId, actions: [t.action], toolName: t.toolName, at: t.at, status: t.status, agentId: t.agentId });
    } else if (!step.actions.includes(t.action)) {
      step.actions.push(t.action);
    }
  }
  return [...byNode.values()];
}

// ---- the files page ----

export type FilesOriginFilter = 'all' | Origin;
export interface FilesFilter {
  /** null: not chosen yet (the busiest project is used). */
  projectId: string | null;
  origin: FilesOriginFilter;
  range: FilesRange;
  changedOnly: boolean;
  /** The path filter (not remembered). */
  q: string;
  sort: FilesSort;
}
export const FILES_FILTER_KEY = 'agent-canvas.files';
export const DEFAULT_FILES_FILTER: FilesFilter = {
  projectId: null, origin: 'all', range: FILES_DEFAULT_RANGE, changedOnly: true, q: '', sort: FILES_DEFAULT_SORT,
};
export const FILES_RANGE_OPTIONS: readonly { value: FilesRange; label: string }[] = [
  { value: '7d', label: '最近 7 天' },
  { value: '30d', label: '最近 30 天' },
  { value: 'all', label: '全部' },
];
export const FILES_SORT_OPTIONS: readonly { value: FilesSort; label: string }[] = [
  { value: 'recent', label: '最近' },
  { value: 'changes', label: '改动最多' },
  { value: 'path', label: '路径' },
];

/** A stored filter; each unknown or malformed part falls back to its default. The path filter always starts empty. */
export function parseFilesFilter(raw: string | null): FilesFilter {
  if (raw === null) return { ...DEFAULT_FILES_FILTER };
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return { ...DEFAULT_FILES_FILTER }; }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ...DEFAULT_FILES_FILTER };
  const o = v as Record<string, unknown>;
  return {
    projectId: typeof o.projectId === 'string' && o.projectId !== '' ? o.projectId : null,
    origin: (ORIGINS as readonly unknown[]).includes(o.origin) ? (o.origin as Origin) : 'all',
    range: (FILES_RANGES as readonly unknown[]).includes(o.range) ? (o.range as FilesRange) : DEFAULT_FILES_FILTER.range,
    changedOnly: typeof o.changedOnly === 'boolean' ? o.changedOnly : DEFAULT_FILES_FILTER.changedOnly,
    q: '',
    sort: (FILES_SORTS as readonly unknown[]).includes(o.sort) ? (o.sort as FilesSort) : DEFAULT_FILES_FILTER.sort,
  };
}

export function serializeFilesFilter(f: FilesFilter): string {
  return JSON.stringify({ projectId: f.projectId, origin: f.origin, range: f.range, changedOnly: f.changedOnly, sort: f.sort });
}

/**
 * The filter in force: the remembered project while it exists, else the busiest one (most active sessions, then most
 * sessions; null when there is none); an origin the project does not have becomes 全部. Before the project list has
 * loaded (null) the filter is used as is.
 */
export function effectiveFilesFilter(f: FilesFilter, projects: readonly Project[] | null): FilesFilter {
  if (projects === null) return f;
  const project = projects.find((p) => p.id === f.projectId) ?? pickProject(projects);
  const origin = f.origin !== 'all' && project !== null && project.origins.includes(f.origin) ? f.origin : 'all';
  return { ...f, projectId: project?.id ?? null, origin };
}

/** The `/api/files` query (projectId must be set); the path filter trimmed and cut to what the server accepts. */
export function filesQueryString(f: FilesFilter): string {
  const enc = encodeURIComponent;
  const parts = [
    `projectId=${enc(f.projectId ?? '')}`, `range=${enc(f.range)}`, `changedOnly=${f.changedOnly ? '1' : '0'}`, `sort=${enc(f.sort)}`,
  ];
  if (f.origin !== 'all') parts.push(`origin=${enc(f.origin)}`);
  // The server counts UTF-16 units; cut on a code point boundary.
  let q = '';
  for (const ch of f.q.trim()) {
    if (q.length + ch.length > FILES_QUERY_MAX) break;
    q += ch;
  }
  if (q !== '') parts.push(`q=${enc(q)}`);
  return parts.join('&');
}
