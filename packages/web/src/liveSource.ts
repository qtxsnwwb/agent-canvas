import { api, openLiveBookmarks, type LiveSession } from './client';
import { createBrowserLayoutWorker, createLayoutClient } from './canvas/layoutClient';
import { createTimelineClient } from './canvas/timelineClient';
import { createBrowserTimelineWorker } from './canvas/timelineWorker';
import type { SessionSource } from './sessionSource';

/**
 * The session page's source for the running app: the live session plus the API (details, files, anomalies on demand,
 * the session's bookmarks live).
 */
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
    bookmarks: {
      // Over the app's shared sessions-scope socket: refetched on each `bookmarks` push naming this session.
      watch(onList) {
        const l = openLiveBookmarks((s) => onList(s.bookmarks), { sessionId: id() });
        return () => l.close();
      },
      create: (nodeId, note) => api.createBookmark(id(), nodeId, note),
      patch: api.patchBookmark,
      remove: api.deleteBookmark,
      restore: api.restoreBookmark,
    },
    createLayoutClient: () => createLayoutClient(createBrowserLayoutWorker),
    createTimelineClient: () => createTimelineClient(createBrowserTimelineWorker),
  };
}
