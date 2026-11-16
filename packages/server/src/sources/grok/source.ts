import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { normaliseCwd } from '../cursor/project.js';
import { asWorkingDir, readSidecar } from '../sidecar.js';
import { ProjectIdResolver } from '../project-ids.js';
import { KEY_PREFIXES, type FileClass, type FileSource, type IndexEntry, type MaybePromise } from '../source.js';

const PREFIX = KEY_PREFIXES.grok;
const UPDATES = 'updates.jsonl';
const SUMMARY = 'summary.json';
const DOT_CWD = '.cwd';
const UNKNOWN_PROJECT = 'unknown';
/**
 * Store keys of the per-session summary entries (meta raw events GrokFileSource.indexEntries derives from a session's
 * `summary.json`): `grok:@summary/<session id>`. `@` never starts an encoded working-directory name (urlencoding writes
 * it as `%40`; the hashed form is `<slug>-<hash>`).
 */
export const GROK_SUMMARY_ENTRY_PREFIX = `${PREFIX}@summary/`;
/** Largest `summary.json` read (by the source, and classified for the pipeline); a larger one counts as missing. */
export const GROK_SUMMARY_MAX_BYTES = 1024 * 1024;
/** Largest `<cwd dir>/.cwd` read (it holds one path); a larger one counts as missing. */
export const GROK_CWD_MAX_BYTES = 4 * 1024;

/** What a session file belongs to, as stored with its raw events. */
export interface GrokStoredFile {
  sessionId: string;
  agentId: string | null;
  projectId: string | null;
}

/** What the source may ask the store (never file contents). */
export interface GrokLookup {
  /** Session, agent and project stored with the transcript raw events of a key; null when none are stored. */
  storedFile(key: string): GrokStoredFile | null;
  /** Project ids already in use (any origin), for reusing one that differs only in letter case. */
  knownProjectIds(): Iterable<string>;
}

const NO_LOOKUP: GrokLookup = { storedFile: () => null, knownProjectIds: () => [] };

/** What is read from a `summary.json` (everything else in it is left alone). */
export interface GrokSummary {
  kind: string | null;
  parent: string | null;
  cwd: string | null;
  title: string | null;
  summary: string | null;
  model: string | null;
  branch: string | null;
  createdAt: string | null;
}

/** The payload of a summary entry (what the normalizer gets of a session's `summary.json`). */
export interface GrokSummaryPayload {
  title: string | null;
  summary: string | null;
  model: string | null;
  cwd: string | null;
  branch: string | null;
  createdAt: string | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** The fields of a `summary.json` text this source uses; null when it is not a JSON object (damaged: missing). */
export function parseGrokSummary(text: string | null): GrokSummary | null {
  if (text === null) return null;
  let rec: unknown;
  try {
    rec = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return null;
  }
  if (!isObject(rec)) return null;
  const info = isObject(rec.info) ? rec.info : {};
  const created = nonEmpty(rec.created_at);
  const createdMs = created === null ? Number.NaN : Date.parse(created);
  return {
    kind: nonEmpty(rec.session_kind),
    parent: nonEmpty(rec.parent_session_id),
    cwd: nonEmpty(info.cwd),
    title: nonEmpty(rec.generated_title),
    summary: nonEmpty(rec.session_summary),
    model: nonEmpty(rec.current_model_id),
    branch: nonEmpty(rec.head_branch),
    createdAt: Number.isNaN(createdMs) ? null : new Date(createdMs).toISOString(),
  };
}

/**
 * The working directory an encoded directory name stands for (spec 5.2): its URL-decoding when that looks like an
 * absolute path (`/…`, or `X:` on Windows), else null (undecodable, relative, or the hashed `<slug>-<hash>` form).
 */
export function decodeGrokDirName(name: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    return null;
  }
  if (decoded === '' || /[\u0000-\u001f\u007f]/.test(decoded)) return null;
  return decoded.startsWith('/') || /^[A-Za-z]:/.test(decoded) ? decoded : null;
}

