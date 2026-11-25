#!/usr/bin/env node
/*
 * The `agent-canvas` entry. `hook-forward` runs once per Codex or Cursor hook event, so it must start fast: this module imports
 * nothing heavy itself, and only loads the commands (server, store, pipeline, watcher) when it is not that invocation.
 * Importers (tests) always get the full command set.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hookForwardProcess } from './hook-forward.js';
import { openEarlyProcessLog } from './logfile.js';
import type * as Commands from './cli-commands.js';

export type { MainDeps, Running, StartOptions } from './cli-commands.js';

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const entry = isEntryPoint();
const forwardOnly = entry && process.argv[2] === 'hook-forward';
// The background service (`start --log-file <file>`) logs from before the commands are loaded: a failure to load them
// (a native module built for another Node version, say) goes to its log, not to a terminal it does not have. `start`
// takes this log over (logfile.ts takeProcessLog). hook-forward never takes --log-file.
const early = entry && !forwardOnly ? openEarlyProcessLog(process.argv.slice(2), (code) => process.exit(code)) : null;
let commands: typeof Commands | null = null;
if (!forwardOnly) {
  try {
    commands = await import('./cli-commands.js');
  } catch (err) {
    if (early === null) throw err;
    early.fail(err); // logged, exit 1
  }
}
const loaded = (): typeof Commands => commands!;

export const fileSources: typeof Commands.fileSources = (...args) => loaded().fileSources(...args);
export const rebuildReason: typeof Commands.rebuildReason = (...args) => loaded().rebuildReason(...args);
export const start: typeof Commands.start = (...args) => loaded().start(...args);
export const rebuild: typeof Commands.rebuild = (...args) => loaded().rebuild(...args);
export const compact: typeof Commands.compact = (...args) => loaded().compact(...args);
export const main: typeof Commands.main = (...args) => loaded().main(...args);

if (forwardOnly) {
  hookForwardProcess(process.argv.slice(3));
} else if (entry) {
  void main(process.argv.slice(2)).then((code) => {
    if (code >= 0) process.exit(code);
  });
}
