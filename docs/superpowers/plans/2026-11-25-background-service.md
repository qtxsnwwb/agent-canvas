# Background Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `agent-canvas service install|uninstall|status|start|stop|restart`: the service starts in the background at login (Windows, macOS, Linux), restarts after a crash, stops cleanly on request, and logs to a capped file.

**Architecture:** The running service gains a richer lock record, a per-start control key and a key-guarded `POST /api/control/stop`, SIGTERM handling, a service-mode exit rule and an optional rotating log file. A platform-independent core builds the service definition, the manifest and the stop/status client; three backends (Windows Run key + JScript launcher, macOS LaunchAgent, Linux systemd user unit) register it through an injected `ServiceSystem`. `main` wires the `service` command.

**Tech Stack:** TypeScript, Node 22, Fastify, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-25-background-service-design.md` (binding; its 「决定」 items are rulings the user may overturn).

## Global Constraints

- Tests never read or write the real autostart registration: the Windows Run key, `StartupApproved\Run`, `~/Library/LaunchAgents`, `~/.config/systemd/user`; registry access and every system command (`reg`, `launchctl`, `systemctl`, `wscript`) go through the injected `ServiceSystem.run` / `spawnDetached`, faked in tests. Files are written only under temp HOME / APPDATA / XDG dirs.
- Tests never use port 4317, never the real `~/.agent-canvas`, never the real `~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.cursor/hooks.json`; no real desktop notification. Throwaway servers: temp dirs via `AGENT_CANVAS_*_DIR` plus temp HOME / USERPROFILE / APPDATA / LOCALAPPDATA.
- All user-facing CLI text in Chinese, in the spec's words (「正在运行」「没有运行」「没有安装」「已安装，但在任务管理器里被停用」…).
- Launch argv: `[nodePath, cliPath, 'start', '--port', String(port), '--log-file', logFile, '--service']`; `logFile = <dataDir>/logs/service.log`.
- Log cap: 5 MB per file (5 * 1024 * 1024 bytes), one rotated file `service.log.1`.
- Stop waits at most 30 s for the lock to be released; never kills a process.
- Windows backoff 5, 10, 20, 40, 60 s then 60 s; reset after a run longer than 10 minutes. macOS `ThrottleInterval` 10; Linux `RestartSec=5`.
- Names: Run value `AgentCanvas`; LaunchAgent label `io.github.qtxsnwwb.agent-canvas`; unit `agent-canvas.service`; manifest `service.json`; key file `control.key`; stop marker `<dataDir>/service/stopped`; launcher `<dataDir>/service/launcher.js`.
- `status` exit code 0 when running, 3 when not.
- Root commands: `npx --yes pnpm@10 typecheck`, `npx --yes pnpm@10 build`, `npx --yes pnpm@10 test`; one file `npx --yes pnpm@10 exec vitest run <path>`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push; do not open a PR.

## Review Focus

1. Paths with spaces and non-ASCII characters (`C:\Users\张 三\…`, `/Users/张 三/…`) in node, cli, data and log paths: the launcher, plist and unit carry them intact. (Tasks 3, 4)
2. `install` again with another port while the background service runs: registration and manifest rewritten, the 「已有服务在运行」 hint printed, no second instance started. (Task 5)
3. `stop` when the running service is an older version (lock without port) or is a `rebuild` / `compact`: a clear message, nothing killed, non-zero exit. (Task 2)
4. A service that keeps crashing: `stop` ends the restarts (Windows: the launcher sees the marker before restarting). (Tasks 3, 5)
5. A log file that cannot be written (directory read-only, disk full): the service keeps running and serving. (Task 1)

---

### Task 1: The running service — lock record, control key, stop endpoint, SIGTERM, service mode, log file

**Files:**
- Modify: `packages/server/src/lock.ts`, `packages/server/src/cli-commands.ts` (`start`, `rebuild`, `compact`, `main`'s `start` branch, USAGE), `packages/server/src/api/server.ts` (route)
- Create: `packages/server/src/control.ts`, `packages/server/src/logfile.ts`
- Test: `packages/server/test/lock.test.ts` (extend), `packages/server/test/control.test.ts`, `packages/server/test/logfile.test.ts`, `packages/server/test/service-mode.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // lock.ts
  export type LockCommand = 'start' | 'rebuild' | 'compact';
  export interface LockHolder { pid: number; startedAt: string; command: LockCommand; version: string | null; service: boolean; port: number | null }
  export interface LockInfo { command: LockCommand; version: string; service?: boolean }
  export interface Lock { release(): void; setPort(port: number): void }   // setPort rewrites the file with the port
  export function acquireLock(dataDir: string, info: LockInfo): Lock;      // throws LockHeldError
  export class LockHeldError extends Error { readonly holder: LockHolder }  // message unchanged from today
  export function readLock(dataDir: string): LockHolder | null;            // null: no file, unreadable, or holder not alive
  // control.ts
  export const CONTROL_KEY_FILE = 'control.key';
  export const CONTROL_HEADER = 'x-agent-canvas-key';
  export function createControlKey(dataDir: string): string;   // 64 hex chars (32 random bytes); file mode 0o600; overwrites
  export function readControlKey(dataDir: string): string | null;
  export function removeControlKey(dataDir: string, key: string): void;  // only when the file still holds this key
  export function keyMatches(expected: string, given: unknown): boolean;  // constant time (crypto.timingSafeEqual), false on length mismatch / non-string
  // logfile.ts
  export const LOG_MAX_BYTES = 5 * 1024 * 1024;
  export interface LogFile { write(text: string): void; close(): void }
  export function openLogFile(file: string, opts?: { maxBytes?: number; now?: () => Date }): LogFile;
  export function captureProcessOutput(log: LogFile): () => void;   // patches process.stdout/stderr.write; returns restore
  // server.ts buildServer deps
  control?: { key: string; onStop(): void };   // absent: route not registered
  // cli-commands.ts StartOptions
  service?: boolean;   // recorded in the lock; the control key/route are always on for start()
  ```
- `POST /api/control/stop`: 403 `{ error }` when an `Origin` header is present or `keyMatches(key, req.headers[CONTROL_HEADER])` is false; else 202 `{ stopping: true }` then `onStop()` after the reply is sent.
- `start --log-file <path> --service`: `--log-file` opens the log and calls `captureProcessOutput` before anything prints; each line written as `<ISO time> <line>`.
- `--service` and the lock is held: holder `command === 'start'` → print `agent-canvas: 已有服务在运行（进程号 N），这次不启动` and exit 0; holder `rebuild` / `compact` → print `agent-canvas: 正在重建数据 / 正在压缩数据库（进程号 N），稍后重试` and exit 1. Without `--service`, today's behaviour (message, exit 1).
- SIGTERM handled exactly as SIGINT (close, exit 0). The stop endpoint's `onStop` does the same.

- [ ] **Step 1: Failing tests.**
  - `lock.test.ts`: `acquireLock(dir, { command: 'start', version: '1.2.3', service: true })` then `readLock(dir)` → `{ pid: process.pid, command: 'start', version: '1.2.3', service: true, port: null }`; after `setPort(5000)` → `port: 5000`; an old-format file `{"pid":<live pid>,"startedAt":"…"}` reads as `{ command: 'start', version: null, service: false, port: null }`; a dead pid → `readLock` null; a second `acquireLock` throws `LockHeldError` whose `holder.command` is the first one's and whose message still contains `already running with this data directory`.
  - `control.test.ts`: key is 64 hex chars and differs per call; on POSIX the file mode is `0o600` (`it.skipIf(win32)`); `keyMatches` true for the key, false for wrong / shorter / non-string; `removeControlKey` leaves a file holding another key. Route through `buildServer` with a `control` dep (in-memory store as other API tests): no header → 403; wrong key → 403; right key plus `Origin: http://127.0.0.1:1` → 403; right key → 202 and `onStop` called once; without the `control` dep → 404.
  - `logfile.test.ts`: lines get the ISO prefix; with `maxBytes: 100`, writing 250 bytes leaves `service.log` ≤ 100 bytes and `service.log.1` holding the earlier lines, and only those two files exist; a missing parent directory is created; **Review Focus 5:** a log path inside a directory made read-only (POSIX) / a path whose parent is a file (all platforms) → `write` does not throw.
  - `service-mode.test.ts` (calls `main([...], deps)` with temp dirs and `--port 0`; `statsWarmup` off through the test env): a lock held by a live `start` holder written into the temp data dir → `main(['start','--port','0','--service'])` resolves 0; held by `compact` → resolves 1; `main(['start','--port','0','--log-file', f])` → `f` contains `agent-canvas listening on`; then a real stop request (read port from `readLock`, key from `readControlKey`) → the lock and the key file are gone within 10 s (inject `exit` so the test process survives: add `exit?: (code: number) => void` to `MainDeps`, default `process.exit`).
