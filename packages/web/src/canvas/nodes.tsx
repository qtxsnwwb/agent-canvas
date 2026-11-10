import { createContext, memo, useContext, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { Handle, Position, type Node, type NodeProps, type NodeTypes } from '@xyflow/react';
import type { GraphNode, NodeKind, NodeStatus } from '@claude-canvas/shared';
import { NODE_STATUS_LABEL } from '../labels';
import { formatDuration, nodeAriaLabel } from './format';
import { THINKING_NOT_RECORDED } from './reasoning';
import type { TurnSummary } from './view';

export const KIND_LABEL: Record<NodeKind, string> = {
  prompt: '提示',
  thinking: '思考',
  text: '回复',
  tool: '工具',
  subagent: '子代理',
  system: '系统',
  unknown: '未知',
};

export const STATUS_COLOR: Record<NodeStatus, string> = {
  running: '#2563eb',
  awaiting_permission: '#d97706',
  succeeded: '#16a34a',
  failed: '#dc2626',
  denied: '#9f1239',
};
const KIND_COLOR: Partial<Record<NodeKind, string>> = {
  prompt: '#7c3aed',
  text: '#475569',
  thinking: '#94a3b8',
  system: '#64748b',
  unknown: '#a16207',
};
const FALLBACK_COLOR = '#64748b';
const SUMMARY_COLOR = '#64748b';

/** Border and side-bar colour: the status when the node has one, otherwise its kind. */
export function nodeColor(node: GraphNode): string {
  return node.status !== null ? STATUS_COLOR[node.status] ?? FALLBACK_COLOR : KIND_COLOR[node.kind] ?? FALLBACK_COLOR;
}
export function summaryColor(s: TurnSummary): string {
  if (s.running) return STATUS_COLOR.running;
  if (s.failedCount > 0) return STATUS_COLOR.failed;
  return SUMMARY_COLOR;
}
/** Accessible name for a graph node: kind, title and status. */
export function graphNodeAriaLabel(node: GraphNode, expanded = false): string {
  return nodeAriaLabel([
    KIND_LABEL[node.kind] ?? node.kind, node.title, node.status !== null ? NODE_STATUS_LABEL[node.status] ?? node.status : null,
    expanded ? '已展开' : null,
  ]);
}
export function summaryAriaLabel(s: TurnSummary): string {
  return nodeAriaLabel(['已折叠的轮次', s.promptSummary, `${s.nodeCount} 个节点`, s.running ? '运行中' : null]);
}

export function isActive(status: NodeStatus | null): boolean {
  return status === 'running' || status === 'awaiting_permission';
}

/**
 * `expandable`: show the expand / collapse button (a subagent with inner nodes; every view but topology). `expanded`: the agent
 * is expanded in the view. `container`: drawn as a container (expanded and its box has landed; until then it keeps the
 * collapsed size).
 */
export type GraphNodeData = {
  node: GraphNode; innerCount: number; expandable: boolean; expanded: boolean; container: boolean;
  /** Causal view: a thinking node is drawn with two rows (see sizeOf). */
  causal: boolean;
  highlight: Highlight;
};
/**
 * Causal view with a selection: 'chain' for nodes / edges on the selection's upstream chain, 'dim' for the rest; 'none'
 * otherwise. Drawn through the React Flow wrapper's className only (never changes a size or position).
 */
export type Highlight = 'chain' | 'dim' | 'none';
export type GraphFlowNode = Node<GraphNodeData, 'graphNode'>;
export type SummaryFlowNode = Node<{ summary: TurnSummary; highlight: Highlight }, 'turnSummary'>;
export type HeaderFlowNode = Node<{ turnKey: string; startedAt: string; nodeCount: number; highlight: Highlight }, 'turnHeader'>;
/** `groupKey`: the turn key, or the agent group key for the fold inside a long expanded agent (see ViewNode). */
export type EarlierFlowNode = Node<{
  turnKey: string; groupKey: string; count: number; toolCount: number; failedCount: number; highlight: Highlight;
}, 'earlier'>;

/** The wrapper class for a highlight state ('' for none). */
export function highlightClass(h: Highlight): string {
  return h === 'chain' ? 'cc-hl-chain' : h === 'dim' ? 'cc-hl-dim' : '';
}
export type FlowNode = GraphFlowNode | SummaryFlowNode | HeaderFlowNode | EarlierFlowNode;

/** `fromKeyboard`: the action came from the keyboard, so focus should land on the turn's header once it exists. */
export interface CanvasActionsValue {
  toggleTurn(turnKey: string, fromKeyboard?: boolean): void;
  /** Takes a turn key or an agent group key (the fold inside a long agent). */
  showFullTurn(turnKey: string, fromKeyboard?: boolean): void;
  /** Expands or collapses the agent (a subagent node's childAgentId). */
  toggleAgent(agentId: string): void;
}
/** Callbacks for controls inside nodes; a context keeps them out of node data (which must stay stable). */
export const CanvasActions = createContext<CanvasActionsValue>({ toggleTurn() {}, showFullTurn() {}, toggleAgent() {} });

function boxStyle(width: number | undefined, height: number | undefined, color: string): CSSProperties {
  return { width, height, ['--cc-color' as string]: color };
}

/**
 * Edges attach to these; React Flow also gets the same handles on the node objects (see Canvas), so it can draw
 * edges without measuring the DOM first. Hidden visually.
 */
function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} className="cc-handle" />
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="cc-handle" />
    </>
  );
}

