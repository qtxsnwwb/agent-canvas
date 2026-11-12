import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {
  SettingsShapeError,
  claudeHookTarget,
  codexForwardCommands,
  codexHookTarget,
  cursorForwardCommand,
  cursorHookTarget,
  hookUrl,
  planCursorInstall,
  planCursorUninstall,
  planInstallFor,
  planUninstallFor,
  type HookTarget,
  type InstallPlan,
  type UninstallPlan,
} from './hooks-config.js';

export interface HooksCliIo {
  out(line: string): void;
  err(line: string): void;
  /** Reads one line on an interactive terminal; true for y / yes. */
  confirm(question: string): Promise<boolean>;
  isInteractive: boolean;
  now(): Date;
}

export interface HooksCliOptions {
  settingsFile: string;
  port: number;
  yes: boolean;
}

/** Asks one question and reads one line; true for y / yes. */
export function confirmOnStreams(question: string, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const rl = readline.createInterface({ input, output });
    rl.once('close', () => resolve(false)); // Ctrl-D / Ctrl-C without an answer
    rl.question(question, (answer) => {
      resolve(/^(y|yes)$/i.test(answer.trim())); // before close(): close emits 'close' synchronously
      rl.close();
    });
  });
}

export function defaultSettingsFile(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.CLAUDE_CANVAS_SETTINGS_FILE;
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : path.join(os.homedir(), '.claude', 'settings.json');
}

/** Codex's hooks file: `CLAUDE_CANVAS_CODEX_HOOKS_FILE`, else `~/.codex/hooks.json`. */
export function defaultCodexHooksFile(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.CLAUDE_CANVAS_CODEX_HOOKS_FILE;
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : path.join(os.homedir(), '.codex', 'hooks.json');
}

export interface CodexHooksCliOptions extends HooksCliOptions {
  /** The node binary the hook commands run (process.execPath). */
  nodePath: string;
  /** This installation's cli.js. */
  cliPath: string;
}

/** Cursor's hooks file: `CLAUDE_CANVAS_CURSOR_HOOKS_FILE`, else `~/.cursor/hooks.json`. */
export function defaultCursorHooksFile(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.CLAUDE_CANVAS_CURSOR_HOOKS_FILE;
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : path.join(os.homedir(), '.cursor', 'hooks.json');
}

export interface CursorHooksCliOptions extends CodexHooksCliOptions {
  /** Decides the command form (PowerShell call form on win32). Default: process.platform. */
  platform?: NodeJS.Platform;
}

/** What differs between installing into Claude Code's settings.json and into Codex's hooks.json. */
interface HooksProfile {
  target: HookTarget;
  /** Refuses (message) when the target file's directory must already exist and does not; null = go on. */
  precheck(file: string, mode: Mode): string | null;
  /** Lines describing what the hooks are, printed with the plan. */
  describe(file: string): string[];
  /** Printed when there is nothing to remove. */
  nothingToRemove: string;
  /** Printed when the file does not exist yet and will be created. */
  willCreate(file: string): string | null;
  /** Printed after a successful write. */
  after(mode: Mode): string[];
  /** The node binary the hook commands run (named when outdated handlers are replaced). */
  nodePath?: string;
  /** Planning for a file whose format differs from the shared one (Cursor's `version`). Default: the shared planners. */
  planInstall?(settings: unknown): InstallPlan;
  planUninstall?(settings: unknown): UninstallPlan;
}

