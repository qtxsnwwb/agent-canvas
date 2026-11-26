import fs from 'node:fs';
import path from 'node:path';
import { removeSync } from '../fs-remove.js';
import type { ServiceBackend, ServiceDefinition, ServiceSystem } from './types.js';

/*
 * Linux: a systemd user unit. Not lingering: it runs while the user is logged in, which matches "start at login".
 */

export const UNIT_NAME = 'agent-canvas.service';

const NO_SYSTEMD = '没有找到 systemd 用户服务（例如 WSL、容器里），不能装后台常驻';

/** A double-quoted unit-file word: `\` and `"` escaped, `%` and `$` doubled so systemd does not expand them. */
function quote(s: string): string {
  if (/[\r\n]/.test(s)) throw new Error(`启动命令和环境变量里不能有换行：${JSON.stringify(s)}`);
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

/** An Environment= value word: no `$` change (Environment= does no variable expansion); `%` is still a specifier. */
function quoteEnv(s: string): string {
  if (/[\r\n]/.test(s)) throw new Error(`启动命令和环境变量里不能有换行：${JSON.stringify(s)}`);
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

export function unitSource(def: ServiceDefinition): string {
  return [
    '[Unit]',
    'Description=Agent Canvas',
    '',
    '[Service]',
    `ExecStart=${def.argv.map(quote).join(' ')}`,
    ...Object.entries(def.env).map(([k, v]) => `Environment=${quoteEnv(`${k}=${v}`)}`),
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function linuxBackend(system: ServiceSystem): ServiceBackend {
  const configHome = system.env.XDG_CONFIG_HOME ? system.env.XDG_CONFIG_HOME : path.join(system.home, '.config');
  const unitPath = path.join(configHome, 'systemd', 'user', UNIT_NAME);
  const ctl = (...args: string[]) => system.run('systemctl', ['--user', ...args]);
  const ctlOrThrow = async (...args: string[]) => {
    const result = await ctl(...args);
    if (result.code !== 0) throw new Error(`systemctl --user ${args.join(' ')} 失败（退出码 ${result.code}）：${result.stderr.trim()}`);
  };

  return {
    kind: 'linux',
    where: `systemd 用户服务（${unitPath}）`,

    async check() {
      const result = await system.run('systemctl', ['--user', 'show-environment']).catch(() => null);
      return result?.code === 0 ? null : NO_SYSTEMD;
    },

    plan(def) {
      return [
        `写 systemd 用户服务文件：${unitPath}`,
        ...unitSource(def)
          .trimEnd()
          .split('\n')
          .map((line) => `  ${line}`),
        '运行命令：',
        '  systemctl --user daemon-reload',
        `  systemctl --user enable ${UNIT_NAME}`,
      ];
    },

    async register(def) {
      fs.mkdirSync(path.dirname(unitPath), { recursive: true });
      fs.writeFileSync(unitPath, unitSource(def));
      await ctlOrThrow('daemon-reload');
      await ctlOrThrow('enable', UNIT_NAME);
    },

    async unregister() {
      await ctl('disable', '--now', UNIT_NAME); // not enabled / not running is fine
      removeSync(unitPath);
      await ctl('daemon-reload');
    },

    async start() {
      await ctlOrThrow('start', UNIT_NAME);
    },

    async cancelRestart() {
      await ctl('stop', UNIT_NAME);
    },

    async state() {
      if (!fs.existsSync(unitPath)) return 'absent';
      const result = await ctl('is-enabled', UNIT_NAME).catch(() => null);
      return result?.stdout.trim() === 'disabled' ? 'disabled' : 'installed';
    },
  };
}
