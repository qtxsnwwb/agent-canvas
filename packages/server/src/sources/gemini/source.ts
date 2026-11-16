import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ProjectIdResolver } from '../project-ids.js';
import { KEY_PREFIXES, type FileClass, type FileSource, type IndexEntry, type MaybePromise } from '../source.js';
import { GEMINI_PROJECT_ENTRY_PREFIX, geminiProject } from './project.js';

const PREFIX = KEY_PREFIXES.gemini;
/** Gemini's project registry, next to (not under) the tmp directory. */
const PROJECTS_JSON = 'projects.json';
export const GEMINI_PROJECTS_KEY = `${PREFIX}../${PROJECTS_JSON}`;
const PROJECT_ROOT = '.project_root';
const MAIN_FILE = /^session-.+\.jsonl?$/;
const SUB_FILE = /^.+\.jsonl?$/;
/** Gemini's own temporary and quarantined copies (rewriteConversationFile). */
const IGNORED = /\.(tmp|unreadable)-/;
/** A first line longer than this is not a metadata line we can use. */
const FIRST_LINE_MAX_BYTES = 1024 * 1024;
/** How much of a legacy `.json` is read to find its `sessionId` before parsing the whole file. */
const HEAD_BYTES = 64 * 1024;
/**
 * Largest legacy `.json` read at all (the pipeline reads it whole as one meta record, and its session id may need a whole
 * parse). Gemini CLI stopped writing them at 0.39; a larger one is reported as a failure and nothing of it is ingested.
 */
export const GEMINI_LEGACY_MAX_BYTES = 64 * 1024 * 1024;
const CHUNK = 64 * 1024;
const NEWLINE = 0x0a;

/** What a session file belongs to, as stored with its raw events. */
export interface GeminiStoredFile {
  sessionId: string;
  agentId: string | null;
  projectId: string | null;
}

/** What the source may ask the store (never file contents). */
export interface GeminiLookup {
  /** Session, agent and project stored with the transcript raw events of a key; null when none are stored. */
  storedFile(key: string): GeminiStoredFile | null;
  /** Project ids already in use (any origin), for reusing one that differs only in letter case (Windows). */
  knownProjectIds(): Iterable<string>;
}

const NO_LOOKUP: GeminiLookup = { storedFile: () => null, knownProjectIds: () => [] };

/** A key's file shape, from its path alone. */
type Shape =
  | { kind: 'projects' }
  | { kind: 'root'; slug: string }
  | { kind: 'main'; slug: string; legacy: boolean }
  | { kind: 'sub'; slug: string; parent: string; agentId: string; legacy: boolean };

interface Known {
  sessionId: string;
  agentId: string | null;
  projectId: string;
  slug: string;
}

/**
 * Gemini CLI's `<root>/tmp` (spec 5.1): `<slug>/chats/session-*.jsonl` (main sessions; legacy whole-object
 * `session-*.json`), `<slug>/chats/<session id>/<agent id>.jsonl` (subagent threads; legacy `.json` likewise),
 * `<slug>/.project_root` and `../projects.json` (the project's directory). Keys: `gemini:` + the path relative to tmp.
 *
 * A main `.jsonl`'s session id is read from its first line (bounded), a legacy `.json`'s from its head; a subagent's
 * session and agent come from its path. Each key's session and project are cached, and taken from the stored raw events
 * when there are any (a rebuild and a vanished file keep what was stored). A legacy `.json` with a `.jsonl` of the same
 * name next to it is not read (Gemini copies the session into the `.jsonl` on resume). `.project_root` and
 * `projects.json` are index files: for every session seen in a project directory they yield one meta raw event
 * (`gemini:@project/<session id>`, payload `{"cwd": …}`, with the project id), so the normalizer — and every rebuild —
 * has the working directory without reading these files again.
 */
