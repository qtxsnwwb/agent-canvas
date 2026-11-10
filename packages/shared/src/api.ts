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
/**
 * `hello` is sent once, right after the socket opens; `epoch` identifies the database (a different epoch after a
 * reconnect means seqs are not comparable: resync). `resync`: refetch the snapshot of that session instead of
 * expecting a backlog. Catch-up `changes` come in chunks of at most 1000; node detail is never on the socket.
 */
export type ServerMessage =
  | { type: 'hello'; epoch: string }
  | { type: 'changes'; changes: SeqChange[] }
  | { type: 'resync'; sessionId: string };
