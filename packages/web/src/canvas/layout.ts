import { sizeOf } from './sizes';
import type { CanvasView, TurnView } from './view';

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

/** Layout input for one turn: nodes in TurnView.nodeIds order; only edges with both ends among the emitted nodes. */
export function turnInput(view: CanvasView, turn: TurnView): TurnLayoutInput {
  const ids = new Set<string>();
  const nodes: TurnLayoutInput['nodes'] = [];
  for (const id of turn.nodeIds) {
    const vn = view.nodes.get(id);
    if (vn) {
      nodes.push({ id, ...sizeOf(vn) });
      ids.add(id);
    }
  }
  const edges = view.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => ({ id: e.id, from: e.from, to: e.to }));
  return { key: turn.key, nodes, edges };
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

/** Stack turns top to bottom in the given order, each placed so that its anchor (first node's centre) is at x = 0. */
export function stackTurns(layouts: TurnLayout[]): { positions: Record<string, { x: number; y: number }>; turnBoxes: Record<string, Box> } {
  const positions: Record<string, { x: number; y: number }> = {};
  const turnBoxes: Record<string, Box> = {};
  let y = 0;
  for (const l of layouts) {
    const x = -l.anchorX;
    turnBoxes[l.key] = { x, y, width: l.width, height: TURN_HEADER + l.height };
    for (const [id, p] of Object.entries(l.positions)) positions[id] = { x: x + p.x, y: y + TURN_HEADER + p.y };
    y += TURN_HEADER + l.height + TURN_GAP;
  }
  return { positions, turnBoxes };
}
