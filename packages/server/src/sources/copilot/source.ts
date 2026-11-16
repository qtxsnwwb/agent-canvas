import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { normaliseCwd } from '../cursor/project.js';
import { ProjectIdResolver } from '../project-ids.js';
import { KEY_PREFIXES, type FileClass, type FileSource, type MaybePromise } from '../source.js';
import { parseWorkspaceYaml, type CopilotWorkspace } from './workspace.js';

const PREFIX = KEY_PREFIXES.copilot;
const EVENTS = 'events.jsonl';
const WORKSPACE = 'workspace.yaml';
const LEGACY = /^(.+)\.jsonl$/;
/** Most bytes read from the start of an `events.jsonl` to find its first line (a `session.start` is about 1 KB). */
export const COPILOT_FIRST_LINE_MAX_BYTES = 256 * 1024;
/** Largest `workspace.yaml` read (by the source, and classified for the pipeline); a larger one counts as missing. */
export const COPILOT_WORKSPACE_MAX_BYTES = 64 * 1024;
const CHUNK = 64 * 1024;
const NEWLINE = 0x0a;
const UNKNOWN_PROJECT = 'unknown';

/** What a session file belongs to, as stored with its raw events. */
export interface CopilotStoredFile {
  sessionId: string;
  agentId: string | null;
  projectId: string | null;
}

/** What the source may ask the store (never file contents). */
export interface CopilotLookup {
  /** Session, agent and project stored with the transcript raw events of a key; null when none are stored. */
  storedFile(key: string): CopilotStoredFile | null;
  /** Project ids already in use (any origin), for reusing one that differs only in letter case. */
  knownProjectIds(): Iterable<string>;
}

const NO_LOOKUP: CopilotLookup = { storedFile: () => null, knownProjectIds: () => [] };

/**
 * The start of a file: `line` = its first line (a line break was found within `max` bytes), `incomplete` = fewer than
 * `max` bytes and no line break yet (an empty file included), `tooLong` = `max` bytes without a line break, `missing` =
 * no such file. `bytesRead` never exceeds `max`.
 */
export type FirstLine =
  | { kind: 'line'; text: string; bytesRead: number }
  | { kind: 'incomplete' | 'tooLong' | 'missing'; bytesRead: number };

interface CachedWorkspace {
  mtimeMs: number;
  size: number;
  value: CopilotWorkspace | null;
}
const workspaceCache = new Map<string, CachedWorkspace>();

/**
 * The source's only reads outside the pipeline's line reader, each bounded (an object so tests can spy on them).
 * `workspaceReads` counts workspace.yaml contents actually read (reads are cached by mtime and size).
 */
export const copilotIo = {
  workspaceReads: 0,

  /** At most `max` bytes from the start of `abs`, up to the first line break. */
  async readFirstLine(abs: string, max: number): Promise<FirstLine> {
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(abs, 'r');
    } catch {
      return { kind: 'missing', bytesRead: 0 };
    }
    try {
      const chunks: Buffer[] = [];
      let total = 0;
      while (total < max) {
        const buf = Buffer.alloc(Math.min(CHUNK, max - total));
        const { bytesRead } = await handle.read(buf, 0, buf.length, total);
        if (bytesRead === 0) return { kind: 'incomplete', bytesRead: total };
        const part = buf.subarray(0, bytesRead);
        const nl = part.indexOf(NEWLINE);
        if (nl !== -1) {
          chunks.push(part.subarray(0, nl));
          const text = Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '').replace(/\r$/, '');
          return { kind: 'line', text, bytesRead: total + bytesRead };
        }
        chunks.push(part);
        total += bytesRead;
      }
      return { kind: 'tooLong', bytesRead: total };
    } catch {
      return { kind: 'missing', bytesRead: 0 };
    } finally {
      await handle.close().catch(() => undefined);
    }
  },

  /**
   * The parsed `workspace.yaml` at `abs`, read only when at most `max` bytes, cached by path, mtime and size. Null when
   * missing, unreadable or too large (spec 8: a damaged sidecar counts as missing). Synchronous, never throws.
   */
  readWorkspace(abs: string, max: number): CopilotWorkspace | null {
    let fd: number;
    try {
      fd = fs.openSync(abs, 'r');
    } catch {
      workspaceCache.delete(abs);
      return null;
    }
    try {
      const st = fs.fstatSync(fd);
      const hit = workspaceCache.get(abs);
      if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
      let value: CopilotWorkspace | null = null;
      if (st.isFile() && st.size <= max) {
        const buf = Buffer.alloc(st.size);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        copilotIo.workspaceReads += 1;
        value = parseWorkspaceYaml(buf.subarray(0, n).toString('utf8'));
      }
      workspaceCache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, value });
      return value;
    } catch {
      return null;
    } finally {
      fs.closeSync(fd);
    }
  },
};

