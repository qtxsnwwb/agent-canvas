import type { Origin } from '@agent-canvas/shared';
import { originLook } from './home';

/** A tiny line picture per origin, drawn in the badge's text colour. */
function OriginIcon({ origin }: { origin: Origin }) {
  return (
    <svg className="origin-icon" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" focusable="false">
      {origin === 'claude' ? (
        // A sunburst.
        <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M6 1.2v9.6M1.2 6h9.6M2.6 2.6l6.8 6.8M9.4 2.6l-6.8 6.8" />
        </g>
      ) : origin === 'cursor' ? (
        // A pointer arrow.
        <path d="M2.2 1.6l7.6 3.7-3.2 1.1-1.1 3.3z" fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
      ) : (
        // A terminal prompt.
        <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 3l3 3-3 3M6.5 9.5h3.5" />
        </g>
      )}
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