- [ ] **Step 2: Run; expect failure.**
- [ ] **Step 3: Implement.** `start()` takes the lock with `{ command: 'start', version: packageVersion(), service: options.service === true }`, calls `lock.setPort` after `listen`, creates the key before `buildServer` and removes it in `close()` (before `lock.release()`); `rebuild` / `compact` pass their command. The log writer uses `fs.appendFileSync` and swallows its own errors.
- [ ] **Step 4: Run; expect pass; server suite; typecheck.**
- [ ] **Step 5: Commit:** `feat(service): stop endpoint, richer lock, service mode and log file`.

### Task 2: Service core — environment list, definition, manifest, stop and status client

**Files:**
- Modify: `packages/server/src/config.ts` (export the list)
- Create: `packages/server/src/service/types.ts`, `packages/server/src/service/definition.ts`, `packages/server/src/service/manifest.ts`, `packages/server/src/service/client.ts`
- Test: `packages/server/test/service-core.test.ts`

**Interfaces:**
- Consumes: Task 1's `readLock`, `readControlKey`, `CONTROL_HEADER`, `LockHolder`.
- Produces:
  ```ts
  // config.ts
  export const SERVICE_ENV_VARS: readonly string[];  // exactly the spec 3.4 list, in that order
  // service/types.ts
  export interface ServiceSystem {
    platform: NodeJS.Platform; env: NodeJS.ProcessEnv; home: string; uid: number | null;
    run(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
    spawnDetached(command: string, args: string[]): void;
    sleep(ms: number): Promise<void>; now(): number;
  }
  export function realServiceSystem(): ServiceSystem;   // execFile with windowsHide; spawn detached+unref+windowsHide+stdio ignore
  export interface ServiceDefinition { nodePath: string; cliPath: string; port: number; dataDir: string; logFile: string; env: Record<string, string>; argv: string[] }
  export interface ServiceBackend {
    readonly kind: 'windows' | 'macos' | 'linux';
    readonly where: string;                               // e.g. 「Windows 启动项」 + the key, the plist path, the unit path
    check(def: ServiceDefinition): Promise<string | null>; // null: usable; else a Chinese reason
    plan(def: ServiceDefinition): string[];               // lines printed before confirming (files with contents, registry value, commands)
    register(def: ServiceDefinition): Promise<void>;
    unregister(def: ServiceDefinition): Promise<void>;
    start(def: ServiceDefinition): Promise<void>;
    cancelRestart(def: ServiceDefinition): Promise<void>;
    state(def: ServiceDefinition): Promise<'installed' | 'disabled' | 'absent'>;
  }
  // service/definition.ts
  export function pickServiceEnv(env: NodeJS.ProcessEnv): Record<string, string>;  // set (non-undefined) members of SERVICE_ENV_VARS
  export function serviceDefinition(o: { env: NodeJS.ProcessEnv; port: number; nodePath: string; cliPath: string }): ServiceDefinition;  // dataDir from loadConfig(env)
  // service/manifest.ts
  export interface ServiceManifest extends ServiceDefinition { version: 1; platform: NodeJS.Platform; where: string; installedAt: string }
  export function manifestPath(system: Pick<ServiceSystem, 'platform' | 'env' | 'home'>): string;  // spec 5 locations
  export function readManifest(system: …): ServiceManifest | null;   // null: missing or unparsable
  export function writeManifest(system: …, m: ServiceManifest): void;
  export function removeManifest(system: …): void;
  // service/client.ts
  export type StopResult = 'stopped' | 'not-running' | 'timeout' | 'unreachable' | 'old-version' | 'maintenance';
  export function stopRunning(dataDir: string, o?: { timeoutMs?: number; sleep?: (ms: number) => Promise<void>; fetch?: typeof fetch }): Promise<StopResult>;
  export function waitForStart(dataDir: string, o: { timeoutMs: number; sleep; now }): Promise<LockHolder | null>;  // a `start` holder with a port
  export function formatUptime(ms: number): string;   // 「不到 1 分钟」「N 分」「H 小时 M 分」「D 天 H 小时」
  export function statusLines(o: { holder: LockHolder | null; now: number; state: 'installed' | 'disabled' | 'absent' | 'unsupported'; where: string | null; logFile: string; kind: ServiceBackend['kind'] | null }): { lines: string[]; code: 0 | 3 };
  ```
