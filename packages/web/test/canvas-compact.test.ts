import { expect, test } from 'vitest';
import type { Graph, GraphEdge, GraphNode, NodeKind } from '@claude-canvas/shared';
import { compactGraph, createCompactor, isRunId, runIdOf, RUN_MIN } from '../src/canvas/compact';
import { buildView } from '../src/canvas/view';

const EPOCH = Date.parse('2026-01-01T00:00:00Z');

function node(id: string, kind: NodeKind, t: number, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id, sessionId: 's1', turnId: 't1', agentId: null, childAgentId: null, endedAt: null, parentId: null, kind, status: null,
    timestamp: new Date(EPOCH + t).toISOString(), confirmed: true, title: kind, summary: '', toolName: null,
    toolUseId: null, messageId: null, durationMs: null, usage: null, systemSubtype: null, ...extra,
  };
}
const read = (id: string, t: number, extra: Partial<GraphNode> = {}) =>
  node(id, 'tool', t, { status: 'succeeded', toolName: 'Read', title: 'Read', summary: `${id}.ts`, durationMs: 10, ...extra });
const e = (from: string, to: string, kind: GraphEdge['kind'] = 'sequence'): GraphEdge => ({ id: `${from}->${to}`, sessionId: 's1', from, to, kind });
function graph(nodes: GraphNode[], edges: GraphEdge[]): Graph {
  return { nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), edges: Object.fromEntries(edges.map((x) => [x.id, x])) };
}
function chain(nodes: GraphNode[]): Graph {
  return graph(nodes, nodes.slice(1).map((n, i) => e(nodes[i]!.id, n.id)));
}
const pairs = (g: Graph) => Object.values(g.edges).map((x) => `${x.from}->${x.to}`).sort();

test('an empty thinking node with a successor is removed; its duration is carried to the next node', () => {
  const g = chain([
    node('p', 'prompt', 0), node('th', 'thinking', 1, { durationMs: 3000 }), node('x', 'text', 2, { summary: 'hi' }),
  ]);
  const r = compactGraph(g);
  expect(Object.keys(r.graph.nodes).sort()).toEqual(['p', 'x']);
  expect(pairs(r.graph)).toEqual(['p->x']);
  expect(r.thinkingMs.get('x')).toBe(3000);
  expect(r.graph.nodes.p).toBe(g.nodes.p); // untouched nodes keep their object
});

test('a run of removed nodes is contracted and the durations add up', () => {
  const g = chain([
    node('p', 'prompt', 0), node('a', 'thinking', 1, { durationMs: 1000 }), node('s', 'system', 2),
    node('b', 'thinking', 3, { durationMs: 500 }), node('x', 'text', 4),
  ]);
  const r = compactGraph(g);
  expect(pairs(r.graph)).toEqual(['p->x']);
  expect(r.thinkingMs.get('x')).toBe(1500);
});

test('kept: thinking with text, a trailing empty thinking node, the selection, compact and interrupt system nodes', () => {
  const g = chain([
    node('p', 'prompt', 0), node('t1', 'thinking', 1, { summary: 'because' }), node('c', 'system', 2, { systemSubtype: 'compact' }),
    node('i', 'system', 3, { systemSubtype: 'interrupt' }), node('sel', 'thinking', 4), node('s', 'system', 5), node('last', 'thinking', 6),
  ]);
  const r = compactGraph(g, { keep: 'sel' });
  expect(Object.keys(r.graph.nodes).sort()).toEqual(['c', 'i', 'last', 'p', 'sel', 't1']);
  expect(pairs(r.graph)).toEqual(['c->i', 'i->sel', 'p->t1', 'sel->last', 't1->c']);
});

test(`${RUN_MIN} consecutive successful calls of one tool become one run node`, () => {
  const g = chain([node('p', 'prompt', 0), read('a', 1), read('b', 2), read('c', 3), node('x', 'text', 4)]);
  const r = compactGraph(g);
  const id = runIdOf('a');
  expect(isRunId(id)).toBe(true);
  expect(Object.keys(r.graph.nodes).sort()).toEqual([id, 'p', 'x'].sort());
  expect(pairs(r.graph)).toEqual([`${id}->x`, `p->${id}`].sort());
  expect(r.runs.get(id)).toEqual(['a', 'b', 'c']);
  const run = r.graph.nodes[id]!;
  expect(run).toMatchObject({ kind: 'tool', status: 'succeeded', toolName: 'Read', title: 'Read ×3', durationMs: 30, turnId: 't1' });
  expect(run.timestamp).toBe(g.nodes.a!.timestamp);
  expect(run.summary).toContain('a.ts');
});

