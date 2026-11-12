import type { Change } from '@agent-canvas/shared';
import type { RawEvent } from '../store/store.js';

export interface NormalizeResult {
  changes: Change[];
  unknownRecordType?: string;
}

/** One event of a batch and the project it belongs to (as `apply` takes them). */
export interface BatchItem {
  event: RawEvent;
  projectId: string;
}

/** The result of applying a batch: every change, and the unknown record type of each event (by index). */
export interface BatchResult {
  changes: Change[];
  unknown: (string | undefined)[];
}

/**
 * What the pipeline needs from the normalizer of one origin: raw events in, graph changes out, plus the in-memory
 * session bookkeeping the pipeline drives (eviction, hydration from the raw log). One instance per origin; the
 * pipeline hands each one only the raw events of its origin.
 */
export interface AgentNormalizer {
  /** `projectId` is the project the event belongs to ('unknown' when it cannot be told). Never throws. */
  apply(event: RawEvent, projectId: string): NormalizeResult;
  /**
   * Optional: applies the events in order, ending in the state, graph and session that applying them one by one would
   * give (the change stream may be shorter: intermediate versions are not emitted), deriving once at the end instead
   * of once per event. Never throws. Without it, callers apply the events one by one.
   */
  applyBatch?(items: readonly BatchItem[]): BatchResult;
  /** Forgets everything held for the session (it is re-hydrated from the raw log on its next event). */
  dropSession(sessionId: string): void;
  /** True when the session has no state and its pre-session memory has not been restored since it was last dropped. */
  needsPreSessionReplay(sessionId: string): boolean;
  /**
   * For a session that has committed raw events but no session yet: rebuilds what the normalizer keeps before a
   * session exists from those events, in ingest order, without producing changes.
   */
  restorePreSession(sessionId: string, events: Iterable<RawEvent>): void;
  hasSession(sessionId: string): boolean;
  /** Number of sessions held in memory. */
  sessionCount(): number;
  /** Number of tool inputs held in memory for a session (introspection for tests). */
  toolInputCount(sessionId: string): number;
}
