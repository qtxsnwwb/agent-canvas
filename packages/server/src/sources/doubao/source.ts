import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readGuardedLines } from '../guarded-reader.js';
import { KEY_PREFIXES, type FileClass, type FileSource, type SourceRead } from '../source.js';
import { parseAssignment } from './assignment.js';

/** The fixed project of every Doubao Work session (spec 5.3: the files hold no working directory). */
export const DOUBAO_PROJECT = 'doubao-work';
/** An assignment.md larger than this is not read (it is read whole, as a meta raw event, each time it grows). */
export const DOUBAO_ASSIGNMENT_MAX_BYTES = 2 * 1024 * 1024;

const PREFIX = KEY_PREFIXES.doubao;
/** A Chromium profile directory (format reference A1 "Profiles"). */
const PROFILE = /^(Default|Profile \d+)$/;
/** The namespace directories of the two variants (`.` + URL scheme). */
const NAMESPACES = ['.doubaowork', '.doubao'] as const;
/** `<profile>/<ns>/` + this = the sessions directory. */
const SESSIONS = ['agent_mode', 'workspace', '.sessions'] as const;
const AGENTS = 'agents';
const SYSTEM = 'system';
const TRAJECTORY = 'trajectory.jsonl';
const ASSIGNMENT = 'assignment.md';
/** A conversation or agent directory name (format reference A1 "Identity"). */
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
/** The main agent's directory. */
const MAIN_AGENT = /^m_[a-zA-Z0-9]+$/;

/** What the source may ask the store (never file contents). */
export interface DoubaoLookup {
  /** Session and agent stored with the transcript raw events of a key; null when none are stored. */
  storedFile(key: string): { sessionId: string; agentId: string | null; projectId: string | null } | null;
}

const NO_LOOKUP: DoubaoLookup = { storedFile: () => null };

/** A key's file, from its path alone. */
interface Shape {
  label: string;
  profile: string;
  ns: string;
  conv: string;
  agent: string;
  file: typeof TRAJECTORY | typeof ASSIGNMENT;
  /** `<label>/<profile>/<ns>/<conv>`: one copy of a conversation. */
  loc: string;
}

/** What a full scan found of one copy of a conversation. */
interface Listed {
  /** The main agent's directory, or null when there is none or several. */
  main: string | null;
}

/** Whether an agent's assignment.md gives a time, by the size and modification time it was read at. */
interface TimeCheck {
  size: number;
  mtimeMs: number;
  hasTime: boolean;
}

/**
 * The label of each root for the store keys: the root's directory name, or for a Windows "User Data" directory its
 * parent's (`DoubaoWork`, `Doubao`), without leading dots; a label that would be empty, unusable in a key or taken
 * by an earlier root gets `~2`, `~3`, … appended.
 */
function rootsOf(dirs: readonly string[]): { label: string; dir: string }[] {
  const out: { label: string; dir: string }[] = [];
  const taken = new Set<string>();
  for (const dir of dirs) {
    if (dir === '') continue;
    let name = path.basename(dir);
    if (name.toLowerCase() === 'user data') name = path.basename(path.dirname(dir));
    let base = name.replace(/^\.+/, '');
    if (!validName(base)) base = 'root';
    let label = base;
    for (let n = 2; taken.has(label); n++) label = `${base}~${n}`;
    taken.add(label);
    out.push({ label, dir });
  }
  return out;
}

