import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Panel,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type Edge,
  type NodeHandle,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './canvas.css';
import { TURN_HEADER } from './layout';
import { followTarget, viewportMoved } from './follow';
import { sizeOf } from './sizes';
import type { CanvasSnapshot } from './useCanvas';
import { forkSources, type TurnSummary, type ViewEdge } from './view';
import { CanvasActions, isActive, nodeColor, nodeTypes, summaryColor, type FlowNode } from './nodes';

export interface CanvasProps {
  snapshot: CanvasSnapshot;
  selectedId: string | null;
  onSelect(id: string | null): void;
  onToggleTurn(turnKey: string): void;
  onShowFullTurn(turnKey: string): void;
  /** Called with the follow state whenever it changes (and on mount). */
  onFollowingChange?(following: boolean): void;
}

const EDGE_COLOR = { sequence: '#94a3b8', fork: '#6366f1' } as const;
/** Header strip height: the turn's reserved TURN_HEADER minus a small gap above its first node. */
const HEADER_HEIGHT = TURN_HEADER - 6;
const HEADER_MIN_WIDTH = 200;
const HEADER_PREFIX = 'cc-header:';

type Pos = { x: number; y: number };
const samePos = (a: Pos, b: Pos): boolean => a.x === b.x && a.y === b.y;

function sameSummary(a: TurnSummary, b: TurnSummary): boolean {
  return a.turnKey === b.turnKey && a.promptSummary === b.promptSummary && a.nodeCount === b.nodeCount
    && a.toolCount === b.toolCount && a.failedCount === b.failedCount && a.running === b.running
    && a.startedAt === b.startedAt && a.durationMs === b.durationMs;
}

/** `next` when any element differs from `prev`, otherwise `prev` itself (so React Flow sees no change). */
function sameElements<T>(prev: T[] | null, next: T[]): T[] {
  if (prev === null || prev.length !== next.length) return next;
  for (let i = 0; i < next.length; i++) if (prev[i] !== next[i]) return next;
  return prev;
}

const NO_HANDLES: NodeHandle[] = [];
/** Top-centre target, bottom-centre source: declared up front so edges are drawn without measuring the DOM. */
const handleCache = new Map<string, NodeHandle[]>();
function handlesFor(width: number, height: number): NodeHandle[] {
  const key = `${width}x${height}`;
  let h = handleCache.get(key);
  if (!h) {
    h = [
      { type: 'target', position: Position.Top, x: width / 2 - 0.5, y: 0, width: 1, height: 1 },
      { type: 'source', position: Position.Bottom, x: width / 2 - 0.5, y: height - 1, width: 1, height: 1 },
    ];
    handleCache.set(key, h);
  }
  return h;
}

