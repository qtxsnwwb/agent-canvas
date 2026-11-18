import { ORIGINS, type FileSourceStatus, type Origin } from '@agent-canvas/shared';

/**
 * What a file is to the pipeline. `session` / `agent`: an appended JSONL of the session's main thread / of one of its
 * agents' threads (read line by line); `title` / `agent_meta`: a small file read whole (stored as a meta raw event).
 * `agentId` is set for `agent` and `agent_meta`. `index`: a file read whole that holds entries of many sessions (see
 * FileSource.indexEntries); its `projectId` and `sessionId` are empty and unused.
 */
export interface FileClass {
  kind: 'session' | 'agent' | 'agent_meta' | 'title' | 'index';
  projectId: string;
  sessionId: string;
  agentId?: string;
}

/**
 * One session's entry of an index file, stored as a meta raw event under its own `key` (so "unchanged since last
 * emitted" is decided per session) and applied to that session only.
 */
export interface IndexEntry {
  /** Store key of the entry (raw_event.file of the meta event); stable per session. */
  key: string;
  sessionId: string;
  agentId: string | null;
  /** Project of the session, passed to the normalizer with the event. */
  projectId: string;
  payload: string;
}

/**
 * What FileSource.readLines read from a file: complete lines from `fromOffset` on (or from the start when `truncated`),
 * and where to resume.
 */
export interface SourceRead {
  /** Offset strictly increasing within one generation of the file (normalisers take a smaller one for a restart). */
  lines: { offset: number; text: string }[];
  /** Byte position in the file to resume from. */
  newOffset: number;
  /** The file was rewritten: lines restart from the beginning (the generation of a lineIdentity 'offset' file is bumped). */
  truncated: boolean;
  /** Opaque reader state persisted with the offset (same transaction); undefined = leave the stored one as is, null = remove it. */
  state?: string | null;
}

/** A value, or a promise of it: synchronous sources answer directly, so the pipeline never waits on them. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Prefix of each origin's store keys (raw_event.file, file_offset.file). Claude Code keys are the paths relative to
 * projectsDir, unprefixed as before origins existed; every other origin's keys carry its prefix.
 */
export const KEY_PREFIXES: Readonly<Record<Origin, string>> = {
  claude: '',
  codex: 'codex:',
  cursor: 'cursor:',
  gemini: 'gemini:',
  grok: 'grok:',
  copilot: 'copilot:',
  deepseek: 'deepseek:',
  workbuddy: 'workbuddy:',
  codebuddy: 'codebuddy:',
  doubao: 'doubao:',
  qwen: 'qwen:',
};

/** The origin a store key belongs to: the one whose prefix is the longest that matches. */
export function originOfKey(key: string): Origin {
  let best: Origin = 'claude';
  for (const origin of ORIGINS) {
    const prefix = KEY_PREFIXES[origin];
    if (key.startsWith(prefix) && prefix.length > KEY_PREFIXES[best].length) best = origin;
  }
  return best;
}

/**
 * A directory of session files of one origin: how its files are found and keyed (keys start with
 * KEY_PREFIXES[origin]), and which session (thread, project) each file belongs to. The pipeline holds a list of these,
 * at most one per origin; everything after a file's lines are read is shared.
 */
export interface FileSource {
  readonly origin: Origin;
  /** Directory the source's files live under (watched). */
  readonly rootDir: string;
  /** chokidar depth below rootDir that reaches every file of the source. */
  readonly watchDepth: number;
  /**
   * Optional. The directories to watch, each at its own chokidar depth, when the source's files live under several
   * roots; preferred over rootDir/watchDepth when present (an empty list watches nothing). Read once when the watcher
   * starts: roots that appear later are found by the full scan's listing.
   */
  readonly watchRoots?: readonly { dir: string; depth: number }[];
  /**
   * Optional. Reads the session/agent file's lines itself (a container that is not plain JSONL, or a guard against
   * rewrites, see readGuardedLines) instead of the pipeline's readNewLines. Called with the stored offset (0 the first
   * time) and the state it returned last time (null the first time, or after it returned null); the state returned is
   * stored in the same transaction as `newOffset`. Called on every change event, and by the scans when the file's size
   * or modification time differs from what the last read saw (a source without readLines is compared by size only).
   */
  readLines?(absPath: string, fromOffset: number, maxBytes: number, state: string | null): Promise<SourceRead>;
  /**
   * Optional. How a line of the source's session files is told apart from the others when stored (the raw-event dedupe):
   * `content` (default) by its text alone — a byte-identical line anywhere in the file is the same line; `offset` by its
   * text, its byte offset and the file's generation (bumped each time the file is found shorter than what was read, so
   * a rewritten file is read again whole) — for append-only logs whose lines may legitimately repeat (Grok's streamed
   * chunks). A re-read of an unchanged file adds nothing either way.
   */
  readonly lineIdentity?: 'content' | 'offset';
  /**
   * Optional. Absolute paths of files to ingest right after the index file `key` was read: files whose classification
   * depends on it (e.g. a session log that is not a session until its summary exists).
   */
  afterIndex?(key: string): string[];
  /** Absolute paths of the files that may belong to this source (listed without reading them), sorted. */
  listFiles(): Promise<string[]>;
  /** Store key of an absolute path, or null when the path is not one of this source's files' locations. */
  keyOf(absPath: string): string | null;
  /** Absolute path of a store key, or null when the key is not this source's. */
  pathOf(key: string): string | null;
  /**
   * What the keyed file is, or null when it is none of this source's files, or cannot be told yet (a source that must
   * read the file may say null until the file says enough). May read the file.
   */
  classify(key: string): MaybePromise<FileClass | null>;
  /**
   * The project named by the key alone, without reading anything (replay of stored raw events); null when the key does
   * not name it (the source then stores the project with each raw event).
   */
  projectOfKey(key: string): string | null;
  /**
   * Project of a session or agent transcript at `absPath` as named by a hook payload's transcript_path, without reading
   * the file; null when unknown.
   */
  projectOfTranscript(absPath: string): string | null;
  /**
   * The session whose main file the key is (the file whose disappearance marks the session "source deleted"), or null
   * when the key is another kind of file or the source cannot tell. Called for every recorded key on each full scan.
   */
  mainSessionOf(key: string): MaybePromise<string | null>;
  /**
   * Optional. Project of a hook event of this origin from its payload, without reading anything: `cwd` encoded the way
   * the source encodes a session's directory; for a subagent's hook (`agentId` set) the session's project when the
   * source knows it. Null when it cannot tell.
   */
  projectOfHook?(sessionId: string | null, cwd: string | null, agentId: string | null): string | null;
  /**
   * Optional. Absolute paths of index files (classified `index`), possibly outside rootDir: each is also watched
   * (its directory at depth 0), listed by listFiles when it exists, and checked by every rescan.
   */
  indexFiles?(): readonly string[];
  /** Optional, with indexFiles: the entries the source can place now, given an index file's whole content. */
  indexEntries?(key: string, content: string): IndexEntry[];
  /**
   * Optional, with indexFiles: a value that changes whenever indexEntries could place more entries than before (e.g. a
   * new root thread was seen); the pipeline then re-reads the index files even when their size did not change.
   */
  indexVersion?(): number;
  /**
   * Optional. What the source adds to its Diagnostics.sources entry (e.g. legacy files skipped, duplicate sessions,
   * why it cannot run here); merged over the entry the server assembles. Never reads anything that blocks.
   */
  status?(): Partial<FileSourceStatus>;
}

export function isPromise<T>(v: MaybePromise<T>): v is Promise<T> {
  return typeof (v as { then?: unknown } | null)?.then === 'function';
}
