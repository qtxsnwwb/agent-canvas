import fs from 'node:fs';
import path from 'node:path';
import type { ProjectIdResolver } from '../project-ids.js';
import { isObject } from './trim.js';

/** A workspace id we are willing to use as a directory name (no separators, no `.` / `..`). */
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

/** `User/workspaceStorage`, the sibling of the database's `globalStorage` directory. */
export function workspaceStorageDir(dbPath: string): string {
  return path.join(path.dirname(path.resolve(dbPath)), '..', 'workspaceStorage');
}

/**
 * A `file://` URI as a local path: `file:///d%3A/work/x` → `d:\work\x` (a drive letter gives a Windows path whatever
 * the platform), `file:///home/u/x` → `/home/u/x`, `file://server/share/x` → `\\server\share\x`. Null for any other
 * scheme (e.g. a remote workspace) or a malformed URI.
 */
export function fileUriToPath(uri: string): string | null {
  if (!/^file:\/\//i.test(uri)) return null;
  const rest = uri.slice('file://'.length);
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  let p: string;
  try {
    p = decodeURIComponent(slash === -1 ? '/' : rest.slice(slash));
  } catch {
    return null;
  }
  if (/^\/[A-Za-z]:/.test(p)) return p.slice(1).replace(/\//g, '\\');
  if (authority !== '' && authority.toLowerCase() !== 'localhost') return `\\\\${authority}${p.replace(/\//g, '\\')}`;
  return p;
}

/** `workspaceIdentifier.uri.fsPath` of a composerData or header value; null when absent. */
export function fsPathOf(holder: unknown): string | null {
  if (!isObject(holder) || !isObject(holder.workspaceIdentifier)) return null;
  const uri = holder.workspaceIdentifier.uri;
  if (!isObject(uri)) return null;
  return typeof uri.fsPath === 'string' && uri.fsPath !== '' ? uri.fsPath : null;
}

/**
 * The `folder` of `workspaceStorage/<workspaceId>/workspace.json` as a path; null when the id is unusable, the file is
 * missing or unreadable, or it names no local folder (a multi-root `workspace` file is not a working directory).
 */
export function workspaceFolder(storageDir: string, workspaceId: string | null): string | null {
  if (workspaceId === null || !SAFE_ID.test(workspaceId) || workspaceId === '.' || workspaceId === '..') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(storageDir, workspaceId, 'workspace.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!isObject(parsed) || typeof parsed.folder !== 'string') return null;
  return fileUriToPath(parsed.folder);
}

/**
 * A conversation's working directory (spec 5.4), the first that exists of: composerData's
 * `workspaceIdentifier.uri.fsPath`, the header value's, and the workspace.json `folder` of its workspace id.
 */
export function cursorCwd(composerData: unknown, headerValue: unknown, workspaceId: string | null, storageDir: string): string | null {
  return fsPathOf(composerData) ?? fsPathOf(headerValue) ?? workspaceFolder(storageDir, workspaceId);
}

/** Project id: the cwd encoded as Claude Code does (reusing an id differing only in case), else `cursor-<workspaceId>`. */
export function cursorProjectId(projects: ProjectIdResolver, cwd: string | null, workspaceId: string | null): string {
  if (cwd !== null) return projects.forCwd(cwd);
  return `cursor-${workspaceId ?? 'unknown'}`;
}
