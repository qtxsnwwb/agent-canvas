import { parseForwardArgs } from './hook-forward.js';

/**
 * Pure planning of the changes `claude-canvas hooks install/uninstall` makes to a Claude Code settings object, and
 * (`--codex`) to Codex's `hooks.json`. Both files have the same `hooks` shape (event -> matcher groups -> handlers);
 * one core plans both, given a HookTarget: the events, the matcher group to append, and how to recognise our handler.
 */

/** What is installed and how our own handler is recognised. */
export interface HookTarget {
  readonly events: readonly string[];
  /** A fresh matcher group (`{ hooks: [handler] }`) appended to the event's array. */
  entry(event: string): Record<string, unknown>;
  /** True for a handler this installation added (and may remove). */
  isOurs(hook: unknown): boolean;
  /** One of ours that no longer matches what install would write (install replaces it). Absent: never. */
  isOutdated?(hook: unknown): boolean;
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
  /** Events whose handler of ours was outdated: removed and a fresh one appended, in the same write. */
  replaced: string[];
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

/** The entries without the handlers `drop` selects; an entry left with no handler goes too. */
function withoutHandlers(entries: unknown[], drop: (hook: unknown) => boolean): unknown[] {
  const kept: unknown[] = [];
  for (const entry of entries) {
    const list = entryHooks(entry);
    if (list === null || !list.some(drop)) {
      kept.push(entry);
      continue;
    }
    const remaining = list.filter((h) => !drop(h));
    if (remaining.length > 0) kept.push({ ...(entry as Obj), hooks: remaining });
  }
  return kept;
}

/**
 * Does not modify `settings`. An event counts as present when any of its entries holds one of our handlers that is up
 * to date; when all of ours are outdated, they are removed and a fresh entry is appended (replaced).
 */
export function planInstallFor(target: HookTarget, settings: unknown): InstallPlan {
  const { root, hooks } = readHooks(settings, target.events);
  const nextHooks: Obj = hooks === undefined ? {} : structuredClone(hooks);
  const added: string[] = [];
  const alreadyPresent: string[] = [];
  const replaced: string[] = [];
  const outdated = (h: unknown): boolean => target.isOurs(h) && (target.isOutdated?.(h) ?? false);
  for (const event of target.events) {
    let existing = nextHooks[event] as unknown[] | undefined;
    const ours = existing?.flatMap((entry) => (entryHooks(entry) ?? []).filter((h) => target.isOurs(h))) ?? [];
    if (ours.some((h) => !outdated(h))) {
      alreadyPresent.push(event);
      continue;
    }
    if (existing !== undefined && ours.length > 0) {
      existing = withoutHandlers(existing, outdated);
      setOwn(nextHooks, event, existing);
      replaced.push(event);
    } else added.push(event);
    const entry = target.entry(event);
    if (existing === undefined) setOwn(nextHooks, event, [entry]);
    else existing.push(entry);
  }
  return { next: { ...structuredClone(root), hooks: nextHooks }, added, alreadyPresent, replaced };
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
    if (!value.some((entry) => entryHooks(entry)?.some((h) => target.isOurs(h)))) continue;
    const kept = withoutHandlers(value, (h) => target.isOurs(h));
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
/** SessionEnd and Interrupt: Codex runs them synchronously and allows at most 3 seconds. */
export const CODEX_SHORT_HOOK_TIMEOUT_SECONDS = 3;
const SHORT_TIMEOUT_EVENTS: ReadonlySet<string> = new Set(['SessionEnd', 'Interrupt']);

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
  /** Paths compare case-insensitively on win32. Default: process.platform. */
  platform?: NodeJS.Platform;
}

/** `<node> <cli.js> hook-forward --origin codex --port <n>`, quoted for sh (`command`) and for Windows (`commandWindows`). */
export function codexForwardCommands(spec: CodexForwardSpec): { command: string; commandWindows: string } {
  const args = `hook-forward --origin codex --port ${spec.port}`;
  return {
    command: `${posixQuote(spec.nodePath)} ${posixQuote(spec.cliPath)} ${args}`,
    commandWindows: `${windowsQuote(spec.nodePath)} ${windowsQuote(spec.cliPath)} ${args}`,
  };
}

const BACKSLASH = '\\';

/** Splits a POSIX shell command line into words: single quotes, double quotes (with `\` escapes), `\` escapes. */
export function splitPosix(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      cur += end === -1 ? line.slice(i + 1) : line.slice(i + 1, end);
      i = end === -1 ? line.length : end;
      inWord = true;
    } else if (c === '"') {
      inWord = true;
      for (i++; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === BACKSLASH && i + 1 < line.length && ['$', '`', '"', BACKSLASH, '\n'].includes(line[i + 1]!)) i++;
        cur += line[i];
      }
    } else if (c === BACKSLASH && i + 1 < line.length) {
      cur += line[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) out.push(cur);
      cur = '';
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (inWord) out.push(cur);
  return out;
}

