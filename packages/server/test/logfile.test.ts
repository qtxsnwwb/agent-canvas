import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, test } from 'vitest';
import { captureProcessOutput, LOG_MAX_BYTES, openLogFile } from '../src/logfile.js';

let tmp: string;
const T = '2026-11-25T10:00:00.000Z';
const now = (): Date => new Date(T);

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-logfile-'));
});
afterEach(async () => {
  await fs.chmod(path.join(tmp, 'ro'), 0o755).catch(() => undefined);
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

test('上限是 5 MB', () => {
  expect(LOG_MAX_BYTES).toBe(5 * 1024 * 1024);
});

test('每行前面加 ISO 时间；一行分几次写也只加一次', async () => {
  const file = path.join(tmp, 'service.log');
  const log = openLogFile(file, { now });
  log.write('first\nsec');
  log.write('ond\n');
  log.write('third\n');
  log.close();
  expect(await fs.readFile(file, 'utf8')).toBe(`${T} first\n${T} second\n${T} third\n`);
});

test('超过上限时把当前文件改名为 .1（覆盖旧的），只留两个文件', async () => {
  const file = path.join(tmp, 'service.log');
  const log = openLogFile(file, { maxBytes: 100, now });
  // Each line is 50 bytes with its 25-byte prefix: 250 bytes in all.
  const lines = [1, 2, 3, 4, 5].map((n) => `line ${n} `.padEnd(24, 'x') + '\n');
  for (const line of lines) log.write(line);
  log.close();
  const current = await fs.readFile(file, 'utf8');
  const previous = await fs.readFile(`${file}.1`, 'utf8');
  expect(Buffer.byteLength(current)).toBeLessThanOrEqual(100);
  expect(current).toBe(`${T} ${lines[4]}`);
  expect(previous).toBe(`${T} ${lines[2]}${T} ${lines[3]}`);
  expect((await fs.readdir(tmp)).sort()).toEqual(['service.log', 'service.log.1']);
});

test('已有的文件接着写，大小算在上限里', async () => {
  const file = path.join(tmp, 'service.log');
  await fs.writeFile(file, 'x'.repeat(90));
  const log = openLogFile(file, { maxBytes: 100, now });
  log.write('next\n');
  log.close();
  expect(await fs.readFile(`${file}.1`, 'utf8')).toBe('x'.repeat(90));
  expect(await fs.readFile(file, 'utf8')).toBe(`${T} next\n`);
});

test('上级目录不存在时建出来', async () => {
  const file = path.join(tmp, 'logs', 'deeper', 'service.log');
  const log = openLogFile(file, { now });
  log.write('hello\n');
  log.close();
  expect(await fs.readFile(file, 'utf8')).toBe(`${T} hello\n`);
});

test('上级是一个文件：写不进去也不抛', async () => {
  await fs.writeFile(path.join(tmp, 'plain'), '');
  const log = openLogFile(path.join(tmp, 'plain', 'service.log'), { maxBytes: 10, now });
  expect(() => {
    log.write('hello\n');
    log.write('again and again\n');
    log.close();
  }).not.toThrow();
});

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('目录只读：写不进去也不抛', async () => {
  const dir = path.join(tmp, 'ro');
  await fs.mkdir(dir);
  await fs.chmod(dir, 0o555);
  const log = openLogFile(path.join(dir, 'service.log'), { maxBytes: 10, now });
  expect(() => {
    log.write('hello\n');
    log.write('again and again\n');
    log.close();
  }).not.toThrow();
});

test('captureProcessOutput 把 stdout / stderr 写进日志，restore 后复原', async () => {
  const file = path.join(tmp, 'service.log');
  const log = openLogFile(file, { now });
  const out = process.stdout.write;
  const err = process.stderr.write;
  const restore = captureProcessOutput(log);
  let called = 0;
  try {
    expect(process.stdout.write).not.toBe(out);
    process.stdout.write('to stdout\n', () => called++);
    process.stderr.write(Buffer.from('to stderr\n'));
  } finally {
    restore();
  }
  log.close();
  expect(process.stdout.write).toBe(out);
  expect(process.stderr.write).toBe(err);
  expect(await fs.readFile(file, 'utf8')).toBe(`${T} to stdout\n${T} to stderr\n`);
  await new Promise((r) => setImmediate(r));
  expect(called).toBe(1);
});
