import fsp from 'node:fs/promises';
import path from 'node:path';
import { KEY_PREFIXES, type FileClass, type FileSource, type IndexEntry, type MaybePromise } from '../source.js';

const PREFIX = KEY_PREFIXES.codex;
/** Name of Codex's thread-title index, next to (not under) the sessions directory. */
const INDEX_NAME = 'session_index.jsonl';
/** Store key of the index file: `codex:` + its path relative to the sessions directory. */
export const CODEX_INDEX_KEY = `${PREFIX}../${INDEX_NAME}`;
/** Keys of the per-session index entries (meta raw events): `codex:index/<root thread id>`. */
const ENTRY_PREFIX = `${PREFIX}index/`;
const ROLLOUT = /^rollout-.+\.jsonl$/;
/** A first line longer than this is not a session_meta record we can use. */
const FIRST_LINE_MAX_BYTES = 16 * 1024 * 1024;
const CHUNK = 64 * 1024;
const NEWLINE = 0x0a;
const UNKNOWN_PROJECT = 'unknown';

/** What a rollout file belongs to, as stored with its raw events. */
export interface StoredThread {
  sessionId: string;
  agentId: string | null;
  projectId: string | null;
}

/** What the source may ask the store (never the file contents). */
export interface CodexLookup {
  /** Session, agent and project stored with the transcript raw events of a key; null when none are stored. */
  storedFile(key: string): StoredThread | null;
  /** Project ids already in use (any origin), for reusing one that differs only in letter case. */
  knownProjectIds(): Iterable<string>;
}

const NO_LOOKUP: CodexLookup = { storedFile: () => null, knownProjectIds: () => [] };

interface Thread {
  sessionId: string;
  agentId: string | null;
  projectId: string;
}

/** Claude Code's encoding of a working directory into a project id: every non-alphanumeric character becomes `-`. */
export const encodeProjectId = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

/**
 * Codex's `~/.codex/sessions`: one file per thread, `YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`, whose first line
 * (`session_meta`) says which session (root thread) the thread belongs to and in which directory it ran. Keys are
 * `codex:` + the path relative to the directory. The thread → session mapping is cached per file, taken from the stored
 * raw events when there are any (so a file that is gone, and every rebuild, keep the mapping and project they were
 * stored with), and otherwise read from the file's first line. The title index `../session_index.jsonl` is an index
 * file: one meta raw event per root thread this source has seen.
 */
export class CodexFileSource implements FileSource {
  readonly origin = 'codex' as const;
  readonly watchDepth = 4;
  private readonly indexPath: string;
  /** key -> what the file belongs to (never changes for a key). */
  private readonly files = new Map<string, Thread>();
  /** Root thread ids seen (from a first line or the store) -> project. */
  private readonly roots = new Map<string, string>();
  /** Lower-cased project id -> the project id in use. */
  private readonly projects = new Map<string, string>();

  constructor(
    readonly rootDir: string,
    private readonly lookup: CodexLookup = NO_LOOKUP,
  ) {
    this.indexPath = path.join(path.dirname(path.resolve(rootDir)), INDEX_NAME);
  }

  indexFiles(): readonly string[] {
    return [this.indexPath];
  }