- `stopRunning`: no live holder → `not-running`; holder `rebuild`/`compact` → `maintenance`; holder without port or no key file → `old-version`; POST fails (connection) → `unreachable`; otherwise poll `readLock` every 200 ms until gone (`stopped`) or `timeoutMs` (default 30 000) → `timeout`.
- `statusLines` texts, per spec 4: `服务：正在运行（进程号 N，端口 P，版本 V，已运行 <uptime>）`; `服务：没有运行`; maintenance holders → `服务：没有运行（正在重建数据，进程号 N）` / `（正在压缩数据库，进程号 N）`; `自动启动：已安装（<where>）` / `自动启动：已安装，但在任务管理器里被停用（<where>）` (Windows) / `自动启动：已安装，但已停用（<where>）` (Linux `is-enabled` disabled) / `自动启动：没有安装` / `自动启动：这个系统不支持`; `日志：<logFile>`.

- [ ] **Step 1: Failing tests (`service-core.test.ts`).** `SERVICE_ENV_VARS` equals the spec list; every quoted upper-case variable name in `config.ts`'s source (regex over the file text) except `APPDATA`, `LOCALAPPDATA` is in it, and setting each to a temp path changes some field of `loadConfig`; `AGENT_CANVAS_TIMING_SCALE` and `AGENT_CANVAS_STATS_WARMUP` are not picked. `serviceDefinition` argv equals the Global Constraints argv with `logFile` under `dataDir/logs`. `manifestPath` for win32 (`APPDATA` set and unset), darwin, linux (`XDG_CONFIG_HOME` set and unset); write → read round-trip; garbage file → null. `stopRunning` against a real `start()` on a temp dir and port 0 → `stopped`; no lock → `not-running`; a live-pid old-format lock → `old-version`; a `compact` holder → `maintenance`; a live holder with a port nothing listens on → `unreachable`; a server whose stop route answers 202 but never exits (stub Fastify on port 0 plus a lock file naming the test's pid) with `timeoutMs: 500` → `timeout`. **Review Focus 3** is the `old-version` and `maintenance` cases. `formatUptime` at 30 s, 5 min, 2 h 3 min, 3 d 4 h. `statusLines` for running / not running / maintenance × installed / disabled / absent / unsupported, codes 0 / 3.
- [ ] **Step 2: Run; expect failure.** **Step 3: Implement.** **Step 4: Run; expect pass; typecheck.**
- [ ] **Step 5: Commit:** `feat(service): definition, manifest, stop and status client`.

