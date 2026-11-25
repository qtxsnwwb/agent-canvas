import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { linuxBackend, UNIT_NAME, unitSource } from '../src/service/linux.js';
import type { ServiceDefinition, ServiceSystem } from '../src/service/types.js';

/* The Linux backend against a fake system: no real systemctl is ever run; files go to a temp home. Runs on every platform. */

type Call = { command: string; args: string[] };
type Answer = { code: number; stdout?: string; stderr?: string } | 'enoent';

let tmp: string;
let calls: Call[];
let answer: (c: Call) => Answer;

function fakeSystem(env: NodeJS.ProcessEnv = {}): ServiceSystem {
  return {
    platform: 'linux',
    env,
    home: tmp,
    uid: 1000,
    run: async (command, args) => {
      const c = { command, args };
      calls.push(c);
      const a = answer(c);
      if (a === 'enoent') throw Object.assign(new Error('spawn systemctl ENOENT'), { code: 'ENOENT' });
      return { code: a.code, stdout: a.stdout ?? '', stderr: a.stderr ?? '' };
    },
    spawnDetached: () => {
      throw new Error('linux must not spawn detached');
    },
    sleep: async () => undefined,
    now: () => 0,
  };
}

function definition(): ServiceDefinition {
  const argv = ['/usr/bin/node', '/opt/agent-canvas/cli.js', 'start', '--port', '4399', '--log-file', '/data/logs/service.log', '--service'];
  return {
    nodePath: argv[0]!,
    cliPath: argv[1]!,
    port: 4399,
    dataDir: '/data',
    logFile: '/data/logs/service.log',
    env: { AGENT_CANVAS_DATA_DIR: '/data', GROK_HOME: '/home/a b/grok' },
    argv,
  };
}

const unitFile = () => path.join(tmp, '.config', 'systemd', 'user', UNIT_NAME);
const cmds = () => calls.map((c) => [c.command, ...c.args].join(' '));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-service-linux-'));
  calls = [];
  answer = () => ({ code: 0 });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10 });
});

