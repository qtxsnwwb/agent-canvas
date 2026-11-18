import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { normaliseCwd } from '../cursor/project.js';
import { readGuardedLines } from '../guarded-reader.js';
import { ProjectIdResolver } from '../project-ids.js';
import { isPromise, KEY_PREFIXES, type FileClass, type FileSource, type MaybePromise, type SourceRead } from '../source.js';

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
/**
 * Longest line the classification looks at (spec 3.3): a longer one (a first prompt carrying `@`-referenced files) is
 * passed over without being held; the next record carries the same `cwd`.
 */
export const QWEN_LINE_MAX = 64 * 1024;
/** Most bytes one classification attempt reads; the next attempt goes on from where it stopped. */
export const QWEN_SCAN_BUDGET = 4 * 1024 * 1024;
const CHUNK = 64 * 1024;
const MANAGED_HEADER = 'managed_session_header_v1';
const MANAGED_PREFIX = 'managed_session_';
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

/**
 * Where the search of a session file not classified yet stopped. Every byte is examined once: the next attempt goes on
 * from `next`, with the incomplete last line's bytes (at most QWEN_LINE_MAX) held here, or passing over the rest of an
 * over-long one.
 */
interface Search {
  /** Bytes of the file consumed so far. */
  next: number;
  /** The incomplete line read so far (empty while skipping). */
  held: Buffer[];
  heldBytes: number;
  /** `next` is inside a line longer than QWEN_LINE_MAX: pass over the rest of it. */
  skipping: boolean;
  /**
   * The first-record rule (spec 3.4, reference 4.6): `start` before any record, `engine` after a leading
   * `session_execution_engine` record, `decided` once the first record (after it) was neither a managed header nor that.
   */
  first: 'start' | 'engine' | 'decided';
  /** Size and modification time the last attempt saw (an unchanged file is not opened again). */
  size: number;
  mtimeMs: number;
}

const newSearch = (): Search => ({ next: 0, held: [], heldBytes: 0, skipping: false, first: 'start', size: -1, mtimeMs: -1 });

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
 * A session's project (spec 3.3) is the `cwd` of the first valid record of the session in its main file that is not
 * longer than QWEN_LINE_MAX (every record carries the same `cwd`; a longer line is passed over unread, see Search), as
 * `qwenProjectDir` of it, through the resolver shared with DeepSeek / WorkBuddy / CodeBuddy. A file whose first record
 * (after one optional `session_execution_engine` record) is `managed_session_header_v1` is a managed session (spec 3.4):
 * nothing of it is read (title and subagent files neither) and it is counted in status().unsupportedSessions (once per
 * session key, however often it is seen; no longer once its file is gone). A header anywhere later does not count, so an
 * incremental read and a fresh one agree. The project directory name is never decoded. Subagent files and sidecars take their session's
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
  /** readGuardedLines, except that a file gone at the path read keeps its offset (see readMoved). */
  readonly readLines = (absPath: string, fromOffset: number, maxBytes: number, state: string | null): Promise<SourceRead> =>
    this.readMoved(absPath, fromOffset, maxBytes, state);
  private readonly prefix = KEY_PREFIXES.qwen;
  private readonly lookup: QwenLookup;
  private readonly resolver: ProjectIdResolver;
  /** Session-file key -> its class, once decided. */
  private readonly classes = new Map<string, FileClass>();
  /** Session-file keys of managed sessions. */
  private readonly managed = new Set<string>();
  /** Session-file key -> where the search of a file not classified yet stopped. */
  private readonly searches = new Map<string, Search>();
  /** Session-file key -> the classification attempt in progress (one at a time per file: it moves its Search on). */
  private readonly attempts = new Map<string, Promise<FileClass | null>>();

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
    const shape = this.shapeOfPath(absPath);
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

  /** The file a path names below the projects directory, from the path alone. */
  private shapeOfPath(absPath: string): Shape | null {
    const rel = path.relative(this.rootDir, absPath);
    if (rel === '' || path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) return null;
    return shapeOfParts(rel.split(/[\\/]+/));
  }

  /**
   * readGuardedLines at `absPath`; when the file is gone there (moved between the pipeline's stat and this read, or
   * deleted), read once more where its key leads now (it may have just been archived or unarchived), else answer the
   * offset given, no lines, no rewrite. readGuardedLines answers offset 0 for a missing file, which the pipeline would
   * store: the next read would then start at 0 without the guard, and a rewrite made meanwhile (a deleted last message
   * group) would go unnoticed for good.
   */
  private async readMoved(absPath: string, fromOffset: number, maxBytes: number, state: string | null): Promise<SourceRead> {
    const res = await readGuardedLines(absPath, fromOffset, maxBytes, state);
    if (!vanished(res, absPath, fromOffset)) return res;
    const shape = this.shapeOfPath(absPath);
    const now = shape === null ? null : this.pathOf(this.keyFor(shape));
    if (now !== null && now !== absPath) {
      const moved = await readGuardedLines(now, fromOffset, maxBytes, state);
      if (!vanished(moved, now, fromOffset)) return moved;
    }
    return { lines: [], newOffset: fromOffset, truncated: false };
  }

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

  /** A main thread: known, managed (null), or decided by searching its file (null while nothing in it decides). */
  private classifySession(key: string, sid: string): MaybePromise<FileClass | null> {
    const known = this.known(key, sid);
    if (known !== null) return known;
    if (this.managed.has(key)) return null;
    const running = this.attempts.get(key);
    if (running !== undefined) return running;
    const attempt = this.searchFile(key, sid).finally(() => this.attempts.delete(key));
    this.attempts.set(key, attempt);
    return attempt;
  }

  /** One attempt (at most QWEN_SCAN_BUDGET bytes) of the search of a session file, from where the last one stopped. */
  private async searchFile(key: string, sid: string): Promise<FileClass | null> {
    const file = this.pathOf(key)!;
    let st: fs.Stats;
    try {
      st = await fsp.stat(file);
    } catch {
      return null;
    }
    let search = this.searches.get(key);
    if (search !== undefined && search.size === st.size && search.mtimeMs === st.mtimeMs && search.next >= st.size) return null;
    // Found shorter than what was consumed: rewritten, searched again from the start.
    if (search === undefined || st.size < search.next) this.searches.set(key, (search = newSearch()));
    search.size = st.size;
    search.mtimeMs = st.mtimeMs;
    let verdict: Verdict;
    try {
      verdict = await searchLines(file, search, sid);
    } catch {
      return null; // unreadable now: the next attempt goes on from where this one was before it
    }
    if (verdict === null) return null;
    this.searches.delete(key);
    if (verdict === MANAGED) {
      this.managed.add(key);
      return null;
    }
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

type Verdict = typeof MANAGED | { cwd: string } | null;

/**
 * One attempt of the search (see Search), reading from `search.next` to at most QWEN_SCAN_BUDGET bytes further, in
 * CHUNK slices; moves `search` on. A line longer than QWEN_LINE_MAX is passed over without being held. Memory: one
 * chunk plus at most QWEN_LINE_MAX held bytes. On a read error `search` is left as it was.
 */
async function searchLines(file: string, search: Search, sid: string): Promise<Verdict> {
  const handle = await fsp.open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    const s: Search = { ...search, held: [...search.held] };
    const end = Math.min(size, s.next + QWEN_SCAN_BUDGET);
    const buf = Buffer.alloc(CHUNK);
    let verdict: Verdict = null;
    let pos = s.next;
    scan: while (pos < end) {
      const { bytesRead } = await handle.read(buf, 0, Math.min(CHUNK, end - pos), pos);
      if (bytesRead <= 0) break;
      const chunk = buf.subarray(0, bytesRead);
      let i = 0;
      while (i < bytesRead) {
        const nl = chunk.indexOf(10, i);
        const stop = nl === -1 ? bytesRead : nl;
        if (!s.skipping) {
          if (s.heldBytes + (stop - i) > QWEN_LINE_MAX) {
            s.skipping = true;
            s.held = [];
            s.heldBytes = 0;
            // A managed header is a small wrapper record: an over-long first record is not one, the file is plain.
            if (s.first !== 'decided') s.first = 'decided';
          } else if (stop > i) {
            s.held.push(Buffer.from(chunk.subarray(i, stop)));
            s.heldBytes += stop - i;
          }
        }
        if (nl === -1) break;
        if (!s.skipping) verdict = examine(Buffer.concat(s.held, s.heldBytes).toString('utf8'), s, sid);
        s.held = [];
        s.heldBytes = 0;
        s.skipping = false;
        i = nl + 1;
        if (verdict !== null) {
          pos += i;
          break scan;
        }
      }
      pos += bytesRead;
    }
    s.next = pos;
    Object.assign(search, s);
    return verdict;
  } finally {
    await handle.close();
  }
}

