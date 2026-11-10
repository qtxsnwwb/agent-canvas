import { CONTAINER_HEADER, CONTAINER_PADDING, containerSize, sizeOf } from './sizes';
import type { AgentGroup, CanvasView, TurnView } from './view';

export interface Box { x: number; y: number; width: number; height: number }
export interface TurnLayoutInput { key: string; nodes: { id: string; width: number; height: number }[]; edges: { id: string; from: string; to: string }[] }
/**
 * Positions are relative to the turn's top-left corner. `anchorX` is the horizontal centre of the turn's first input
 * node, relative to the same corner: turns are stacked so that their anchors line up (a straight spine).
 */
export interface TurnLayout { key: string; width: number; height: number; anchorX: number; positions: Record<string, { x: number; y: number }> }
export interface ElkLike { layout(graph: unknown): Promise<unknown> }

/** Vertical gap between adjacent turns. */
export const TURN_GAP = 56;
/** Height reserved at the top of each turn for its title. */
export const TURN_HEADER = 28;

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

export async function layoutTurn(elk: ElkLike, input: TurnLayoutInput): Promise<TurnLayout> {
  if (input.nodes.length === 1) {
    const only = input.nodes[0]!;
    return { key: input.key, width: only.width, height: only.height, anchorX: only.width / 2, positions: { [only.id]: { x: 0, y: 0 } } };
  }
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
  return { key: input.key, width: out.width ?? 0, height: out.height ?? 0, anchorX, positions };
}

/**
 * Stack turns top to bottom in the given order, each placed so that its anchor (first node's centre) is at x = 0. A
 * layout with no positions (a turn with nothing to draw) takes no space and gets no box.
 */
export function stackTurns(layouts: TurnLayout[]): { positions: Record<string, { x: number; y: number }>; turnBoxes: Record<string, Box> } {
  const positions: Record<string, { x: number; y: number }> = {};
  const turnBoxes: Record<string, Box> = {};
  let y = 0;
  for (const l of layouts) {
    if (Object.keys(l.positions).length === 0) continue;
    const x = -l.anchorX;
    turnBoxes[l.key] = { x, y, width: l.width, height: TURN_HEADER + l.height };
    for (const [id, p] of Object.entries(l.positions)) positions[id] = { x: x + p.x, y: y + TURN_HEADER + p.y };
    y += TURN_HEADER + l.height + TURN_GAP;
  }
  return { positions, turnBoxes };
}

/**
 * Places agent groups on top of the stackTurns result: inner node position = container position + (PADDING,
 * HEADER + PADDING) + its position relative to the group. `groups` must be ordered by depth ascending (outer groups
 * first). A group whose container has no position is skipped (and so are the groups nested in it). Returns new
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
    containerBoxes[group.containerId] = { x: c.x, y: c.y, ...containerSize(layout) };
    const ox = c.x + CONTAINER_PADDING;
    const oy = c.y + CONTAINER_HEADER + CONTAINER_PADDING;
    for (const [id, p] of Object.entries(layout.positions)) positions[id] = { x: ox + p.x, y: oy + p.y };
  }
  return { positions, containerBoxes };
}
