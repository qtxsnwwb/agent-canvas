import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** What is shown: plain text, passed to the system as data (never as code). */
export interface NotificationMessage {
  title: string;
  body: string;
  /** Opened when the notification is clicked (where the platform allows it). */
  url: string;
}

/** Delivery of one notification; rejects when it was not delivered (spec 5.2). */
export interface Notifier {
  /** `force`: attempt even while marked unavailable (the test notification). */
  notify(message: NotificationMessage, options?: { force?: boolean }): Promise<void>;
}

/** A program run without a shell: `command` with `args`, plus `env` added to the inherited environment. */
export interface CommandSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Runs a command to completion: resolves on exit code 0, rejects otherwise (a missing program: an error whose `code`
 * is `ENOENT`). Must stop the program when `signal` aborts.
 */
export type ProcessRunner = (spec: CommandSpec, options: { signal: AbortSignal }) => Promise<void>;

/** Environment variable carrying the notification (JSON `{ title, body, url }`) to the fixed Windows script. */
export const NOTIFY_ENV = 'AGENT_CANVAS_NOTIFICATION';

/** Windows PowerShell's own AppUserModelID, registered on every Windows install. */
export const WINDOWS_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

/**
 * Fixed script (no part of it depends on the notification): reads the notification from NOTIFY_ENV as JSON, builds
 * the toast XML with the XML DOM (texts set through InnerText, the URL through SetAttribute: escaped as data), and
 * shows it through the WinRT toast API; a click opens the URL (protocol activation).
 */
export const WINDOWS_TOAST_SCRIPT = [
  // Error text on the redirected stderr in UTF-8 (Windows PowerShell 5.1 otherwise uses the OEM code page).
  'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }',
  "$ErrorActionPreference = 'Stop'",
  `$data = ConvertFrom-Json -InputObject $env:${NOTIFY_ENV}`,
  '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
  '[void][Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]',
  '[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]',
  '$xml = New-Object System.Xml.XmlDocument',
  "$toast = $xml.CreateElement('toast')",
  // The default banner stays about 5 s, easy to miss while looking elsewhere; 'long' keeps it about 25 s.
  "$toast.SetAttribute('duration', 'long')",
  // No URL (refused by the service): a toast without a click target.
  'if ([string]$data.url -ne \'\') {',
  "  $toast.SetAttribute('activationType', 'protocol')",
  "  $toast.SetAttribute('launch', [string]$data.url)",
  '}',
  '[void]$xml.AppendChild($toast)',
  "$visual = $xml.CreateElement('visual')",
  '[void]$toast.AppendChild($visual)',
  "$binding = $xml.CreateElement('binding')",
  "$binding.SetAttribute('template', 'ToastGeneric')",
  '[void]$visual.AppendChild($binding)',
  'foreach ($line in @([string]$data.title, [string]$data.body)) {',
  "  $text = $xml.CreateElement('text')",
  '  $text.InnerText = $line',
  '  [void]$binding.AppendChild($text)',
  '}',
  '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
  '$doc.LoadXml($xml.OuterXml)',
  '$notification = New-Object Windows.UI.Notifications.ToastNotification $doc',
  `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${WINDOWS_APP_ID}').Show($notification)`,
].join('\r\n');

/** PowerShell's -EncodedCommand form of a script: base64 of its UTF-16LE text. */
const encodeCommand = (script: string): string => Buffer.from(script, 'utf16le').toString('base64');
const ENCODED_TOAST_SCRIPT = encodeCommand(WINDOWS_TOAST_SCRIPT);

/**
 * Windows PowerShell by absolute path (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, SystemRoot
 * defaulting to `C:\Windows`): a bare name would be looked up in the current directory first. The bare name only
 * when that file does not exist.
 */
export function windowsPowerShellPath(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fileExists): string {
  const root = env.SystemRoot !== undefined && env.SystemRoot !== '' ? env.SystemRoot : env.SYSTEMROOT || 'C:\\Windows';
  const full = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return exists(full) ? full : 'powershell.exe';
}

