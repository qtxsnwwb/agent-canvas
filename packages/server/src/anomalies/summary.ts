import {
  detectAnomalies,
  turnCosts,
  type Anomaly,
  type GraphNode,
  type Session,
  type SessionStatus,
  type TurnCost,
} from '@agent-canvas/shared';

/**
 * One session's cached anomaly summary (spec section 4): its `loop` / `failures` / `churn` anomalies and its main-thread
 * turn costs. `cost` anomalies are not here: they need every session's turn costs (the baseline), so the service judges
 * them at query time. `failed`: computing it threw (nothing else is set); the session counts as failed until it changes.
 */
export interface AnomalySummary {
  anomalies: Anomaly[];
  costs: TurnCost[];
  failed: boolean;
}

/** The statuses in which a session counts as running (for turnCosts' "finished" and for notifications). */
export const RUNNING_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['running', 'awaiting_permission']);

export const isRunningStatus = (status: SessionStatus): boolean => RUNNING_STATUSES.has(status);

/** A pure function of the session record (its status) and its nodes. Throws when detection does. */
export function summarizeAnomalies(session: Session, nodes: readonly GraphNode[]): AnomalySummary {
  return {
    anomalies: detectAnomalies(nodes),
    costs: turnCosts(nodes, isRunningStatus(session.status)),
    failed: false,
  };
}

/** The summary of a session whose computation failed. */
export const FAILED_SUMMARY: AnomalySummary = Object.freeze({ anomalies: [], costs: [], failed: true }) as AnomalySummary;
