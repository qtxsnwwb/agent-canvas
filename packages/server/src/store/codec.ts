import zlib from 'node:zlib';

/**
 * Storage codec of the large text columns (`raw_event.data`, `node_detail.data`). Each row carries an encoding marker
 * (`enc`): 0 = the column holds the text itself (TEXT; every row written before compression existed), 1 = the column
 * holds the zlib stream (RFC 1950: 2-byte header, deflate, Adler-32 of the content; 6 bytes more than raw deflate) of
 * the text's UTF-8 bytes (BLOB). The checksum makes damaged bytes a decode failure instead of wrong text. Old and new
 * rows coexist; every reader goes through decodeBody, nothing may assume the column is text. A row whose enc this
 * build does not know (a newer format) throws UnknownEncodingError: it must be left as it is, never overwritten.
 */
export type BodyEncoding = 0 | 1;
export const ENC_PLAIN = 0;
export const ENC_DEFLATE = 1;

/** Texts shorter than this many UTF-8 bytes are stored as they are (compression would gain little, cost a call). */
export const PLAIN_BELOW_BYTES = 200;
/**
 * Texts larger than this many UTF-8 bytes are stored as they are, so a compressed row never holds more: inflating is
 * bounded by it (a damaged or hostile row cannot inflate to hundreds of MB). 16 MiB: four times the largest JSON
 * transcript line seen in practice and far above typical bodies (a few KB); hook payloads up to the server's 64 MB
 * request limit above it are kept plain.
 */
export const MAX_COMPRESSED_TEXT_BYTES = 16 * 1024 * 1024;
/**
 * zlib level. Measured on JSON-like transcript text (rows of 1-6 KB, best of 4 runs, one core): levels 1-3 give the
 * same size within 0.6 percentage points of level 9, and run on zlib's fast path; level 1 is the cheapest of them.
 */
export const DEFLATE_LEVEL = 1;

/** A stored body that cannot be decoded (damaged bytes, failed checksum, wrong marker). Callers catch it by type. */
export class CorruptBodyError extends Error {
  constructor(message: string) {
    super(`corrupt stored body: ${message}`);
    this.name = 'CorruptBodyError';
  }
}

/** A row whose encoding marker this build does not know (written by a newer format): leave it untouched. */
export class UnknownEncodingError extends CorruptBodyError {
  readonly enc: unknown;
  constructor(enc: unknown) {
    super(`unknown encoding ${String(enc)}`);
    this.enc = enc;
    this.name = 'UnknownEncodingError';
  }
}

/**
 * What to store for `text`: the text itself (enc 0) when it is shorter than PLAIN_BELOW_BYTES or longer than
 * MAX_COMPRESSED_TEXT_BYTES of UTF-8, or when compression would not make it smaller; else its zlib stream (enc 1).
 */
export function encodeBody(text: string): { data: Buffer | string; enc: BodyEncoding } {
  // Cheap bounds first: every UTF-16 unit is 1-3 UTF-8 bytes (a surrogate pair is 4 bytes for 2 units).
  if (text.length * 3 < PLAIN_BELOW_BYTES) return { data: text, enc: ENC_PLAIN };
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length < PLAIN_BELOW_BYTES || bytes.length > MAX_COMPRESSED_TEXT_BYTES) return { data: text, enc: ENC_PLAIN };
  const packed = zlib.deflateSync(bytes, { level: DEFLATE_LEVEL });
  if (packed.length >= bytes.length) return { data: text, enc: ENC_PLAIN };
  return { data: packed, enc: ENC_DEFLATE };
}

/** The text of a stored body. Throws CorruptBodyError (and nothing else) when it cannot be decoded. */
export function decodeBody(data: unknown, enc: number): string {
  if (enc === ENC_PLAIN) {
    if (typeof data === 'string') return data;
    if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
    throw new CorruptBodyError(`plain body is ${data === null ? 'null' : typeof data}`);
  }
  if (enc === ENC_DEFLATE) {
    if (!(data instanceof Uint8Array)) throw new CorruptBodyError(`compressed body is ${data === null ? 'null' : typeof data}`);
    try {
      return zlib.inflateSync(data, { maxOutputLength: MAX_COMPRESSED_TEXT_BYTES }).toString('utf8');
    } catch (err) {
      throw new CorruptBodyError(err instanceof Error ? err.message : String(err));
    }
  }
  throw new UnknownEncodingError(enc);
}
