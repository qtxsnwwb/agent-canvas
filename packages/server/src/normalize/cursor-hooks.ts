/*
 * Cursor hook payloads (spec 7; fields as Cursor documents them, to be checked against real payloads at acceptance).
 * All events: conversation_id, generation_id, model, hook_event_name, cursor_version, workspace_roots, user_email,
 * transcript_path. sessionStart / sessionEnd also carry session_id; beforeSubmitPrompt the prompt and attachments;
 * stop the status and loop_count; subagentStop (with the PARENT's conversation_id) the subagent's type, status, task,
 * summary and transcript path.
 *
 * Hooks never create, change or settle nodes and never create sessions: what a hook carries for the normalizer is only
 * which conversation it is about and which session-level mark it leaves (interpreted in cursor.ts).
 */

import { CURSOR_TEXT_CAP_BYTES } from '../sources/cursor/records.js';
import { capUtf8 } from '../sources/cursor/trim.js';

/** The five events `hooks install --cursor` installs; the only ones a Cursor hook raw event is expected to have. */
export const CURSOR_HOOK_EVENT_NAMES: ReadonlySet<string> = new Set(['sessionStart', 'sessionEnd', 'beforeSubmitPrompt', 'stop', 'subagentStop']);

export interface CursorHook {
  eventName: string;
  /** `conversation_id` (Cursor's composer id), else `session_id`. */
  conversationId: string;
  /** `workspace_roots[0]`, when it is a non-empty string. */
  workspaceRoot: string | null;
}

/**
 * Not ok: `unknownRecordType` labels what is counted as unknown (a payload that is not a JSON object, an event name not
 * installed); null for a well-formed payload that names no conversation (nothing to attribute it to, not an error).
 */
export type ParsedCursorHook = { ok: true; hook: CursorHook } | { ok: false; unknownRecordType: string | null };

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function parseObject(payload: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The session id a Cursor hook names: conversation_id, else session_id; null when neither is a non-empty string. */
export function cursorHookConversationId(body: Record<string, unknown>): string | null {
  return str(body.conversation_id) ?? str(body.session_id);
}

/** The first workspace root of a Cursor hook payload, or null. */
export function cursorHookWorkspaceRoot(body: Record<string, unknown>): string | null {
  return Array.isArray(body.workspace_roots) ? str(body.workspace_roots[0]) : null;
}

/** Parses a raw Cursor hook payload; unknown event names and broken payloads are reported, never thrown. */
export function parseCursorHook(eventName: string, payload: string): ParsedCursorHook {
  const body = parseObject(payload);
  if (body === null) return { ok: false, unknownRecordType: 'hook:invalid' };
  if (!CURSOR_HOOK_EVENT_NAMES.has(eventName)) return { ok: false, unknownRecordType: `hook:${eventName}` };
  const conversationId = cursorHookConversationId(body);
  if (conversationId === null) return { ok: false, unknownRecordType: null };
  return { ok: true, hook: { eventName, conversationId, workspaceRoot: cursorHookWorkspaceRoot(body) } };
}

/**
 * The payload as stored: Cursor puts the signed-in user's e-mail address in every hook (`user_email`); it is personal
 * data claude-canvas has no use for, so it is dropped. beforeSubmitPrompt carries the prompt and its attachments, which
 * the normalizer never reads: like the records' texts (CURSOR_TEXT_CAP_BYTES) the prompt is cut to 64 KB at a code
 * point, and attachments longer than that as JSON are dropped; either is then listed in `truncated`. A payload with
 * none of this to change (including one that is not a JSON object) is stored exactly as received, as for the other
 * origins; otherwise it is stored re-serialised.
 */
export function sanitizeCursorHookPayload(payload: string): string {
  const body = parseObject(payload);
  if (body === null) return payload;
  const out: Record<string, unknown> = { ...body };
  let changed = false;
  if (Object.prototype.hasOwnProperty.call(out, 'user_email')) {
    delete out.user_email;
    changed = true;
  }
  const truncated: string[] = [];
  if (typeof out.prompt === 'string') {
    const { text, cut } = capUtf8(out.prompt, CURSOR_TEXT_CAP_BYTES);
    if (cut) {
      out.prompt = text;
      truncated.push('prompt');
    }
  }
  if (out.attachments !== undefined) {
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(out.attachments) ?? '', 'utf8');
    } catch {
      size = Number.POSITIVE_INFINITY;
    }
    if (size > CURSOR_TEXT_CAP_BYTES) {
      delete out.attachments;
      truncated.push('attachments');
    }
  }
  if (truncated.length > 0) {
    out.truncated = truncated;
    changed = true;
  }
  return changed ? JSON.stringify(out) : payload;
}