  async listFiles(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fsp.readdir(this.rootDir, { recursive: true });
    } catch {
      return [];
    }
    const files = entries.map((rel) => path.join(this.rootDir, rel)).filter((abs) => this.keyOf(abs) !== null);
    try {
      if ((await fsp.stat(this.indexPath)).isFile()) files.push(this.indexPath);
    } catch {
      // no index yet
    }
    return files.sort();
  }

  keyOf(absPath: string): string | null {
    const rel = path.relative(this.rootDir, absPath);
    if (rel === '' || path.isAbsolute(rel)) return null;
    const parts = rel.split(/[\\/]+/).filter((p) => p !== '');
    if (parts.length === 2 && parts[0] === '..' && parts[1] === INDEX_NAME) return CODEX_INDEX_KEY;
    if (parts[0] === '..' || !ROLLOUT.test(parts[parts.length - 1]!)) return null;
    return PREFIX + parts.join('/');
  }

  pathOf(key: string): string | null {
    if (key === CODEX_INDEX_KEY) return this.indexPath;
    if (!this.isRolloutKey(key)) return null;
    return path.join(this.rootDir, ...key.slice(PREFIX.length).split('/'));
  }

  classify(key: string): MaybePromise<FileClass | null> {
    if (key === CODEX_INDEX_KEY) return { kind: 'index', projectId: '', sessionId: '' };
    if (!this.isRolloutKey(key)) return null;
    const known = this.known(key);
    if (known !== null) return toClass(known);
    return this.readFirstLine(key).then((thread) => (thread === null ? null : toClass(thread)));
  }

  /** The key names nothing about the project: it is stored with each raw event (from the file's first line). */
  projectOfKey(_key: string): string | null {
    return null;
  }

  projectOfTranscript(absPath: string): string | null {
    const key = this.keyOf(absPath);
    if (key === null || !this.isRolloutKey(key)) return null;
    return this.known(key)?.projectId ?? null;
  }

  /** A hook's project: the session's (root's) for a subagent's hook when known, else the cwd encoded as for a file. */
  projectOfHook(sessionId: string | null, cwd: string | null, agentId: string | null): string | null {
    const root = sessionId === null ? undefined : this.roots.get(sessionId);
    if (agentId !== null && root !== undefined) return root;
    if (cwd !== null && cwd !== '') return this.projectFor(cwd);
    return root ?? null;
  }

  mainSessionOf(key: string): string | null {
    if (!this.isRolloutKey(key)) return null;
    const thread = this.known(key);
    return thread !== null && thread.agentId === null ? thread.sessionId : null;
  }

  /**
   * One entry per root thread seen so far, from the last valid line naming it (`{ id, thread_name, updated_at }`);
   * lines of unknown or subagent threads are skipped (they are placed by a later call once the id is a known root).
   */
  indexEntries(_key: string, content: string): IndexEntry[] {
    const last = new Map<string, string>();
    for (const raw of content.split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (line.trim() === '') continue;
      let id: unknown;
      try {
        id = (JSON.parse(line) as { id?: unknown } | null)?.id;
      } catch {
        continue;
      }
      if (typeof id !== 'string' || id === '' || !this.roots.has(id)) continue;
      last.set(id, line); // in order of first occurrence, with the last line's content
    }
    return [...last].map(([id, payload]) => ({
      key: ENTRY_PREFIX + id,
      sessionId: id,
      agentId: null,
      projectId: this.roots.get(id)!,
      payload,
    }));
  }

  /** Grows with every newly seen root thread. */
  indexVersion(): number {
    return this.roots.size;
  }

  // ---------------------------------------------------------------- internals

  private isRolloutKey(key: string): boolean {
    return key.startsWith(PREFIX) && !key.startsWith(ENTRY_PREFIX) && key !== CODEX_INDEX_KEY && ROLLOUT.test(key.slice(key.lastIndexOf('/') + 1));
  }

  /** Cached, else stored with the file's raw events (no read). */
  private known(key: string): Thread | null {
    const cached = this.files.get(key);
    if (cached !== undefined) return cached;
    const stored = this.lookup.storedFile(key);
    if (stored === null || stored.projectId === null) return null;
    return this.remember(key, { sessionId: stored.sessionId, agentId: stored.agentId, projectId: stored.projectId });
  }

  private remember(key: string, thread: Thread): Thread {
    const existing = this.files.get(key);
    if (existing !== undefined) return existing; // a concurrent read got there first
    this.files.set(key, thread);
    const lower = thread.projectId.toLowerCase();
    if (!this.projects.has(lower)) this.projects.set(lower, thread.projectId);
    if (thread.agentId === null && !this.roots.has(thread.sessionId)) this.roots.set(thread.sessionId, thread.projectId);
    return thread;
  }

  /**
   * Reads the file's first line (`session_meta`). Null when the file does not exist; throws (an ingest failure the
   * pipeline reports) when the line is missing, incomplete or not a usable session_meta. Messages carry no content.
   */
  private async readFirstLine(key: string): Promise<Thread | null> {
    const abs = this.pathOf(key)!;
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(abs, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    let first: string;
    try {
      const chunks: Buffer[] = [];
      let total = 0;
      let found = -1;
      for (;;) {
        const buf = Buffer.alloc(CHUNK);
        const { bytesRead } = await handle.read(buf, 0, CHUNK, total);
        if (bytesRead === 0) break;
        const part = buf.subarray(0, bytesRead);
        const nl = part.indexOf(NEWLINE);
        if (nl !== -1) {
          chunks.push(part.subarray(0, nl));
          found = total + nl;
          break;
        }
        chunks.push(part);
        total += bytesRead;
        if (total > FIRST_LINE_MAX_BYTES) throw new Error('codex rollout: first line too long');
      }
      if (found === -1) throw new Error(total === 0 ? 'codex rollout: first line missing (empty file)' : 'codex rollout: first line incomplete');
      first = Buffer.concat(chunks).toString('utf8').replace(/\r$/, '');
    } finally {
      await handle.close();
    }
    let record: unknown;
    try {
      record = JSON.parse(first);
    } catch {
      throw new Error('codex rollout: first line is not JSON');
    }
    const type = isObject(record) && typeof record.type === 'string' ? record.type : typeof record;
    if (type !== 'session_meta' || !isObject(record) || !isObject(record.payload)) {
      throw new Error(`codex rollout: first line is not session_meta (type: ${type.slice(0, 64)})`);
    }
    const meta = record.payload;
    const id = nonEmpty(meta.id);
    if (id === null) throw new Error('codex rollout: session_meta without an id');
    const parent = nonEmpty(meta.parent_thread_id);
    const sessionId = nonEmpty(meta.session_id) ?? (parent === null ? id : (this.rootOfThread(parent) ?? parent));
    const agentId = sessionId === id ? null : id;
    const cwd = nonEmpty(meta.cwd);
    const projectId = agentId !== null ? (this.roots.get(sessionId) ?? this.projectFor(cwd)) : this.projectFor(cwd);
    return this.remember(key, { sessionId, agentId, projectId });
  }

  /** The session of a known thread id (a parent named by an old-style session_meta without session_id). */
  private rootOfThread(threadId: string): string | null {
    if (this.roots.has(threadId)) return threadId;
    for (const t of this.files.values()) if (t.agentId === threadId) return t.sessionId;
    return null;
  }

  /** The encoded cwd, or a project id already in use that differs from it only in letter case. */
  private projectFor(cwd: string | null): string {
    if (cwd === null) return UNKNOWN_PROJECT;
    const id = encodeProjectId(cwd);
    const lower = id.toLowerCase();
    let hit = this.projects.get(lower);
    if (hit === undefined) {
      for (const known of this.lookup.knownProjectIds()) {
        const l = known.toLowerCase();
        if (!this.projects.has(l)) this.projects.set(l, known);
      }
      hit = this.projects.get(lower);
    }
    if (hit !== undefined) return hit;
    this.projects.set(lower, id);
    return id;
  }
}

const toClass = (t: Thread): FileClass =>
  t.agentId === null
    ? { kind: 'session', projectId: t.projectId, sessionId: t.sessionId }
    : { kind: 'agent', projectId: t.projectId, sessionId: t.sessionId, agentId: t.agentId };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
