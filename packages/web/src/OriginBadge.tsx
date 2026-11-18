import type { Origin } from '@agent-canvas/shared';
import { siClaude, siCursor } from 'simple-icons';
import { originLook } from './home';
import { OPENAI_MARK_PATH } from './openaiMark';

/** The rounded square the letter marks are cut from (24×24 view box). */
const TILE = 'M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5z';

/**
 * Marks of the origins without a mark we use: our own plain glyphs, a block letter cut out of a rounded square (drawn
 * with the even-odd rule), so they identify the tool without imitating any vendor logo. G for Gemini CLI, K for Grok,
 * C for Copilot CLI, D for DeepSeek, W for WorkBuddy, B for CodeBuddy (C is Copilot CLI's), O for 豆包 (Dou, a round
 * bean).
 */
const LETTER_MARKS = {
  gemini: `${TILE}M17 6v2H9v8h6v-3h-3v-2h5v7H7V6z`,
  grok: `${TILE}M7 6h2.5v5L14 6h3l-5.2 6L17 18h-3l-4.5-5v5H7z`,
  copilot: `${TILE}M17 6v2.5H9.5v7H17V18H7V6z`,
  deepseek: `${TILE}M7 6h6a4 4 0 0 1 4 4v4a4 4 0 0 1-4 4H7zM9.5 8.5v7H13a1.5 1.5 0 0 0 1.5-1.5v-4A1.5 1.5 0 0 0 13 8.5z`,
  workbuddy: `${TILE}M5.5 6h2.4l1.3 7.6L10.9 6h2.2l1.7 7.6L16.1 6h2.4L16 18h-2.3L12 10.9 10.3 18H8z`,
  codebuddy: `${TILE}M7 6h6a3 3 0 0 1 2.2 5A3.2 3.2 0 0 1 13.6 18H7zM9.5 8.3V11h3a1.35 1.35 0 0 0 0-2.7zM9.5 13.2v2.5H13a1.25 1.25 0 0 0 0-2.5z`,
  doubao: `${TILE}M12 6.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11zM12 9a3 3 0 1 1 0 6a3 3 0 1 1 0-6z`,
  // Provisional Q (a ring and a tail) until plan qwen-code, Task 5.
  qwen: `${TILE}M11.5 6.5a5 5 0 1 0 0 10a5 5 0 1 0 0-10zM11.5 8.9a2.6 2.6 0 1 1 0 5.2a2.6 2.6 0 1 1 0-5.2zM15 16.2L16.2 15l2.3 2.3l-1.2 1.2z`,
} as const;

/**
 * The mark shown for each origin, drawn in the badge's text colour. Claude Code and Cursor: the product's own mark from
 * simple-icons; Codex has no mark of its own and uses OpenAI's (see openaiMark.ts); Gemini CLI, Grok, Copilot CLI,
 * DeepSeek, WorkBuddy, CodeBuddy and 豆包: our letter marks above. The product marks are trademarks of their owners
 * and are used only to identify which tool a session comes from.
 */
export const ORIGIN_MARKS: Readonly<Record<Origin, { viewBox: string; path: string; fillRule?: 'evenodd' }>> = {
  claude: { viewBox: '0 0 24 24', path: siClaude.path },
  cursor: { viewBox: '0 0 24 24', path: siCursor.path },
  codex: { viewBox: '0 0 24 24', path: OPENAI_MARK_PATH },
  gemini: { viewBox: '0 0 24 24', path: LETTER_MARKS.gemini, fillRule: 'evenodd' },
  grok: { viewBox: '0 0 24 24', path: LETTER_MARKS.grok, fillRule: 'evenodd' },
  copilot: { viewBox: '0 0 24 24', path: LETTER_MARKS.copilot, fillRule: 'evenodd' },
  deepseek: { viewBox: '0 0 24 24', path: LETTER_MARKS.deepseek, fillRule: 'evenodd' },
  workbuddy: { viewBox: '0 0 24 24', path: LETTER_MARKS.workbuddy, fillRule: 'evenodd' },
  codebuddy: { viewBox: '0 0 24 24', path: LETTER_MARKS.codebuddy, fillRule: 'evenodd' },
  doubao: { viewBox: '0 0 24 24', path: LETTER_MARKS.doubao, fillRule: 'evenodd' },
  qwen: { viewBox: '0 0 24 24', path: LETTER_MARKS.qwen, fillRule: 'evenodd' },
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