/** macOS's osascript by absolute path, else the bare name. */
export function osascriptPath(exists: (p: string) => boolean = fileExists): string {
  return exists('/usr/bin/osascript') ? '/usr/bin/osascript' : 'osascript';
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function windowsCommand(m: NotificationMessage, program = 'powershell.exe'): CommandSpec {
  return {
    command: program,
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED_TOAST_SCRIPT],
    env: { [NOTIFY_ENV]: JSON.stringify({ title: m.title, body: m.body, url: m.url }) },
  };
}

/**
 * macOS: a fixed `on run argv` script; the texts are its arguments. The first argument is a fixed word so that no
 * text can be taken for an osascript option. A click cannot carry a URL there: it is appended to the body.
 */
export function macCommand(m: NotificationMessage, program = 'osascript'): CommandSpec {
  return {
    command: program,
    args: [
      '-e',
      'on run argv',
      '-e',
      'display notification (item 3 of argv) with title (item 2 of argv)',
      '-e',
      'end run',
      'agent-canvas',
      m.title,
      withUrl(m),
    ],
  };
}

/** The body with the URL on its own last line (no URL: the body alone). */
const withUrl = (m: NotificationMessage): string => (m.url !== '' ? `${m.body}\n${m.url}` : m.body);

/** Notification servers may read the body as markup: `&`, `<`, `>` are escaped so it shows literally. */
const escapeMarkup = (s: string): string => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Linux and other free Unixes: notify-send; `--` ends the options. The URL is appended to the body. */
export function linuxCommand(m: NotificationMessage): CommandSpec {
  return { command: 'notify-send', args: ['--app-name=Agent Canvas', '--', m.title, escapeMarkup(withUrl(m))] };
}

const UNIX_LIKE: ReadonlySet<NodeJS.Platform> = new Set(['linux', 'freebsd', 'openbsd', 'netbsd'] as NodeJS.Platform[]);

/** Resolved program paths (default: the bare names). */
export interface ProgramPaths {
  powershell?: string;
  osascript?: string;
}

/** The command for `platform`; null when the platform is not supported. */
export function commandFor(platform: NodeJS.Platform, m: NotificationMessage, programs: ProgramPaths = {}): CommandSpec | null {
  if (platform === 'win32') return windowsCommand(m, programs.powershell);
  if (platform === 'darwin') return macCommand(m, programs.osascript);
  if (UNIX_LIKE.has(platform)) return linuxCommand(m);
  return null;
}

/** First readable line of a PowerShell error (its CLIXML form when stderr is redirected) or of plain stderr. */
function stderrSummary(stderr: string): string {
  const clixml = [...stderr.matchAll(/<S S="Error">([^<]*)<\/S>/g)].map((m) => m[1]!.replace(/_x000D__x000A_/g, ' ')).join('');
  const text = (clixml !== '' ? clixml : stderr).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** The real runner: spawns without a shell and without a console window; stdout ignored, stderr kept for the error. */
export const spawnRunner: ProcessRunner = (spec, { signal }) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.command, spec.args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: spec.env !== undefined ? { ...process.env, ...spec.env } : process.env,
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => {
      if (stderr.length < 16_384) stderr += d;
    });
    const onAbort = (): void => {
      child.kill();
      // A program ignoring SIGTERM (POSIX) is killed outright a moment later; Windows terminates at once.
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 1_000).unref();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', (err) => {
      signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.once('close', (code, sig) => {
      signal.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else {
        const detail = stderrSummary(stderr);
        reject(new Error(`${spec.command} 退出码 ${code ?? sig}${detail !== '' ? `：${detail}` : ''}`));
      }
    });
  });

export interface DesktopNotifierOptions {
  platform?: NodeJS.Platform;
  run?: ProcessRunner;
  now?: () => number;
  /** Per delivery (default 5 s). */
  timeoutMs?: number;
  /** Deliveries in flight at once (default 4). */
  maxConcurrent?: number;
  /** Deliveries waiting; beyond this the oldest is dropped (default 20). */
  maxQueue?: number;
  /** After the platform or command was found missing, at most one attempt per this period (default 10 min). */
  retryUnavailableMs?: number;
  /** Program paths (default: resolved on first use, windowsPowerShellPath / osascriptPath). */
  programs?: ProgramPaths;
}

/** notify() options: `force` attempts delivery even while marked unavailable (the explicit test notification). */
export interface NotifyOptions {
  force?: boolean;
}

