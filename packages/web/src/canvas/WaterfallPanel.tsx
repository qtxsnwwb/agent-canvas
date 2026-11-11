import { memo, useEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties, type MouseEvent } from 'react';
import type { Graph } from '@claude-canvas/shared';
import type { LiveSession } from '../client';
import { NODE_STATUS_LABEL } from '../labels';
import { useNow } from '../useNow';
import { formatDuration } from './format';
import { KIND_LABEL, nodeColor, UNFINISHED_LABEL } from './nodes';
import {
  barOf, buildWaterfall, durationPlacement, scopeKey, stepTicking, waterfallClock, withNow, type WaterfallRow, type WaterfallScope,
} from './waterfall';

export interface WaterfallProps {
  graph: Graph;
  /** The session is read from here as it changes (its status decides whether open steps keep growing, see waterfallClock). */
  live: Pick<LiveSession, 'subscribe' | 'getSession'>;
  scope: WaterfallScope;
  /** The turn's prompt, or the agent's type and task. */
  title: string;
  /** Leave out steps with nothing to read (see buildWaterfall). */
  compact: boolean;
  /** The row whose detail is open in the drawer. */
  selectedId: string | null;
  /** The steps that led to the selected row (see stepChain); the other rows are dimmed. Null: no highlighting. */
  chainIds: ReadonlySet<string> | null;
  /** Among them, the steps the selected row was decided on (stepChain's `direct`): marked more strongly. */
  directIds: ReadonlySet<string> | null;
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

/**
 * One step. The bar is placed by CSS from the row's own `--s` (start offset in the range, ms) and `--d` (duration, ms)
 * and the list's `--span`, so a growing range (a step still running) moves the bars without re-rendering the rows:
 * only a row whose own data changed renders again.
 */
const Row = memo(function Row({ row, offset, place, selected, ticking, chain, onSelectRow, onOpenAgent }: {
  row: WaterfallRow;
  /** row.startMs minus the range start. */
  offset: number;
  place: 'after' | 'before' | 'inside';
  selected: boolean;
  /** The session is progressing: an open bar is animated. */
  ticking: boolean;
  /** 'direct': what the selected row was decided on; 'on': led to it; 'off': did not (dimmed); null: nothing is selected. */
  chain: 'direct' | 'on' | 'off' | null;
  onSelectRow(id: string): void; onOpenAgent(id: string): void;
}) {
  const { node } = row;
  const named = node.kind === 'tool' || node.kind === 'subagent';
  const color = nodeColor(node);
  const length = row.endMs - row.startMs;
  const duration = length > 0 ? formatDuration(length) : '';
  const openAgent = (e: MouseEvent): void => {
    e.stopPropagation(); // not a row click
    onOpenAgent(row.id);
  };
  const style = { ['--s' as string]: offset, ['--d' as string]: length } as CSSProperties;
  return (
    <div className={`cc-wf-row${selected ? ' cc-wf-selected' : ''}${chain === 'direct' ? ' cc-wf-direct' : chain === 'on' ? ' cc-wf-chain' : chain === 'off' ? ' cc-wf-dim' : ''}`}
      style={style} onClick={() => onSelectRow(row.id)}>
      <div className="cc-wf-label">
        <span className="cc-wf-dot" style={{ background: color }} />
        <button type="button" className="cc-wf-name" title={node.summary || undefined} aria-current={selected ? 'true' : undefined}>
          <span className="cc-wf-kind">{named ? node.title : KIND_LABEL[node.kind] ?? node.kind}</span>
          <span className="cc-wf-summary">{node.summary}</span>
        </button>
        {node.status !== null && node.status !== 'succeeded' && (
          <span className="cc-wf-status" style={{ color }}>
            {row.open && !ticking ? UNFINISHED_LABEL : NODE_STATUS_LABEL[node.status] ?? node.status}
          </span>
        )}
        {row.childAgentId !== null && (
          <button type="button" className="cc-wf-inner" onClick={openAgent}>内部步骤</button>
        )}
      </div>
      <div className="cc-wf-track">
        {length > 0
          ? <span className={`cc-wf-bar${row.open && ticking ? ' cc-wf-open' : ''}`} style={{ background: color }} />
          : <span className="cc-wf-mark" style={{ background: color }} />}
        {duration !== '' && <span className={`cc-wf-dur cc-wf-dur-${place}`}>{duration}</span>}
      </div>
    </div>
  );
});

/**
 * The steps of one turn or one agent as a waterfall: one row per step in time order, its bar placed on a shared time
 * axis (parallel steps overlap in time on separate rows). A row click opens the step's detail. While a step is running
 * (and the session is progressing) the panel re-renders every second and, if the reader is at the bottom of the list,
 * keeps up with new rows.
 */
export const Waterfall = memo(function Waterfall({
  graph, live: liveSession, scope, title, compact, selectedId, chainIds, directIds, onSelectRow, onOpenAgent, onClose,
}: WaterfallProps) {
  const now = useNow(1000);
  // Subscribed here: a status change alone (no node change) publishes no canvas snapshot, so the parent does not re-render.
  const session = useSyncExternalStore(liveSession.subscribe, liveSession.getSession);
  const key = scopeKey(scope);
  // `scope` is rebuilt by the caller on every render; the key says whether it changed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const base = useMemo(() => buildWaterfall(graph, scope, { compact, nowMs: 0 }), [graph, key, compact]);
  const open = base.rows.some((r) => r.open);
  const clock = waterfallClock(session, now);
  // Main-thread steps and background ones (a subagent's steps, a dispatch) have their own "now" (see waterfallClock).
  const live = base.rows.some((r) => r.open && stepTicking(clock, r.node));
  const { nowMs, backgroundNowMs } = clock;
  const wf = useMemo(() => (open ? withNow(base, { nowMs, backgroundNowMs }) : base), [base, open, nowMs, backgroundNowMs]);

  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(false);
  // A new scope starts at the top, or at the bottom when it is still running (the newest step is the interesting one).
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    stick.current = live;
    el.scrollTop = live ? el.scrollHeight : 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
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
          {open && !live && <span className="cc-wf-stalled"> · 有步骤未结束</span>}
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
      <div className="cc-wf-body" ref={body} onScroll={onScroll} style={{ ['--span' as string]: span } as CSSProperties}>
        {count === 0 && <p className="cc-wf-empty">这一段还没有步骤</p>}
        {wf.rows.map((row) => {
          const { left, width } = barOf(wf, row);
          return (
            <Row key={row.id} row={row} offset={row.startMs - wf.startMs} place={durationPlacement(left, width)}
              selected={row.id === selectedId} ticking={stepTicking(clock, row.node)}
              chain={chainIds === null ? null : directIds?.has(row.id) ? 'direct' : chainIds.has(row.id) ? 'on' : 'off'}
              onSelectRow={onSelectRow} onOpenAgent={onOpenAgent} />
          );
        })}
      </div>
    </section>
  );
});
