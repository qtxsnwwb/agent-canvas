import { expect, test } from 'vitest';
import type { Change, GraphNode, Session } from '@agent-canvas/shared';
import { openStore } from '../src/store/store.js';
import { storeStatsSource } from '../src/stats/service.js';

const iso = (ms: number): string => new Date(ms).toISOString();
const T0 = Date.parse('2026-11-10T10:00:00Z');

function session(id: string): Session {
  return {
    id, projectId: 'p1', origin: 'claude', cwd: null, title: null, gitBranch: null, status: 'idle', sourceDeleted: false,
    startedAt: iso(T0), lastActivityAt: iso(T0),
  };
}
function node(sessionId: string, id: string): GraphNode {
  return {
    id, sessionId, turnId: 'T', agentId: null, parentId: null, kind: 'text', status: null, timestamp: iso(T0),
    confirmed: true, title: 't', summary: 's', toolName: null, toolUseId: null, messageId: null, durationMs: null,
    endedAt: null, usage: null, systemSubtype: null, childAgentId: null,
  };
}
const add = (sessionId: string, ids: string[]): Change[] => ids.map((id) => ({ type: 'node_added', node: node(sessionId, id), detail: {} }));

test('nodePage: one session\'s nodes in id order, after a given id, at most `limit`, with their rowid', () => {
  const store = openStore(':memory:');
  try {
    store.applyChanges([{ type: 'session_upserted', session: session('a') }, { type: 'session_upserted', session: session('b') }]);
    store.applyChanges(add('a', ['n3', 'n1', 'n2']));
    store.applyChanges(add('b', ['x']));
    const first = store.nodePage('a', null, 2);
    expect(first.map((r) => r.node.id)).toEqual(['n1', 'n2']);
    expect(store.nodePage('a', 'n2', 2).map((r) => r.node.id)).toEqual(['n3']);
    expect(store.nodePage('a', 'n3', 2)).toEqual([]);
    // rowid = insertion order (the snapshot's node order).
    const all = store.nodePage('a', null, 10);
    const byRowid = [...all].sort((p, q) => p.rowid - q.rowid).map((r) => r.node.id);
    expect(byRowid).toEqual(store.getGraph('a')!.nodes.map((n) => n.id));
    expect(store.nodePage('missing', null, 10)).toEqual([]);
  } finally {
    store.close();
  }
});

test('lastSeq: the last assigned change seq (as in a snapshot)', () => {
  const store = openStore(':memory:');
  try {
    expect(store.lastSeq()).toBe(0);
    store.applyChanges([{ type: 'session_upserted', session: session('a') }, ...add('a', ['n1'])]);
    expect(store.lastSeq()).toBe(store.getGraph('a')!.seq);
  } finally {
    store.close();
  }
});

test('the stats source reads a session page by page in snapshot order, keyed on the seq taken before the first page', async () => {
  const store = openStore(':memory:');
  try {
    store.applyChanges([{ type: 'session_upserted', session: session('a') }]);
    const ids = Array.from({ length: 12 }, (_, i) => `n${String(11 - i).padStart(2, '0')}`); // inserted in reverse id order
    store.applyChanges(add('a', ids));
    const seqBefore = store.lastSeq();
    const source = storeStatsSource(store, { pageSize: 5 });
    const pages: number[] = [];
    const spy = store.nodePage.bind(store);
    store.nodePage = (s, after, limit) => {
      const out = spy(s, after, limit);
      pages.push(out.length);
      // A change committed between pages: the result keeps the seq taken before the first page.
      if (pages.length === 1) store.applyChanges(add('a', ['zz-late']));
      return out;
    };
    const read = await source.readSession('a');
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(read!.seq).toBe(seqBefore);
    expect(read!.nodes.slice(0, 12).map((n) => n.id)).toEqual(ids);
    expect(await source.readSession('missing')).toBeNull();
  } finally {
    store.close();
  }
});