### Task 3: Windows backend and launcher

**Files:**
- Create: `packages/server/src/service/windows.ts`
- Test: `packages/server/test/service-windows.test.ts`, `packages/server/test/service-launcher.win.test.ts`

**Interfaces:**
- Consumes: Task 2's `ServiceSystem`, `ServiceBackend`, `ServiceDefinition`.
- Produces:
  ```ts
  export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  export const APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
  export const RUN_VALUE = 'AgentCanvas';
  export function launcherSource(o: { argv: string[]; env: Record<string, string>; markerPath: string; backoffMs?: number[]; resetAfterMs?: number }): string;  // defaults [5000,10000,20000,40000,60000], 600000
  export function runCommandLine(system: ServiceSystem, launcherPath: string): string;  // `"<SystemRoot>\System32\wscript.exe" //B //Nologo "<launcher>"`
  export function windowsBackend(system: ServiceSystem, o?: { runKey?: string; approvedKey?: string }): ServiceBackend;
  ```
- Launcher (JScript, written UTF-16LE with BOM): sets each env var through `WScript.Shell.Environment('PROCESS')`; deletes the marker when it starts; loop: quit if the marker exists; run the argv hidden and wait (`Run(cmd, 0, true)`); quit on exit code 0; quit if the marker exists; next wait from the backoff list (last value repeats), reset to the first after a run longer than `resetAfterMs`. Every argv element is wrapped in double quotes; an element containing `"` is rejected by `launcherSource` (throw).
- `register`: write the launcher; `reg add <RUN_KEY> /v AgentCanvas /t REG_SZ /d <runCommandLine> /f`. `unregister`: `reg delete <RUN_KEY> /v AgentCanvas /f` (exit 1 "not found" is fine), remove `<dataDir>/service/`. `start`: remove the marker, `spawnDetached(wscript, ['//B','//Nologo', launcher])`. `cancelRestart`: write the marker. `state`: `reg query <RUN_KEY> /v AgentCanvas` code ≠ 0 → absent; else `reg query <APPROVED_KEY> /v AgentCanvas`: a `REG_BINARY` whose first byte is odd → disabled, else installed. `check`: write `<dataDir>/service/probe.js` containing `WScript.Quit(7);`, run wscript on it, expect code 7 (else `Windows Script Host 不可用（可能被系统策略禁用），不能装后台常驻`), delete the probe.

