import fsp from 'node:fs/promises';
import type fs from 'node:fs';
import path from 'node:path';
import { normaliseCwd } from '../cursor/project.js';
import { ProjectIdResolver } from '../project-ids.js';
import { KEY_PREFIXES, type FileClass, type FileSource, type MaybePromise } from '../source.js';
import { readDshHeaderLine, readDshLines } from './zstd-frames.js';

const PREFIX = KEY_PREFIXES.deepseek;
/** The only file read: the current format generation (docs/formats/deepseek-harness.md 1.3). */
const V4 = 'session.v4.jsonl.zstd';
/** A canonical generation file name with the zstd suffix: `session.jsonl.zstd` (v0) or `session.vN.jsonl.zstd`. */
const GENERATION = /^session(?:\.v([1-9][0-9]*))?\.jsonl\.zstd$/;
const UNKNOWN_PROJECT = 'unknown';
/** Most links followed from a subagent up to its root session. */
export const DSH_CHAIN_MAX = 16;
/** Largest header frame read when classifying (the header is a few hundred bytes; a larger one counts as unreadable). */
export const DSH_HEADER_MAX_BYTES = 1024 * 1024;

/** What the source may ask the store (never file contents). */
export interface DeepSeekLookup {
  /** Session, agent and project stored with the transcript raw events of a key; null when none are stored. */
  storedFile(key: string): { sessionId: string; agentId: string | null; projectId: string | null } | null;
  /** Project ids already in use (any origin), for reusing one that differs only in letter case. */
  knownProjectIds(): Iterable<string>;
}

const NO_LOOKUP: DeepSeekLookup = { storedFile: () => null, knownProjectIds: () => [] };

