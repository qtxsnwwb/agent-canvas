import path from 'node:path';

export type TranscriptFile =
  | { kind: 'session'; projectId: string; sessionId: string }
  | { kind: 'agent'; projectId: string; sessionId: string; agentId: string }
  | { kind: 'agent_meta'; projectId: string; sessionId: string; agentId: string }
  | { kind: 'title'; projectId: string; sessionId: string };

const AGENT_JSONL = /^agent-(.+)\.jsonl$/;
const AGENT_META = /^agent-(.+)\.meta\.json$/;

/**
 * Path of `absPath` relative to `projectsDir` with `/` separators (the key stored in raw_event and file_offset), or
 * null when it is not under `projectsDir`. On Windows the comparison is case-insensitive (path.win32.relative).
 */
export function relPath(projectsDir: string, absPath: string): string | null {
  const rel = path.relative(projectsDir, absPath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(/[\\/]+/).filter((p) => p !== '').join('/');
}

/** Classify a file under the projects directory; both `/` and `\` separators are accepted. */
export function classifyPath(projectsDir: string, absPath: string): TranscriptFile | null {
  const rel = relPath(projectsDir, absPath);
  return rel === null ? null : classifyRelPath(rel);
}

/** Classify a path relative to the projects directory (as stored in raw_event.file). */
export function classifyRelPath(rel: string): TranscriptFile | null {
  const parts = rel.split(/[\\/]+/).filter((p) => p !== '');
  const [projectId, second, third, fourth] = parts;

  if (parts.length === 2 && second.endsWith('.jsonl') && second.length > '.jsonl'.length) {
    return { kind: 'session', projectId, sessionId: second.slice(0, -'.jsonl'.length) };
  }
  if (parts.length === 3 && third === 'custom-title.json') {
    return { kind: 'title', projectId, sessionId: second };
  }
  if (parts.length === 4 && third === 'subagents') {
    const jsonl = AGENT_JSONL.exec(fourth);
    if (jsonl) return { kind: 'agent', projectId, sessionId: second, agentId: jsonl[1] };
    const meta = AGENT_META.exec(fourth);
    if (meta) return { kind: 'agent_meta', projectId, sessionId: second, agentId: meta[1] };
  }
  return null;
}
