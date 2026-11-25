import fs from 'node:fs';
import path from 'node:path';
import { removeSync } from '../fs-remove.js';
import type { ServiceBackend, ServiceDefinition, ServiceSystem } from './types.js';

/*
 * Windows: a value under the current user's Run key starts `wscript.exe` on a JScript launcher at login. The launcher
 * runs node hidden (no console window) and restarts it after a failure, with growing waits; a marker file stops it.
 *
 * reg.exe prints in the console's OEM code page, not UTF-8: decisions use exit codes and ASCII text only.
 */

export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
export const RUN_VALUE = 'AgentCanvas';

const BACKOFF_MS = [5000, 10000, 20000, 40000, 60000];
const RESET_AFTER_MS = 600000;
/** How often the launcher looks for the marker while it waits to restart. */
const MARKER_POLL_MS = 500;

const WSH_UNAVAILABLE = 'Windows Script Host 不可用（可能被系统策略禁用），不能装后台常驻';

/** A JScript (ES3) string literal: single quotes; everything but printable text escaped. */
function jsString(s: string): string {
  const body = s.replace(/[\\'\u0000-\u001f\u2028\u2029]/g, (c) => {
    if (c === '\\') return '\\\\';
    if (c === "'") return "\\'";
    return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
  return `'${body}'`;
}

/** The command line the launcher runs: every element in double quotes. */
function commandLine(argv: string[]): string {
  for (const a of argv) {
    if (a.includes('"')) throw new Error(`启动命令的参数里不能有双引号：${a}`);
  }
  return argv.map((a) => `"${a}"`).join(' ');
}

/** The JScript launcher: sets the env, runs the command hidden, restarts it after a failure until the marker appears. */
export function launcherSource(o: {
  argv: string[];
  env: Record<string, string>;
  markerPath: string;
  backoffMs?: number[];
  resetAfterMs?: number;
}): string {
  const command = commandLine(o.argv);
  const backoff = o.backoffMs ?? BACKOFF_MS;
  if (backoff.length === 0) throw new Error('backoffMs must not be empty');
  const resetAfter = o.resetAfterMs ?? RESET_AFTER_MS;
  const env = Object.entries(o.env).map(([name, value]) => `env(${jsString(name)}) = ${jsString(value)};`);
  return [
    '// Agent Canvas background service launcher, written by `agent-canvas service install`; run by wscript.exe at login.',
    '// Runs the service hidden; after a failure (exit code not 0) waits and runs it again. The marker file stops it.',
    "var shell = WScript.CreateObject('WScript.Shell');",
    "var fso = WScript.CreateObject('Scripting.FileSystemObject');",
    "var env = shell.Environment('PROCESS');",
    ...env,
    `var command = ${jsString(command)};`,
    `var marker = ${jsString(o.markerPath)};`,
    `var backoff = [${backoff.join(', ')}];`,
    `var resetAfter = ${resetAfter};`,
    // Also stops when this script is gone: uninstall writes the marker, then deletes the whole service directory.
    'function stopped() { return fso.FileExists(marker) || !fso.FileExists(WScript.ScriptFullName); }',
    'function now() { return new Date().getTime(); }',
    'function wait(ms) {',
    '  var end = now() + ms;',
    '  while (!stopped()) {',
    '    var left = end - now();',
    '    if (left <= 0) return;',
    `    WScript.Sleep(left < ${MARKER_POLL_MS} ? left : ${MARKER_POLL_MS});`,
    '  }',
    '}',
    'if (stopped()) fso.DeleteFile(marker, true);',
    'var attempt = 0;',
    'while (!stopped()) {',
    '  var began = now();',
    '  var code = shell.Run(command, 0, true);',
    '  if (code == 0 || stopped()) break;',
    '  if (now() - began > resetAfter) attempt = 0;',
    '  wait(backoff[attempt < backoff.length ? attempt : backoff.length - 1]);',
    '  attempt++;',
    '}',
    '',
  ].join('\r\n');
}

function system32(system: ServiceSystem, exe: string): string {
  const root = system.env.SystemRoot ?? system.env.SYSTEMROOT ?? system.env.windir ?? 'C:\\Windows';
  return path.win32.join(root, 'System32', exe);
}

/** The Run value: wscript in batch mode, no logo, on the launcher. */
export function runCommandLine(system: ServiceSystem, launcherPath: string): string {
  return `"${system32(system, 'wscript.exe')}" //B //Nologo "${launcherPath}"`;
}

export function windowsBackend(system: ServiceSystem, o: { runKey?: string; approvedKey?: string } = {}): ServiceBackend {
  const runKey = o.runKey ?? RUN_KEY;
  const approvedKey = o.approvedKey ?? APPROVED_KEY;
  const reg = system32(system, 'reg.exe');
  const wscript = system32(system, 'wscript.exe');
  const serviceDir = (def: ServiceDefinition) => path.join(def.dataDir, 'service');
  const launcherPath = (def: ServiceDefinition) => path.join(serviceDir(def), 'launcher.js');
  const markerPath = (def: ServiceDefinition) => path.join(serviceDir(def), 'stopped');
  const source = (def: ServiceDefinition) => launcherSource({ argv: def.argv, env: def.env, markerPath: markerPath(def) });

  return {
    kind: 'windows',
    where: `Windows 启动项（${runKey}\\${RUN_VALUE}）`,

    async check(def) {
      const probe = path.join(serviceDir(def), 'probe.js');
      const created = fs.mkdirSync(serviceDir(def), { recursive: true });
      try {
        fs.writeFileSync(probe, 'WScript.Quit(7);\r\n');
        const result = await system.run(wscript, ['//B', '//Nologo', probe]).catch(() => null);
        return result?.code === 7 ? null : WSH_UNAVAILABLE;
      } finally {
        removeSync(probe);
        // Checking writes nothing that stays: remove the directories the probe needed.
        if (created !== undefined) removeSync(created, { recursive: true });
      }
    },

    plan(def) {
      const launcher = launcherPath(def);
      const envLines = Object.entries(def.env).map(([name, value]) => `    ${name}=${value}`);
      return [
        `写注册表：${runKey} 的值 ${RUN_VALUE}（REG_SZ）`,
        `  ${runCommandLine(system, launcher)}`,
        '  登录 Windows 后运行；wscript 在后台隐藏运行启动脚本，不弹窗口。',
        `写启动脚本：${launcher}`,
        `  运行：${commandLine(def.argv)}`,
        '  服务异常退出（退出码不是 0）时等 5、10、20、40、60 秒后再启动，之后每次 60 秒；正常退出不再启动。',
        ...(envLines.length > 0 ? ['  环境变量：', ...envLines] : ['  环境变量：没有记下的']),
      ];
    },

    async register(def) {
      fs.mkdirSync(serviceDir(def), { recursive: true });
      const text = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source(def), 'utf16le')]);
      fs.writeFileSync(launcherPath(def), text);
      const args = ['add', runKey, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', runCommandLine(system, launcherPath(def)), '/f'];
      const result = await system.run(reg, args);
      if (result.code !== 0) throw new Error(`写注册表启动项失败（reg add 退出码 ${result.code}）`);
    },

    async unregister(def) {
      const result = await system.run(reg, ['delete', runKey, '/v', RUN_VALUE, '/f']);
      // 1: the value is not there (or could not be deleted; `state` tells which).
      if (result.code !== 0 && result.code !== 1) throw new Error(`删除注册表启动项失败（reg delete 退出码 ${result.code}）`);
      removeSync(serviceDir(def), { recursive: true });
    },

    async start(def) {
      removeSync(markerPath(def));
      system.spawnDetached(wscript, ['//B', '//Nologo', launcherPath(def)]);
    },

    async cancelRestart(def) {
      fs.mkdirSync(serviceDir(def), { recursive: true });
      fs.writeFileSync(markerPath(def), '');
    },

    async state() {
      const run = await system.run(reg, ['query', runKey, '/v', RUN_VALUE]);
      if (run.code !== 0) return 'absent';
      const approved = await system.run(reg, ['query', approvedKey, '/v', RUN_VALUE]);
      if (approved.code !== 0) return 'installed';
      // Task Manager writes 02 00 … (enabled) or 03 00 … (disabled): an odd first byte means disabled.
      const first = /REG_BINARY\s+([0-9A-Fa-f]{2})/.exec(approved.stdout)?.[1];
      return first !== undefined && parseInt(first, 16) % 2 === 1 ? 'disabled' : 'installed';
    },
  };
}
