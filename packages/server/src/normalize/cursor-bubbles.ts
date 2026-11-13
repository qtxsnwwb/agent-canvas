import type { NodeDetail, Usage } from '@agent-canvas/shared';
import { promptTitle } from './codex.js';
import { cursorTouches, type RawTouch } from './files.js';
import { inputKeyOf } from './input-key.js';
import { summarize } from './summary.js';

/*
 * Parsing of the Cursor records (contract: sources/cursor/records.ts) into what the CursorNormalizer derives the graph
 * from: the composer facts of a conversation and a compact view of the latest record of each bubble, plus tool summaries.
 */

export const TASK_TOOL = 'task_v2';
/** Cursor's terminal tool: its result carries the command's `exitCode`. */
export const TERMINAL_TOOL = 'run_terminal_command_v2';

export type Obj = Record<string, unknown>;
export const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export function isoOf(ms: number | null): string | null {
  if (ms === null) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function msOfIso(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}
export const maxOf = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));
export const minOf = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.min(a, b));

/** A conversation's composer facts the graph needs. */
export interface ComposerFacts {
  name: string | null;
  status: string | null;
  createdAt: number | null;
  cwd: string | null;
  /** Subagents: the task_v2 call that dispatched it. */
  toolCallId: string | null;
  subagentTypeName: string | null;
}

export function composerFacts(rec: Obj): ComposerFacts {
  const info = isObject(rec.subagentInfo) ? rec.subagentInfo : null;
  return {
    name: str(rec.name),
    status: str(rec.status),
    createdAt: num(rec.createdAt),
    cwd: str(rec.cwd),
    toolCallId: info === null ? null : str(info.toolCallId),
    subagentTypeName: info === null ? null : str(info.subagentTypeName),
  };
}

/** `notification`: a type-1 bubble that is a notice Cursor injected (a system node), not a user prompt. */
export type BubbleKind = 'prompt' | 'notification' | 'text' | 'thinking' | 'tool' | 'subagent';

/** A notice: the text starts with `<system_notification>`, optionally after a leading `<timestamp>…</timestamp>`. */
const NOTIFICATION_START = /^(?:<timestamp>[\s\S]*?<\/timestamp>\s*)?<system_notification>/;
const LEADING_TIMESTAMP = /^<timestamp>[\s\S]*?<\/timestamp>\s*/;
const USER_QUERY = /^<user_query>([\s\S]*)<\/user_query>$/;

export function isNotification(text: string): boolean {
  return NOTIFICATION_START.test(text.trim());
}

/** The text inside the first `<tag>…</tag>`, whitespace collapsed; null when absent or empty. */
function tagText(text: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  const inner = m === null ? '' : m[1]!.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return inner === '' ? null : inner;
}

/** A notice's summary: its high-level summary, else its task, else the notification's text without tags. */
export function notificationSummary(text: string): string {
  const body = text.trim().replace(LEADING_TIMESTAMP, '');
  const inner = tagText(body, 'system_notification') ?? body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return summarize(tagText(body, 'user_visible_high_level_summary') ?? tagText(body, 'task') ?? inner);
}

/** A prompt as shown (summary, title): a leading `<timestamp>` dropped; exactly `<user_query>…</user_query>` unwrapped. */
export function promptText(text: string): string {
  const trimmed = text.trim();
  const query = USER_QUERY.exec(trimmed);
  if (query !== null) return query[1]!.trim();
  return LEADING_TIMESTAMP.test(trimmed) ? trimmed.replace(LEADING_TIMESTAMP, '') : text;
}

/** What the graph needs of the latest record of one bubble (the large texts go to the normalizer's pending details). */
export interface BubbleView {
  bubbleId: string;
  nodeId: string;
  /** Index in the conversation's list; Infinity when the record had none. */
  order: number;
  createdMs: number | null;
  /** startedAtMs, else createdAt. */
  startMs: number | null;
  endMs: number | null;
  /** Latest of its times (session activity). */
  latestMs: number | null;
  hasTurnDuration: boolean;
  /** null: a shape that makes no node. */
  kind: BubbleKind | null;
  /** Shape label of an unrecognised record (null when recognised). */
  unknown: string | null;
  title: string;
  summary: string;
  promptTitle: string | null;
  thinkingMs: number | null;
  usage: Usage | null;
  toolName: string | null;
  toolStatus: string | null;
  toolCallId: string | null;
  /** The call's result says the user rejected it (`rejected: true`). */
  rejected: boolean;
  /** The terminal tool's `exitCode` from a result that was not cut; null otherwise. */
  exitCode: number | null;
  /** task_v2: the subagent type named in its params. */
  agentType: string | null;
  /** task_v2: the subagent conversation named in its result (`agentId`). */
  resultAgentId: string | null;
  /** The files the call names, as its params wrote them (resolved against the composer's cwd when derived). */
  fileTouches: RawTouch[];
  /** Tool / task bubbles: the call's input fingerprint (inputKeyOf of the tool name and the params as derived). */
  inputKey?: string;
}

