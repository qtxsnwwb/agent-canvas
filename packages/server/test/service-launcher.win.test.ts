import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { launcherSource } from '../src/service/windows.js';

/*
 * The launcher under the real wscript.exe. Everything lives in a temp directory (with 张 三 and spaces in its path);
 * nothing is registered and no port is used. The launched command is a small node script that counts its runs and
 * exits with codes from a list.
 */

const TIMING_SCALE = Math.max(1, Number(process.env.AGENT_CANVAS_TIMING_SCALE) || 1);
const WSCRIPT = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe');

const CHILD = `
const fs = require('node:fs');
const [counter, codes, envOut] = process.argv.slice(2);
fs.appendFileSync(counter, 'run\\n');
const n = fs.readFileSync(counter, 'utf8').split('\\n').filter(Boolean).length;
const list = codes.split(',').map(Number);
const seen = (name) => (name in process.env ? process.env[name] : null);
if (envOut !== undefined) {
  fs.writeFileSync(envOut, JSON.stringify({ data: seen('AGENT_CANVAS_DATA_DIR'), grok: seen('GROK_HOME') }), 'utf8');
}
process.exit(list[Math.min(n, list.length) - 1]);
`;

let tmp: string;
let dir: string;
let launcher: ChildProcess | null;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-launcher-'));
  dir = path.join(tmp, '张 三', 'service dir');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'child.cjs'), CHILD);
  launcher = null;
});
afterEach(() => {
  if (launcher?.pid !== undefined && launcher.exitCode === null && launcher.signalCode === null) {
    spawnSync('taskkill', ['/PID', String(launcher.pid), '/T', '/F'], { windowsHide: true });
  }
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10 });
});

const counter = () => path.join(dir, 'counter');
const marker = () => path.join(dir, 'stopped');
const runs = () => (fs.existsSync(counter()) ? fs.readFileSync(counter(), 'utf8').split('\n').filter(Boolean).length : 0);

/** Writes the launcher (UTF-16LE with a BOM, as the backend does) and starts it under wscript. */
function startLauncher(o: { codes: string; env?: Record<string, string>; backoffMs: number[]; envOut?: string }): ChildProcess {
  const argv = [process.execPath, path.join(dir, 'child.cjs'), counter(), o.codes];
  if (o.envOut !== undefined) argv.push(o.envOut);
  const source = launcherSource({ argv, env: o.env ?? {}, markerPath: marker(), backoffMs: o.backoffMs });
  const file = path.join(dir, 'launcher.js');
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, 'utf16le')]));
  launcher = spawn(WSCRIPT, ['//B', '//Nologo', file], { stdio: 'ignore', windowsHide: true });
  return launcher;
}

function exited(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => reject(new Error(`launcher still running after ${timeoutMs} ms`)), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.skipIf(process.platform !== 'win32')('launcher under wscript', () => {
  test('restarts after a failure and ends when the command exits 0', async () => {
    const child = startLauncher({ codes: '1,1,0', backoffMs: [100, 100] });
    expect(await exited(child, 15_000 * TIMING_SCALE)).toBe(0);
    expect(runs()).toBe(3);
  });

  test('a marker written after the second run ends the launcher within 2 s, without a third run', async () => {
    // Without the marker the second wait (30 s) would come next and a third run after it.
    const child = startLauncher({ codes: '1', backoffMs: [100, 30_000] });
    await until(() => runs() === 2, 15_000 * TIMING_SCALE);
    // Let the second run end, so the marker arrives while the launcher waits (as `service stop` during a crash loop).
    await new Promise((r) => setTimeout(r, 500));
    fs.writeFileSync(marker(), '');
    await exited(child, 2_000 * TIMING_SCALE);
    expect(runs()).toBe(2);
  });

  test('removing its own script during the wait ends the launcher within 2 s, without another run', async () => {
    // Uninstall in a crash loop: the marker is written and the service directory deleted a moment later.
    const child = startLauncher({ codes: '1', backoffMs: [100, 30_000] });
    await until(() => runs() === 2, 15_000 * TIMING_SCALE);
    await new Promise((r) => setTimeout(r, 500));
    // unlinkSync, not rmSync: Node 25.2's rmSync crashes the process (0xC0000409) on a non-ASCII path.
    fs.unlinkSync(path.join(dir, 'launcher.js'));
    await exited(child, 2_000 * TIMING_SCALE);
    expect(runs()).toBe(2);
  });

  test('deletes a marker left from before when it starts', async () => {
    fs.writeFileSync(marker(), '');
    const child = startLauncher({ codes: '0', backoffMs: [100] });
    expect(await exited(child, 15_000 * TIMING_SCALE)).toBe(0);
    expect(runs()).toBe(1);
    expect(fs.existsSync(marker())).toBe(false);
  });

  test('the environment it sets reaches the command: non-ASCII intact, the empty string kept as a value', async () => {
    const dataDir = path.join(tmp, '张 三', 'data dir');
    const envOut = path.join(dir, 'env.json');
    const env = { AGENT_CANVAS_DATA_DIR: dataDir, GROK_HOME: '' };
    const child = startLauncher({ codes: '0', backoffMs: [100], env, envOut });
    expect(await exited(child, 15_000 * TIMING_SCALE)).toBe(0);
    expect(JSON.parse(fs.readFileSync(envOut, 'utf8'))).toEqual({ data: dataDir, grok: '' });
  });
});
