import type { SessionStatus, Usage } from '@claude-canvas/shared';

/** A parsed JSON transcript record. */
export type TranscriptRecord = Record<string, unknown> & { type: string; uuid: string };

export interface MessageMeta {
  messageId: string | null;
  usage: Usage | null;
  endTurn: boolean;
}

/** What a record means for the graph, independent of any session state. */
export type Classified =
  | { kind: 'prompt'; text: string }
  | { kind: 'thinking'; text: string; durationMs: number | null; meta: MessageMeta }
  | { kind: 'text'; text: string; meta: MessageMeta }
  | { kind: 'tool_use'; toolUseId: string; name: string; input: unknown; meta: MessageMeta }
  | { kind: 'tool_results'; results: { toolUseId: string; content: unknown; isError: boolean }[] }
  | { kind: 'compact' }
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

function classifyAssistant(record: TranscriptRecord): Classified {
  const message = record.message;
  if (!isObject(message) || !Array.isArray(message.content)) return { kind: 'malformed' };
  const block: unknown = message.content[0];
  if (!isObject(block)) return { kind: 'malformed' };
  const meta = messageMeta(message);
  switch (block.type) {
    case 'thinking':
      if (typeof block.thinking !== 'string') return { kind: 'malformed' };
      return {
        kind: 'thinking',
        text: block.thinking,
        durationMs: typeof record.thinkingDurationMs === 'number' ? record.thinkingDurationMs : null,
        meta,
      };
    case 'text':
      return typeof block.text === 'string' ? { kind: 'text', text: block.text, meta } : { kind: 'malformed' };
    case 'tool_use':
      if (typeof block.id !== 'string' || typeof block.name !== 'string') return { kind: 'malformed' };
      return { kind: 'tool_use', toolUseId: block.id, name: block.name, input: block.input ?? {}, meta };
    default:
      return { kind: 'malformed' };
  }
}

function classifyUser(record: TranscriptRecord): Classified {
  const message = record.message;
  if (!isObject(message)) return { kind: 'malformed' };
  const content = message.content;
  if (typeof content === 'string') return record.isMeta === true ? { kind: 'silent' } : { kind: 'prompt', text: content };
  if (!Array.isArray(content)) return { kind: 'malformed' };
  const results: { toolUseId: string; content: unknown; isError: boolean }[] = [];
  for (const block of content as unknown[]) {
    if (isObject(block) && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      results.push({ toolUseId: block.tool_use_id, content: block.content, isError: block.is_error === true });
    }
  }
  if (results.length > 0) return { kind: 'tool_results', results };
  if (record.isMeta === true) return { kind: 'silent' };
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
  if (c.kind === 'prompt') return 'running';
  if (!isSubagent && (c.kind === 'thinking' || c.kind === 'text' || c.kind === 'tool_use') && c.meta.endTurn) return 'idle';
  return null;
}
