import type { SessionStatus } from '@claude-canvas/shared';
import { parseHookPayload } from './hooks.js';

/*
 * Codex hook payloads (spec 2.3, from the official documentation; to be checked against real payloads at acceptance).
 * All events: session_id, transcript_path, cwd, hook_event_name, model. Tool events: turn_id, tool_name, tool_use_id,
 * tool_input, and (PostToolUse) tool_response. Subagent events: agent_id, agent_type, with the PARENT's session_id.
 * The base payload is the same as Claude Code's (parseHookPayload); the events and their meaning differ, so Claude's
 * parser is left as it is.
 */

/** What a Codex hook means for a node, independent of any session state. */
export type CodexHookEffect =
  | { kind: 'pre_tool'; toolUseId: string; toolName: string; input: unknown; turnId: string | null }
  | { kind: 'permission_request'; toolUseId: string | null; toolName: string; input: unknown }
  | { kind: 'post_tool'; toolUseId: string; toolName: string | null; failed: boolean; output: unknown };

export interface CodexHook {
  eventName: string;
  sessionId: string;
  cwd: string | null;
  /** `agent_id`: the subagent thread the event is from; null for the root thread. */
  agentId: string | null;
  /** Session status this hook sets, or null to leave it unchanged. */
  status: SessionStatus | null;
  /** SessionStart / UserPromptSubmit may bring an `ended` session back. */
  resumes: boolean;
  /** The hook may create a session the normalizer has not seen (a live one whose file is not read yet). */
  createsSession: boolean;
  node: CodexHookEffect | null;
}

export type ParsedCodexHook = { ok: true; hook: CodexHook } | { ok: false; unknownRecordType: string };

/** Events that change nothing but are part of Codex's documented set (installed or not): not "unknown". */
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
/** The only events of a subagent thread (agent_id set) that move the session's status. */
const SUBAGENT_STATUS = new Set(['PreToolUse', 'PermissionRequest', 'PostToolUse']);

/** Tool names (as a hook names them) of the call that starts a subagent; its node follows the child thread. */
export const SPAWN_TOOL_NAMES: ReadonlySet<string> = new Set(['spawn_agent', 'collaboration.spawn_agent', 'Agent']);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const nonZero = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v !== 0;

/**
 * Whether a tool_response clearly reports a failure: an object with a non-zero `exit_code` / `exitCode`, `success:
 * false`, `is_error` / `isError: true`, or a non-empty `error`. Anything else (plain text included) is a success.
 */
export function responseFailed(response: unknown): boolean {
  if (!isObject(response)) return false;
  if (nonZero(response.exit_code) || nonZero(response.exitCode)) return true;
  if (response.success === false || response.is_error === true || response.isError === true) return true;
  const error = response.error;
  return error !== undefined && error !== null && error !== false && error !== '';
}

function status(eventName: string, agentId: string | null): SessionStatus | null {
  if (agentId !== null && !SUBAGENT_STATUS.has(eventName)) return null;
  switch (eventName) {
    case 'SessionStart':
    case 'Stop':
    case 'Interrupt':
      return 'idle';
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'running';
    case 'PermissionRequest':
      return 'awaiting_permission';
    case 'SessionEnd':
      return 'ended';
    default:
      return null;
  }
}

function effect(eventName: string, p: Record<string, unknown>): CodexHookEffect | null {
  const toolUseId = str(p.tool_use_id);
  const toolName = str(p.tool_name);
  switch (eventName) {
    case 'PreToolUse':
      return toolUseId !== null && toolName !== null
        ? { kind: 'pre_tool', toolUseId, toolName, input: p.tool_input ?? {}, turnId: str(p.turn_id) }
        : null;
    case 'PermissionRequest':
      return toolName !== null ? { kind: 'permission_request', toolUseId, toolName, input: p.tool_input ?? {} } : null;
    case 'PostToolUse':
      return toolUseId !== null
        ? { kind: 'post_tool', toolUseId, toolName, failed: responseFailed(p.tool_response), output: p.tool_response ?? null }
        : null;
    default:
      return null;
  }
}

/** Parses a raw Codex hook payload; unknown event names and broken payloads are reported, never thrown. */
export function parseCodexHook(eventName: string, payload: string): ParsedCodexHook {
  const base = parseHookPayload(payload);
  if (base === null) return { ok: false, unknownRecordType: 'hook:invalid' };
  if (!KNOWN.has(eventName)) return { ok: false, unknownRecordType: `hook:${eventName}` };
  const p = base.body;
  const agentId = str(p.agent_id);
  return {
    ok: true,
    hook: {
      eventName,
      sessionId: base.sessionId,
      cwd: str(p.cwd),
      agentId,
      status: status(eventName, agentId),
      resumes: eventName === 'SessionStart' || eventName === 'UserPromptSubmit',
      createsSession: CREATES.has(eventName),
      node: effect(eventName, p),
    },
  };
}
