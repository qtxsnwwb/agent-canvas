import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { normaliseCwd } from '../cursor/project.js';
import { readGuardedLines } from '../guarded-reader.js';
import { ProjectIdResolver } from '../project-ids.js';
import { isPromise, KEY_PREFIXES, type FileClass, type FileSource, type MaybePromise } from '../source.js';

const CHATS = 'chats';
const ARCHIVE = 'archive';
const SUBAGENTS = 'subagents';
const JSONL = '.jsonl';
const TITLE = '.title.json';
const META = '.meta.json';
const AGENT_PREFIX = 'agent-';
/** A session id: Qwen Code's own rule for transcript names (reference 1.2). */
const SESSION_ID = /^[0-9a-fA-F-]{32,36}$/;
/** An agent file's stem: the agent id with every character outside `[a-zA-Z0-9_-]` replaced (reference 5.2). */
const AGENT_STEM = /^[A-Za-z0-9_-]+$/;
/** `<repo>/.qwen/worktrees/<x>[/…]`, either separator (reference 1.2; spec 3.3). */
const WORKTREE = /^(.*?)([\\/])\.qwen[\\/]worktrees[\\/]+[^\\/]+(?:[\\/].*)?$/;
/** Bytes of a session file's head looked at to classify it (spec 3.4). */
export const QWEN_HEAD_BYTES = 64 * 1024;
const MANAGED_HEADER = 'managed_session_header_v1';
/** The owner record that may precede a managed header (reference 4.6): it does not decide a session's class. */
const EXECUTION_ENGINE = 'session_execution_engine';
const RECORD_TYPES = new Set(['user', 'assistant', 'tool_result', 'system']);
const MANAGED = Symbol('managed');

/** What the source may ask the store (never file contents). */
export interface QwenLookup {
  /** Session, agent and project stored with the transcript raw events of a key; null when none are stored. */
  storedFile(key: string): { sessionId: string; agentId: string | null; projectId: string | null } | null;
  /** Project ids already in use (any origin), for reusing one that differs only in letter case. */
  knownProjectIds(): Iterable<string>;
}

const NO_LOOKUP: QwenLookup = { storedFile: () => null, knownProjectIds: () => [] };

/** `<repo>/.qwen/worktrees/<x>[/…]` → `<repo>`; anything else unchanged (either separator). */
export function qwenProjectDir(cwd: string): string {
  const m = WORKTREE.exec(cwd);
  if (m === null) return cwd;
  const repo = m[1]!;
  const sep = m[2]!;
  if (repo === '') return sep; // `/.qwen/worktrees/x`
  if (/^[A-Za-z]:$/.test(repo)) return repo + sep; // `C:\.qwen\worktrees\x`
  return repo;
}

/** A file of the source, from its path below the projects directory (or from its key). */
type Shape =
  | { kind: 'session' | 'title'; proj: string; sid: string; name: string; archived: boolean }
  | { kind: 'agent' | 'agent_meta'; proj: string; sid: string; name: string; stem: string };

/** Why a session file was last found unclassifiable: its size and modification time then. */
interface Unplaced {
  size: number;
  mtimeMs: number;
  /** The head was full (QWEN_HEAD_BYTES of it seen): only a rewrite to a shorter file makes it worth reading again. */
  exhausted: boolean;
}

/**
 * Qwen Code's session files (spec 2, 3; format reference 1, 4.4, 4.6, 5.2), under `<qwenDir>/projects`:
 *
 * - `<p>/chats/<sid>.jsonl` and `<p>/chats/archive/<sid>.jsonl`: a session's main thread; `<sid>.title.json` beside
 *   either: its title sidecar. An archived file has the key of its place in `chats/` (`qwen:<p>/chats/<name>`), so
 *   archiving and unarchiving (a rename) neither re-read, duplicate nor flag the session as source-deleted: the pipeline
 *   keeps the key's offset, reader guard, size and modification time, and the full scan's listing still names the key.
 *   pathOf finds the file in `chats/` first, then in `chats/archive/`. While both copies exist, `chats/` wins by rule
 *   (never by listing order): only it is listed, and keyOf disowns the archived copy, so an event for it reads nothing.
 * - `<p>/subagents/<sid>/agent-<x>.jsonl`: a subagent thread of session `<sid>` (agent id `<x>`, the file name's form of
 *   it); `agent-<x>.meta.json`: its sidecar.
 * - Everything else (`.runtime.json`, `.worktree.json`, `.pr.json`, `.jsonl.stream`, `workflows/`, `tmp/`) is not ours.
 *
 * A session's project (spec 3.3) comes from the head of its main file (at most QWEN_HEAD_BYTES, complete lines only):
 * the `cwd` of the first valid record of the session (a `session_execution_engine` record alone does not decide), as
 * `qwenProjectDir` of it, through the resolver shared with DeepSeek / WorkBuddy / CodeBuddy. A head holding a
 * `managed_session_header_v1` record is a managed session (spec 3.4): nothing of it is read (title and subagent files
 * neither) and it is counted in status().unsupportedSessions (once per session key, however often it is seen; no longer
 * once its file is gone). The project directory name is never decoded. Subagent files and sidecars take their session's
 * class; while the session cannot be told yet (no valid record), neither can they. Classes are cached per key, and taken
 * from the stored raw events when there are any. Nothing is ever written under the tool directory.
 */
