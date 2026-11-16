import fs from 'node:fs';
import path from 'node:path';
import { normaliseCwd } from '../cursor/project.js';
import { encodeProjectId, ProjectIdResolver } from '../project-ids.js';

/**
 * Store keys of the per-session project entries (meta raw events written from `.project_root` / `projects.json`, see
 * GeminiFileSource.indexEntries): `gemini:@project/<session id>`. `@` never occurs in a Gemini project directory name.
 */
export const GEMINI_PROJECT_ENTRY_PREFIX = 'gemini:@project/';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The first non-empty line of `<tmp>/<slug>/.project_root`, or null when missing, unreadable or empty. */
export function readProjectRoot(tmpDir: string, slug: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(tmpDir, slug, '.project_root'), 'utf8');
  } catch {
    return null;
  }
  const line = text.replace(/^﻿/, '').split(/\r?\n/).find((l) => l.trim() !== '');
  return line === undefined ? null : line.trim();
}

/** The path `<tmp>/../projects.json` maps to `slug` (`{"projects": {"<path>": "<slug>"}}`), or null. */
export function readProjectsJson(tmpDir: string, slug: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, '..', 'projects.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!isObject(parsed) || !isObject(parsed.projects)) return null;
  for (const [p, s] of Object.entries(parsed.projects)) if (s === slug && p.trim() !== '') return p;
  return null;
}

/**
 * A Gemini project directory's project (spec 5.1): its working directory from `<tmp>/<slug>/.project_root`, else
 * from the reverse lookup of the slug in `<tmp>/../projects.json`; the id is that directory encoded as Claude Code
 * does — on Windows (where Gemini writes the path lower-cased) reusing a project id in use that differs only in
 * letter case (`knownProjectIds`, through ProjectIdResolver). Neither found: `gemini:<slug>`, cwd unknown. Missing or
 * damaged files are "not found"; never throws.
 */
export function geminiProject(
  tmpDir: string,
  slug: string,
  knownProjectIds: () => Iterable<string> = () => [],
  platform: NodeJS.Platform = process.platform,
): { projectId: string; cwd: string | null } {
  const raw = readProjectRoot(tmpDir, slug) ?? readProjectsJson(tmpDir, slug);
  if (raw === null) return { projectId: `gemini:${slug}`, cwd: null };
  const cwd = normaliseCwd(raw);
  const projectId = platform === 'win32' ? new ProjectIdResolver(knownProjectIds).forCwd(cwd) : encodeProjectId(cwd);
  return { projectId, cwd };
}