/** What is used of a header line (format reference 4.1). */
interface DshHeader {
  id: string;
  cwd: string | null;
  parentSession: string | null;
  origin: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** The header fields used here; null when the line is not a session header (`type: 'session'` with an `id`). */
export function parseDshHeader(line: string | null): DshHeader | null {
  if (line === null) return null;
  let h: unknown;
  try {
    h = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof h !== 'object' || h === null || Array.isArray(h)) return null;
  const r = h as Record<string, unknown>;
  const id = str(r.id);
  if (r.type !== 'session' || id === null) return null;
  return { id, cwd: str(r.cwd), parentSession: str(r.parentSession), origin: str(r.origin) };
}

/** dsh's `encodeSegment(id)` (format reference 1.2): the session directory name of an id. */
export function encodeDshSegment(id: string): string {
  if (id === '.' || id === '..') return id.replace(/\./g, '~002E');
  let out = '';
  for (let i = 0; i < id.length; i++) {
    const ch = id[i]!;
    out += /[A-Za-z0-9._-]/.test(ch) ? ch : `~${id.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/** A subagent: header `origin: 'subagent'` with a parent other than itself (format reference 4.10; a fork is a session). */
const isSubagent = (h: DshHeader): boolean => h.origin === 'subagent' && h.parentSession !== null && h.parentSession !== h.id;

/** A directory name taken from the listing or a key: not empty, not `.` or `..`, no path syntax. */
const validName = (s: string): boolean => s !== '' && s !== '.' && s !== '..' && !/[\\/:]/.test(s);

/**
 * DeepSeek Harness's `<dsh home>/sessions` (spec 3.1): `<projectKey(cwd)>/<encodeSegment(id)>/session.v4.jsonl.zstd`,
 * read frame by frame (readDshLines). Every other file there (older or newer generations, `.tmp` files, `session.lock`)
 * is not this source's. Keys: `deepseek:` + the path relative to sessions. Diagnostics count the session directories
 * with a generation file that is not read (status().legacyFiles): a directory without a v4 file but with another
 * generation, or a directory whose v4 file sits beside a higher generation (v4 is still read).
 *
 * A file is classified from its header (frame 1, bounded): a subagent (`origin: 'subagent'` with `parentSession`) is an
 * agent thread of its ROOT session, found by following `parentSession` headers (at most DSH_CHAIN_MAX links, cycle
 * check); anything else (forks included) is a session of its own, project from the header `cwd`. While a header on the
 * chain cannot be read (not written yet, torn) the file is not classified ("cannot tell yet"; the next scan or change
 * tries again). The result is cached per key, and taken from the stored raw events when there are any (a rebuild or a
 * vanished file reads nothing). Nothing is ever written under the dsh directory.
 */
export class DeepSeekFileSource implements FileSource {
  readonly origin = 'deepseek' as const;
  readonly rootDir: string;
  /** Reaches `<project>/<session>/session.v4.jsonl.zstd` (two directories below rootDir). */
  readonly watchDepth = 2;
  /** Lines are told apart by their ordinal (header 0, then seq + 1): the identity is `(session, seq)`. */
  readonly lineIdentity = 'offset' as const;
  readonly readLines = readDshLines;
  /** Key -> its class, once decided. */
  private readonly classes = new Map<string, FileClass>();
  /** Session id -> key of the v4 file whose header names it (headers read). */
  private readonly keyById = new Map<string, string>();
  /** Session directory name -> project directories it was listed in. */
  private readonly dirsBySegment = new Map<string, Set<string>>();
  private legacyFiles = 0;
  private readonly resolver: ProjectIdResolver;
  /** Bumped when the listing finds a v4 file it had not seen (a session directory that may be a missing parent). */
  private listEpoch = 0;
  /** v4 files seen by listFiles (absolute paths). */
  private readonly listed = new Set<string>();
  /**
   * Key -> why it was last found unplaceable, with the file's size and modification time then. `missing`: the session
   * id on its chain whose header could not be read (null: its own header is unreadable, or the chain is a cycle or
   * longer than DSH_CHAIN_MAX links: only the file itself changing can change that, headers being immutable). Asked
   * again while the file is unchanged, the missing header has not been read since (by any classification) and the
   * listing found no new v4 file, it answers null after one stat, reading nothing else.
   */
  private readonly unplaced = new Map<string, { size: number; mtimeMs: number; missing: string | null; listEpoch: number }>();

  constructor(
    dshHome: string,
    private readonly lookup: DeepSeekLookup = NO_LOOKUP,
  ) {
    this.rootDir = path.join(dshHome, 'sessions');
    this.resolver = new ProjectIdResolver(() => this.lookup.knownProjectIds());
  }

  /** The v4 file of every session directory (sorted); counts the directories with generations not read. */
  async listFiles(): Promise<string[]> {
    const out: string[] = [];
    let legacy = 0;
    for (const project of await dirs(this.rootDir)) {
      for (const seg of await dirs(path.join(this.rootDir, project))) {
        let names: string[];
        try {
          names = await fsp.readdir(path.join(this.rootDir, project, seg));
        } catch {
          continue;
        }
        let hasV4 = false;
        let other = false;
        let higher = false;
        for (const name of names) {
          const m = GENERATION.exec(name);
          if (m === null) continue;
          const version = m[1] === undefined ? 0 : Number(m[1]);
          if (version === 4) hasV4 = true;
          else other = true;
          if (version > 4) higher = true;
        }
        if (hasV4 ? higher : other) legacy++;
        if (!hasV4) continue;
        const v4 = path.join(this.rootDir, project, seg, V4);
        if (!(await isFile(v4))) continue;
        let at = this.dirsBySegment.get(seg);
        if (at === undefined) this.dirsBySegment.set(seg, (at = new Set()));
        at.add(project);
        if (!this.listed.has(v4)) {
          this.listed.add(v4);
          this.listEpoch++;
        }
        out.push(v4);
      }
    }
    this.legacyFiles = legacy;
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
    const known = this.known(key);
    if (known !== null) return known;
    return this.classifyFromHeaders(key, shape.dir);
  }

  /** No key names the project: it is stored with each raw event. */
  projectOfKey(_key: string): string | null {
    return null;
  }

  projectOfTranscript(absPath: string): string | null {
    const key = this.keyOf(absPath);
    return key === null ? null : (this.known(key)?.projectId ?? null);
  }

  /** A main session's v4 file (a subagent's belongs to its root session, whose main file is the root's). */
  mainSessionOf(key: string): string | null {
    if (shapeOf(key) === null) return null;
    const known = this.known(key);
    return known?.kind === 'session' ? known.sessionId : null;
  }

  status(): { legacyFiles: number } {
    return { legacyFiles: this.legacyFiles };
  }

  // ---------------------------------------------------------------- internals

  private async classifyFromHeaders(key: string, dir: string): Promise<FileClass | null> {
    let st: { size: number; mtimeMs: number };
    try {
      st = await fsp.stat(this.pathOf(key)!);
    } catch {
      return null;
    }
    const was = this.unplaced.get(key);
    if (
      was !== undefined &&
      was.size === st.size &&
      was.mtimeMs === st.mtimeMs &&
      (was.missing === null || (!this.keyById.has(was.missing) && was.listEpoch === this.listEpoch))
    ) {
      return null;
    }
    const listEpoch = this.listEpoch;
    const placed = await this.placeFromHeaders(key, dir);
    if ('cls' in placed) {
      this.unplaced.delete(key);
      return placed.cls;
    }
    this.unplaced.set(key, { size: st.size, mtimeMs: st.mtimeMs, missing: placed.missing, listEpoch });
    return null;
  }

  private async placeFromHeaders(key: string, dir: string): Promise<{ cls: FileClass } | { missing: string | null }> {
    const header = await this.headerOf(key);
    if (header === null) return { missing: null }; // not a session (yet)
    if (!isSubagent(header)) return { cls: this.remember(key, { kind: 'session', projectId: this.project(header.cwd), sessionId: header.id }) };
    const root = await this.rootOf(header, dir);
    if (!('root' in root)) return root;
    // A thread always gets its root session's project (one session, one project), whatever its own header says.
    return { cls: this.remember(key, { kind: 'agent', projectId: this.project(root.root.cwd), sessionId: root.root.id, agentId: header.id }) };
  }

  /**
   * The root session of a subagent: up the chain of `parentSession` headers while the parent is a subagent itself.
   * Not found ("cannot tell yet"): `missing` = the id whose header cannot be read (yet), or null on a cycle or past
   * DSH_CHAIN_MAX links.
   */
  private async rootOf(child: DshHeader, dir: string): Promise<{ root: DshHeader } | { missing: string | null }> {
    const seen = new Set([child.id]);
    let id = child.parentSession!;
    for (let depth = 0; depth < DSH_CHAIN_MAX; depth++) {
      if (seen.has(id)) return { missing: null };
      seen.add(id);
      const parent = await this.findHeader(id, dir);
      if (parent === null) return { missing: id };
      if (!isSubagent(parent.header)) return { root: parent.header };
      dir = parent.dir;
      id = parent.header.parentSession!;
    }
    return { missing: null };
  }

  /**
   * The header of session `id`: the file its header was last seen in, else `<dir>/<encodeSegment(id)>` (a child sits in
   * its parent's project directory), else that session directory under any other project directory (dsh's own findLog).
   */
  private async findHeader(id: string, dir: string): Promise<{ header: DshHeader; dir: string } | null> {
    const seg = encodeDshSegment(id);
    const candidates: string[] = [];
    const add = (k: string | undefined): void => {
      if (k !== undefined && !candidates.includes(k)) candidates.push(k);
    };
    add(this.keyById.get(id));
    add(`${PREFIX}${dir}/${seg}/${V4}`);
    for (const d of this.dirsBySegment.get(seg) ?? []) add(`${PREFIX}${d}/${seg}/${V4}`);
    const tryAll = async (from: number): Promise<{ header: DshHeader; dir: string } | null> => {
      for (const k of candidates.slice(from)) {
        const header = await this.headerOf(k);
        if (header?.id === id) return { header, dir: shapeOf(k)!.dir };
      }
      return null;
    };
    const tried = candidates.length;
    const hit = await tryAll(0);
    if (hit !== null) return hit;
    for (const d of await dirs(this.rootDir)) if (await isFile(path.join(this.rootDir, d, seg, V4))) add(`${PREFIX}${d}/${seg}/${V4}`);
    return tryAll(tried);
  }

  /** The header of a key's file (frame 1 only, bounded); null while it cannot be read. */
  private async headerOf(key: string): Promise<DshHeader | null> {
    const header = parseDshHeader(await readDshHeaderLine(this.pathOf(key)!, DSH_HEADER_MAX_BYTES));
    if (header !== null) this.keyById.set(header.id, key);
    return header;
  }

  /** Cached, else stored with the key's raw events (no read). */
  private known(key: string): FileClass | null {
    // Cached for good: a session header is immutable (format reference 4.1, 4.8); a rewritten frame 1 is read as a
    // rewrite of the whole file (readDshLines), not as a session moving to another project.
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

  /** Project id of a header cwd (the header is the authority; the directory name is lossy). */
  private project(cwd: string | null): string {
    return cwd === null ? UNKNOWN_PROJECT : this.resolver.forCwd(normaliseCwd(cwd));
  }
}

/** Names of the subdirectories of `dir` that may be dsh directories (none when it cannot be read). */
async function dirs(dir: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((d) => d.isDirectory() && validName(d.name)).map((d) => d.name);
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** `<project dir>/<session dir>` of a key, or null when it is not a v4 file's key. */
function shapeOf(key: string): { dir: string; seg: string } | null {
  if (!key.startsWith(PREFIX)) return null;
  const parts = key.slice(PREFIX.length).split('/');
  if (parts.length !== 3) return null;
  const [dir, seg, name] = parts as [string, string, string];
  if (!validName(dir) || !validName(seg) || name !== V4) return null;
  return { dir, seg };
}
