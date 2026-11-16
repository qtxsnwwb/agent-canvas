import fs from 'node:fs';
import path from 'node:path';
import { normaliseCwd } from '../cursor/project.js';
import { encodeProjectId, ProjectIdResolver } from '../project-ids.js';

/**
 * Store keys of the per-session project entries (meta raw events written from `.project_root` / `projects.json`, see
 * GeminiFileSource.indexEntries): `gemini:@project/<session id>`. `@` never occurs in a Gemini project directory name.
 */
export const GEMINI_PROJECT_ENTRY_PREFIX = 'gemini:@project/';

/** Largest `.project_root` read (it holds one path); a larger one counts as missing. */
export const PROJECT_ROOT_MAX_BYTES = 4 * 1024;
/** Largest `projects.json` read; a larger one counts as missing. */
export const PROJECTS_JSON_MAX_BYTES = 1024 * 1024;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Number of sidecar file contents read so far (tests: reads are cached by mtime and size). */
export let sidecarReads = 0;

interface Cached<T> {
  mtimeMs: number;
  size: number;
  value: T;
}
const cache = new Map<string, Cached<unknown>>();

/**
 * `parse` of a small file's content, at most `max` bytes, cached per path by mtime and size (re-read only when either
 * changes). Missing, unreadable or larger than `max`: `parse(null)`.
 */
function readSidecar<T>(file: string, max: number, parse: (text: string | null) => T): T {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    cache.delete(file);
    return parse(null);
  }
  try {
    const st = fs.fstatSync(fd);
    const hit = cache.get(file);
    if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value as T;
    let value: T;
    if (!st.isFile() || st.size > max) value = parse(null);
    else {
      const buf = Buffer.alloc(Math.min(st.size, max));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      sidecarReads += 1;
      value = parse(buf.subarray(0, n).toString('utf8'));
    }
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  } catch {
    return parse(null);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A usable working directory: one absolute path (POSIX `/…`, Windows `X:\…` / `X:/…`, UNC `\\server\share…`) without
 * control characters; anything else (spec 8: a damaged sidecar) is null.
 */
export function asWorkingDir(text: string | null): string | null {
  if (text === null) return null;
  const p = text.replace(/^\uFEFF/, '').replace(/[\r\n]+$/, '').trim();
  if (p === '' || /[\u0000-\u001f\u007f]/.test(p)) return null;
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p)) return p;
  return null;
}

/** The working directory `<tmp>/<slug>/.project_root` names, or null (missing, too large, not one absolute path). */
export function readProjectRoot(tmpDir: string, slug: string): string | null {
  return readSidecar(path.join(tmpDir, slug, '.project_root'), PROJECT_ROOT_MAX_BYTES, asWorkingDir);
}

/** `<tmp>/../projects.json` as slug -> path (usable paths only); empty when missing, too large or damaged. */
function readProjects(tmpDir: string): ReadonlyMap<string, string> {
  return readSidecar(path.join(tmpDir, '..', 'projects.json'), PROJECTS_JSON_MAX_BYTES, (text) => {
    const bySlug = new Map<string, string>();
    if (text === null) return bySlug;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return bySlug;
    }
    if (!isObject(parsed) || !isObject(parsed.projects)) return bySlug;
    for (const [p, s] of Object.entries(parsed.projects)) {
      const dir = asWorkingDir(p);
      if (typeof s === 'string' && dir !== null && !bySlug.has(s)) bySlug.set(s, dir);
    }
    return bySlug;
  });
}

/** The path `<tmp>/../projects.json` maps to `slug`, or null. */
export function readProjectsJson(tmpDir: string, slug: string): string | null {
  return readProjects(tmpDir).get(slug) ?? null;
}

/**
 * A Gemini project directory's project (spec 5.1): its working directory from `<tmp>/<slug>/.project_root`, else
 * from the reverse lookup of the slug in `<tmp>/../projects.json`; the id is that directory encoded as Claude Code
 * does — on Windows (where Gemini writes the path lower-cased) reusing a project id in use that differs only in
 * letter case (through ProjectIdResolver: `resolver` when given, else one over `knownProjectIds`). Neither found:
 * `gemini:<slug>`, cwd unknown. Missing, oversized or damaged files are "not found"; never throws. File contents are
 * read at most once per change (cached by mtime and size).
 */
export function geminiProject(
  tmpDir: string,
  slug: string,
  knownProjectIds: () => Iterable<string> = () => [],
  platform: NodeJS.Platform = process.platform,
  resolver?: ProjectIdResolver,
): { projectId: string; cwd: string | null } {
  const raw = readProjectRoot(tmpDir, slug) ?? readProjectsJson(tmpDir, slug);
  if (raw === null) return { projectId: `gemini:${slug}`, cwd: null };
  const cwd = normaliseCwd(raw);
  const projectId = platform === 'win32' ? (resolver ?? new ProjectIdResolver(knownProjectIds)).forCwd(cwd) : encodeProjectId(cwd);
  return { projectId, cwd };
}
