import path from 'node:path';
import { loadConfig, SERVICE_ENV_VARS } from '../config.js';
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