- [ ] **Step 1: Failing tests.**
  - `service-windows.test.ts` (any platform; fake `run` recording calls and answering by pattern): `register` writes `launcher.js` starting with the UTF-16LE BOM and issues exactly the `reg add` above (assert the args array); `state` maps `reg query` answers: missing → absent, present with approved `03 00 …` → disabled, `02 00 …` → installed, approved missing → installed; `unregister` issues `reg delete` and removes the service dir; `cancelRestart` creates the marker, `start` removes it then calls `spawnDetached` with wscript; `check` returns the reason when the probe answers code 1. **Review Focus 1:** argv and data dir under `张 三` with spaces: decode the written launcher as UTF-16LE and find each path intact inside quotes; `launcherSource` throws for an argv element containing `"`.
  - `service-launcher.win.test.ts` (`describe.skipIf(process.platform !== 'win32')`; real `wscript.exe`, temp dir only, nothing registered): a launcher whose argv runs a small node script that appends a line to a counter file and exits with codes from a list (`1,1,0`), `backoffMs: [100, 100]` → three runs, then the launcher process ends; with codes always `1` and the marker created after the second run → the launcher ends within 2 s without a third run (**Review Focus 4**); env vars set by the launcher reach the child (the child writes `process.env.AGENT_CANVAS_DATA_DIR` to a file). Kill any leftover wscript started by the test in `afterEach`.
- [ ] **Step 2: Run; expect failure.** **Step 3: Implement.** **Step 4: Run; expect pass; typecheck.**
- [ ] **Step 5: Commit:** `feat(service): Windows startup entry and launcher`.

### Task 4: macOS and Linux backends

**Files:**
- Create: `packages/server/src/service/macos.ts`, `packages/server/src/service/linux.ts`, `packages/server/src/service/backend.ts`
- Test: `packages/server/test/service-macos.test.ts`, `packages/server/test/service-linux.test.ts`

