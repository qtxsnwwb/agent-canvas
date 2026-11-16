import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Change, GraphNode, NodeDetail } from '@agent-canvas/shared';
import { openStore, type Store } from '../src/store/store.js';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const iso = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const NOW = T0 + 24 * 60 * 60_000;

const session: Change = {
  type: 'session_upserted',
  session: {
    id: 's1', projectId: 'proj', origin: 'gemini', cwd: null, title: 'demo', gitBranch: null, status: 'idle',
    sourceDeleted: false, startedAt: iso(0), lastActivityAt: iso(5),
  },
};

const node = (id: string, minutes: number, body: string): GraphNode => ({
  id, sessionId: 's1', turnId: null, agentId: null, childAgentId: null, parentId: null, kind: 'text', status: null,
  timestamp: iso(minutes), confirmed: true, title: 'text', summary: body, toolName: null, toolUseId: null,
  messageId: null, durationMs: null, endedAt: null, usage: null, systemSubtype: null,
});
const added = (id: string, minutes: number, body: string): Change => ({
  type: 'node_added', node: node(id, minutes, body), detail: { text: body } as Partial<NodeDetail>,
});
const edge = (from: string, to: string, suffix = ''): Change => ({
  type: 'edge_added', edge: { id: `${from}->${to}${suffix}`, sessionId: 's1', from, to, kind: suffix === ':fork' ? 'fork' : 'sequence' },
});
const removed = (id: string): Change => ({ type: 'node_removed', sessionId: 's1', id });

const build: Change[] = [
  session,
  added('n1', 1, 'first alphaword reply'),
  added('n2', 2, 'middle zebracorn reply'),
  added('n3', 3, 'last gammaword reply'),
  edge('n1', 'n2'),
  edge('n2', 'n3'),
  edge('n1', 'n3', ':fork'),
];

let tmp: string;
const stores: Store[] = [];
const open = (name: string): Store => {
  const s = openStore(path.join(tmp, name));
  stores.push(s);
  return s;
};
const indexRows = (name: string): number => {
  const db = new Database(path.join(tmp, name), { readonly: true });
  try {
    return db.prepare('SELECT COUNT(*) FROM search_fts_docsize').pluck().get() as number;
  } finally {
    db.close();
  }
};
const hits = (store: Store, q: string): string[] =>
  store.searchContent(q, { nowMs: NOW, timeBudgetMs: 60_000 }).hits.map((h) => h.nodeId);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-node-removed-'));
});
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

function expectRemoved(store: Store, name: string): void {
  const g = store.getGraph('s1')!;
  expect(g.nodes.map((n) => n.id).sort()).toEqual(['n1', 'n3']);
  expect(g.edges.map((e) => e.id)).toEqual(['n1->n3:fork']);
  expect(g.edges.some((e) => e.from === 'n2' || e.to === 'n2')).toBe(false);
  expect(store.getNodeDetail('s1', 'n2')).toBeNull();
  expect(store.getNodeDetail('s1', 'n1')).not.toBeNull();
  expect(hits(store, 'zebracorn')).toEqual([]);
  expect(hits(store, 'alphaword')).toEqual(['n1']);
  expect(hits(store, 'gammaword')).toEqual(['n3']);
  expect(indexRows(name)).toBe(2);
}

test('node_removed in a later batch removes the node, its detail, its index row and its edges', () => {
  const store = open('a.db');
  store.applyChanges(build);
  expect(hits(store, 'zebracorn')).toEqual(['n2']);
  expect(indexRows('a.db')).toBe(3);
  const out = store.applyChanges([removed('n2')]);
  expect(out.map((c) => c.type)).toEqual(['node_removed']); // logged and forwarded like any change
  expectRemoved(store, 'a.db');
  expect(store.changesSince(0).some((c) => c.type === 'node_removed' && c.id === 'n2')).toBe(true);
});

test('node_removed in the same batch as the node was added and updated', () => {
  const store = open('b.db');
  store.applyChanges([
    ...build,
    { type: 'node_updated', sessionId: 's1', id: 'n2', patch: { summary: 'middle zebracorn reply changed' }, detail: { text: 'more zebracorn' } as Partial<NodeDetail> },
    removed('n2'),
  ]);
  expectRemoved(store, 'b.db');
});

test('a node removed and then added again is stored afresh', () => {
  const store = open('c.db');
  store.applyChanges(build);
  store.applyChanges([removed('n2'), added('n2', 2, 'again ostrichword'), edge('n1', 'n2')]);
  const g = store.getGraph('s1')!;
  expect(g.nodes.map((n) => n.id).sort()).toEqual(['n1', 'n2', 'n3']);
  expect(g.edges.map((e) => e.id).sort()).toEqual(['n1->n2', 'n1->n3:fork']);
  expect(hits(store, 'zebracorn')).toEqual([]);
  expect(hits(store, 'ostrichword')).toEqual(['n2']);
  expect(indexRows('c.db')).toBe(3);
});

test('node_removed of an unknown id is a no-op', () => {
  const store = open('d.db');
  store.applyChanges(build);
  const before = store.getGraph('s1')!;
  store.applyChanges([removed('nope')]);
  const after = store.getGraph('s1')!;
  expect(after.nodes).toEqual(before.nodes);
  expect(after.edges).toEqual(before.edges);
  expect(indexRows('d.db')).toBe(3);
});

test('replaying the same change list on a fresh store gives the same graph', () => {
  const changes: Change[] = [...build, removed('n2'), added('n4', 4, 'fourth'), edge('n3', 'n4')];
  const live = open('e.db');
  for (const c of changes) live.applyChanges([c]);
  const replay = open('f.db');
  replay.applyChanges(changes);
  const [r, l] = [replay.getGraph('s1')!, live.getGraph('s1')!];
  expect(r.nodes).toEqual(l.nodes);
  expect(r.edges).toEqual(l.edges);
  expect(r.session).toEqual(l.session);
  expect(hits(replay, 'zebracorn')).toEqual([]);
  expect(indexRows('e.db')).toBe(indexRows('f.db'));
});
