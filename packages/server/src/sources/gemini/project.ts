import path from 'node:path';
import { normaliseCwd } from '../cursor/project.js';
import { encodeProjectId, ProjectIdResolver } from '../project-ids.js';
import { asWorkingDir, readSidecar } from '../sidecar.js';

export { asWorkingDir, readSidecar, sidecarReads } from '../sidecar.js';

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