/** React Flow nodes for the snapshot; an unchanged node keeps its previous object so React Flow skips it. */
function useFlowNodes(snapshot: CanvasSnapshot, selectedId: string | null): FlowNode[] {
  const cache = useRef(new Map<string, FlowNode>());
  const last = useRef<FlowNode[] | null>(null);
  return useMemo(() => {
    const prev = cache.current;
    const next = new Map<string, FlowNode>();
    const out: FlowNode[] = [];
    const { view, positions, turnBoxes } = snapshot;

    // Headers first so they render beneath the nodes. A turn whose nodes have no position yet (an expand in flight)
    // gets no header: its box is still the old layout's.
    for (const turn of view.turns) {
      if (turn.collapsed) continue;
      const box = turnBoxes[turn.key];
      if (!box || !turn.nodeIds.some((id) => positions[id] !== undefined)) continue;
      const id = HEADER_PREFIX + turn.key;
      const position = { x: box.x, y: box.y };
      const width = Math.max(box.width, HEADER_MIN_WIDTH);
      const old = prev.get(id);
      const n: FlowNode = old && old.type === 'turnHeader' && samePos(old.position, position) && old.width === width
        && old.data.startedAt === turn.summary.startedAt && old.data.nodeCount === turn.summary.nodeCount
        ? old
        : {
          id, type: 'turnHeader', position, width, height: HEADER_HEIGHT,
          data: { turnKey: turn.key, startedAt: turn.summary.startedAt, nodeCount: turn.summary.nodeCount },
          // Declared (empty) handles: otherwise React Flow force-renders an unmeasured node even when off screen.
          handles: NO_HANDLES, selectable: false, focusable: false, draggable: false, connectable: false,
        };
      next.set(id, n);
      out.push(n);
    }

    for (const vn of view.nodes.values()) {
      const position = positions[vn.id];
      if (!position) continue;
      const { width, height } = sizeOf(vn);
      const selected = vn.id === selectedId;
      const old = prev.get(vn.id);
      let n: FlowNode;
      if (vn.type === 'node') {
        n = old && old.type === 'graphNode' && old.data.node === vn.node && old.data.innerCount === vn.innerCount
          && samePos(old.position, position) && old.selected === selected && old.width === width && old.height === height
          ? old
          : {
            id: vn.id, type: 'graphNode', position, width, height, selected,
            data: { node: vn.node, innerCount: vn.innerCount },
            handles: handlesFor(width, height), draggable: false, connectable: false,
          };
      } else if (vn.type === 'turn_summary') {
        n = old && old.type === 'turnSummary' && sameSummary(old.data.summary, vn.summary)
          && samePos(old.position, position) && old.selected === selected && old.width === width && old.height === height
          ? old
          : {
            id: vn.id, type: 'turnSummary', position, width, height, selected,
            data: { summary: vn.summary },
            handles: handlesFor(width, height), draggable: false, connectable: false,
          };
      } else {
        n = old && old.type === 'earlier' && old.data.count === vn.count && old.data.toolCount === vn.toolCount
          && old.data.failedCount === vn.failedCount && samePos(old.position, position) && old.width === width && old.height === height
          ? old
          : {
            id: vn.id, type: 'earlier', position, width, height,
            data: { turnKey: vn.turnKey, count: vn.count, toolCount: vn.toolCount, failedCount: vn.failedCount },
            handles: handlesFor(width, height), selectable: false, focusable: false, draggable: false, connectable: false,
          };
      }
      next.set(vn.id, n);
      out.push(n);
    }
    cache.current = next;
    return (last.current = sameElements(last.current, out));
  }, [snapshot, selectedId]);
}

/**
 * React Flow edges between drawn nodes. An edge out of a node with two or more outgoing edges is drawn in the fork
 * colour; an edge into a running or awaiting-permission node is animated.
 */
function useFlowEdges(snapshot: CanvasSnapshot): Edge[] {
  type Cached = { src: ViewEdge; animated: boolean; fork: boolean; edge: Edge };
  const cache = useRef(new Map<string, Cached>());
  const last = useRef<Edge[] | null>(null);
  return useMemo(() => {
    const prev = cache.current;
    const next = new Map<string, Cached>();
    const out: Edge[] = [];
    const { view, positions } = snapshot;
    const forks = forkSources(view.edges);
    for (const e of view.edges) {
      if (!positions[e.from] || !positions[e.to]) continue;
      const target = view.nodes.get(e.to);
      const animated = target?.type === 'node' && isActive(target.node.status);
      const fork = forks.has(e.from);
      const old = prev.get(e.id);
      let edge: Edge;
      if (old && old.animated === animated && old.fork === fork && old.src.from === e.from && old.src.to === e.to) {
        edge = old.edge;
      } else {
        const color = fork ? EDGE_COLOR.fork : EDGE_COLOR.sequence;
        edge = {
          id: e.id, source: e.from, target: e.to, type: 'smoothstep', animated,
          selectable: false, focusable: false,
          className: `cc-edge cc-edge-${fork ? 'fork' : 'sequence'}`,
          style: { stroke: color, strokeWidth: 1.5 },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        };
      }
      next.set(e.id, { src: e, animated, fork, edge });
      out.push(edge);
    }
    cache.current = next;
    return (last.current = sameElements(last.current, out));
  }, [snapshot]);
}

function miniMapColor(n: FlowNode): string {
  if (n.type === 'graphNode') return nodeColor(n.data.node);
  if (n.type === 'turnSummary') return summaryColor(n.data.summary);
  if (n.type === 'earlier') return '#cbd5e1';
  return 'transparent';
}

/** Share of the viewport height by which the view is centred above the latest node, leaving it below centre. */
const FOLLOW_LIFT = 0.15;
const FOLLOW_DURATION = 200;