function pulseClass(status: NodeStatus | null): string {
  return status === 'running' ? ' cc-pulse-running' : status === 'awaiting_permission' ? ' cc-pulse-awaiting' : '';
}

function GraphNodeView({ data, width, height, selected }: NodeProps<GraphFlowNode>) {
  const { node } = data;
  const duration = node.durationMs !== null ? formatDuration(node.durationMs) : '';
  const unconfirmed = node.confirmed === false;
  const className = `cc-node cc-kind-${node.kind}${pulseClass(node.status)}${selected ? ' cc-selected' : ''}${unconfirmed ? ' cc-unconfirmed' : ''}`;
  const style = boxStyle(width, height, nodeColor(node));
  const kindLabel = KIND_LABEL[node.kind] ?? node.kind;
  const tag = unconfirmed ? <span className="cc-tag">未确认</span> : null;

  // Causal view: thinking gets two rows, "思考 · 3.4s" and its text (or a grey placeholder when none was recorded).
  if (node.kind === 'thinking' && data.causal) {
    return (
      <div className={className} style={style} title={node.summary || undefined}>
        <Handles />
        <div className="cc-row">
          <span className="cc-ellipsis cc-grow">{[kindLabel, duration].filter(Boolean).join(' · ')}</span>
          {tag}
        </div>
        <div className="cc-row cc-summary">
          {node.summary !== ''
            ? <span className="cc-ellipsis cc-grow">{node.summary}</span>
            : <span className="cc-ellipsis cc-grow cc-muted">{THINKING_NOT_RECORDED}</span>}
        </div>
      </div>
    );
  }

  // Compact one-line nodes: thinking ("思考 · 3.4s") and system (label, title and summary on one line).
  if (node.kind === 'thinking' || node.kind === 'system') {
    const text = node.kind === 'thinking'
      ? [kindLabel, duration].filter(Boolean).join(' · ')
      : [kindLabel, node.summary || node.title].filter(Boolean).join(' · ');
    return (
      <div className={`${className} cc-oneline`} style={style} title={node.summary || undefined}>
        <Handles />
        <div className="cc-row">
          <span className="cc-ellipsis cc-grow">{text}</span>
          {tag}
        </div>
      </div>
    );
  }

  const showTitle = node.kind === 'tool' || node.kind === 'subagent';
  const rows = (button: ReactNode) => (
    <>
      <div className="cc-row">
        <span className="cc-kind">{kindLabel}</span>
        <span className="cc-title cc-ellipsis cc-grow">{showTitle ? node.title : ''}</span>
        {node.status !== null && <span className="cc-status">{NODE_STATUS_LABEL[node.status] ?? node.status}</span>}
        {duration !== '' && <span className="cc-duration">{duration}</span>}
        {tag}
        {button}
      </div>
      {node.summary !== '' && (
        <div className="cc-row cc-summary">
          <span className="cc-ellipsis cc-grow">{node.summary}</span>
        </div>
      )}
    </>
  );
  if (node.kind === 'subagent') return <SubagentView data={data} className={className} style={style} rows={rows} />;
  return (
    <div className={className} style={style}>
      <Handles />
      {rows(null)}
    </div>
  );
}

/**
 * A subagent node, collapsed or drawn as a container (its expanded box: the 68 px head is the collapsed node, the
 * inner nodes are separate React Flow nodes drawn above the body). The same element tree in both states, so the
 * expand / collapse button keeps the keyboard focus across the switch.
 */
