import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { normaliseCwd } from '../cursor/project.js';
import { isExistingDir } from '../dirs.js';
import { ProjectIdResolver } from '../project-ids.js';
import { readBuddyLines } from './line-guard.js';
import { KEY_PREFIXES, type FileClass, type FileSource, type MaybePromise } from '../source.js';

/** Where the transcripts are below a tool directory (`<configDir>/projects`, format reference 1.1). */
const PROJECTS = 'projects';
const SUBAGENTS = 'subagents';
const JSONL = '.jsonl';
const UNKNOWN_PROJECT = 'unknown';
/** A main session's id (format reference 1.4: the file stem is a UUID). */
const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
/** A subagent's store id (its file stem). */
const AGENT_PREFIX = 'agent-';
/** WorkBuddy's per-session working folder name (spec 4.7, 10.12). */
const STAMP = /^(.*?)([\\/]+)(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})[\\/]*$/;
/** Most links followed from a nested subagent up to its root session. */
export const BUDDY_CHAIN_MAX = 16;
/** Most bytes of a file's head scanned for the first `cwd` (in all, across scans). */
export const BUDDY_HEAD_MAX_BYTES = 16 * 1024 * 1024;
/** A line longer than this is skipped while scanning the head, never held in memory (its successor has a cwd too). */
export const BUDDY_HEAD_LINE_MAX = 1024 * 1024;
const CHUNK = 64 * 1024;

/** What the source may ask the store (never file contents). */
export interface BuddyLookup {
  /** Session, agent and project stored with the transcript raw events of a key; null when none are stored. */
  storedFile(key: string): { sessionId: string; agentId: string | null; projectId: string | null } | null;
  /** Project ids already in use (any origin), for reusing one that differs only in letter case. */
  knownProjectIds(): Iterable<string>;
}

const NO_LOOKUP: BuddyLookup = { storedFile: () => null, knownProjectIds: () => [] };

/** `…/2026-10-27-13-46-52` → its parent directory; anything else unchanged. */
export function workbuddyProjectDir(cwd: string): string {
  const m = STAMP.exec(cwd);
  if (m === null) return cwd;
  const parent = m[1]!;
  const sep = m[2]![0]!;
  if (parent === '') return sep; // `/2026-…`
  if (/^[A-Za-z]:$/.test(parent)) return parent + sep; // `C:\2026-…`
  return parent;
}

/**
 * The roots of one origin, labelled for the store keys: each configured tool directory (empty entries skipped), in
 * configured order, labelled with its name without leading dots (`.workbuddy` → `workbuddy`); a label that would be
 * empty, unusable in a key or taken by an earlier root gets `~2`, `~3`, … appended. Labelling every configured root
 * (present or not) keeps a root's label the same whether the others exist.
 */
export function buddyRootsOf(dirs: readonly (string | null)[]): { label: string; dir: string }[] {
  const out: { label: string; dir: string }[] = [];
  const taken = new Set<string>();
  for (const dir of dirs) {
    if (dir === null || dir === '') continue;
    let base = path.basename(dir).replace(/^\.+/, '');
    if (!validName(base)) base = 'root';
    let label = base;
    for (let n = 2; taken.has(label); n++) label = `${base}~${n}`;
    taken.add(label);
    out.push({ label, dir });
  }
  return out;
}

/** A key's file, from its path alone. */
type Shape =
  | { kind: 'main'; label: string; proj: string; sid: string }
  | { kind: 'agent'; label: string; proj: string; parent: string; agent: string };

/** Why a main file was last found without a cwd: its size and modification time then, and where the scan stopped. */
interface Unplaced {
  size: number;
  mtimeMs: number;
  /** Byte position after the last complete line scanned (the next scan of a grown file starts there). */
  next: number;
  /** The scan reached BUDDY_HEAD_MAX_BYTES: nothing but a rewrite (the file found shorter) makes it scan again. */
  exhausted: boolean;
}

