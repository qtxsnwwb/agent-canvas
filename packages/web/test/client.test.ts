import { afterEach, expect, test, vi } from 'vitest';
import { openLiveSession, openLiveSessions, orderNodes } from '../src/client';
import { baseSession, fakeSocket, mkNode, snapshot, type FakeSocket } from './helpers';


afterEach(() => { vi.useRealTimers(); });

test('changes after the snapshot are merged and old seq is dropped', async () => {
  const sock = fakeSocket();
  const live = await openLiveSession('s1', { fetchGraph: async () => snapshot({ seq: 5, nodes: [mkNode('n1')] }), createSocket: () => sock });
  await Promise.resolve();
  expect(sock.sent[0]).toEqual({ type: 'subscribe', scope: 'session', sessionId: 's1', sinceSeq: 5 });
  sock.receive({ type: 'changes', changes: [{ seq: 4, type: 'node_added', node: mkNode('old'), detail: {} }, { seq: 6, type: 'node_added', node: mkNode('n2'), detail: {} }] });
  expect(Object.keys(live.getGraph().nodes)).toEqual(['n1', 'n2']);
  live.close();
});

test('session_upserted updates the session and notifies subscribers', async () => {
  const sock = fakeSocket();
  const live = await openLiveSession('s1', { fetchGraph: async () => snapshot({ seq: 1 }), createSocket: () => sock });
  const fn = vi.fn();
  live.subscribe(fn);
  sock.receive({ type: 'changes', changes: [{ seq: 2, type: 'session_upserted', session: { ...baseSession, status: 'awaiting_permission' } }] });
  expect(live.getSession().status).toBe('awaiting_permission');
  expect(fn).toHaveBeenCalledTimes(1);
  live.close();
});

test('reconnects after a drop and resubscribes with the latest seq', async () => {
  vi.useFakeTimers();
  const socks: FakeSocket[] = [];
  const live = await openLiveSession('s1', { fetchGraph: async () => snapshot({ seq: 1 }), createSocket: () => { const s = fakeSocket(); socks.push(s); return s; } });
  socks[0].receive({ type: 'changes', changes: [{ seq: 3, type: 'node_added', node: mkNode('n2'), detail: {} }] });
  socks[0].drop();
  await vi.advanceTimersByTimeAsync(1000);
  expect(socks[1].sent[0]).toMatchObject({ sinceSeq: 3 });
  live.close();
});

test('does not reconnect after close', async () => {
  vi.useFakeTimers();
  let created = 0;
  const live = await openLiveSession('s1', { fetchGraph: async () => snapshot({ seq: 1 }), createSocket: () => { created++; return fakeSocket(); } });
  live.close();
  await vi.advanceTimersByTimeAsync(5000);
  expect(created).toBe(1);
});

test('orderNodes sorts by timestamp then id', () => {
  const g = { nodes: { b: mkNode('b', '2026-01-01T00:00:01Z'), a: mkNode('a', '2026-01-01T00:00:01Z'), c: mkNode('c', '2026-01-01T00:00:00Z') }, edges: {} };
  expect(orderNodes(g).map((n) => n.id)).toEqual(['c', 'a', 'b']);
});

test('openLiveSessions subscribes on open and forwards session_upserted', async () => {
  const sock = fakeSocket();
  const onSession = vi.fn();
  const live = openLiveSessions(onSession, { createSocket: () => sock });
  await Promise.resolve();
  expect(sock.sent[0]).toEqual({ type: 'subscribe', scope: 'sessions' });
  const upserted = { ...baseSession, status: 'idle' as const };
  sock.receive({ type: 'changes', changes: [{ seq: 9, type: 'session_upserted', session: upserted }, { seq: 10, type: 'node_added', node: mkNode('x'), detail: {} }] });
  expect(onSession).toHaveBeenCalledTimes(1);
  expect(onSession).toHaveBeenCalledWith(upserted);
  live.close();
});

test('openLiveSessions resubscribes after a reconnect and reports it', async () => {
  vi.useFakeTimers();
  const socks: FakeSocket[] = [];
  const onReconnect = vi.fn();
  const live = openLiveSessions(() => {}, { createSocket: () => { const s = fakeSocket(); socks.push(s); return s; }, onReconnect });
  await vi.advanceTimersByTimeAsync(0);
  socks[0].drop();
  await vi.advanceTimersByTimeAsync(1000);
  expect(socks).toHaveLength(2);
  expect(socks[1].sent[0]).toEqual({ type: 'subscribe', scope: 'sessions' });
  expect(onReconnect).toHaveBeenCalledTimes(1);
  live.close();
});

test('openLiveSessions does not reconnect after close', async () => {
  vi.useFakeTimers();
  let created = 0;
  const live = openLiveSessions(() => {}, { createSocket: () => { created++; return fakeSocket(); } });
  live.close();
  await vi.advanceTimersByTimeAsync(5000);
  expect(created).toBe(1);
});
