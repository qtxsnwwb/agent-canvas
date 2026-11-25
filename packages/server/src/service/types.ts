import { execFile, spawn } from 'node:child_process';
import os from 'node:os';

/** Everything the service code needs from the system, injected so tests never touch the real registration. */
export interface ServiceSystem {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  /** The user id (macOS `launchctl gui/<uid>`); null where there is none (Windows). */
  uid: number | null;
  /** Runs a command to its end. Resolves with its exit code (also when non-zero); rejects when it cannot be started (ENOENT). */
  run(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Starts a command and lets it outlive this process, without a window. */
  spawnDetached(command: string, args: string[]): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export function realServiceSystem(): ServiceSystem {
  return {
    platform: process.platform,
    env: process.env,
    home: os.homedir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    run: (command, args) =>
      new Promise((resolve, reject) => {
        execFile(command, args, { windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
          if (error === null) return resolve({ code: 0, stdout, stderr });
          const code: unknown = (error as { code?: unknown }).code;
          if (typeof code === 'number') return resolve({ code, stdout, stderr });
          reject(error); // not started (ENOENT, EACCES) or killed
        });
      }),
    spawnDetached: (command, args) => {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => undefined); // a command that cannot start must not crash the caller
      child.unref();
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

/** What the background service runs, and where (the same on every system). */
export interface ServiceDefinition {
  nodePath: string;
  cliPath: string;
  port: number;
  dataDir: string;
  logFile: string;
  /** The recorded environment variables (pickServiceEnv). */
  env: Record<string, string>;
  argv: string[];
}

/** One system's way to register, start and look up the service. */
export interface ServiceBackend {
  readonly kind: 'windows' | 'macos' | 'linux';
  /** Where the registration lives, for messages: 「Windows 启动项」 + the key, the plist path, the unit path. */
  readonly where: string;
  /** null: usable; else the reason, in Chinese. */
  check(def: ServiceDefinition): Promise<string | null>;
  /** Lines printed before the user confirms: files with contents, the registry value, the commands. */
  plan(def: ServiceDefinition): string[];
  register(def: ServiceDefinition): Promise<void>;
  unregister(def: ServiceDefinition): Promise<void>;
  start(def: ServiceDefinition): Promise<void>;
  /** Stops the system from restarting a service that just crashed. */
  cancelRestart(def: ServiceDefinition): Promise<void>;
  state(def: ServiceDefinition): Promise<'installed' | 'disabled' | 'absent'>;
}
