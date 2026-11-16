import { api, type LiveSession } from './client';
import { createBrowserLayoutWorker, createLayoutClient } from './canvas/layoutClient';
import type { SessionSource } from './sessionSource';

/** The session page's source for the running app: the live session plus the API (details, files, anomalies on demand). */
export function liveSource(live: LiveSession): SessionSource {
  const id = (): string => live.getSession().id;
  return {
    getSession: live.getSession,
    getGraph: live.getGraph,
    subscribe: live.subscribe,
    live: true,
    nodeDetail: (nodeId) => api.nodeDetail(id(), nodeId).then((detail) => ({ detail, outputOriginalBytes: null })),
    files: () => api.sessionFiles(id()),
    anomalies: () => api.sessionAnomalies(id()),
    createLayoutClient: () => createLayoutClient(createBrowserLayoutWorker),
  };
}