const EXPECTED = `[Unit]
Description=Agent Canvas

[Service]
ExecStart="/usr/bin/node" "/opt/agent-canvas/cli.js" "start" "--port" "4399" "--log-file" "/data/logs/service.log" "--service"
Environment="AGENT_CANVAS_DATA_DIR=/data"
Environment="GROK_HOME=/home/a b/grok"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;

function unescapeWord(s: string): string {
  return s.replace(/\\([\\"])|%%|\$\$/g, (m, c: string | undefined) => (c !== undefined ? c : m[0]!));
}
function words(line: string): string[] {
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => unescapeWord(m[1]!));
}

describe('unitSource', () => {
  test('is exactly the expected file', () => {
    expect(unitSource(definition())).toBe(EXPECTED);
  });

  test('has no Environment lines when the env is empty', () => {
    expect(unitSource({ ...definition(), env: {} })).not.toContain('Environment=');
  });

  test('argv and env with non-ASCII, spaces and special characters round-trip', () => {
    const argv = ['/home/张 三/node', 'a & b', '<x>', '100%', '$HOME', 'back\\slash', 'q"uote', "it's"];
    const env = { K: '张 三 & <v> % $ \\ "' };
    const text = unitSource({ ...definition(), argv, env });
    expect(words(/^ExecStart=(.*)$/m.exec(text)![1]!)).toEqual(argv);
    expect(words(/^Environment=(.*)$/m.exec(text)![1]!)).toEqual([`K=${env.K}`]);
    expect(text).toContain('"100%%"');
    expect(text).toContain('"$$HOME"');
    expect(text).toContain('"back\\\\slash"');
    expect(text).toContain('"q\\"uote"');
  });

  test('a newline in a value is refused', () => {
    expect(() => unitSource({ ...definition(), env: { K: 'a\nb' } })).toThrow(/换行/);
  });
});

describe('linuxBackend', () => {
  test('where and kind, with the config home from XDG_CONFIG_HOME when set', () => {
    const b = linuxBackend(fakeSystem());
    expect(b.kind).toBe('linux');
    expect(b.where).toBe(`systemd 用户服务（${unitFile()}）`);
    const xdg = path.join(tmp, 'xdg');
    expect(linuxBackend(fakeSystem({ XDG_CONFIG_HOME: xdg })).where).toBe(`systemd 用户服务（${path.join(xdg, 'systemd', 'user', UNIT_NAME)}）`);
    expect(linuxBackend(fakeSystem({ XDG_CONFIG_HOME: '' })).where).toContain(path.join(tmp, '.config'));
  });

  test('check: usable when the user instance answers', async () => {
    expect(await linuxBackend(fakeSystem()).check(definition())).toBeNull();
    expect(cmds()).toEqual(['systemctl --user show-environment']);
  });

  test('check: non-zero or missing systemctl gives the reason, and writes nothing', async () => {
    const reason = '没有找到 systemd 用户服务（例如 WSL、容器里），不能装后台常驻';
    answer = () => ({ code: 1 });
    expect(await linuxBackend(fakeSystem()).check(definition())).toBe(reason);
    answer = () => 'enoent';
    expect(await linuxBackend(fakeSystem()).check(definition())).toBe(reason);
    expect(fs.existsSync(path.join(tmp, '.config'))).toBe(false);
  });

  test('plan shows the path, the full content and the commands', () => {
    const plan = linuxBackend(fakeSystem()).plan(definition()).join('\n');
    expect(plan).toContain(unitFile());
    for (const line of EXPECTED.trimEnd().split('\n').filter((l) => l !== '')) expect(plan).toContain(line);
    expect(plan).toContain('systemctl --user daemon-reload');
    expect(plan).toContain(`systemctl --user enable ${UNIT_NAME}`);
  });

  test('register writes the unit, reloads, enables', async () => {
    await linuxBackend(fakeSystem()).register(definition());
    expect(fs.readFileSync(unitFile(), 'utf8')).toBe(EXPECTED);
    expect(cmds()).toEqual(['systemctl --user daemon-reload', `systemctl --user enable ${UNIT_NAME}`]);
  });

  test('register fails when enable fails', async () => {
    answer = (c) => (c.args[1] === 'enable' ? { code: 1, stderr: 'boom' } : { code: 0 });
    await expect(linuxBackend(fakeSystem()).register(definition())).rejects.toThrow(/enable.*1/);
  });

  test('start and cancelRestart', async () => {
    const b = linuxBackend(fakeSystem());
    await b.start(definition());
    await b.cancelRestart(definition());
    expect(cmds()).toEqual([`systemctl --user start ${UNIT_NAME}`, `systemctl --user stop ${UNIT_NAME}`]);
  });

  test('start fails when systemctl fails', async () => {
    answer = () => ({ code: 5 });
    await expect(linuxBackend(fakeSystem()).start(definition())).rejects.toThrow(/start.*5/);
  });

  test('unregister: disable --now, delete, daemon-reload', async () => {
    const b = linuxBackend(fakeSystem());
    await b.register(definition());
    calls = [];
    await b.unregister(definition());
    expect(cmds()).toEqual([`systemctl --user disable --now ${UNIT_NAME}`, 'systemctl --user daemon-reload']);
    expect(fs.existsSync(unitFile())).toBe(false);
  });

  test('state: absent without a file; disabled when is-enabled says so; else installed', async () => {
    const b = linuxBackend(fakeSystem());
    expect(await b.state(definition())).toBe('absent');
    expect(calls).toEqual([]);
    await b.register(definition());
    calls = [];
    answer = () => ({ code: 0, stdout: 'enabled\n' });
    expect(await b.state(definition())).toBe('installed');
    answer = () => ({ code: 1, stdout: 'disabled\n' });
    expect(await b.state(definition())).toBe('disabled');
    answer = () => ({ code: 1, stdout: 'static\n' });
    expect(await b.state(definition())).toBe('installed');
    expect(cmds()[0]).toBe(`systemctl --user is-enabled ${UNIT_NAME}`);
  });
});
