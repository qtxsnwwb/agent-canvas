export type NodeKind = 'prompt' | 'thinking' | 'text' | 'tool' | 'subagent' | 'system' | 'unknown';
export type NodeStatus = 'running' | 'awaiting_permission' | 'succeeded' | 'failed' | 'denied';
export type SessionStatus = 'running' | 'awaiting_input' | 'awaiting_permission' | 'idle' | 'ended';
export type EdgeKind = 'sequence' | 'fork' | 'spawn';
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
  usage: Usage | null;
  systemSubtype: string | null;
}

export interface GraphEdge { id: string; sessionId: string; from: string; to: string; kind: EdgeKind }

export interface Session {
  id: string;
  projectId: string;             // ~/.claude/projects 下的目录名
  cwd: string | null;
  title: string | null;
  gitBranch: string | null;
  status: SessionStatus;
  sourceDeleted: boolean;
  startedAt: string;
  lastActivityAt: string;
}

/** activeSessionCount counts sessions in running, awaiting_input or awaiting_permission. */
export interface Project { id: string; cwd: string | null; sessionCount: number; activeSessionCount: number }

export interface NodeDetail { nodeId: string; input: unknown; output: unknown; text: string | null; raw: unknown }
