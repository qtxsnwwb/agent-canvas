import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
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
import { followTarget, resumeZoom, viewportMoved } from './follow';
import { sizeOf } from './sizes';
import { edgeZ, groupDepths, nodeZ } from './stacking';
import type { CanvasSnapshot } from './useCanvas';
import { forkSources, type CanvasView, type TurnSummary, type ViewEdge } from './view';
import type { UpstreamChain } from './chain';
import { chainAriaLabel, isActivationKey } from './format';
import {
  CanvasActions, graphNodeAriaLabel, highlightClass, isActive, nodeColor, nodeTypes, summaryAriaLabel, summaryColor,
  type FlowNode, type Highlight,
} from './nodes';

export interface CanvasProps {
  snapshot: CanvasSnapshot;
  selectedId: string | null;
  /**
   * upstreamChain(snapshot.view, selectedId), or EMPTY_CHAIN; highlighted in the causal view only. Pass a memoized
   * value: a new object rebuilds the comparison for every node and edge.
   */
  chain: UpstreamChain;
  onSelect(id: string | null): void;
  onToggleTurn(turnKey: string): void;
  onShowFullTurn(turnKey: string): void;
  /** Expands a subagent (by its childAgentId) into a container of its inner nodes, or collapses it again. */
  onToggleAgent(agentId: string): void;
  /** Called with the follow state whenever it changes (and on mount). */
  onFollowingChange?(following: boolean): void;
}

const EDGE_COLOR = { sequence: '#94a3b8', fork: '#6366f1' } as const;
/** Edges on the selection's upstream chain (causal view); the nodes get the same colour as an outline (canvas.css). */
const CHAIN_COLOR = '#f59e0b';
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
const CONTAINER_STYLE: CSSProperties = { pointerEvents: 'none' };
/** Top-centre target, bottom-centre source: declared up front so edges are drawn without measuring the DOM. */
function makeHandles(width: number, height: number): NodeHandle[] {
  return [
    { type: 'target', position: Position.Top, x: width / 2 - 0.5, y: 0, width: 1, height: 1 },
    { type: 'source', position: Position.Bottom, x: width / 2 - 0.5, y: height - 1, width: 1, height: 1 },
  ];
}
/**
 * Shared handle arrays for the fixed node sizes (a handful of keys, see sizeOf). Containers have a size per layout and
 * get their own array (computed inline, never cached), so the cache cannot grow without bound.
 */
const handleCache = new Map<string, NodeHandle[]>();
function handlesFor(width: number, height: number): NodeHandle[] {
  const key = `${width}x${height}`;
  let h = handleCache.get(key);
  if (!h) handleCache.set(key, (h = makeHandles(width, height)));
  return h;
}

/** Chain highlighting is on in the causal view while a node is selected (the chain then holds at least that node). */
function chainActive(view: CanvasView, chain: UpstreamChain): boolean {
  return view.mode === 'causal' && chain.nodeIds.size > 0;
}
/** The node wrapper's className: the container class (if any) and the highlight class. */
function wrapperClass(container: boolean, highlight: Highlight): string | undefined {
  const s = [container ? 'cc-container-node' : '', highlightClass(highlight)].filter(Boolean).join(' ');
  return s === '' ? undefined : s;
}

/**
 * React Flow nodes for the snapshot; an unchanged node keeps its previous object so React Flow skips it. The highlight
 * state is part of the comparison, so a selection change only replaces the nodes whose state changed.
 */
