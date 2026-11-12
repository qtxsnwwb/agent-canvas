import type { Origin } from '@claude-canvas/shared';

/** One record a poll source read: stored as a transcript raw event's line, with its record type. */
export interface PollRecord {
  recordType: string;
  line: string;
}

/**
 * Records of one store key (e.g. one Cursor conversation, `cursor:<composerId>`), all belonging to one session (and
 * thread: `agentId` null for the main thread). `projectId` is stored with each raw event (replay uses it).
 */
export interface PollBatch {
  key: string;
  projectId: string;
  sessionId: string;
  agentId: string | null;
  records: PollRecord[];
}

/** Last completed poll (ISO 8601) and last error message of a poll source; null when none. */
export interface PollStatus {
  lastPollAt: string | null;
  lastError: string | null;
}

/** What a poll source may ask of the pipeline. Bound to the source's origin. */
export interface PollSink {
  /**
   * Stores each record as a `source: 'transcript'` raw event of the source's origin under `file = batch.key`, in order
   * (a record whose line is already stored under that key is skipped: unchanged records are no-ops), and applies the
   * new ones through the normalizer, serialised per session with every other ingestion. Rejects when the slice could
   * not be committed (nothing of it is stored then; the failure is also reported under `batch.key`), and once the
   * pipeline is closed (nothing stored, nothing reported). A successful batch clears no failure: see clearFailure.
   */
  ingestRecords(batch: PollBatch): Promise<void>;
  /** Flags the session "source deleted" (data kept; the flag sticks to later changes). Idempotent; no-op once closed. */
  markSourceDeleted(sessionId: string): Promise<void>;
  /** Undoes markSourceDeleted, including a flag stored by an earlier run. Idempotent; no-op once closed. */
  clearSourceDeleted(sessionId: string): Promise<void>;
  /** Records a failure under `key` for diagnostics (ingestFailures) and logs one line, rate limited per key. */
  reportFailure(key: string, err: unknown): void;
  /**
   * Removes the failure recorded under `key` (by reportFailure or a failed ingestRecords), e.g. once the conversation
   * reads and ingests cleanly again. No-op when there is none.
   */
  clearFailure(key: string): void;
  /**
   * Distinct session ids of the transcript records stored under this origin's key prefix, by any run (so a source can
   * re-assert "source deleted" marks after a restart or rebuild, which do not keep them). Read-only.
   */
  storedSessionIds(): string[];
  /**
   * What the source saved with saveUnitState, by store key (this origin's keys only), as saved by any earlier run.
   * Read-only.
   */
  loadUnitStates(): Map<string, string>;
  /**
   * Saves (`value`) or deletes (null) the source's own note about the unit stored under `key` (a key of this origin),
   * kept across restarts and rebuilds (it describes what was read and stored, not derived data). Throws when it could not
   * be written.
   */
  saveUnitState(key: string, value: string | null): void;
}

/**
 * A source of one origin whose data is polled (Cursor's SQLite state database) rather than read from appended files.
 * The pipeline starts it after its initial file scan, stops it on close, and pokes it when a hook of its origin
 * arrives for a session. Rebuild never touches it: it replays the raw events the source stored.
 */
export interface PollSource {
  readonly origin: Origin;
  start(sink: PollSink): void;
  /** Stops polling; resolves once no poll is running. */
  stop(): Promise<void>;
  /** A hook of this origin arrived for the session: poll it soon. */
  poke(sessionId: string): void;
  status(): PollStatus;
}
