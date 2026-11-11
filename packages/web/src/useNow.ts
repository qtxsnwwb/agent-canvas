import { useEffect, useState } from 'react';

/** Current time in ms, re-evaluated every `intervalMs` so time-derived display (e.g. `stale`) updates without events. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
