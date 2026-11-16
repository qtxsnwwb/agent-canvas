/**
 * Grok Build reads the hooks in Claude Code's `.claude/settings.json` and Cursor's `.cursor/hooks.json`, and Copilot
 * CLI the ones in `.claude/settings(.local).json`, so they may call the hooks we installed for Claude Code and Cursor
 * with their own payloads (spec section 7). Whether `body` (the parsed JSON of a `/hooks` call as `origin`) is such a
 * foreign payload, to be answered as usual but dropped:
 * - origin claude or cursor: the object has a top-level `hookEventName` (Grok's spelling; Claude Code and Cursor send
 *   `hook_event_name`), or a top-level `sessionId` and neither `session_id` nor `conversation_id` (Grok, Copilot).
 * - origin codex: never.
 * Anything else (not an object, an array, no such keys) is not foreign: it takes the existing path, invalid payloads
 * included.
 */
export function isForeignHookPayload(origin: 'claude' | 'codex' | 'cursor', body: unknown): boolean {
  if (origin === 'codex') return false;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(body, key);
  if (has('hookEventName')) return true;
  return has('sessionId') && !has('session_id') && !has('conversation_id');
}