/**
 * Doubao Work's (豆包工作) transcripts (spec 5.1, format reference A1): under each "User Data"-level root, every
 * `Default` / `Profile N` directory, namespace `.doubaowork` or `.doubao`, then `agent_mode/workspace/.sessions`. A
 * `.sessions/<conversationId>` directory is a session; under its `agents/<agentId>/system/`, `trajectory.jsonl` is a
 * thread (tailed, lines told apart by offset) and `assignment.md` its demands (read whole: `title` for the main agent,
 * `agent_meta` for the others, up to DOUBAO_ASSIGNMENT_MAX_BYTES). The main agent is the single `m_…` agent directory
 * (none or several: the conversation is not read, status().unknownSessions); the others are subagent threads. Only
 * those two files are ever opened. The scans list only the profile, namespace, conversation, agent and `system`
 * directories on that path. The watcher is wider: each `.sessions` directory is handed to chokidar at watchDepth (4)
 * without a filter, so chokidar lists and stats everything up to four levels below it (a conversation's `board.md`,
 * `memory/`, `attachments/` and any other files there included), though it opens none of them; nothing outside the
 * `.sessions` directories (`.skills`, `coding/snapshot`, logs, the browser profile) is listed or watched.
 * Keys: `doubao:<root label>/<profile>/<ns>/<conversation>/<agent>/<file>`. Every session is in DOUBAO_PROJECT.
 *
 * The same conversation id under another root, profile or namespace: the copy already stored, else the first one
 * classified, wins; the other copies (all their agents) are skipped and counted (status().duplicateSessions). When the
 * winning copy is gone from a listing its claim is released, so another copy takes over and a session with no copy
 * left is flagged "source deleted". Classes are cached per key, and taken from the stored raw events when there are
 * any. Nothing is ever written under a root.
 */
export class DoubaoFileSource implements FileSource {
  readonly origin = 'doubao' as const;
  readonly rootDir: string;
  /** Reaches `<conversation>/agents/<agent>/system/<file>` below a `.sessions` directory. */
  readonly watchDepth = 4;
  /** Rows have no id: a row is its place in the file (spec 5.1, 10.5). */
  readonly lineIdentity = 'offset' as const;
  readonly readLines = readDoubaoLines;
  private readonly roots: { label: string; dir: string }[];
  private readonly dirByLabel = new Map<string, string>();
  /** Copy (`loc`) -> what the last listing found; replaced by every listing. */
  private listed = new Map<string, Listed>();
  /** Key -> its class, once decided. */
  private readonly classes = new Map<string, FileClass>();
  /** Conversation id -> the copy (`loc`) that holds it. */
  private readonly claims = new Map<string, string>();
  /** Conversation id -> the copies (`loc`) seen for it. */
  private readonly copies = new Map<string, Set<string>>();
  /** Conversation id -> copies skipped as duplicates. */
  private readonly duplicates = new Map<string, Set<string>>();
  /** Copies without a single main agent, as of the last listing. */
  private unknown = new Set<string>();
  /** Agent (`loc/agent`) -> whether its assignment.md gives a time (cached by size and modification time). */
  private readonly timeChecks = new Map<string, TimeCheck>();
  /** Each listed thread's copy and whether its assignment.md gives a time, as of the last listing. */
  private timed: { conv: string; loc: string; hasTime: boolean }[] = [];

  constructor(
    roots: readonly string[],
    private readonly lookup: DoubaoLookup = NO_LOOKUP,
  ) {
    this.roots = rootsOf(roots);
    for (const r of this.roots) this.dirByLabel.set(r.label, r.dir);
    this.rootDir = this.roots[0]?.dir ?? '';
  }

  /** Each `.sessions` directory that exists now (found the way listFiles finds them), at watchDepth. */
  get watchRoots(): readonly { dir: string; depth: number }[] {
    const out: { dir: string; depth: number }[] = [];
    for (const r of this.roots) {
      for (const profile of profilesSync(r.dir)) {
        for (const ns of NAMESPACES) {
          const dir = path.join(r.dir, profile, ns, ...SESSIONS);
          if (isDirSync(dir)) out.push({ dir, depth: this.watchDepth });
        }
      }
    }
    return out;
  }

