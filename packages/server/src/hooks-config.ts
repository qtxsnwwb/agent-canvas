import { parseForwardArgs } from './hook-forward.js';

/**
 * Pure planning of the changes `agent-canvas hooks install/uninstall` makes to a Claude Code settings object, and
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
  /**
   * The event arrays hold handlers directly (Cursor: `hooks.<event>: [{ command, timeout }]`) instead of matcher groups
   * (`{ hooks: [handler] }`); `entry` then returns the handler itself.
   */
  flat?: boolean;
}

/** The hook events agent-canvas listens to; same order as docs/hooks-snippet.json. */
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
  /**
   * Events whose handler of ours was outdated: replaced in place (same event, same group index, same handler index),
   * in the same write; further outdated handlers of ours in that event are removed.
   */
  replaced: string[];
  /** Events where a handler that is not ours changed position (group or handler index). Absent when none. */
  shifted?: string[];
}

export interface UninstallPlan {
  next: Record<string, unknown>;
  /** Events from which at least one hook was removed. */
  removed: string[];
  /**
   * Events where a handler that is not ours changed position (group or handler index) because one of ours before it
   * was removed. Absent when none. Matters for Codex, which keys a hook's trust by its position.
   */
  shifted?: string[];
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

/** The handlers of one entry of an event array: the entry itself for a flat target. */
function handlersOf(target: HookTarget, entry: unknown): unknown[] | null {
  return target.flat === true ? [entry] : entryHooks(entry);
}

/** What happens to one handler: kept, dropped, or replaced by another in the same place. */
type HandlerAction = 'keep' | 'drop' | { replace: unknown };

/**
 * Applies `decide` to every handler of an event's entries (to every entry for a flat target). A group left with no
 * handler goes too (an originally empty group stays). `shifted`: a kept handler that is not ours now sits at another
 * position (group index, handler index) than before.
 */
function rewriteHandlers(target: HookTarget, entries: unknown[], decide: (hook: unknown) => HandlerAction): { entries: unknown[]; shifted: boolean } {
  const out: unknown[] = [];
  let shifted = false;
  entries.forEach((entry, gi) => {
    if (target.flat === true) {
      const d = decide(entry);
      if (d === 'drop') return;
      if (d !== 'keep') out.push(d.replace);
      else {
        if (!target.isOurs(entry) && out.length !== gi) shifted = true;
        out.push(entry);
      }
      return;
    }
    const list = entryHooks(entry);
    if (list === null) {
      if (out.length !== gi) shifted = true;
      out.push(entry);
      return;
    }
    const group = out.length;
    const kept: unknown[] = [];
    let changed = false;
    list.forEach((hook, hi) => {
      const d = decide(hook);
      if (d === 'keep') {
        if (!target.isOurs(hook) && (group !== gi || kept.length !== hi)) shifted = true;
        kept.push(hook);
      } else {
        changed = true;
        if (d !== 'drop') kept.push(d.replace);
      }
    });
    if (!changed) out.push(entry);
    else if (kept.length > 0) out.push({ ...(entry as Obj), hooks: kept });
  });
  return { entries: out, shifted };
}

/** Sorts events in the target's order (unknown ones last), in place. */
function sortEvents(target: HookTarget, events: string[]): string[] {
  const rank = (event: string): number => {
    const i = target.events.indexOf(event);
    return i === -1 ? target.events.length : i;
  };
  return events.sort((a, b) => rank(a) - rank(b));
}

/** The handler to put in place of an outdated one: the entry itself (flat), else the entry's only handler. */
function freshHandler(target: HookTarget, event: string): unknown {
  const entry = target.entry(event);
  return target.flat === true ? entry : (entryHooks(entry) ?? [])[0];
}

/**
 * Does not modify `settings`. An event counts as present when any of its entries holds one of our handlers that is up
 * to date. When all of ours are outdated, the first is replaced in place (same group index, same handler index: Codex
 * keys a hook's trust by its position, so other people's hooks keep theirs) and any further ones are removed
 * (replaced). An event without one of ours gets a fresh entry appended (added).
 */
export function planInstallFor(target: HookTarget, settings: unknown): InstallPlan {
  const { root, hooks } = readHooks(settings, target.events);
  const nextHooks: Obj = hooks === undefined ? {} : structuredClone(hooks);
  const added: string[] = [];
  const alreadyPresent: string[] = [];
  const replaced: string[] = [];
  const shifted: string[] = [];
  const outdated = (h: unknown): boolean => target.isOurs(h) && (target.isOutdated?.(h) ?? false);
  for (const event of target.events) {
    const existing = nextHooks[event] as unknown[] | undefined;
    const ours = existing?.flatMap((entry) => (handlersOf(target, entry) ?? []).filter((h) => target.isOurs(h))) ?? [];
    if (ours.some((h) => !outdated(h))) {
      alreadyPresent.push(event);
      continue;
    }
    if (existing !== undefined && ours.length > 0) {
      const fresh = freshHandler(target, event);
      let done = false;
      const r = rewriteHandlers(target, existing, (h) => {
        if (!outdated(h)) return 'keep';
        if (done) return 'drop';
        done = true;
        return { replace: fresh };
      });
      setOwn(nextHooks, event, r.entries);
      replaced.push(event);
      if (r.shifted) shifted.push(event);
      continue;
    }
    added.push(event);
    const entry = target.entry(event);
    if (existing === undefined) setOwn(nextHooks, event, [entry]);
    else existing.push(entry);
  }
  return { next: { ...structuredClone(root), hooks: nextHooks }, added, alreadyPresent, replaced, ...(shifted.length > 0 ? { shifted } : {}) };
}

/**
 * Does not modify `settings`. Removes only our handlers; prunes what that leaves empty (an empty group is not left in
 * place: whether Codex accepts one is unknown). Reports the events where that moved someone else's handler.
 */
export function planUninstallFor(target: HookTarget, settings: unknown): UninstallPlan {
  const { root, hooks } = readHooks(settings, target.events);
  const next = structuredClone(root);
  const removed: string[] = [];
  const shifted: string[] = [];
  if (hooks === undefined) return { next, removed };
  const nextHooks = next.hooks as Obj;
  for (const [event, value] of Object.entries(nextHooks)) {
    if (!Array.isArray(value)) continue;
    if (!value.some((entry) => handlersOf(target, entry)?.some((h) => target.isOurs(h)))) continue;
    const r = rewriteHandlers(target, value, (h) => (target.isOurs(h) ? 'drop' : 'keep'));
    removed.push(event);
    if (r.shifted) shifted.push(event);
    if (r.entries.length > 0) setOwn(nextHooks, event, r.entries);
    else delete nextHooks[event];
  }
  if (removed.length > 0 && Object.keys(nextHooks).length === 0) delete next.hooks;
  // Canonical order (known events first, in the target's order) rather than the file's key order.
  sortEvents(target, removed);
  if (shifted.length === 0) return { next, removed };
  return { next, removed, shifted: sortEvents(target, shifted) };
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

/** The Codex hook events agent-canvas listens to (spec 7.2; not PreModelRequest, PostModelRequest, PreCompact). */
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
/**
 * SessionEnd and Interrupt: Codex allows at most 3 seconds for these two (it clamps to 1..3). SessionEnd also runs
 * synchronously even with `async: true`; Interrupt does run in the background (Codex source at 75fc67e).
 */
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
  /**
   * Windows only: the 8.3 short form of an existing path, or null (win-short-path.ts `windowsShortPath`). Asked only
   * for a path that is not a plain token. Absent: no short forms (the PowerShell call form is used for such a path).
   */
  shortPath?: (longPath: string) => string | null;
  /**
   * Windows only: whether an absolute plain word names the same existing file as `longPath` (win-short-path.ts
   * `sameExistingFile`). Lets an installed unquoted entry count as up to date when this run's short-path lookup
   * failed. Absent: words are compared by name only.
   */
  sameFile?: (word: string, longPath: string) => boolean;
}

/**
 * A word every shell Codex may use on Windows (PowerShell, cmd.exe) takes literally without quotes. `@` is allowed
 * except as the first character (PowerShell reads a leading `@` as splatting or an `@(` / `@{` literal): a scoped npm
 * package's path (`…\node_modules\@scope\…`) is one plain word.
 */
const PLAIN_TOKEN = /^[A-Za-z0-9_.:\\/~-][A-Za-z0-9_.:\\/~@-]*$/;

/** True when `word` needs no quoting in PowerShell or cmd.exe: letters, digits, `_ . : \ / ~ -`, and `@` after the first character. */
export function isPlainToken(word: string): boolean {
  return PLAIN_TOKEN.test(word);
}

/** A hook command that cannot be written safely (the message is ready to print). */
export class HookCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HookCommandError';
  }
}

