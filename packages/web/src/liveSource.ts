import type { Bookmark } from '@agent-canvas/shared';
import { api, openLiveBookmarks, type LiveSession, type SessionsFeed } from './client';
import { createBrowserLayoutWorker, createLayoutClient } from './canvas/layoutClient';
import { createTimelineClient } from './canvas/timelineClient';
import { createBrowserTimelineWorker } from './canvas/timelineWorker';
import type { SessionSource } from './sessionSource';

/**
 * The session page's source for the running app: the live session plus the API (details, files, anomalies on demand,
 * the session's bookmarks live). `bookmarkDeps`: tests only (the feed and the fetch of the bookmarks' live list;
 * default the app's shared sessions-scope socket and the API).
 */
export function liveSource(
  live: Pick<LiveSession, 'getSession' | 'getGraph' | 'subscribe'>,
  bookmarkDeps: { feed?: SessionsFeed; fetchBookmarks?: (sessionId: string) => Promise<Bookmark[]> } = {},
): SessionSource {
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
        const sessionId = id();
        const { feed, fetchBookmarks } = bookmarkDeps;
        const l = openLiveBookmarks((s) => onList(s.bookmarks), {
          sessionId, feed, ...(fetchBookmarks !== undefined ? { fetchBookmarks: () => fetchBookmarks(sessionId) } : {}),
        });
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
