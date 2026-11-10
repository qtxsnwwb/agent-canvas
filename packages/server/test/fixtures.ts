import { applyChange, emptyGraph, type Change, type Graph } from '@claude-canvas/shared';
import type { Normalizer } from '../src/normalize/normalizer.js';
import type { RawEvent } from '../src/store/store.js';

const BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z');
let tick = 0;
let offset = 0;

function nextTimestamp(): string {
  tick += 1;
  return new Date(BASE_TIME + tick * 1000).toISOString();
}

function toEvent(type: string, record: Record<string, unknown>, agentId: string | null): RawEvent {
  const line = JSON.stringify(record);
  offset += line.length + 1;
  return { source: 'transcript', file: 'projects/p1/s1.jsonl', offset, line, recordType: type, sessionId: 's1', agentId };
}

function baseRecord(type: string, uuid: string, parentUuid: string | null): Record<string, unknown> {
  return {
    type,
    uuid,
    parentUuid,
    timestamp: nextTimestamp(),
    sessionId: 's1',
    cwd: '/work/demo',
    gitBranch: 'main',
    isSidechain: false,
  };
}

function agentIdOf(over?: object): string | null {
  const id = (over as { agentId?: unknown } | undefined)?.agentId;
  return typeof id === 'string' ? id : null;
}

export function userPrompt(uuid: string, parentUuid: string | null, text: string, over: object = {}): RawEvent {
  const record = { ...baseRecord('user', uuid, parentUuid), message: { role: 'user', content: text }, ...over };
  return toEvent('user', record, agentIdOf(over));
}

export function assistantBlock(
  uuid: string,
  parentUuid: string | null,
  block: object,
  over: { messageId?: string; stopReason?: string; agentId?: string; thinkingDurationMs?: number; timestamp?: string } = {},
): RawEvent {
  const record: Record<string, unknown> = {
    ...baseRecord('assistant', uuid, parentUuid),
    message: {
      id: over.messageId ?? `msg-${uuid}`,
      role: 'assistant',
      content: [block],
      stop_reason: over.stopReason ?? null,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
  if (over.timestamp !== undefined) record.timestamp = over.timestamp;
  if (over.thinkingDurationMs !== undefined) record.thinkingDurationMs = over.thinkingDurationMs;
  if (over.agentId !== undefined) {
    record.agentId = over.agentId;
    record.isSidechain = true;
  }
  return toEvent('assistant', record, over.agentId ?? null);
}

export function toolResult(
  uuid: string,
  parentUuid: string | null,
  toolUseId: string,
  content: unknown,
  isError?: boolean,
  over: object = {},
): RawEvent {
  const block: Record<string, unknown> = { type: 'tool_result', tool_use_id: toolUseId, content };
  if (isError !== undefined) block.is_error = isError;
  const record = { ...baseRecord('user', uuid, parentUuid), message: { role: 'user', content: [block] }, ...over };
  return toEvent('user', record, agentIdOf(over));
}

export function rawLine(type: string, body: object): RawEvent {
  const record = { type, timestamp: nextTimestamp(), sessionId: 's1', cwd: '/work/demo', gitBranch: 'main', ...body };
  return toEvent(type, record, agentIdOf(body));
}

export function agentMeta(
  agentId: string,
  meta: { toolUseId: string; agentType: string; description: string; finished?: boolean },
): RawEvent {
  return {
    source: 'meta',
    file: `projects/p1/s1/subagents/agent-${agentId}.meta.json`,
    sessionId: 's1',
    agentId,
    payload: JSON.stringify(meta),
  };
}

export function customTitle(title: string): RawEvent {
  return {
    source: 'meta',
    file: 'projects/p1/s1/custom-title.json',
    sessionId: 's1',
    agentId: null,
    payload: JSON.stringify({ customTitle: title }),
  };
}

export function hook(eventName: string, body: object = {}, receivedAt: string = nextTimestamp()): RawEvent {
  return {
    source: 'hook',
    receivedAt,
    eventName,
    sessionId: 's1',
    payload: JSON.stringify({ session_id: 's1', hook_event_name: eventName, cwd: '/w', ...body }),
  };
}

export function run(n: Normalizer, events: RawEvent[]): { changes: Change[]; graph: Graph; unknown: string[] } {
  const changes: Change[] = [];
  const unknown: string[] = [];
  let graph = emptyGraph();
  for (const ev of events) {
    const r = n.apply(ev, 'p1');
    if (r.unknownRecordType !== undefined) unknown.push(r.unknownRecordType);
    for (const c of r.changes) {
      changes.push(c);
      graph = applyChange(graph, c);
    }
  }
  return { changes, graph, unknown };
}
