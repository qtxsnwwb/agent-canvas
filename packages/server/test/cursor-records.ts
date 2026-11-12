/**
 * Synthetic Cursor raw records for normalizer tests: shaped exactly like the lines CursorSource stores (the record
 * contract in src/sources/cursor/records.ts: every field present, key order fixed), invented content. A CursorConv is
 * one conversation (Cursor "composer"): each method returns the raw event the poll source would store for one record.
 */
import type { CursorBubbleRecord, CursorComposerRecord, CursorToolFormerData } from '../src/sources/cursor/records.js';
import type { RawEvent } from '../src/store/store.js';

export const T0 = Date.parse('2026-11-12T08:00:00.000Z');
/** Epoch ms `sec` seconds after T0. */
export const at = (sec: number): number => T0 + sec * 1000;
export const iso = (ms: number): string => new Date(ms).toISOString();

export interface ConvSpec {
  /** The conversation's composer id. */
  id: string;
  /** Root conversation id (defaults to `id`: a main conversation). */
  sessionId?: string;
  projectId?: string;
}

type BubbleInit = Partial<Omit<CursorBubbleRecord, 'toolFormerData'>> & { toolFormerData?: Partial<CursorToolFormerData> | null };

export class CursorConv {
  readonly id: string;
  readonly sessionId: string;
  readonly agentId: string | null;
  readonly projectId: string;
  private nextOrder = 0;
  private offset = 0;
  /** Latest record of each bubble emitted so far. */
  private readonly last = new Map<string, CursorBubbleRecord>();

  constructor(spec: ConvSpec) {
    this.id = spec.id;
    this.sessionId = spec.sessionId ?? spec.id;
    this.agentId = this.sessionId === spec.id ? null : spec.id;
    this.projectId = spec.projectId ?? 'p1';
  }

  /** The node id the normalizer gives a bubble of this conversation. */
  node(bubbleId: string): string {
    return `bubble:${this.id}:${bubbleId}`;
  }

  event(recordType: string, line: string): RawEvent {
    const offset = this.offset++;
    return {
      source: 'transcript',
      origin: 'cursor',
      file: `cursor:${this.id}`,
      offset,
      line,
      recordType,
      sessionId: this.sessionId,
      agentId: this.agentId,
      projectId: this.projectId,
    };
  }

  composer(over: Partial<CursorComposerRecord> = {}): RawEvent {
    const rec: CursorComposerRecord = {
      composerId: this.id,
      name: over.name === undefined ? `Conversation ${this.id}` : over.name,
      status: over.status === undefined ? 'completed' : over.status,
      createdAt: over.createdAt === undefined ? T0 : over.createdAt,
      modelName: 'synthetic-model',
      unifiedMode: 'agent',
      cwd: over.cwd === undefined ? '/work/app' : over.cwd,
      subagentInfo: over.subagentInfo ?? null,
    };
    return this.event('composer', JSON.stringify(rec));
  }

  /** A subagent conversation's composer record, linked to the dispatching task_v2 call. */
  subagentComposer(toolCallId: string, parent: string = this.sessionId, over: Partial<CursorComposerRecord> = {}): RawEvent {
    return this.composer({
      name: null,
      subagentInfo: { parentComposerId: parent, rootParentConversationId: this.sessionId, toolCallId, subagentTypeName: 'explorer', subagentType: 3 },
      ...over,
    });
  }

  /** Any bubble record; `order` defaults to the next index of this conversation. */
  bubble(init: BubbleInit & { bubbleId: string }): RawEvent {
    const tfd = init.toolFormerData;
    const rec: CursorBubbleRecord = {
      bubbleId: init.bubbleId,
      order: init.order ?? this.nextOrder++,
      type: init.type === undefined ? 2 : init.type,
      capabilityType: init.capabilityType ?? null,
      createdAt: init.createdAt === undefined ? null : init.createdAt,
      startedAtMs: init.startedAtMs ?? null,
      completedAtMs: init.completedAtMs ?? null,
      turnDurationMs: init.turnDurationMs ?? null,
      text: init.text ?? null,
      thinking: init.thinking ?? null,
      thinkingDurationMs: init.thinkingDurationMs ?? null,
      tokenCount: init.tokenCount === undefined ? { inputTokens: 0, outputTokens: 0 } : init.tokenCount,
      toolFormerData:
        tfd === undefined || tfd === null
          ? null
          : { name: tfd.name ?? null, status: tfd.status ?? null, toolCallId: tfd.toolCallId ?? null, params: tfd.params ?? null, result: tfd.result ?? null },
      truncated: init.truncated ?? [],
    };
    this.last.set(rec.bubbleId, rec);
    return this.event('bubble', JSON.stringify(rec));
  }

