import { useEffect, useRef, useState } from 'react';
import { advance, formatTokens, turnIndexAt } from './replay';
import type { CanvasSnapshot } from './useCanvas';

/** Playback timer period; each tick advances the time by the real elapsed time × the speed (see advance). */
export const PLAY_TICK_MS = 100;
const SPEEDS = [1, 10, 60] as const;
const DEFAULT_SPEED = 10;
/** Slider step (ms). */
const SLIDER_STEP = 1000;

function formatClock(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
}

/**
 * The replay view's timeline bar: play / pause, speed, a slider over the replay range with a tick per turn above it,
 * the current time and turn, "回到末尾", and the totals of the replayed graph. Presentational apart from its play
 * timer, which is cleared when playback stops or the bar unmounts (leaving the replay view).
 */
export function Timeline({ replay, onSeek }: { replay: NonNullable<CanvasSnapshot['replay']>; onSeek(ms: number): void }) {
  const { range, timeMs, marks, totals } = replay;
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(DEFAULT_SPEED);
  // The timer reads the latest values through refs; a seek is published at once, so the next render agrees.
  const timeRef = useRef(timeMs);
  timeRef.current = timeMs;
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const seekRef = useRef(onSeek);
  seekRef.current = onSeek;

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const step = advance(timeRef.current, now - last, speed, rangeRef.current);
      last = now;
      timeRef.current = step.timeMs;
      seekRef.current(step.timeMs);
      if (step.done) setPlaying(false);
    }, PLAY_TICK_MS);
    return () => clearInterval(id);
  }, [playing, speed]);

  const usable = range !== null && range.endMs > range.startMs;
  const start = range?.startMs ?? 0;
  const end = range?.endMs ?? 0;
  const span = end - start;
  const clock = formatClock(timeMs);
  const togglePlay = (): void => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (range === null) return;
    if (timeMs >= range.endMs) { // at the end: play from the start
      timeRef.current = range.startMs;
      onSeek(range.startMs);
    }
    setPlaying(true);
  };
  return (
    <div className="cc-timeline" role="group" aria-label="时间轴">
      {/* A toggle: its name stays "播放", aria-pressed says whether it is playing; the glyph shows pause while it is. */}
      <button type="button" className="cc-tl-btn cc-tl-play" aria-pressed={playing} disabled={!usable} onClick={togglePlay}>
        <span className="cc-tl-glyph" aria-hidden="true">{playing ? '❚❚' : '▶'}</span>播放
      </button>
      <select className="cc-tl-speed" aria-label="倍速" value={speed} onChange={(e) => setSpeed(Number(e.currentTarget.value))}>
        {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
      </select>
      <div className="cc-tl-track">
        <div className="cc-tl-ticks">
          {usable && marks.map((m, i) => (
            <button key={`${m.turnId}:${i}`} type="button" className="cc-tl-tick" aria-label={`第 ${i + 1} 轮`}
              title={`第 ${i + 1} 轮 · ${formatClock(m.ms)}`}
              style={{ left: `${((m.ms - start) / span) * 100}%` }} onClick={() => onSeek(m.ms)} />
          ))}
        </div>
        <input type="range" className="cc-tl-slider" min={start} max={end} step={SLIDER_STEP} value={timeMs}
          disabled={!usable} aria-label="回放时刻" aria-valuetext={clock}
          onChange={(e) => {
            setPlaying(false);
            const v = Number(e.currentTarget.value);
            // The last step may stop short of the end (the range is rarely a whole number of steps).
            onSeek(v > end - SLIDER_STEP ? end : v);
          }} />
      </div>
      <div className="cc-tl-now">
        <span className="cc-tl-clock">{clock}</span>
        <span className="cc-muted"> · 第 {turnIndexAt(marks, timeMs)} / {marks.length} 轮</span>
      </div>
      <button type="button" className="cc-tl-btn" disabled={range === null} onClick={() => onSeek(end)}>
        回到末尾
      </button>
      <div className="cc-tl-totals">
        {totals.nodeCount} 个节点 · 输入 {formatTokens(totals.usage.inputTokens)} · 输出 {formatTokens(totals.usage.outputTokens)}
      </div>
    </div>
  );
}
