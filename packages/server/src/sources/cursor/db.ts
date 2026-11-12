import Database from 'better-sqlite3';

/** A result that carries its failure instead of throwing it. */
export type DbResult<T> = { ok: true; value: T } | { ok: false; error: Error };

/** One row of `composerHeaders`, with `value` parsed (null when it is not a JSON object). */
export interface HeaderRow {
  composerId: string;
  workspaceId: string | null;
  createdAt: number | null;
  lastUpdatedAt: number | null;
  isArchived: boolean;
  isSubagent: boolean;
  /** The parsed `value` column; null when absent or not a JSON object. */
  value: Record<string, unknown> | null;
  /** True when `value` was present but did not parse as a JSON object. */
  valueInvalid: boolean;
}

/** What CursorSource reads from Cursor's state database. Never throws: every failure is returned. */
export interface CursorDbReader {
  /** Every row of `composerHeaders` (a few hundred; never the KV table). */
  headers(): DbResult<HeaderRow[]>;
  /** The text of `cursorDiskKV['composerData:<id>']`, or null when the key is absent. */
  composerData(composerId: string): DbResult<string | null>;
  /** The text of `cursorDiskKV['bubbleId:<composerId>:<bubbleId>']`, or null when the key is absent. */
  bubble(composerId: string, bubbleId: string): DbResult<string | null>;
  close(): void;
}

const HEADERS_SQL = `SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, value FROM composerHeaders`;
const KV_SQL = `SELECT value FROM cursorDiskKV WHERE key = ?`;

const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'bigint' ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** A KV value as text: Cursor stores JSON as TEXT or as a UTF-8 BLOB. */
export function kvText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return String(value);
}

/**
 * Opens Cursor's state database read-only (spec 5.1): `readonly` + `fileMustExist`, `query_only`, `busy_timeout = 1000`.
 * Only auto-commit single-row lookups by primary key and the small `composerHeaders` table are ever run: no explicit
 * transactions, no writes, no checkpoint. Statements are prepared on open, so a missing table or column fails here.
 */
export function openCursorDb(dbPath: string): DbResult<CursorDbReader> {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
  try {
    db.pragma('query_only = ON');
    db.pragma('busy_timeout = 1000');
    const headers = db.prepare(HEADERS_SQL);
    const kv = db.prepare(KV_SQL).pluck();
    const lookup = (key: string): DbResult<string | null> => {
      try {
        return { ok: true, value: kvText(kv.get(key)) };
      } catch (err) {
        return { ok: false, error: toError(err) };
      }
    };
    return {
      ok: true,
      value: {
        headers() {
          try {
            const rows = headers.all() as Record<string, unknown>[];
            const out: HeaderRow[] = [];
            for (const r of rows) {
              const composerId = str(r.composerId);
              if (composerId === null) continue;
              let value: Record<string, unknown> | null = null;
              let valueInvalid = false;
              const text = kvText(r.value);
              if (text !== null && text !== '') {
                try {
                  const parsed: unknown = JSON.parse(text);
                  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) value = parsed as Record<string, unknown>;
                  else valueInvalid = true;
                } catch {
                  valueInvalid = true;
                }
              }
              out.push({
                composerId,
                workspaceId: str(r.workspaceId),
                createdAt: num(r.createdAt),
                lastUpdatedAt: num(r.lastUpdatedAt),
                isArchived: num(r.isArchived) === 1,
                isSubagent: num(r.isSubagent) === 1,
                value,
                valueInvalid,
              });
            }
            return { ok: true, value: out };
          } catch (err) {
            return { ok: false, error: toError(err) };
          }
        },
        composerData: (composerId) => lookup(`composerData:${composerId}`),
        bubble: (composerId, bubbleId) => lookup(`bubbleId:${composerId}:${bubbleId}`),
        close() {
          try {
            db.close();
          } catch {
            // closing a read-only handle cannot lose anything
          }
        },
      },
    };
  } catch (err) {
    try {
      db.close();
    } catch {
      // ignore
    }
    return { ok: false, error: toError(err) };
  }
}