/** What PowerShell interprets inside double quotes (the typographic double quotes count as `"`). */
const POWERSHELL_UNSAFE = /[`$"“”„]/;

/** `plain`: form A, unquoted words (runs in PowerShell and cmd.exe). `call`: form E, `& "<node>" "<cli.js>" …` (PowerShell only). */
export type CodexWindowsForm = 'plain' | 'call';

interface CodexWindowsPlan {
  /** null when refused. */
  commandWindows: string | null;
  form: CodexWindowsForm | null;
  refused: string | null;
  /** The words that name our node binary / cli.js in a commandWindows: the long path, and the short form when used. */
  nodeNames: string[];
  cliNames: string[];
}

/**
 * Codex runs `commandWindows` through the session's shell — PowerShell (`-NoProfile -Command <line>`) normally, and
 * `cmd.exe /C` only when its local environment is not ready (codex-rs at 75fc67e: core/src/session/mod.rs
 * build_hooks_config, hooks/src/engine/command_runner.rs build_command). A line starting with a quoted path is a parse
 * error in PowerShell, and `& "…"` is one in cmd; only unquoted words work in both. So: form A when both paths can be
 * written plain (a path that is not plain replaced by its 8.3 short form, when that is plain), else form E.
 */
function planCodexWindows(spec: CodexForwardSpec): CodexWindowsPlan {
  const win = (spec.platform ?? process.platform) === 'win32';
  const tail = `hook-forward --origin codex --port ${spec.port}`;
  const plainOf = (p: string): string | null => {
    if (isPlainToken(p)) return p;
    if (!win || spec.shortPath === undefined) return null;
    const s = spec.shortPath(p);
    return s !== null && isPlainToken(s) ? s : null;
  };
  const node = plainOf(spec.nodePath);
  const cli = plainOf(spec.cliPath);
  const names = (long: string, plain: string | null): string[] => (plain !== null && plain !== long ? [long, plain] : [long]);
  const base = { nodeNames: names(spec.nodePath, node), cliNames: names(spec.cliPath, cli) };
  if (node !== null && cli !== null) return { ...base, commandWindows: `${node} ${cli} ${tail}`, form: 'plain', refused: null };
  // Form E: a word that has a plain form is written bare; only a path without one is double-quoted, and refused on
  // Windows when it holds a character PowerShell interprets inside double quotes.
  const unsafe = [[spec.nodePath, node] as const, [spec.cliPath, cli] as const].find(([p, plain]) => plain === null && POWERSHELL_UNSAFE.test(p))?.[0];
  if (win && unsafe !== undefined) {
    return {
      ...base,
      commandWindows: null,
      form: null,
      refused: `路径 ${unsafe} 含有 PowerShell 会解释的字符（" \` $ 或中文引号 “ ” „），也没有可用的 8.3 短路径，无法安全地写成 Codex 的 hook 命令；请把 node 或 agent-canvas 装到不含这些字符的路径`,
    };
  }
  const word = (long: string, plain: string | null): string => plain ?? powershellQuote(long);
  return { ...base, commandWindows: `& ${word(spec.nodePath, node)} ${word(spec.cliPath, cli)} ${tail}`, form: 'call', refused: null };
}

