/**
 * Calls `fn` at most once per `intervalMs`. A trigger schedules a call (if none is pending) at the earliest moment the
 * interval allows, so under a continuous stream of triggers `fn` still runs every `intervalMs` (a pure debounce would
 * wait for the stream to stop), and the last trigger is always followed by a call.
 */
export function createThrottle(fn: () => void, intervalMs: number): { trigger(): void; cancel(): void } {
  let last = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    trigger() {
      if (timer !== null) return;
      const wait = Math.max(0, last + intervalMs - Date.now());
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn();
      }, wait);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
