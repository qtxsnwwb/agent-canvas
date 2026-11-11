import { memo, useEffect, useMemo, useRef, type MouseEvent } from 'react';
import type { Graph } from '@claude-canvas/shared';
import { NODE_STATUS_LABEL } from '../labels';
import { useNow } from '../useNow';
import { formatDuration } from './format';
import { KIND_LABEL, nodeColor } from './nodes';
import { barOf, buildWaterfall, type WaterfallRow, type WaterfallScope } from './waterfall';

export interface WaterfallProps {
  graph: Graph;
  scope: WaterfallScope;
  /** The turn's prompt, or the agent's type and task. */
  title: string;
  /** Leave out steps with nothing to read (see buildWaterfall). */
  compact: boolean;
  /** The row whose detail is open in the drawer. */
  selectedId: string | null;
  /** The steps that led to the selected row (see stepChain); the other rows are dimmed. Null: no highlighting. */
  chainIds: ReadonlySet<string> | null;
  onSelectRow(id: string): void;
  /** A subagent row's "内部步骤": show that agent's steps instead (takes the dispatch node's id). */
  onOpenAgent(dispatchNodeId: string): void;
  onClose(): void;
}

/** The end of the range is not ticked: its label would collide with the previous one; the head shows the total. */
const TICKS = [0, 0.25, 0.5, 0.75];
/** How close to the bottom still counts as "reading the newest rows" (the list then keeps up with new rows). */
const STICK_PX = 40;

function formatClock(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
}
const pct = (f: number): string => `${(f * 100).toFixed(3)}%`;

const Row = memo(function Row({ row, left, width, selected, chain, onSelectRow, onOpenAgent }: {
  row: WaterfallRow; left: number; width: number; selected: boolean;
  /** 'on': led to the selected row; 'off': did not (dimmed); null: nothing is selected. */
  chain: 'on' | 'off' | null;
  onSelectRow(id: string): void; onOpenAgent(id: string): void;
}) {
  const { node } = row;
  const named = node.kind === 'tool' || node.kind === 'subagent';
  const color = nodeColor(node);
  const duration = row.endMs > row.startMs ? formatDuration(row.endMs - row.startMs) : '';
  const openAgent = (e: MouseEvent): void => {
    e.stopPropagation(); // not a row click
    onOpenAgent(row.id);
  };
  // The duration is written after the bar, or before it when the bar ends in the right-hand third of the track.
  const after = left + width < 0.7;
  return (
    <div className={`cc-wf-row${selected ? ' cc-wf-selected' : ''}${chain === 'on' ? ' cc-wf-chain' : chain === 'off' ? ' cc-wf-dim' : ''}`}
      onClick={() => onSelectRow(row.id)}>
      <div className="cc-wf-label">
        <span className="cc-wf-dot" style={{ background: color }} />
        <button type="button" className="cc-wf-name" title={node.summary || undefined}>
          <span className="cc-wf-kind">{named ? node.title : KIND_LABEL[node.kind] ?? node.kind}</span>
          <span className="cc-wf-summary">{node.summary}</span>
        </button>
        {node.status !== null && node.status !== 'succeeded' && (
          <span className="cc-wf-status" style={{ color }}>{NODE_STATUS_LABEL[node.status] ?? node.status}</span>
        )}
        {row.childAgentId !== null && (
          <button type="button" className="cc-wf-inner" onClick={openAgent}>内部步骤</button>
        )}
      </div>
      <div className="cc-wf-track">
        {width > 0
          ? <span className={`cc-wf-bar${row.open ? ' cc-wf-open' : ''}`} style={{ left: pct(left), width: pct(width), background: color }} />
          : <span className="cc-wf-mark" style={{ left: pct(left), background: color }} />}
        {duration !== '' && (
          <span className="cc-wf-dur" style={after ? { left: pct(left + width) } : { right: pct(1 - left) }}>{duration}</span>
        )}
      </div>
    </div>
  );
});

/**
 * The steps of one turn or one agent as a waterfall: one row per step in time order, its bar placed on a shared time
 * axis (parallel steps overlap in time on separate rows). A row click opens the step's detail. While a step is running
 * the panel re-renders every second and, if the reader is at the bottom of the list, keeps up with new rows.
 */
export const Waterfall = memo(function Waterfall({
  graph, scope, title, compact, selectedId, chainIds, onSelectRow, onOpenAgent, onClose,
}: WaterfallProps) {
  const now = useNow(1000);
  const scopeKey = scope.type === 'turn' ? `turn:${scope.turnKey}` : `agent:${scope.agentId}`;
  // `scope` is rebuilt by the caller on every render; the key says whether it changed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const base = useMemo(() => buildWaterfall(graph, scope, { compact, nowMs: 0 }), [graph, scopeKey, compact]);
  const live = base.rows.some((r) => r.open);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const wf = useMemo(() => (live ? buildWaterfall(graph, scope, { compact, nowMs: now }) : base), [base, live, now]);

  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(false);
  // A new scope starts at the top, or at the bottom when it is still running (the newest step is the interesting one).
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    stick.current = live;
    el.scrollTop = live ? el.scrollHeight : 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);
  const count = wf.rows.length;
  useEffect(() => {
    const el = body.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [count]);
  const onScroll = (): void => {
    const el = body.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
  };

  const span = wf.endMs - wf.startMs;
  return (
    <section className="cc-waterfall" aria-label="执行过程">
      <div className="cc-wf-head">
        <span className="cc-wf-scope">{scope.type === 'turn' ? '轮次' : '子代理'}</span>
        <span className="cc-wf-title" title={title}>{title}</span>
        <span className="cc-wf-meta">
          {count} 步{count > 0 && ` · ${formatClock(wf.startMs)} 开始 · 历时 ${formatDuration(span)}`}
          {live && <span className="cc-wf-live"> · 进行中</span>}
        </span>
        <button type="button" className="cc-drawer-close" onClick={onClose} aria-label="关闭执行过程">×</button>
      </div>
      <div className="cc-wf-axis" aria-hidden="true">
        <div className="cc-wf-label" />
        <div className="cc-wf-track">
          {count > 0 && TICKS.map((f) => (
            <span key={f} className="cc-wf-tick" style={{ left: pct(f) }}>+{formatDuration(span * f) || '0'}</span>
          ))}
        </div>
      </div>
      <div className="cc-wf-body" ref={body} onScroll={onScroll}>
        {count === 0 && <p className="cc-wf-empty">这一段还没有步骤</p>}
        {wf.rows.map((row) => {
          const { left, width } = barOf(wf, row);
          return (
            <Row key={row.id} row={row} left={left} width={width} selected={row.id === selectedId}
              chain={chainIds === null ? null : chainIds.has(row.id) ? 'on' : 'off'}
              onSelectRow={onSelectRow} onOpenAgent={onOpenAgent} />
          );
        })}
      </div>
    </section>
  );
});
