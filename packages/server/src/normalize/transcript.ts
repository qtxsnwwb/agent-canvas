import type { SessionStatus, Usage } from '@agent-canvas/shared';

/** A parsed JSON transcript record. */
export type TranscriptRecord = Record<string, unknown> & { type: string; uuid: string };

export interface MessageMeta {
  messageId: string | null;
  usage: Usage | null;
  endTurn: boolean;
}

/** One recognized content block of an assistant record; `index` is its position in `message.content`. */
export type AssistantBlock =
  | { kind: 'thinking'; index: number; text: string; durationMs: number | null }
  | { kind: 'text'; index: number; text: string }
  | { kind: 'tool_use'; index: number; toolUseId: string; name: string; input: unknown };

/** What a record means for the graph, independent of any session state. */
export type Classified =
  | { kind: 'prompt'; text: string }
  /** Recognized blocks in content order (at least one); unknown block types are skipped. */
  | { kind: 'assistant'; blocks: AssistantBlock[]; meta: MessageMeta }
  /**
   * `asyncAgent`: the record is the immediate answer to a background Agent launch (the agent goes on running); its
   * `agentId` when the record names it.
   */
  | {
    kind: 'tool_results';
    results: { toolUseId: string; content: unknown; isError: boolean }[];
    asyncAgent: { agentId: string | null } | null;
  }
  | { kind: 'compact' }
  | { kind: 'interrupt'; text: string } // "[Request interrupted by user…]": a system node, ends the turn
  | { kind: 'silent' } // produces no node; only keeps the parent chain intact
  | { kind: 'malformed' };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function messageMeta(message: Record<string, unknown>): MessageMeta {
  const u = message.usage;
  const usage =
    isObject(u) && typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number'
      ? { inputTokens: u.input_tokens, outputTokens: u.output_tokens }
      : null;
  return {
    messageId: typeof message.id === 'string' ? message.id : null,
    usage,
    endTurn: message.stop_reason === 'end_turn',
  };
}

function classifyBlock(record: TranscriptRecord, block: unknown, index: number): AssistantBlock | null {
  if (!isObject(block)) return null;
  switch (block.type) {
    case 'thinking':
      if (typeof block.thinking !== 'string') return null;
      return {
        kind: 'thinking',
        index,
        text: block.thinking,
        durationMs: typeof record.thinkingDurationMs === 'number' ? record.thinkingDurationMs : null,
      };
    case 'text':
      return typeof block.text === 'string' ? { kind: 'text', index, text: block.text } : null;
    case 'tool_use':
      if (typeof block.id !== 'string' || typeof block.name !== 'string') return null;
      return { kind: 'tool_use', index, toolUseId: block.id, name: block.name, input: block.input ?? {} };
    default:
      return null;
  }
}

function classifyAssistant(record: TranscriptRecord): Classified {
  const message = record.message;
  if (!isObject(message) || !Array.isArray(message.content)) return { kind: 'malformed' };
  const blocks: AssistantBlock[] = [];
  (message.content as unknown[]).forEach((block, i) => {
    const b = classifyBlock(record, block, i);
    if (b !== null) blocks.push(b);
  });
  if (blocks.length === 0) return { kind: 'malformed' };
  return { kind: 'assistant', blocks, meta: messageMeta(message) };
}

/** A user record whose text starts with this is an interrupt marker, not a prompt. */
export const INTERRUPT_PREFIX = '[Request interrupted by user';

/**
 * User records whose text (after leading whitespace) starts with one of these are not user input: they produce no
 * node and do not change the session status. To be validated against real transcripts during acceptance.
 */
export const NOT_A_PROMPT_PREFIXES: readonly string[] = [
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
  '<task-notification>',
  '<system-reminder>',
  // Injected by the desktop app, seen in real transcripts (acceptance, 2026-11-10).
  '<ci-monitor-event>',
  '<side-sessions-event>',
];

/** Interrupt marker / not-a-prompt check on the record's text (string content, or the joined text blocks). */
function nonPrompt(record: TranscriptRecord, text: string): Classified | null {
  if (record.isCompactSummary === true) return { kind: 'silent' };
  const t = text.trimStart();
  if (t.startsWith(INTERRUPT_PREFIX)) return { kind: 'interrupt', text: t };
  if (NOT_A_PROMPT_PREFIXES.some((p) => t.startsWith(p))) return { kind: 'silent' };
  return null;
}

/**
 * A background Agent launch answers at once with `{ status: 'async_launched', isAsync: true, agentId, ... }` (seen in
 * real transcripts, 2026-11-11) while the agent keeps running. Null for anything else.
 */
export function asyncLaunch(result: unknown): { agentId: string | null } | null {
  if (!isObject(result)) return null;
  if (result.status !== 'async_launched' && result.isAsync !== true) return null;
  return { agentId: typeof result.agentId === 'string' ? result.agentId : null };
}

function classifyUser(record: TranscriptRecord): Classified {
  const message = record.message;
  if (!isObject(message)) return { kind: 'malformed' };
  const content = message.content;
  if (typeof content === 'string') {
    if (record.isMeta === true) return { kind: 'silent' };
    return nonPrompt(record, content) ?? { kind: 'prompt', text: content };
  }
  if (!Array.isArray(content)) return { kind: 'malformed' };
  const results: { toolUseId: string; content: unknown; isError: boolean }[] = [];
  for (const block of content as unknown[]) {
    if (isObject(block) && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      results.push({ toolUseId: block.tool_use_id, content: block.content, isError: block.is_error === true });
    }
  }
  if (results.length > 0) return { kind: 'tool_results', results, asyncAgent: asyncLaunch(record.toolUseResult) };
  if (record.isMeta === true) return { kind: 'silent' };
  const textOnly = (content as unknown[])
    .flatMap((b) => (isObject(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
    .join('\n');
  const special = nonPrompt(record, textOnly);
  if (special !== null) return special;
  // Array prompts (pasted images, multi-part text): text blocks joined, images as a literal marker.
  const parts: string[] = [];
  for (const block of content as unknown[]) {
    if (!isObject(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[image]');
  }
  return parts.length > 0 ? { kind: 'prompt', text: parts.join('\n') } : { kind: 'silent' };
}

export function classifyRecord(record: TranscriptRecord): Classified {
  switch (record.type) {
    case 'user':
      return classifyUser(record);
    case 'assistant':
      return classifyAssistant(record);
    case 'system':
      return record.subtype === 'compact_boundary' ? { kind: 'compact' } : { kind: 'silent' };
    default:
      return { kind: 'silent' }; // attachment
  }
}

/** Session status implied by a record, or null when it does not change it. */
export function impliedStatus(c: Classified, isSubagent: boolean): SessionStatus | null {
  if (isSubagent) return null; // subagent records never change the session status
  if (c.kind === 'prompt') return 'running';
  if (c.kind === 'interrupt') return 'idle';
  // Activity implies running: a turn need not begin with a recognizable prompt record.
  if (c.kind === 'assistant') return c.meta.endTurn ? 'idle' : 'running';
  return null;
}