**Interfaces:**
- Consumes: Task 2's types; Task 3's `windowsBackend`.
- Produces:
  ```ts
  // macos.ts
  export const LAUNCH_AGENT_LABEL = 'io.github.qtxsnwwb.agent-canvas';
  export function plistSource(def: ServiceDefinition): string;
  export function macosBackend(system: ServiceSystem): ServiceBackend;   // plist at <home>/Library/LaunchAgents/<label>.plist
  // linux.ts
  export const UNIT_NAME = 'agent-canvas.service';
  export function unitSource(def: ServiceDefinition): string;
  export function linuxBackend(system: ServiceSystem): ServiceBackend;   // unit at ($XDG_CONFIG_HOME || <home>/.config)/systemd/user/agent-canvas.service
  // backend.ts
  export function serviceBackend(system: ServiceSystem): ServiceBackend | null;  // win32 / darwin / linux; null otherwise
  ```
- macOS plist: `Label`; `ProgramArguments` = argv; `EnvironmentVariables` only when non-empty; `RunAtLoad` true; `KeepAlive` `<dict><key>SuccessfulExit</key><false/></dict>`; `ThrottleInterval` 10; strings XML-escaped. `register`: write; `launchctl bootout gui/<uid>/<label>` (failure ignored); `launchctl bootstrap gui/<uid> <plist>`. `start`: `launchctl print gui/<uid>/<label>` ≠ 0 → bootstrap; then `launchctl kickstart gui/<uid>/<label>`. `cancelRestart` and the first step of `unregister`: `launchctl bootout gui/<uid>/<label>` (failure ignored); `unregister` then deletes the plist. `state`: plist exists → installed, else absent. `check`: `uid === null` or `launchctl` missing (`run('launchctl', ['help'])` throws/ENOENT) → reason.
- Linux unit: `[Unit] Description=Agent Canvas`; `[Service] ExecStart=` argv, each element in double quotes with `\` → `\\`, `"` → `\"`, `%` → `%%`, `$` → `$$`; one `Environment="K=V"` line per env var (same escaping); `Restart=on-failure`; `RestartSec=5`; `[Install] WantedBy=default.target`. `check`: `systemctl --user show-environment` ≠ 0 or ENOENT → `没有找到 systemd 用户服务（例如 WSL、容器里），不能装后台常驻`. `register`: write, `daemon-reload`, `enable agent-canvas.service`. `start`: `systemctl --user start agent-canvas.service`. `cancelRestart`: `systemctl --user stop agent-canvas.service`. `unregister`: `disable --now`, delete, `daemon-reload`. `state`: no file → absent; `is-enabled` stdout `disabled` → disabled; else installed.

- [ ] **Step 1: Failing tests** (any platform, fake `run`, temp home): exact `plistSource` / `unitSource` for a fixed definition (inline expected strings); the command sequences of register / start (loaded and not loaded) / cancelRestart / unregister / state / check; `serviceBackend` by platform (`freebsd` → null). **Review Focus 1:** argv and env with `张 三`, spaces, `&`, `<`, `%`, `$`, `\` survive: parse the plist back with a minimal regex over `<string>` and the unit's `ExecStart` with the inverse escaping, compare to the input.
- [ ] **Step 2: Run; expect failure.** **Step 3: Implement.** **Step 4: Run; expect pass; typecheck.**
- [ ] **Step 5: Commit:** `feat(service): macOS LaunchAgent and Linux systemd user unit`.

### Task 5: The `service` command

**Files:**
- Modify: `packages/server/src/cli-commands.ts` (`main`, `MainDeps`, USAGE)
- Create: `packages/server/src/service/command.ts`
- Test: `packages/server/test/service-command.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: `export function serviceCommand(args: string[], o: { system: ServiceSystem; io: HooksCliIo; cliPath: string; nodePath: string; backend?: ServiceBackend | null }): Promise<number>`; `MainDeps` gains `serviceSystem?: ServiceSystem` and `serviceBackend?: ServiceBackend | null` (tests); `main` routes `service` there with `deps.hooksIo ?? terminalIo()`.
- Behaviour per spec 4, with these exact rules:
  - Which data dir / port: the manifest's when `readManifest` returns one, else `loadConfig(system.env)`.
  - `install [--port <n>] [--yes]`: `isNpxPath(cliPath)` → the hooks-style message naming `npm install -g @qtxsnwwb/agent-canvas`, exit 1; backend null → `这个系统不支持后台常驻（只支持 Windows、macOS、Linux）`, exit 1; `check` reason → print, exit 1; print `backend.plan(def)` and the manifest path, plus `更新已有的安装` when a manifest exists; not interactive and no `--yes` → refuse as hooks install does; declined → exit 1, nothing written; `register`, `writeManifest`; a live `start` holder → `已有服务在运行（进程号 N）；先停掉它，再运行 agent-canvas service start`, exit 0, not started; else `start`, `waitForStart(timeoutMs 15000)` → `已在后台启动：http://127.0.0.1:<port>` exit 0, or `已登记，但服务没有在 15 秒内起来，看日志：<logFile>` exit 1.
  - `uninstall [--yes]`: no manifest and `state` absent → `没有安装`, exit 0; confirm; `stopRunning`; `cancelRestart`; `unregister`; `removeManifest`; prints what was removed.
  - `status`: `statusLines`; exit 0 / 3.
  - `start`: no manifest → `还没有安装后台常驻：先运行 agent-canvas service install，或在终端里用 agent-canvas start`, exit 1; running → say so, 0; else `backend.start`, `waitForStart` as install.
  - `stop`: `stopRunning` (any instance, also a terminal one); when a manifest exists also `cancelRestart`; messages per `StopResult` (`已停止`; `没有在运行`; `服务没有在 30 秒内退出` exit 1; `服务在运行，但不能用这个命令停止（版本较旧，或不是后台常驻启动的）：请在它的终端里按 Ctrl+C` exit 1; `正在重建数据 / 压缩数据库，做完会自己退出` exit 1; `连不上服务` exit 1).
  - `restart`: `stop` then `start`; needs a manifest.
