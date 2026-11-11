import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FileClass, FileSource } from './source.js';
import { classifyPath, classifyRelPath, relPath } from './transcript/paths.js';

/**
 * Claude Code's `~/.claude/projects`: `<project>/<session>.jsonl`, `<project>/<session>/subagents/agent-<id>.jsonl`
 * (+ `.meta.json`) and `<project>/<session>/custom-title.json`. Keys are the paths relative to the directory with `/`
 * separators, exactly as stored before origins existed; everything is told from the path, synchronously.
 */
export class ClaudeFileSource implements FileSource {
  readonly origin = 'claude' as const;
  readonly watchDepth = 3;

  constructor(readonly rootDir: string) {}

  async listFiles(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fsp.readdir(this.rootDir, { recursive: true });
    } catch {
      return [];
    }
    return entries
      .map((rel) => path.join(this.rootDir, rel))
      .filter((abs) => classifyPath(this.rootDir, abs) !== null)
      .sort();
  }

  keyOf(absPath: string): string | null {
    return relPath(this.rootDir, absPath);
  }

  pathOf(key: string): string {
    return path.join(this.rootDir, ...key.split('/'));
  }

  classify(key: string): FileClass | null {
    return classifyRelPath(key);
  }

  projectOfKey(key: string): string | null {
    return classifyRelPath(key)?.projectId ?? null;
  }

  projectOfTranscript(absPath: string): string | null {
    const cls = classifyPath(this.rootDir, absPath);
    return cls !== null && (cls.kind === 'session' || cls.kind === 'agent') ? cls.projectId : null;
  }

  mainSessionOf(key: string): string | null {
    const cls = classifyRelPath(key);
    return cls?.kind === 'session' ? cls.sessionId : null;
  }
}
