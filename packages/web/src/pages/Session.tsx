import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type { GraphNode, NodeDetail } from '@claude-canvas/shared';
import { api, openLiveSession, orderNodes, type LiveSession } from '../client';
import { NODE_STATUS_LABEL, sessionStatusView } from '../labels';
import { useNow } from '../useNow';

const DETAIL_MAX_CHARS = 200_000;

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

function atBottom(): boolean {
  const el = document.documentElement;
  return el.scrollHeight - (window.scrollY + window.innerHeight) < 40;
}

function DetailView({ sessionId, node }: { sessionId: string; node: GraphNode }) {
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
      ? <div className="detail muted">加载中…</div>
      : <div className="detail error">详情加载失败：{error}</div>;
  }
  const json = JSON.stringify(detail, null, 2) ?? '';
  const truncated = json.length > DETAIL_MAX_CHARS;
  return (
    <div className="detail">
      {error !== null && <div className="error">详情刷新失败：{error}</div>}
      <pre>{truncated ? json.slice(0, DETAIL_MAX_CHARS) : json}</pre>
      {truncated && <div className="muted">（已截断，仅显示前 {DETAIL_MAX_CHARS} 个字符）(truncated)</div>}
    </div>
  );
}

function NodeRow({ sessionId, node, open, onToggle }: {
  sessionId: string;
  node: GraphNode;
  open: boolean;
  onToggle: () => void;
}) {
  const inSubagent = node.agentId !== null;
  return (
    <li className={inSubagent ? 'node subagent-node' : 'node'}>
      <div className="node-row" onClick={onToggle} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}>
        <span className="time">{formatTime(node.timestamp)}</span>
        <span className="kind">{node.kind}</span>
        {inSubagent && <span className="tag">子代理 {node.agentId}</span>}
        <span className="title">{node.title}</span>
        {node.status !== null && <span className={`status status-${node.status}`}>{NODE_STATUS_LABEL[node.status] ?? node.status}</span>}
        {!node.confirmed && <span className="tag">未确认</span>}
        <span className="summary">{node.summary}</span>
      </div>
      {open && <DetailView sessionId={sessionId} node={node} />}
    </li>
  );
}

export function SessionPage({ sessionId }: { sessionId: string }) {
  const [live, setLive] = useState<LiveSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const stick = useRef(true);
  const now = useNow();

  useEffect(() => {
    let alive = true;
    let current: LiveSession | null = null;
    let unsubscribe: (() => void) | null = null;
    openLiveSession(sessionId).then(
      (l) => {
        if (!alive) { l.close(); return; }
        current = l;
        unsubscribe = l.subscribe(() => {
          stick.current = atBottom();
          rerender();
        });
        setLive(l);
      },
      (e: unknown) => { if (alive) setError(String(e)); },
    );
    return () => {
      alive = false;
      unsubscribe?.();
      current?.close();
    };
  }, [sessionId]);

  useEffect(() => {
    const onScroll = (): void => { stick.current = atBottom(); };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const nodes = live ? orderNodes(live.getGraph()) : [];
  useLayoutEffect(() => {
    if (stick.current) window.scrollTo(0, document.documentElement.scrollHeight);
  }, [nodes.length]);

  const toggle = (id: string): void =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  if (error !== null) return <p className="error">加载失败：{error}</p>;
  if (live === null) return <p className="muted">加载中…</p>;
  const session = live.getSession();
  const status = sessionStatusView(session, now);
  return (
    <div className="session-page">
      <div className="session-head">
        <a href={`#/p/${encodeURIComponent(session.projectId)}`}>返回项目</a>
        <h2>{session.title ?? session.id.slice(0, 8)}</h2>
        <div className="muted">
          <span className={`status status-${status.status}`}>{status.label}</span>
          {session.gitBranch !== null && <span> · {session.gitBranch}</span>}
          {session.sourceDeleted && <span className="tag"> 源文件已删除</span>}
        </div>
      </div>
      {nodes.length === 0 && <p className="muted">暂无节点</p>}
      <ul className="nodes">
        {nodes.map((n) => (
          <NodeRow key={n.id} sessionId={sessionId} node={n} open={open.has(n.id)} onToggle={() => toggle(n.id)} />
        ))}
      </ul>
    </div>
  );
}
