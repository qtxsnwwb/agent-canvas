/** The start of every placeholder the masker writes (`‹已遮蔽·…›`). */
const PLACEHOLDER_START = '‹已遮蔽·';
/** Longer than any placeholder the masker writes. */
const PLACEHOLDER_MAX_CHARS = 64;

/**
 * Cuts already-masked text to at most `maxBytes` UTF-8 bytes on a character boundary (a surrogate pair is never split;
 * a lone surrogate counts as the 3 bytes of its replacement character). A cut that would fall inside a masking
 * placeholder is moved before it, so no part of a placeholder (or of what it stands for) is left half. null when the
 * text fits. originalBytes: the whole text's size.
 */
export function truncateUtf8(text: string, maxBytes: number): { text: string; originalBytes: number } | null {
  const originalBytes = Buffer.byteLength(text, 'utf8');
  if (originalBytes <= maxBytes) return null;
  let bytes = 0;
  let cut = 0;
  while (cut < text.length) {
    const c = text.charCodeAt(cut);
    let size: number;
    let units = 1;
    if (c < 0x80) size = 1;
    else if (c < 0x800) size = 2;
    else if (c >= 0xd800 && c <= 0xdbff && cut + 1 < text.length) {
      const d = text.charCodeAt(cut + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        size = 4;
        units = 2;
      } else size = 3;
    } else size = 3;
    if (bytes + size > maxBytes) break;
    bytes += size;
    cut += units;
  }
  const open = text.lastIndexOf('‹', cut - 1);
  if (open >= 0 && cut - open < PLACEHOLDER_MAX_CHARS && text.startsWith(PLACEHOLDER_START, open) && !text.slice(open, cut).includes('›')) {
    cut = open;
  }
  return { text: text.slice(0, cut), originalBytes };
}
