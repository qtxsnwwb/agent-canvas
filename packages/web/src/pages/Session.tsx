import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { openLiveSession, type LiveSession } from '../client';
import { Canvas, type CanvasFocus } from '../canvas/Canvas';
import { FilePanel } from '../canvas/FilePanel';
import { revealPlan } from '../canvas/reveal';
import { EMPTY_CHAIN, expandCut, upstreamChain } from '../canvas/chain';
import { isRunId } from '../canvas/compact';
import { Drawer } from '../canvas/Drawer';
import { Timeline } from '../canvas/Timeline';
import { useCanvas } from '../canvas/useCanvas';
import { turnKeyOf, type ViewMode } from '../canvas/view';
import { Waterfall } from '../canvas/WaterfallPanel';
import { reasoningRow, type ReasoningRow } from '../canvas/reasoning';
import { ALL_PROGRESSING, type Progressing } from '../canvas/nodes';
import { scopeKey, scopeOf, stepChain, stepTicking, waterfallClock, type WaterfallScope } from '../canvas/waterfall';
import { sessionStatusView } from '../labels';
import { OriginBadge } from '../OriginBadge';
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
const SessionCanvas = memo(function SessionCanvas({ live, toolbar, filePath }: {
  live: LiveSession; toolbar: HTMLElement | null;
  /** The deep link's file (`#/s/<id>/f/<path>`): opens the file panel at it, again whenever it changes. */
  filePath: string | null;
}) {
  const canvas = useCanvas(live);
  // ---- the file panel (spec 4) ----
  // It sits where the drawer does: while it is open the drawer is not shown (the selection stays on the canvas, and the
  // drawer comes back when the panel closes); a step the reader opens on the canvas or in the waterfall closes it.
  const [filesOpen, setFilesOpen] = useState(filePath !== null);
  const [fileTarget, setFileTarget] = useState<{ path: string; seq: number } | null>(
    filePath !== null ? { path: filePath, seq: 1 } : null,
  );
  const firstPath = useRef(filePath);
  useEffect(() => {
    if (firstPath.current === filePath) return; // the initial one is already in the state
    firstPath.current = filePath;
    if (filePath === null) return;
    setFilesOpen(true);
    setFileTarget((t) => ({ path: filePath, seq: (t?.seq ?? 0) + 1 }));
  }, [filePath]);
  const [focus, setFocus] = useState<CanvasFocus | null>(null);
  const focusSeq = useRef(0);
  const [pickedStep, setPickedStep] = useState<string | null>(null);
  const [pickNote, setPickNote] = useState<string | null>(null);
  // Whether the session is progressing; re-evaluated when its status changes (a change that brings no node change
  // publishes no canvas snapshot) and every 30 s (a running session that went silent turns stale).
  // The snapshot is the status plus the last activity in 30 s steps: activity alone (a background agent's records, a
  // stale session waking up) changes the answer too, but must not re-render this on every record.
  const getStatus = useCallback(() => {
    const s = live.getSession();
    return `${s.status}|${Math.floor(Date.parse(s.lastActivityAt) / 30_000)}`;
  }, [live]);
  useSyncExternalStore(live.subscribe, getStatus);
  const clock = useNow(5_000);
  const sessionClock = waterfallClock(live.getSession(), Math.max(clock, Date.now()));
  const { ticking: mainTicking, backgroundTicking } = sessionClock;
  const progressing = useMemo<Progressing>(() => ({ main: mainTicking, background: backgroundTicking }), [mainTicking, backgroundTicking]);
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
  /** The step open in the drawer, and the scope (scopeKey) it belongs to; it is shown only while that scope is listed. */
  const [detail, setDetail] = useState<{ id: string; scope: string } | null>(null);
  const graphNow = live.getGraph();
  // With nothing selected the panel follows the latest turn (until it is closed). In the outline view every view node
  // is a turn card or a subagent, so a selection always has a scope.
  const explicitScope = outline ? scopeOf(selectedView) : null;
  const latestTurn = canvas.view.turns[canvas.view.turns.length - 1];
  const scope: WaterfallScope | null = !outline || panelClosed
    ? null
    : explicitScope ?? (selected === null && latestTurn !== undefined ? { type: 'turn', turnKey: latestTurn.key } : null);
  const currentScope = scope !== null ? scopeKey(scope) : null;
  /** The canvas node the panel belongs to (highlighted): the selection, or the latest turn's card while following it. */
  const scopeNodeId = scope === null ? null : selected ?? `turn:${latestTurn!.key}`;
  const detailId = detail !== null && detail.scope === currentScope ? detail.id : null;
  // A step of a scope that is no longer listed is dropped, so its drawer cannot reopen by itself later.
  useEffect(() => {
    if (detail !== null && detailId === null) setDetail(null);
  }, [detail, detailId]);
  const selectedNode = outline
    ? (detailId !== null ? graphNow.nodes[detailId] ?? null : null)
    : selectedView?.type === 'node'
      ? (replaying ? graphNow.nodes[selectedView.id] : undefined) ?? selectedView.node
      : null;
  // The latest values for the stable callbacks below.
  const now = useRef({ outline, selected, scopeNodeId, currentScope, view: canvas.view });
  now.current = { outline, selected, scopeNodeId, currentScope, view: canvas.view };
  /** The turn card openStep selected on the reader's behalf (to pin the panel); undone when the drawer closes. */
  const pinned = useRef<string | null>(null);
  const closeDrawer = useCallback(() => {
    if (now.current.outline) {
      setDetail(null);
      // Back to following the latest turn, unless the reader has picked something themself since.
      const pin = pinned.current;
      pinned.current = null;
      if (pin !== null) setSelectedId((id) => (id === pin ? null : id));
    } else {
      setSelectedId(null);
    }
  }, []);
  const scopeView = scopeNodeId !== null ? canvas.view.nodes.get(scopeNodeId) : undefined;
  const scopeTitle = scope === null
    ? ''
    : scope.type === 'turn'
      ? canvas.view.turns.find((t) => t.key === scope.turnKey)?.summary.promptSummary || '（无提示）'
      : scopeView?.type === 'node' ? [scopeView.node.title, scopeView.node.summary].filter(Boolean).join(' · ') : '';
  const closePanel = useCallback(() => {
    pinned.current = null;
    setPanelClosed(true);
    setSelectedId(null);
    setDetail(null);
  }, []);
  const openAgent = useCallback((dispatchNodeId: string) => {
    pinned.current = null; // the reader's own choice
    setSelectedId(dispatchNodeId);
  }, []);
  // Opening a step while the panel follows the latest turn pins the panel to that turn: a new turn must not take the
  // list away from under the open drawer.
  const openStep = useCallback((id: string) => {
    const cur = now.current;
    if (cur.currentScope === null) return;
    setFilesOpen(false); // the drawer and the file panel share the right-hand side
    if (cur.selected === null && cur.scopeNodeId !== null) {
      pinned.current = cur.scopeNodeId;
      setSelectedId(cur.scopeNodeId);
    }
    setDetail({ id, scope: cur.currentScope });
  }, []);
  // A row of the drawer's "推理链" may belong to another thread (an agent's chain continues into the main thread): the
  // panel moves to the turn or agent that step belongs to.
  const openChainStep = useCallback((id: string) => {
    const cur = now.current;
    const graph = live.getGraph();
    const node = graph.nodes[id];
    if (node === undefined || cur.currentScope === null) return;
    let target: string | null = null;
    let key: string | null = null;
    if (node.agentId !== null) {
      key = `agent:${node.agentId}`;
      for (const vn of cur.view.nodes.values()) {
        if (vn.type === 'node' && vn.node.childAgentId === node.agentId) { target = vn.id; break; }
      }
    } else {
      const turnKey = turnKeyOf(graph, id);
      if (turnKey !== null) target = key = `turn:${turnKey}`;
    }
    if (target !== null && key !== null && cur.view.nodes.has(target)) {
      if (target !== cur.selected) pinned.current = null; // moved to another turn or agent by the reader
      setSelectedId(target);
      setDetail({ id, scope: key });
    } else {
      setDetail({ id, scope: cur.currentScope });
    }
  }, [live]);
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
      // A step picked on the canvas opens the drawer, which takes the file panel's place.
      if (id !== null && !now.current.outline && now.current.view.nodes.get(id)?.type === 'node') setFilesOpen(false);
      setPickNote(null);
      pinned.current = null; // the reader's own choice
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
  const { reveal } = canvas;
  /**
   * A step picked in the file panel: shown on the canvas in the active view, the panel stays open. Outline: its turn
   * card (or its agent's node) is selected and the step selected in the waterfall. Step views: its turn and agents are
   * expanded, then it is selected and centred. When the view cannot draw it, its turn is selected (or centred) instead
   * and the panel says so.
   */
  const pickStep = useCallback((nodeId: string) => {
    const cur = now.current;
    const graph = live.getGraph();
    const node = graph.nodes[nodeId];
    const plan = revealPlan(graph, nodeId);
    const focusOn = (target: Omit<CanvasFocus, 'seq'>): void => setFocus({ ...target, seq: ++focusSeq.current });
    setPickedStep(nodeId);
    if (node === undefined || plan === null) {
      setPickNote('这一步已经不在画布上了。');
      return;
    }
    const turnId = plan.turnKey !== null ? `turn:${plan.turnKey}` : null;
    if (cur.outline) {
      pinned.current = null;
      setPanelClosed(false);
      const target = node.agentId === null ? turnId : plan.dispatchId;
      if (target !== null && cur.view.nodes.has(target)) {
        setSelectedId(target);
        setDetail({ id: nodeId, scope: node.agentId === null ? target : `agent:${node.agentId}` });
        setPickNote(null);
        focusOn({ id: target });
      } else if (turnId !== null && cur.view.nodes.has(turnId)) {
        setSelectedId(turnId);
        setDetail(null);
        setPickNote('概览里找不到这一步所在的子代理，已选中它所在的轮次。');
        focusOn({ id: turnId });
      } else {
        setPickNote('这一步在概览里画不出来。');
      }
      return;
    }
    // Like the drawer's 展开: auto-fold off first, so nothing opened here is folded away again by later updates.
    setAutoFold(false);
    setStopFollowingSignal((n) => n + 1);
    if (reveal(nodeId)) {
      setSelectedId(nodeId);
      setPickNote(null);
      focusOn({ id: nodeId });
      return;
    }
    const why = cur.view.mode === 'replay' ? '复盘时间还没到这一步' : '这一步在当前视角里画不出来';
    if (plan.turnKey === null) {
      setPickNote(`${why}。`);
    } else if (turnId !== null && cur.view.nodes.has(turnId)) {
      setSelectedId(turnId);
      setPickNote(`${why}，已选中它所在的轮次。`);
      focusOn({ id: turnId });
    } else {
      setSelectedId(null);
      setPickNote(`${why}，已定位到它所在的轮次。`);
      focusOn({ turnKey: plan.turnKey });
    }
  }, [live, reveal, setAutoFold]);
  const closeFiles = useCallback(() => {
    setFilesOpen(false);
    setPickNote(null);
  }, []);
  const toggleFiles = useCallback(() => {
    setFilesOpen((o) => !o);
    setPickNote(null);
  }, []);
  // "暂无节点" only when the live graph really has no nodes; "布局中…" while the model is starting or the view has
  // nodes none of which is placed yet.
  const empty = !hasKeys(live.getGraph().nodes);
  const laying = !empty && canvas.layoutError === null
    && (!canvas.ready || (canvas.view.nodes.size > 0 && !hasKeys(canvas.positions)));
  return (
    <>
      {toolbar !== null && createPortal(
        <>
          <button type="button" className="files-toggle" aria-pressed={filesOpen}
            onClick={toggleFiles} title="这个会话读过、改过哪些文件">文件</button>
          <DensitySwitch compact={canvas.compact} disabled={!canvas.ready} onChange={canvas.setCompact} />
          <ViewSwitch mode={canvas.view.mode} disabled={!canvas.ready} onChange={canvas.setMode} />
        </>,
        toolbar,
      )}
      {canvas.layoutError !== null && <div className="canvas-error">布局失败，正在自动重试：{canvas.layoutError}</div>}
      <div className={`canvas-area${selectedNode !== null || filesOpen ? ' cc-drawer-open' : ''}${canvas.replay !== null ? ' cc-replay' : ''}${scope !== null ? ' cc-waterfall-open' : ''}`}>
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
          focus={focus}
          rightCovered={filesOpen}
          // The replay view shows history: "running" there is what was running at the replay time.
          progressing={replaying ? ALL_PROGRESSING : progressing}
        />
        {selectedNode !== null && !filesOpen && (
          <Drawer
            sessionId={live.getSession().id}
            node={selectedNode}
            chain={chain}
            view={view}
            replay={replaying}
            // The drawer shows the node's current state (also in the replay view).
            stalled={!stepTicking(sessionClock, selectedNode)}
            reasoning={stepReasoning}
            onSelect={outline ? openChainStep : setSelectedId}
            onExpandCut={expandChainCut}
            onClose={closeDrawer}
          />
        )}
        {filesOpen && (
          <FilePanel
            sessionId={live.getSession().id}
            origin={live.getSession().origin}
            subscribe={live.subscribe}
            target={fileTarget}
            pickedNode={pickedStep}
            note={pickNote}
            onPick={pickStep}
            onClose={closeFiles}
          />
        )}
        {canvas.replay !== null && <Timeline replay={canvas.replay} onSeek={canvas.setReplayTime} />}
        {scope !== null && (
          <Waterfall
            graph={graphNow}
            live={live}
            scope={scope}
            title={scopeTitle}
            compact={canvas.compact}
            selectedId={detailId}
            chainIds={steps !== null ? steps.ids : null}
            directIds={steps !== null ? steps.direct : null}
            onSelectRow={openStep}
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

export function SessionPage({ sessionId, filePath = null }: { sessionId: string; filePath?: string | null }) {
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
        <OriginBadge origin={session.origin} />
        {session.gitBranch !== null && <span className="muted branch" title={session.gitBranch}>{session.gitBranch}</span>}
        {session.sourceDeleted && <span className="tag">源文件已删除</span>}
        <div className="session-bar-end" ref={setToolbar} />
      </div>
      <SessionCanvas key={session.id} live={live} toolbar={toolbar} filePath={filePath} />
    </div>
  );
}
