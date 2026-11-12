/**
 * The two raw record types CursorSource stores (spec 5.3): `composer` (one conversation's session-level facts) and
 * `bubble` (one message or step). Each is one JSON line, written by trim.ts with a fixed key order (equal content gives
 * equal lines), stored under the conversation's key `cursor:<composerId>`. Every field is always present; a value the
 * database did not have (or had with the wrong type) is null. Strings that were empty in the database are null.
 */

export const CURSOR_RECORD_TYPES = { composer: 'composer', bubble: 'bubble' } as const;

/** Text fields (`text`, `thinking.text`, `params`, `result`) are cut to this many UTF-8 bytes (spec 5.3). */
export const CURSOR_TEXT_CAP_BYTES = 64 * 1024;

/** A subagent conversation's link to the conversation that dispatched it (`composerData.subagentInfo`). */
export interface CursorSubagentInfo {
  /** Composer that ran the `task_v2` call (may itself be a subagent). */
  parentComposerId: string | null;
  /** The root (non-subagent) conversation: the session this subagent belongs to. */
  rootParentConversationId: string | null;
  /** Equals the `toolFormerData.toolCallId` of the dispatching `task_v2` bubble in the parent. */
  toolCallId: string | null;
  /** Human-readable subagent type, e.g. an explorer type name. */
  subagentTypeName: string | null;
  /** Cursor's numeric subagent type. */
  subagentType: number | null;
}

/** recordType `composer`: one conversation (Cursor "composer"), as of the read. */
export interface CursorComposerRecord {
  composerId: string;
  /** Title (`composerData.name`). */
  name: string | null;
  /** `composerData.status`: 'none' | 'completed' | 'aborted' seen; other values passed through. */
  status: string | null;
  /** Creation time, ms since epoch (`composerData.createdAt`, else the header's). */
  createdAt: number | null;
  /** Last update, ms since epoch (`composerData.lastUpdatedAt`, else the header's `lastUpdatedAt` column). */
  lastUpdatedAt: number | null;
  /** `composerData.modelConfig.modelName`. */
  modelName: string | null;
  /** `composerData.unifiedMode` (e.g. 'agent'), else the header value's. */
  unifiedMode: string | null;
  /** Workspace id of the header row (`composerHeaders.workspaceId`). */
  workspaceId: string | null;
  /** Working directory by the three-step fallback of spec 5.4; null when none was found. */
  cwd: string | null;
  /** Present for subagent conversations only. */
  subagentInfo: CursorSubagentInfo | null;
  /** Bubble ids in conversation order (`fullConversationHeadersOnly[].bubbleId`). */
  bubbleIds: string[];
}

/** `toolFormerData` of a tool bubble. */
export interface CursorToolFormerData {
  /** Tool name, e.g. 'read_file', 'run_terminal_cmd', 'task_v2'. */
  name: string | null;
  /** 'completed' | 'error' | 'loading' | 'cancelled' seen. */
  status: string | null;
  /** Tool call id; for `task_v2` it matches the subagent's `subagentInfo.toolCallId`. */
  toolCallId: string | null;
  /** The call's parameters: JSON text as Cursor stored it (may be cut, see `truncated`). */
  params: string | null;
  /** The call's result: JSON text as Cursor stored it (may be cut, see `truncated`). */
  result: string | null;
}

/** recordType `bubble`: one message or step. A later version of the same `bubbleId` supersedes an earlier one. */
export interface CursorBubbleRecord {
  bubbleId: string;
  /** 1 user, 2 assistant. */
  type: number | null;
  /** 15 tool, 30 thinking, null for plain text. */
  capabilityType: number | null;
  /** ISO 8601 creation time. */
  createdAt: string | null;
  /** Start / completion, ms since epoch. */
  startedAtMs: number | null;
  completedAtMs: number | null;
  /** Set on the last bubble of a turn. */
  turnDurationMs: number | null;
  /** Message text (user prompt or assistant reply). */
  text: string | null;
  /** Thinking text (`thinking.text`; the signature is not stored). */
  thinking: { text: string | null } | null;
  thinkingDurationMs: number | null;
  tokenCount: { inputTokens: number | null; outputTokens: number | null } | null;
  toolFormerData: CursorToolFormerData | null;
  /**
   * Fields cut to CURSOR_TEXT_CAP_BYTES, by name in this fixed order: 'text', 'thinking.text', 'params', 'result'.
   * Empty when nothing was cut. A cut `params` / `result` is no longer valid JSON.
   */
  truncated: string[];
}