function SubagentView({ data, className, style, rows }: {
  data: GraphNodeData; className: string; style: CSSProperties; rows(button: ReactNode): ReactNode;
}) {
  const { toggleAgent } = useContext(CanvasActions);
  const { node, innerCount, expandable, expanded, container } = data;
  const agentId = node.childAgentId;
  const onToggle = (e: MouseEvent): void => {
    e.stopPropagation(); // not a node click: does not select the node
    if (agentId !== null) toggleAgent(agentId);
  };
  const verb = expanded ? '收起' : '展开';
  // "nokey": React Flow's node key handler ignores keys from inside it (Enter would select the node).
  const button = expandable && agentId !== null
    ? (
      <button type="button" className="cc-expand nodrag nopan nokey" onClick={onToggle}
        aria-expanded={expanded} aria-label={`子代理 ${node.title}`}>
        {verb}
      </button>
    )
    : null;
  return (
    <div className={`${className}${container ? ' cc-container' : ''}`} style={style}>
      <Handles />
      <div className="cc-agent-head">
        {rows(button)}
        <div className="cc-row cc-inner">
          <span className="cc-ellipsis cc-grow">{innerCount > 0 ? `内部 ${innerCount} 个节点` : '暂无内部节点'}</span>
        </div>
      </div>
      {container && <div className="cc-container-body" />}
    </div>
  );
}

function TurnSummaryView({ data, width, height, selected }: NodeProps<SummaryFlowNode>) {
  const { toggleTurn } = useContext(CanvasActions);
  const onExpand = (e: MouseEvent): void => {
    e.stopPropagation(); // the node click would expand it as well
    toggleTurn(data.summary.turnKey, e.detail === 0); // detail 0: a click synthesised from Enter / Space
  };
  const s = data.summary;
  const duration = s.durationMs > 0 ? formatDuration(s.durationMs) : '';
  const stats = [`${s.nodeCount} 个节点`, `${s.toolCount} 次工具调用`, duration].filter(Boolean).join(' · ');
  const className = `cc-node cc-turn-summary${s.running ? ' cc-pulse-running' : ''}${selected ? ' cc-selected' : ''}`;
  return (
    <div className={className} style={boxStyle(width, height, summaryColor(s))} title="点击展开该轮次">
      <Handles />
      <div className="cc-row">
        <span className="cc-kind">已折叠</span>
        <span className="cc-title cc-ellipsis cc-grow">{s.promptSummary || '（无提示）'}</span>
        {s.running && <span className="cc-status cc-running-dot">运行中</span>}
        <button type="button" className="cc-expand nodrag nopan" onClick={onExpand}>展开</button>
      </div>
      <div className="cc-row cc-summary">
        <span className="cc-ellipsis cc-grow">
          {stats}
          {s.failedCount > 0 && <span className="cc-failed"> · {s.failedCount} 个失败</span>}
        </span>
      </div>
    </div>
  );
}

function EarlierView({ data, width, height }: NodeProps<EarlierFlowNode>) {
  const { showFullTurn } = useContext(CanvasActions);
  const onShowAll = (e: MouseEvent): void => {
    e.stopPropagation(); // not a node click
    // A keyboard click moves focus to the turn's header afterwards; an agent group has no header of its own.
    showFullTurn(data.groupKey, e.detail === 0 && data.groupKey === data.turnKey);
  };
  return (
    <div className="cc-node cc-earlier" style={boxStyle(width, height, SUMMARY_COLOR)}>
      <Handles />
      <div className="cc-row">
        <span className="cc-ellipsis cc-grow">
          更早的 {data.count} 个节点 · {data.toolCount} 次工具调用
          {data.failedCount > 0 && <span className="cc-failed"> · {data.failedCount} 个失败</span>}
        </span>
        <button type="button" className="cc-fold nodrag nopan" onClick={onShowAll}>展开全部</button>
      </div>
    </div>
  );
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
}

function TurnHeaderView({ data, width, height }: NodeProps<HeaderFlowNode>) {
  const { toggleTurn } = useContext(CanvasActions);
  const onFold = (e: MouseEvent): void => {
    e.stopPropagation(); // not a node click
    toggleTurn(data.turnKey);
  };
  return (
    <div className="cc-turn-header" style={{ width, height }}>
      <span className="cc-ellipsis cc-grow">
        {formatClock(data.startedAt)}
        <span className="cc-muted"> · {data.nodeCount} 个节点</span>
      </span>
      <button type="button" className="cc-fold nodrag nopan" onClick={onFold}>折叠</button>
    </div>
  );
}

/** Defined at module level so React Flow sees one stable object. */
export const nodeTypes = {
  graphNode: memo(GraphNodeView),
  turnSummary: memo(TurnSummaryView),
  turnHeader: memo(TurnHeaderView),
  earlier: memo(EarlierView),
} satisfies NodeTypes;