/**
 * One complete line (not over-long): MANAGED when it is the file's first record (after one optional leading
 * `session_execution_engine` record) and a managed-session header; `{ cwd }` when it is a valid record of the session
 * with a `cwd` (neither an engine record nor a managed wrapper); null otherwise. Moves the first-record rule on.
 */
function examine(line: string, s: Search, sid: string): Verdict {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (text.trim() === '') return null;
  let rec: unknown;
  try {
    rec = JSON.parse(text);
  } catch {
    rec = null;
  }
  const r = typeof rec === 'object' && rec !== null && !Array.isArray(rec) ? (rec as Record<string, unknown>) : null;
  if (s.first !== 'decided') {
    if (r?.subtype === MANAGED_HEADER) return MANAGED;
    if (s.first === 'start' && r?.subtype === EXECUTION_ENGINE) {
      s.first = 'engine';
      return null;
    }
    s.first = 'decided';
  }
  if (r === null || !isValidRecord(r, sid) || r.subtype === EXECUTION_ENGINE) return null;
  if (typeof r.subtype === 'string' && r.subtype.startsWith(MANAGED_PREFIX)) return null;
  return typeof r.cwd === 'string' && r.cwd.trim() !== '' ? { cwd: r.cwd } : null;
}

/**
 * Whether readGuardedLines found no file: it then answers offset 0, no lines, no rewrite. For an existing file an offset
 * above 0 gives a rewrite or a position at or past it, so above 0 that answer means the file is missing; at 0 it is
 * checked.
 */
function vanished(res: SourceRead, absPath: string, fromOffset: number): boolean {
  if (res.lines.length > 0 || res.newOffset !== 0 || res.truncated) return false;
  return fromOffset > 0 || !exists(absPath);
}

/** A record the normaliser would take (spec 4): string uuid, the file's session, a string or null parent, a known type. */
function isValidRecord(r: Record<string, unknown>, sid: string): boolean {
  return typeof r.uuid === 'string' && r.sessionId === sid && (typeof r.parentUuid === 'string' || r.parentUuid === null) && RECORD_TYPES.has(r.type as string);
}

/** A directory name: not empty, not `.` or `..`, no path syntax. */
function validName(s: string): boolean {
  return s !== '' && s !== '.' && s !== '..' && !/[\\/:]/.test(s);
}

/** Whether `p` is a file now (no exception for a missing one: keyOf asks this for every archived path). */
function exists(p: string): boolean {
  try {
    return fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
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