  /** Every trajectory.jsonl and assignment.md of every conversation with a single main agent (sorted). */
  async listFiles(): Promise<string[]> {
    const out: string[] = [];
    const listed = new Map<string, Listed>();
    const unknown = new Set<string>();
    /** Agents with a trajectory, per copy: for the fallback count. */
    const threads: { loc: string; conv: string; agent: string; dir: string }[] = [];
    for (const r of this.roots) {
      for (const profile of await dirNames(r.dir, (n) => PROFILE.test(n))) {
        for (const ns of NAMESPACES) {
          const sessions = path.join(r.dir, profile, ns, ...SESSIONS);
          for (const conv of await dirNames(sessions, (n) => ID.test(n))) {
            const loc = `${r.label}/${profile}/${ns}/${conv}`;
            const agentsDir = path.join(sessions, conv, AGENTS);
            const agents = await dirNames(agentsDir, (n) => ID.test(n));
            const main = mainOf(agents);
            listed.set(loc, { main });
            this.noteCopy(conv, loc);
            if (main === null) {
              unknown.add(loc);
              continue;
            }
            for (const agent of agents) {
              const sys = path.join(agentsDir, agent, SYSTEM);
              const files = await fileNames(sys);
              if (files.has(ASSIGNMENT)) out.push(path.join(sys, ASSIGNMENT));
              if (files.has(TRAJECTORY)) {
                out.push(path.join(sys, TRAJECTORY));
                threads.push({ loc, conv, agent, dir: sys });
              }
            }
          }
        }
      }
    }
    this.listed = listed;
    this.unknown = unknown;
    // A claim whose copy is gone (moved, deleted, no longer a valid conversation) is released: another copy, if one is
    // listed, takes it at its next classification, and is no longer counted as a duplicate.
    for (const [conv, holder] of [...this.claims]) {
      if (listed.get(holder)?.main != null) continue;
      this.claims.delete(conv);
      this.duplicates.delete(conv);
    }
    const timed: { conv: string; loc: string; hasTime: boolean }[] = [];
    const seen = new Set<string>();
    for (const t of threads) {
      const id = `${t.loc}/${t.agent}`;
      seen.add(id);
      timed.push({ conv: t.conv, loc: t.loc, hasTime: await this.hasTime(id, path.join(t.dir, ASSIGNMENT)) });
    }
    for (const id of [...this.timeChecks.keys()]) if (!seen.has(id)) this.timeChecks.delete(id);
    this.timed = timed;
    return out.sort();
  }

  keyOf(absPath: string): string | null {
    for (const r of this.roots) {
      const rel = path.relative(r.dir, absPath);
      if (rel === '' || path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) continue;
      const parts = rel.split(/[\\/]+/).filter((p) => p !== '');
      // <profile>/<ns>/agent_mode/workspace/.sessions/<conv>/agents/<agent>/system/<file>
      if (parts.length !== 10) return null;
      const [profile, ns, a, w, s, conv, agents, agent, sys, file] = parts as [string, string, string, string, string, string, string, string, string, string];
      if (a !== SESSIONS[0] || w !== SESSIONS[1] || s !== SESSIONS[2] || agents !== AGENTS || sys !== SYSTEM) return null;
      const key = `${PREFIX}${r.label}/${profile}/${ns}/${conv}/${agent}/${file}`;
      return this.shapeOf(key) === null ? null : key;
    }
    return null;
  }

  pathOf(key: string): string | null {
    const s = this.shapeOf(key);
    if (s === null) return null;
    return path.join(this.dirByLabel.get(s.label)!, s.profile, s.ns, ...SESSIONS, s.conv, AGENTS, s.agent, SYSTEM, s.file);
  }

  classify(key: string): FileClass | null {
    const s = this.shapeOf(key);
    if (s === null) return null;
    this.noteCopy(s.conv, s.loc);
    if (!this.holds(s)) return null;
    if (s.file === ASSIGNMENT && !this.withinCap(key)) return null;
    const known = this.known(key, s);
    if (known !== null) return known;
    const main = this.mainAgentOf(s);
    if (main === null) return null;
    return this.remember(key, s, s.agent === main);
  }