  /** A later version of a bubble already emitted: its last record with `patch` applied (toolFormerData merged). */
  update(bubbleId: string, patch: BubbleInit): RawEvent {
    const prev = this.last.get(bubbleId);
    if (prev === undefined) throw new Error(`no bubble ${bubbleId}`);
    const tfd = patch.toolFormerData === undefined ? prev.toolFormerData : patch.toolFormerData === null ? null : { ...prev.toolFormerData!, ...patch.toolFormerData };
    return this.bubble({ ...prev, ...patch, toolFormerData: tfd, bubbleId });
  }

  user(bubbleId: string, text: string, sec: number, over: BubbleInit = {}): RawEvent {
    const ms = at(sec);
    return this.bubble({ bubbleId, type: 1, text, createdAt: iso(ms), startedAtMs: ms, completedAtMs: ms, ...over });
  }

  text(bubbleId: string, text: string, sec: number, over: BubbleInit = {}): RawEvent {
    const ms = at(sec);
    return this.bubble({ bubbleId, type: 2, text, createdAt: iso(ms), startedAtMs: ms, completedAtMs: ms + 500, tokenCount: { inputTokens: 100, outputTokens: 20 }, ...over });
  }

  thinking(bubbleId: string, text: string | null, sec: number, over: BubbleInit = {}): RawEvent {
    const ms = at(sec);
    return this.bubble({
      bubbleId,
      type: 2,
      capabilityType: 30,
      thinking: { text },
      thinkingDurationMs: 1200,
      createdAt: iso(ms),
      startedAtMs: ms,
      ...over,
    });
  }

  /** A tool bubble; a finished one completes `durSec` after it started (default 1 s), a loading one has no end. */
  tool(
    bubbleId: string,
    name: string,
    status: 'completed' | 'error' | 'loading' | 'cancelled' | null,
    sec: number,
    opts: { params?: unknown; result?: unknown; toolCallId?: string; durSec?: number; over?: BubbleInit } = {},
  ): RawEvent {
    const ms = at(sec);
    const done = status !== 'loading' && status !== null;
    return this.bubble({
      bubbleId,
      type: 2,
      capabilityType: 15,
      createdAt: iso(ms),
      startedAtMs: ms,
      completedAtMs: done ? ms + (opts.durSec ?? 1) * 1000 : null,
      tokenCount: { inputTokens: 50, outputTokens: 5 },
      toolFormerData: {
        name,
        status,
        toolCallId: opts.toolCallId ?? `call-${bubbleId}`,
        params: typeof opts.params === 'string' ? opts.params : JSON.stringify(opts.params ?? { targetFile: `src/${bubbleId}.ts` }),
        result: done ? JSON.stringify(opts.result ?? { contents: 'ok' }) : null,
      },
      ...opts.over,
    });
  }

  /** A task_v2 dispatch bubble. */
  task(
    bubbleId: string,
    toolCallId: string,
    status: 'completed' | 'error' | 'loading' | 'cancelled',
    sec: number,
    opts: { durSec?: number; over?: BubbleInit; result?: unknown } = {},
  ): RawEvent {
    return this.tool(bubbleId, 'task_v2', status, sec, {
      toolCallId,
      params: { description: `look into ${bubbleId}`, prompt: 'find the thing and report back', subagentType: 'explore' },
      result: { summary: 'found it' },
      ...opts,
    });
  }

  /** An empty assistant bubble ending the turn (`turnDurationMs` set). */
  turnEnd(bubbleId: string, sec: number, over: BubbleInit = {}): RawEvent {
    const ms = at(sec);
    return this.bubble({ bubbleId, type: 2, text: 'Done.', createdAt: iso(ms), startedAtMs: ms, completedAtMs: ms + 100, turnDurationMs: 30_000, ...over });
  }
}
