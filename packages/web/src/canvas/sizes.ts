import type { ViewNode } from './view';

const SIZES = {
  prompt: { width: 280, height: 64 },
  text: { width: 280, height: 56 },
  thinking: { width: 160, height: 28 },
  tool: { width: 240, height: 52 },
  subagent: { width: 260, height: 68 },
  system: { width: 200, height: 32 },
  unknown: { width: 200, height: 40 },
  turn_summary: { width: 340, height: 60 },
  earlier: { width: 340, height: 44 },
} as const;

/** Inner padding of an expanded container, on every side. */
export const CONTAINER_PADDING = 16;
/** Height of an expanded container's title area (= the height of a collapsed subagent node). */
export const CONTAINER_HEADER = 68;
export const CONTAINER_MIN_WIDTH = 260;

/** Size of an expanded container: width = max(MIN_WIDTH, inner.width + 2 * PADDING), height = HEADER + inner.height + 2 * PADDING. */
export function containerSize(inner: { width: number; height: number }): { width: number; height: number } {
  return {
    width: Math.max(CONTAINER_MIN_WIDTH, inner.width + 2 * CONTAINER_PADDING),
    height: CONTAINER_HEADER + inner.height + 2 * CONTAINER_PADDING,
  };
}

/** Fixed node size (width x height) by kind; layout depends only on this, never on measured DOM. */
export function sizeOf(v: ViewNode): { width: number; height: number } {
  const s = v.type === 'turn_summary' ? SIZES.turn_summary
    : v.type === 'earlier' ? SIZES.earlier
      : (SIZES as Record<string, { width: number; height: number }>)[v.node.kind] ?? SIZES.unknown;
  return { width: s.width, height: s.height };
}
