import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  DesktopNotifier,
  NOTIFY_ENV,
  WINDOWS_APP_ID,
  WINDOWS_TOAST_SCRIPT,
  commandFor,
  linuxCommand,
  macCommand,
  windowsCommand,
  type CommandSpec,
  type NotificationMessage,
  type ProcessRunner,
  osascriptPath,
  spawnRunner,
  windowsPowerShellPath,
} from '../src/notify/desktop.js';

describe('修复轮 1：程序路径、无网址、字符清理、强制重试、spawnRunner', () => {
  test('Windows PowerShell 用绝对路径；文件不存在才用名字', () => {
    const seen: string[] = [];
    const exists = (p: string): boolean => {
      seen.push(p);
      return true;
    };
    expect(windowsPowerShellPath({ SystemRoot: 'D:\\Win' }, exists)).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(windowsPowerShellPath({}, exists)).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(windowsPowerShellPath({ SystemRoot: 'D:\\Win' }, () => false)).toBe('powershell.exe');
    expect(windowsCommand(msg, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe').command).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    expect(osascriptPath(() => true)).toBe('/usr/bin/osascript');
    expect(osascriptPath(() => false)).toBe('osascript');
    expect(commandFor('win32', msg, { powershell: 'X:\\ps.exe' })?.command).toBe('X:\\ps.exe');
    expect(commandFor('darwin', msg, { osascript: '/usr/bin/osascript' })?.command).toBe('/usr/bin/osascript');
  });

  test('Windows 脚本：先把输出编码设为 UTF-8；没有网址时不设点击目标', () => {
    expect(WINDOWS_TOAST_SCRIPT.split('\r\n')[0]).toContain('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8');
    // The banner stays about 25 s instead of the default 5 s.
    expect(WINDOWS_TOAST_SCRIPT).toContain("$toast.SetAttribute('duration', 'long')");
    expect(WINDOWS_TOAST_SCRIPT).toMatch(/if \(\[string\]\$data\.url -ne ''\) \{\r\n {2}\$toast\.SetAttribute\('activationType', 'protocol'\)/);
  });

  test('没有网址：macOS / Linux 的正文不附网址', () => {
    const m = { title: 't', body: 'b', url: '' };
    expect(macCommand(m).args.at(-1)).toBe('b');
    expect(linuxCommand(m).args.at(-1)).toBe('b');
  });

  test('落单的代理项被替换成 U+FFFD', async () => {
    const calls: CommandSpec[] = [];
    const n = new DesktopNotifier({ platform: 'linux', run: async (spec) => void calls.push(spec) });
    await n.notify({ title: 'a\uD800b', body: '\uDC00', url: '' });
    expect(calls[0]!.args.slice(2)).toEqual(['a\uFFFDb', '\uFFFD']);
  });

  test('force：不可用期间也会再试一次（测试通知）', async () => {
    let attempts = 0;
    let fail = true;
    const n = new DesktopNotifier({
      platform: 'linux',
      run: async () => {
        attempts += 1;
        if (fail) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    });
    await expect(n.notify(msg)).rejects.toThrow();
    await expect(n.notify(msg)).rejects.toThrow();
    expect(attempts).toBe(1);
    fail = false;
    await n.notify(msg, { force: true });
    expect(attempts).toBe(2);
    expect(n.status().available).toBe(true);
  });

  // spawnRunner with Node itself (never a notification command).
  const node = (code: string): CommandSpec => ({ command: process.execPath, args: ['-e', code] });
  test('spawnRunner：退出码 0 成功；非 0 失败并带 stderr；环境变量传入', async () => {
    await expect(spawnRunner(node('process.exit(0)'), { signal: new AbortController().signal })).resolves.toBeUndefined();
    await expect(spawnRunner(node("process.stderr.write('bad thing'); process.exit(3)"), { signal: new AbortController().signal })).rejects.toThrow(
      /退出码 3：bad thing/,
    );
    await expect(
      spawnRunner(
        { ...node(`process.exit(process.env.${NOTIFY_ENV} === '{"a":"$x"}' ? 0 : 1)`), env: { [NOTIFY_ENV]: '{"a":"$x"}' } },
        { signal: new AbortController().signal },
      ),
    ).resolves.toBeUndefined();
  });

  test('spawnRunner：程序不存在是 ENOENT；中止会结束子进程', async () => {
    await expect(spawnRunner({ command: 'agent-canvas-no-such-program-xyz', args: [] }, { signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const ac = new AbortController();
    const started = Date.now();
    const p = spawnRunner(node('setInterval(() => {}, 1000)'), { signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    await expect(p).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

const NASTY = `a"b'c\`d$e $(calc) %PATH% ; & | <x> </text>]]> \r\n 第二行 -e --help`;
const msg: NotificationMessage = { title: `等你确认权限 · ${NASTY}`, body: `${NASTY}\nClaude Code`, url: 'http://127.0.0.1:4999/#/s/a%22b' };

const decode = (b64: string): string => Buffer.from(b64, 'base64').toString('utf16le');

describe('各平台的命令（纯函数）', () => {
  test('Windows：固定脚本经 -EncodedCommand 传入；文字只在环境变量里（JSON）', () => {
    const spec = windowsCommand(msg);
    expect(spec.command).toBe('powershell.exe');
    expect(spec.args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
    expect(spec.args).toHaveLength(6);
    expect(decode(spec.args[5]!)).toBe(WINDOWS_TOAST_SCRIPT);
    // 脚本与消息无关：同一份
    expect(windowsCommand({ title: 'x', body: 'y', url: 'z' }).args).toEqual(spec.args);
    expect(JSON.parse(spec.env![NOTIFY_ENV]!)).toEqual(msg);
    for (const arg of spec.args) expect(arg).not.toContain('calc');
  });

  test('Windows 脚本：WinRT toast、PowerShell 的 AppUserModelID、protocol 激活、文字经 XML DOM 写入', () => {
    expect(WINDOWS_TOAST_SCRIPT).toContain('Windows.UI.Notifications.ToastNotificationManager');
    expect(WINDOWS_TOAST_SCRIPT).toContain('Windows.Data.Xml.Dom.XmlDocument');
    expect(WINDOWS_APP_ID).toBe('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(WINDOWS_TOAST_SCRIPT).toContain(WINDOWS_APP_ID);
    expect(WINDOWS_TOAST_SCRIPT).toContain("SetAttribute('activationType', 'protocol')");
    expect(WINDOWS_TOAST_SCRIPT).toContain(`$env:${NOTIFY_ENV}`);
    expect(WINDOWS_TOAST_SCRIPT).toContain('.InnerText =');
    expect(WINDOWS_TOAST_SCRIPT).not.toMatch(/Invoke-Expression|iex\b/i);
  });

  test('macOS：固定的 on run argv 脚本，文字作为参数；网址附在正文后', () => {
    const spec = macCommand(msg);
    expect(spec.command).toBe('osascript');
    expect(spec.args).toEqual([
      '-e',
      'on run argv',
      '-e',
      'display notification (item 3 of argv) with title (item 2 of argv)',
      '-e',
      'end run',
      'agent-canvas',
      msg.title,
      `${msg.body}\n${msg.url}`,
    ]);
    expect(spec.env).toBeUndefined();
  });

  test('Linux：notify-send，选项结束后才是文字；正文的标记字符被转义', () => {
    const spec = linuxCommand(msg);
    expect(spec.command).toBe('notify-send');
    expect(spec.args.slice(0, 2)).toEqual(['--app-name=Agent Canvas', '--']);
    expect(spec.args[2]).toBe(msg.title);
    expect(spec.args[3]).toBe(
      `${NASTY.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}\nClaude Code\n${msg.url}`,
    );
    expect(spec.args).toHaveLength(4);
  });

  test('按平台选择；不支持的平台为 null', () => {
    expect(commandFor('win32', msg)?.command).toBe('powershell.exe');
    expect(commandFor('darwin', msg)?.command).toBe('osascript');
    expect(commandFor('linux', msg)?.command).toBe('notify-send');
    expect(commandFor('freebsd', msg)?.command).toBe('notify-send');
    expect(commandFor('aix', msg)).toBeNull();
  });
});

describe('DesktopNotifier', () => {
  let now: number;
  let calls: CommandSpec[];
  let pending: { resolve: () => void; reject: (e: Error) => void; signal: AbortSignal }[];

  const deferredRunner: ProcessRunner = (spec, { signal }) =>
    new Promise<void>((resolve, reject) => {
      calls.push(spec);
      pending.push({ resolve, reject, signal });
    });
  const make = (run: ProcessRunner, platform: NodeJS.Platform = 'linux'): DesktopNotifier =>
    new DesktopNotifier({ platform, run, now: () => now });

  beforeEach(() => {
    vi.useFakeTimers();
    now = Date.parse('2026-11-12T10:00:00.000Z');
    calls = [];
    pending = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('成功：状态记下可用；控制字符被去掉', async () => {
    const n = make(async (spec) => {
      calls.push(spec);
    });
    await n.notify({ title: 't\u0007x', body: 'b\u0000\ny', url: 'u' });
    expect(calls[0]!.args.slice(2)).toEqual(['tx', 'b\ny\nu']);
    expect(n.status()).toEqual({ available: true, lastError: null, lastErrorAt: null });
  });

  test('失败：拒绝，记下最近的错误和时间，仍算可用', async () => {
    const n = make(async () => {
      throw new Error('exit 1');
    });
    await expect(n.notify(msg)).rejects.toThrow('exit 1');
    expect(n.status()).toEqual({ available: true, lastError: 'exit 1', lastErrorAt: '2026-11-12T10:00:00.000Z' });
  });

  test('5 秒超时：中止命令并拒绝', async () => {
    const n = make(deferredRunner);
    const p = n.notify(msg);
    const settled = expect(p).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(pending[0]!.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
    expect(pending[0]!.signal.aborted).toBe(true);
    expect(n.status().lastError).toMatch(/超时/);
  });

  test('同时最多 4 个在途，多的排队；队列超过 20 条丢掉最旧的', async () => {
    const n = make(deferredRunner);
    const results: string[] = [];
    const ps = Array.from({ length: 26 }, (_, i) =>
      n.notify({ title: `t${i}`, body: 'b', url: 'u' }).then(
        () => results.push(`ok${i}`),
        (e: Error) => results.push(`err${i}:${e.message}`),
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => c.args[2])).toEqual(['t0', 't1', 't2', 't3']);
    // 26 = 4 在途 + 22 排队 → 最旧的两条 (t4, t5) 被丢掉
    expect(results).toEqual([expect.stringMatching(/^err4:/), expect.stringMatching(/^err5:/)]);
    pending[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => c.args[2])).toEqual(['t0', 't1', 't2', 't3', 't6']);
    for (let i = 1; i < 30; i++) {
      pending[i]?.resolve();
      await vi.advanceTimersByTimeAsync(0);
    }
    await Promise.all(ps);
    expect(results.filter((r) => r.startsWith('ok'))).toHaveLength(24);
  });

  test('命令不存在：标记不可用；10 分钟内不再尝试；之后再试一次，成功则恢复', async () => {
    let fail = true;
    let attempts = 0;
    const n = make(async () => {
      attempts += 1;
      if (fail) throw Object.assign(new Error('spawn notify-send ENOENT'), { code: 'ENOENT' });
    });
    await expect(n.notify(msg)).rejects.toThrow(/notify-send/);
    expect(n.status()).toMatchObject({ available: false, lastError: expect.stringMatching(/找不到系统命令 notify-send/) });
    now += 9 * 60_000;
    await expect(n.notify(msg)).rejects.toThrow(/notify-send/);
    expect(attempts).toBe(1);
    now += 60_000;
    fail = false;
    await n.notify(msg);
    expect(attempts).toBe(2);
    expect(n.status().available).toBe(true);
  });

  test('不支持的平台：不可用，不运行任何命令', async () => {
    let attempts = 0;
    const n = make(async () => {
      attempts += 1;
    }, 'aix');
    await expect(n.notify(msg)).rejects.toThrow(/不支持/);
    expect(attempts).toBe(0);
    expect(n.status().available).toBe(false);
  });

  test('close：丢掉排队的，等在途的结束（最多到超时）', async () => {
    const n = make(deferredRunner);
    const ps = Array.from({ length: 6 }, (_, i) => n.notify({ title: `t${i}`, body: 'b', url: 'u' }).then(() => 'ok', () => 'err'));
    await vi.advanceTimersByTimeAsync(0);
    let closed = false;
    const closing = n.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);
    pending[0]!.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    await closing;
    expect(await Promise.all(ps)).toEqual(['ok', 'err', 'err', 'err', 'err', 'err']);
    await expect(n.notify(msg)).rejects.toThrow();
    expect(calls).toHaveLength(4);
  });
});