- [ ] **Step 1: Failing tests** (fake backend recording calls, real temp data dirs, `realServiceSystem` replaced by a fake with temp `home` / `env`): install from an npx path refused; unsupported platform refused; `check` reason printed; non-interactive without `--yes` refused and nothing written; declined → nothing written; install writes the manifest and calls register then start, prints the URL when a fake `start` launches a real `start()` on port 0 in the temp dir; **Review Focus 2:** install while a `start` holder is live → register called, start not called, hint printed, manifest port updated; uninstall order (stop → cancelRestart → unregister → manifest removed); status codes 0 / 3 reading the manifest's data dir while `system.env` names another; stop with a manifest calls `cancelRestart` even when nothing runs (**Review Focus 4**); stop of an `old-version` holder exits 1 with the Ctrl+C message; restart = stop then start; `--help` lists the six `service` lines.
- [ ] **Step 2: Run; expect failure.** **Step 3: Implement.** **Step 4: Run; expect pass; whole suite; typecheck; build.**
- [ ] **Step 5: Commit:** `feat(service): the service command`.

### Task 6: Docs and full verification

**Files:**
- Modify: `docs/manual.md` (「后台常驻」 section after 「安装与启动」), `README.md` (one line in the install part pointing to it), the spec's status line (`已实现（分支 feat/service；未发布）`)

- [ ] **Step 1:** Manual per spec 8, every sentence checked against the code: the mechanism and where its files / registry value live on each system; each command and its exit codes; why `stop` is not undone by the system; log path and 10 MB cap; global install or source checkout, not `npx`; the recorded variables (list them) and re-running `install` after changing them; `service restart` after upgrading; the control key and not putting the data directory in a shared place; Linux notifications need the session's display / D-Bus in the systemd user environment; tested on Windows only, macOS not tested, Linux only the generated files.
- [ ] **Step 2: Full verification:** `npx --yes pnpm@10 typecheck && npx --yes pnpm@10 build && npx --yes pnpm@10 test && npx --yes pnpm@10 release`.
- [ ] **Step 3: Commit:** `docs(service): manual section`.

---

## After the tasks (controller)

- Whole-branch review.
- Real check on the user's Windows machine **only after the user agrees** (it writes their Run key): `service install` from the source checkout, `status`, open the page, `stop` (then `status` shows not running and no restart within 2 minutes), `start`, sign out and back in (no window, service up), `uninstall` (Run value gone, `<dataDir>/service` gone, data untouched). Back up the database first as before.
- Push, PR, merge only when the user asks.
