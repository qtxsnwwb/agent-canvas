import { useEffect, useMemo, useRef } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type Edge,
  type NodeHandle,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './canvas.css';
import { TURN_HEADER } from './layout';
import { sizeOf } from './sizes';
import type { CanvasSnapshot } from './useCanvas';
import type { TurnSummary, ViewEdge } from './view';
import { CanvasActions, nodeColor, nodeTypes, summaryColor, type FlowNode } from './nodes';

export interface CanvasProps {
  snapshot: CanvasSnapshot;
  selectedId: string | null;
  onSelect(id: string | null): void;
  onToggleTurn(turnKey: string): void;
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
  return useMemo(() => {
    const prev = cache.current;
    const next = new Map<string, FlowNode>();
    const out: FlowNode[] = [];
    const { view, positions, turnBoxes } = snapshot;

    // Headers first so they render beneath the nodes.
    for (const turn of view.turns) {
      if (turn.collapsed) continue;
      const box = turnBoxes[turn.key];
      if (!box) continue;
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
      } else {
        n = old && old.type === 'turnSummary' && sameSummary(old.data.summary, vn.summary)
          && samePos(old.position, position) && old.selected === selected && old.width === width && old.height === height
          ? old
          : {
            id: vn.id, type: 'turnSummary', position, width, height, selected,
            data: { summary: vn.summary },
            handles: handlesFor(width, height), draggable: false, connectable: false,
          };
      }
      next.set(vn.id, n);
      out.push(n);
    }
    cache.current = next;
    return out;
  }, [snapshot, selectedId]);
}

/** React Flow edges between drawn nodes; an edge into a running node is animated. */
function useFlowEdges(snapshot: CanvasSnapshot): Edge[] {
  const cache = useRef(new Map<string, { src: ViewEdge; animated: boolean; edge: Edge }>());
  return useMemo(() => {
    const prev = cache.current;
    const next = new Map<string, { src: ViewEdge; animated: boolean; edge: Edge }>();
    const out: Edge[] = [];
    const { view, positions } = snapshot;
    for (const e of view.edges) {
      if (!positions[e.from] || !positions[e.to]) continue;
      const target = view.nodes.get(e.to);
      const animated = target?.type === 'node' && target.node.status === 'running';
      const old = prev.get(e.id);
      let edge: Edge;
      if (old && old.animated === animated && old.src.from === e.from && old.src.to === e.to && old.src.kind === e.kind) {
        edge = old.edge;
      } else {
        const color = e.kind === 'fork' ? EDGE_COLOR.fork : EDGE_COLOR.sequence;
        edge = {
          id: e.id, source: e.from, target: e.to, type: 'smoothstep', animated,
          selectable: false, focusable: false,
          className: `cc-edge cc-edge-${e.kind}`,
          style: { stroke: color, strokeWidth: 1.5 },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        };
      }
      next.set(e.id, { src: e, animated, edge });
      out.push(edge);
    }
    cache.current = next;
    return out;
  }, [snapshot]);
}

function miniMapColor(n: FlowNode): string {
  if (n.type === 'graphNode') return nodeColor(n.data.node);
  if (n.type === 'turnSummary') return summaryColor(n.data.summary);
  return 'transparent';
}

/**
 * Centres on the latest node at zoom 1 once its position first arrives, so the page is not blank on open.
 * (Placeholder: Task 5 replaces this with follow logic.)
 */
function useInitialCentre(snapshot: CanvasSnapshot): void {
  const { setCenter } = useReactFlow();
  const ready = useStore((s) => s.width > 0 && s.height > 0 && s.panZoom !== null);
  const done = useRef(false);
  const id = snapshot.view.latestNodeId;
  const pos = id !== null ? snapshot.positions[id] : undefined;
  const vn = id !== null ? snapshot.view.nodes.get(id) : undefined;
  useEffect(() => {
    // `ready` includes the zoom pane, so setCenter takes effect now.
    if (done.current || !ready || !pos || !vn) return;
    done.current = true;
    const { width, height } = sizeOf(vn);
    void setCenter(pos.x + width / 2, pos.y + height / 2, { zoom: 1 });
  }, [ready, pos, vn, setCenter]);
}

function CanvasInner({ snapshot, selectedId, onSelect, onToggleTurn }: CanvasProps) {
  const nodes = useFlowNodes(snapshot, selectedId);
  const edges = useFlowEdges(snapshot);
  useInitialCentre(snapshot);

  // Stable identity for the context value; the latest callback is read through the ref.
  const toggleRef = useRef(onToggleTurn);
  toggleRef.current = onToggleTurn;
  const actions = useMemo(() => ({ toggleTurn: (key: string) => toggleRef.current(key) }), []);

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