function useFlowNodes(snapshot: CanvasSnapshot, selectedId: string | null, chain: UpstreamChain): FlowNode[] {
  const cache = useRef(new Map<string, FlowNode>());
  const last = useRef<FlowNode[] | null>(null);
  return useMemo(() => {
    const prev = cache.current;
    const next = new Map<string, FlowNode>();
    const out: FlowNode[] = [];
    const { view, positions, turnBoxes, containerBoxes, layoutMode } = snapshot;
    const active = chainActive(view, chain);
    const highlightOf = (id: string): Highlight => (!active ? 'none' : chain.nodeIds.has(id) ? 'chain' : 'dim');
    const headerHighlight: Highlight = active ? 'dim' : 'none';

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
        && old.data.highlight === headerHighlight
        ? old
        : {
          id, type: 'turnHeader', position, width, height: HEADER_HEIGHT, className: wrapperClass(false, headerHighlight),
          data: { turnKey: turn.key, startedAt: turn.summary.startedAt, nodeCount: turn.summary.nodeCount, highlight: headerHighlight },
          // Declared (empty) handles: otherwise React Flow force-renders an unmeasured node even when off screen.
          handles: NO_HANDLES, selectable: false, focusable: false, draggable: false, connectable: false,
        };
      next.set(id, n);
      out.push(n);
    }

    const depths = groupDepths(view);
    // Agents can be expanded and collapsed in every view except topology (which shows every subagent collapsed).
    const canExpand = view.mode !== 'topology';
    // Sizes (and the two-row causal thinking node) follow the mode the positions were laid out for, so a mode switch
    // never draws new sizes on old positions; both switch together when the new mode's round lands.
    const causal = layoutMode === 'causal';
    for (const vn of view.nodes.values()) {
      const position = positions[vn.id];
      if (!position) continue;
      // An expanded agent is drawn as a container once its box has landed; until then it keeps the collapsed size.
      const box = vn.type === 'node' && vn.expanded ? containerBoxes[vn.id] : undefined;
      const { width, height } = box ?? sizeOf(vn, layoutMode);
      const zIndex = nodeZ(depths, vn);
      const selected = vn.id === selectedId;
      const highlight = highlightOf(vn.id);
      const old = prev.get(vn.id);
      let n: FlowNode;
      if (vn.type === 'node') {
        const container = box !== undefined;
        const expandable = canExpand && vn.expandable;
        const d = old?.type === 'graphNode' ? old.data : undefined;
        n = old && d && d.node === vn.node && d.innerCount === vn.innerCount && d.expanded === vn.expanded
          && d.expandable === expandable && d.container === container && d.causal === causal && d.highlight === highlight
          && old.zIndex === zIndex
          && samePos(old.position, position) && old.selected === selected && old.width === width && old.height === height
          ? old
          : {
            id: vn.id, type: 'graphNode', position, width, height, selected, zIndex,
            ariaLabel: chainAriaLabel(graphNodeAriaLabel(vn.node, container), highlight === 'chain'),
            // The wrapper of a container lets clicks on its body through to the pane; its head opts back in (see
            // canvas.css). Inline, because React Flow sets `pointer-events: all` inline on the wrapper and spreads
            // node.style after it.
            className: wrapperClass(container, highlight),
            style: container ? CONTAINER_STYLE : undefined,
            data: { node: vn.node, innerCount: vn.innerCount, expanded: vn.expanded, expandable, container, causal, highlight },
            handles: container ? makeHandles(width, height) : handlesFor(width, height), draggable: false, connectable: false,
          };
      } else if (vn.type === 'turn_summary') {
        n = old && old.type === 'turnSummary' && sameSummary(old.data.summary, vn.summary) && old.data.highlight === highlight
          && old.zIndex === zIndex
          && samePos(old.position, position) && old.selected === selected && old.width === width && old.height === height
          ? old
          : {
            id: vn.id, type: 'turnSummary', position, width, height, selected, zIndex,
            ariaLabel: chainAriaLabel(summaryAriaLabel(vn.summary), highlight === 'chain'),
            className: wrapperClass(false, highlight),
            data: { summary: vn.summary, highlight },
            handles: handlesFor(width, height), draggable: false, connectable: false,
          };
      } else {
        // An agent group's `earlier` node sits inside its container: it needs the group's zIndex.
        n = old && old.type === 'earlier' && old.data.count === vn.count && old.data.toolCount === vn.toolCount
          && old.data.failedCount === vn.failedCount && old.data.highlight === highlight && old.zIndex === zIndex
          && samePos(old.position, position) && old.width === width && old.height === height
          ? old
          : {
            id: vn.id, type: 'earlier', position, width, height, zIndex, className: wrapperClass(false, highlight),
            data: {
              turnKey: vn.turnKey, groupKey: vn.groupKey, count: vn.count, toolCount: vn.toolCount, failedCount: vn.failedCount,
              highlight,
            },
            handles: handlesFor(width, height), selectable: false, focusable: false, draggable: false, connectable: false,
          };
      }
      next.set(vn.id, n);
      out.push(n);
    }
    cache.current = next;
    return (last.current = sameElements(last.current, out));
  }, [snapshot, selectedId, chain]);
}

