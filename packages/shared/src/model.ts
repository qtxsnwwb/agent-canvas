export type NodeKind = 'prompt' | 'thinking' | 'text' | 'tool' | 'subagent' | 'system' | 'unknown';
export type NodeStatus = 'running' | 'awaiting_permission' | 'succeeded' | 'failed' | 'denied';
export type SessionStatus = 'running' | 'awaiting_input' | 'awaiting_permission' | 'idle' | 'ended';
export type EdgeKind = 'sequence' | 'fork' | 'spawn';
/** Which agent a session (and every raw event, file and hook behind it) comes from. */
export type Origin = 'claude' | 'codex' | 'cursor';
/** Every origin, in the order lists of origins are given in (Project.origins, diagnostics). */
export const ORIGINS: readonly Origin[] = ['claude', 'codex', 'cursor'];
export const TERMINAL_STATUSES: readonly NodeStatus[] = ['succeeded', 'failed', 'denied'];
export const SUMMARY_MAX = 200;

/**
 * Token usage of one model response, the same categories for every origin:
 * - inputTokens: input the model processed that was NOT read from cache ("新输入"; cache writes included).
 *   Claude Code: input_tokens + cache_creation_input_tokens. Codex: input_tokens − cached_input_tokens (≥ 0).
 * - cachedInputTokens: input read from cache ("缓存读取"). Claude Code: cache_read_input_tokens. Codex:
 *   cached_input_tokens. Absent on nodes derived before it existed (and on Cursor's, which has no such count): 0.
 * - outputTokens: output (Codex's output_tokens already include its reasoning tokens).
 */
export interface Usage { inputTokens: number; outputTokens: number; cachedInputTokens?: number }

export interface GraphNode {
  id: string;
  sessionId: string;
  turnId: string | null;
  agentId: string | null;        // 节点所属的线程，主线为 null（派发节点也是）
  childAgentId: string | null;   // 仅 subagent 节点：它派出的代理的 id，元数据到达前为 null；其余恒为 null
  parentId: string | null;
  kind: NodeKind;
  status: NodeStatus | null;     // 仅 tool、subagent 有值
  timestamp: string;             // ISO 8601
  confirmed: boolean;            // false = 只有 hook，JSONL 记录未到
  title: string;                 // tool: 工具名；subagent: 代理类型；其余为固定标签
  summary: string;               // 不超过 SUMMARY_MAX 字符
  toolName: string | null;
  toolUseId: string | null;
  messageId: string | null;      // assistant 记录的 message.id
  durationMs: number | null;
  endedAt: string | null;       // ISO 8601；仅 tool、subagent：第一次进入终态的事件的时间，之后的状态纠正不改；其余为 null
  usage: Usage | null;
  systemSubtype: string | null;
  /**
   * Files this tool call read or changed, from tools that name a file in a structured way (never guessed from command
   * lines). Absent when the node touches no file. At most MAX_FILES_PER_NODE entries; one entry per (path, action).
   */
  files?: FileTouch[];
  /** True when the call named more files than MAX_FILES_PER_NODE and the rest were dropped. */
  filesTruncated?: boolean;
}

/** What a tool call did to a file. `write` is "created or overwrote" (the tool does not say which). */
export type FileAction = 'read' | 'edit' | 'write' | 'delete';
export const FILE_ACTIONS: readonly FileAction[] = ['read', 'edit', 'write', 'delete'];

/**
 * One file a tool call touched. `path` is absolute and normalized: `/` separators, upper-case Windows drive letter,
 * no `.` / `..` segments; a relative path the session's working directory could not resolve is kept as given.
 */
export interface FileTouch {
  path: string;
  action: FileAction;
}

export const MAX_FILES_PER_NODE = 50;

export interface GraphEdge { id: string; sessionId: string; from: string; to: string; kind: EdgeKind }

export interface Session {
  id: string;
  projectId: string;             // ~/.claude/projects 下的目录名（Codex 会话：其 cwd 按同样规则编码）
  origin: Origin;
  cwd: string | null;
  title: string | null;
  gitBranch: string | null;
  status: SessionStatus;
  sourceDeleted: boolean;
  startedAt: string;
  lastActivityAt: string;
}

/**
 * activeSessionCount counts sessions in running, awaiting_input or awaiting_permission. origins: the origins of the
 * project's sessions, each once, in ORIGINS order.
 */
export interface Project { id: string; cwd: string | null; sessionCount: number; activeSessionCount: number; origins: Origin[] }

export interface NodeDetail { nodeId: string; input: unknown; output: unknown; text: string | null; raw: unknown }
