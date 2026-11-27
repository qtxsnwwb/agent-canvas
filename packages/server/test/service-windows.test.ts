import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ServiceDefinition, ServiceSystem } from '../src/service/types.js';
import { APPROVED_KEY, launcherSource, RUN_KEY, RUN_VALUE, runCommandLine, windowsBackend } from '../src/service/windows.js';
import { removeTestPath } from './remove-test-path.js';

/*
 * The Windows backend against a fake system: every `reg` and `wscript` call goes to a recording fake `run`, so no test
 * reads or writes the real registry. Files go to a temp data directory. Runs on every platform.
 */

type Call = { command: string; args: string[] };
type Answer = { code: number; stdout?: string; stderr?: string };

let tmp: string;
let calls: Call[];
let spawned: Call[];
let answer: (c: Call) => Answer;

function fakeSystem(): ServiceSystem {
  return {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    home: tmp,
    uid: null,
    run: async (command, args) => {
      const c = { command, args };
      calls.push(c);
      const a = answer(c);
      return { code: a.code, stdout: a.stdout ?? '', stderr: a.stderr ?? '' };
    },
    spawnDetached: (command, args) => {
      spawned.push({ command, args });
    },
    sleep: async () => undefined,
    now: () => 0,
  };
}

function definition(dataDir: string): ServiceDefinition {
  const nodePath = path.join(tmp, '张 三', 'node.exe');
  const cliPath = path.join(tmp, '张 三', 'app dir', 'cli.js');
  const logFile = path.join(dataDir, 'logs', 'service.log');
  return {
    nodePath,
    cliPath,
    port: 4399,
    dataDir,
    logFile,
    env: { AGENT_CANVAS_DATA_DIR: dataDir, GROK_HOME: '' },
    argv: [nodePath, cliPath, 'start', '--port', '4399', '--log-file', logFile, '--service'],
  };
}

/** The JScript string literal the launcher uses for `s` (single quotes; backslashes doubled). */
function jsText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function readLauncher(dataDir: string): { bytes: Buffer; text: string } {
  const bytes = fs.readFileSync(path.join(dataDir, 'service', 'launcher.js'));
  return { bytes, text: bytes.subarray(2).toString('utf16le') };
}

const WSCRIPT = 'C:\\Windows\\System32\\wscript.exe';
const isReg = (c: Call) => /reg(\.exe)?$/i.test(c.command);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-service-win-'));
  calls = [];
  spawned = [];
  answer = () => ({ code: 0 });
});
afterEach(() => {
  removeTestPath(tmp);
});

describe('runCommandLine', () => {
  test('runs the launcher with wscript from SystemRoot, in batch mode without a logo', () => {
    expect(runCommandLine(fakeSystem(), 'D:\\data dir\\service\\launcher.js')).toBe(
      `"${WSCRIPT}" //B //Nologo "D:\\data dir\\service\\launcher.js"`,
    );
  });
});

describe('launcherSource', () => {
  test('throws for an argv element containing a double quote', () => {
    expect(() => launcherSource({ argv: ['node', 'say "hi"'], env: {}, markerPath: 'm' })).toThrow();
  });

  test('carries the backoff list, the reset time, the env and the quoted command', () => {
    const src = launcherSource({
      argv: ['C:\\a b\\node.exe', 'start'],
      env: { AGENT_CANVAS_DATA_DIR: "C:\\it's" },
      markerPath: 'C:\\d\\service\\stopped',
    });
    expect(src).toContain('[5000, 10000, 20000, 40000, 60000]');
    expect(src).toContain('600000');
    expect(src).toContain(`'"C:\\\\a b\\\\node.exe" "start"'`);
    expect(src).toContain(`'AGENT_CANVAS_DATA_DIR'`);
    expect(src).toContain(`'C:\\\\it\\'s'`);
    expect(src).toContain(`'C:\\\\d\\\\service\\\\stopped'`);
  });
});