/** A key's file, from its path alone. */
type Shape = { kind: 'events' | 'legacy' | 'workspace'; sessionId: string };

/**
 * GitHub Copilot CLI's `<root>/session-state` (spec 5.3): `<session id>/events.jsonl` (the session's event log),
 * `<session id>.jsonl` (the same format, before 1.0) and `<session id>/workspace.yaml` (title and working directory,
 * read whole as the session's `title` file). Every other file there (`session.db`, `checkpoints/`, `plan.md`, `files/`,
 * lock files, `vscode.metadata.json`) is not this source's. Keys: `copilot:` + the path relative to session-state.
 *
 * The session id is the directory (or legacy file) name. The project is resolved once per session and cached: the one
 * stored with the session's raw events, else the `session.start` cwd of the event log's first line (a bounded read),
 * else `workspace.yaml`'s `cwd`, else unknown. No `events.jsonl` is ever read here beyond COPILOT_FIRST_LINE_MAX_BYTES,
 * and no `workspace.yaml` larger than COPILOT_WORKSPACE_MAX_BYTES is read at all (nor classified, so the pipeline's
 * whole-file read never sees it).
 */
export class CopilotFileSource implements FileSource {
  readonly origin = 'copilot' as const;
  /** Reaches `<session id>/events.jsonl` (one directory below rootDir). */
  readonly watchDepth = 1;
  /** Session id -> its project, once decided. */
  private readonly projects = new Map<string, string>();
  /** Project ids in use, reused when a cwd differs only in letter case. */
  private readonly resolver: ProjectIdResolver;

  constructor(
    readonly rootDir: string,
    private readonly lookup: CopilotLookup = NO_LOOKUP,
  ) {
    this.resolver = new ProjectIdResolver(() => this.lookup.knownProjectIds());
  }