function claudeProfile(port: number): HooksProfile {
  const url = hookUrl(port);
  return {
    target: claudeHookTarget(port),
    precheck: () => null,
    describe: (file) => [`settings 文件：${file}`, `hook 地址：${url}`],
    nothingToRemove: `没有找到指向 ${url} 的 hooks`,
    willCreate: () => null,
    after: () => ['新开的 Claude Code 会话才会使用这些 hooks'],
  };
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function codexProfile(opts: CodexHooksCliOptions): HooksProfile {
  const spec = { nodePath: opts.nodePath, cliPath: opts.cliPath, port: opts.port };
  const { command, commandWindows } = codexForwardCommands(spec);
  return {
    target: codexHookTarget(spec),
    nodePath: opts.nodePath,
    // ~/.codex is Codex's own directory: never created here.
    precheck: (file, mode) =>
      mode === 'install' && !isDirectory(path.dirname(file))
        ? `目录 ${path.dirname(file)} 不存在，Codex 似乎没有安装，未做任何改动`
        : null,
    describe: (file) => [
      `Codex hooks 文件：${file}`,
      `hook 命令（macOS / Linux）：${command}`,
      `hook 命令（Windows）：${commandWindows}`,
      `转发到：${hookUrl(opts.port)}?origin=codex`,
    ],
    nothingToRemove: `没有找到本安装（${opts.cliPath}，端口 ${opts.port}）的 Codex hooks`,
    willCreate: (file) => `将新建 ${file}`,
    after: (mode) =>
      mode === 'install'
        ? [
            '注意：这些 hooks 需要在 Codex 里确认信任后才会运行——桌面应用：设置 → Hooks；CLI：输入 /hooks',
            '移动或升级 claude-canvas 后命令路径会变，需要重新安装（hooks install --codex）并在 Codex 里重新确认信任',
            '没确认信任时 claude-canvas 只靠会话文件工作',
          ]
        : ['已移除；Codex 不会再调用这些 hooks'],
  };
}

function cursorProfile(opts: CursorHooksCliOptions): HooksProfile {
  const spec = { nodePath: opts.nodePath, cliPath: opts.cliPath, port: opts.port, ...(opts.platform ? { platform: opts.platform } : {}) };
  const target = cursorHookTarget(spec);
  return {
    target,
    nodePath: opts.nodePath,
    planInstall: (settings) => planCursorInstall(target, settings),
    planUninstall: (settings) => planCursorUninstall(target, settings),
    // ~/.cursor is Cursor's own directory: never created here.
    precheck: (file, mode) =>
      mode === 'install' && !isDirectory(path.dirname(file))
        ? `目录 ${path.dirname(file)} 不存在，Cursor 似乎没有安装，未做任何改动`
        : null,
    describe: (file) => [
      `Cursor hooks 文件：${file}`,
      `hook 命令：${cursorForwardCommand(spec)}`,
      `转发到：${hookUrl(opts.port)}?origin=cursor`,
    ],
    nothingToRemove: `没有找到本安装（${opts.cliPath}，端口 ${opts.port}）的 Cursor hooks`,
    willCreate: (file) => `将新建 ${file}`,
    after: (mode) =>
      mode === 'install'
        ? [
            'Cursor 监视 hooks.json，保存后自动生效，不需要确认信任',
            '移动或升级 claude-canvas 后命令路径会变，需要重新安装（hooks install --cursor）',
          ]
        : ['已移除；Cursor 不会再调用这些 hooks'],
  };
}

interface Loaded {
  settings: unknown;
  exists: boolean;
  crlf: boolean;
  /** The file started with a UTF-8 BOM (kept on write-back). */
  bom: boolean;
  /** Indentation unit to write with: the file's own (tab or N spaces), 2 spaces when it has no indented line. */
  indent: string;
  /** Why the file cannot be written back losslessly (checked only when a write is about to happen); null when it can. */
  lossy: Lossy | null;
  /** The exact file text the plan is computed from; null when the file did not exist. */
  raw: string | null;
  mode: number | null;
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Follows a symlinked settings file so the link itself is never replaced. A missing path is used as is; a dangling
 * symlink is refused (null).
 */
function resolveTarget(file: string): string | null {
  try {
    return fs.realpathSync(file);
  } catch {
    return isSymlink(file) ? null : file;
  }
}

function readRaw(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

const DEFAULT_INDENT = '  ';

/** The first indented line decides: a leading tab means tabs, otherwise its run of leading spaces. */
function detectIndent(text: string): string {
  const m = /(?:^|\n)([ \t]+)\S/.exec(text);
  if (m === null) return DEFAULT_INDENT;
  const lead = m[1]!;
  if (lead.startsWith('\t')) return '\t';
  return /^ +/.exec(lead)![0];
}

/**
 * A number token in canonical form (sign, significant digits without leading/trailing zeros, exponent), so tokens
 * that denote the same decimal value compare equal ("1e3" and "1000", "2.50" and "2.5"; zero ignores its sign).
 */
function canonicalNumber(token: string): string | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (m === null) return null;
  const frac = m[3] ?? '';
  let digits = (m[2]! + frac).replace(/^0+/, '');
  if (digits === '') return '0';
  let exp = BigInt(m[4] ?? '0') - BigInt(frac.length);
  const trimmed = digits.replace(/0+$/, '');
  exp += BigInt(digits.length - trimmed.length);
  digits = trimmed;
  return `${m[1]}${digits}e${exp}`;
}

/** True when the number token does not survive JSON.parse -> JSON.stringify with its decimal value intact. */
function numberIsLossy(token: string): boolean {
  return canonicalNumber(token) !== canonicalNumber(JSON.stringify(JSON.parse(token)));
}

type Lossy = 'number' | 'duplicate' | 'reorder';

const sameOrder = (a: string[], b: string[]): boolean => a.length === b.length && a.every((k, j) => k === b[j]);

/**
 * Scans JSON text that JSON.parse already accepted for what JSON.parse -> JSON.stringify would silently change: a
 * number literal whose value a double cannot hold, a key repeated within one object (parsing keeps only the last), or
 * an object whose key order JSON.parse -> JSON.stringify would change (integer-like keys are moved to the front).
 * Returns the first such problem in text order.
 */
function findLossy(text: string): Lossy | null {
  let i = 0;
  let found: Lossy | null = null;
  const skipWs = (): void => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++;
  };
  const readString = (): string => {
    const start = i;
    i++; // opening quote
    while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i++; // closing quote
    return JSON.parse(text.slice(start, i)) as string;
  };
  const NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  // Iterative walk (no recursion depth limit): a stack of open containers, each object with the keys seen so far.
  const stack: (Set<string> | null)[] = [];
  const key = (): void => {
    skipWs();
    const k = readString();
    const keys = stack[stack.length - 1]!;
    if (keys.has(k)) found ??= 'duplicate';
    keys.add(k);
    skipWs();
    i++; // ':'
  };
  /** Consumes one value, or opens a container; true when it opened a non-empty one (its first value comes next). */
  const value = (): boolean => {
    skipWs();
    const c = text[i];
    if (c === '{' || c === '[') {
      i++;
      stack.push(c === '{' ? new Set() : null);
      skipWs();
      if (text[i] === (c === '{' ? '}' : ']')) {
        i++;
        stack.pop();
        return false;
      }
      if (c === '{') key();
      return true;
    }
    if (c === '"') {
      readString();
      return false;
    }
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) {
      NUMBER.lastIndex = i;
      const token = NUMBER.exec(text)![0];
      i += token.length;
      if (found === null && numberIsLossy(token)) found = 'number';
      return false;
    }
    i += c === 'f' ? 5 : 4; // true / false / null
    return false;
  };
  let expectValue = true;
  for (;;) {
    if (expectValue) {
      expectValue = value();
      continue;
    }
    // After a value: move to the next member, or close the innermost container.
    skipWs();
    if (stack.length === 0) break;
    if (text[i] === ',') {
      i++;
      if (stack[stack.length - 1] !== null) key();
      expectValue = true;
      continue;
    }
    i++; // '}' or ']'
    const closed = stack.pop();
    // JSON.parse puts integer-like keys ("0", "10") first, in numeric order: writing back would move them.
    if (closed && found === null && !sameOrder([...closed], Object.keys(Object.fromEntries([...closed].map((k) => [k, 0]))))) {
      found = 'reorder';
    }
  }
  return found;
}

