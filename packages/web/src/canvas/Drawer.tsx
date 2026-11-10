import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GraphNode, NodeDetail } from '@claude-canvas/shared';
import { api } from '../client';
import { NODE_STATUS_LABEL } from '../labels';
import type { UpstreamChain } from './chain';
import { formatDuration } from './format';
import { DETAIL_MAX_CHARS, detailSections } from './detail';
import { KIND_LABEL, nodeColor } from './nodes';
import { CHAIN_FOLDED, NO_REASONING, reasoningRows, type ReasoningRow } from './reasoning';
import type { CanvasView } from './view';

/** Kind chip colours of the "推理链" rows (the canvas's thinking / text colours). */
const THINKING_COLOR = '#94a3b8';
const TEXT_COLOR = '#475569';

export { DETAIL_MAX_CHARS, detailSections, type DetailSection } from './detail';

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

/** A collapsed section whose content is only rendered once it has been opened (raw records can be large). */
function LazyDetails({ label, children }: { label: string; children: () => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="cc-section" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{label}</summary>
      {open && children()}
    </details>
  );
}

/**
 * Causal view: the thinking / text nodes on the selection's upstream chain, oldest first. Each other row is a button
 * that selects its node; the selected node's own row is marked current. When a row selects a node, that node's row
 * (now current, no longer a button) takes the focus, so it does not fall back to the page body. `pendingFocus` is
 * owned by the drawer: the list is remounted with the body when the selection changes. When a fold cut the chain short
 * (`truncated`), a line above the rows says so, with a button that expands what cut it; the "nothing recorded" text is
 * shown only for a chain that was not cut short.
 */
function ReasoningList({ rows, truncated, onSelect, onExpand, pendingFocus }: {
  rows: ReasoningRow[]; truncated: boolean; onSelect(id: string): void; onExpand(): void;
  pendingFocus: { current: boolean };
}) {
  const currentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    const current = currentRef.current;
    if (!current) return;
    current.focus({ preventScroll: true });
    current.scrollIntoView({ block: 'nearest' }); // the list may have scrolled the new current row out of view
  }, [rows, pendingFocus]);
  const content = (r: ReasoningRow) => (
    <>
      <span className="cc-kind" style={{ ['--cc-color' as string]: r.kind === 'thinking' ? THINKING_COLOR : TEXT_COLOR }}>{r.label}</span>
      <span className="cc-reason-time">{formatTime(r.time)}</span>
      <span className={`cc-reason-text${r.missing ? ' cc-muted' : ''}`} title={r.missing ? undefined : r.text}>
        {r.text}
        {r.durationMs !== null && ` · ${formatDuration(r.durationMs)}`}
      </span>
    </>
  );
  return (
    <section className="cc-section cc-reasoning">
      <h3>推理链</h3>
      {truncated && (
        <div className="cc-reason-folded">
          <span className="cc-muted">{CHAIN_FOLDED}</span>
          <button type="button" className="cc-fold" onClick={onExpand}>展开</button>
        </div>
      )}
      {rows.length === 0
        ? !truncated && <div className="cc-muted">{NO_REASONING}</div>
        : (
          <ol className="cc-reason-list">
            {rows.map((r) => (
              <li key={r.id}>
                {r.current
                  ? <div ref={currentRef} className="cc-reason cc-reason-current" aria-current="step" tabIndex={-1}>{content(r)}</div>
                  : (
                    <button type="button" className="cc-reason" onClick={() => { pendingFocus.current = true; onSelect(r.id); }}>
                      {content(r)}
                    </button>
                  )}
              </li>
            ))}
          </ol>
        )}
    </section>
  );
}

function DrawerBody({ sessionId, node, prefix }: { sessionId: string; node: GraphNode; prefix: ReactNode }) {
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  // `node` is a new object whenever the node receives an update, so this refetches the detail then.
  useEffect(() => {
    let alive = true;
    api.nodeDetail(sessionId, node.id).then(
      (d) => { if (alive) { setDetail(d); setError(null); } },
      (e: unknown) => { if (alive) setError(String(e)); },
    );
    return () => { alive = false; };
  }, [sessionId, node]);

  if (detail === null) {
    return (
      <div className="cc-drawer-body">
        {prefix}
        {error === null
          ? <div className="cc-muted">加载中…</div>
          : <div className="cc-drawer-error">详情加载失败：{error}</div>}
      </div>
    );
  }
  const sections = detailSections(detail);
  return (
    <div className="cc-drawer-body">
      {prefix}
      {error !== null && <div className="cc-drawer-error">详情刷新失败：{error}</div>}
      {sections.length === 0 && <div className="cc-muted">无内容</div>}
      {sections.map((s) => {
        const content = () => (
          <>
            <pre>{s.body}</pre>
            {s.truncated && <div className="cc-muted">（已截断，仅显示前 {DETAIL_MAX_CHARS} 个字符）</div>}
          </>
        );
        return s.label === '原始记录'
          ? <LazyDetails key={s.label} label={s.label}>{content}</LazyDetails>
          : <section key={s.label} className="cc-section"><h3>{s.label}</h3>{content()}</section>;
      })}
    </div>
  );
}

export interface DrawerProps {
  sessionId: string;
  node: GraphNode;
  /** upstreamChain(view, node.id) in the causal view (EMPTY_CHAIN otherwise). */
  chain: UpstreamChain;
  view: CanvasView;
  /** Selects another node (a row of the "推理链" list). */
  onSelect(id: string): void;
  /** Expands the folds that cut the chain short (chain.cutAt; see expandCut). */
  onExpandCut(): void;
  onClose(): void;
}

export function Drawer({ sessionId, node, chain, view, onSelect, onExpandCut, onClose }: DrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // Focus the close button on open; give focus back to whatever had it when the drawer closes.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** Set by a "推理链" row click; the next list render focuses the (new) current row. */
  const reasonFocus = useRef(false);
  const causal = view.mode === 'causal';
  const rows = useMemo(() => (causal ? reasoningRows(view, chain, node.id) : []), [causal, view, chain, node.id]);
  const duration = node.durationMs !== null ? formatDuration(node.durationMs) : '';
  return (
    <aside className="cc-drawer" aria-label="节点详情" style={{ ['--cc-color' as string]: nodeColor(node) }}>
      <div className="cc-drawer-head">
        <div className="cc-drawer-line">
          <span className="cc-kind">{KIND_LABEL[node.kind] ?? node.kind}</span>
          <span className="cc-drawer-title">{node.title}</span>
          <button ref={closeRef} type="button" className="cc-drawer-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="cc-drawer-meta">
          {node.status !== null && <span className="cc-status">{NODE_STATUS_LABEL[node.status] ?? node.status}</span>}
          <span>{formatTime(node.timestamp)}</span>
          {duration !== '' && <span>{duration}</span>}
          {node.usage !== null && <span>输入 {node.usage.inputTokens} · 输出 {node.usage.outputTokens}</span>}
          {!node.confirmed && <span className="cc-tag">未确认</span>}
        </div>
      </div>
      <DrawerBody
        key={node.id}
        sessionId={sessionId}
        node={node}
        prefix={causal
          ? <ReasoningList rows={rows} truncated={chain.truncated} onSelect={onSelect} onExpand={onExpandCut} pendingFocus={reasonFocus} />
          : null}
      />
    </aside>
  );
}
