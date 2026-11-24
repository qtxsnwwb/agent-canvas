import { createTimelineWorkerState, type TimelineRequest } from './timelineClient';

// Request TimelineRequest -> reply TimelineReply (see timelineClient.ts).
const state = createTimelineWorkerState();
const ctx = self as unknown as {
  onmessage: ((ev: { data: TimelineRequest }) => void) | null;
  postMessage(msg: unknown): void;
};

ctx.onmessage = (ev) => {
  ctx.postMessage(state.handle(ev.data));
};