/**
 * `<node> <cli.js> hook-forward --origin codex --port <n>`: POSIX-quoted for sh (`command`); for Windows
 * (`commandWindows`) unquoted with plain or 8.3 short paths when possible (form A), else the PowerShell call form
 * (form E, see planCodexWindows). Throws HookCommandError on Windows when no safe form exists.
 */
export function codexForwardCommands(spec: CodexForwardSpec): { command: string; commandWindows: string; windowsForm: CodexWindowsForm } {
  const w = planCodexWindows(spec);
  if (w.commandWindows === null || w.form === null) throw new HookCommandError(w.refused ?? 'commandWindows');
  return {
    command: `${posixQuote(spec.nodePath)} ${posixQuote(spec.cliPath)} hook-forward --origin codex --port ${spec.port}`,
    commandWindows: w.commandWindows,
    windowsForm: w.form,
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
 * A commandWindows in the PowerShell call form (`& …`, split as PowerShell does), else a command line split as Windows
 * does: `plain` when it has no quote at all (form A), `quoted` otherwise (form D, what earlier versions wrote).
 */
function splitWindowsCommand(cmd: string): { words: string[]; kind: CodexWindowsForm | 'quoted' } {
  const trimmed = cmd.trimStart();
  if (trimmed.startsWith('&')) return { words: splitPowerShell(trimmed.slice(1)), kind: 'call' };
  return { words: splitWindows(trimmed), kind: trimmed.includes('"') ? 'quoted' : 'plain' };
}

/**
 * Codex: one async command hook per event running the forwarder (SessionEnd / Interrupt with Codex's 3 s maximum).
 * Ours = a command handler whose `command` (split as sh does) or `commandWindows` (any form this or an earlier version
 * wrote: unquoted, `"…" "…"`, or `& "…" "…"`) has this installation's cli.js as a word — its long path or the short
 * form install uses — with `hook-forward` right after it and the forwarder's port (`--port n`, `--port=n`, default
 * 4317) equal to ours; paths compare case-insensitively on win32. Outdated = ours, but the node word is missing or not
 * the current node binary (e.g. after a node upgrade), or — on Windows, where Codex runs it — the commandWindows is
 * missing or not in the form install writes now (e.g. the `"<node>" "<cli.js>" …` form earlier versions wrote, which
 * PowerShell cannot run). An unquoted commandWindows whose words name the current node and cli.js (by name, or by file
 * through spec.sameFile) is up to date even when this run would write another form, e.g. after a failed short-path
 * lookup: rewriting it would only cost the user Codex's trust.
 */
export function codexHookTarget(spec: CodexForwardSpec): HookTarget {
  const w = planCodexWindows(spec);
  const command = `${posixQuote(spec.nodePath)} ${posixQuote(spec.cliPath)} hook-forward --origin codex --port ${spec.port}`;
  const win = (spec.platform ?? process.platform) === 'win32';
  const norm = (p: string): string => (win ? p.replace(/\//g, BACKSLASH).toLowerCase() : p);
  const samePath = (a: string, b: string): boolean => norm(a) === norm(b);
  /** Same file by name, or (Windows, an absolute plain word) by asking spec.sameFile. */
  const names = (known: string[], long: string) => (word: string, viaFile: boolean): boolean =>
    known.some((n) => samePath(n, word)) ||
    (viaFile && win && spec.sameFile !== undefined && isPlainToken(word) && /^([A-Za-z]:\\|\\\\)/.test(word) && spec.sameFile(word, long));
  const nodeName = names(w.nodeNames, spec.nodePath);
  const cliName = names(w.cliNames, spec.cliPath);
  /** The node word of our forwarder command (null when none precedes the cli.js); undefined = not ours. */
  const nodeOf = (words: string[], viaFile = false): string | null | undefined => {
    const at = words.findIndex((word) => cliName(word, viaFile));
    if (at === -1 || words[at + 1] !== 'hook-forward') return undefined;
    if (parseForwardArgs(words.slice(at + 2)).port !== spec.port) return undefined;
    return at > 0 ? words[at - 1]! : null;
  };
  /** undefined = not ours; else whether it is outdated. */
  const inspect = (hook: unknown): boolean | undefined => {
    if (!isPlainObject(hook) || hook.type !== 'command') return undefined;
    const posixNode = typeof hook.command === 'string' ? nodeOf(splitPosix(hook.command)) : undefined;
    const winSplit = typeof hook.commandWindows === 'string' ? splitWindowsCommand(hook.commandWindows) : undefined;
    // An unquoted line's words may be short forms this run could not look up: those may be matched by file.
    const viaFile = winSplit?.kind === 'plain';
    const winNode = winSplit !== undefined ? nodeOf(winSplit.words, viaFile) : undefined;
    if (posixNode === undefined && winNode === undefined) return undefined;
    if (posixNode !== undefined && (posixNode === null || !samePath(posixNode, spec.nodePath))) return true;
    if (winNode !== undefined && (winNode === null || !nodeName(winNode, viaFile))) return true;
    if (win) {
      if (winNode === undefined) return true;
      // An unquoted line naming the current files runs in every shell: up to date whatever this run computed.
      if (winSplit!.kind === 'plain') return false;
      if (winSplit!.kind !== w.form) return true;
    }
    return false;
  };
  return {
    events: CODEX_HOOK_EVENTS,
    entry: (event) => {
      if (w.commandWindows === null) throw new HookCommandError(w.refused ?? 'commandWindows');
      return {
        hooks: [
          {
            type: 'command',
            command,
            commandWindows: w.commandWindows,
            async: true,
            timeout: SHORT_TIMEOUT_EVENTS.has(event) ? CODEX_SHORT_HOOK_TIMEOUT_SECONDS : CODEX_HOOK_TIMEOUT_SECONDS,
          },
        ],
      };
    },
    isOurs: (hook) => inspect(hook) !== undefined,
    isOutdated: (hook) => inspect(hook) === true,
  };
}

// ---------------------------------------------------------------- Cursor

/** The Cursor hook events agent-canvas installs (spec 7.2): observation-only, never a permission hook. */
export const CURSOR_HOOK_EVENTS: readonly string[] = ['sessionStart', 'beforeSubmitPrompt', 'stop', 'subagentStop', 'sessionEnd'];

export const CURSOR_HOOK_TIMEOUT_SECONDS = 5;

/** Characters PowerShell treats specially inside a double-quoted string (the typographic quotes count as `"`). */
const POWERSHELL_DQ_SPECIAL = /[`$"“”„]/g;

/** One argument for PowerShell: double-quoted, with `` ` ``, `$` and the double quotes escaped by a backtick. */
export function powershellQuote(arg: string): string {
  return `"${arg.replace(POWERSHELL_DQ_SPECIAL, (c) => `\`${c}`)}"`;
}

const isDq = (c: string): boolean => c === '"' || c === '“' || c === '”' || c === '„';
const isSq = (c: string): boolean => c === "'" || c === '‘' || c === '’' || c === '‚' || c === '‛';

/**
 * Splits a PowerShell command line into words, enough to read back what powershellQuote writes: double-quoted strings
 * (backtick escapes, `""` for a quote), single-quoted strings (literal, `''` for a quote), bare words split at
 * whitespace. Variables are not expanded.
 */
export function splitPowerShell(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (isDq(c)) {
      inWord = true;
      for (i++; i < line.length; i++) {
        const d = line[i]!;
        if (d === '`' && i + 1 < line.length) cur += line[++i];
        else if (isDq(d)) {
          if (i + 1 < line.length && isDq(line[i + 1]!)) cur += line[++i];
          else break;
        } else cur += d;
      }
    } else if (isSq(c)) {
      inWord = true;
      for (i++; i < line.length; i++) {
        const d = line[i]!;
        if (isSq(d)) {
          if (i + 1 < line.length && isSq(line[i + 1]!)) cur += line[++i];
          else break;
        } else cur += d;
      }
    } else if (c === '`' && i + 1 < line.length) {
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

/**
 * The forwarder command Cursor runs: on Windows Cursor runs it through PowerShell, so a quoted executable needs the
 * call operator (`& "<node>" "<cli.js>" hook-forward --origin cursor --port <n>`); elsewhere a shell command line with
 * single-quoted paths.
 */
export function cursorForwardCommand(spec: CodexForwardSpec): string {
  const args = `hook-forward --origin cursor --port ${spec.port}`;
  if ((spec.platform ?? process.platform) === 'win32') return `& ${powershellQuote(spec.nodePath)} ${powershellQuote(spec.cliPath)} ${args}`;
  return `${posixQuote(spec.nodePath)} ${posixQuote(spec.cliPath)} ${args}`;
}

/** The PowerShell call form (`& …`) or a plain command line, split accordingly. */
function splitCursorCommand(cmd: string): { words: string[]; callForm: boolean } {
  const trimmed = cmd.trimStart();
  if (trimmed.startsWith('&')) return { words: splitPowerShell(trimmed.slice(1)), callForm: true };
  return { words: splitPosix(trimmed), callForm: false };
}

/**
 * Cursor: one `{ command, timeout }` per event, directly in the event's array. Ours = a handler whose `command` (the
 * PowerShell call form, or a plain command line) has this installation's cli.js as a word, `hook-forward` right after
 * it, and the forwarder's origin `cursor` and port (`--port n`, `--port=n`, default 4317) equal to ours; paths compare
 * case-insensitively on win32. Outdated = ours, but the node word is missing or not the current node binary, or the
 * command is not in this platform's form (the call form on Windows, a plain command line elsewhere).
 */
export function cursorHookTarget(spec: CodexForwardSpec): HookTarget {
  const command = cursorForwardCommand(spec);
  const win = (spec.platform ?? process.platform) === 'win32';
  const norm = (p: string): string => (win ? p.replace(/\//g, BACKSLASH).toLowerCase() : p);
  const samePath = (a: string, b: string): boolean => norm(a) === norm(b);
  /** undefined = not ours; else whether it is outdated. */
  const inspect = (hook: unknown): boolean | undefined => {
    if (!isPlainObject(hook) || typeof hook.command !== 'string') return undefined;
    const { words, callForm } = splitCursorCommand(hook.command);
    const at = words.findIndex((w) => samePath(w, spec.cliPath));
    if (at === -1 || words[at + 1] !== 'hook-forward') return undefined;
    const fwd = parseForwardArgs(words.slice(at + 2));
    if (fwd.origin !== 'cursor' || fwd.port !== spec.port) return undefined;
    const node = at > 0 ? words[at - 1]! : null;
    return node === null || !samePath(node, spec.nodePath) || callForm !== win;
  };
  return {
    events: CURSOR_HOOK_EVENTS,
    flat: true,
    entry: () => ({ command, timeout: CURSOR_HOOK_TIMEOUT_SECONDS }),
    isOurs: (hook) => inspect(hook) !== undefined,
    isOutdated: (hook) => inspect(hook) === true,
  };
}

/** Cursor's hooks.json carries `version: 1`; any other value is a format we do not know and refuse to write. */
function checkCursorVersion(settings: unknown): void {
  if (!isPlainObject(settings) || !('version' in settings)) return;
  if (settings.version !== 1) throw new SettingsShapeError('hooks.json 的 version 不是 1（键 version 的形状不对），未知格式');
}

/** planInstallFor plus Cursor's `version`: refused when it is not 1, added (as the first key) only when absent. */
export function planCursorInstall(target: HookTarget, settings: unknown): InstallPlan {
  checkCursorVersion(settings);
  const plan = planInstallFor(target, settings);
  if (!('version' in plan.next)) plan.next = { version: 1, ...plan.next };
  return plan;
}

/** planUninstallFor, refusing an unknown `version` (never adds one). */
export function planCursorUninstall(target: HookTarget, settings: unknown): UninstallPlan {
  checkCursorVersion(settings);
  return planUninstallFor(target, settings);
}
