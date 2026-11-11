import type { NodeDetail } from '@claude-canvas/shared';

export const DETAIL_MAX_CHARS = 200_000;

export interface DetailSection { label: '文本' | '入参' | '输出' | '原始记录'; body: string; truncated: boolean }

function bodyOf(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2) ?? null;
  } catch {
    return String(v);
  }
}

/** The first `max` UTF-16 code units, one fewer when the cut would split a surrogate pair. */
function cut(s: string, max: number): string {
  const last = s.charCodeAt(max - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** Only the sections that have content, in the order text, input, output, raw. Strings are shown as is, anything else as indented JSON. */
export function detailSections(detail: NodeDetail): DetailSection[] {
  const parts: [DetailSection['label'], unknown][] = [
    ['文本', detail.text], ['入参', detail.input], ['输出', detail.output], ['原始记录', detail.raw],
  ];
  const out: DetailSection[] = [];
  for (const [label, value] of parts) {
    const body = bodyOf(value);
    if (body === null || body === '') continue;
    const truncated = body.length > DETAIL_MAX_CHARS;
    out.push({ label, body: truncated ? cut(body, DETAIL_MAX_CHARS) : body, truncated });
  }
  return out;
}