  /** Every key names the project: the fixed one. */
  projectOfKey(key: string): string | null {
    return this.shapeOf(key) === null ? null : DOUBAO_PROJECT;
  }

  projectOfTranscript(absPath: string): string | null {
    return this.keyOf(absPath) === null ? null : DOUBAO_PROJECT;
  }

  /**
   * The main agent's trajectory of the copy holding the conversation (or of a copy whose files are gone when no other
   * copy holds it, so a deleted session is flagged as for every other source).
   */
  mainSessionOf(key: string): string | null {
    const s = this.shapeOf(key);
    if (s === null || s.file !== TRAJECTORY) return null;
    // Listed but no longer a single-main conversation: not read any more, but its files are there (not deleted).
    if (this.unknown.has(s.loc)) return null;
    const known = this.known(key, s);
    if (known?.kind !== 'session') return null;
    const holder = this.claims.get(s.conv);
    return holder === undefined || holder === s.loc ? known.sessionId : null;
  }

  /**
   * duplicateSessions: copies of a conversation skipped (another root, profile or namespace holds it); unknownSessions:
   * conversations not read for want of a single main agent; mtimeFallbacks: threads (of the copy read) whose times can
   * only come from their file's modification time (assignment.md missing, over the size cap, or without a time that
   * parses). The last two as of the last full scan.
   */
  status(): { duplicateSessions: number; unknownSessions: number; mtimeFallbacks: number } {
    let duplicateSessions = 0;
    for (const set of this.duplicates.values()) duplicateSessions += set.size;
    // Threads of the copy that holds each conversation (of the first listed copy while none holds it yet).
    const firstCopy = new Map<string, string>();
    for (const r of this.timed) if (!firstCopy.has(r.conv)) firstCopy.set(r.conv, r.loc);
    let mtimeFallbacks = 0;
    for (const r of this.timed) if (!r.hasTime && (this.claims.get(r.conv) ?? firstCopy.get(r.conv)) === r.loc) mtimeFallbacks++;
    return { duplicateSessions, unknownSessions: this.unknown.size, mtimeFallbacks };
  }

  // ---------------------------------------------------------------- internals

  /** The file a key names, or null when it is not one of this source's. */
  private shapeOf(key: string): Shape | null {
    if (!key.startsWith(PREFIX)) return null;
    const parts = key.slice(PREFIX.length).split('/');
    if (parts.length !== 6) return null;
    const [label, profile, ns, conv, agent, file] = parts as [string, string, string, string, string, string];
    if (!this.dirByLabel.has(label) || !PROFILE.test(profile) || !(NAMESPACES as readonly string[]).includes(ns)) return null;
    if (!ID.test(conv) || !ID.test(agent) || (file !== TRAJECTORY && file !== ASSIGNMENT)) return null;
    return { label, profile, ns, conv, agent, file, loc: `${label}/${profile}/${ns}/${conv}` };
  }

  private noteCopy(conv: string, loc: string): void {
    let set = this.copies.get(conv);
    if (set === undefined) this.copies.set(conv, (set = new Set()));
    set.add(loc);
  }

  /**
   * Whether this copy holds its conversation: the holder already; else (no holder) a copy whose main trajectory is
   * stored claims it first, else this one does. A copy that does not hold it is counted as a duplicate.
   */
  private holds(s: Shape): boolean {
    let holder = this.claims.get(s.conv);
    if (holder === undefined) {
      for (const other of this.copies.get(s.conv) ?? []) {
        if (this.listed.size > 0 && other !== s.loc && !this.listed.has(other)) continue; // gone: not a contender
        if (this.storedMain(other, s.conv)) {
          holder = other;
          break;
        }
      }
      // A copy is only claimed when it is a valid conversation (its main agent known) or already stored.
      if (holder === undefined && this.mainAgentOf(s) !== null) holder = s.loc;
      if (holder === undefined) return false;
      this.claims.set(s.conv, holder);
    }
    if (holder === s.loc) return true;
    let set = this.duplicates.get(s.conv);
    if (set === undefined) this.duplicates.set(s.conv, (set = new Set()));
    set.add(s.loc);
    return false;
  }

