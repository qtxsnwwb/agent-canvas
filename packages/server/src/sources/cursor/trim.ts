import { CURSOR_TEXT_CAP_BYTES, type CursorBubbleRecord, type CursorComposerRecord, type CursorSubagentInfo } from './records.js';

/**
 * Pure trimming of Cursor's records into the stored lines of spec 5.3. Objects are built with a fixed key order and
 * every field present (null when absent), so equal content always gives an equal line; nothing volatile (no read
 * time) is included. Large or editor-state fields (`toolCallBinary`, `rawArgs`, `additionalData`, the empty arrays)
 * are never copied.
 */

type Obj = Record<string, unknown>;

export const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Obj => (isObject(v) ? v : {});

/** JSON with object keys sorted at every level, so equal content gives equal text. */
export function stableJson(v: unknown): string {
  return JSON.stringify(v, (_key, value: unknown) =>
    isObject(value) ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]])) : value,
  );
}

/** At most `maxBytes` of UTF-8, cut at a code point boundary. */
export function capUtf8(s: string, maxBytes: number = CURSOR_TEXT_CAP_BYTES): { text: string; cut: boolean } {
  if (s.length * 3 <= maxBytes || Buffer.byteLength(s, 'utf8') <= maxBytes) return { text: s, cut: false };
  const buf = Buffer.from(s, 'utf8');
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1; // back off a continuation byte
  return { text: buf.subarray(0, end).toString('utf8'), cut: true };
}

/**
 * Bubbles in conversation order from `composerData.fullConversationHeadersOnly`, each with its index in that list
 * (`order`). Entries without a bubble id are skipped (their index is not reused); a repeated id keeps its first index.
 */
export function bubbleEntriesOf(composerData: unknown): { bubbleId: string; order: number }[] {
  const list = obj(composerData).fullConversationHeadersOnly;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: { bubbleId: string; order: number }[] = [];
  list.forEach((h, order) => {
    const bubbleId = str(obj(h).bubbleId);
    if (bubbleId === null || seen.has(bubbleId)) return;
    seen.add(bubbleId);
    out.push({ bubbleId, order });
  });
  return out;
}

/** `subagentInfo` of a composerData, trimmed; null when it has none. */
export function subagentInfoOf(composerData: unknown): CursorSubagentInfo | null {
  const info = obj(composerData).subagentInfo;
  if (!isObject(info)) return null;
  return {
    parentComposerId: str(info.parentComposerId),
    rootParentConversationId: str(info.rootParentConversationId),
    toolCallId: str(info.toolCallId),
    subagentTypeName: str(info.subagentTypeName),
    subagentType: num(info.subagentType),
  };
}

/** What a composer record takes from outside composerData. */
export interface ComposerExtras {
  /** The conversation's id (authoritative: the key it was read under). */
  composerId: string;
  /** From the `composerHeaders` row. */
  headerCreatedAt: number | null;
  /** `unifiedMode` of the header's value. */
  headerUnifiedMode: string | null;
  /** Working directory (spec 5.4), resolved by the source. */
  cwd: string | null;
}

/** The `composer` line of a conversation (CursorComposerRecord). */
export function trimComposer(raw: unknown, extras: ComposerExtras): string {
  const data = obj(raw);
  const record: CursorComposerRecord = {
    composerId: extras.composerId,
    name: str(data.name),
    status: str(data.status),
    createdAt: num(data.createdAt) ?? extras.headerCreatedAt,
    modelName: str(obj(data.modelConfig).modelName),
    unifiedMode: str(data.unifiedMode) ?? extras.headerUnifiedMode,
    cwd: extras.cwd,
    subagentInfo: subagentInfoOf(data),
  };
  return JSON.stringify(record);
}

/**
 * The `bubble` line of one bubble (CursorBubbleRecord) at index `order` of its conversation's list; `bubbleId` (the id
 * it was read under) wins over the JSON's.
 */
export function trimBubble(raw: unknown, bubbleId: string, order: number): string {
  return JSON.stringify(bubbleRecord(raw, bubbleId, order));
}

/** The CursorBubbleRecord of one bubble (what trimBubble serialises). */
export function bubbleRecord(raw: unknown, bubbleId: string, order: number): CursorBubbleRecord {
  const b = obj(raw);
  const truncated: string[] = [];
  const capped = (name: string, v: unknown, jsonValue = false): string | null => {
    // params / result are JSON text in practice; an object (never seen) is kept as stable JSON rather than dropped.
    const s = jsonValue && typeof v === 'object' && v !== null ? stableJson(v) : str(v);
    if (s === null) return null;
    const { text, cut } = capUtf8(s);
    if (cut) truncated.push(name);
    return text;
  };
  const text = capped('text', b.text);
  const thinking = isObject(b.thinking) ? { text: capped('thinking.text', b.thinking.text) } : null;
  const tool = isObject(b.toolFormerData) ? b.toolFormerData : null;
  const toolFormerData =
    tool === null
      ? null
      : {
          name: str(tool.name),
          status: str(tool.status),
          toolCallId: str(tool.toolCallId),
          params: capped('params', tool.params, true),
          result: capped('result', tool.result, true),
        };
  const tokens = isObject(b.tokenCount) ? b.tokenCount : null;
  return {
    bubbleId,
    order,
    type: num(b.type),
    capabilityType: num(b.capabilityType),
    createdAt: str(b.createdAt),
    startedAtMs: num(b.startedAtMs),
    completedAtMs: num(b.completedAtMs),
    turnDurationMs: num(b.turnDurationMs),
    text,
    thinking,
    thinkingDurationMs: num(b.thinkingDurationMs),
    tokenCount: tokens === null ? null : { inputTokens: num(tokens.inputTokens), outputTokens: num(tokens.outputTokens) },
    toolFormerData,
    truncated,
  };
}

/** A bubble is finished once it has `completedAtMs` and is not a tool still `loading` (spec 5.2 step 3). */
export function bubbleFinished(record: CursorBubbleRecord): boolean {
  return record.completedAtMs !== null && record.toolFormerData?.status !== 'loading';
}