/**
 * WorkBuddy's and CodeBuddy Code's transcripts (spec 4.1, format reference 1): under each root's `projects`,
 * `<project>/<session uuid>.jsonl` is a session's main file, `<project>/<parent>/subagents/agent-*.jsonl` a subagent
 * thread (agent id = the file stem, the string the parent's Agent result names in `toolResult.subAgent.sessionId`).
 * `<parent>` is the session id, or for a nested subagent the store id of the subagent that spawned it, followed up to
 * the root session (spec 10.11). Every other file (`.meta.json` sidecars, `tool-results/`, tombstone names, anything
 * outside `projects` such as `workbuddy.db` and `traces/`) is not this source's and is never opened. Keys:
 * `<origin>:<root label>/<path relative to that root's projects>`.
 *
 * Project (spec 2.4, 4.1, 4.7): the first `cwd` of the main file (a bounded scan of its head, lines over
 * BUDDY_HEAD_LINE_MAX skipped), encoded as Claude Code does; for `workbuddy` of `workbuddyProjectDir(cwd)`. While no
 * `cwd` has been written the file is not classified ("cannot tell yet"); the scan remembers where it stopped and is
 * not repeated while the file is unchanged. A subagent thread always gets its root session's project and waits for it.
 * The project directory name is lossy and never decoded.
 *
 * Several roots of one origin (WorkBuddy's two): a session id found under a second root is skipped and counted
 * (status().duplicateSessions) — the copy already stored, else the first one classified, wins; the loser's subagent
 * threads are skipped with it. Classes are cached per key, and taken from the stored raw events when there are any (a
 * rebuild or a vanished file reads nothing). Nothing is ever written under a tool directory.
 */
export class BuddyFileSource implements FileSource {
  readonly rootDir: string;
  /** Reaches `<project>/<parent>/subagents/agent-*.jsonl` (three directories below each root's projects). */
  readonly watchDepth = 3;
  /** Lines are told apart by their byte offset: the file is append-only, and a rolled-back batch is a rewrite. */
  readonly lineIdentity = 'offset' as const;
  /** readGuardedLines plus a guard on the last complete line read (a same-size rewrite ending on the same bytes). */
  readonly readLines = readBuddyLines;
  private readonly prefix: string;
  /** Label -> that root's projects directory. */
  private readonly projectsByLabel = new Map<string, string>();
  /** Key -> its class, once decided. */
  private readonly classes = new Map<string, FileClass>();
  /** Session id -> the main-file key that holds it (the winner among roots). */
  private readonly claims = new Map<string, string>();
  /** Session id -> main-file keys seen for it (listing, classification). */
  private readonly mainKeys = new Map<string, Set<string>>();
  /** `<label>/<project>/<agent stem>` -> the directory its file sits under (a session id or another agent stem). */
  private readonly agentParents = new Map<string, string>();
  /** Main-file keys found by the last listing; null before the first one. */
  private listedMain: Set<string> | null = null;
  /** `<label>\0<session id>` of each copy skipped as a duplicate. */
  private readonly duplicates = new Set<string>();
  /** Main-file key -> what the last scan of its head found (no cwd). */
  private readonly unplaced = new Map<string, Unplaced>();
  private readonly resolver: ProjectIdResolver;

  constructor(
    readonly origin: 'workbuddy' | 'codebuddy',
    private readonly roots: readonly { label: string; dir: string }[],
    private readonly lookup: BuddyLookup = NO_LOOKUP,
  ) {
    this.prefix = KEY_PREFIXES[origin];
    for (const r of roots) if (!this.projectsByLabel.has(r.label)) this.projectsByLabel.set(r.label, path.join(r.dir, PROJECTS));
    this.rootDir = roots.length > 0 ? path.join(roots[0]!.dir, PROJECTS) : '';
    this.resolver = new ProjectIdResolver(() => this.lookup.knownProjectIds());
  }

  /** Each root's `projects` directory that exists now, at watchDepth (a missing one is not watched). */
  get watchRoots(): readonly { dir: string; depth: number }[] {
    return [...this.projectsByLabel.values()].filter((dir) => isExistingDir(dir)).map((dir) => ({ dir, depth: this.watchDepth }));
  }

