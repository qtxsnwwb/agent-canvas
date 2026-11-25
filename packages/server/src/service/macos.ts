import fs from 'node:fs';
import path from 'node:path';
import { removeSync } from '../fs-remove.js';
import type { ServiceBackend, ServiceDefinition, ServiceSystem } from './types.js';

/*
 * macOS: a LaunchAgent in ~/Library/LaunchAgents, loaded into the user's GUI domain (gui/<uid>) with launchctl.
 * RunAtLoad starts it at login; KeepAlive restarts it only after a failure (exit code not 0).
 */

export const LAUNCH_AGENT_LABEL = 'io.github.qtxsnwwb.agent-canvas';

const UNLOAD_WAIT_MS = 15000;
const BOOTSTRAP_ATTEMPTS = 3;
const NO_LAUNCHCTL = '没有找到 launchctl，不能装后台常驻';

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function plistSource(def: ServiceDefinition): string {
  const env = Object.entries(def.env);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xml(LAUNCH_AGENT_LABEL)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...def.argv.map((a) => `    <string>${xml(a)}</string>`),
    '  </array>',
    ...(env.length > 0
      ? [
          '  <key>EnvironmentVariables</key>',
          '  <dict>',
          ...env.flatMap(([k, v]) => [`    <key>${xml(k)}</key>`, `    <string>${xml(v)}</string>`]),
          '  </dict>',
        ]
      : []),
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ThrottleInterval</key>',
    '  <integer>10</integer>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function macosBackend(system: ServiceSystem): ServiceBackend {
  const plistPath = path.join(system.home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
  const domain = () => {
    if (system.uid === null) throw new Error('没有用户 id，不能用 launchctl');
    return `gui/${system.uid}`;
  };
  const target = () => `${domain()}/${LAUNCH_AGENT_LABEL}`;
  const bootout = async () => {
    await system.run('launchctl', ['bootout', target()]).catch(() => null); // not loaded is fine
  };
  const bootstrap = async () => {
    const result = await system.run('launchctl', ['bootstrap', domain(), plistPath]);
    if (result.code !== 0) throw new Error(`launchctl bootstrap 失败（退出码 ${result.code}）：${result.stderr.trim()}`);
  };

  /*
   * After bootout the old job may still be exiting; bootstrapping then fails (5, 37), or succeeds while the old process
   * still holds the lock so the new one exits 0 and nothing runs. Wait until launchd no longer knows the job. If it
   * is still loaded after 15 s, go on and try bootstrap anyway: its retries and error then report the real problem.
   */
  const waitUnloaded = async () => {
    const deadline = system.now() + UNLOAD_WAIT_MS;
    for (;;) {
      const loaded = await system.run('launchctl', ['print', target()]).catch(() => null);
      if (loaded === null || loaded.code !== 0) return;
      if (system.now() >= deadline) return;
      await system.sleep(500);
    }
  };
  const bootstrapWithRetry = async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await bootstrap();
      } catch (error) {
        if (attempt >= BOOTSTRAP_ATTEMPTS) throw error;
        await system.sleep(1000);
      }
    }
  };

  return {
    kind: 'macos',
    where: `macOS 登录项（${plistPath}）`,

    async check() {
      if (system.uid === null) return NO_LAUNCHCTL;
      const result = await system.run('launchctl', ['help']).catch(() => null);
      return result === null ? NO_LAUNCHCTL : null;
    },

    plan(def) {
      return [
        `写登录项文件：${plistPath}`,
        ...plistSource(def)
          .trimEnd()
          .split('\n')
          .map((line) => `  ${line}`),
        '运行命令：',
        `  launchctl bootout ${target()}（已经登记过时先卸掉，失败不要紧）`,
        `  launchctl bootstrap ${domain()} ${plistPath}`,
      ];
    },

    async register(def) {
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.writeFileSync(plistPath, plistSource(def));
      await bootout();
      await waitUnloaded();
      await bootstrapWithRetry();
    },

    async unregister() {
      await bootout();
      removeSync(plistPath);
    },

    async start() {
      const loaded = await system.run('launchctl', ['print', target()]);
      if (loaded.code !== 0) await bootstrap();
      const result = await system.run('launchctl', ['kickstart', target()]);
      if (result.code !== 0) throw new Error(`launchctl kickstart 失败（退出码 ${result.code}）：${result.stderr.trim()}`);
    },

    async cancelRestart() {
      await bootout();
    },

    async state() {
      return fs.existsSync(plistPath) ? 'installed' : 'absent';
    },
  };
}