test('two calls are not merged; nor are different tools, failed or running calls', () => {
  const two = compactGraph(chain([node('p', 'prompt', 0), read('a', 1), read('b', 2), node('x', 'text', 3)]));
  expect(two.runs.size).toBe(0);
  const mixed = compactGraph(chain([
    node('p', 'prompt', 0), read('a', 1), read('b', 2), read('c', 3, { toolName: 'Bash', title: 'Bash' }), read('d', 4),
  ]));
  expect(mixed.runs.size).toBe(0);
  const failed = compactGraph(chain([node('p', 'prompt', 0), read('a', 1), read('b', 2, { status: 'failed' }), read('c', 3), read('d', 4)]));
  expect(failed.runs.size).toBe(0);
  const running = compactGraph(chain([node('p', 'prompt', 0), read('a', 1), read('b', 2), read('c', 3, { status: 'running' })]));
  expect(running.runs.size).toBe(0);
});

test('calls separated only by empty thinking nodes merge', () => {
  const g = chain([
    node('p', 'prompt', 0), read('a', 1), node('t1', 'thinking', 2, { durationMs: 100 }), read('b', 3),
    node('t2', 'thinking', 4, { durationMs: 200 }), read('c', 5), node('x', 'text', 6),
  ]);
  const r = compactGraph(g);
  expect(r.runs.get(runIdOf('a'))).toEqual(['a', 'b', 'c']);
  expect(pairs(r.graph)).toEqual([`${runIdOf('a')}->x`, `p->${runIdOf('a')}`].sort());
});

test('parallel calls of one tool (same parent, same child) merge, and chain with a following batch', () => {
  const g = graph(
    [node('p', 'prompt', 0), read('a', 1), read('b', 1), read('c', 1), read('d', 2), read('f', 2), node('x', 'text', 3)],
    [e('p', 'a', 'fork'), e('p', 'b', 'fork'), e('p', 'c', 'fork'),
      e('a', 'd'), e('a', 'f'), e('b', 'd'), e('b', 'f'), e('c', 'd'), e('c', 'f'), e('d', 'x'), e('f', 'x')],
  );
  const r = compactGraph(g);
  const id = runIdOf('a');
  expect(r.runs.get(id)).toEqual(['a', 'b', 'c', 'd', 'f']);
  expect(pairs(r.graph)).toEqual([`${id}->x`, `p->${id}`].sort());
  expect(r.graph.nodes[id]!.title).toBe('Read ×5');
});

test('runs do not cross a turn or an agent, and a run holding the selection is not formed', () => {
  const turns = compactGraph(chain([read('a', 1), read('b', 2), read('c', 3, { turnId: 't2' }), read('d', 4, { turnId: 't2' })]));
  expect(turns.runs.size).toBe(0);
  const agents = compactGraph(chain([read('a', 1), read('b', 2), read('c', 3, { agentId: 'ag' })]));
  expect(agents.runs.size).toBe(0);
  const g = chain([node('p', 'prompt', 0), read('a', 1), read('b', 2), read('c', 3)]);
  expect(compactGraph(g, { keep: 'b' }).runs.size).toBe(0);
});

test('allowRun vetoes a run by its id (an expanded run stays expanded)', () => {
  const g = chain([node('p', 'prompt', 0), read('a', 1), read('b', 2), read('c', 3), node('x', 'text', 4), read('d', 5), read('f', 6), read('h', 7)]);
  const r = compactGraph(g, { allowRun: (id) => id !== runIdOf('a') });
  expect([...r.runs.keys()]).toEqual([runIdOf('d')]);
  expect(r.graph.nodes.a).toBe(g.nodes.a);
});

test('thinking time in front of a run lands on the run node', () => {
  const g = chain([node('p', 'prompt', 0), node('th', 'thinking', 1, { durationMs: 700 }), read('a', 2), read('b', 3), read('c', 4)]);
  const r = compactGraph(g);
  expect(r.thinkingMs.get(runIdOf('a'))).toBe(700);
});

test('a compactor reuses the run node object while its members are unchanged', () => {
  const nodes = [node('p', 'prompt', 0), read('a', 1), read('b', 2), read('c', 3)];
  const compactor = createCompactor();
  const first = compactor(chain(nodes)).graph.nodes[runIdOf('a')];
  const again = compactor(chain([...nodes, node('x', 'text', 9)])).graph.nodes[runIdOf('a')];
  expect(again).toBe(first);
  const grown = compactor(chain([...nodes, read('d', 4)])).graph.nodes[runIdOf('a')];
  expect(grown).not.toBe(first);
  expect(grown!.title).toBe('Read ×4');
});

test('5,000 empty thinking nodes in a row are contracted quickly', () => {
  const nodes = [node('p', 'prompt', 0)];
  for (let i = 0; i < 5000; i++) nodes.push(node(`th${i}`, 'thinking', i + 1, { durationMs: 1 }));
  nodes.push(node('x', 'text', 6000));
  const started = performance.now();
  const r = compactGraph(chain(nodes));
  expect(performance.now() - started).toBeLessThan(500);
  expect(pairs(r.graph)).toEqual(['p->x']);
  expect(r.thinkingMs.get('x')).toBe(5000);
});