  /** Whether the copy `loc` has a main trajectory stored for `conv` (any of its agents' trajectories as the main thread). */
  private storedMain(loc: string, conv: string): boolean {
    const main = this.listed.get(loc)?.main;
    if (main == null) return false;
    const stored = this.lookup.storedFile(`${PREFIX}${loc}/${main}/${TRAJECTORY}`);
    return stored !== null && stored.agentId === null && stored.sessionId === conv;
  }

  /**
   * The copy's main agent: from the last listing, else (a conversation seen through a change event before any listing
   * of it) from its agents directory now; null when there is none or several. A negative answer is not kept.
   */
  private mainAgentOf(s: Shape): string | null {
    const listed = this.listed.get(s.loc);
    if (listed !== undefined && listed.main !== null) return listed.main;
    const dir = path.join(this.dirByLabel.get(s.label)!, s.profile, s.ns, ...SESSIONS, s.conv, AGENTS);
    let names: string[];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && ID.test(d.name)).map((d) => d.name);
    } catch {
      return null;
    }
    const main = mainOf(names);
    if (main !== null) this.listed.set(s.loc, { main });
    return main;
  }

  private withinCap(key: string): boolean {
    try {
      return fs.statSync(this.pathOf(key)!).size <= DOUBAO_ASSIGNMENT_MAX_BYTES;
    } catch {
      return true; // gone: the pipeline handles a missing file
    }
  }

  /** Cached, else stored with the key's raw events (a trajectory's; an assignment follows its sibling's). */
  private known(key: string, s: Shape): FileClass | null {
    const cached = this.classes.get(key);
    if (cached !== undefined) return cached;
    const stored = this.lookup.storedFile(`${PREFIX}${s.loc}/${s.agent}/${TRAJECTORY}`);
    if (stored === null || stored.sessionId !== s.conv) return null;
    if (stored.agentId === null && !this.claims.has(s.conv)) this.claims.set(s.conv, s.loc);
    return this.remember(key, s, stored.agentId === null);
  }

  private remember(key: string, s: Shape, isMain: boolean): FileClass {
    const existing = this.classes.get(key);
    if (existing !== undefined) return existing;
    let cls: FileClass;
    if (s.file === TRAJECTORY) {
      cls = isMain ? { kind: 'session', projectId: DOUBAO_PROJECT, sessionId: s.conv } : { kind: 'agent', projectId: DOUBAO_PROJECT, sessionId: s.conv, agentId: s.agent };
    } else {
      cls = isMain ? { kind: 'title', projectId: DOUBAO_PROJECT, sessionId: s.conv } : { kind: 'agent_meta', projectId: DOUBAO_PROJECT, sessionId: s.conv, agentId: s.agent };
    }
    this.classes.set(key, cls);
    return cls;
  }

  /** Whether the assignment.md at `file` gives at least one demand time (read again only when it changed). */
  private async hasTime(id: string, file: string): Promise<boolean> {
    let st: fs.Stats;
    try {
      st = await fsp.stat(file);
    } catch {
      this.timeChecks.delete(id);
      return false;
    }
    const was = this.timeChecks.get(id);
    if (was !== undefined && was.size === st.size && was.mtimeMs === st.mtimeMs) return was.hasTime;
    let hasTime = false;
    if (st.size <= DOUBAO_ASSIGNMENT_MAX_BYTES) {
      try {
        hasTime = parseAssignment(await fsp.readFile(file, 'utf8')).some((d) => d.at !== null);
      } catch {
        hasTime = false;
      }
    }
    this.timeChecks.set(id, { size: st.size, mtimeMs: st.mtimeMs, hasTime });
    return hasTime;
  }
}