/** A key's file, from its path alone. */
type Shape = { kind: 'updates' | 'summary'; dir: string; id: string };

/**
 * Grok Build's `<root>/sessions` (spec 5.2): `<encoded cwd>/<session id>/updates.jsonl` (the session's update log, read
 * line by line) and `<encoded cwd>/<session id>/summary.json` (read whole). Every other file there (chat_history.jsonl,
 * usage.json, rewind_points.jsonl, prompts/, images/, …) is not this source's. Keys: `grok:` + the path relative to
 * sessions. A directory is a session only when it has a `summary.json`.
 *
 * `updates.jsonl` is classified from its directory's `summary.json` (bounded read, cached by mtime and size): a
 * `session_kind: "subagent"` with a `parent_session_id` makes it an agent thread of that parent (agent id = its own
 * id); anything else (forks included) a session of its own. Until `summary.json` can be read it is not classified
 * ("cannot tell yet"). The result is cached per key, and taken from the stored raw events when there are any (a
 * rebuild or a vanished file reads nothing). Project: the encoded `info.cwd`, else the URL-decoded directory name when
 * it looks absolute, else `<cwd dir>/.cwd`, else unknown.
 *
 * `summary.json` is an index file of one session: its entry (`grok:@summary/<id>`) is a projection of the fields the
 * normalizer uses (title, summary, model, resolved cwd, branch, creation time), so the counters Grok bumps on every
 * append store nothing new. A subagent's summary gives no entry. Nothing is ever written under the Grok directory.
 */
export class GrokFileSource implements FileSource {
  readonly origin = 'grok' as const;
  /** Reaches `<encoded cwd>/<session id>/updates.jsonl` (two directories below rootDir). */
  readonly watchDepth = 2;
  /** Key of an updates.jsonl -> its class, once decided. */
  private readonly classes = new Map<string, FileClass>();
  private readonly resolver: ProjectIdResolver;

  constructor(
    readonly rootDir: string,
    private readonly lookup: GrokLookup = NO_LOOKUP,
  ) {
    this.resolver = new ProjectIdResolver(() => this.lookup.knownProjectIds());
  }

