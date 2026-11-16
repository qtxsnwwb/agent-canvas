import { spawn, spawnSync, type ChildProcess, type SpawnSyncOptions } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { codexForwardCommands, cursorForwardCommand, windowsQuote } from '../src/hooks-config.js';
import { windowsShortPath } from '../src/win-short-path.js';

/*
 * The hook command strings the installer writes, run for real the way the tools run them on Windows — Codex:
 * `powershell.exe -NoProfile -Command <commandWindows>` (its normal path) and `cmd.exe /C <commandWindows>` (its
 * fallback when the local environment is not ready); Cursor: PowerShell — against a throwaway server (temp dirs, every
 * AGENT_CANVAS_* overridden, temp HOME, a free port, never 4317) with an invented payload on stdin. Uses the built
 * cli.js (the forwarder and the server as shipped); `pnpm build` first.
 */
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
const HAVE_CLI = fs.existsSync(CLI);
const ON_WINDOWS = process.platform === 'win32';
const SKIP_REASON = !ON_WINDOWS ? 'Windows only' : !HAVE_CLI ? `${CLI} is missing: run the build first` : '';
if (SKIP_REASON !== '') console.warn(`codex-hook-shell.timing.test.ts skipped: ${SKIP_REASON}`);

type Way = 'powershell' | 'pwsh' | 'cmd' | 'cmd-raw';
/** Codex prefers PowerShell 7 (`pwsh`) when it is installed, else Windows PowerShell: run both when both exist. */
const HAVE_PWSH = ON_WINDOWS && spawnSync('pwsh.exe', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true, timeout: 20_000 }).status === 0;
const POWERSHELLS: readonly Way[] = HAVE_PWSH ? ['powershell', 'pwsh'] : ['powershell'];
if (ON_WINDOWS && !HAVE_PWSH) console.warn('codex-hook-shell: pwsh not found, only Windows PowerShell is checked');

let tmp: string;
let junction: string | undefined;
let port: number;
let server: ChildProcess | undefined;
let env: NodeJS.ProcessEnv;

async function freePort(): Promise<number> {
  for (;;) {
    const p = await new Promise<number>((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => {
        const got = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(got));
      });
    });
    if (p !== 4317) return p;
  }
}

async function get(pathname: string): Promise<any> {
  return (await fetch(`http://127.0.0.1:${port}${pathname}`)).json();
}

async function hookCount(origin: string): Promise<number> {
  const d = await get('/api/diagnostics');
  return (d.hookEvents as { origin: string; count: number }[]).filter((e) => e.origin === origin).reduce((n, e) => n + e.count, 0);
}

/** Waits until the server has stored `want` hook events of `origin` (it ingests after answering), or gives up. */
async function waitForCount(origin: string, want: number): Promise<number> {
  let n = await hookCount(origin);
  for (let i = 0; i < 40 && n < want; i++) {
    await new Promise((r) => setTimeout(r, 100));
    n = await hookCount(origin);
  }
  return n;
}

