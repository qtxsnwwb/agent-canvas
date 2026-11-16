import type { Origin } from '@agent-canvas/shared';

/** Longest type name kept in an unknown-record report (after cleaning). */
export const UNKNOWN_TYPE_MAX_CHARS = 60;

/**
 * The `unknownRecordType` of a record (or part of one) whose type `raw` a normalizer does not know (spec 4.3):
 * `<origin>:<type>`, the type name stripped of every character outside `[A-Za-z0-9._\-/$]` and cut to
 * UNKNOWN_TYPE_MAX_CHARS. A type that is not a string, or nothing of which is left, is `<origin>:?`. Never carries a
 * content value: callers pass the record's type field only.
 */
export function unknownTypeName(origin: Origin, raw: unknown): string {
  const cleaned = typeof raw === 'string' ? raw.replace(/[^A-Za-z0-9._\-/$]/g, '').slice(0, UNKNOWN_TYPE_MAX_CHARS) : '';
  return `${origin}:${cleaned === '' ? '?' : cleaned}`;
}
