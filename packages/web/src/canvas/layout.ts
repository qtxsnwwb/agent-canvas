import { CONTAINER_HEADER, CONTAINER_PADDING, containerSize, sizeOf } from './sizes';
import type { AgentGroup, CanvasView, TurnView } from './view';

export interface Box { x: number; y: number; width: number; height: number }
export interface TurnLayoutInput { key: string; nodes: { id: string; width: number; height: number }[]; edges: { id: string; from: string; to: string }[] }
/**
 * Positions are relative to the turn's top-left corner. `anchorX` is the horizontal centre of the turn's first input
 * node, relative to the same corner.
 */
export interface TurnLayout { key: string; width: number; height: number; anchorX: number; positions: Record<string, { x: number; y: number }> }
export interface ElkLike { layout(graph: unknown): Promise<unknown> }

/** Vertical gap between two rows of turns (room for the line that leads from a row's end to the next row's start). */
export const TURN_GAP = 72;
/** Horizontal gap between adjacent turns of a row. */
export const TURN_GAP_X = 64;
/** Height reserved at the top of each turn for its title. */
export const TURN_HEADER = 28;
/** A turn's cell is at least this wide (its title needs the room). */
export const TURN_MIN_WIDTH = 200;
/**
 * Width budget of a row of turns: a turn that would end past it starts a new row (a row always holds at least one
 * turn). Four outline cards (340 wide) and their gaps fit.
 */
export const ROW_WIDTH = 4 * 340 + 3 * TURN_GAP_X;
/** A group taller than this is folded into columns (see wrapColumns). */
export const COLUMN_HEIGHT = 720;
/** Horizontal gap between two columns of a folded group. */
export const COLUMN_GAP = 72;

const ELK_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.layered.spacing.nodeNodeBetweenLayers': '32',
  'elk.spacing.nodeNode': '24',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  // Centres a parent above its fork children (and the join below them).
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.padding': '[top=0,left=0,bottom=0,right=0]',
};

type Size = { width: number; height: number };
const NO_SIZES: ReadonlyMap<string, Size> = new Map();

/**
 * Layout input for any group (a turn or an agent group): nodes in `nodeIds` order (those in the view); only edges with
 * both ends among the emitted nodes. `sizes`: sizes of expanded containers by view node id; other nodes use sizeOf.
 */
export function groupInput(view: CanvasView, groupKey: string, nodeIds: readonly string[], sizes: ReadonlyMap<string, Size>): TurnLayoutInput {
  const ids = new Set<string>();
  const nodes: TurnLayoutInput['nodes'] = [];
  for (const id of nodeIds) {
    const vn = view.nodes.get(id);
    if (vn) {
      const size = sizes.get(id) ?? sizeOf(vn, view.mode);
      nodes.push({ id, width: size.width, height: size.height });
      ids.add(id);
    }
  }
  const edges = view.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => ({ id: e.id, from: e.from, to: e.to }));
  return { key: groupKey, nodes, edges };
}

/** Layout input for one turn (see groupInput). */
export function turnInput(view: CanvasView, turn: TurnView, sizes: ReadonlyMap<string, Size> = NO_SIZES): TurnLayoutInput {
  return groupInput(view, turn.key, turn.nodeIds, sizes);
}

/** Same input, same string: node id+size and edge from/to, in input order. */
export function turnSignature(input: TurnLayoutInput): string {
  return JSON.stringify([input.nodes.map((n) => [n.id, n.width, n.height]), input.edges.map((e) => [e.from, e.to])]);
}

interface ElkOut { width?: number; height?: number; children?: { id: string; x?: number; y?: number }[] }

/** The layout of a single-node input (no layout engine needed); null for any other input. */
export function singleNodeLayout(input: TurnLayoutInput): TurnLayout | null {
  if (input.nodes.length !== 1) return null;
  const only = input.nodes[0]!;
  return { key: input.key, width: only.width, height: only.height, anchorX: only.width / 2, positions: { [only.id]: { x: 0, y: 0 } } };
}

export async function layoutTurn(elk: ElkLike, input: TurnLayoutInput): Promise<TurnLayout> {
  const single = singleNodeLayout(input);
  if (single) return single;
  const out = (await elk.layout({
    id: 'root',
    layoutOptions: ELK_OPTIONS,
    children: input.nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    edges: input.edges.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  })) as ElkOut;
  const positions: Record<string, { x: number; y: number }> = {};
  for (const c of out.children ?? []) positions[c.id] = { x: c.x ?? 0, y: c.y ?? 0 };
  const first = input.nodes[0];
  const anchorX = first ? (positions[first.id]?.x ?? 0) + first.width / 2 : 0;
  return wrapColumns({ key: input.key, width: out.width ?? 0, height: out.height ?? 0, anchorX, positions }, input);
}

/**
 * Folds a tall top-to-bottom layout into columns read left to right: the layout is cut at horizontal lines that cross
 * no node and at most one edge (so a fork and its join stay in one column), a column is closed once the next piece
 * would make it taller than `maxHeight` (a piece taller than that gets a column of its own), and each column starts at
 * the top. A layout that fits is returned as is.
 */
