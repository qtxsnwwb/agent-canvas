/** Pure planning of the changes `claude-canvas hooks install/uninstall` makes to a Claude Code settings object. */

/** The hook events claude-canvas listens to; same order as docs/hooks-snippet.json. */
export const HOOK_EVENTS: readonly string[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PermissionDenied',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'Notification',
  'Stop',
  'StopFailure',
  'PostCompact',
  'SessionEnd',
];

export const HOOK_TIMEOUT_SECONDS = 2;

export function hookUrl(port: number): string {
  return `http://127.0.0.1:${port}/hooks`;
}

export class SettingsShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsShapeError';
  }
}

export interface InstallPlan {
  next: Record<string, unknown>;
  added: string[];
  alreadyPresent: string[];
}

export interface UninstallPlan {
  next: Record<string, unknown>;
  /** Events from which at least one hook was removed. */
  removed: string[];
}

type Obj = Record<string, unknown>;

function isPlainObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Assigns an own data property, so keys such as __proto__ cannot reach the prototype setter. */
function setOwn(target: Obj, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function isOurs(hook: unknown, url: string): boolean {
  return isPlainObject(hook) && hook.type === 'http' && hook.url === url;
}

function entryHooks(entry: unknown): unknown[] | null {
  return isPlainObject(entry) && Array.isArray(entry.hooks) ? entry.hooks : null;
}

/** Validates the top-level shape and returns the (possibly absent) hooks object. */
function readHooks(settings: unknown): { root: Obj; hooks: Obj | undefined } {
  const root = settings === undefined || settings === null ? {} : settings;
  if (!isPlainObject(root)) throw new SettingsShapeError('settings 必须是 JSON 对象（键 settings 的形状不对）');
  const hooks = root.hooks;
  if (hooks !== undefined && !isPlainObject(hooks)) throw new SettingsShapeError('settings 中的 hooks 必须是对象（键 hooks 的形状不对）');
  if (hooks !== undefined) {
    for (const event of HOOK_EVENTS) {
      if (event in hooks && !Array.isArray(hooks[event])) throw new SettingsShapeError(`settings 中的 hooks.${event} 必须是数组（键 hooks.${event} 的形状不对）`);
    }
  }
  return { root, hooks };
}

/** Does not modify `settings`. An event counts as present when any entry's hooks has an http hook at our url. */
export function planInstall(settings: unknown, port: number): InstallPlan {
  const { root, hooks } = readHooks(settings);
  const url = hookUrl(port);
  const nextHooks: Obj = hooks === undefined ? {} : structuredClone(hooks);
  const added: string[] = [];
  const alreadyPresent: string[] = [];
  for (const event of HOOK_EVENTS) {
    const existing = nextHooks[event] as unknown[] | undefined;
    if (existing !== undefined && existing.some((entry) => entryHooks(entry)?.some((h) => isOurs(h, url)))) {
      alreadyPresent.push(event);
      continue;
    }
    const entry = { hooks: [{ type: 'http', url, timeout: HOOK_TIMEOUT_SECONDS }] };
    if (existing === undefined) setOwn(nextHooks, event, [entry]);
    else existing.push(entry);
    added.push(event);
  }
  return { next: { ...structuredClone(root), hooks: nextHooks }, added, alreadyPresent };
}

/** Does not modify `settings`. Removes only http hooks at our url; prunes what that leaves empty. */
export function planUninstall(settings: unknown, port: number): UninstallPlan {
  const { root, hooks } = readHooks(settings);
  const next = structuredClone(root);
  const removed: string[] = [];
  if (hooks === undefined) return { next, removed };
  const url = hookUrl(port);
  const nextHooks = next.hooks as Obj;
  for (const [event, value] of Object.entries(nextHooks)) {
    if (!Array.isArray(value)) continue;
    let touched = false;
    const kept: unknown[] = [];
    for (const entry of value) {
      const list = entryHooks(entry);
      if (list === null || !list.some((h) => isOurs(h, url))) {
        kept.push(entry);
        continue;
      }
      touched = true;
      const remaining = list.filter((h) => !isOurs(h, url));
      if (remaining.length > 0) kept.push({ ...(entry as Obj), hooks: remaining });
    }
    if (!touched) continue;
    removed.push(event);
    if (kept.length > 0) setOwn(nextHooks, event, kept);
    else delete nextHooks[event];
  }
  if (removed.length > 0 && Object.keys(nextHooks).length === 0) delete next.hooks;
  // Canonical order (known events first, in HOOK_EVENTS order) rather than the file's key order.
  const rank = (event: string): number => {
    const i = HOOK_EVENTS.indexOf(event);
    return i === -1 ? HOOK_EVENTS.length : i;
  };
  removed.sort((a, b) => rank(a) - rank(b));
  return { next, removed };
}
