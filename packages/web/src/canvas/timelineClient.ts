import type { Graph, GraphNode, Session } from '@agent-canvas/shared';
import type { SessionSource } from '../sessionSource';
import { createThrottle } from '../throttle';
import { computeAgentTimeline, type AgentTimelineResult } from './agentTime';
import type { WorkerLike } from './layoutClient';
import { snapshotClock, waterfallClock, type WaterfallClock } from './waterfall';

/**
 * Where the 时间线 view's numbers are computed (computeAgentTimeline, about 110 ms on 100,000 nodes): on the page's own
 * thread for a small session, in a worker for a large one in the app. The exported viewer has no worker (its content
 * security policy allows none): it computes on its own thread (createInThreadTimelineClient). This module loads no
 * worker by URL; the app's worker comes from timelineWorker.ts through SessionSource.createTimelineClient.
 */

export type TimelineSession = Pick<Session, 'origin' | 'status' | 'lastActivityAt'>;

export interface TimelineClient {
  compute(graph: Graph, session: TimelineSession, clock: WaterfallClock): Promise<AgentTimelineResult>;
  dispose(): void;
}

/** Below this many nodes the app computes on the page's own thread (about 10 ms; a worker round trip saves nothing). */
export const IN_THREAD_BELOW = 10_000;
/** A request with no answer after this long counts as a hung worker. */
export const TIMELINE_TIMEOUT_MS = 20_000;
/** Graph changes are taken at most this often (the canvas rebuilds as often; the waterfall panel follows it). */
export const TIMELINE_REFRESH_MS = 50;
/** While the clock ticks, the numbers are computed again this often (as the waterfall panel re-renders). */
export const TIMELINE_TICK_MS = 1000;

const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

/** Computes on the page's own thread (the exported viewer; a small session in the app). */
export function createInThreadTimelineClient(): TimelineClient {
  let disposed = false;
  return {
    compute(graph, session, clock) {
      if (disposed) return Promise.reject(new Error('timeline client disposed'));
      try {
        return Promise.resolve(computeAgentTimeline(graph, session, clock));
      } catch (err) {
        return Promise.reject(toError(err));
      }
    },
    dispose() { disposed = true; },
  };
}

/**
 * One request to the worker. The worker keeps the nodes it was sent: `reset` starts from none, `upserts` are the nodes
 * that are new or changed (by object identity) since the last request, `removals` the ids that are gone.
 */
export interface TimelineRequest {
  id: number;
  reset: boolean;
  upserts: GraphNode[];
  removals: string[];
  session: TimelineSession;
  clock: WaterfallClock;
}
export type TimelineReply = { id: number; result: AgentTimelineResult } | { id: number; error: string };

/** The worker's side (timeline.worker.ts runs it; tests run it in place of a worker). */
export function createTimelineWorkerState(): { handle(req: TimelineRequest): TimelineReply } {
  let nodes: Record<string, GraphNode> = {};
  return {
    handle(req) {
      try {
        if (req.reset) nodes = {};
        for (const id of req.removals) delete nodes[id];
        for (const n of req.upserts) nodes[n.id] = n;
        return { id: req.id, result: computeAgentTimeline({ nodes, edges: {} }, req.session, req.clock) };
      } catch (err) {
        return { id: req.id, error: toError(err).message };
      }
    },
  };
}

interface Pending { timer: ReturnType<typeof setTimeout>; resolve(r: AgentTimelineResult): void; reject(e: Error): void; fallback(): void }

/**
 * The app's client: a session with fewer than `inThreadBelow` nodes is computed on the page's own thread; a larger one
 * in a worker (created on first need), which is sent only what changed since the last request. Answers come in the
 * order of the requests. A worker that errors, cannot be created or does not answer within 20 s is dropped: its
 * pending requests and every later one are computed on the page's own thread.
 */
