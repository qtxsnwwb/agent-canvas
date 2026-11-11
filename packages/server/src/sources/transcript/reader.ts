import fs from 'node:fs/promises';

export interface ReadResult {
  lines: { offset: number; text: string }[];
  newOffset: number;
  truncated: boolean;
}

const CHUNK_SIZE = 64 * 1024;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const NEWLINE = 0x0a;

/**
 * Read complete lines appended after `fromOffset`. A trailing partial line is left unread.
 * Lines are split at the byte level so multi-byte characters never straddle a decode boundary.
 */
export async function readNewLines(
  absPath: string,
  fromOffset: number,
  maxBytes: number = DEFAULT_MAX_BYTES,
): Promise<ReadResult> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(absPath, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { lines: [], newOffset: 0, truncated: false };
    throw err;
  }
  try {
    const { size } = await handle.stat();
    const truncated = size < fromOffset;
    const start = truncated ? 0 : fromOffset;
    const lines: ReadResult['lines'] = [];
    let newOffset = start;
    let pending: Buffer = Buffer.alloc(0);
    let filePos = start;
    let done = false;

    while (!done && filePos < size) {
      const chunk = Buffer.alloc(Math.min(CHUNK_SIZE, size - filePos));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, filePos);
      if (bytesRead === 0) break;
      filePos += bytesRead;
      pending = pending.length === 0 ? chunk.subarray(0, bytesRead) : Buffer.concat([pending, chunk.subarray(0, bytesRead)]);

      let from = 0;
      for (;;) {
        const nl = pending.indexOf(NEWLINE, from);
        if (nl === -1) break;
        const lineEnd = newOffset + (nl + 1 - from);
        // Stop at a line boundary once the budget would be exceeded (the first line is always read in full).
        if (lines.length > 0 && lineEnd - start > maxBytes) {
          done = true;
          break;
        }
        const text = pending.toString('utf8', from, nl).replace(/\r$/, '');
        if (text !== '') lines.push({ offset: newOffset, text });
        newOffset = lineEnd;
        from = nl + 1;
      }
      pending = pending.subarray(from);
    }
    return { lines, newOffset, truncated };
  } finally {
    await handle.close();
  }
}
