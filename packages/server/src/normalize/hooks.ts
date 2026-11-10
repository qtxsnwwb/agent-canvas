import type { NodeStatus, SessionStatus } from '@claude-canvas/shared';

/** What a hook means for a node, independent of any session state. */
export type HookNodeEffect =
  | { kind: 'pre_tool'; toolUseId: string; toolName: string; input: unknown }
  | { kind: 'permission_request'; toolName: string; input: unknown }
  | {
      kind: 'settle';
      toolUseId: string;
      status: Extract<NodeStatus, 'succeeded' | 'failed' | 'denied'>;
      durationMs: number | null;
      /** Present only when the hook carries an output (`tool_response` / `error`). */
      output?: unknown;
    }
  | { kind: 'subagent_stop'; agentId: string }
  | { kind: 'compact'; summary: string };

export interface HookDescription {
  sessionId: string;
  cwd: string | null;
  /** `payload.agent_id`; null for the main thread. */
  agentId: string | null;
  /** Session status this hook sets, or null to leave it unchanged. */
  status: SessionStatus | null;
  /** True for the events that may bring an `ended` session back (SessionStart, UserPromptSubmit). */
  resumes: boolean;
  node: HookNodeEffect | null;
  /** `session_title` of a UserPromptSubmit payload; null when absent or empty. */
  title: string | null;
}

export type ParsedHook = { ok: true; hook: HookDescription } | { ok: false; unknownRecordType: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function nodeEffect(eventName: string, p: Record<string, unknown>, agentId: string | null): HookNodeEffect | null {
  const toolUseId = str(p.tool_use_id);
  const toolName = str(p.tool_name);
  switch (eventName) {
    case 'PreToolUse':
      return toolUseId !== null && toolName !== null ? { kind: 'pre_tool', toolUseId, toolName, input: p.tool_input ?? {} } : null;
    case 'PermissionRequest':
      return toolName !== null ? { kind: 'permission_request', toolName, input: p.tool_input ?? {} } : null;
    case 'PermissionDenied':
      return toolUseId !== null ? { kind: 'settle', toolUseId, status: 'denied', durationMs: null } : null;
    case 'PostToolUse':
      return toolUseId !== null
        ? { kind: 'settle', toolUseId, status: 'succeeded', durationMs: num(p.duration_ms), output: p.tool_response }
        : null;
    case 'PostToolUseFailure':
      return toolUseId !== null
        ? { kind: 'settle', toolUseId, status: 'failed', durationMs: num(p.duration_ms), output: p.error }
        : null;
    case 'SubagentStop':
      return agentId !== null ? { kind: 'subagent_stop', agentId } : null;
    case 'PostCompact':
      return { kind: 'compact', summary: str(p.compact_summary) ?? '' };
    default:
      return null;
  }
}

function sessionStatus(eventName: string, p: Record<string, unknown>): SessionStatus | null {
  switch (eventName) {
    case 'SessionStart':
    case 'Stop':
    case 'StopFailure':
      return 'idle';
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PermissionDenied':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return 'running';
    case 'PermissionRequest':
      return 'awaiting_permission';
    case 'Notification':
      if (p.notification_type === 'permission_prompt') return 'awaiting_permission';
      if (p.notification_type === 'idle_prompt') return 'awaiting_input';
      return null;
    case 'SessionEnd':
      return 'ended';
    default:
      return null;
  }
}

const KNOWN_HOOKS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PermissionDenied',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'Notification',
  'Stop',
  'StopFailure',
  'PostCompact',
  'SessionEnd',
]);

/** Parses a raw hook payload; unknown event names and broken payloads are reported, never thrown. */
export function parseHook(eventName: string, payload: string): ParsedHook {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { ok: false, unknownRecordType: 'hook:invalid' };
  }
  if (!isObject(parsed)) return { ok: false, unknownRecordType: 'hook:invalid' };
  const sessionId = str(parsed.session_id);
  if (sessionId === null || sessionId === '') return { ok: false, unknownRecordType: 'hook:invalid' };
  if (!KNOWN_HOOKS.has(eventName)) return { ok: false, unknownRecordType: `hook:${eventName}` };
  const agentId = str(parsed.agent_id);
  return {
    ok: true,
    hook: {
      sessionId,
      cwd: str(parsed.cwd),
      agentId,
      status: sessionStatus(eventName, parsed),
      resumes: eventName === 'SessionStart' || eventName === 'UserPromptSubmit',
      node: nodeEffect(eventName, parsed, agentId),
      title: eventName === 'UserPromptSubmit' && agentId === null ? (str(parsed.session_title) || null) : null,
    },
  };
}
