import type { TodayUsage } from '@agent-canvas/shared';
import { headerToday } from './today';

/**
 * The header's 今天 item (spec 2026-11-24-today-usage-design.md 4.1), right after 待处理: today's new input + output,
 * in the warning colour once at or over the line; it opens the stats page scrolled to the top, where the 今天 block is
 * (also when the stats page is already open: the hash does not change then).
 */
export function TodayHeaderLink({ usage }: { usage: TodayUsage | null }) {
  const h = headerToday(usage);
  return (
    <a className={`header-link header-link-next header-today${h.over ? ' is-over' : ''}`} href="#/stats" aria-label={h.label}
      onClick={() => window.scrollTo({ top: 0 })}>
      今天{h.num !== null && <span className="header-today-num" aria-hidden="true">{h.num}</span>}
    </a>
  );
}