export function createTimelineClient(createWorker: () => WorkerLike, opts: { inThreadBelow?: number } = {}): TimelineClient {
  const inThreadBelow = opts.inThreadBelow ?? IN_THREAD_BELOW;
  const inThread = createInThreadTimelineClient();
  const pending = new Map<number, Pending>();
  /** What the worker holds: id -> the node object last sent. */
  const sent = new Map<string, GraphNode>();
  let lastGraph: Graph | null = null;
  let worker: WorkerLike | null = null;
  let broken = false;
  let disposed = false;
  let nextId = 1;

  function dropWorker(): void {
    const w = worker;
    worker = null;
    sent.clear();
    lastGraph = null;
    if (w) {
      w.onmessage = null;
      w.onerror = null;
      try { w.terminate(); } catch { /* already gone */ }
    }
  }
  /** The worker failed: drop it and answer what it still owed on the page's own thread. */
  function failed(): void {
    broken = true;
    dropWorker();
    const all = [...pending.values()];
    pending.clear();
    for (const p of all) {
      clearTimeout(p.timer);
      p.fallback();
    }
  }
  function ensureWorker(): WorkerLike {
    if (worker) return worker;
    const w = createWorker();
    w.onmessage = (ev) => {
      const data = ev.data as TimelineReply;
      const p = pending.get(data.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(data.id);
      if ('error' in data) p.reject(new Error(data.error));
      else p.resolve(data.result);
    };
    w.onerror = () => failed();
    worker = w;
    return w;
  }

  return {
    compute(graph, session, clock) {
      if (disposed) return Promise.reject(new Error('timeline client disposed'));
      let count = 0;
      for (const _ in graph.nodes) count++;
      if (broken || count < inThreadBelow) return inThread.compute(graph, session, clock);
      let w: WorkerLike;
      try {
        w = ensureWorker();
      } catch {
        failed();
        return inThread.compute(graph, session, clock);
      }
      // What changed since the last request (nothing when the graph is the same object).
      const reset = sent.size === 0 && lastGraph === null;
      const upserts: GraphNode[] = [];
      const removals: string[] = [];
      if (graph !== lastGraph) {
        let kept = 0;
        for (const id in graph.nodes) {
          const n = graph.nodes[id]!;
          const before = sent.get(id);
          if (before !== undefined) kept++;
          if (before !== n) upserts.push(n);
        }
        if (kept < sent.size) for (const id of sent.keys()) if (!Object.prototype.hasOwnProperty.call(graph.nodes, id)) removals.push(id);
      }
      const id = nextId++;
      return new Promise<AgentTimelineResult>((resolve, reject) => {
        const fallback = (): void => { inThread.compute(graph, session, clock).then(resolve, reject); };
        const timer = setTimeout(failed, TIMELINE_TIMEOUT_MS);
        pending.set(id, { timer, resolve, reject, fallback });
        try {
          w.postMessage({ id, reset, upserts, removals, session: { origin: session.origin, status: session.status, lastActivityAt: session.lastActivityAt }, clock } satisfies TimelineRequest);
        } catch {
          // Not sent: the worker's copy is unknown now. Start over with a fresh worker next time; this one on the page.
          clearTimeout(timer);
          pending.delete(id);
          dropWorker();
          fallback();
          return;
        }
        for (const rid of removals) sent.delete(rid);
        for (const n of upserts) sent.set(n.id, n);
        lastGraph = graph;
      });
    },
    dispose() {
      disposed = true;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('timeline client disposed'));
      }
      pending.clear();
      dropWorker();
      inThread.dispose();
    },
  };
}

/**
 * The 时间线 view's computation while it shows: a client from the source (the app's moves a large session into a
 * worker; none: the page's own thread), kept current by watchAgentTimeline. The stop function also disposes the client,
 * so a worker and its copy of the graph do not outlive the view; showing it again starts a new one.
 */
export function startAgentTimeline(
  source: Pick<SessionSource, 'getGraph' | 'getSession' | 'subscribe' | 'live' | 'createTimelineClient'>,
  handlers: { onResult(result: AgentTimelineResult, graph: Graph): void; onError?(err: Error): void },
): () => void {
  const client = source.createTimelineClient?.() ?? createInThreadTimelineClient();
  const stop = watchAgentTimeline({ source, client, ...handlers });
  return () => {
    stop();
    client.dispose();
  };
}

/**
 * Keeps the 时间线 numbers current: computed now, again when the source changes (throttled, TIMELINE_REFRESH_MS) and
 * every second while the clock ticks (once more when it stops), one computation at a time; triggers while one runs are
 * folded into one run after it, on the newest graph, so an older result never follows a newer one. A snapshot source
 * (`live` false) is computed with snapshotClock and never ticks. Returns the stop function; nothing is reported after it.
 */
export function watchAgentTimeline(o: {
  source: Pick<SessionSource, 'getGraph' | 'getSession' | 'subscribe' | 'live'>;
  client: TimelineClient;
  onResult(result: AgentTimelineResult, graph: Graph): void;
  onError?(err: Error): void;
}): () => void {
  const { source, client } = o;
  let stopped = false;
  let running = false;
  let again = false;
  /** Whether the clock was ticking at the last computation (the first one after it stops is still needed). */
  let lastTicking = false;
  const clockNow = (): WaterfallClock => (source.live ? waterfallClock(source.getSession(), Date.now()) : snapshotClock(source.getSession()));
  const run = (): void => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    const graph = source.getGraph();
    const session = source.getSession();
    const clock = clockNow();
    lastTicking = clock.ticking || clock.backgroundTicking;
    client.compute(graph, session, clock).then(
      (r) => { if (!stopped) o.onResult(r, graph); },
      (err: unknown) => { if (!stopped) o.onError?.(toError(err)); },
    ).finally(() => {
      running = false;
      if (again) {
        again = false;
        run();
      }
    });
  };
  const throttle = createThrottle(run, TIMELINE_REFRESH_MS);
  const unsubscribe = source.subscribe(() => throttle.trigger());
  const ticker = source.live
    ? setInterval(() => {
      const c = clockNow();
      if (c.ticking || c.backgroundTicking || lastTicking) run();
    }, TIMELINE_TICK_MS)
    : null;
  run();
  return () => {
    stopped = true;
    throttle.cancel();
    unsubscribe();
    if (ticker !== null) clearInterval(ticker);
  };
}
