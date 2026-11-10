import { afterEach, expect, test, vi } from 'vitest';
import { api, openLiveSession, openLiveSessions } from '../src/client';
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

// ---- final fix wave, group 7: hello / resync ----

/** A fetchGraph whose responses are resolved by the test. */
function controlledFetch(first: GraphSnapshotLike) {
  const pending: ((s: GraphSnapshotLike) => void)[] = [];
  let calls = 0;
  const fetchGraph = (): Promise<GraphSnapshotLike> => {
    calls += 1;
    if (calls === 1) return Promise.resolve(first);
    return new Promise((resolve) => pending.push(resolve));
  };
  return { fetchGraph, calls: () => calls, respond: (s: GraphSnapshotLike) => pending.shift()!(s) };
}
type GraphSnapshotLike = ReturnType<typeof snapshot>;
const added = (seq: number, id: string) => ({ seq, type: 'node_added', node: mkNode(id), detail: {} });

test('resync：重新取快照替换图，取快照期间到达的变更只应用新于快照的', async () => {
  const sock = fakeSocket();
  const f = controlledFetch(snapshot({ seq: 5, nodes: [mkNode('n1')] }));
  const live = await openLiveSession('s1', { fetchGraph: f.fetchGraph, createSocket: () => sock });
  const fn = vi.fn();
  live.subscribe(fn);
  await Promise.resolve();
  sock.receive({ type: 'resync', sessionId: 's1' });
  expect(f.calls()).toBe(2);
  sock.receive({ type: 'changes', changes: [added(9, 'old'), added(11, 'new')] });
  expect(live.getGraph().nodes.new).toBeUndefined(); // buffered while the refetch is in flight
  f.respond(snapshot({ seq: 10, nodes: [mkNode('r1'), mkNode('r2')] }));
  await vi.waitFor(() => expect(Object.keys(live.getGraph().nodes).sort()).toEqual(['new', 'r1', 'r2']));
  expect(fn).toHaveBeenCalled();
  sock.receive({ type: 'changes', changes: [added(11, 'new'), added(12, 'n12')] }); // 11 is not applied twice
  expect(Object.keys(live.getGraph().nodes).sort()).toEqual(['n12', 'new', 'r1', 'r2']);
  live.close();
});

test('其他会话的 resync 被忽略', async () => {
  const sock = fakeSocket();
  const f = controlledFetch(snapshot({ seq: 1 }));
  const live = await openLiveSession('s1', { fetchGraph: f.fetchGraph, createSocket: () => sock });
  sock.receive({ type: 'resync', sessionId: 's2' });
  expect(f.calls()).toBe(1);
  live.close();
});

test('重连后 hello 的 epoch 变化视为 resync；不变则不重取', async () => {
  vi.useFakeTimers();
  const socks: FakeSocket[] = [];
  const f = controlledFetch(snapshot({ seq: 3 }));
  const live = await openLiveSession('s1', { fetchGraph: f.fetchGraph, createSocket: () => { const s = fakeSocket(); socks.push(s); return s; } });
  socks[0]!.receive({ type: 'hello', epoch: 'e1' });
  socks[0]!.drop();
  await vi.advanceTimersByTimeAsync(1000);
  socks[1]!.receive({ type: 'hello', epoch: 'e1' });
  expect(f.calls()).toBe(1);
  socks[1]!.drop();
  await vi.advanceTimersByTimeAsync(1000);
  socks[2]!.receive({ type: 'hello', epoch: 'e2' });
  expect(f.calls()).toBe(2);
  f.respond(snapshot({ seq: 1, nodes: [mkNode('fresh')] }));
  await vi.waitFor(() => expect(Object.keys(live.getGraph().nodes)).toEqual(['fresh']));
  socks[2]!.receive({ type: 'changes', changes: [added(2, 'n2')] }); // seqs restart in the new database
  expect(Object.keys(live.getGraph().nodes).sort()).toEqual(['fresh', 'n2']);
  live.close();
});

// ---- missing sessions (404) ----

const httpError = (status: number): Error => Object.assign(new Error(`HTTP ${status}`), { status });

test('getJson 失败时抛出的错误带 status', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
  try {
    await expect(api.graph('missing')).rejects.toMatchObject({ status: 404 });
  } finally {
    vi.unstubAllGlobals();
  }
});

test('首次取图 404：openLiveSession 以带 status 404 的错误 reject', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
  try {
    await expect(openLiveSession('missing', { createSocket: () => fakeSocket() })).rejects.toMatchObject({ status: 404 });
  } finally {
    vi.unstubAllGlobals();
  }
});

function failingResync(error: Error) {
  let calls = 0;
  const fetchGraph = (): Promise<GraphSnapshotLike> => {
    calls += 1;
    return calls === 1 ? Promise.resolve(snapshot({ seq: 1 })) : Promise.reject(error);
  };
  return { fetchGraph, calls: () => calls };
}

test('resync 时 404：不再重试，订阅者收到通知，isGone() 为真', async () => {
  vi.useFakeTimers();
  const sock = fakeSocket();
  const f = failingResync(httpError(404));
  const live = await openLiveSession('s1', { fetchGraph: f.fetchGraph, createSocket: () => sock });
  const fn = vi.fn();
  live.subscribe(fn);
  expect(live.isGone()).toBe(false);
  sock.receive({ type: 'resync', sessionId: 's1' });
  await vi.advanceTimersByTimeAsync(0);
  expect(live.isGone()).toBe(true);
  expect(fn).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.calls()).toBe(2);
  live.close();
});

test('resync 时 500：按原有间隔重试', async () => {
  vi.useFakeTimers();
  const sock = fakeSocket();
  const f = failingResync(httpError(500));
  const live = await openLiveSession('s1', { fetchGraph: f.fetchGraph, createSocket: () => sock });
  sock.receive({ type: 'resync', sessionId: 's1' });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.calls()).toBe(2);
  expect(live.isGone()).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.calls()).toBe(3);
  live.close();
});