/** Longer than FOLLOW_DURATION: clears the programmatic flag if React Flow emits no move-end event. */
const PROGRAMMATIC_TIMEOUT = FOLLOW_DURATION + 150;

/**
 * Keeps the latest node in view (slightly below centre) until the viewport changes for a reason other than our own
 * setCenter. Move events do not say who moved the viewport (Controls and MiniMap look programmatic, a plain click can
 * start a zoom gesture), so we compare the viewport against its value at move start while no follow move is running.
 */
function useFollow(snapshot: CanvasSnapshot) {
  const { setCenter, getZoom } = useReactFlow();
  const [following, setFollowing] = useState(true);
  const ready = useStore((s) => s.width > 0 && s.height > 0 && s.panZoom !== null);
  const height = useStore((s) => s.height);
  const placed = useRef(false);
  const heightRef = useRef(height);
  heightRef.current = height;
  const programmatic = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const startVp = useRef<Viewport | null>(null);
  const target = followTarget(snapshot);
  const tx = target?.x;
  const ty = target?.y;
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    // `ready` includes the zoom pane, so setCenter takes effect now.
    if (!following || !ready || tx === undefined || ty === undefined) return;
    const first = !placed.current;
    placed.current = true;
    const zoom = first ? 1 : getZoom();
    programmatic.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { programmatic.current = false; }, PROGRAMMATIC_TIMEOUT);
    void setCenter(tx, ty - (FOLLOW_LIFT * heightRef.current) / zoom, first ? { zoom } : { zoom, duration: FOLLOW_DURATION });
  }, [following, ready, tx, ty, setCenter, getZoom]);

  const check = (vp: Viewport) => {
    if (!programmatic.current && startVp.current && viewportMoved(startVp.current, vp)) setFollowing(false);
  };
  return {
    following,
    resume: () => { placed.current = true; setFollowing(true); }, // keep the user's zoom
    onMoveStart: (_: unknown, vp: Viewport) => { startVp.current = vp; },
    onMove: (_: unknown, vp: Viewport) => check(vp),
    onMoveEnd: (_: unknown, vp: Viewport) => {
      check(vp);
      programmatic.current = false;
      clearTimeout(timer.current);
    },
  };
}

function CanvasInner({ snapshot, selectedId, onSelect, onToggleTurn, onShowFullTurn, onFollowingChange }: CanvasProps) {
  const nodes = useFlowNodes(snapshot, selectedId);
  const edges = useFlowEdges(snapshot);
  const follow = useFollow(snapshot);
  const { following } = follow;
  useEffect(() => { onFollowingChange?.(following); }, [following, onFollowingChange]);

  // Stable identity for the context value; the latest callback is read through the ref.
  const toggleRef = useRef(onToggleTurn);
  toggleRef.current = onToggleTurn;
  const showFullRef = useRef(onShowFullTurn);
  showFullRef.current = onShowFullTurn;
  const actions = useMemo(() => ({
    toggleTurn: (key: string) => toggleRef.current(key),
    showFullTurn: (key: string) => showFullRef.current(key),
  }), []);

  return (
    <CanvasActions.Provider value={actions}>
      <ReactFlow<FlowNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, n) => {
          if (n.type === 'turnSummary') onToggleTurn(n.data.summary.turnKey);
          else if (n.type === 'graphNode') onSelect(n.id);
        }}
        onPaneClick={() => onSelect(null)}
        onMoveStart={follow.onMoveStart}
        onMove={follow.onMove}
        onMoveEnd={follow.onMoveEnd}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        onlyRenderVisibleElements
        minZoom={0.05}
        maxZoom={2}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#cbd5e1" />
        <Controls showInteractive={false} />
        {!follow.following && (
          <Panel position="bottom-right" className="cc-follow-panel">
            <button type="button" className="cc-follow-btn" onClick={follow.resume}>回到最新</button>
          </Panel>
        )}
        <MiniMap<FlowNode> nodeColor={miniMapColor} nodeStrokeWidth={0} pannable zoomable />
      </ReactFlow>
    </CanvasActions.Provider>
  );
}

export function Canvas(props: CanvasProps) {
  return (
    <div className="cc-canvas">
      <ReactFlowProvider>
        <CanvasInner {...props} />
      </ReactFlowProvider>
    </div>
  );
}