  /** Every main and subagent file under every root (sorted); remembers which stems and sessions are where. */
  async listFiles(): Promise<string[]> {
    const out: string[] = [];
    const listedMain = new Set<string>();
    for (const [label, projects] of this.projectsByLabel) {
      for (const proj of await dirNames(projects)) {
        const projDir = path.join(projects, proj);
        let entries: fs.Dirent[];
        try {
          entries = await fsp.readdir(projDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (e.isFile() && e.name.endsWith(JSONL) && UUID.test(e.name.slice(0, -JSONL.length))) {
            const sid = e.name.slice(0, -JSONL.length);
            const key = this.keyFor(label, [proj, e.name]);
            this.noteMain(sid, key);
            listedMain.add(key);
            out.push(path.join(projDir, e.name));
            continue;
          }
          if (!e.isDirectory() || !isParentName(e.name)) continue;
          let subs: fs.Dirent[];
          try {
            subs = await fsp.readdir(path.join(projDir, e.name, SUBAGENTS), { withFileTypes: true });
          } catch {
            continue;
          }
          for (const f of subs) {
            if (!f.isFile() || !f.name.endsWith(JSONL) || !isAgentStem(f.name.slice(0, -JSONL.length))) continue;
            this.agentParents.set(`${label}/${proj}/${f.name.slice(0, -JSONL.length)}`, e.name);
            out.push(path.join(projDir, e.name, SUBAGENTS, f.name));
          }
        }
      }
    }
    this.listedMain = listedMain;
    // A claim whose file is gone (moved to another root, deleted) is released: another copy of the session, if one is
    // listed, takes it at its next classification, and is no longer counted as a duplicate.
    for (const [sid, holder] of [...this.claims]) {
      if (listedMain.has(holder)) continue;
      this.claims.delete(sid);
      for (const d of [...this.duplicates]) if (d.endsWith(`\u0000${sid}`)) this.duplicates.delete(d);
    }
    return out.sort();
  }

  keyOf(absPath: string): string | null {
    for (const [label, projects] of this.projectsByLabel) {
      const rel = path.relative(projects, absPath);
      if (rel === '' || path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) continue;
      const parts = rel.split(/[\\/]+/).filter((p) => p !== '');
      const key = this.keyFor(label, parts);
      return this.shapeOf(key) === null ? null : key;
    }
    return null;
  }

  pathOf(key: string): string | null {
    const shape = this.shapeOf(key);
    if (shape === null) return null;
    const parts = key.slice(this.prefix.length).split('/').slice(1);
    return path.join(this.projectsByLabel.get(shape.label)!, ...parts);
  }

  classify(key: string): MaybePromise<FileClass | null> {
    const shape = this.shapeOf(key);
    if (shape === null) return null;
    if (shape.kind === 'main' && this.heldByOther(shape.sid, key)) {
      this.duplicates.add(`${shape.label}\u0000${shape.sid}`);
      return null;
    }
    const known = this.known(key);
    if (known !== null) return known;
    return shape.kind === 'main' ? this.classifyMain(key, shape) : this.classifyAgent(key, shape);
  }

  /** No key names the project: it is stored with each raw event. */
  projectOfKey(_key: string): string | null {
    return null;
  }

  projectOfTranscript(absPath: string): string | null {
    const key = this.keyOf(absPath);
    return key === null ? null : (this.known(key)?.projectId ?? null);
  }

  /**
   * A session's main file (the winning copy, or a copy whose file is gone when no other copy holds the session); a
   * subagent's file belongs to its root session's main file.
   */
  mainSessionOf(key: string): string | null {
    if (this.shapeOf(key)?.kind !== 'main') return null;
    const known = this.known(key);
    if (known?.kind !== 'session') return null;
    // The claim holder answers; so does a key when no copy holds the claim (its file is gone and no other copy took
    // over), so a deleted session is flagged "source deleted" as for every other source.
    const holder = this.claims.get(known.sessionId);
    return holder === undefined || holder === key ? known.sessionId : null;
  }

  /** Sessions found again under another root and not read twice. (The configured roots are listed by the server.) */
  status(): { duplicateSessions: number } {
    return { duplicateSessions: this.duplicates.size };
  }

  // ---------------------------------------------------------------- internals

  private keyFor(label: string, parts: readonly string[]): string {
    return `${this.prefix}${label}/${parts.join('/')}`;
  }

  /** The file a key names, or null when it is not one of this source's. */
  private shapeOf(key: string): Shape | null {
    if (!key.startsWith(this.prefix)) return null;
    const parts = key.slice(this.prefix.length).split('/');
    const label = parts[0]!;
    if (!this.projectsByLabel.has(label)) return null;
    const proj = parts[1];
    if (proj === undefined || !validName(proj)) return null;
    if (parts.length === 3) {
      const name = parts[2]!;
      if (!name.endsWith(JSONL)) return null;
      const sid = name.slice(0, -JSONL.length);
      return UUID.test(sid) ? { kind: 'main', label, proj, sid } : null;
    }
    if (parts.length === 5) {
      const [, , parent, sub, name] = parts as [string, string, string, string, string];
      if (sub !== SUBAGENTS || !isParentName(parent) || !name.endsWith(JSONL)) return null;
      const agent = name.slice(0, -JSONL.length);
      return isAgentStem(agent) ? { kind: 'agent', label, proj, parent, agent } : null;
    }
    return null;
  }

  /** Whether another main file holds the claim on the session id. */
  private heldByOther(sid: string, key: string): boolean {
    const holder = this.claims.get(sid);
    return holder !== undefined && holder !== key;
  }

  private noteMain(sid: string, key: string): void {
    let keys = this.mainKeys.get(sid);
    if (keys === undefined) this.mainKeys.set(sid, (keys = new Set()));
    keys.add(key);
  }

  /**
   * A main file: skipped when another copy of the session holds the claim (an already stored copy claims it first);
   * else classified from the first `cwd` of its head, and the claim taken.
   */
  private async classifyMain(key: string, shape: Extract<Shape, { kind: 'main' }>): Promise<FileClass | null> {
    const { sid, label } = shape;
    this.noteMain(sid, key);
    let winner = this.claims.get(sid);
    if (winner === undefined) {
      for (const other of this.mainKeys.get(sid)!) {
        if (other === key || (this.listedMain !== null && !this.listedMain.has(other))) continue; // gone: not a contender
        const stored = this.lookup.storedFile(other);
        if (stored !== null && stored.agentId === null && stored.sessionId === sid) {
          winner = other;
          this.claims.set(sid, other);
          break;
        }
      }
    }
    if (winner !== undefined && winner !== key) {
      this.duplicates.add(`${label}\u0000${sid}`);
      return null;
    }
    const cwd = await this.firstCwd(key);
    if (cwd === null) return null;
    // Classified while another copy was being read: the first one done wins.
    const now = this.claims.get(sid);
    if (now !== undefined && now !== key) {
      this.duplicates.add(`${label}\u0000${sid}`);
      return null;
    }
    this.claims.set(sid, key);
    return this.remember(key, { kind: 'session', projectId: this.project(cwd), sessionId: sid });
  }

  /** A subagent thread: of the root session its directory leads to, in that session's project; null until both are known. */
  private async classifyAgent(key: string, shape: Extract<Shape, { kind: 'agent' }>): Promise<FileClass | null> {
    const { label, proj } = shape;
    this.agentParents.set(`${label}/${proj}/${shape.agent}`, shape.parent);
    const seen = new Set([shape.agent]);
    let parent = shape.parent;
    for (let depth = 0; isAgentStem(parent); depth++) {
      if (depth >= BUDDY_CHAIN_MAX || seen.has(parent)) return null;
      seen.add(parent);
      const up = this.agentParents.get(`${label}/${proj}/${parent}`);
      if (up === undefined) return null; // the spawning subagent's file is not seen yet
      parent = up;
    }
    const mainKey = this.keyFor(label, [proj, `${parent}${JSONL}`]);
    const mainShape = this.shapeOf(mainKey);
    if (mainShape?.kind !== 'main') return null;
    let root = this.known(mainKey);
    if (root === null) {
      root = await this.classifyMain(mainKey, mainShape);
    }
    if (root === null || root.kind !== 'session') return null;
    return this.remember(key, { kind: 'agent', projectId: root.projectId, sessionId: root.sessionId, agentId: shape.agent });
  }

  /**
   * The first `cwd` of a main file's head, or null while none has been written (or the file cannot be read). A file
   * found without one is not read again while its size and modification time are unchanged; a grown one is scanned on
   * from where the last scan stopped.
   */
  private async firstCwd(key: string): Promise<string | null> {
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
    const from = was !== undefined && st.size > was.size ? was.next : 0;
    let found: { cwd: string | null; next: number; exhausted: boolean };
    try {
      found = await scanHeadForCwd(file, from, BUDDY_HEAD_MAX_BYTES);
    } catch {
      return null;
    }
    if (found.cwd !== null) {
      this.unplaced.delete(key);
      return found.cwd;
    }
    this.unplaced.set(key, { size: st.size, mtimeMs: st.mtimeMs, next: found.next, exhausted: found.exhausted });
    return null;
  }

  /** Cached, else stored with the key's raw events (no read). */
  private known(key: string): FileClass | null {
    const cached = this.classes.get(key);
    if (cached !== undefined) return cached;
    const stored = this.lookup.storedFile(key);
    if (stored === null || stored.projectId === null) return null;
    const shape = this.shapeOf(key);
    if (stored.agentId === null && shape?.kind === 'main') {
      this.noteMain(stored.sessionId, key);
      if (!this.claims.has(stored.sessionId)) this.claims.set(stored.sessionId, key);
    }
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

  /** Project id of a session's cwd (WorkBuddy's timestamp folders count as their parent directory). */
  private project(cwd: string): string {
    const dir = normaliseCwd(cwd);
    return this.resolver.forCwd(this.origin === 'workbuddy' ? normaliseCwd(workbuddyProjectDir(dir)) : dir);
  }
}

/**
 * The top-level `cwd` of the first complete line from `from` on that has one (scanning stops at byte `limit`): lines
 * are read in CHUNK slices; one longer than BUDDY_HEAD_LINE_MAX is passed over without being held. `next` is the byte
 * after the last complete line scanned when none was found; `exhausted` when the scan stopped at `limit`.
 */
async function scanHeadForCwd(file: string, from: number, limit: number): Promise<{ cwd: string | null; next: number; exhausted: boolean }> {
  const handle = await fsp.open(file, 'r');
  try {
    const end = Math.min((await handle.stat()).size, limit);
    const buf = Buffer.alloc(CHUNK);
    let pos = from;
    let next = from;
    let parts: Buffer[] = [];
    let held = 0;
    let skipping = false;
    while (pos < end) {
      const { bytesRead } = await handle.read(buf, 0, Math.min(CHUNK, end - pos), pos);
      if (bytesRead <= 0) break;
      const chunk = buf.subarray(0, bytesRead);
      let i = 0;
      while (i < bytesRead) {
        const nl = chunk.indexOf(10, i);
        const stop = nl === -1 ? bytesRead : nl;
        if (!skipping) {
          if (held + (stop - i) > BUDDY_HEAD_LINE_MAX) {
            skipping = true;
            parts = [];
            held = 0;
          } else if (stop > i) {
            parts.push(Buffer.from(chunk.subarray(i, stop)));
            held += stop - i;
          }
        }
        if (nl === -1) break;
        if (!skipping) {
          const cwd = cwdOf(Buffer.concat(parts, held).toString('utf8'));
          if (cwd !== null) return { cwd, next: pos + nl + 1, exhausted: false };
        }
        parts = [];
        held = 0;
        skipping = false;
        next = pos + nl + 1;
        i = nl + 1;
      }
      pos += bytesRead;
    }
    return { cwd: null, next, exhausted: pos >= limit };
  } finally {
    await handle.close();
  }
}

/** A line's top-level `cwd` (a non-blank string), else null (not JSON, not an object, no cwd). */
function cwdOf(line: string): string | null {
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof rec !== 'object' || rec === null || Array.isArray(rec)) return null;
  const cwd = (rec as Record<string, unknown>).cwd;
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : null;
}

/** A directory name taken from the listing or a key: not empty, not `.` or `..`, no path syntax. */
function validName(s: string): boolean {
  return s !== '' && s !== '.' && s !== '..' && !/[\\/:]/.test(s);
}

function isAgentStem(s: string): boolean {
  return s.length > AGENT_PREFIX.length && s.startsWith(AGENT_PREFIX) && validName(s);
}

/** The directory a `subagents` folder sits in: a session id, or the store id of the subagent that spawned it. */
function isParentName(s: string): boolean {
  return UUID.test(s) || isAgentStem(s);
}

/** Names of the subdirectories of `dir` (none when it cannot be read). */
async function dirNames(dir: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((d) => d.isDirectory() && validName(d.name)).map((d) => d.name);
}