export function wrapColumns(layout: TurnLayout, input: TurnLayoutInput, maxHeight = COLUMN_HEIGHT): TurnLayout {
  if (layout.height <= maxHeight) return layout;
  const boxes: { id: string; x: number; y: number; right: number; bottom: number }[] = [];
  for (const n of input.nodes) {
    const p = layout.positions[n.id];
    if (p) boxes.push({ id: n.id, x: p.x, y: p.y, right: p.x + n.width, bottom: p.y + n.height });
  }
  if (boxes.length < 2) return layout;
  boxes.sort((a, b) => a.y - b.y); // stable: equal tops keep input order
  const index = new Map(boxes.map((b, i) => [b.id, i]));
  // crossing[g]: edges with one end before sorted position g and the other at or after it.
  const delta = new Array<number>(boxes.length + 1).fill(0);
  for (const e of input.edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    delta[Math.min(a, b) + 1]! += 1;
    delta[Math.max(a, b) + 1]! -= 1;
  }
  // Pieces: maximal runs of nodes that may not be separated.
  const pieces: { from: number; to: number; top: number; bottom: number }[] = [];
  let crossing = 0;
  let maxBottom = -Infinity;
  let start = 0;
  for (let g = 1; g < boxes.length; g++) {
    crossing += delta[g]!;
    maxBottom = Math.max(maxBottom, boxes[g - 1]!.bottom);
    if (boxes[g]!.y >= maxBottom && crossing <= 1) {
      pieces.push({ from: start, to: g, top: boxes[start]!.y, bottom: maxBottom });
      start = g;
    }
  }
  pieces.push({ from: start, to: boxes.length, top: boxes[start]!.y, bottom: Math.max(maxBottom, boxes[boxes.length - 1]!.bottom) });
  if (pieces.length < 2) return layout;
  const columns: { from: number; to: number; top: number; bottom: number }[] = [];
  for (const piece of pieces) {
    const cur = columns[columns.length - 1];
    if (cur && piece.bottom - cur.top <= maxHeight) {
      cur.to = piece.to;
      cur.bottom = piece.bottom;
    } else columns.push({ ...piece });
  }
  if (columns.length < 2) return layout;
  const positions: Record<string, { x: number; y: number }> = {};
  let x = 0;
  let height = 0;
  for (const col of columns) {
    const members = boxes.slice(col.from, col.to);
    const left = Math.min(...members.map((b) => b.x));
    const right = Math.max(...members.map((b) => b.right));
    for (const b of members) positions[b.id] = { x: x + b.x - left, y: b.y - col.top };
    height = Math.max(height, col.bottom - col.top);
    x += right - left + COLUMN_GAP;
  }
  const first = input.nodes[0];
  const anchorX = first && positions[first.id] ? positions[first.id]!.x + first.width / 2 : layout.anchorX;
  return { key: layout.key, width: x - COLUMN_GAP, height, anchorX, positions };
}

/**
 * Places turns in reading order: left to right in rows, top-aligned within a row; a turn that would end past
 * `rowWidth` starts a new row below the tallest turn of the current one. A turn narrower than TURN_MIN_WIDTH is
 * centred in a cell of that width. A layout with no positions (a turn with nothing to draw) takes no space and gets no
 * box. Growing the last turn never moves an earlier one.
 */
export function wrapTurns(
  layouts: TurnLayout[], rowWidth = ROW_WIDTH,
): { positions: Record<string, { x: number; y: number }>; turnBoxes: Record<string, Box> } {
  const positions: Record<string, { x: number; y: number }> = {};
  const turnBoxes: Record<string, Box> = {};
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const l of layouts) {
    if (Object.keys(l.positions).length === 0) continue;
    const width = Math.max(l.width, TURN_MIN_WIDTH);
    const height = TURN_HEADER + l.height;
    if (x > 0 && x + width > rowWidth) {
      x = 0;
      y += rowHeight + TURN_GAP;
      rowHeight = 0;
    }
    turnBoxes[l.key] = { x, y, width, height };
    const inset = (width - l.width) / 2;
    for (const [id, p] of Object.entries(l.positions)) positions[id] = { x: x + inset + p.x, y: y + TURN_HEADER + p.y };
    rowHeight = Math.max(rowHeight, height);
    x += width + TURN_GAP_X;
  }
  return { positions, turnBoxes };
}

/**
 * Places agent groups on top of the wrapTurns result: inner node position = container position + (PADDING,
 * HEADER + PADDING) + its position relative to the group, shifted right by (container width - 2 * PADDING - inner
 * width) / 2 when the container was widened to its minimum width (so a narrow inner layout is centred). `groups` must
 * be ordered by depth ascending (outer groups first). A group whose container has no position is skipped (and so are the groups nested in it). Returns new
 * positions (with the inner nodes) and each placed container's box (its expanded size, see containerSize).
 */
export function placeAgentGroups(
  base: { positions: Record<string, { x: number; y: number }> },
  groups: { group: AgentGroup; layout: TurnLayout }[],
): { positions: Record<string, { x: number; y: number }>; containerBoxes: Record<string, Box> } {
  const positions = { ...base.positions };
  const containerBoxes: Record<string, Box> = {};
  for (const { group, layout } of groups) {
    const c = positions[group.containerId];
    if (!c) continue;
    const size = containerSize(layout);
    containerBoxes[group.containerId] = { x: c.x, y: c.y, ...size };
    const ox = c.x + CONTAINER_PADDING + Math.max(0, (size.width - 2 * CONTAINER_PADDING - layout.width) / 2);
    const oy = c.y + CONTAINER_HEADER + CONTAINER_PADDING;
    for (const [id, p] of Object.entries(layout.positions)) positions[id] = { x: ox + p.x, y: oy + p.y };
  }
  return { positions, containerBoxes };
}
