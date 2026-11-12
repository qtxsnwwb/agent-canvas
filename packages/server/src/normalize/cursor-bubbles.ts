import type { NodeDetail, Usage } from '@claude-canvas/shared';
import { promptTitle } from './codex.js';
import { summarize } from './summary.js';

/*
 * Parsing of the Cursor records (contract: sources/cursor/records.ts) into what the CursorNormalizer derives the graph
 * from: the composer facts of a conversation and a compact view of the latest record of each bubble, plus tool summaries.
 */

export const TASK_TOOL = 'task_v2';

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

export type BubbleKind = 'prompt' | 'text' | 'thinking' | 'tool' | 'subagent';

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
  /** task_v2: the subagent type named in its params. */
  agentType: string | null;
  /** task_v2: the subagent conversation named in its result (`agentId`). */
  resultAgentId: string | null;
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
  if (type === 1) kind = 'prompt';
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
    agentType: null,
    resultAgentId: null,
  };
  let detail: Partial<NodeDetail> = {};
  switch (kind) {
    case 'prompt':
      view.title = 'Prompt';
      view.summary = summarize(text ?? '');
      view.promptTitle = text === null ? null : promptTitle(text);
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
      view.rejected = isObject(output) && output.rejected === true;
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
