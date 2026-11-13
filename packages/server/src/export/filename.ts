/**
 * The download name `agent-canvas-<slug>-<YYYYMMDD>.<ext>`: slug = the (masked) session title reduced to letters,
 * digits, `-` and `_` (every other run of characters becomes one `-`; no path separators, control or bidi characters,
 * dots), at most 40 characters, `session` when nothing is left. `ascii`: the same with only ASCII letters and digits kept
 * (the header's fallback `filename`). Date: the service's local date.
 */
export interface ExportFileName {
  utf8: string;
  ascii: string;
}

const SLUG_MAX = 40;

function slugOf(title: string, keep: RegExp): string {
  let slug = '';
  let dash = false;
  for (const ch of title) {
    if (keep.test(ch)) {
      if (dash && slug !== '') slug += '-';
      slug += ch;
      dash = false;
    } else dash = true;
  }
  slug = [...slug].slice(0, SLUG_MAX).join('');
  slug = slug.replace(/^[-_]+|[-_]+$/g, '');
  return slug === '' ? 'session' : slug;
}

function ymd(date: Date): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}

export function exportFileName(title: string | null, date: Date, ext: 'html' | 'md'): ExportFileName {
  const t = title ?? '';
  const day = ymd(date);
  return {
    utf8: `agent-canvas-${slugOf(t, /^[\p{L}\p{N}_-]$/u)}-${day}.${ext}`,
    ascii: `agent-canvas-${slugOf(t, /^[A-Za-z0-9_-]$/)}-${day}.${ext}`,
  };
}

/** RFC 5987 value characters (attr-char); everything else percent-encoded from UTF-8. */
function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `Content-Disposition: attachment` with the ASCII fallback and the UTF-8 name (only printable ASCII in the header). */
export function contentDisposition(name: ExportFileName): string {
  return `attachment; filename="${name.ascii}"; filename*=UTF-8''${rfc5987(name.utf8)}`;
}
