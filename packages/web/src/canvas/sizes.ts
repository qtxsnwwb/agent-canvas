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

/** Fixed node size (width x height) by kind; layout depends only on this, never on measured DOM. */
export function sizeOf(v: ViewNode): { width: number; height: number } {
  const s = v.type === 'turn_summary' ? SIZES.turn_summary
    : v.type === 'earlier' ? SIZES.earlier
      : (SIZES as Record<string, { width: number; height: number }>)[v.node.kind] ?? SIZES.unknown;
  return { width: s.width, height: s.height };
}