describe.skipIf(SKIP_REASON !== '')('hook commands run through the shells the tools use (Windows)', () => {
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hook-shell-'));
    for (const d of ['home', 'data', 'projects']) fs.mkdirSync(path.join(tmp, d));
    const home = path.join(tmp, 'home');
    port = await freePort();
    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENT_CANVAS_DATA_DIR: path.join(tmp, 'data'),
      AGENT_CANVAS_PROJECTS_DIR: path.join(tmp, 'projects'),
      AGENT_CANVAS_CODEX_DIR: '',
      AGENT_CANVAS_CURSOR_DB: '',
      AGENT_CANVAS_GEMINI_DIR: '',
      AGENT_CANVAS_GROK_DIR: '',
      AGENT_CANVAS_COPILOT_DIR: '',
      AGENT_CANVAS_STATS_WARMUP: '0',
      AGENT_CANVAS_SETTINGS_FILE: path.join(home, 'claude-settings.json'),
      AGENT_CANVAS_CODEX_HOOKS_FILE: path.join(home, 'codex-hooks.json'),
      AGENT_CANVAS_CURSOR_HOOKS_FILE: path.join(home, 'cursor-hooks.json'),
      AGENT_CANVAS_NOTIFICATION: '',
    };
    server = spawn(process.execPath, [CLI, 'start', '--port', String(port)], { env, stdio: 'ignore', windowsHide: true });
    for (let i = 0; i < 120; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/projects`)).ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('the throwaway server did not start');
  }, 60_000);

  afterAll(async () => {
    if (server !== undefined && server.exitCode === null) {
      const exited = new Promise((r) => server!.once('exit', r));
      server.kill();
      await exited;
    }
    // The junction points into this repository: remove the link itself first, so nothing ever walks into its target.
    const link = junction === undefined ? undefined : fs.lstatSync(junction, { throwIfNoEntry: false });
    if (link !== undefined && !link.isSymbolicLink()) throw new Error(`${junction} is not a link: temp dir left in place, remove it by hand`);
    if (link !== undefined) {
      try {
        fs.unlinkSync(junction!);
      } catch {
        fs.rmdirSync(junction!); // removes a junction itself, never its target's contents
      }
    }
    if (tmp !== undefined) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10 });
  }, 30_000);

  let n = 0;
  const codexPayload = (): string =>
    JSON.stringify({
      session_id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
      hook_event_name: 'PreToolUse',
      turn_id: `turn-${n}`,
      cwd: 'C:\\work\\demo',
      transcript_path: null,
      model: 'invented-model',
      permission_mode: 'default',
      tool_name: 'shell',
      tool_input: { command: 'echo hi' },
      tool_use_id: `call-${n}`,
    });

  /** Runs `line` the given way with `input` on stdin; returns the result and how many hooks of `origin` arrived. */
  async function run(way: Way, line: string, input: string, origin = 'codex') {
    const before = await hookCount(origin);
    const opts: SpawnSyncOptions = { input, env, encoding: 'utf8', timeout: 30_000, windowsHide: true };
    const r =
      way === 'powershell' || way === 'pwsh'
        ? spawnSync(way === 'pwsh' ? 'pwsh.exe' : 'powershell.exe', ['-NoProfile', '-Command', line], opts)
        : way === 'cmd'
          ? // Node's default quoting: the whole line as one argument (as Rust's Command::arg passes it).
            spawnSync('cmd.exe', ['/C', line], opts)
          : // Codex's own fallback (no shell configured): `/C` then the line wrapped in one extra pair of quotes, raw.
            spawnSync('cmd.exe', ['/C', `"${line}"`], { ...opts, windowsVerbatimArguments: true });
    const delivered = (await waitForCount(origin, before + 1)) - before;
    return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), delivered, error: r.error };
  }

  const installed = (): string =>
    codexForwardCommands({ nodePath: process.execPath, cliPath: CLI, port, platform: 'win32', shortPath: windowsShortPath }).commandWindows;

  test('Codex commandWindows as installed: PowerShell -NoProfile -Command delivers, exit 0, no output (also pwsh when present)', async () => {
    for (const way of POWERSHELLS) {
      const r = await run(way, installed(), codexPayload());
      expect(r.error).toBeUndefined();
      expect({ way, status: r.status, stdout: r.stdout, stderr: r.stderr, delivered: r.delivered }).toEqual({ way, status: 0, stdout: '', stderr: '', delivered: 1 });
    }
  }, 60_000);

  test('a global npm install path (`…\\node_modules\\@scope\\…`, real directories): plain form, delivered in every shell', async () => {
    // node.exe hard-linked (copied if that fails) and the package reached through a junction, both under `@scope`.
    const scope = path.join(tmp, 'npm', 'node_modules', '@qtxsnwwb');
    fs.mkdirSync(path.join(scope, 'bin'), { recursive: true });
    const node = path.join(scope, 'bin', 'node.exe');
    // Idempotent: the timing project retries a failed test in the same temp dir.
    if (!fs.existsSync(node)) {
      try {
        fs.linkSync(process.execPath, node);
      } catch {
        fs.copyFileSync(process.execPath, node);
      }
    }
    junction = path.join(scope, 'agent-canvas');
    if (fs.lstatSync(junction, { throwIfNoEntry: false }) === undefined) fs.symlinkSync(path.resolve(path.dirname(CLI), '..'), junction, 'junction');
    const cli = path.join(scope, 'agent-canvas', 'dist', 'cli.js');
    const c = codexForwardCommands({ nodePath: node, cliPath: cli, port, platform: 'win32', shortPath: windowsShortPath });
    if (!/^[A-Za-z0-9_.:\\~-]+$/.test(tmp)) {
      console.warn(`codex-hook-shell: temp dir ${tmp} is not plain; scoped-path check skipped`);
      return;
    }
    expect(c.windowsForm).toBe('plain');
    expect(c.commandWindows).toBe(`${node} ${cli} hook-forward --origin codex --port ${port}`);
    expect(c.commandWindows).toContain('\\@qtxsnwwb\\');
    for (const way of [...POWERSHELLS, 'cmd', 'cmd-raw'] as const) {
      const r = await run(way, c.commandWindows, codexPayload());
      expect({ way, status: r.status, stdout: r.stdout, stderr: r.stderr, delivered: r.delivered }).toEqual({ way, status: 0, stdout: '', stderr: '', delivered: 1 });
    }
  }, 120_000);

  test('Codex commandWindows as installed: cmd.exe /C delivers (when it is the plain form)', async () => {
    const line = installed();
    if (line.startsWith('&')) {
      // The PowerShell call form is the documented fallback when no plain form exists; it does not run under cmd.
      console.warn('codex-hook-shell: commandWindows is the PowerShell call form here; cmd.exe check skipped');
      return;
    }
    for (const way of ['cmd', 'cmd-raw'] as const) {
      const r = await run(way, line, codexPayload());
      expect({ way, status: r.status, stdout: r.stdout, stderr: r.stderr, delivered: r.delivered }).toEqual({ way, status: 0, stdout: '', stderr: '', delivered: 1 });
    }
  }, 60_000);

  test('control: the form earlier versions wrote ("<node>" "<cli.js>" …) is not delivered under PowerShell', async () => {
    const old = `${windowsQuote(process.execPath)} ${windowsQuote(CLI)} hook-forward --origin codex --port ${port}`;
    const r = await run('powershell', old, codexPayload());
    expect(r.delivered).toBe(0);
    expect(r.status).not.toBe(0);
  }, 60_000);

  test('Cursor command as installed: PowerShell -NoProfile -Command delivers, exit 0, no output for stop', async () => {
    const line = cursorForwardCommand({ nodePath: process.execPath, cliPath: CLI, port, platform: 'win32' });
    const payload = JSON.stringify({
      conversation_id: 'invented-conversation-1',
      generation_id: 'invented-generation-1',
      hook_event_name: 'stop',
      status: 'completed',
      workspace_roots: ['C:\\work\\demo'],
    });
    for (const way of POWERSHELLS) {
      const r = await run(way, line, payload, 'cursor');
      expect(r.error).toBeUndefined();
      expect({ way, status: r.status, stdout: r.stdout, stderr: r.stderr, delivered: r.delivered }).toEqual({ way, status: 0, stdout: '', stderr: '', delivered: 1 });
    }
  }, 60_000);
});
