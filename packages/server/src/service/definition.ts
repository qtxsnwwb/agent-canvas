import path from 'node:path';
import { loadConfig, SERVICE_ENV_VARS, userPath } from '../config.js';
import type { ServiceDefinition } from './types.js';

/** The members of SERVICE_ENV_VARS that are set in `env` (the empty string is a value: it switches a source off). */
export function pickServiceEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of SERVICE_ENV_VARS) {
    const value = env[name];
    if (value !== undefined) picked[name] = value;
  }
  return picked;
}

/** The variables Qwen Code reads with a leading `~` meaning the home directory (config.ts userPath). */
const TILDE_VARS: readonly string[] = ['AGENT_CANVAS_QWEN_DIR', 'QWEN_RUNTIME_DIR', 'QWEN_HOME'];

/**
 * `env` with every non-empty member of SERVICE_ENV_VARS (all of them name a directory or a file) made absolute against
 * `cwd`, the directory `install` runs in: the background service starts elsewhere. In the Qwen variables a leading `~`
 * is the home directory, as config.ts reads them. Other variables and empty values (a source switched off) are kept.
 */
export function absoluteServiceEnv(env: NodeJS.ProcessEnv, o: { cwd: string; home: string; platform: NodeJS.Platform }): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of SERVICE_ENV_VARS) {
    const value = env[name];
    if (value === undefined || value === '') continue;
    const tilde = TILDE_VARS.includes(name) && (value === '~' || value.startsWith('~/') || (o.platform === 'win32' && value.startsWith('~\\')));
    out[name] = tilde ? userPath(value, o.home, o.platform) : path.resolve(o.cwd, value);
  }
  return out;
}

/** The service as installed from this shell: its data directory is the one `env` selects. */
export function serviceDefinition(o: { env: NodeJS.ProcessEnv; port: number; nodePath: string; cliPath: string }): ServiceDefinition {
  const dataDir = loadConfig(o.env).dataDir;
  const logFile = path.join(dataDir, 'logs', 'service.log');
  return {
    nodePath: o.nodePath,
    cliPath: o.cliPath,
    port: o.port,
    dataDir,
    logFile,
    env: pickServiceEnv(o.env),
    argv: [o.nodePath, o.cliPath, 'start', '--port', String(o.port), '--log-file', logFile, '--service'],
  };
}
