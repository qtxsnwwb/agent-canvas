import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { removeSync } from '../src/fs-remove.js';

/*
 * removeSync replaces fs.rmSync, which on Node 25 (Windows) ends the process with 0xC0000409 when the path has
 * non-ASCII characters. Every case runs under a temp directory named with 张 三, in this worker: a crash would take
 * the worker down and fail the file.
 */

let base: string;
let tmp: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-fs-remove-'));
  tmp = path.join(base, '张 三');
  fs.mkdirSync(tmp);
});
afterEach(() => {
  removeSync(base, { recursive: true });
});

describe('removeSync', () => {
  test('removes a file', () => {
    const file = path.join(tmp, '文件.txt');
    fs.writeFileSync(file, 'x');
    removeSync(file);
    expect(fs.existsSync(file)).toBe(false);
  });

  test('removes a nested directory tree with recursive', () => {
    const dir = path.join(tmp, '服务 dir');
    fs.mkdirSync(path.join(dir, 'a', '子 b', 'c'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'top.js'), 'x');
    fs.writeFileSync(path.join(dir, 'a', '一.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'a', '子 b', 'c', '深.txt'), 'x');
    fs.mkdirSync(path.join(dir, 'empty'));
    removeSync(dir, { recursive: true });
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(tmp)).toBe(true);
  });

  test('a missing path is not an error, with or without recursive', () => {
    expect(() => removeSync(path.join(tmp, '没有.txt'))).not.toThrow();
    expect(() => removeSync(path.join(tmp, '没有', 'dir'), { recursive: true })).not.toThrow();
  });

  test('a directory without recursive throws and stays', () => {
    const dir = path.join(tmp, '目录');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'f'), 'x');
    expect(() => removeSync(dir)).toThrow(expect.objectContaining({ code: 'ERR_FS_EISDIR' }));
    expect(fs.existsSync(path.join(dir, 'f'))).toBe(true);
  });

  test('other errors propagate', () => {
    expect(() => removeSync(path.join(tmp, 'a\0b'))).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
  });

  test.skipIf(process.platform === 'win32')('a path through a file throws ENOTDIR (POSIX)', () => {
    const file = path.join(tmp, 'f');
    fs.writeFileSync(file, 'x');
    expect(() => removeSync(path.join(file, 'x'))).toThrow(expect.objectContaining({ code: 'ENOTDIR' }));
  });
});

describe('the server source', () => {
  test('never calls fs.rmSync (use removeSync)', () => {
    const src = path.join(import.meta.dirname, '..', 'src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith('.ts') && fs.readFileSync(p, 'utf8').includes('rmSync(')) offenders.push(p);
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