/**
 * React Flow edges between drawn nodes. An edge out of a node with two or more outgoing edges is drawn in the fork
 * colour; an edge into a running or awaiting-permission node is animated.
 */
function useFlowEdges(snapshot: CanvasSnapshot, chain: UpstreamChain): Edge[] {
  type Cached = { src: ViewEdge; animated: boolean; fork: boolean; zIndex: number; highlight: Highlight; edge: Edge };
  const cache = useRef(new Map<string, Cached>());
  const last = useRef<Edge[] | null>(null);
  return useMemo(() => {
    const prev = cache.current;
    const next = new Map<string, Cached>();
    const out: Edge[] = [];
    const { view, positions } = snapshot;
    const forks = forkSources(view.edges, (id) => view.nodes.get(id)?.type === 'earlier');
    const depths = groupDepths(view);
    const active = chainActive(view, chain);
    for (const e of view.edges) {
      if (!positions[e.from] || !positions[e.to]) continue;
      const target = view.nodes.get(e.to);
      const animated = target?.type === 'node' && isActive(target.node.status);
      const fork = forks.has(e.from);
      const highlight: Highlight = !active ? 'none' : chain.edgeIds.has(e.id) ? 'chain' : 'dim';
      // Inside a container: above its background, below the nodes of the same group; chain edges above dimmed ones.
      const zIndex = edgeZ(view, depths, e, highlight === 'chain');
      const old = prev.get(e.id);
      let edge: Edge;
      if (old && old.animated === animated && old.fork === fork && old.zIndex === zIndex && old.highlight === highlight
        && old.src.from === e.from && old.src.to === e.to) {
        edge = old.edge;
      } else {
        const onChain = highlight === 'chain';
        const color = onChain ? CHAIN_COLOR : fork ? EDGE_COLOR.fork : EDGE_COLOR.sequence;
        const hl = highlightClass(highlight);
        edge = {
          id: e.id, source: e.from, target: e.to, type: 'smoothstep', animated, zIndex,
          selectable: false, focusable: false,
          className: `cc-edge cc-edge-${fork ? 'fork' : 'sequence'}${hl !== '' ? ` ${hl}` : ''}`,
          style: { stroke: color, strokeWidth: onChain ? 2.5 : 1.5 },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        };
      }
      next.set(e.id, { src: e, animated, fork, zIndex, highlight, edge });
      out.push(edge);
    }
    cache.current = next;
    return (last.current = sameElements(last.current, out));
  }, [snapshot, chain]);
}

function miniMapColor(n: FlowNode): string {
  if (n.type === 'graphNode') return nodeColor(n.data.node);
  if (n.type === 'turnSummary') return summaryColor(n.data.summary);
  if (n.type === 'earlier') return '#cbd5e1';
  return 'transparent';
}
/** Containers are drawn see-through in the minimap so their inner nodes stay visible (see canvas.css). */
function miniMapClass(n: FlowNode): string {
  return n.type === 'graphNode' && n.data.container ? 'cc-minimap-container' : '';
}

/** Share of the viewport height by which the view is centred above the latest node, leaving it below centre. */
const FOLLOW_LIFT = 0.15;
const FOLLOW_DURATION = 200;