export class QwenFileSource implements FileSource {
  readonly origin = 'qwen' as const;
  readonly rootDir: string;
  /** Reaches `<p>/chats/archive/<file>` and `<p>/subagents/<sid>/<file>` (three directories below the root). */
  readonly watchDepth = 3;
  /** Lines are told apart by their byte offset: the file is appended to, and a message-group deletion is a rewrite. */
  readonly lineIdentity = 'offset' as const;
  readonly readLines = readGuardedLines;
  private readonly prefix = KEY_PREFIXES.qwen;
  private readonly lookup: QwenLookup;
  private readonly resolver: ProjectIdResolver;
  /** Session-file key -> its class, once decided. */
  private readonly classes = new Map<string, FileClass>();
  /** Session-file keys of managed sessions. */
  private readonly managed = new Set<string>();
  /** Session-file key -> what the last look at its head found (nothing that decides). */
  private readonly unplaced = new Map<string, Unplaced>();

  /**
   * `projects`: the project-id resolver shared with the other sources of plan more-sources-cn (fileSources), so one
   * directory spelled in two letter cases is one project; default: its own.
   */
  constructor(projectsDir: string, lookup?: QwenLookup, projects?: ProjectIdResolver) {
    this.rootDir = projectsDir;
    this.lookup = lookup ?? NO_LOOKUP;
    this.resolver = projects ?? new ProjectIdResolver(() => this.lookup.knownProjectIds());
  }

  /** Managed sessions seen (and still listed): recognised, not shown. */
  status(): { unsupportedSessions: number } {
    return { unsupportedSessions: this.managed.size };
  }

  /** Every file of the source (sorted); a session or title in both `chats/` and `chats/archive/` only once, from `chats/`. */
  async listFiles(): Promise<string[]> {
    const out: string[] = [];
    const sessionKeys = new Set<string>();
    for (const proj of await names(this.rootDir, 'dir')) {
      if (!validName(proj)) continue;
      const chats = path.join(this.rootDir, proj, CHATS);
      const inChats = new Set<string>();
      for (const name of await names(chats, 'file')) {
        const shape = chatShape(proj, name, false);
        if (shape === null) continue;
        inChats.add(name);
        if (shape.kind === 'session') sessionKeys.add(this.keyFor(shape));
        out.push(path.join(chats, name));
      }
      for (const name of await names(path.join(chats, ARCHIVE), 'file')) {
        const shape = chatShape(proj, name, true);
        if (shape === null || inChats.has(name)) continue;
        if (shape.kind === 'session') sessionKeys.add(this.keyFor(shape));
        out.push(path.join(chats, ARCHIVE, name));
      }
      const subagents = path.join(this.rootDir, proj, SUBAGENTS);
      for (const sid of await names(subagents, 'dir')) {
        if (!SESSION_ID.test(sid)) continue;
        for (const name of await names(path.join(subagents, sid), 'file')) {
          if (agentShape(proj, sid, name) !== null) out.push(path.join(subagents, sid, name));
        }
      }
    }
    // A managed session whose file is gone is no longer counted.
    for (const key of [...this.managed]) if (!sessionKeys.has(key)) this.managed.delete(key);
    return out.sort();
  }

  keyOf(absPath: string): string | null {
    const rel = path.relative(this.rootDir, absPath);
    if (rel === '' || path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) return null;
    const shape = shapeOfParts(rel.split(/[\\/]+/));
    if (shape === null) return null;
    // Both copies present: the one in chats/ is the key's file; the archived one is not read.
    if ((shape.kind === 'session' || shape.kind === 'title') && shape.archived && exists(this.chatsPath(shape))) return null;
    return this.keyFor(shape);
  }