/** Splits a Windows command line into arguments as CommandLineToArgvW does (2n backslashes + `"` = n and a quote toggle). */
export function splitWindows(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === BACKSLASH) {
      let n = 0;
      while (line[i + n] === BACKSLASH) n++;
      if (line[i + n] === '"') {
        cur += BACKSLASH.repeat(Math.floor(n / 2));
        if (n % 2 === 1) cur += '"';
        else quoted = !quoted;
        i += n;
      } else {
        cur += BACKSLASH.repeat(n);
        i += n - 1;
      }
      inWord = true;
    } else if (c === '"') {
      quoted = !quoted;
      inWord = true;
    } else if (!quoted && (c === ' ' || c === '\t')) {
      if (inWord) out.push(cur);
      cur = '';
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (inWord) out.push(cur);
  return out;
}

/**
 * Codex: one async command hook per event running the forwarder (SessionEnd / Interrupt with Codex's 3 s maximum).
 * Ours = a command handler whose `command` (split as sh does) or `commandWindows` (split as Windows does) has this
 * installation's cli.js as a word, `hook-forward` right after it, and the forwarder's port (`--port n`, `--port=n`,
 * default 4317) equal to ours; paths compare case-insensitively on win32. Outdated = ours, but the word before the
 * cli.js (the node binary) is not the current one, e.g. after a node upgrade.
 */
export function codexHookTarget(spec: CodexForwardSpec): HookTarget {
  const { command, commandWindows } = codexForwardCommands(spec);
  const win = (spec.platform ?? process.platform) === 'win32';
  const norm = (p: string): string => (win ? p.replace(/\//g, BACKSLASH).toLowerCase() : p);
  const samePath = (a: string, b: string): boolean => norm(a) === norm(b);
  /** The node word of our forwarder command (null when none precedes the cli.js); undefined = not ours. */
  const nodeOf = (cmd: unknown, split: (line: string) => string[]): string | null | undefined => {
    if (typeof cmd !== 'string') return undefined;
    const words = split(cmd);
    const at = words.findIndex((w) => samePath(w, spec.cliPath));
    if (at === -1 || words[at + 1] !== 'hook-forward') return undefined;
    if (parseForwardArgs(words.slice(at + 2)).port !== spec.port) return undefined;
    return at > 0 ? words[at - 1]! : null;
  };
  const nodes = (hook: unknown): (string | null)[] => {
    if (!isPlainObject(hook) || hook.type !== 'command') return [];
    return [nodeOf(hook.command, splitPosix), nodeOf(hook.commandWindows, splitWindows)].filter((x): x is string | null => x !== undefined);
  };
  return {
    events: CODEX_HOOK_EVENTS,
    entry: (event) => ({
      hooks: [
        {
          type: 'command',
          command,
          commandWindows,
          async: true,
          timeout: SHORT_TIMEOUT_EVENTS.has(event) ? CODEX_SHORT_HOOK_TIMEOUT_SECONDS : CODEX_HOOK_TIMEOUT_SECONDS,
        },
      ],
    }),
    isOurs: (hook) => nodes(hook).length > 0,
    isOutdated: (hook) => nodes(hook).some((n) => n === null || !samePath(n, spec.nodePath)),
  };
}