  /** `summary.json` and `updates.jsonl` of every session directory that has a `summary.json` (nothing else is listed). */
  async listFiles(): Promise<string[]> {
    let dirs: fs.Dirent[];
    try {
      dirs = await fsp.readdir(this.rootDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const d of dirs) {
      if (!d.isDirectory() || !validDir(d.name)) continue;
      let sessions: fs.Dirent[];
      try {
        sessions = await fsp.readdir(path.join(this.rootDir, d.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of sessions) {
        if (!s.isDirectory() || !validId(s.name)) continue;
        const at = path.join(this.rootDir, d.name, s.name);
        if (!(await isFile(path.join(at, SUMMARY)))) continue;
        out.push(path.join(at, SUMMARY));
        if (await isFile(path.join(at, UPDATES))) out.push(path.join(at, UPDATES));
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
    if (shape.kind === 'summary') {
      // Classified only when it exists and is small: the pipeline then reads it whole (an index file).
      try {
        const st = fs.statSync(this.pathOf(key)!);
        if (!st.isFile() || st.size > GROK_SUMMARY_MAX_BYTES) return null;
      } catch {
        return null;
      }
      return { kind: 'index', projectId: '', sessionId: '' };
    }
    const known = this.known(key);
    if (known !== null) return known;
    const summary = this.readSummary(shape);
    if (summary === null) return null; // not a session (yet)
    const projectId = this.project(shape.dir, summary).projectId;
    const cls: FileClass =
      summary.kind === 'subagent' && summary.parent !== null && summary.parent !== shape.id
        ? { kind: 'agent', projectId, sessionId: summary.parent, agentId: shape.id }
        : { kind: 'session', projectId, sessionId: shape.id };
    return this.remember(key, cls);
  }

  /** No key names the project: it is stored with each raw event. */
  projectOfKey(_key: string): string | null {
    return null;
  }

  projectOfTranscript(absPath: string): string | null {
    const key = this.keyOf(absPath);
    if (key === null || shapeOf(key)?.kind !== 'updates') return null;
    return this.known(key)?.projectId ?? null;
  }

  /** A main session's `updates.jsonl` (a subagent's belongs to its parent's session, whose main file is the parent's). */
  mainSessionOf(key: string): string | null {
    if (shapeOf(key)?.kind !== 'updates') return null;
    const known = this.known(key);
    return known?.kind === 'session' ? known.sessionId : null;
  }

  /** The summary entry of a main session's `summary.json` (none for a subagent's, or a damaged one). */
  indexEntries(key: string, content: string): IndexEntry[] {
    const shape = shapeOf(key);
    if (shape?.kind !== 'summary' || Buffer.byteLength(content) > GROK_SUMMARY_MAX_BYTES) return [];
    const summary = parseGrokSummary(content);
    if (summary === null || (summary.kind === 'subagent' && summary.parent !== null && summary.parent !== shape.id)) return [];
    const { projectId, cwd } = this.project(shape.dir, summary);
    const payload: GrokSummaryPayload = { title: summary.title, summary: summary.summary, model: summary.model, cwd, branch: summary.branch, createdAt: summary.createdAt };
    return [{ key: GROK_SUMMARY_ENTRY_PREFIX + shape.id, sessionId: shape.id, agentId: null, projectId, payload: JSON.stringify(payload) }];
  }

  // ---------------------------------------------------------------- internals

  /** Cached, else stored with the key's raw events (no read). */
  private known(key: string): FileClass | null {
    const cached = this.classes.get(key);
    if (cached !== undefined) return cached;
    const stored = this.lookup.storedFile(key);
    if (stored === null || stored.projectId === null) return null;
    const cls: FileClass =
      stored.agentId === null
        ? { kind: 'session', projectId: stored.projectId, sessionId: stored.sessionId }
        : { kind: 'agent', projectId: stored.projectId, sessionId: stored.sessionId, agentId: stored.agentId };
    return this.remember(key, cls);
  }

  private remember(key: string, cls: FileClass): FileClass {
    const existing = this.classes.get(key);
    if (existing !== undefined) return existing;
    this.classes.set(key, cls);
    if (cls.projectId !== UNKNOWN_PROJECT) this.resolver.note(cls.projectId);
    return cls;
  }

  private readSummary(shape: Shape): GrokSummary | null {
    return readSidecar(path.join(this.rootDir, shape.dir, shape.id, SUMMARY), GROK_SUMMARY_MAX_BYTES, parseGrokSummary);
  }

  /** The session's working directory (spec 5.2 order) and project id; never throws. */
  private project(dir: string, summary: GrokSummary): { projectId: string; cwd: string | null } {
    const raw = summary.cwd ?? decodeGrokDirName(dir) ?? readSidecar(path.join(this.rootDir, dir, DOT_CWD), GROK_CWD_MAX_BYTES, asWorkingDir);
    if (raw === null) return { projectId: UNKNOWN_PROJECT, cwd: null };
    const cwd = normaliseCwd(raw);
    return { projectId: this.resolver.forCwd(cwd), cwd };
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** An encoded working-directory name: not empty, not hidden, not one of our entry keys. */
const validDir = (s: string): boolean => s !== '' && !s.startsWith('.') && !s.startsWith('@');
/** A session id taken from a directory name: not empty, not hidden, no path syntax. */
const validId = (s: string): boolean => s !== '' && !s.startsWith('.') && !/[\\/:]/.test(s);

/** The shape of a key from its path alone, or null when it is none of this source's files. */
function shapeOf(key: string): Shape | null {
  if (!key.startsWith(PREFIX)) return null;
  const parts = key.slice(PREFIX.length).split('/');
  if (parts.length !== 3 || parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  const [dir, id, name] = parts as [string, string, string];
  if (!validDir(dir) || !validId(id)) return null;
  if (name === UPDATES) return { kind: 'updates', dir, id };
  if (name === SUMMARY) return { kind: 'summary', dir, id };
  return null;
}