/** Longer than FOLLOW_DURATION: clears the programmatic flag if React Flow emits no move-end event. */
const PROGRAMMATIC_TIMEOUT = FOLLOW_DURATION + 150;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

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
  /** Zoom for the first follow move after "回到最新" (see resumeZoom); null otherwise. */
  const nextZoom = useRef<number | null>(null);
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
    const zoom = first ? 1 : nextZoom.current ?? getZoom();
    nextZoom.current = null;
    const duration = first || prefersReducedMotion() ? 0 : FOLLOW_DURATION;
    programmatic.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { programmatic.current = false; }, PROGRAMMATIC_TIMEOUT);
    void setCenter(tx, ty - (FOLLOW_LIFT * heightRef.current) / zoom, duration > 0 ? { zoom, duration } : { zoom });
  }, [following, ready, tx, ty, setCenter, getZoom]);

  const stop = useCallback(() => setFollowing(false), []);
  const check = (vp: Viewport) => {
    if (!programmatic.current && startVp.current && viewportMoved(startVp.current, vp)) setFollowing(false);
  };
  return {
    following,
    resume: () => {
      placed.current = true;
      nextZoom.current = resumeZoom(getZoom()); // keep the user's zoom unless it is too small to read
      setFollowing(true);
    },
    /** A UI action changed the layout (turn toggle, "展开全部"): stop following so the opened content stays put. */
    stop,
    onMoveStart: (_: unknown, vp: Viewport) => { startVp.current = vp; },
    onMove: (_: unknown, vp: Viewport) => check(vp),
    onMoveEnd: (_: unknown, vp: Viewport) => {
      check(vp);
      programmatic.current = false;
      clearTimeout(timer.current);
    },
  };
}

/** How long a keyboard expand keeps waiting for its turn header to appear before giving up. */
const HEADER_FOCUS_WAIT_MS = 3_000;
const HEADER_FOCUS_POLL_MS = 50;

/**
 * After a keyboard expand the focused element (a summary node or its button) goes away; move focus to the turn
 * header's "折叠" button once React Flow has rendered it, so focus does not fall back to the page body. Best effort.
 */
function useHeaderFocus(): (turnKey: string) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return useCallback((turnKey: string) => {
    clearTimeout(timer.current);
    const until = Date.now() + HEADER_FOCUS_WAIT_MS;
    const selector = `.react-flow__node[data-id="${CSS.escape(HEADER_PREFIX + turnKey)}"] .cc-fold`;
    const attempt = (): void => {
      const button = document.querySelector<HTMLButtonElement>(selector);
      if (button) button.focus({ preventScroll: true });
      else if (Date.now() < until) timer.current = setTimeout(attempt, HEADER_FOCUS_POLL_MS);
    };
    timer.current = setTimeout(attempt, 0);
  }, []);
}