/** Throws a plain Error whose message is ready to print. */
function loadSettings(file: string): Loaded {
  let raw: string | null;
  try {
    raw = readRaw(file);
  } catch (err) {
    throw new Error(`无法读取 ${file}：${(err as Error).message}`);
  }
  if (raw === null) return { settings: {}, exists: false, crlf: false, bom: false, indent: DEFAULT_INDENT, lossy: null, raw: null, mode: null };
  let mode: number | null = null;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    // mode is only a nicety
  }
  const bom = raw.charCodeAt(0) === 0xfeff;
  const text = bom ? raw.slice(1) : raw;
  const crlf = text.includes('\r\n');
  const indent = detectIndent(text);
  if (text.trim() === '') return { settings: {}, exists: true, crlf, bom, indent, lossy: null, raw, mode };
  try {
    const settings = JSON.parse(text) as unknown;
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
      throw new SettingsShapeError('settings 必须是 JSON 对象（键 settings 的形状不对）');
    }
    return { settings, exists: true, crlf, bom, indent, lossy: findLossy(text), raw, mode };
  } catch (err) {
    if (err instanceof SettingsShapeError) throw err;
    throw new Error(`${file} 不是合法的 JSON：${(err as Error).message}`);
  }
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

function stamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function backupCandidate(file: string, d: Date, attempt: number): string {
  return `${file}.bak-claude-canvas-${stamp(d)}${attempt === 1 ? '' : `-${attempt}`}`;
}

