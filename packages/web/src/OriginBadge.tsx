import type { Origin } from '@agent-canvas/shared';
import { siClaude, siCursor } from 'simple-icons';
import { originLook } from './home';
import { OPENAI_MARK_PATH } from './openaiMark';

/**
 * Placeholder marks (24×24 view box) of the origins that have none of their own yet: plain shapes, no vendor logo, one
 * per origin so the marks stay distinct.
 */
const PLACEHOLDER_MARKS = {
  gemini: 'M12 2C12.6 7.4 16.6 11.4 22 12C16.6 12.6 12.6 16.6 12 22C11.4 16.6 7.4 12.6 2 12C7.4 11.4 11.4 7.4 12 2Z',
  grok: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM4.5 18.1L18.1 4.5L19.5 5.9L5.9 19.5Z',
  copilot: 'M6 4h12a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4z',
} as const;

/**
 * The mark shown for each origin, drawn in the badge's text colour: each product's own mark. Claude Code and Cursor
 * come from simple-icons; Codex has no mark of its own and uses OpenAI's (see openaiMark.ts). The marks are trademarks
 * of their owners and are used only to identify which tool a session comes from.
 */
export const ORIGIN_MARKS: Readonly<Record<Origin, { viewBox: string; path: string }>> = {
  claude: { viewBox: '0 0 24 24', path: siClaude.path },
  cursor: { viewBox: '0 0 24 24', path: siCursor.path },
  codex: { viewBox: '0 0 24 24', path: OPENAI_MARK_PATH },
  gemini: { viewBox: '0 0 24 24', path: PLACEHOLDER_MARKS.gemini },
  grok: { viewBox: '0 0 24 24', path: PLACEHOLDER_MARKS.grok },
  copilot: { viewBox: '0 0 24 24', path: PLACEHOLDER_MARKS.copilot },
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