function CanvasInner({ snapshot, selectedId, chain, onSelect, onToggleTurn, onShowFullTurn, onToggleAgent, onFollowingChange }: CanvasProps) {
  const nodes = useFlowNodes(snapshot, selectedId, chain);
  const edges = useFlowEdges(snapshot, chain);
  const follow = useFollow(snapshot);
  const { following } = follow;
  useEffect(() => { onFollowingChange?.(following); }, [following, onFollowingChange]);

  // A view switch (live / topology / causal) resumes following, as "回到最新" does, unless a node is selected (the
  // reader is looking at it).
  const mode = snapshot.view.mode;
  const lastMode = useRef(mode);
  const resumeRef = useRef(follow.resume);
  resumeRef.current = follow.resume;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  useEffect(() => {
    if (lastMode.current === mode) return;
    lastMode.current = mode;
    // While following, the new view's latest node is followed anyway.
    if (!following && selectedRef.current === null) resumeRef.current();
  }, [mode, following]);

  // Stable identity for the context value; the latest callback is read through the ref.
  const toggleRef = useRef(onToggleTurn);
  toggleRef.current = onToggleTurn;
  const showFullRef = useRef(onShowFullTurn);
  showFullRef.current = onShowFullTurn;
  const toggleAgentRef = useRef(onToggleAgent);
  toggleAgentRef.current = onToggleAgent;
  const followChangeRef = useRef(onFollowingChange);
  followChangeRef.current = onFollowingChange;
  const focusHeader = useHeaderFocus();
  const stopFollowing = follow.stop;
  // A UI layout change stops following; auto-fold is switched off right away (not only through the follow effect
  // after the next render), so the rebuild this action triggers already keeps everything expanded in place.
  const actions = useMemo(() => {
    const stop = (): void => {
      stopFollowing();
      followChangeRef.current?.(false);
    };
    const before = (key: string, fromKeyboard?: boolean): void => {
      stop();
      if (fromKeyboard) focusHeader(key);
    };
    return {
      stopFollowing: stop,
      toggleTurn: (key: string, fromKeyboard?: boolean) => { before(key, fromKeyboard); toggleRef.current(key); },
      showFullTurn: (key: string, fromKeyboard?: boolean) => { before(key, fromKeyboard); showFullRef.current(key); },
      // The subagent node (and its button, which keeps the focus) stays in place, so no focus handling is needed.
      toggleAgent: (agentId: string) => { stop(); toggleAgentRef.current(agentId); },
    };
  }, [stopFollowing, focusHeader]);

  // A selection in the causal view stops following (and so auto-fold): its upstream chain must not be folded away
  // under the reader by later updates.
  const causalSelection = mode === 'causal' && selectedId !== null;
  useEffect(() => {
    if (causalSelection) actions.stopFollowing();
  }, [causalSelection, actions]);

  // Enter / Space on a focused node. React Flow's own key handler on the node wrapper only updates its internal
  // selection and never calls onNodeClick; the wrapper (not our node component) holds the focus, so the key is
  // handled here as it bubbles out of the wrapper. Stopping it keeps Space from also arming React Flow's pan key.
  const viewRef = useRef(snapshot.view);
  viewRef.current = snapshot.view;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (!isActivationKey(e.key)) return;
    const el = e.target as HTMLElement;
    if (!el.classList.contains('react-flow__node')) return; // a button inside a node handles its own keys
    const vn = el.dataset.id !== undefined ? viewRef.current.nodes.get(el.dataset.id) : undefined;
    if (!vn || vn.type === 'earlier') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    if (vn.type === 'node') onSelectRef.current(vn.id);
    else actions.toggleTurn(vn.turnKey, true);
  }, [actions]);
  const onNodeClick = useCallback((_: unknown, n: FlowNode) => {
    if (n.type === 'turnSummary') actions.toggleTurn(n.data.summary.turnKey);
    else if (n.type === 'graphNode') onSelectRef.current(n.id);
  }, [actions]);
  const onPaneClick = useCallback(() => onSelectRef.current(null), []);

  return (
    <CanvasActions.Provider value={actions}>
      <ReactFlow<FlowNode, Edge>
        onKeyDown={onKeyDown}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onMoveStart={follow.onMoveStart}
        onMove={follow.onMove}
        onMoveEnd={follow.onMoveEnd}
        // zIndex values are used as given (see stacking.ts): no elevation of selected nodes, which would lift a
        // selected container above its own inner nodes.
        zIndexMode="manual"
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
        <MiniMap<FlowNode> nodeColor={miniMapColor} nodeClassName={miniMapClass} nodeStrokeWidth={0} pannable zoomable />
      </ReactFlow>
    </CanvasActions.Provider>
  );
}

/** Memoized: re-renders only when the snapshot, the selection or a handler changes (pass stable handlers). */
export const Canvas = memo(function Canvas(props: CanvasProps) {
  return (
    <div className="cc-canvas">
      <ReactFlowProvider>
        <CanvasInner {...props} />
      </ReactFlowProvider>
    </div>
  );
});
