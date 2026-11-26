import fs from 'node:fs';
import path from 'node:path';
import { removeSync } from '../fs-remove.js';
import type { ServiceDefinition, ServiceSystem } from './types.js';

/** The registration manifest (spec 5): what `install` set up, at a place that does not depend on the data directory. */
export interface ServiceManifest extends ServiceDefinition {
  version: 1;
  platform: NodeJS.Platform;
  where: string;
  installedAt: string;
}

type ManifestSystem = Pick<ServiceSystem, 'platform' | 'env' | 'home'>;

const nonEmpty = (v: string | undefined): v is string => v !== undefined && v !== '';

/** Windows `%APPDATA%\agent-canvas\service.json`, macOS `~/Library/Application Support/agent-canvas/`, elsewhere `$XDG_CONFIG_HOME` (default `~/.config`). */
export function manifestPath(system: ManifestSystem): string {
  const { platform, env, home } = system;
  if (platform === 'win32') {
    const appData = nonEmpty(env.APPDATA) ? env.APPDATA : path.win32.join(home, 'AppData', 'Roaming');
    return path.win32.join(appData, 'agent-canvas', 'service.json');
  }
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'agent-canvas', 'service.json');
  const config = nonEmpty(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.posix.join(home, '.config');
  return path.posix.join(config, 'agent-canvas', 'service.json');
}

const isString = (v: unknown): v is string => typeof v === 'string';

/** The manifest; null when there is none or it is not one. */
export function readManifest(system: ManifestSystem): ServiceManifest | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(manifestPath(system), 'utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const m = value as Record<string, unknown>;
    const env = m.env;
    const ok =
      m.version === 1 &&
      isString(m.platform) &&
      isString(m.where) &&
      isString(m.installedAt) &&
      isString(m.nodePath) &&
      isString(m.cliPath) &&
      isString(m.dataDir) &&
      isString(m.logFile) &&
      typeof m.port === 'number' &&
      Number.isInteger(m.port) &&
      typeof env === 'object' &&
      env !== null &&
      Object.values(env).every(isString) &&
      Array.isArray(m.argv) &&
      m.argv.every(isString);
    return ok ? (value as ServiceManifest) : null;
  } catch {
    return null;
  }
}

export function writeManifest(system: ManifestSystem, manifest: ServiceManifest): void {
  const file = manifestPath(system);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function removeManifest(system: ManifestSystem): void {
  removeSync(manifestPath(system));
}
