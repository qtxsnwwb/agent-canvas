export type NodeKind = 'prompt' | 'thinking' | 'text' | 'tool' | 'subagent' | 'system' | 'unknown';
export type NodeStatus = 'running' | 'awaiting_permission' | 'succeeded' | 'failed' | 'denied';
export type SessionStatus = 'running' | 'awaiting_input' | 'awaiting_permission' | 'idle' | 'ended';
export type EdgeKind = 'sequence' | 'fork' | 'spawn';
/** Which agent a session (and every raw event, file and hook behind it) comes from. */
export type Origin = 'claude' | 'codex';
/** Every origin, in the order lists of origins are given in (Project.origins, diagnostics). */
export const ORIGINS: readonly Origin[] = ['claude', 'codex'];
export const TERMINAL_STATUSES: readonly NodeStatus[] = ['succeeded', 'failed', 'denied'];
export const SUMMARY_MAX = 200;

export interface Usage { inputTokens: number; outputTokens: number }

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
}

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
