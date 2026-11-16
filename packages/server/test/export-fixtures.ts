import type { Change, GraphEdge, GraphNode, NodeDetail, Session } from '@agent-canvas/shared';

/** Synthetic sessions for the export tests. Secret-looking values are fake and assembled at run time. */

export const T0 = Date.parse('2026-11-01T10:00:00.000Z');
export const iso = (ms: number): string => new Date(ms).toISOString();

/** A fake OpenAI-style key (credential rule). */
export const FAKE_KEY = 'sk-' + 'proj-' + 'Q7w8'.repeat(12);

export function makeSession(id: string, o: Partial<Session> = {}): Session {
  return {
    id,
    projectId: 'D--w-shop',
    origin: 'claude',
    cwd: 'D:\\w\\shop',
    title: 'Shop work',
    gitBranch: 'main',
    status: 'idle',
    sourceDeleted: false,
    startedAt: iso(T0),
    lastActivityAt: iso(T0 + 3600_000),
    ...o,
  };
}

export function makeNode(sessionId: string, id: string, sec: number, o: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    sessionId,
    turnId: null,
    agentId: null,
    childAgentId: null,
    parentId: null,
    kind: 'tool',
    status: 'succeeded',
    timestamp: iso(T0 + sec * 1000),
    confirmed: true,
    title: 'Bash',
    summary: '',
    toolName: 'Bash',
    toolUseId: null,
    messageId: null,
    durationMs: 1200,
    endedAt: null,
    usage: null,
    systemSubtype: null,
    ...o,
  };
}

const edge = (sessionId: string, from: string, to: string, kind: GraphEdge['kind'] = 'sequence'): Change => ({
  type: 'edge_added',
  edge: { id: `${from}->${to}`, sessionId, from, to, kind },
});

/**
 * Three turns:
 * - T1: prompt p1, reply x1, thinking th1, tool b1;
 * - T2: prompt p2, dispatch d2 (agent A1: tool a1-1, nested dispatch a1-2 (agent A2: tool a2-1)), thinking th2;
 * - T3: prompt p3, tool b3.
 * Every node has a detail; raw holds a marker that must never be exported.
 */
export function threeTurns(sessionId = 's1', sessionOverrides: Partial<Session> = {}): Change[] {
  const s = sessionId;
  const nodes: [GraphNode, Partial<NodeDetail>][] = [
    [makeNode(s, 'p1', 0, { kind: 'prompt', status: null, toolName: null, title: 'Prompt', summary: 'first prompt', turnId: 'T1' }), { text: 'first prompt, full text' }],
    [makeNode(s, 'x1', 1, { kind: 'text', status: null, toolName: null, title: 'Text', summary: 'reply one', turnId: 'T1' }), { text: 'reply one' }],
    [makeNode(s, 'th1', 2, { kind: 'thinking', status: null, toolName: null, title: 'Thinking', summary: 'hmm', turnId: 'T1' }), { text: 'thinking one' }],
    [makeNode(s, 'b1', 3, { turnId: 'T1', summary: 'ls' }), { input: { command: 'ls' }, output: 'out one', raw: { marker: 'RAW-MARKER' } }],
    [makeNode(s, 'p2', 100, { kind: 'prompt', status: null, toolName: null, title: 'Prompt', summary: 'second prompt', turnId: 'T2' }), { text: 'second prompt' }],
    [
      makeNode(s, 'd2', 101, { kind: 'subagent', toolName: 'Task', title: 'general-purpose', childAgentId: 'A1', turnId: 'T2' }),
      { input: { prompt: 'do the thing' }, output: 'agent done' },
    ],
    [makeNode(s, 'a1-1', 102, { agentId: 'A1', turnId: 'T2', toolName: 'Read', title: 'Read' }), { input: { file_path: 'D:/w/shop/a.ts' }, output: 'file text' }],
    [
      makeNode(s, 'a1-2', 103, { agentId: 'A1', kind: 'subagent', toolName: 'Task', title: 'nested', childAgentId: 'A2', turnId: 'T2' }),
      { input: { prompt: 'nested work' }, output: 'nested done' },
    ],
    [makeNode(s, 'a2-1', 104, { agentId: 'A2', turnId: 'T2', toolName: 'Grep', title: 'Grep' }), { input: { pattern: 'x' }, output: 'grep out' }],
    [makeNode(s, 'th2', 105, { kind: 'thinking', status: null, toolName: null, title: 'Thinking', summary: 'think two', turnId: 'T2' }), { text: 'thinking two' }],
    [makeNode(s, 'p3', 200, { kind: 'prompt', status: null, toolName: null, title: 'Prompt', summary: 'third prompt', turnId: 'T3' }), { text: 'third prompt' }],
    [makeNode(s, 'b3', 201, { turnId: 'T3' }), { input: { command: 'pwd' }, output: 'out three' }],
  ];
  return [
    { type: 'session_upserted', session: makeSession(s, sessionOverrides) },
    ...nodes.map(([node, detail]): Change => ({ type: 'node_added', node, detail })),
    edge(s, 'p1', 'x1'),
    edge(s, 'x1', 'th1'),
    edge(s, 'th1', 'b1'),
    edge(s, 'b1', 'p2'),
    edge(s, 'p2', 'd2'),
    edge(s, 'd2', 'a1-1', 'spawn'),
    edge(s, 'a1-1', 'a1-2'),
    edge(s, 'a1-2', 'a2-1', 'spawn'),
    edge(s, 'd2', 'th2'),
    edge(s, 'th2', 'p3'),
    edge(s, 'p3', 'b3'),
  ];
}
