import type { NodeDetail } from '@agent-canvas/shared';

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

export const DETAIL_UNREADABLE_NOTE = '这一步的详情已损坏，无法读取';

/**
 * The line the drawer shows instead of sections: the detail is damaged (`unreadable`: its fields are empty), or there is
 * nothing to show; null when sections are shown.
 */
export function detailNote(detail: NodeDetail, sectionCount: number): string | null {
  if (detail.unreadable === true) return DETAIL_UNREADABLE_NOTE;
  return sectionCount === 0 ? '无内容' : null;
}

/** An exported file without a detail entry for the step (it had none stored). */
export const DETAIL_NO_STORED_NOTE = '这一步没有保存详情';

/** detailNote for a StepDetail's detail, which is null when there is no stored detail. */
export function stepDetailNote(detail: NodeDetail | null, sectionCount: number): string | null {
  return detail === null ? DETAIL_NO_STORED_NOTE : detailNote(detail, sectionCount);
}

/** Under the output of a step whose output was cut at export time: its original size, in KB rounded up. */
export function exportCutNote(originalBytes: number | null): string | null {
  return originalBytes === null ? null : `（导出时已截断，原始 ${Math.max(1, Math.ceil(originalBytes / 1024))} KB）`;
}