/** The text of the synthetic first line: the file's modification time when its start was read. */
export function doubaoFileLine(mtimeMs: number): string {
  return JSON.stringify({ __agentCanvas: 'file', mtimeMs });
}

/** Offset of the synthetic line (before the file's first byte, so offsets stay strictly increasing). */
export const DOUBAO_FILE_LINE_OFFSET = -1;

/**
 * readGuardedLines plus a synthetic line `{"__agentCanvas":"file","mtimeMs":<n>}` carrying the file's modification
 * time at this read, stored with the raw events so what it feeds replays identically:
 * - at offset -1 whenever the file is read from its start (the first read that advances, even over blank lines only,
 *   or a rewrite): the node times' fallback (spec 5.3, 10.13) and the thread's last activity;
 * - at offset `fromOffset - 1` before the rows of every later read that delivers rows: the thread's last activity only
 *   (rows have no time; a turn writes rows long after its demand's time). That byte is the newline ending the row
 *   before, so offsets stay strictly increasing within the generation and no row has it.
 * A file that is not there is not a rewrite: nothing read, nothing changed (a missing file never sends the offset back
 * to 0). A file that cannot be opened or read right now is not a rewrite either: the error is thrown (nothing read or
 * stored, the next scan retries). Otherwise the shared reader's result as is (offsets, state, truncated).
 */
export async function readDoubaoLines(absPath: string, fromOffset: number, maxBytes: number, state: string | null): Promise<SourceRead> {
  let mtimeMs: number;
  try {
    mtimeMs = Math.floor((await fsp.stat(absPath)).mtimeMs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { lines: [], newOffset: fromOffset, truncated: false };
    throw err;
  }
  const res = await readGuardedLines(absPath, fromOffset, maxBytes, state);
  // Vanished between the stat and the read: as above.
  if (!res.truncated && res.lines.length === 0 && res.newOffset === 0 && fromOffset > 0 && res.state === undefined) return { lines: [], newOffset: fromOffset, truncated: false };
  const fromStart = res.truncated || fromOffset === 0;
  if (!fromStart) {
    // A later read: the line goes before its rows, when it delivered any.
    if (res.lines.length === 0) return res;
    return { ...res, lines: [{ offset: fromOffset - 1, text: doubaoFileLine(mtimeMs) }, ...res.lines] };
  }
  // Once per generation from the start: the read that starts at 0 and gets anywhere (rows, or only blank lines), or a rewrite.
  if (res.lines.length === 0 && !res.truncated && res.newOffset <= fromOffset) return res;
  return { ...res, lines: [{ offset: DOUBAO_FILE_LINE_OFFSET, text: doubaoFileLine(mtimeMs) }, ...res.lines] };
}

/** The single `m_…` name among an agents directory's entries, else null (none or several). */
function mainOf(agents: readonly string[]): string | null {
  const mains = agents.filter((a) => MAIN_AGENT.test(a));
  return mains.length === 1 ? mains[0]! : null;
}

/** A directory name taken from a listing or a key: not empty, not `.` or `..`, no path syntax. */
function validName(s: string): boolean {
  return s !== '' && s !== '.' && s !== '..' && !/[\\/:]/.test(s);
}

function isDirSync(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The profile directories of a root, read now (none when it cannot be read). */
function profilesSync(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && PROFILE.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** Names of the subdirectories of `dir` that `ok` accepts (none when it cannot be read), sorted. */
async function dirNames(dir: string, ok: (name: string) => boolean): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((d) => d.isDirectory() && ok(d.name))
    .map((d) => d.name)
    .sort();
}

/** Names of the regular files in `dir` (none when it cannot be read). */
async function fileNames(dir: string): Promise<Set<string>> {
  try {
    return new Set((await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name));
  } catch {
    return new Set();
  }
}