describe('windowsBackend', () => {
  test('where names the startup entry', () => {
    const backend = windowsBackend(fakeSystem());
    expect(backend.kind).toBe('windows');
    expect(backend.where).toBe(`Windows 启动项（${RUN_KEY}\\${RUN_VALUE}）`);
  });

  test('register writes a UTF-16LE launcher with a BOM and issues exactly one reg add', async () => {
    const dataDir = path.join(tmp, '张 三', 'data dir');
    const def = definition(dataDir);
    await windowsBackend(fakeSystem()).register(def);

    const launcher = path.join(dataDir, 'service', 'launcher.js');
    const { bytes, text } = readLauncher(dataDir);
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);

    expect(calls).toHaveLength(1);
    expect(isReg(calls[0]!)).toBe(true);
    expect(calls[0]!.args).toEqual([
      'add',
      RUN_KEY,
      '/v',
      'AgentCanvas',
      '/t',
      'REG_SZ',
      '/d',
      runCommandLine(fakeSystem(), launcher),
      '/f',
    ]);

    // Review Focus 1: every path survives intact, inside double quotes, in the decoded launcher.
    for (const p of [def.nodePath, def.cliPath, def.logFile]) expect(text).toContain(`"${jsText(p)}"`);
    expect(text).toContain(`'${jsText(dataDir)}'`);
    expect(text).toContain(`'${jsText(path.join(dataDir, 'service', 'stopped'))}'`);
    expect(text).toContain(`'GROK_HOME'`);
    expect(text).toContain('"start" "--port" "4399"');
  });

  test('register reports a failed reg add', async () => {
    answer = () => ({ code: 1 });
    await expect(windowsBackend(fakeSystem()).register(definition(path.join(tmp, 'data')))).rejects.toThrow();
  });

  test('register uses the key it was given', async () => {
    await windowsBackend(fakeSystem(), { runKey: 'HKCU\\Software\\Test\\Run' }).register(definition(path.join(tmp, 'data')));
    expect(calls[0]!.args[1]).toBe('HKCU\\Software\\Test\\Run');
  });

  describe('state', () => {
    const query = (key: string, present: boolean, binary?: string) => (c: Call): Answer | null => {
      if (!isReg(c) || c.args[0] !== 'query' || c.args[1] !== key) return null;
      if (!present) return { code: 1, stderr: '错误: 系统找不到指定的注册表项或值。' };
      const type = binary === undefined ? 'REG_SZ    x' : `REG_BINARY    ${binary}`;
      return { code: 0, stdout: `\r\n${key}\r\n    AgentCanvas    ${type}\r\n\r\n` };
    };
    const states = (...qs: ((c: Call) => Answer | null)[]) => (c: Call): Answer => {
      for (const q of qs) {
        const a = q(c);
        if (a !== null) return a;
      }
      throw new Error(`unexpected call ${c.command} ${c.args.join(' ')}`);
    };
    const def = () => definition(path.join(tmp, 'data'));

    test('no Run value: absent', async () => {
      answer = states(query(RUN_KEY, false));
      expect(await windowsBackend(fakeSystem()).state(def())).toBe('absent');
      expect(calls.map((c) => c.args)).toEqual([['query', RUN_KEY, '/v', 'AgentCanvas']]);
    });

    test('approved with an odd first byte: disabled', async () => {
      answer = states(query(RUN_KEY, true), query(APPROVED_KEY, true, '030000000000000000000000'));
      expect(await windowsBackend(fakeSystem()).state(def())).toBe('disabled');
      expect(calls.map((c) => c.args)).toEqual([
        ['query', RUN_KEY, '/v', 'AgentCanvas'],
        ['query', APPROVED_KEY, '/v', 'AgentCanvas'],
      ]);
    });

    test('approved with an even first byte: installed', async () => {
      answer = states(query(RUN_KEY, true), query(APPROVED_KEY, true, '020000000000000000000000'));
      expect(await windowsBackend(fakeSystem()).state(def())).toBe('installed');
    });

    test('no approved value: installed', async () => {
      answer = states(query(RUN_KEY, true), query(APPROVED_KEY, false));
      expect(await windowsBackend(fakeSystem()).state(def())).toBe('installed');
    });

    test('uses the keys it was given', async () => {
      answer = states(query('HKCU\\R', true), query('HKCU\\A', true, '07'));
      expect(await windowsBackend(fakeSystem(), { runKey: 'HKCU\\R', approvedKey: 'HKCU\\A' }).state(def())).toBe('disabled');
    });
  });

  test('unregister deletes the Run value and the service directory', async () => {
    const def = definition(path.join(tmp, 'data'));
    const backend = windowsBackend(fakeSystem());
    await backend.register(def);
    calls = [];
    await backend.unregister(def);
    expect(calls).toHaveLength(1);
    expect(isReg(calls[0]!)).toBe(true);
    expect(calls[0]!.args).toEqual(['delete', RUN_KEY, '/v', 'AgentCanvas', '/f']);
    expect(fs.existsSync(path.join(def.dataDir, 'service'))).toBe(false);
  });

  test('unregister accepts a missing Run value', async () => {
    answer = () => ({ code: 1 });
    await expect(windowsBackend(fakeSystem()).unregister(definition(path.join(tmp, 'data')))).resolves.toBeUndefined();
  });

  test('cancelRestart creates the marker; start removes it, then runs the launcher with wscript', async () => {
    const def = definition(path.join(tmp, 'data'));
    const backend = windowsBackend(fakeSystem());
    await backend.register(def);
    const marker = path.join(def.dataDir, 'service', 'stopped');

    await backend.cancelRestart(def);
    expect(fs.existsSync(marker)).toBe(true);

    let markerAtSpawn: boolean | null = null;
    const system = fakeSystem();
    system.spawnDetached = (command, args) => {
      markerAtSpawn = fs.existsSync(marker);
      spawned.push({ command, args });
    };
    await windowsBackend(system).start(def);
    expect(fs.existsSync(marker)).toBe(false);
    expect(markerAtSpawn).toBe(false);
    expect(spawned).toEqual([
      { command: WSCRIPT, args: ['//B', '//Nologo', path.join(def.dataDir, 'service', 'launcher.js')] },
    ]);
  });

  describe('check', () => {
    test('null when the probe answers 7; the probe is gone afterwards', async () => {
      const def = definition(path.join(tmp, 'data'));
      let probe = '';
      answer = (c) => {
        probe = c.args[2]!;
        expect(fs.readFileSync(probe, 'utf8')).toContain('WScript.Quit(7);');
        return { code: 7 };
      };
      expect(await windowsBackend(fakeSystem()).check(def)).toBeNull();
      expect(calls).toEqual([{ command: WSCRIPT, args: ['//B', '//Nologo', path.join(def.dataDir, 'service', 'probe.js')] }]);
      expect(fs.existsSync(probe)).toBe(false);
    });

    test('the reason when the probe answers 1', async () => {
      answer = () => ({ code: 1 });
      expect(await windowsBackend(fakeSystem()).check(definition(path.join(tmp, 'data')))).toBe(
        'Windows Script Host 不可用（可能被系统策略禁用），不能装后台常驻',
      );
    });

    test('the reason when wscript cannot start', async () => {
      const system = fakeSystem();
      system.run = async () => {
        throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      };
      expect(await windowsBackend(system).check(definition(path.join(tmp, 'data')))).toBe(
        'Windows Script Host 不可用（可能被系统策略禁用），不能装后台常驻',
      );
    });
  });

  test('plan shows the launcher, its command and env, the registry value, and that it runs hidden at login', () => {
    const def = definition(path.join(tmp, 'data'));
    const launcher = path.join(def.dataDir, 'service', 'launcher.js');
    const text = windowsBackend(fakeSystem()).plan(def).join('\n');
    expect(text).toContain(launcher);
    expect(text).toContain(RUN_KEY);
    expect(text).toContain(RUN_VALUE);
    expect(text).toContain(runCommandLine(fakeSystem(), launcher));
    expect(text).toContain(def.argv.map((a) => `"${a}"`).join(' '));
    expect(text).toContain(`AGENT_CANVAS_DATA_DIR=${def.dataDir}`);
    expect(text).toContain('GROK_HOME=');
    expect(text).toContain('登录');
    expect(text).toContain('隐藏');
  });
});
