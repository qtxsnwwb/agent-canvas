import { ORIGINS, type Origin, type Project } from '@claude-canvas/shared';

/** How an origin is shown: its name and the CSS class that colours its badge (styles.css, `.origin-badge`). */
export const ORIGIN_LOOK: Record<Origin, { label: string; className: string }> = {
  claude: { label: 'Claude Code', className: 'origin-claude' },
  codex: { label: 'Codex', className: 'origin-codex' },
};

export function originLook(origin: Origin): { label: string; className: string } {
  return ORIGIN_LOOK[origin];
}

/** The home page's origin filter. */
export type OriginFilter = 'all' | Origin;
/** The viewer's filter choice, remembered in this browser (like the density switch). */
export const ORIGIN_FILTER_KEY = 'claude-canvas.origin';
export const ORIGIN_FILTER_OPTIONS: readonly { value: OriginFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  ...ORIGINS.map((o) => ({ value: o, label: ORIGIN_LOOK[o].label })),
];

/** A stored filter value; anything unknown (or nothing) is `all`. */
export function parseOriginFilter(value: string | null): OriginFilter {
  return value === 'all' || (ORIGINS as readonly string[]).includes(value ?? '') ? (value as OriginFilter) : 'all';
}

/** The filter is offered only once some project has Codex sessions (a Claude-only install looks as before). */
export function showOriginFilter(projects: readonly Project[]): boolean {
  return projects.some((p) => p.origins.includes('codex'));
}

/** The filter in force: the chosen one while the filter is offered, `all` otherwise. */
export function effectiveOriginFilter(chosen: OriginFilter, projects: readonly Project[]): OriginFilter {
  return showOriginFilter(projects) ? chosen : 'all';
}

export function matchesOrigin(filter: OriginFilter, origin: Origin): boolean {
  return filter === 'all' || filter === origin;
}

/** Projects with at least one session of the filtered origin, in their order. */
export function visibleProjects(projects: readonly Project[], filter: OriginFilter): Project[] {
  return filter === 'all' ? [...projects] : projects.filter((p) => p.origins.includes(filter));
}

/** The project strip: the visible projects plus the selected one when the filter hides it (order kept). */
export function stripProjects(projects: readonly Project[], filter: OriginFilter, selectedId: string | null): Project[] {
  return projects.filter((p) => p.id === selectedId || filter === 'all' || p.origins.includes(filter));
}

/** The project shown: the one in the address (even when the filter hides it), else the busiest visible one. */
export function shownProjectId(addressId: string | null, projects: readonly Project[], filter: OriginFilter): string | null {
  return addressId ?? pickProject(visibleProjects(projects, filter))?.id ?? null;
}

/**
 * Whether a project's session counts are right under the filter: the API counts every origin together, so they are
 * only right for `all` or a project that has no other origin.
 */
export function projectCountsExact(project: Project, filter: OriginFilter): boolean {
  return filter === 'all' || project.origins.every((o) => o === filter);
}

/** The hero's totals under the filter; sessions / active are null when the API's counts cannot give them exactly. */
export function heroTotals(projects: readonly Project[], filter: OriginFilter): { projects: number; sessions: number | null; active: number | null } {
  const visible = visibleProjects(projects, filter);
  if (!visible.every((p) => projectCountsExact(p, filter))) return { projects: visible.length, sessions: null, active: null };
  return {
    projects: visible.length,
    sessions: visible.reduce((n, p) => n + p.sessionCount, 0),
    active: visible.reduce((n, p) => n + p.activeSessionCount, 0),
  };
}

/** The last segment of a path (either separator), or the whole string when there is none. */
export function projectName(pathOrId: string): string {
  const parts = pathOrId.split(/[\\/]+/).filter((x) => x !== '');
  return parts[parts.length - 1] ?? pathOrId;
}

const AVATARS = ['🚀', '🧩', '🛠️', '🌈', '🎯', '🪄', '🧪', '🎈'] as const;
const HUES = [340, 265, 200, 160, 45, 20, 290, 130] as const;

/** A stable picture and hue for a project, from its id (the same project always looks the same). */
export function projectLook(id: string): { emoji: string; hue: number } {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return { emoji: AVATARS[h % AVATARS.length]!, hue: HUES[(h >>> 3) % HUES.length]! };
}

/** The project to show when none is chosen: the one with the most active sessions, then the most sessions; null for none. */
export function pickProject(projects: readonly Project[]): Project | null {
  let best: Project | null = null;
  for (const p of projects) {
    if (best === null || p.activeSessionCount > best.activeSessionCount
      || (p.activeSessionCount === best.activeSessionCount && p.sessionCount > best.sessionCount)) best = p;
  }
  return best;
}

/** "刚刚", "5 分钟前", "3 小时前", "昨天", "4 天前", then the date; '' for an unreadable time. */
export function relativeTime(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86_400) return `${Math.floor(s / 3600)} 小时前`;
  const days = Math.floor(s / 86_400);
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  return new Date(t).toLocaleDateString();
}