test('buildView counts a run as its member calls and carries thinking time onto view nodes', () => {
  const g = chain([
    node('p', 'prompt', 0), node('th', 'thinking', 1, { durationMs: 900 }), read('a', 2), read('b', 3), read('c', 4), node('x', 'text', 5),
  ]);
  const r = compactGraph(g);
  const view = buildView(r.graph, new Map(), undefined, { runs: r.runs, thinkingMs: r.thinkingMs });
  expect(view.turns[0]!.summary.toolCount).toBe(3);
  const vn = view.nodes.get(runIdOf('a'));
  expect(vn?.type === 'node' && vn.thinkingMs).toBe(900);
  expect(vn?.type === 'node' && vn.runCount).toBe(3);
  const plain = view.nodes.get('x');
  expect(plain?.type === 'node' && plain.runCount).toBe(0);
});

// The shape the server gives parallel batches: every member of a batch hangs off the same parent; the first call of the
// next message is joined from every member, the later calls of that message hang off the last member only.
test('thinking time in front of parallel calls is counted once on their run', () => {
  const g = graph(
    [node('p', 'prompt', 0), node('th', 'thinking', 1, { durationMs: 3000 }), read('a', 2), read('b', 2), read('c', 2), node('x', 'text', 3)],
    [e('p', 'th'), e('th', 'a'), e('th', 'b'), e('th', 'c'), e('a', 'x'), e('b', 'x'), e('c', 'x')],
  );
  const r = compactGraph(g);
  expect(r.runs.get(runIdOf('a'))).toEqual(['a', 'b', 'c']);
  expect(r.thinkingMs.get(runIdOf('a'))).toBe(3000);
});

test('a run of parallel calls survives the next message arriving call by call (server edge shape)', () => {
  const compactor = createCompactor();
  const nodes = [node('p', 'prompt', 0), read('a', 1), read('b', 1), read('c', 1)];
  const edges = [e('p', 'a', 'fork'), e('p', 'b', 'fork'), e('p', 'c', 'fork')];
  expect([...compactor(graph(nodes, edges)).runs.keys()]).toEqual([runIdOf('a')]);
  // The next message's first call d is joined from every member ...
  nodes.push(node('d', 'tool', 2, { status: 'succeeded', toolName: 'Bash', title: 'Bash' }));
  edges.push(e('a', 'd'), e('b', 'd'), e('c', 'd'));
  expect(compactor(graph(nodes, edges)).runs.get(runIdOf('a'))).toEqual(['a', 'b', 'c']);
  // ... its second call f hangs off the last member only.
  nodes.push(node('f', 'tool', 2, { status: 'succeeded', toolName: 'Bash', title: 'Bash' }));
  edges.push(e('c', 'f'));
  const r = compactor(graph(nodes, edges));
  expect(r.runs.get(runIdOf('a'))).toEqual(['a', 'b', 'c']);
  expect(pairs(r.graph)).toEqual([`${runIdOf('a')}->d`, `${runIdOf('a')}->f`, `p->${runIdOf('a')}`].sort());
});

test('four parallel calls are one run of four, and a following batch of the same tool joins it (server edge shape)', () => {
  const g = graph(
    [node('p', 'prompt', 0), read('a', 1), read('b', 1), read('c', 1), read('c2', 1), read('d', 2), read('f', 2), node('x', 'text', 3)],
    [e('p', 'a', 'fork'), e('p', 'b', 'fork'), e('p', 'c', 'fork'), e('p', 'c2', 'fork'),
      e('a', 'd'), e('b', 'd'), e('c', 'd'), e('c2', 'd'), e('c2', 'f'), e('d', 'x'), e('f', 'x')],
  );
  const r = compactGraph(g);
  expect(r.runs.get(runIdOf('a'))).toEqual(['a', 'b', 'c', 'c2', 'd', 'f']);
  expect(pairs(r.graph)).toEqual([`${runIdOf('a')}->x`, `p->${runIdOf('a')}`].sort());
});

test('parallel calls are not merged while one of them is still in flight, so the run id does not change later', () => {
  const build = (aStatus: GraphNode['status']) => graph(
    [node('p', 'prompt', 0), read('a', 1, { status: aStatus }), read('b', 1), read('c', 1), read('d', 1)],
    [e('p', 'a', 'fork'), e('p', 'b', 'fork'), e('p', 'c', 'fork'), e('p', 'd', 'fork')],
  );
  const compactor = createCompactor();
  expect(compactor(build('running')).runs.size).toBe(0);
  expect(compactor(build('awaiting_permission')).runs.size).toBe(0);
  expect(compactor(build('succeeded')).runs.get(runIdOf('a'))).toEqual(['a', 'b', 'c', 'd']);
});

test('exclude keeps the named calls out of every run; the calls after them can still form one', () => {
  const g = chain([node('p', 'prompt', 0), read('a', 1), read('b', 2), read('c', 3), read('d', 4), read('f', 5), read('h', 6)]);
  const none = compactGraph(g, { exclude: new Set(['a', 'b', 'c', 'd']) });
  expect(none.runs.size).toBe(0);
  const later = compactGraph(g, { exclude: new Set(['a', 'b', 'c']) });
  expect(later.runs.get(runIdOf('d'))).toEqual(['d', 'f', 'h']);
  expect(later.graph.nodes.a).toBe(g.nodes.a);
});
