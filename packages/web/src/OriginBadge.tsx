import type { Origin } from '@agent-canvas/shared';
import { siClaude, siCursor } from 'simple-icons';
import { originLook } from './home';
import { OPENAI_MARK_PATH } from './openaiMark';

/** The rounded square the letter marks are cut from (24×24 view box). */
const TILE = 'M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5z';

/**
 * Marks of the origins without a mark we use: our own plain glyphs, a block letter cut out of a rounded square (drawn
 * with the even-odd rule), so they identify the tool without imitating any vendor logo. G for Gemini CLI, K for Grok,
 * C for Copilot CLI.
 */
const LETTER_MARKS = {
  gemini: `${TILE}M17 6v2H9v8h6v-3h-3v-2h5v7H7V6z`,
  grok: `${TILE}M7 6h2.5v5L14 6h3l-5.2 6L17 18h-3l-4.5-5v5H7z`,
  copilot: `${TILE}M17 6v2.5H9.5v7H17V18H7V6z`,
} as const;

/**
 * The mark shown for each origin, drawn in the badge's text colour. Claude Code and Cursor: the product's own mark from
 * simple-icons; Codex has no mark of its own and uses OpenAI's (see openaiMark.ts); Gemini CLI, Grok and Copilot CLI:
 * our letter marks above. The product marks are trademarks of their owners and are used only to identify which tool a
 * session comes from.
 */
export const ORIGIN_MARKS: Readonly<Record<Origin, { viewBox: string; path: string; fillRule?: 'evenodd' }>> = {
  claude: { viewBox: '0 0 24 24', path: siClaude.path },
  cursor: { viewBox: '0 0 24 24', path: siCursor.path },
  codex: { viewBox: '0 0 24 24', path: OPENAI_MARK_PATH },
  gemini: { viewBox: '0 0 24 24', path: LETTER_MARKS.gemini, fillRule: 'evenodd' },
  grok: { viewBox: '0 0 24 24', path: LETTER_MARKS.grok, fillRule: 'evenodd' },
  copilot: { viewBox: '0 0 24 24', path: LETTER_MARKS.copilot, fillRule: 'evenodd' },
};

function OriginIcon({ origin }: { origin: Origin }) {
  const mark = ORIGIN_MARKS[origin];
  return (
    <svg className="origin-icon" viewBox={mark.viewBox} width="12" height="12" aria-hidden="true" focusable="false">
      <path d={mark.path} fill="currentColor" fillRule={mark.fillRule} />
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
