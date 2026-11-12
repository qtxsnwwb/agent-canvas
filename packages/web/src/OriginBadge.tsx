import type { Origin } from '@agent-canvas/shared';
import { siClaude, siCursor } from 'simple-icons';
import { originLook } from './home';

/**
 * The mark shown for each origin, drawn in the badge's text colour.
 *
 * Claude Code and Cursor use their products' own marks (path data from simple-icons, CC0; the marks themselves are
 * trademarks of their owners and are used only to identify the supported tools). Codex has no mark of its own and
 * OpenAI's logo is not available under a licence we can ship, so Codex keeps a neutral terminal-prompt glyph.
 */
export const ORIGIN_MARKS: Readonly<Record<Origin, { viewBox: string; path: string } | null>> = {
  claude: { viewBox: '0 0 24 24', path: siClaude.path },
  cursor: { viewBox: '0 0 24 24', path: siCursor.path },
  codex: null,
};

function OriginIcon({ origin }: { origin: Origin }) {
  const mark = ORIGIN_MARKS[origin];
  if (mark !== null) {
    return (
      <svg className="origin-icon" viewBox={mark.viewBox} width="12" height="12" aria-hidden="true" focusable="false">
        <path d={mark.path} fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg className="origin-icon" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" focusable="false">
      {/* A terminal prompt. */}
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 3l3 3-3 3M6.5 9.5h3.5" />
      </g>
    </svg>
  );
}

/**
 * The origin of a session: a small pill with a picture and the tool's name. `iconOnly` keeps the name for screen
 * readers and the tooltip only (the project tiles' pair of dots).
 */
export function OriginBadge({ origin, iconOnly = false }: { origin: Origin; iconOnly?: boolean }) {
  const look = originLook(origin);
  return (
    <span className={`origin-badge ${look.className}${iconOnly ? ' origin-badge-dot' : ''}`} title={look.label}>
      <OriginIcon origin={origin} />
      {iconOnly ? <span className="visually-hidden">{look.label}</span> : look.label}
    </span>
  );
}