export class GeminiFileSource implements FileSource {
  readonly origin = 'gemini' as const;
  /** Reaches `<slug>/chats/<session id>/<agent id>.jsonl` (directories below rootDir: 3). */
  readonly watchDepth = 3;
  private readonly projectsPath: string;
  private readonly files = new Map<string, Known>();
  /** Session id -> project directory (slug) it was seen in, in order of first sight. */
  private readonly sessions = new Map<string, string>();
  private readonly slugs = new Set<string>();
  /** Project ids in use, reused (Windows) when a cwd differs only in letter case. */
  private readonly projects: ProjectIdResolver;

  private readonly legacyMaxBytes: number;

  constructor(
    readonly rootDir: string,
    private readonly lookup: GeminiLookup = NO_LOOKUP,
    options: { legacyMaxBytes?: number } = {},
  ) {
    this.legacyMaxBytes = options.legacyMaxBytes ?? GEMINI_LEGACY_MAX_BYTES;
    this.projectsPath = path.join(path.dirname(path.resolve(rootDir)), PROJECTS_JSON);
    this.projects = new ProjectIdResolver(() => this.lookup.knownProjectIds());
  }

  private project(slug: string): { projectId: string; cwd: string | null } {
    return geminiProject(this.rootDir, slug, () => this.lookup.knownProjectIds(), process.platform, this.projects);
  }

  /** projects.json, and the `.project_root` of every project directory a session was seen in (grows as they appear). */
  indexFiles(): readonly string[] {
    return [this.projectsPath, ...[...this.slugs].sort().map((s) => path.join(this.rootDir, s, PROJECT_ROOT))];
  }

