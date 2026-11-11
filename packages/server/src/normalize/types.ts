import type { Change } from '@claude-canvas/shared';
import type { RawEvent } from '../store/store.js';

export interface NormalizeResult {
  changes: Change[];
  unknownRecordType?: string;
}

/**
 * What the pipeline needs from the normalizer of one origin: raw events in, graph changes out, plus the in-memory
 * session bookkeeping the pipeline drives (eviction, hydration from the raw log). One instance per origin; the
 * pipeline hands each one only the raw events of its origin.
 */
export interface AgentNormalizer {
  /** `projectId` is the project the event belongs to ('unknown' when it cannot be told). Never throws. */
  apply(event: RawEvent, projectId: string): NormalizeResult;
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