/** `params` keys naming a call's main argument for tools without their own entry (camelCase and snake_case). */
const MAIN_ARG_KEYS = [
  'command',
  'targetFile',
  'target_file',
  'relativeWorkspacePath',
  'relative_workspace_path',
  'filePath',
  'file_path',
  'path',
  'globPattern',
  'glob_pattern',
  'targetDirectory',
  'target_directory',
  'query',
  'pattern',
  'searchTerm',
  'search_term',
  'url',
  'description',
  'prompt',
  'explanation',
];
/** The main argument of Cursor's tools, by tool name (parameter names as Cursor stores them). */
const TOOL_ARG_KEYS: Record<string, string[]> = {
  read_file_v2: ['targetFile'],
  run_terminal_command_v2: ['command', 'commandDescription'],
  ripgrep_raw_search: ['pattern', 'path', 'glob'],
  edit_file_v2: ['relativeWorkspacePath'],
  glob_file_search: ['globPattern', 'targetDirectory'],
  web_search: ['searchTerm'],
  [TASK_TOOL]: ['description', 'prompt', 'name'],
};
const AGENT_TYPE_KEYS = ['subagentTypeName', 'subagentType', 'subagent_type'];

/** Pass-through of JSON text: parsed when it parses, else the text itself. */
function parseJsonText(text: string | null, cut: boolean): unknown {
  if (text === null) return null;
  if (cut) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** The main argument of a call as a one-line summary: a known key, else the first string value, else the whole input. */
function mainArg(input: unknown, keys: readonly string[]): string {
  if (isObject(input)) {
    for (const k of keys) {
      const v = str(input[k]);
      if (v !== null && v.trim() !== '') return summarize(v.trim());
    }
    for (const v of Object.values(input)) {
      if (typeof v === 'string' && v.trim() !== '') return summarize(v.trim());
    }
    return Object.keys(input).length === 0 ? '' : summarize(input);
  }
  return input === null || input === undefined ? '' : summarize(input);
}

/** An MCP tool's name `mcp-<server>-<tool>`: the tool part. */
export function mcpToolPart(name: string): string | null {
  if (!name.startsWith('mcp-')) return null;
  const rest = name.slice(4);
  const dash = rest.indexOf('-');
  return dash < 0 || dash === rest.length - 1 ? rest : rest.slice(dash + 1);
}

/** The call's arguments of an MCP tool: params carry them under `tools` (a list, an object, or JSON text). */
function mcpArguments(input: unknown): unknown {
  if (!isObject(input) || input.tools === undefined) return input;
  let inner: unknown = input.tools;
  if (typeof inner === 'string') inner = parseJsonText(inner, false);
  if (Array.isArray(inner)) inner = inner[0];
  if (isObject(inner)) {
    for (const k of ['parameters', 'arguments', 'args', 'input']) {
      if (inner[k] !== undefined) return typeof inner[k] === 'string' ? parseJsonText(inner[k] as string, false) : inner[k];
    }
  }
  return inner;
}

/** One-line summary of a tool call from its parsed params. */
export function toolSummary(name: string, input: unknown): string {
  if (name === 'get_mcp_tools' && isObject(input)) {
    const parts = [str(input.server), str(input.toolName)].filter((p): p is string => p !== null);
    if (parts.length > 0) return summarize(parts.join('.'));
  }
  if (name === 'todo_write' && isObject(input) && Array.isArray(input.todos)) {
    const todos = input.todos;
    const texts = todos.flatMap((t) => {
      const text = isObject(t) ? str(t.content) : str(t);
      return text === null ? [] : [text];
    });
    return summarize(texts.length > 0 ? texts.join('; ') : `${todos.length} todos`);
  }
  if (mcpToolPart(name) !== null) return mainArg(mcpArguments(input), MAIN_ARG_KEYS);
  return mainArg(input, TOOL_ARG_KEYS[name] ?? MAIN_ARG_KEYS);
}

function usageOf(v: unknown): Usage | null {
  if (!isObject(v)) return null;
  const inputTokens = num(v.inputTokens) ?? 0;
  const outputTokens = num(v.outputTokens) ?? 0;
  return inputTokens === 0 && outputTokens === 0 ? null : { inputTokens, outputTokens };
}

function firstString(input: unknown, keys: readonly string[]): string | null {
  if (!isObject(input)) return null;
  for (const k of keys) {
    const v = str(input[k]);
    if (v !== null) return v;
  }
  return null;
}

/** The view of a bubble record and its detail; `view.unknown` labels a shape that makes no node. */
export function bubbleView(rec: Obj, bubbleId: string, nodeId: string): { view: BubbleView; detail: Partial<NodeDetail> } {
  const type = num(rec.type);
  const cap = num(rec.capabilityType);
  const text = str(rec.text);
  const thinking = isObject(rec.thinking) ? rec.thinking : null;
  const tfd = isObject(rec.toolFormerData) ? rec.toolFormerData : null;
  const truncated = Array.isArray(rec.truncated) ? rec.truncated.filter((x): x is string => typeof x === 'string') : [];
  const createdMs = msOfIso(rec.createdAt);
  const startedAtMs = num(rec.startedAtMs);
  const endMs = num(rec.completedAtMs);
  let kind: BubbleKind | null = null;
  if (type === 1) kind = text !== null && isNotification(text) ? 'notification' : 'prompt';
  else if (type === 2) {
    if (tfd !== null) kind = str(tfd.name) === TASK_TOOL ? 'subagent' : 'tool';
    else if (thinking !== null || cap === 30) kind = 'thinking';
    else if (text !== null) kind = 'text';
  }
  const view: BubbleView = {
    bubbleId,
    nodeId,
    order: num(rec.order) ?? Number.POSITIVE_INFINITY,
    createdMs,
    startMs: startedAtMs ?? createdMs,
    endMs,
    latestMs: maxOf(maxOf(createdMs, startedAtMs), endMs),
    hasTurnDuration: num(rec.turnDurationMs) !== null,
    kind,
    unknown: null,
    title: '',
    summary: '',
    promptTitle: null,
    thinkingMs: null,
    usage: usageOf(rec.tokenCount),
    toolName: null,
    toolStatus: null,
    toolCallId: null,
    rejected: false,
    exitCode: null,
    agentType: null,
    resultAgentId: null,
    fileTouches: [],
  };
  let detail: Partial<NodeDetail> = {};
  switch (kind) {
    case 'prompt': {
      const shown = text === null ? null : promptText(text);
      view.title = 'Prompt';
      view.summary = summarize(shown ?? '');
      view.promptTitle = shown === null ? null : promptTitle(shown);
      detail = { input: null, output: null, text: text ?? '', raw: null };
      break;
    }
    case 'notification':
      view.title = 'Task notification';
      view.summary = notificationSummary(text ?? '');
      detail = { input: null, output: null, text: text ?? '', raw: null };
      break;
    case 'text':
      view.title = 'Text';
      view.summary = summarize(text ?? '');
      detail = { input: null, output: null, text: text ?? '', raw: null };
      break;
    case 'thinking': {
      const t = thinking === null ? null : str(thinking.text);
      view.title = 'Thinking';
      view.summary = summarize(t ?? '');
      view.thinkingMs = num(rec.thinkingDurationMs);
      detail = { input: null, output: null, text: t ?? '', raw: null };
      break;
    }
    case 'tool':
    case 'subagent': {
      const t = tfd!;
      const name = str(t.name) ?? 'unknown';
      const input = parseJsonText(str(t.params), truncated.includes('params'));
      const output = parseJsonText(str(t.result), truncated.includes('result'));
      view.toolName = name;
      view.title = mcpToolPart(name) ?? name;
      view.toolStatus = str(t.status);
      view.toolCallId = str(t.toolCallId);
      view.summary = toolSummary(name, input);
      view.fileTouches = cursorTouches(name, input);
      const key = inputKeyOf(name, input);
      if (key !== undefined) view.inputKey = key;
      view.rejected = isObject(output) && output.rejected === true;
      if (name === TERMINAL_TOOL && isObject(output)) view.exitCode = num(output.exitCode);
      if (kind === 'subagent') {
        view.agentType = firstString(input, AGENT_TYPE_KEYS);
        view.resultAgentId = isObject(output) ? str(output.agentId) : null;
      }
      detail = { input, output, raw: { status: view.toolStatus, toolCallId: view.toolCallId, truncated } };
      break;
    }
    case null:
      view.unknown = type === 2 ? `bubble:type2/cap${cap ?? 'null'}/empty` : `bubble:type${type ?? 'null'}/cap${cap ?? 'null'}`;
  }
  return { view, detail };
}

export function compareBubbles(a: BubbleView, b: BubbleView): number {
  if (a.order !== b.order) return a.order < b.order ? -1 : 1;
  const ac = a.createdMs ?? Number.POSITIVE_INFINITY;
  const bc = b.createdMs ?? Number.POSITIVE_INFINITY;
  if (ac !== bc) return ac < bc ? -1 : 1;
  return a.bubbleId < b.bubbleId ? -1 : a.bubbleId > b.bubbleId ? 1 : 0;
}

/** First index of `list` (sorted by compareBubbles) whose bubble does not sort before `v`. */
export function lowerBound(list: BubbleView[], v: BubbleView): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareBubbles(list[mid]!, v) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
