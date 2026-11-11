import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { openLiveSession, type LiveSession } from '../client';
import { Canvas } from '../canvas/Canvas';
import { EMPTY_CHAIN, expandCut, upstreamChain } from '../canvas/chain';
import { isRunId } from '../canvas/compact';
import { Drawer } from '../canvas/Drawer';
import { Timeline } from '../canvas/Timeline';
import { useCanvas } from '../canvas/useCanvas';
import type { ViewMode } from '../canvas/view';
import { Waterfall } from '../canvas/WaterfallPanel';
import { reasoningRow, type ReasoningRow } from '../canvas/reasoning';
import { scopeOf, stepChain, type WaterfallScope } from '../canvas/waterfall';
import { sessionStatusView } from '../labels';
import { sessionLoadState } from '../sessionLoad';
import { useNow } from '../useNow';

function hasKeys(obj: object): boolean {
  for (const _ in obj) return true;
  return false;
}

const VIEW_MODES: { mode: ViewMode; label: string; title: string }[] = [
  { mode: 'outline', label: '概览', title: '画布只画轮次和子代理；点一个看它的执行过程（瀑布图）' },
  { mode: 'live', label: '逐步', title: '每一步都画成画布节点' },
  { mode: 'topology', label: '拓扑', title: '只画提示、工具调用和子代理' },
  { mode: 'causal', label: '因果', title: '选中一步，高亮它之前的推理链' },
  { mode: 'replay', label: '复盘', title: '按时间轴回放' },
];

/** Segmented live / topology / causal / replay switch; the mode itself lives in the canvas model. */
/** Disabled until the model exists (before that a click would be dropped). */
function ViewSwitch({ mode, disabled, onChange }: { mode: ViewMode; disabled: boolean; onChange(mode: ViewMode): void }) {
  return (
    <div className="view-switch" role="group" aria-label="视角">
      {VIEW_MODES.map((m) => (
        <button key={m.mode} type="button" aria-pressed={mode === m.mode} disabled={disabled} title={m.title}
          onClick={() => onChange(m.mode)}>
          {m.label}
        </button>
      ))}
    </div>
  );
}

/** "精简" leaves out empty thinking and system nodes and merges repeated tool calls; "完整" draws every node. */
function DensitySwitch({ compact, disabled, onChange }: { compact: boolean; disabled: boolean; onChange(compact: boolean): void }) {
  return (
    <div className="view-switch" role="group" aria-label="节点密度">
      <button type="button" aria-pressed={compact} disabled={disabled} onClick={() => onChange(true)}
        title="不画没有内容的思考节点和系统节点，连续的同类工具调用合并成一个节点">精简</button>
      <button type="button" aria-pressed={!compact} disabled={disabled} onClick={() => onChange(false)}
        title="每条记录都画成一个节点">完整</button>
    </div>
  );
}

/**
 * Memoized on `live` and the info bar's slot for the view switch, so the info bar's per-second and per-update
 * re-renders do not reach React Flow; it re-renders when the canvas snapshot or the selection changes. Every handler
 * passed to Canvas is stable.
 */
