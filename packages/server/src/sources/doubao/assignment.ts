/**
 * Doubao Work's `assignment.md` (docs/formats/doubao-work.md A1 "Sibling files"): an append-only per-agent task file.
 * After an administrative header (ignored), each `## [<time>] 需求` section is one demand given to the agent: the
 * user's prompt for the main agent, the task for a subagent. A section made only of `<system-reminder>` blocks is a
 * notification, not a demand.
 */

/** A section header: `## [<time>] 需求` on a line of its own (the third-party reader's regex, verbatim). */
const HEADER = /^## \[([^\]\r\n]+)\] 需求\r?\n/gm;
/** A demand body longer than this (UTF-8 bytes) is dropped, as the third-party reader does. */
export const DOUBAO_DEMAND_MAX_BYTES = 64 * 1024;

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

/** The demand sections of an assignment.md, reminder-only sections dropped; `at` is null when the header time does not parse. */
export function parseAssignment(text: string): { at: number | null; text: string }[] {
  const heads: { at: number | null; start: number; end: number }[] = [];
  HEADER.lastIndex = 0;
  for (let m = HEADER.exec(text); m !== null; m = HEADER.exec(text)) {
    const ms = Date.parse(m[1]!);
    heads.push({ at: Number.isSafeInteger(ms) ? ms : null, start: m.index, end: m.index + m[0].length });
  }
  const out: { at: number | null; text: string }[] = [];
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i]!;
    const body = text.slice(h.end, i + 1 < heads.length ? heads[i + 1]!.start : text.length).trim();
    if (body === '' || Buffer.byteLength(body) > DOUBAO_DEMAND_MAX_BYTES) continue;
    const demand = stripReminders(body).trim();
    if (demand === '') continue; // only reminders: a notification
    out.push({ at: h.at, text: demand });
  }
  return out;
}