  /** Only `<slug>/.project_root` and `<slug>/chats/**` are listed (not logs, checkpoints, tool outputs), plus projects.json. */
  async listFiles(): Promise<string[]> {
    let slugs: string[];
    try {
      slugs = (await fsp.readdir(this.rootDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
    const files: string[] = [];
    for (const slug of slugs) {
      files.push(path.join(this.rootDir, slug, PROJECT_ROOT));
      const chats = path.join(this.rootDir, slug, 'chats');
      let entries: string[];
      try {
        entries = await fsp.readdir(chats, { recursive: true });
      } catch {
        continue;
      }
      for (const rel of entries) files.push(path.join(chats, rel));
    }
    const out: string[] = [];
    for (const abs of files) {
      if (this.keyOf(abs) === null) continue;
      if (abs.endsWith(PROJECT_ROOT)) {
        try {
          if (!(await fsp.stat(abs)).isFile()) continue;
        } catch {
          continue;
        }
      }
      out.push(abs);
    }
    try {
      if ((await fsp.stat(this.projectsPath)).isFile()) out.push(this.projectsPath);
    } catch {
      // no registry
    }
    return out.sort();
  }

  keyOf(absPath: string): string | null {
    const rel = path.relative(this.rootDir, absPath);
    if (rel === '' || path.isAbsolute(rel)) return null;
    const parts = rel.split(/[\\/]+/).filter((p) => p !== '');
    if (parts.length === 2 && parts[0] === '..' && parts[1] === PROJECTS_JSON) return GEMINI_PROJECTS_KEY;
    const key = PREFIX + parts.join('/');
    return shapeOf(key) === null ? null : key;
  }

  pathOf(key: string): string | null {
    const shape = shapeOf(key);
    if (shape === null) return null;
    if (shape.kind === 'projects') return this.projectsPath;
    return path.join(this.rootDir, ...key.slice(PREFIX.length).split('/'));
  }

  classify(key: string): MaybePromise<FileClass | null> {
    const shape = shapeOf(key);
    if (shape === null) return null;
    if (shape.kind === 'projects' || shape.kind === 'root') return { kind: 'index', projectId: '', sessionId: '' };
    if (shape.legacy && this.hasJsonl(key)) return null;
    // Checked at every classification (the pipeline classifies before each whole read), not only the first one.
    if (shape.legacy) this.checkLegacySize(key);
    const known = this.known(key, shape);
    if (known !== null) return toClass(known, shape.legacy);
    if (shape.kind === 'sub') return toClass(this.remember(key, shape.slug, shape.parent, shape.agentId), shape.legacy);
    const read = shape.legacy ? this.legacySessionId(key) : this.firstLineSessionId(key);
    return read.then((sessionId) => (sessionId === null ? null : toClass(this.remember(key, shape.slug, sessionId, null), shape.legacy)));
  }

  /** No key names the project: it is stored with each raw event. */
  projectOfKey(_key: string): string | null {
    return null;
  }

  projectOfTranscript(absPath: string): string | null {
    const key = this.keyOf(absPath);
    const shape = key === null ? null : shapeOf(key);
    if (key === null || shape === null || shape.kind === 'projects' || shape.kind === 'root') return null;
    return this.known(key, shape)?.projectId ?? null;
  }

  mainSessionOf(key: string): string | null {
    const shape = shapeOf(key);
    if (shape?.kind !== 'main') return null;
    if (shape.legacy && this.hasJsonl(key)) return null;
    return this.known(key, shape)?.sessionId ?? null;
  }

  /**
   * One entry per session seen whose project directory has a working directory (`.project_root`, else
   * `projects.json`): its project id and `{"cwd": …}`. The same for either file, so each is written once.
   */
  indexEntries(key: string, _content: string): IndexEntry[] {
    const shape = shapeOf(key);
    if (shape === null || (shape.kind !== 'projects' && shape.kind !== 'root')) return [];
    const out: IndexEntry[] = [];
    const bySlug = new Map<string, { projectId: string; cwd: string | null }>();
    for (const [sessionId, slug] of this.sessions) {
      if (shape.kind === 'root' && slug !== shape.slug) continue;
      let project = bySlug.get(slug);
      if (project === undefined) bySlug.set(slug, (project = this.project(slug)));
      if (project.cwd === null) continue;
      out.push({ key: GEMINI_PROJECT_ENTRY_PREFIX + sessionId, sessionId, agentId: null, projectId: project.projectId, payload: JSON.stringify({ cwd: project.cwd }) });
    }
    return out;
  }

  /** Grows with every newly seen session. */
  indexVersion(): number {
    return this.sessions.size;
  }

  // ---------------------------------------------------------------- internals

  private hasJsonl(key: string): boolean {
    try {
      return fs.statSync(`${this.pathOf(key)!}l`).isFile();
    } catch {
      return false;
    }
  }

  /** Cached, else stored with the key's raw events (no read). */
  private known(key: string, shape: Shape): Known | null {
    const cached = this.files.get(key);
    if (cached !== undefined) return cached;
    if (shape.kind !== 'main' && shape.kind !== 'sub') return null;
    const stored = this.lookup.storedFile(key);
    if (stored === null || stored.projectId === null) return null;
    return this.note(key, { sessionId: stored.sessionId, agentId: stored.agentId, projectId: stored.projectId, slug: shape.slug });
  }

  private remember(key: string, slug: string, sessionId: string, agentId: string | null): Known {
    const existing = this.files.get(key);
    if (existing !== undefined) return existing;
    const { projectId } = this.project(slug);
    return this.note(key, { sessionId, agentId, projectId, slug });
  }

  private note(key: string, known: Known): Known {
    const existing = this.files.get(key);
    if (existing !== undefined) return existing; // a concurrent read got there first
    this.files.set(key, known);
    if (!this.sessions.has(known.sessionId)) this.sessions.set(known.sessionId, known.slug);
    this.slugs.add(known.slug);
    return known;
  }

  /**
   * The `sessionId` of a main `.jsonl`'s first line (the metadata line). Null when the file does not exist; throws (an
   * ingest failure the pipeline reports and retries) when the line is missing, incomplete or names no session.
   */
  private async firstLineSessionId(key: string): Promise<string | null> {
    const text = await readHead(this.pathOf(key)!, FIRST_LINE_MAX_BYTES, true);
    if (text === null) return null;
    let rec: unknown;
    try {
      rec = JSON.parse(text);
    } catch {
      throw new Error('gemini session: first line is not JSON');
    }
    const id = isObject(rec) && typeof rec.sessionId === 'string' && rec.sessionId !== '' ? rec.sessionId : null;
    if (id === null) throw new Error('gemini session: first line has no sessionId');
    return id;
  }

  /** Throws (reported in the failures list, nothing ingested) when a legacy `.json` is larger than the cap. */
  private checkLegacySize(key: string): void {
    let size: number;
    try {
      size = fs.statSync(this.pathOf(key)!).size;
    } catch {
      return; // gone: the pipeline handles a missing file
    }
    if (size > this.legacyMaxBytes) throw new Error(`gemini legacy session: ${size} bytes, larger than ${this.legacyMaxBytes}; not read`);
  }

  /** A legacy `.json`'s `sessionId`: from its head (it is the first key Gemini writes), else from the whole file. */
  private async legacySessionId(key: string): Promise<string | null> {
    const abs = this.pathOf(key)!;
    const head = await readHead(abs, HEAD_BYTES, false);
    if (head === null) return null;
    const m = /^\s*\{\s*"sessionId"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
    if (m !== null) {
      try {
        const id = JSON.parse(`"${m[1]}"`) as string;
        if (id !== '') return id;
      } catch {
        // fall through to the whole file
      }
    }
    let rec: unknown;
    try {
      rec = JSON.parse(await fsp.readFile(abs, 'utf8')); // size checked by classify (checkLegacySize)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('gemini legacy session: not a JSON object (yet)');
    }
    if (!isObject(rec) || typeof rec.sessionId !== 'string' || rec.sessionId === '') throw new Error('gemini legacy session: no sessionId');
    return rec.sessionId;
  }
}

/**
 * The start of a file: up to the first line break (`lineOnly`; throws when there is none within `max` bytes or the file
 * is empty), else up to `max` bytes. Null when the file does not exist.
 */
async function readHead(abs: string, max: number, lineOnly: boolean): Promise<string | null> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(abs, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buf = Buffer.alloc(CHUNK);
      const { bytesRead } = await handle.read(buf, 0, CHUNK, total);
      if (bytesRead === 0) break;
      const part = buf.subarray(0, bytesRead);
      if (lineOnly) {
        const nl = part.indexOf(NEWLINE);
        if (nl !== -1) {
          chunks.push(part.subarray(0, nl));
          return Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '').replace(/\r$/, '');
        }
      }
      chunks.push(part);
      total += bytesRead;
      if (total >= max) break;
    }
    if (lineOnly) throw new Error(total === 0 ? 'gemini session: first line missing (empty file)' : total >= max ? 'gemini session: first line too long' : 'gemini session: first line incomplete');
    return Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '');
  } finally {
    await handle.close();
  }
}

