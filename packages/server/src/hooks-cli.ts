import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { SettingsShapeError, hookUrl, planInstall, planUninstall } from './hooks-config.js';

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

interface Loaded {
  settings: unknown;
  exists: boolean;
  crlf: boolean;
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

/** Throws a plain Error whose message is ready to print. */
function loadSettings(file: string): Loaded {
  let raw: string | null;
  try {
    raw = readRaw(file);
  } catch (err) {
    throw new Error(`无法读取 ${file}：${(err as Error).message}`);
  }
  if (raw === null) return { settings: {}, exists: false, crlf: false, raw: null, mode: null };
  let mode: number | null = null;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    // mode is only a nicety
  }
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const crlf = text.includes('\r\n');
  if (text.trim() === '') return { settings: {}, exists: true, crlf, raw, mode };
  try {
    const settings = JSON.parse(text) as unknown;
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
      throw new SettingsShapeError('settings 必须是 JSON 对象（键 settings 的形状不对）');
    }
    return { settings, exists: true, crlf, raw, mode };
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

function writeAtomically(file: string, next: Record<string, unknown>, crlf: boolean, mode: number | null): void {
  let text = `${JSON.stringify(next, null, 2)}\n`;
  if (crlf) text = text.replace(/\n/g, '\r\n');
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

const STALE_MESSAGE = '设置文件在确认期间被修改，未做任何改动，请重新运行';

async function run(mode: Mode, opts: HooksCliOptions, io: HooksCliIo): Promise<number> {
  const file = resolveTarget(opts.settingsFile);
  if (file === null) {
    io.err(`设置文件是一个指向不存在目标的符号链接，未做任何改动：${opts.settingsFile}`);
    return 1;
  }
  const url = hookUrl(opts.port);
  let loaded: Loaded;
  let events: string[];
  let next: Record<string, unknown>;
  try {
    loaded = loadSettings(file);
    if (mode === 'install') {
      const plan = planInstall(loaded.settings, opts.port);
      events = plan.added;
      next = plan.next;
    } else {
      const plan = planUninstall(loaded.settings, opts.port);
      events = plan.removed;
      next = plan.next;
    }
  } catch (err) {
    io.err(err instanceof SettingsShapeError ? `${file}：${err.message}` : err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (events.length === 0) {
    io.out(mode === 'install' ? `hooks 已全部安装，无需改动（${file}）` : `没有找到指向 ${url} 的 hooks`);
    return 0;
  }

  if (isSymlink(opts.settingsFile)) {
    io.out(`（${opts.settingsFile} 是符号链接，实际写入 ${file}）`);
  }
  io.out(`settings 文件：${file}`);
  io.out(`hook 地址：${url}`);
  io.out(`将${mode === 'install' ? '添加' : '移除'}的事件（${events.length}）：${events.join(', ')}`);
  io.out('不会改动已有的其他内容');
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
    writeAtomically(file, next, loaded.crlf, loaded.mode);
    io.out(`已写入 ${file}`);
    if (backup !== null) io.out(`备份：${backup}`);
    io.out('新开的 Claude Code 会话才会使用这些 hooks');
    return 0;
  } catch (err) {
    io.err(`写入失败：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

export function runHooksInstall(opts: HooksCliOptions, io: HooksCliIo): Promise<number> {
  return run('install', opts, io);
}

export function runHooksUninstall(opts: HooksCliOptions, io: HooksCliIo): Promise<number> {
  return run('uninstall', opts, io);
}
