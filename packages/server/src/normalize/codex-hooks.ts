import { parseHookPayload } from './hooks.js';

/*
 * Codex hook payloads (spec 2.3, from the official documentation; to be checked against real payloads at acceptance).
 * All events: session_id, transcript_path, cwd, hook_event_name, model. Turn-scoped events: turn_id. Tool events:
 * tool_name, tool_use_id, tool_input, and (PostToolUse) tool_response. Subagent events: agent_id, agent_type, with the
 * PARENT's session_id. The base payload is the same as Claude Code's (parseHookPayload); the events and their meaning
 * differ, so Claude's parser is left as it is.
 *
 * Hooks v1 never create, confirm or settle nodes (the transcript alone makes the graph): what a hook carries for the
 * normalizer is only which session / turn it is about. The marks it leaves are interpreted in codex.ts.
 */

export interface CodexHook {
  eventName: string;
  sessionId: string;
  cwd: string | null;
  /** `agent_id`: the subagent the event is from; null for the root thread. */
  agentId: string | null;
  /** `turn_id`, when the payload has one. */
  turnId: string | null;
  /** The hook may create a session the normalizer has not seen (a live one whose file is not read yet). */
  createsSession: boolean;
}

export type ParsedCodexHook = { ok: true; hook: CodexHook } | { ok: false; unknownRecordType: string };

/** Events that leave no mark but are part of Codex's documented set (installed or not): not "unknown". */
const NO_EFFECT = new Set(['SubagentStart', 'SubagentStop', 'PostCompact', 'PreCompact', 'PreModelRequest', 'PostModelRequest']);
const KNOWN = new Set([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop',
  'Interrupt',
  ...NO_EFFECT,
]);
/** Events that show a live session (and so may create one): its start, a prompt, a tool. */
const CREATES = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse']);

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Parses a raw Codex hook payload; unknown event names and broken payloads are reported, never thrown. */
export function parseCodexHook(eventName: string, payload: string): ParsedCodexHook {
  const base = parseHookPayload(payload);
  if (base === null) return { ok: false, unknownRecordType: 'hook:invalid' };
  if (!KNOWN.has(eventName)) return { ok: false, unknownRecordType: `hook:${eventName}` };
  const p = base.body;
  return {
    ok: true,
    hook: {
      eventName,
      sessionId: base.sessionId,
      cwd: str(p.cwd),
      agentId: str(p.agent_id),
      turnId: str(p.turn_id),
      createsSession: CREATES.has(eventName),
    },
  };
}
