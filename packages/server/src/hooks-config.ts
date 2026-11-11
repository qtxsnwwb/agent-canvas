/**
 * Pure planning of the changes `claude-canvas hooks install/uninstall` makes to a Claude Code settings object, and
 * (`--codex`) to Codex's `hooks.json`. Both files have the same `hooks` shape (event -> matcher groups -> handlers);
 * one core plans both, given a HookTarget: the events, the matcher group to append, and how to recognise our handler.
 */

/** What is installed and how our own handler is recognised. */
export interface HookTarget {
  readonly events: readonly string[];
  /** A fresh matcher group (`{ hooks: [handler] }`) appended to an event's array. */
  entry(): Record<string, unknown>;
  /** True for a handler this installation added (and may remove). */
  isOurs(hook: unknown): boolean;
}

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

function entryHooks(entry: unknown): unknown[] | null {
  return isPlainObject(entry) && Array.isArray(entry.hooks) ? entry.hooks : null;
}

/** Validates the top-level shape and returns the (possibly absent) hooks object. */
function readHooks(settings: unknown, events: readonly string[]): { root: Obj; hooks: Obj | undefined } {
  const root = settings === undefined || settings === null ? {} : settings;
  if (!isPlainObject(root)) throw new SettingsShapeError('settings 必须是 JSON 对象（键 settings 的形状不对）');
  const hooks = root.hooks;
  if (hooks !== undefined && !isPlainObject(hooks)) throw new SettingsShapeError('settings 中的 hooks 必须是对象（键 hooks 的形状不对）');
  if (hooks !== undefined) {
    for (const event of events) {
      if (event in hooks && !Array.isArray(hooks[event])) throw new SettingsShapeError(`settings 中的 hooks.${event} 必须是数组（键 hooks.${event} 的形状不对）`);
    }
  }
  return { root, hooks };
}

/** Does not modify `settings`. An event counts as present when any of its entries holds one of our handlers. */
export function planInstallFor(target: HookTarget, settings: unknown): InstallPlan {
  const { root, hooks } = readHooks(settings, target.events);
  const nextHooks: Obj = hooks === undefined ? {} : structuredClone(hooks);
  const added: string[] = [];
  const alreadyPresent: string[] = [];
  for (const event of target.events) {
    const existing = nextHooks[event] as unknown[] | undefined;
    if (existing !== undefined && existing.some((entry) => entryHooks(entry)?.some((h) => target.isOurs(h)))) {
      alreadyPresent.push(event);
      continue;
    }
    const entry = target.entry();
    if (existing === undefined) setOwn(nextHooks, event, [entry]);
    else existing.push(entry);
    added.push(event);
  }
  return { next: { ...structuredClone(root), hooks: nextHooks }, added, alreadyPresent };
}

/** Does not modify `settings`. Removes only our handlers; prunes what that leaves empty. */
export function planUninstallFor(target: HookTarget, settings: unknown): UninstallPlan {
  const { root, hooks } = readHooks(settings, target.events);
  const next = structuredClone(root);
  const removed: string[] = [];
  if (hooks === undefined) return { next, removed };
  const nextHooks = next.hooks as Obj;
  for (const [event, value] of Object.entries(nextHooks)) {
    if (!Array.isArray(value)) continue;
    let touched = false;
    const kept: unknown[] = [];
    for (const entry of value) {
      const list = entryHooks(entry);
      if (list === null || !list.some((h) => target.isOurs(h))) {
        kept.push(entry);
        continue;
      }
      touched = true;
      const remaining = list.filter((h) => !target.isOurs(h));
      if (remaining.length > 0) kept.push({ ...(entry as Obj), hooks: remaining });
    }
    if (!touched) continue;
    removed.push(event);
    if (kept.length > 0) setOwn(nextHooks, event, kept);
    else delete nextHooks[event];
  }
  if (removed.length > 0 && Object.keys(nextHooks).length === 0) delete next.hooks;
  // Canonical order (known events first, in the target's order) rather than the file's key order.
  const rank = (event: string): number => {
    const i = target.events.indexOf(event);
    return i === -1 ? target.events.length : i;
  };
  removed.sort((a, b) => rank(a) - rank(b));
  return { next, removed };
}

/** Claude Code: one http hook per event at our url. */
export function claudeHookTarget(port: number): HookTarget {
  const url = hookUrl(port);
  return {
    events: HOOK_EVENTS,
    entry: () => ({ hooks: [{ type: 'http', url, timeout: HOOK_TIMEOUT_SECONDS }] }),
    isOurs: (hook) => isPlainObject(hook) && hook.type === 'http' && hook.url === url,
  };
}

/** Does not modify `settings`. An event counts as present when any entry's hooks has an http hook at our url. */
export function planInstall(settings: unknown, port: number): InstallPlan {
  return planInstallFor(claudeHookTarget(port), settings);
}

/** Does not modify `settings`. Removes only http hooks at our url; prunes what that leaves empty. */
export function planUninstall(settings: unknown, port: number): UninstallPlan {
  return planUninstallFor(claudeHookTarget(port), settings);
}

// ---------------------------------------------------------------- Codex

/** The Codex hook events claude-canvas listens to (spec 7.2; not PreModelRequest, PostModelRequest, PreCompact). */
export const CODEX_HOOK_EVENTS: readonly string[] = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'PostCompact',
  'Interrupt',
];

export const CODEX_HOOK_TIMEOUT_SECONDS = 5;

/** One argument for a POSIX shell: single-quoted, an inner `'` written as `'\''`. */
export function posixQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * One argument for a Windows command line (CreateProcess / cmd.exe): double-quoted, an inner `"` escaped, and the
 * backslashes before a quote doubled (so a trailing `\` does not escape the closing quote). Other backslashes stay.
 */
export function windowsQuote(arg: string): string {
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

export interface CodexForwardSpec {
  /** Absolute path of the node binary (process.execPath at install time). */
  nodePath: string;
  /** Absolute path of this installation's cli.js. */
  cliPath: string;
  port: number;
}

/** `<node> <cli.js> hook-forward --origin codex --port <n>`, quoted for sh (`command`) and for Windows (`commandWindows`). */
export function codexForwardCommands(spec: CodexForwardSpec): { command: string; commandWindows: string } {
  const args = `hook-forward --origin codex --port ${spec.port}`;
  return {
    command: `${posixQuote(spec.nodePath)} ${posixQuote(spec.cliPath)} ${args}`,
    commandWindows: `${windowsQuote(spec.nodePath)} ${windowsQuote(spec.cliPath)} ${args}`,
  };
}

/**
 * Codex: one async command hook per event running the forwarder. Ours = a command handler whose `command` or
 * `commandWindows` names this installation's cli.js, `hook-forward`, and the same port (`--port <n>` as a whole word).
 */
export function codexHookTarget(spec: CodexForwardSpec): HookTarget {
  const { command, commandWindows } = codexForwardCommands(spec);
  const portArg = new RegExp(`(^|\\s)--port\\s+${spec.port}(\\s|$)`);
  const matches = (cmd: unknown): boolean =>
    typeof cmd === 'string' && cmd.includes(spec.cliPath) && /(^|\s)hook-forward(\s|$)/.test(cmd) && portArg.test(cmd);
  return {
    events: CODEX_HOOK_EVENTS,
    entry: () => ({ hooks: [{ type: 'command', command, commandWindows, async: true, timeout: CODEX_HOOK_TIMEOUT_SECONDS }] }),
    isOurs: (hook) => isPlainObject(hook) && hook.type === 'command' && (matches(hook.command) || matches(hook.commandWindows)),
  };
}
