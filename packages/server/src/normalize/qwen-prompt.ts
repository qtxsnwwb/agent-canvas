/*
 * The text of a Qwen Code user record and what kind of user record it is (spec 4.1 and 4.3, docs/formats/qwen-code.md
 * 3.4). `message.parts` is what was sent to the model (expanded `@` references, context blocks, a trailing hook-context
 * part); `systemPayload.displayText` is what the user submitted. The product's own display rule decides which is shown.
 */

const HOOK_OPEN = '<qwen:user-prompt-submit-context>';
const HOOK_CLOSE = '</qwen:user-prompt-submit-context>';

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The `message.parts` of a record (empty when there are none). */
function partsOf(rec: Obj): unknown[] {
  return isObject(rec.message) && Array.isArray(rec.message.parts) ? rec.message.parts : [];
}

/** A part that is one complete hook-context block. */
function isHookPart(p: unknown): boolean {
  if (!isObject(p) || typeof p.text !== 'string') return false;
  return p.text.startsWith(HOOK_OPEN) && p.text.trimEnd().endsWith(HOOK_CLOSE);
}

/** Text parts joined (thought parts left out) and the number of media parts (reference 2.2: inlineData, fileData). */
function collect(parts: readonly unknown[]): { text: string; images: number } {
  let text = '';
  let images = 0;
  for (const p of parts) {
    if (!isObject(p)) continue;
    if (typeof p.text === 'string') {
      if (p.thought !== true) text += p.text;
    } else if (isObject(p.inlineData) || isObject(p.fileData)) images += 1;
  }
  return { text, images };
}

/** Reference 3.4 / spec 4.3. `images` = count of media parts kept (an empty or unknown part is not one). */
export function promptText(rec: unknown): { text: string; images: number } {
  if (!isObject(rec)) return { text: '', images: 0 };
  const parts = partsOf(rec);
  const sp = rec.systemPayload;
  const lastIsHook = parts.length > 0 && isHookPart(parts[parts.length - 1]);
  // 1. The submitted text (an empty one counts), with the images of the request.
  if (isObject(sp) && typeof sp.displayText === 'string' && (typeof sp.hookContext === 'string' || lastIsHook)) {
    return { text: sp.displayText, images: collect(parts).images };
  }
  // 2. An older record without a payload: the parts without the trailing hook-context part.
  if ((sp === undefined || sp === null) && parts.length > 1 && lastIsHook) return collect(parts.slice(0, -1));
  // 3. The parts as they are.
  return collect(parts);
}

export type UserKind = 'prompt' | 'mid-turn-prompt' | 'realtime-prompt' | 'mod-prompt' | 'notice' | 'hidden' | 'unknown';

const HIDDEN = new Set(['goal_runtime', 'agent_mention', 'agent_message']);

/** Spec 4.1: what a `user` record shows as. A null subtype is no subtype. */
export function classifyUser(rec: unknown): UserKind {
  if (!isObject(rec)) return 'unknown';
  const subtype = rec.subtype;
  if (subtype === undefined || subtype === null) return rec.provenance === 'mod_prompt' ? 'mod-prompt' : 'prompt';
  if (typeof subtype !== 'string') return 'unknown';
  if (subtype === 'mid_turn_user_message') return 'mid-turn-prompt';
  if (subtype === 'realtime_message') return 'realtime-prompt';
  if (subtype === 'notification' || subtype === 'cron') return 'notice';
  if (HIDDEN.has(subtype)) return 'hidden';
  return 'unknown';
}