  pathOf(key: string): string | null {
    const shape = this.shapeOfKey(key);
    if (shape === null) return null;
    if (shape.kind === 'agent' || shape.kind === 'agent_meta') return path.join(this.rootDir, shape.proj, SUBAGENTS, shape.sid, shape.name);
    const chats = this.chatsPath(shape);
    if (exists(chats)) return chats;
    const archived = path.join(this.rootDir, shape.proj, CHATS, ARCHIVE, shape.name);
    return exists(archived) ? archived : chats;
  }

  classify(key: string): MaybePromise<FileClass | null> {
    const shape = this.shapeOfKey(key);
    if (shape === null) return null;
    if (shape.kind === 'session') return this.classifySession(key, shape.sid);
    const sessionKey = `${this.prefix}${shape.proj}/${CHATS}/${shape.sid}${JSONL}`;
    const kind = shape.kind;
    const agentId = 'stem' in shape ? shape.stem : undefined;
    const derive = (session: FileClass | null): FileClass | null => {
      if (session === null) return null;
      const { projectId, sessionId } = session;
      return agentId === undefined ? { kind, projectId, sessionId } : { kind, projectId, sessionId, agentId };
    };
    const session = this.classifySession(sessionKey, shape.sid);
    return isPromise(session) ? session.then(derive) : derive(session);
  }

  /** No key names the project: it is stored with each raw event. */
  projectOfKey(_key: string): string | null {
    return null;
  }

  projectOfTranscript(absPath: string): string | null {
    const key = this.keyOf(absPath);
    const shape = key === null ? null : this.shapeOfKey(key);
    if (shape === null) return null;
    return this.known(`${this.prefix}${shape.proj}/${CHATS}/${shape.sid}${JSONL}`, shape.sid)?.projectId ?? null;
  }

  /** The session of a main-thread key whose class is known (a managed session has none). */
  mainSessionOf(key: string): string | null {
    const shape = this.shapeOfKey(key);
    if (shape?.kind !== 'session') return null;
    return this.known(key, shape.sid)?.sessionId ?? null;
  }

  // ---------------------------------------------------------------- internals

  private keyFor(shape: Shape): string {
    const rel = shape.kind === 'session' || shape.kind === 'title' ? `${CHATS}/${shape.name}` : `${SUBAGENTS}/${shape.sid}/${shape.name}`;
    return `${this.prefix}${shape.proj}/${rel}`;
  }

  /** The file a key names (never an archived place: keys name `chats/`), or null when it is not one of this source's. */
  private shapeOfKey(key: string): Shape | null {
    if (!key.startsWith(this.prefix)) return null;
    const shape = shapeOfParts(key.slice(this.prefix.length).split('/'));
    if (shape === null || ((shape.kind === 'session' || shape.kind === 'title') && shape.archived)) return null;
    return shape;
  }

  private chatsPath(shape: { proj: string; name: string }): string {
    return path.join(this.rootDir, shape.proj, CHATS, shape.name);
  }

  /** Cached, else stored with the key's raw events (no read). */
  private known(key: string, sid: string): FileClass | null {
    const cached = this.classes.get(key);
    if (cached !== undefined) return cached;
    const stored = this.lookup.storedFile(key);
    if (stored === null || stored.agentId !== null || stored.projectId === null || stored.sessionId !== sid) return null;
    return this.remember(key, { kind: 'session', projectId: stored.projectId, sessionId: sid });
  }

  /** A main thread: known, managed (null), or decided by its head (null while nothing in it decides). */
  private classifySession(key: string, sid: string): MaybePromise<FileClass | null> {
    const known = this.known(key, sid);
    if (known !== null) return known;
    if (this.managed.has(key)) return null;
    return this.readHead(key, sid);
  }

  private async readHead(key: string, sid: string): Promise<FileClass | null> {
    const file = this.pathOf(key)!;
    let st: fs.Stats;
    try {
      st = await fsp.stat(file);
    } catch {
      return null;
    }
    const was = this.unplaced.get(key);
    if (was !== undefined && was.size === st.size && was.mtimeMs === st.mtimeMs) return null;
    if (was?.exhausted === true && st.size >= was.size) return null;
    let lines: string[];
    try {
      lines = await headLines(file, QWEN_HEAD_BYTES);
    } catch {
      return null;
    }
    const verdict = inspectHead(lines, sid);
    if (verdict === MANAGED) {
      this.unplaced.delete(key);
      this.managed.add(key);
      return null;
    }
    if (verdict === null) {
      this.unplaced.set(key, { size: st.size, mtimeMs: st.mtimeMs, exhausted: st.size >= QWEN_HEAD_BYTES });
      return null;
    }
    this.unplaced.delete(key);
    // Classified meanwhile by another call (the same answer): keep the first.
    return this.classes.get(key) ?? this.remember(key, { kind: 'session', projectId: this.project(verdict.cwd), sessionId: sid });
  }

