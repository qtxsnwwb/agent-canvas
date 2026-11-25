import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { serviceBackend } from '../src/service/backend.js';
import { LAUNCH_AGENT_LABEL, macosBackend, plistSource } from '../src/service/macos.js';
import type { ServiceDefinition, ServiceSystem } from '../src/service/types.js';

/* The macOS backend against a fake system: no real launchctl is ever run; files go to a temp home. Runs on every platform. */

type Call = { command: string; args: string[] };
type Answer = { code: number; stdout?: string; stderr?: string } | 'enoent';

let tmp: string;
let calls: Call[];
let answer: (c: Call) => Answer;

function fakeSystem(uid: number | null = 501): ServiceSystem {
  return {
    platform: 'darwin',
    env: {},
    home: tmp,
    uid,
    run: async (command, args) => {
      const c = { command, args };
      calls.push(c);
      const a = answer(c);
      if (a === 'enoent') throw Object.assign(new Error('spawn launchctl ENOENT'), { code: 'ENOENT' });
      return { code: a.code, stdout: a.stdout ?? '', stderr: a.stderr ?? '' };
    },
    spawnDetached: () => {
      throw new Error('macOS must not spawn detached');
    },
    sleep: async () => undefined,
    now: () => 0,
  };
}

function definition(): ServiceDefinition {
  const argv = ['/usr/local/bin/node', '/opt/agent-canvas/cli.js', 'start', '--port', '4399', '--log-file', '/data/logs/service.log', '--service'];
  return {
    nodePath: argv[0]!,
    cliPath: argv[1]!,
    port: 4399,
    dataDir: '/data',
    logFile: '/data/logs/service.log',
    env: { AGENT_CANVAS_DATA_DIR: '/data' },
    argv,
  };
}

const plistFile = () => path.join(tmp, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
const target = `gui/501/${LAUNCH_AGENT_LABEL}`;
const cmds = () => calls.map((c) => [c.command, ...c.args].join(' '));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-service-mac-'));
  calls = [];
  answer = () => ({ code: 0 });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10 });
});

const EXPECTED = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.github.qtxsnwwb.agent-canvas</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/opt/agent-canvas/cli.js</string>
    <string>start</string>
    <string>--port</string>
    <string>4399</string>
    <string>--log-file</string>
    <string>/data/logs/service.log</string>
    <string>--service</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENT_CANVAS_DATA_DIR</key>
    <string>/data</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
