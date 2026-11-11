import { COLUMN_GAP, TURN_GAP, TURN_GAP_X, type Box } from './layout';

export interface Point { x: number; y: number }

const same = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;
const collinear = (a: Point, b: Point, c: Point): boolean => (b.x - a.x) * (c.y - b.y) === (b.y - a.y) * (c.x - b.x);

/**
 * SVG path through `points` with straight segments and corners rounded by up to `radius` (less where a segment is too
 * short). Repeated points and points lying on a straight run are dropped first.
 */
export function roundedPath(points: readonly Point[], radius = 10): string {
  const pts: Point[] = [];
  for (const p of points) {
    if (pts.length > 0 && same(pts[pts.length - 1]!, p)) continue;
    while (pts.length >= 2 && collinear(pts[pts.length - 2]!, pts[pts.length - 1]!, p)) pts.pop();
    pts.push(p);
  }
  if (pts.length === 0) return '';
  let d = `M ${pts[0]!.x} ${pts[0]!.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [a, b, c] = [pts[i - 1]!, pts[i]!, pts[i + 1]!];
    const inLen = Math.hypot(b.x - a.x, b.y - a.y);
    const outLen = Math.hypot(c.x - b.x, c.y - b.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const before = { x: b.x - ((b.x - a.x) / inLen) * r, y: b.y - ((b.y - a.y) / inLen) * r };
    const after = { x: b.x + ((c.x - b.x) / outLen) * r, y: b.y + ((c.y - b.y) / outLen) * r };
    d += ` L ${before.x} ${before.y} Q ${b.x} ${b.y} ${after.x} ${after.y}`;
  }
  if (pts.length > 1) d += ` L ${pts[pts.length - 1]!.x} ${pts[pts.length - 1]!.y}`;
  return d;
}

const right = (b: Box): number => b.x + b.width;
const midY = (b: Box): number => b.y + b.height / 2;

/**
 * An edge inside one group whose target does not lie below its source: the group was folded into columns (see
 * wrapColumns) and the edge leads from the bottom of one column to the top of the next. (The layered layout itself
 * always puts a target below its source.)
 */
export function isColumnWrap(source: Box, target: Box): boolean {
  return target.y < source.y + source.height && target.x >= right(source);
}

/**
 * The centre of the empty vertical strip that separates the source's column from the next one: just left of the
 * leftmost node to the right of the source that has a clear COLUMN_GAP-wide strip on its left. Null when there is none.
 */
export function columnGapX(source: Box, group: readonly Box[]): number | null {
  const from = source.x + source.width / 2;
  let best: number | null = null;
  for (const c of group) {
    if (c.x <= from || (best !== null && c.x >= best)) continue;
    if (group.every((o) => right(o) <= c.x - COLUMN_GAP || o.x >= c.x)) best = c.x;
  }
  return best === null ? null : best - COLUMN_GAP / 2;
}

/** Out of the source's right side, along the vertical line x = `gapX`, into the target's left side. */
export function sideLink(source: Box, target: Box, gapX: number): Point[] {
  return [{ x: right(source), y: midY(source) }, { x: gapX, y: midY(source) }, { x: gapX, y: midY(target) }, { x: target.x, y: midY(target) }];
}

/**
 * The line between two nodes of different turns. Same row (the target's turn is to the right): through the gap between
 * the two turns. Otherwise (the target's turn starts a new row): right of the source's turn, down to the gap above the
 * target's row, back to the left of the target's turn and into the target's left side.
 */
export function turnLink(source: Box, target: Box, sourceTurn: Box, targetTurn: Box): Point[] {
  const gapX = right(sourceTurn) + TURN_GAP_X / 2;
  if (targetTurn.y === sourceTurn.y && targetTurn.x > sourceTurn.x) return sideLink(source, target, gapX);
  const rowGapY = targetTurn.y - TURN_GAP / 2;
  const leftX = targetTurn.x - TURN_GAP_X / 2;
  return [
    { x: right(source), y: midY(source) }, { x: gapX, y: midY(source) }, { x: gapX, y: rowGapY },
    { x: leftX, y: rowGapY }, { x: leftX, y: midY(target) }, { x: target.x, y: midY(target) },
  ];
}