  /** Session directories' `events.jsonl` / `workspace.yaml` and legacy `<id>.jsonl`, by name (nothing deeper is listed). */
  async listFiles(): Promise<string[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(this.rootDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const e of entries) {
      const at = path.join(this.rootDir, e.name);
      if (e.isFile()) {
        if (this.keyOf(at) !== null) out.push(at);
        continue;
      }
      if (!e.isDirectory()) continue;
      let inner: fs.Dirent[];
      try {
        inner = await fsp.readdir(at, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const f of inner) {
        if (!f.isFile() || (f.name !== EVENTS && f.name !== WORKSPACE)) continue;
        const file = path.join(at, f.name);
        if (this.keyOf(file) !== null) out.push(file);
      }
    }
    return out.sort();
  }

  keyOf(absPath: string): string | null {
    const rel = path.relative(this.rootDir, absPath);
    if (rel === '' || path.isAbsolute(rel)) return null;
    const key = PREFIX + rel.split(/[\\/]+/).filter((p) => p !== '').join('/');
    return shapeOf(key) === null ? null : key;
  }

  pathOf(key: string): string | null {
    if (shapeOf(key) === null) return null;
    return path.join(this.rootDir, ...key.slice(PREFIX.length).split('/'));
  }

  classify(key: string): MaybePromise<FileClass | null> {
    const shape = shapeOf(key);
    if (shape === null) return null;
    const { sessionId } = shape;
    if (shape.kind === 'workspace') {
      // Classified only when it exists and is small: the pipeline then reads it whole (a `title` file).
      try {
        const st = fs.statSync(this.pathOf(key)!);
        if (!st.isFile() || st.size > COPILOT_WORKSPACE_MAX_BYTES) return null;
      } catch {
        return null;
      }
      const known = this.known(sessionId);
      if (known !== null) return { kind: 'title', projectId: known, sessionId };
      return this.resolve(sessionId, null).then((projectId) => ({ kind: 'title', projectId, sessionId }));
    }
    const known = this.known(sessionId, key);
    if (known !== null) return { kind: 'session', projectId: known, sessionId };
    return this.resolve(sessionId, key).then((projectId) => (projectId === null ? null : { kind: 'session', projectId, sessionId }));
  }

  /** No key names the project: it is stored with each raw event. */
  projectOfKey(_key: string): string | null {
    return null;
  }

  projectOfTranscript(absPath: string): string | null {
    const key = this.keyOf(absPath);
    const shape = key === null ? null : shapeOf(key);
    if (shape === null || shape.kind === 'workspace') return null;
    return this.known(shape.sessionId, key!);
  }

  /**
   * The session of an event log. When a session has both forms (legacy `<id>.jsonl` and `<id>/events.jsonl`), a log
   * is its main file only while the other one is gone: both present → neither speaks (present); one removed → only the
   * one left speaks (present); both removed → both speak (deleted). So the "source deleted" flag never depends on the
   * order the keys are checked in.
   */
  mainSessionOf(key: string): string | null {
    const shape = shapeOf(key);
    if (shape === null || shape.kind === 'workspace') return null;
    const other = shape.kind === 'legacy' ? path.join(this.rootDir, shape.sessionId, EVENTS) : path.join(this.rootDir, `${shape.sessionId}.jsonl`);
    return fs.existsSync(other) ? null : shape.sessionId;
  }

  // ---------------------------------------------------------------- internals

  private eventsKeys(sessionId: string): string[] {
    return [`${PREFIX}${sessionId}/${EVENTS}`, `${PREFIX}${sessionId}.jsonl`];
  }

  /** Cached, else stored with the raw events of the session's event log (`key` first, when given); no read. */
  private known(sessionId: string, key?: string): string | null {
    const cached = this.projects.get(sessionId);
    if (cached !== undefined) return cached;
    const keys = key === undefined ? this.eventsKeys(sessionId) : [key, ...this.eventsKeys(sessionId).filter((k) => k !== key)];
    for (const k of keys) {
      const stored = this.lookup.storedFile(k);
      if (stored !== null && stored.projectId !== null) return this.remember(sessionId, stored.projectId);
    }
    return null;
  }

  private remember(sessionId: string, projectId: string): string {
    const existing = this.projects.get(sessionId);
    if (existing !== undefined) return existing; // a concurrent read got there first
    this.projects.set(sessionId, projectId);
    this.resolver.note(projectId);
    return projectId;
  }

  /**
   * The session's project from its files: the first line of `eventsKey` (or of the session's event log), else the
   * workspace's cwd, else unknown. Null when `eventsKey` is given and has nothing to read yet (missing, empty, first
   * line incomplete): nothing is cached then, so the next look decides. A result reached without a complete first line
   * of the event log is not cached either (the log may still say more).
   */
  private resolve(sessionId: string, eventsKey: null): Promise<string>;
  private resolve(sessionId: string, eventsKey: string): Promise<string | null>;
  private async resolve(sessionId: string, eventsKey: string | null): Promise<string | null> {
    const keys = eventsKey !== null ? [eventsKey] : this.eventsKeys(sessionId);
    let decided = false;
    for (const k of keys) {
      const first = await copilotIo.readFirstLine(this.pathOf(k)!, COPILOT_FIRST_LINE_MAX_BYTES);
      if (first.kind === 'missing' || first.kind === 'incomplete') {
        if (eventsKey !== null) return null;
        continue;
      }
      decided = true;
      const cwd = first.kind === 'line' ? startCwd(first.text) : null;
      if (cwd !== null) return this.remember(sessionId, this.resolver.forCwd(normaliseCwd(cwd)));
      break;
    }
    const ws = copilotIo.readWorkspace(path.join(this.rootDir, sessionId, WORKSPACE), COPILOT_WORKSPACE_MAX_BYTES);
    const projectId = ws?.cwd !== undefined ? this.resolver.forCwd(normaliseCwd(ws.cwd)) : UNKNOWN_PROJECT;
    return decided ? this.remember(sessionId, projectId) : projectId;
  }
}

/** The `data.context.cwd` of a `session.start` line; null for anything else. */
function startCwd(line: string): string | null {
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(rec) || rec.type !== 'session.start' || !isObject(rec.data) || !isObject(rec.data.context)) return null;
  const cwd = rec.data.context.cwd;
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : null;
}

/** A session id taken from a file or directory name: not empty, not hidden, no path syntax. */
const validId = (s: string): boolean => s !== '' && !s.startsWith('.') && !/[\\/:]/.test(s);

/** The shape of a key from its path alone, or null when it is none of this source's files. */
function shapeOf(key: string): Shape | null {
  if (!key.startsWith(PREFIX)) return null;
  const parts = key.slice(PREFIX.length).split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  if (parts.length === 1) {
    const m = LEGACY.exec(parts[0]!);
    return m !== null && validId(m[1]!) ? { kind: 'legacy', sessionId: m[1]! } : null;
  }
  if (parts.length === 2 && validId(parts[0]!)) {
    if (parts[1] === EVENTS) return { kind: 'events', sessionId: parts[0]! };
    if (parts[1] === WORKSPACE) return { kind: 'workspace', sessionId: parts[0]! };
  }
  return null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