  private remember(key: string, cls: FileClass): FileClass {
    this.classes.set(key, cls);
    this.resolver.note(cls.projectId);
    return cls;
  }

  /** Project id of a session's cwd (a Qwen Code worktree counts as its repository). */
  private project(cwd: string): string {
    return this.resolver.forCwd(normaliseCwd(qwenProjectDir(normaliseCwd(cwd))));
  }
}

/** `<p>/chats[/archive]/<name>`: a session or title file, or null. */
function chatShape(proj: string, name: string, archived: boolean): Shape | null {
  for (const [ext, kind] of [[JSONL, 'session'], [TITLE, 'title']] as const) {
    if (!name.endsWith(ext)) continue;
    const sid = name.slice(0, -ext.length);
    return SESSION_ID.test(sid) ? { kind, proj, sid, name, archived } : null;
  }
  return null;
}

/** `<p>/subagents/<sid>/<name>`: a subagent thread or its sidecar, or null. */
function agentShape(proj: string, sid: string, name: string): Shape | null {
  if (!SESSION_ID.test(sid) || !name.startsWith(AGENT_PREFIX)) return null;
  for (const [ext, kind] of [[JSONL, 'agent'], [META, 'agent_meta']] as const) {
    if (!name.endsWith(ext)) continue;
    const stem = name.slice(AGENT_PREFIX.length, -ext.length);
    return AGENT_STEM.test(stem) ? { kind, proj, sid, name, stem } : null;
  }
  return null;
}

/** A path below the projects directory, split into its parts. */
function shapeOfParts(parts: readonly string[]): Shape | null {
  const [proj, dir] = parts;
  if (proj === undefined || !validName(proj)) return null;
  if (dir === CHATS) {
    if (parts.length === 3) return chatShape(proj, parts[2]!, false);
    if (parts.length === 4 && parts[2] === ARCHIVE) return chatShape(proj, parts[3]!, true);
    return null;
  }
  if (dir === SUBAGENTS && parts.length === 4) return agentShape(proj, parts[2]!, parts[3]!);
  return null;
}

/**
 * What a session file's head says: MANAGED when it holds a managed-session header; else the `cwd` of the first valid
 * record of the session (not a `session_execution_engine` record); null when nothing decides yet.
 */
function inspectHead(lines: readonly string[], sid: string): typeof MANAGED | { cwd: string } | null {
  let cwd: string | null = null;
  for (const text of lines) {
    let rec: unknown;
    try {
      rec = JSON.parse(text);
    } catch {
      continue;
    }
    if (typeof rec !== 'object' || rec === null || Array.isArray(rec)) continue;
    const r = rec as Record<string, unknown>;
    if (r.subtype === MANAGED_HEADER) return MANAGED;
    if (cwd !== null || !isValidRecord(r, sid) || r.subtype === EXECUTION_ENGINE) continue;
    if (typeof r.cwd === 'string' && r.cwd.trim() !== '') cwd = r.cwd;
  }
  return cwd === null ? null : { cwd };
}

/** A record the normaliser would take (spec 4): string uuid, the file's session, a string or null parent, a known type. */
function isValidRecord(r: Record<string, unknown>, sid: string): boolean {
  return typeof r.uuid === 'string' && r.sessionId === sid && (typeof r.parentUuid === 'string' || r.parentUuid === null) && RECORD_TYPES.has(r.type as string);
}

/** The complete lines within the first `limit` bytes of a file. */
async function headLines(file: string, limit: number): Promise<string[]> {
  const handle = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(limit);
    let done = 0;
    while (done < limit) {
      const { bytesRead } = await handle.read(buf, done, limit - done, done);
      if (bytesRead === 0) break;
      done += bytesRead;
    }
    const head = buf.subarray(0, done);
    const end = head.lastIndexOf(10);
    if (end === -1) return [];
    return head
      .subarray(0, end)
      .toString('utf8')
      .split('\n')
      .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  } finally {
    await handle.close();
  }
}

/** A directory name: not empty, not `.` or `..`, no path syntax. */
function validName(s: string): boolean {
  return s !== '' && s !== '.' && s !== '..' && !/[\\/:]/.test(s);
}

function exists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Names of the subdirectories or files of `dir` (none when it cannot be read). */
async function names(dir: string, kind: 'dir' | 'file'): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => (kind === 'dir' ? e.isDirectory() : e.isFile())).map((e) => e.name);
}
