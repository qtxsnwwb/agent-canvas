import type { SeqChange } from './change.js';
import type { GraphEdge, GraphNode, Session } from './model.js';

export interface GraphSnapshot { session: Session; nodes: GraphNode[]; edges: GraphEdge[]; seq: number }
export interface Diagnostics {
  unknownRecords: { recordType: string; count: number; sample: string }[];
  lastHookAt: string | null;
  files: { path: string; offset: number; size: number }[];
}
export type ClientMessage =
  | { type: 'subscribe'; scope: 'sessions' }
  | { type: 'subscribe'; scope: 'session'; sessionId: string; sinceSeq: number };
export type ServerMessage = { type: 'changes'; changes: SeqChange[] };