const SessionCanvas = memo(function SessionCanvas({ live, toolbar }: { live: LiveSession; toolbar: HTMLElement | null }) {
  const canvas = useCanvas(live);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Drop a selection whose node is no longer in the view (its turn was folded, it went into an "earlier" node, a
  // resync removed it): hidden at once, and cleared so the drawer cannot reopen by itself when the node comes back.
  const selected = selectedId !== null && canvas.view.nodes.has(selectedId) ? selectedId : null;
  useEffect(() => {
    if (selectedId !== null && selected === null) setSelectedId(null);
  }, [selectedId, selected]);
  // The selected node is never folded away by later updates (see CanvasModel.setKeepVisible).
  const { setKeepVisible } = canvas;
  useEffect(() => { setKeepVisible(selected); }, [selected, setKeepVisible]);
  // Only graph nodes open the drawer; a vanished node (or a turn summary) leaves selectedNode null and closes it.
  const selectedView = selected !== null ? canvas.view.nodes.get(selected) : undefined;
  // The replay view draws nodes as they were at the replay time; the drawer shows the node's current content.
  const replaying = canvas.view.mode === 'replay';
  // Outline view: the canvas selection picks what the waterfall panel lists; a row of the panel opens the drawer.
  const outline = canvas.view.mode === 'outline';
  const [panelClosed, setPanelClosed] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  useEffect(() => { setDetailId(null); }, [outline, selected]);
  const graphNow = live.getGraph();
  const selectedNode = outline
    ? (detailId !== null ? graphNow.nodes[detailId] ?? null : null)
    : selectedView?.type === 'node'
      ? (replaying ? graphNow.nodes[selectedView.id] : undefined) ?? selectedView.node
      : null;
  const closeDrawer = useCallback(() => {
    setDetailId(null);
    setSelectedId((id) => (outlineRef.current ? id : null));
  }, []);
  const outlineRef = useRef(outline);
  outlineRef.current = outline;
  // With nothing selected the panel follows the latest turn (until it is closed).
  const explicitScope = outline ? scopeOf(selectedView) : null;
  const latestTurn = canvas.view.turns[canvas.view.turns.length - 1];
  const scope: WaterfallScope | null = !outline || panelClosed
    ? null
    : explicitScope ?? (selected === null && latestTurn !== undefined ? { type: 'turn', turnKey: latestTurn.key } : null);
  const scopeNodeId = scope === null ? null : explicitScope !== null ? selected : `turn:${latestTurn!.key}`;
  const scopeView = scopeNodeId !== null ? canvas.view.nodes.get(scopeNodeId) : undefined;
  const scopeTitle = scopeView?.type === 'turn_summary'
    ? scopeView.summary.promptSummary || '（无提示）'
    : scopeView?.type === 'node' ? [scopeView.node.title, scopeView.node.summary].filter(Boolean).join(' · ') : '';
  const closePanel = useCallback(() => {
    setPanelClosed(true);
    setSelectedId(null);
  }, []);
  const openAgent = useCallback((dispatchNodeId: string) => setSelectedId(dispatchNodeId), []);
  // Outline view: the steps that led to the open step, highlighted in the waterfall and listed in the drawer ("精简"
  // leaves out thinking steps whose content was not recorded).
  const steps = useMemo(() => (outline && detailId !== null ? stepChain(graphNow, detailId) : null), [outline, graphNow, detailId]);
  const compactNow = canvas.compact;
  const stepReasoning = useMemo(() => {
    if (steps === null) return undefined;
    const rows: ReasoningRow[] = [];
    for (const n of steps.reasoning) {
      const row = reasoningRow(n, detailId);
      if (row !== null && !(compactNow && row.missing && !row.current)) rows.push({ ...row, direct: steps.direct.has(n.id) });
    }
    return rows;
  }, [steps, detailId, compactNow]);
  const [stopFollowingSignal, setStopFollowingSignal] = useState(0);
  // A run node has no content of its own: selecting it shows its calls instead (and, like any expand, stops following).
  const { expandRun } = canvas;
  const select = useCallback((id: string | null) => {
    if (id !== null && isRunId(id)) {
      setStopFollowingSignal((n) => n + 1);
      expandRun(id);
    } else {
      if (id !== null) setPanelClosed(false);
      setSelectedId(id);
    }
  }, [expandRun]);
  // Causal view: the selection's upstream chain, once per (view, selection); highlighted on the canvas and listed in
  // the drawer. EMPTY_CHAIN in the other views and without a selected graph node.
  const view = canvas.view;
  const chainStart = view.mode === 'causal' && selectedNode !== null ? selectedNode.id : null;
  const chain = useMemo(() => (chainStart !== null ? upstreamChain(view, chainStart) : EMPTY_CHAIN), [view, chainStart]);
  // The drawer's "展开" under a chain cut short by a fold: show the `earlier` folds in full, expand the collapsed turns
  // (in full too, so one click reveals the upstream instead of running into the long-turn fold). Like a canvas button
  // it stops following; auto-fold goes off first, so the rebuilds below already keep everything in place.
  const { showFullTurn, expandTurn, setAutoFold } = canvas;
  const expandChainCut = useCallback(() => {
    const { fullTurns, turns } = expandCut(view, chain.cutAt);
    setAutoFold(false);
    setStopFollowingSignal((n) => n + 1);
    for (const key of fullTurns) showFullTurn(key);
    for (const key of turns) {
      expandTurn(key);
      showFullTurn(key);
    }
  }, [view, chain, showFullTurn, expandTurn, setAutoFold]);
  // "暂无节点" only when the live graph really has no nodes; "布局中…" while the model is starting or the view has
  // nodes none of which is placed yet.
  const empty = !hasKeys(live.getGraph().nodes);
  const laying = !empty && canvas.layoutError === null
    && (!canvas.ready || (canvas.view.nodes.size > 0 && !hasKeys(canvas.positions)));
  return (
    <>
      {toolbar !== null && createPortal(
        <>
          <DensitySwitch compact={canvas.compact} disabled={!canvas.ready} onChange={canvas.setCompact} />
          <ViewSwitch mode={canvas.view.mode} disabled={!canvas.ready} onChange={canvas.setMode} />
        </>,
        toolbar,
      )}
      {canvas.layoutError !== null && <div className="canvas-error">布局失败，正在自动重试：{canvas.layoutError}</div>}
      <div className={`canvas-area${selectedNode !== null ? ' cc-drawer-open' : ''}${canvas.replay !== null ? ' cc-replay' : ''}${scope !== null ? ' cc-waterfall-open' : ''}`}>
        <Canvas
          snapshot={canvas}
          selectedId={outline ? scopeNodeId : selected}
          chain={chain}
          onSelect={select}
          onToggleTurn={canvas.toggleTurn}
          onShowFullTurn={canvas.showFullTurn}
          onToggleAgent={canvas.toggleAgent}
          onFollowingChange={canvas.setAutoFold}
          stopFollowingSignal={stopFollowingSignal}
        />
        {selectedNode !== null && (
          <Drawer
            sessionId={live.getSession().id}
            node={selectedNode}
            chain={chain}
            view={view}
            replay={replaying}
            reasoning={stepReasoning}
            onSelect={outline ? setDetailId : setSelectedId}
            onExpandCut={expandChainCut}
            onClose={closeDrawer}
          />
        )}
        {canvas.replay !== null && <Timeline replay={canvas.replay} onSeek={canvas.setReplayTime} />}
        {scope !== null && (
          <Waterfall
            graph={graphNow}
            session={live.getSession()}
            scope={scope}
            title={scopeTitle}
            compact={canvas.compact}
            selectedId={detailId}
            chainIds={steps !== null ? steps.ids : null}
            directIds={steps !== null ? steps.direct : null}
            onSelectRow={setDetailId}
            onOpenAgent={openAgent}
            onClose={closePanel}
          />
        )}
        {empty && <div className="canvas-empty muted">暂无节点</div>}
        {laying && <div className="canvas-empty muted">布局中…</div>}
      </div>
    </>
  );
});

export function SessionPage({ sessionId }: { sessionId: string }) {
  const [live, setLive] = useState<LiveSession | null>(null);
  /** The failure of openLiveSession (null while there is none); see sessionLoadState. */
  const [error, setError] = useState<unknown>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  /** The info bar's right-hand slot; the canvas renders its view switch into it (it owns the mode). */
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null);
  const now = useNow();

  useEffect(() => {
    let alive = true;
    let current: LiveSession | null = null;
    let unsubscribe: (() => void) | null = null;
    openLiveSession(sessionId).then(
      (l) => {
        if (!alive) { l.close(); return; }
        current = l;
        unsubscribe = l.subscribe(rerender); // the info bar shows live session fields
        setLive(l);
      },
      (e: unknown) => { if (alive) setError(e ?? new Error('unknown error')); },
    );
    return () => {
      alive = false;
      unsubscribe?.();
      current?.close();
    };
  }, [sessionId]);

  // The subscription re-renders this page when a resync finds the session gone (live.isGone()).
  const state = sessionLoadState(error, live);
  if (state === 'missing') {
    return (
      <div className="session-missing">
        <p>会话不存在</p>
        <a href="#/">返回首页</a>
      </div>
    );
  }
  if (state === 'error') return <p className="error">加载失败：{String(error)}</p>;
  if (live === null) return <p className="muted session-loading">加载中…</p>;
  const session = live.getSession();
  const status = sessionStatusView(session, now);
  return (
    <div className="session-page">
      <div className="session-bar">
        <a href={`#/p/${encodeURIComponent(session.projectId)}`}>← 返回项目</a>
        <h2 title={session.title ?? session.id}>{session.title ?? session.id.slice(0, 8)}</h2>
        <span className={`status status-${status.status}`}>{status.label}</span>
        {session.gitBranch !== null && <span className="muted branch" title={session.gitBranch}>{session.gitBranch}</span>}
        {session.sourceDeleted && <span className="tag">源文件已删除</span>}
        <div className="session-bar-end" ref={setToolbar} />
      </div>
      <SessionCanvas key={session.id} live={live} toolbar={toolbar} />
    </div>
  );
}