`;

function unxml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function strings(block: string): string[] {
  return [...block.matchAll(/<string>(.*?)<\/string>/g)].map((m) => unxml(m[1]!));
}

describe('plistSource', () => {
  test('is exactly the expected file', () => {
    expect(plistSource(definition())).toBe(EXPECTED);
  });

  test('has no EnvironmentVariables when the env is empty', () => {
    expect(plistSource({ ...definition(), env: {} })).toBe(EXPECTED.replace(/  <key>EnvironmentVariables<\/key>\n {2}<dict>\n.*\n.*\n {2}<\/dict>\n/, ''));
    expect(plistSource({ ...definition(), env: {} })).not.toContain('EnvironmentVariables');
  });

  test('argv and env with non-ASCII, spaces and XML/shell characters round-trip', () => {
    const argv = ['/Users/张 三/node', 'a & b', '<x>', '100%', '$HOME', 'back\\slash', 'q"uote\'s'];
    const env = { 'K&<>': '张 三 & <v> % $ \\ "\'' };
    const text = plistSource({ ...definition(), argv, env });
    const args = /<key>ProgramArguments<\/key>([\s\S]*?)<\/array>/.exec(text)![1]!;
    expect(strings(args)).toEqual(argv);
    const envBlock = /<key>EnvironmentVariables<\/key>([\s\S]*?)<\/dict>/.exec(text)![1]!;
    expect(unxml(/<key>(.*?)<\/key>/.exec(envBlock)![1]!)).toBe('K&<>');
    expect(strings(envBlock)).toEqual([env['K&<>']]);
    expect(text).not.toMatch(/<string>[^<]*[&](?!amp;|lt;|gt;|quot;|apos;)/);
  });
});

describe('macosBackend', () => {
  test('where and kind', () => {
    const b = macosBackend(fakeSystem());
    expect(b.kind).toBe('macos');
    expect(b.where).toBe(`macOS 登录项（${plistFile()}）`);
  });

  test('check: usable when launchctl answers', async () => {
    expect(await macosBackend(fakeSystem()).check(definition())).toBeNull();
    expect(cmds()).toEqual(['launchctl help']);
  });

  test('check: launchctl missing, or no uid, gives the reason', async () => {
    answer = () => 'enoent';
    expect(await macosBackend(fakeSystem()).check(definition())).toBe('没有找到 launchctl，不能装后台常驻');
    calls = [];
    expect(await macosBackend(fakeSystem(null)).check(definition())).toBe('没有找到 launchctl，不能装后台常驻');
    expect(calls).toEqual([]);
  });

  test('plan shows the path, the full content and the commands', () => {
    const plan = macosBackend(fakeSystem()).plan(definition()).join('\n');
    expect(plan).toContain(plistFile());
    for (const line of EXPECTED.trimEnd().split('\n')) expect(plan).toContain(line);
    expect(plan).toContain(`launchctl bootout ${target}`);
    expect(plan).toContain(`launchctl bootstrap gui/501 ${plistFile()}`);
  });

  test('register writes the plist, boots out (failure ignored), then bootstraps', async () => {
    answer = (c) => (c.args[0] === 'bootout' ? { code: 113 } : { code: 0 });
    await macosBackend(fakeSystem()).register(definition());
    expect(fs.readFileSync(plistFile(), 'utf8')).toBe(EXPECTED);
    expect(cmds()).toEqual([`launchctl bootout ${target}`, `launchctl bootstrap gui/501 ${plistFile()}`]);
  });

  test('register fails when bootstrap fails', async () => {
    answer = (c) => (c.args[0] === 'bootstrap' ? { code: 5, stderr: 'Bootstrap failed' } : { code: 0 });
    await expect(macosBackend(fakeSystem()).register(definition())).rejects.toThrow(/bootstrap.*5/);
  });

  test('start: loaded -> kickstart only', async () => {
    await macosBackend(fakeSystem()).start(definition());
    expect(cmds()).toEqual([`launchctl print ${target}`, `launchctl kickstart ${target}`]);
  });

  test('start: not loaded -> bootstrap, then kickstart', async () => {
    answer = (c) => (c.args[0] === 'print' ? { code: 113 } : { code: 0 });
    await macosBackend(fakeSystem()).start(definition());
    expect(cmds()).toEqual([`launchctl print ${target}`, `launchctl bootstrap gui/501 ${plistFile()}`, `launchctl kickstart ${target}`]);
  });

  test('cancelRestart boots out, ignoring failure and a missing launchctl', async () => {
    answer = () => ({ code: 113 });
    await macosBackend(fakeSystem()).cancelRestart(definition());
    answer = () => 'enoent';
    await macosBackend(fakeSystem()).cancelRestart(definition());
    expect(cmds()).toEqual([`launchctl bootout ${target}`, `launchctl bootout ${target}`]);
  });

  test('unregister boots out, then deletes the plist', async () => {
    const b = macosBackend(fakeSystem());
    await b.register(definition());
    calls = [];
    answer = () => ({ code: 113 });
    await b.unregister(definition());
    expect(cmds()).toEqual([`launchctl bootout ${target}`]);
    expect(fs.existsSync(plistFile())).toBe(false);
    await b.unregister(definition()); // already gone: fine
  });

  test('state follows the plist file', async () => {
    const b = macosBackend(fakeSystem());
    expect(await b.state(definition())).toBe('absent');
    await b.register(definition());
    expect(await b.state(definition())).toBe('installed');
    await b.unregister(definition());
    expect(await b.state(definition())).toBe('absent');
  });
});

describe('serviceBackend', () => {
  test.each([
    ['win32', 'windows'],
    ['darwin', 'macos'],
    ['linux', 'linux'],
  ] as const)('%s -> %s', (platform, kind) => {
    expect(serviceBackend({ ...fakeSystem(), platform })?.kind).toBe(kind);
  });

  test('other platforms have none', () => {
    expect(serviceBackend({ ...fakeSystem(), platform: 'freebsd' })).toBeNull();
  });
});