/** The shape of a key from its path alone, or null when it is none of this source's files. */
function shapeOf(key: string): Shape | null {
  if (!key.startsWith(PREFIX)) return null;
  if (key === GEMINI_PROJECTS_KEY) return { kind: 'projects' };
  const parts = key.slice(PREFIX.length).split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..') || parts[0]!.startsWith('@')) return null;
  const name = parts[parts.length - 1]!;
  if (IGNORED.test(name)) return null;
  const slug = parts[0]!;
  if (parts.length === 2 && name === PROJECT_ROOT) return { kind: 'root', slug };
  if (parts.length === 3 && parts[1] === 'chats' && MAIN_FILE.test(name)) return { kind: 'main', slug, legacy: name.endsWith('.json') };
  if (parts.length === 4 && parts[1] === 'chats' && SUB_FILE.test(name)) {
    const legacy = name.endsWith('.json');
    const agentId = name.slice(0, name.length - (legacy ? 5 : 6));
    return agentId === '' ? null : { kind: 'sub', slug, parent: parts[2]!, agentId, legacy };
  }
  return null;
}

const toClass = (k: Known, legacy: boolean): FileClass => {
  if (k.agentId === null) return { kind: legacy ? 'title' : 'session', projectId: k.projectId, sessionId: k.sessionId };
  return { kind: legacy ? 'agent_meta' : 'agent', projectId: k.projectId, sessionId: k.sessionId, agentId: k.agentId };
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