/** Delivery state (shared NotificationStatus minus what the service adds). */
export interface DeliveryStatus {
  available: boolean;
  lastError: string | null;
  lastErrorAt: string | null;
}

interface Job {
  message: NotificationMessage;
  force: boolean;
  resolve: () => void;
  reject: (err: Error) => void;
}

/** C0 control characters other than tab, line feed and carriage return (not allowed in XML; never useful). */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/** A UTF-16 surrogate without its pair (not encodable; the XML DOM rejects it). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const clean = (s: string): string => String(s).replace(CONTROL, '').replace(LONE_SURROGATE, '�');

/**
 * System desktop notifications (spec 5.2): one system command per notification, bounded by a timeout, a concurrency
 * limit and a queue that drops its oldest entry; no retries. A missing command or an unsupported platform marks
 * delivery unavailable; after that it is attempted at most once per retryUnavailableMs.
 */
export class DesktopNotifier implements Notifier {
  private readonly platform: NodeJS.Platform;
  private readonly run: ProcessRunner;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  private readonly retryUnavailableMs: number;
  private readonly queue: Job[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private available = true;
  private lastAttemptAt: number | null = null;
  private lastError: string | null = null;
  private lastErrorAt: string | null = null;
  private closed = false;
  private programs: ProgramPaths | null;

  constructor(options: DesktopNotifierOptions = {}) {
    this.programs = options.programs ?? null;
    this.platform = options.platform ?? process.platform;
    this.run = options.run ?? spawnRunner;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.maxQueue = options.maxQueue ?? 20;
    this.retryUnavailableMs = options.retryUnavailableMs ?? 10 * 60_000;
  }

  status(): DeliveryStatus {
    return { available: this.available, lastError: this.lastError, lastErrorAt: this.lastErrorAt };
  }

  notify(message: NotificationMessage, options: NotifyOptions = {}): Promise<void> {
    if (this.closed) return Promise.reject(new Error('通知服务已停止'));
    return new Promise<void>((resolve, reject) => {
      const cleaned = { title: clean(message.title), body: clean(message.body), url: clean(message.url) };
      this.queue.push({ message: cleaned, force: options.force === true, resolve, reject });
      while (this.queue.length > this.maxQueue) this.queue.shift()!.reject(new Error('待发的通知太多，丢弃了最早的一条'));
      this.pump();
    });
  }

  /** Stops accepting; drops what is queued; resolves once the deliveries in flight end (each bounded by the timeout). */
  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0)) job.reject(new Error('通知服务已停止'));
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  private pump(): void {
    while (this.inFlight.size < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift()!;
      const p = this.deliver(job.message, job.force).then(job.resolve, job.reject);
      this.inFlight.add(p);
      void p.finally(() => {
        this.inFlight.delete(p);
        if (!this.closed) this.pump();
      });
    }
  }

  private fail(message: string, unavailable: boolean): Error {
    this.lastError = message;
    this.lastErrorAt = new Date(this.now()).toISOString();
    if (unavailable) this.available = false;
    return new Error(message);
  }

  private async deliver(message: NotificationMessage, force: boolean): Promise<void> {
    const now = this.now();
    if (!force && !this.available && this.lastAttemptAt !== null && now - this.lastAttemptAt < this.retryUnavailableMs) {
      throw new Error(this.lastError ?? '系统通知不可用');
    }
    this.lastAttemptAt = now;
    this.programs ??=
      this.platform === 'win32' ? { powershell: windowsPowerShellPath() } : this.platform === 'darwin' ? { osascript: osascriptPath() } : {};
    const spec = commandFor(this.platform, message, this.programs);
    if (spec === null) throw this.fail(`不支持在这个系统（${this.platform}）上发桌面通知`, true);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`发送通知超时（${Math.round(this.timeoutMs / 1000)} 秒）`));
      }, this.timeoutMs);
      // A hung command must not keep the process alive by this timer alone.
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      await Promise.race([this.run(spec, { signal: controller.signal }), timeout]);
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === 'ENOENT') throw this.fail(`找不到系统命令 ${spec.command}，无法发桌面通知`, true);
      throw this.fail(err instanceof Error ? err.message : String(err), false);
    } finally {
      clearTimeout(timer);
    }
    this.available = true;
  }
}
