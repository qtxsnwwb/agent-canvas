import { effectiveStatus, type EffectiveSessionStatus, type NodeStatus, type Session } from '@claude-canvas/shared';

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
