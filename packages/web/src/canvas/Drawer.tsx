import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { GraphNode, NodeDetail } from '@claude-canvas/shared';
import { api } from '../client';
import { NODE_STATUS_LABEL } from '../labels';
import { formatDuration } from './format';
import { DETAIL_MAX_CHARS, detailSections } from './detail';
import { KIND_LABEL, nodeColor } from './nodes';

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

function DrawerBody({ sessionId, node }: { sessionId: string; node: GraphNode }) {
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
    return error === null
      ? <div className="cc-drawer-body cc-muted">加载中…</div>
      : <div className="cc-drawer-body cc-drawer-error">详情加载失败：{error}</div>;
  }
  const sections = detailSections(detail);
  return (
    <div className="cc-drawer-body">
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

export function Drawer({ sessionId, node, onClose }: { sessionId: string; node: GraphNode; onClose(): void }) {
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
      <DrawerBody key={node.id} sessionId={sessionId} node={node} />
    </aside>
  );
}
