import type { Origin } from '@agent-canvas/shared';
import { siClaude, siCursor } from 'simple-icons';
import { originLook } from './home';
import { OPENAI_MARK_PATH } from './openaiMark';

/**
 * The mark shown for each origin, drawn in the badge's text colour: each product's own mark. Claude Code and Cursor
 * come from simple-icons; Codex has no mark of its own and uses OpenAI's (see openaiMark.ts). The marks are trademarks
 * of their owners and are used only to identify which tool a session comes from.
 */
export const ORIGIN_MARKS: Readonly<Record<Origin, { viewBox: string; path: string }>> = {
  claude: { viewBox: '0 0 24 24', path: siClaude.path },
  cursor: { viewBox: '0 0 24 24', path: siCursor.path },
  codex: { viewBox: '0 0 24 24', path: OPENAI_MARK_PATH },
};

function OriginIcon({ origin }: { origin: Origin }) {
  const mark = ORIGIN_MARKS[origin];
  return (
    <svg className="origin-icon" viewBox={mark.viewBox} width="12" height="12" aria-hidden="true" focusable="false">
      <path d={mark.path} fill="currentColor" />
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
