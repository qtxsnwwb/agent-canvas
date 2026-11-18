/**
 * Doubao Work's `assignment.md` (docs/formats/doubao-work.md A1 "Sibling files"): an append-only per-agent task file.
 * After an administrative header (ignored), each `## [<time>] 需求` section is one demand given to the agent: the
 * user's prompt for the main agent, the task for a subagent. A section made only of `<system-reminder>` blocks is a
 * notification, not a demand.
 */

/** A section header: `## [<time>] 需求` on a line of its own (the third-party reader's regex, verbatim). */
const HEADER = /^## \[([^\]\r\n]+)\] 需求\r?\n/gm;
/**
 * Most UTF-8 bytes of a demand's text kept. A longer demand keeps its place and time (so the nth demand still gives the
 * nth prompt its time) with its text cut here and DOUBAO_DEMAND_CUT_MARK appended. (The third-party reader drops such a
 * section, which moves every later demand up by one.)
 */
export const DOUBAO_DEMAND_MAX_BYTES = 64 * 1024;
/** Appended to a demand's text cut at DOUBAO_DEMAND_MAX_BYTES. */
export const DOUBAO_DEMAND_CUT_MARK = '…';

const OPEN = '<system-reminder>';
const CLOSE = '</system-reminder>';

/**
 * The text after its leading complete `<system-reminder>…</system-reminder>` blocks (and the whitespace around them);
 * the text itself when it does not start with a complete block. An unclosed block is text.
 */
export function stripReminders(text: string): string {
  let pos = 0;
  let stripped = false;
  for (;;) {
    let i = pos;
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (!text.startsWith(OPEN, i)) break;
    const end = text.indexOf(CLOSE, i + OPEN.length);
    if (end === -1) break;
    pos = end + CLOSE.length;
    stripped = true;
  }
  if (!stripped) return text;
  return text.slice(pos).replace(/^\s+/, '');
}

/** The first DOUBAO_DEMAND_MAX_BYTES bytes of `s` (UTF-8), cut on a character boundary. */
function cutToMax(s: string): string {
  const buf = Buffer.from(s, 'utf8');
  let end = DOUBAO_DEMAND_MAX_BYTES;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--; // not inside a multi-byte character
  return buf.subarray(0, end).toString('utf8');
}

/**
 * The demand sections of an assignment.md, reminder-only sections dropped; `at` is null when the header time does not
 * parse. A demand whose text is over DOUBAO_DEMAND_MAX_BYTES keeps its place and time; its text is cut there, with
 * DOUBAO_DEMAND_CUT_MARK appended, and `truncated` is set.
 */
export function parseAssignment(text: string): { at: number | null; text: string; truncated?: true }[] {
  const heads: { at: number | null; start: number; end: number }[] = [];
  HEADER.lastIndex = 0;
  for (let m = HEADER.exec(text); m !== null; m = HEADER.exec(text)) {
    const ms = Date.parse(m[1]!);
    heads.push({ at: Number.isSafeInteger(ms) ? ms : null, start: m.index, end: m.index + m[0].length });
  }
  const out: { at: number | null; text: string; truncated?: true }[] = [];
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i]!;
    const body = text.slice(h.end, i + 1 < heads.length ? heads[i + 1]!.start : text.length).trim();
    if (body === '') continue;
    const demand = stripReminders(body).trim();
    if (demand === '') continue; // only reminders: a notification
    if (Buffer.byteLength(demand) > DOUBAO_DEMAND_MAX_BYTES) out.push({ at: h.at, text: `${cutToMax(demand)}${DOUBAO_DEMAND_CUT_MARK}`, truncated: true });
    else out.push({ at: h.at, text: demand });
  }
  return out;
}
