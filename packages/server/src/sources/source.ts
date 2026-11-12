import { ORIGINS, type Origin } from '@claude-canvas/shared';

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

/** A value, or a promise of it: synchronous sources answer directly, so the pipeline never waits on them. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Prefix of each origin's store keys (raw_event.file, file_offset.file). Claude Code keys are the paths relative to
 * projectsDir, unprefixed as before origins existed; every other origin's keys carry its prefix.
 */
export const KEY_PREFIXES: Readonly<Record<Origin, string>> = { claude: '', codex: 'codex:', cursor: 'cursor:' };

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
}

export function isPromise<T>(v: MaybePromise<T>): v is Promise<T> {
  return typeof (v as { then?: unknown } | null)?.then === 'function';
}
