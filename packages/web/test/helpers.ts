import type { GraphNode, GraphSnapshot, Session } from '@claude-canvas/shared';

export const baseSession: Session = {
  id: 's1', projectId: 'p1', origin: 'claude', cwd: null, title: null, gitBranch: null, status: 'running',
  sourceDeleted: false, startedAt: '2026-01-01T00:00:00Z', lastActivityAt: '2026-01-01T00:00:00Z',
};

export function mkNode(id: string, timestamp = '2026-01-01T00:00:00Z'): GraphNode {
  return {
    id, sessionId: 's1', turnId: null, agentId: null, parentId: null, kind: 'text', status: null, timestamp,
    confirmed: true, title: 't', summary: 's', toolName: null, toolUseId: null, messageId: null,
    durationMs: null, usage: null, systemSubtype: null, childAgentId: null, endedAt: null,
  };
}

export function snapshot(o: { seq: number; nodes?: GraphNode[] }): GraphSnapshot {
  return { session: baseSession, nodes: o.nodes ?? [], edges: [], seq: o.seq };
}

export interface FakeSocket {
  sent: unknown[];
  closed: boolean;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
  receive(msg: unknown): void;
  drop(): void;
}

export function fakeSocket(): FakeSocket {
  // onopen fires in a microtask after the handler is attached, so a socket built before the client asks for it still opens.
  let openHandler: (() => void) | null = null;
  const s: FakeSocket = {
    sent: [], closed: false, onmessage: null, onclose: null,
    get onopen() { return openHandler; },
    set onopen(fn) { openHandler = fn; if (fn) queueMicrotask(() => fn()); },
    send(data) { s.sent.push(JSON.parse(data)); },
    close() { s.closed = true; },
    receive(msg) { s.onmessage?.({ data: JSON.stringify(msg) }); },
    drop() { s.onclose?.(); },
  };
  return s;
}
