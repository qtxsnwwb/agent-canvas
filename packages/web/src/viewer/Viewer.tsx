import { useEffect, useMemo, useState } from 'react';
import type { ExportBundle } from '@agent-canvas/shared';
import { OriginBadge } from '../OriginBadge';
import { SessionCanvas } from '../pages/SessionCanvas';
import { bannerModel } from './banner';
import { embeddedSource, sessionName, viewerNodeId } from './data';
import { createInThreadLayoutClient } from './inThreadLayout';

/** The top of an exported file: what it is, when it was exported, what was masked, the options, the caution line. */
function Banner({ bundle }: { bundle: ExportBundle }) {
  const m = useMemo(() => bannerModel(bundle), [bundle]);
  return (
    <section className="viewer-banner" aria-label="导出说明">
      <p className="viewer-headline">{m.headline}</p>
      <div className="viewer-meta">
        <span className="viewer-mask">{m.maskLine}</span>
        {m.chips.map((c) => (
          <span key={c.label} className="viewer-chip">{c.label}：{c.count}</span>
        ))}
        <span className="viewer-options">{m.optionsLine}</span>
      </div>
      {m.warnings.map((w) => <p key={w} className="viewer-caution" role="note">{w}</p>)}
      <p className="viewer-caution" role="note">{m.caution}</p>
    </section>
  );
}

/**
 * The exported file's page: the banner, the session's bar (title, origin, branch, the views) and the session page's
 * canvas fed from the embedded data. Nothing navigates: the only address the page reads is the node part of its hash
 * (`#n/<id>`), which selects that step.
 */
export function Viewer({ bundle }: { bundle: ExportBundle }) {
  const source = useMemo(() => embeddedSource(bundle, createInThreadLayoutClient), [bundle]);
  const [nodeId, setNodeId] = useState<string | null>(() => viewerNodeId(window.location.hash));
  useEffect(() => {
    const onHash = (): void => setNodeId(viewerNodeId(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null);
  const session = bundle.session;
  const name = sessionName(session);
  return (
    <div className="viewer">
      <Banner bundle={bundle} />
      <div className="session-page">
        <div className="session-bar">
          <h2 title={name}>{name}</h2>
          <OriginBadge origin={session.origin} />
          {session.gitBranch !== null && <span className="muted branch" title={session.gitBranch}>{session.gitBranch}</span>}
          <div className="session-bar-end" ref={setToolbar} />
        </div>
        <SessionCanvas source={source} toolbar={toolbar} filePath={null} nodeId={nodeId} />
      </div>
    </div>
  );
}

/** The page when the data cannot be shown: the reason, full page. */
export function ViewerMessage({ message }: { message: string }) {
  return (
    <div className="viewer-message" role="alert">
      <h1>Agent Canvas 导出</h1>
      <p>{message}</p>
    </div>
  );
}
