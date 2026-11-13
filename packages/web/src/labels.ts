import { effectiveStatus, type EffectiveSessionStatus, type NodeKind, type NodeStatus, type Session } from '@agent-canvas/shared';

export const KIND_LABEL: Record<NodeKind, string> = {
  prompt: '提示',
  thinking: '思考',
  text: '回复',
  tool: '工具',
  subagent: '子代理',
  system: '系统',
  unknown: '未知',
};

export const NODE_STATUS_LABEL: Record<NodeStatus, string> = {
  running: '执行中',
  awaiting_permission: '等待权限确认',
  succeeded: '成功',
  failed: '失败',
  denied: '被拒绝',
};

export const SESSION_STATUS_LABEL: Record<EffectiveSessionStatus, string> = {
  running: '运行中',
  awaiting_input: '等待输入',
  awaiting_permission: '等待权限确认',
  idle: '空闲',
  ended: '已结束',
  stale: '长时间无活动',
};

/** What the pages show for a session's status at time `nowMs`. */
export function sessionStatusView(session: Session, nowMs: number): { status: EffectiveSessionStatus; label: string } {
  const status = effectiveStatus(session, nowMs);
  return { status, label: SESSION_STATUS_LABEL[status] ?? status };
}