/** The backup path that would be used right now (first name not yet taken). */
function nextBackupPath(file: string, d: Date): string {
  for (let n = 1; ; n++) {
    const candidate = backupCandidate(file, d, n);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

/** Copies without ever overwriting an existing file; returns the path actually used. */
function makeBackup(file: string, d: Date): string {
  for (let n = 1; ; n++) {
    const candidate = backupCandidate(file, d, n);
    try {
      fs.copyFileSync(file, candidate, fs.constants.COPYFILE_EXCL);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

function writeAtomically(file: string, next: Record<string, unknown>, loaded: Loaded): void {
  const { crlf, bom, indent, mode } = loaded;
  let text = `${JSON.stringify(next, null, indent)}\n`;
  if (crlf) text = text.replace(/\n/g, '\r\n');
  if (bom) text = `\uFEFF${text}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    if (mode !== null) {
      try {
        fs.chmodSync(tmp, mode);
      } catch {
        // not meaningful on every platform
      }
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

type Mode = 'install' | 'uninstall';

const LOSSY_MESSAGE: Record<Lossy, string> = {
  number: '设置文件包含无法无损读写的数字',
  duplicate: '设置文件包含重复的键',
  reorder: '设置文件包含会被重新排序的键',
};

const STALE_MESSAGE = '设置文件在确认期间被修改，未做任何改动，请重新运行';

async function run(mode: Mode, opts: HooksCliOptions, io: HooksCliIo, profile: HooksProfile): Promise<number> {
  const file = resolveTarget(opts.settingsFile);
  if (file === null) {
    io.err(`设置文件是一个指向不存在目标的符号链接，未做任何改动：${opts.settingsFile}`);
    return 1;
  }
  const refused = profile.precheck(file, mode);
  if (refused !== null) {
    io.err(refused);
    return 1;
  }
  let loaded: Loaded;
  let events: string[];
  let replaced: string[] = [];
  let next: Record<string, unknown>;
  try {
    loaded = loadSettings(file);
    if (mode === 'install') {
      const plan = profile.planInstall ? profile.planInstall(loaded.settings) : planInstallFor(profile.target, loaded.settings);
      events = plan.added;
      replaced = plan.replaced;
      next = plan.next;
    } else {
      const plan = profile.planUninstall ? profile.planUninstall(loaded.settings) : planUninstallFor(profile.target, loaded.settings);
      events = plan.removed;
      next = plan.next;
    }
  } catch (err) {
    io.err(err instanceof SettingsShapeError ? `${file}：${err.message}` : err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (events.length === 0 && replaced.length === 0) {
    io.out(mode === 'install' ? `hooks 已全部安装，无需改动（${file}）` : profile.nothingToRemove);
    return 0;
  }

  // Writing back goes through JSON.parse -> JSON.stringify: refuse when that would silently change the file.
  if (loaded.lossy !== null) {
    io.err(`${LOSSY_MESSAGE[loaded.lossy]}，未做任何改动：${file}`);
    return 1;
  }

  if (isSymlink(opts.settingsFile)) {
    io.out(`（${opts.settingsFile} 是符号链接，实际写入 ${file}）`);
  }
  for (const line of profile.describe(file)) io.out(line);
  if (events.length > 0) io.out(`将${mode === 'install' ? '添加' : '移除'}的事件（${events.length}）：${events.join(', ')}`);
  if (replaced.length > 0) {
    io.out(`已安装但已过期的 hooks（命令里的 node 路径不是当前的 ${profile.nodePath ?? 'node'}）`);
    io.out(`将替换的事件（${replaced.length}）：${replaced.join(', ')}`);
  }
  io.out('不会改动已有的其他内容');
  const creating = loaded.exists ? null : profile.willCreate(file);
  if (creating !== null) io.out(creating);
  io.out(loaded.exists ? `备份文件：${nextBackupPath(file, io.now())}` : '原文件不存在，无需备份');

  if (!opts.yes) {
    if (!io.isInteractive) {
      io.err('非交互终端下需要加 --yes 才会写入');
      return 1;
    }
    if (!(await io.confirm('写入以上改动？(y/N) '))) {
      io.out('已取消，未做任何改动');
      return 0;
    }
  }

  try {
    if (readRaw(file) !== loaded.raw) {
      io.err(STALE_MESSAGE);
      return 1;
    }
    const backup = loaded.exists ? makeBackup(file, io.now()) : null;
    writeAtomically(file, next, loaded);
    io.out(`已写入 ${file}`);
    if (backup !== null) io.out(`备份：${backup}`);
    for (const line of profile.after(mode)) io.out(line);
    return 0;
  } catch (err) {
    io.err(`写入失败：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

export function runHooksInstall(opts: HooksCliOptions, io: HooksCliIo): Promise<number> {
  return run('install', opts, io, claudeProfile(opts.port));
}

export function runHooksUninstall(opts: HooksCliOptions, io: HooksCliIo): Promise<number> {
  return run('uninstall', opts, io, claudeProfile(opts.port));
}

/** `hooks install --codex`: the same flow and protections, writing Codex's hooks.json (created when missing). */
export function runCodexHooksInstall(opts: CodexHooksCliOptions, io: HooksCliIo): Promise<number> {
  return run('install', opts, io, codexProfile(opts));
}

export function runCodexHooksUninstall(opts: CodexHooksCliOptions, io: HooksCliIo): Promise<number> {
  return run('uninstall', opts, io, codexProfile(opts));
}

/** `hooks install --cursor`: the same flow and protections, writing Cursor's hooks.json (created when missing). */
export function runCursorHooksInstall(opts: CursorHooksCliOptions, io: HooksCliIo): Promise<number> {
  return run('install', opts, io, cursorProfile(opts));
}

export function runCursorHooksUninstall(opts: CursorHooksCliOptions, io: HooksCliIo): Promise<number> {
  return run('uninstall', opts, io, cursorProfile(opts));
}
