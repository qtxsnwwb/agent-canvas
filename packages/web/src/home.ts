import type { Project } from '@claude-canvas/shared';

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
