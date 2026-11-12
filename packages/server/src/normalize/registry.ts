import { ORIGINS, type Origin } from '@claude-canvas/shared';
import type { RawEvent } from '../store/store.js';
import { CodexNormalizer } from './codex.js';
import { CursorNormalizer } from './cursor.js';
import { Normalizer } from './normalizer.js';
import type { AgentNormalizer, BatchItem, BatchResult, NormalizeResult } from './types.js';

/** How to make a fresh normalizer for each origin; null = that origin has none (its raw events are stored only). */
export type NormalizerFactories = Readonly<Record<Origin, (() => AgentNormalizer) | null>>;

/** The normalizer of each origin. */
export const NORMALIZER_FACTORIES: NormalizerFactories = {
  claude: () => new Normalizer(),
  codex: () => new CodexNormalizer(),
  cursor: () => new CursorNormalizer(),
};

const originOf = (event: RawEvent): Origin => event.origin ?? 'claude';

function* ofOrigin(events: Iterable<RawEvent>, origin: Origin): Generator<RawEvent> {
  for (const ev of events) if (originOf(ev) === origin) yield ev;
}

/**
 * One fresh normalizer per origin behind the AgentNormalizer surface the pipeline drives: `apply` goes to the
 * normalizer of the event's origin (an origin without one yields no changes); the per-session calls cover every
 * origin (a session id belongs to one origin, so at most one of them holds state for it).
 */
export class NormalizerRegistry implements AgentNormalizer {
  private readonly entries: [Origin, AgentNormalizer][] = [];

  constructor(factories: NormalizerFactories = NORMALIZER_FACTORIES) {
    for (const origin of ORIGINS) {
      const make = factories[origin];
      if (make !== null) this.entries.push([origin, make()]);
    }
  }

  private of(origin: Origin): AgentNormalizer | null {
    return this.entries.find(([o]) => o === origin)?.[1] ?? null;
  }

  apply(event: RawEvent, projectId: string): NormalizeResult {
    return this.of(originOf(event))?.apply(event, projectId) ?? { changes: [] };
  }

  /**
   * Runs of consecutive events of one origin go to that origin's normalizer: as one batch when it has applyBatch,
   * otherwise one by one through apply (exactly what applying each event in turn does).
   */
  applyBatch(items: readonly BatchItem[]): BatchResult {
    const changes: BatchResult['changes'] = [];
    const unknown: BatchResult['unknown'] = [];
    let i = 0;
    while (i < items.length) {
      const origin = originOf(items[i]!.event);
      let j = i + 1;
      while (j < items.length && originOf(items[j]!.event) === origin) j += 1;
      const n = this.of(origin);
      if (n === null) {
        for (let k = i; k < j; k++) unknown.push(undefined);
      } else if (n.applyBatch !== undefined) {
        const r = n.applyBatch(items.slice(i, j));
        for (const c of r.changes) changes.push(c);
        for (const u of r.unknown) unknown.push(u);
      } else {
        for (let k = i; k < j; k++) {
          const r = n.apply(items[k]!.event, items[k]!.projectId);
          for (const c of r.changes) changes.push(c);
          unknown.push(r.unknownRecordType);
        }
      }
      i = j;
    }
    return { changes, unknown };
  }

  dropSession(sessionId: string): void {
    for (const [, n] of this.entries) n.dropSession(sessionId);
  }

  needsPreSessionReplay(sessionId: string): boolean {
    return this.entries.some(([, n]) => n.needsPreSessionReplay(sessionId));
  }

  /** Each normalizer that needs it gets the events of its own origin, in order. */
  restorePreSession(sessionId: string, events: Iterable<RawEvent>): void {
    const targets = this.entries.filter(([, n]) => n.needsPreSessionReplay(sessionId));
    if (targets.length === 0) return;
    const replayable = targets.length === 1 ? events : [...events]; // read the raw log once
    for (const [origin, n] of targets) n.restorePreSession(sessionId, ofOrigin(replayable, origin));
  }

  hasSession(sessionId: string): boolean {
    return this.entries.some(([, n]) => n.hasSession(sessionId));
  }

  sessionCount(): number {
    return this.entries.reduce((sum, [, n]) => sum + n.sessionCount(), 0);
  }

  toolInputCount(sessionId: string): number {
    return this.entries.reduce((sum, [, n]) => sum + n.toolInputCount(sessionId), 0);
  }
}
